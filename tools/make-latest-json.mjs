/* Writes the updater manifest and stages every release asset, from what the bundle step produced.
 *
 *     node tools/make-latest-json.mjs --notes "what changed in this release" [--clean]
 *
 * Multi-platform by construction: it stages whatever this machine can build, and *merges* into an
 * existing `var/release/latest.json` for the same version. So the release is assembled by running it
 * once on Windows and once on Linux — each run adds its own platform key and its own artifacts, and
 * neither has to know how the other was built. `--clean` restores the old wipe-first behaviour.
 *
 * Why generated rather than hand-written: the manifest has to name the exact artifact and carry the
 * exact signature that build produced. A hand-edited manifest is how a release ends up pointing at the
 * previous version's artifact — and because the updater verifies the signature against the public key
 * in `tauri.conf.json`, a mismatch is refused at install time on every client, not caught here.
 *
 * The manifest is fetched from
 * `https://github.com/westsource/MarkdownAura/releases/latest/download/latest.json`, so it has to be
 * uploaded as an asset of the newest release (the URL resolves to whatever that is).
 *
 * Requires builds made with `TAURI_SIGNING_PRIVATE_KEY` set: that is what produces the `.sig` beside
 * each artifact. Everything lands in `var/release/` (gitignored) ready to upload.
 *
 * The updater artifacts differ per platform and that is why the manifest is keyed the way it is:
 * Windows updates from the NSIS installer, Linux from the AppImage (`createUpdaterArtifacts` signs
 * each one). A `.deb` is published for people to install, but it is not an update path — the package
 * manager owns that.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const args = process.argv.slice(2);
const notesIndex = args.indexOf("--notes");
const notes = notesIndex >= 0 ? args[notesIndex + 1] : "";
const clean = args.includes("--clean");

/* Gitee-side mirror: `latest-cn.json` is a *derived* copy of the GitHub manifest with only the
 * `platforms.*.url` base rewritten. It is never hand-written. `--gitee` enters the Gitee upload path;
 * that path defaults to --dry-run (print the plan, no network, never touch the token). Pass
 * `--upload-gitee` to actually push (only once the Gitee repo + token exist; see uploadToGitee). */
const gitee = args.includes("--gitee");
const uploadGitee = args.includes("--upload-gitee");
const giteeFlag = gitee || uploadGitee;

const version = readJson(path.join(root, "package.json")).version;
const tag = `v${version}`;
const repo = "https://github.com/westsource/MarkdownAura";
const giteeRepo = "https://gitee.com/westsource/MarkdownAura";
/* Owner/name for the Gitee v5 API (create release, attach files). */
const giteeOwner = "westsource";
const giteeName = "MarkdownAura";
const releaseDir = path.join(root, "var", "release");
const manifestPath = path.join(releaseDir, "latest.json");
const cnManifestPath = path.join(releaseDir, "latest-cn.json");
const bundleDir = path.join(root, "src-tauri", "target", "release", "bundle");

/* A previous manifest is merged only when it describes the same version; anything else is a release
 * that has already shipped and must not be rewritten. */
const previous = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
const carry = previous && previous.version === version ? previous : null;

if (clean) fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });

/* `--clean` means "this run defines the release", so it must drop the carried platform keys as well as
 * the carried files. Keeping them meant a wiped run still advertised the other platform — with whatever
 * URL the *previous* release had staged, which after a rename points at a file that no longer exists. */
const platforms = { ...(carry && !clean ? carry.platforms : {}) };
const staged = [];

/** Copies a bundle artifact into the staging directory. `as` renames it on the way in: the bundler
 *  owns the name it emits, the release owns the name people download, and the two differ because an
 *  artifact with no platform word in it is ambiguous once it is sitting next to the other platform's. */
function stage(file, as) {
  if (!fs.existsSync(file)) return false;
  const name = as || path.basename(file);
  fs.copyFileSync(file, path.join(releaseDir, name));
  staged.push(name);
  return true;
}

const sigOf = (file) => fs.readFileSync(`${file}.sig`, "utf8").trim();
const urlOf = (name) => `${repo}/releases/download/${tag}/${name}`;

// ---------------------------------------------------------------- Windows

