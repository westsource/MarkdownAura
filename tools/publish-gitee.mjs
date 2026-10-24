/* Publish the CN mirror of one release to Gitee.
 *
 *   node tools/publish-gitee.mjs [--tag v1.8.0] [--dry-run]
 *
 * The CN mirror is not a copy of the release: Gitee carries only the files
 * `latest-cn.json` actually points at (the installers the updater downloads)
 * plus `latest-cn.json` itself. Portable zips, `.deb`, `.sig` files, LICENSE and
 * THIRD-PARTY.md are deliberately left on GitHub — the signature travels inside
 * the manifest, and Gitee's attachment limits are real.
 *
 * Re-runs are safe: Gitee rejects a same-name re-attach, so every file is
 * preceded by a delete of its residual attachment. The token comes from
 * `~/.git-credentials` (the `gitee.com` entry) and is never printed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OWNER = "westsource";
const NAME = "MarkdownAura";
const API = "https://gitee.com/api/v5";

const root = process.cwd();
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tagArg = args.indexOf("--tag");
const version = readJson(path.join(root, "package.json")).version;
const tag = tagArg >= 0 ? args[tagArg + 1] : `v${version}`;
const releaseDir = path.join(root, "var", "release");
const cnManifest = path.join(releaseDir, "latest-cn.json");

if (!fs.existsSync(cnManifest)) {
  console.error(`error: ${path.relative(root, cnManifest)} is missing — run make-latest-json.mjs first`);
  process.exit(1);
}

/* Only what the CN manifest references, plus the manifest itself. */
const manifest = readJson(cnManifest);
const files = [...new Set([
  path.basename(cnManifest),
  ...Object.values(manifest.platforms ?? {}).map((p) => p.url.split("/").pop()),
])].sort();

for (const file of files) {
  const p = path.join(releaseDir, file);
  if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
    console.error(`error: CN manifest references ${file}, but it is missing or empty in var/release`);
    process.exit(1);
  }
}

if (dryRun) {
  console.log(`gitee: --dry-run, release ${tag} at ${OWNER}/${NAME}`);
  for (const file of files) {
    const size = fs.statSync(path.join(releaseDir, file)).size;
    console.log(`  ${(size / 1048576).toFixed(2).padStart(7)} MB  ${file}`);
  }
  process.exit(0);
}

const token = giteeToken();
const redact = (s) => String(s).replace(/(access_token=)[^&\s]+/gi, "$1***");

const releaseId = await ensureRelease();
for (const file of files) {
  await deleteSameName(releaseId, file);
  await attach(releaseId, file);
}
console.log(`gitee: ${files.length} files attached to ${tag}`);

async function ensureRelease() {
  const res = await api(`/repos/${OWNER}/${NAME}/releases`, "GET");
  const list = Array.isArray(res) ? res : [];
  const existing = list.find((r) => r.tag_name === tag);
  if (existing) {
    console.log(`gitee: release ${tag} exists (id ${existing.id})`);
    return existing.id;
  }
  const body = {
    tag_name: tag,
    target_commitish: "main",
    name: `MarkdownAura ${tag}`,
    body: `MarkdownAura ${version} — 国内更新镜像`,
    prerelease: false,
    draft: false,
  };
  const created = await api(`/repos/${OWNER}/${NAME}/releases`, "POST", body);
  console.log(`gitee: created release ${tag} (id ${created.id})`);
  return created.id;
}

async function deleteSameName(releaseId, name) {
  const attachments = await api(`/repos/${OWNER}/${NAME}/releases/${releaseId}/attach_files`, "GET");
  const same = (Array.isArray(attachments) ? attachments : []).filter((a) => a.name === name);
  for (const a of same) {
    await api(`/repos/${OWNER}/${NAME}/releases/${releaseId}/attach_files/${a.id}`, "DELETE");
    console.log(`gitee: removed residual ${name} (id ${a.id})`);
  }
}

async function attach(releaseId, name) {
  const file = path.join(releaseDir, name);
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)], { type: "application/octet-stream" }), name);
  const res = await fetch(
    `${API}/repos/${OWNER}/${NAME}/releases/${releaseId}/attach_files?access_token=${encodeURIComponent(token)}`,
    { method: "POST", body: form },
  );
  if (!res.ok) {
    console.error(`gitee: attach ${name} failed: ${res.status} ${redact(await res.text())}`);
    process.exit(1);
  }
  console.log(`gitee: attached ${name}`);
}

async function api(pathname, method, body) {
  const url = `${API}${pathname}${pathname.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    console.error(`gitee: ${method} ${pathname} failed: ${res.status} ${redact(await res.text())}`);
    process.exit(1);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function giteeToken() {
  const creds = path.join(os.homedir(), ".git-credentials");
  if (!fs.existsSync(creds)) die("no ~/.git-credentials");
  for (const line of fs.readFileSync(creds, "utf8").split(/\r?\n/)) {
    const m = /^https:\/\/([^@]*)@gitee\.com/.exec(line.trim());
    if (m) {
      const token = m[1].includes(":") ? m[1].split(":").pop() : m[1];
      if (token) return token;
    }
  }
  die("no gitee.com entry in ~/.git-credentials");
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}
