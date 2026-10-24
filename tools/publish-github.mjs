/* Publish one release to GitHub, and only make it live at the very end.
 *
 *   node tools/publish-github.mjs [--tag v1.8.0] [--notes "…"] [--dry-run] [--publish]
 *
 * The ordering is the point. The CN manifest is served from Gitee, and the
 * updater takes the *first* endpoint that answers with a parseable manifest, so
 * `latest-cn.json` has to point at files that already exist. Therefore:
 *
 *   1. upload to Gitee first (tools/publish-gitee.mjs)
 *   2. run this script without --publish: creates the GitHub release as a draft
 *      and uploads every staged asset, including `latest-cn.json`
 *   3. run it again with --publish: flips the draft to published, which is the
 *      moment `releases/latest/download/latest.json` starts pointing at it
 *
 * Assets are staged by tools/make-latest-json.mjs into var/release/. Same-name
 * assets are replaced, so a half-finished upload can be re-run. The token comes
 * from `~/.git-credentials` (the github.com entry) and is never printed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OWNER = "westsource";
const NAME = "MarkdownAura";
const API = "https://api.github.com";

const root = process.cwd();
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const publish = args.includes("--publish");
const tagArg = args.indexOf("--tag");
const notesArg = args.indexOf("--notes");
const version = readJson(path.join(root, "package.json")).version;
const tag = tagArg >= 0 ? args[tagArg + 1] : `v${version}`;
const notes = notesArg >= 0 ? args[notesArg + 1] : "";
const releaseDir = path.join(root, "var", "release");

const assets = fs.existsSync(releaseDir)
  ? fs.readdirSync(releaseDir).sort()
  : [];
if (assets.length === 0) die(`no assets in ${path.relative(root, releaseDir)} — run make-latest-json.mjs first`);

if (dryRun) {
  console.log(`github: --dry-run, release ${tag} at ${OWNER}/${NAME}${publish ? " (would publish)" : ""}`);
  for (const file of assets) {
    console.log(`  ${(fs.statSync(path.join(releaseDir, file)).size / 1048576).toFixed(2).padStart(7)} MB  ${file}`);
  }
  process.exit(0);
}

const token = githubToken();
const headers = {
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};

const release = await ensureDraft();
for (const file of assets) {
  await upload(release.id, file);
}
console.log(`github: ${assets.length} assets uploaded to release ${tag} (id ${release.id}, draft)`);

if (publish) {
  await api(`/repos/${OWNER}/${NAME}/releases/${release.id}`, "PATCH", { draft: false });
  console.log(`github: ${tag} published — releases/latest now points at it`);
} else {
  console.log("github: left as a draft; re-run with --publish once Gitee is verified");
}

async function ensureDraft() {
  const existing = await apiOrNull(`/repos/${OWNER}/${NAME}/releases/tags/${tag}`);
  if (existing) {
    console.log(`github: release ${tag} exists (id ${existing.id}, draft=${existing.draft})`);
    return existing;
  }
  const created = await api(`/repos/${OWNER}/${NAME}/releases`, "POST", {
    tag_name: tag,
    target_commitish: "main",
    name: `MarkdownAura ${tag}`,
    body: notes || `MarkdownAura ${version}`,
    draft: true,
    prerelease: false,
  });
  console.log(`github: created draft release ${tag} (id ${created.id})`);
  return created;
}

async function upload(releaseId, name) {
  const current = await apiOrNull(`/repos/${OWNER}/${NAME}/releases/${releaseId}/assets?per_page=100`);
  const same = (Array.isArray(current) ? current : []).filter((a) => a.name === name);
  for (const a of same) {
    await api(`/repos/${OWNER}/${NAME}/releases/assets/${a.id}`, "DELETE");
    console.log(`github: removed residual ${name} (id ${a.id})`);
  }
  const body = fs.readFileSync(path.join(releaseDir, name));
  const res = await fetch(
    `https://uploads.github.com/repos/${OWNER}/${NAME}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body },
  );
  if (!res.ok) die(`upload ${name} failed: ${res.status} ${await res.text()}`);
  console.log(`github: attached ${name}`);
}

async function api(pathname, method, body) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: body ? { ...headers, "content-type": "application/json" } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) die(`${method} ${pathname} failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function apiOrNull(pathname) {
  const res = await fetch(`${API}${pathname}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) die(`GET ${pathname} failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function githubToken() {
  const creds = path.join(os.homedir(), ".git-credentials");
  if (!fs.existsSync(creds)) die("no ~/.git-credentials");
  for (const line of fs.readFileSync(creds, "utf8").split(/\r?\n/)) {
    const m = /^https:\/\/([^@]*)@github\.com/.exec(line.trim());
    if (m) {
      const token = m[1].includes(":") ? m[1].split(":").pop() : m[1];
      if (token) return token;
    }
  }
  die("no github.com entry in ~/.git-credentials");
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}