/* `x64` is the bundler's spelling in the file it emits, and it stays: only the platform word is added,
 * because `MarkdownAura_1.0.0_x64-setup.exe` next to `MarkdownAura_1.0.0_amd64.deb` reads like two
 * architectures rather than two systems. */
const installer = `MarkdownAura_${version}_x64-setup.exe`;
const installerName = `MarkdownAura_${version}_windows-x64-setup.exe`;
const installerPath = path.join(bundleDir, "nsis", installer);
if (fs.existsSync(installerPath) && fs.existsSync(`${installerPath}.sig`)) {
  platforms["windows-x86_64"] = { signature: sigOf(installerPath), url: urlOf(installerName) };
  stage(installerPath, installerName);
  stage(`${installerPath}.sig`, `${installerName}.sig`);

  /* The two-file portable is distributed as a zip rather than as two loose assets: the pair only
   * works together (the exe imports the DLL), so a reader who downloads one of them has nothing. The
   * zip has a single top-level folder, which keeps "Extract All" from scattering files into
   * Downloads. */
  const appExe = path.join(root, "src-tauri", "target", "release", "markdownaura.exe");
  const loaderDll = path.join(root, "src-tauri", "target", "release", "WebView2Loader.dll");
  const folderName = `MarkdownAura-${version}-windows-x64-portable`;
  if (fs.existsSync(appExe) && fs.existsSync(loaderDll)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-portable-"));
    const folder = path.join(tmp, folderName);
    fs.mkdirSync(folder);
    fs.copyFileSync(appExe, path.join(folder, "markdownaura.exe"));
    fs.copyFileSync(loaderDll, path.join(folder, "WebView2Loader.dll"));
    const zipPath = path.join(releaseDir, `${folderName}.zip`);
    try {
      // bsdtar, which Windows has shipped since 1803, picks the format from the extension.
      execFileSync("tar", ["-a", "-c", "-f", zipPath, "-C", tmp, folderName], { stdio: "inherit" });
    } catch {
      execFileSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${folder}' -DestinationPath '${zipPath}' -Force`], { stdio: "inherit" });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    staged.push(path.basename(zipPath));
  } else {
    console.warn("warning: the portable pair is missing, so no zip was staged — build first");
  }
} else {
  console.log("windows: no NSIS bundle here, nothing to stage for it");
}

// ---------------------------------------------------------------- Linux

const appImage = `MarkdownAura_${version}_amd64.AppImage`;
const appImageName = `MarkdownAura_${version}_linux-amd64.AppImage`;
const appImagePath = path.join(bundleDir, "appimage", appImage);
const deb = `MarkdownAura_${version}_amd64.deb`;
const debName = `MarkdownAura_${version}_linux-amd64.deb`;
const debPath = path.join(bundleDir, "deb", deb);

if (fs.existsSync(appImagePath) && fs.existsSync(`${appImagePath}.sig`)) {
  // The AppImage is what the Linux updater replaces, so it is the platform's updater artifact.
  platforms["linux-x86_64"] = { signature: sigOf(appImagePath), url: urlOf(appImageName) };
  stage(appImagePath, appImageName);
  stage(`${appImagePath}.sig`, `${appImageName}.sig`);
}
if (fs.existsSync(debPath)) {
  // Published for installation, not for updating: the package manager owns that path.
  stage(debPath, debName);
  stage(`${debPath}.sig`, `${debName}.sig`);
}
if (!fs.existsSync(appImagePath) && !fs.existsSync(debPath)) {
  console.log("linux: no deb or AppImage here, nothing to stage for it");
}

stage(path.join(root, "LICENSE"));
stage(path.join(root, "THIRD-PARTY.md"));

const keys = Object.keys(platforms);
if (!keys.length) {
  console.error("no updater artifact found for any platform — build one first");
  process.exit(1);
}

const manifest = {
  version,
  notes: notes || (carry ? carry.notes : ""),
  pub_date: carry ? carry.pub_date : new Date().toISOString(),
  platforms,
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`latest.json -> ${path.relative(root, manifestPath)}`);
console.log(`  version ${version}  tag ${tag}  pub_date ${manifest.pub_date}`);
for (const key of keys.sort()) {
  console.log(`  ${key}`);
  console.log(`    url ${platforms[key].url}`);
  console.log(`    sig ${platforms[key].signature.slice(0, 24)}…`);
}

// ---------------------------------------------------------------- CN mirror

/* latest-cn.json is a *derived* product: the GitHub manifest is the single source of truth; the CN one
 * is built from it by rewriting only `platforms.*.url` to the Gitee release download base, keeping
 * version/notes/pub_date/signature byte-for-byte. It is never hand-written and never assembled from a
 * historical manifest separate from the current one. Deriving from the in-memory `manifest` (possibly
 * after a Windows/Linux merge via `carry`) is exactly right: the CN mirror must reflect whatever this
 * run just produced. Faithfulness is enforced by the self-check below. */

const giteeUrlOf = (name) => `${giteeRepo}/releases/download/${tag}/${name}`;
const manifestCn = {
  version: manifest.version,
  notes: manifest.notes,
  pub_date: manifest.pub_date,
  platforms: {},
};
for (const [arch, p] of Object.entries(manifest.platforms)) {
  manifestCn.platforms[arch] = { signature: p.signature, url: giteeUrlOf(/* name kept in comment */ p.url.split("/").pop()) };
}

/* Self-check: the two manifests must be identical except the url field. Any drift (a hand edit, a
 * signature re-token, an extra platform) aborts the release before the CN manifest can ship wrong. */
{
  const ghKeys = Object.keys(manifest.platforms).sort();
  const cnKeys = Object.keys(manifestCn.platforms).sort();
  const problems = [];
  if (cnKeys.join() !== ghKeys.join()) problems.push(`platform sets differ: gh=[${ghKeys}] cn=[${cnKeys}]`);
  if (manifestCn.version !== manifest.version) problems.push("version differs");
  if (manifestCn.notes !== manifest.notes) problems.push("notes differ");
  if (manifestCn.pub_date !== manifest.pub_date) problems.push("pub_date differs");
  for (const arch of ghKeys) {
    const gh = manifest.platforms[arch];
    const cn = manifestCn.platforms[arch];
    if (!cn) { problems.push(`${arch}: missing in cn`); continue; }
    if (cn.signature !== gh.signature) problems.push(`${arch}: signature differs`);
    if (cn.url !== giteeUrlOf(gh.url.split("/").pop())) problems.push(`${arch}: cn url not derived from gh url`);
  }
  if (problems.length) {
    console.error("error: latest-cn.json is not a faithful derivation of latest.json:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}
fs.writeFileSync(cnManifestPath, `${JSON.stringify(manifestCn, null, 2)}\n`);

console.log(`latest-cn.json -> ${path.relative(root, cnManifestPath)} (derived, signatures byte-identical)`);

// ---------------------------------------------------------------- Gitee

/* The upload set is *derived* from the CN manifest, not a sweep of var/release/: only the files the
 * CN manifest's platforms.*.url actually reference (the two installers) plus latest-cn.json itself
 * get pushed to Gitee. Kept lean because Gitee caps a single attachment per file, and latest.json /
 * LICENSE / THIRD-PARTY.md / zip / .sig have no business on the CN mirror (the .sig travels inside
 * latest-cn.json, whose signature field is verified by the client). */
const giteeUploadFiles = () => {
  const names = new Set([path.basename(cnManifestPath)]);
  for (const p of Object.values(manifestCn.platforms)) names.add(p.url.split("/").pop());
  return [...names].sort();
};

/* Gitee puts the token in the query string, so every URL we might print has to be scrubbed first —
 * the token must never appear in console output, logs, or error text. Declared before the dry-run
 * loop below uses it. */
const scrub = (s) => String(s).replace(/(access_token=)[^&\s]+/gi, "$1***");

/* Each referenced pixel file must actually be there and non-empty before we advertise a manifest that
 * points at it: a CN manifest whose url points at a missing/zero-byte installer is exactly the failure
 * mode that leaves CN users stuck. latest-cn.json itself is a disposable derived artifact (rebuilt
 * every run, never trusted off disk), so we only ever check the installers the manifest references. */
const assertUploadFilesPresent = (files) => {
  for (const file of files) {
    if (file === path.basename(cnManifestPath)) continue; // derived this run; checked above
    const p = path.join(releaseDir, file);
    if (!fs.existsSync(p)) {
      console.error(`error: CN manifest references ${file}, but ${path.relative(root, p)} does not exist`);
      process.exit(1);
    }
    const size = fs.statSync(p).size;
    if (size === 0) {
      console.error(`error: CN manifest references ${file}, but ${path.relative(root, p)} is empty (0 bytes)`);
      process.exit(1);
    }
  }
};

if (giteeFlag) {
  const files = giteeUploadFiles();
  assertUploadFilesPresent(files);
  if (uploadGitee) uploadToGitee(files);
  else {
    console.log(`gitee: --dry-run (no network) — derived files to attach to ${giteeRepo}/releases/${tag}:`);
    for (const file of files) {
      const size = fs.statSync(path.join(releaseDir, file)).size;
      console.log(`  ${(size / 1048576).toFixed(2).padStart(7)} MB  ${file}`);
      console.log(`        -> ${scrub(giteeUrlOf(file))}`);
    }
    console.log("  (pass --upload-gitee to actually push; requires GITEE_TOKEN and the repo to exist)");
  }
}

console.log("assets to upload (var/release/):");
for (const file of fs.readdirSync(releaseDir).sort()) {
  const size = fs.statSync(path.join(releaseDir, file)).size;
  console.log(`  ${(size / 1048576).toFixed(2).padStart(7)} MB  ${file}`);
}

/* Real Gitee upload. Gated behind --upload-gitee and kept out of the default path. Reads the token from
 * $env:GITEE_TOKEN and never prints/logs/writes it (scrub() guards every URL that reaches console).
 * NOTE: written against the Gitee v5 API shape (create-or-reuse release, then attach each file as
 * multipart, deleting a same-name residual first for idempotency) but NOT yet exercised — 1.8.0's
 * scope is dry-run only, and the repo + token do not exist yet. Verify against the live API before
 * first real use. */
async function uploadToGitee(files) {
  const token = process.env.GITEE_TOKEN;
  if (!token) {
    console.error("error: --upload-gitee needs $env:GITEE_TOKEN set");
    process.exit(1);
  }
  const api = "https://gitee.com/api/v5";
  const base = `${api}/repos/${giteeOwner}/${giteeName}`;

  // Create-or-reuse the release, idempotent on tag_name.
  let releaseId;
  {
    const list = await (await fetch(`${base}/releases?access_token=${encodeURIComponent(token)}`, {
      headers: { "Content-Type": "application/json" },
    })).json();
    const existing = Array.isArray(list) ? list.find((r) => r.tag_name === tag) : null;
    if (existing) {
      releaseId = existing.id;
      console.log(`gitee: release ${tag} already exists (id ${releaseId})`);
    } else {
      const body = await (await fetch(`${base}/releases?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag_name: tag, name: `MarkdownAura ${tag}`, body: `MarkdownAura ${version} — CN mirror release`, prerelease: false, draft: false }),
      })).json();
      releaseId = body.id;
      console.log(`gitee: created release ${tag} (id ${releaseId})`);
    }
  }

  // Re-run must be idempotent: Gitee rejects a same-name re-attach, so delete any residual of that
  // name first (e.g. a state=starter half from an interrupted run), like diagramon's release.mjs.
  const attachmentsFor = async () => {
    const r = await fetch(`${base}/releases/${releaseId}/attach_files?access_token=${encodeURIComponent(token)}`);
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  };
  for (const file of files) {
    const target = `${base}/releases/${releaseId}/attach_files?access_token=${encodeURIComponent(token)}`;
    for (const a of (await attachmentsFor()).filter((x) => x.name === file)) {
      console.log(`gitee: removing same-name residual ${a.name} (id ${a.id})`);
      await fetch(`${base}/releases/${releaseId}/attach_files/${a.id}?access_token=${encodeURIComponent(token)}`, { method: "DELETE" });
    }
    const buf = await fs.promises.readFile(path.join(releaseDir, file));
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type: "application/octet-stream" }), file);
    const r = await fetch(target, { method: "POST", body: fd });
    if (!r.ok) {
      console.error(`gitee: failed to attach ${file}: ${r.status} ${await r.text()}`.replace(/\n/g, " "));
      process.exit(1);
    }
    console.log(`gitee: attached ${file}`);
  }
  console.log("gitee: upload complete");
}
