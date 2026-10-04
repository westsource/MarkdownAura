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

const version = readJson(path.join(root, "package.json")).version;
const tag = `v${version}`;
const repo = "https://github.com/westsource/MarkdownAura";
const releaseDir = path.join(root, "var", "release");
const manifestPath = path.join(releaseDir, "latest.json");
const bundleDir = path.join(root, "src-tauri", "target", "release", "bundle");

/* A previous manifest is merged only when it describes the same version; anything else is a release
 * that has already shipped and must not be rewritten. */
const previous = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
const carry = previous && previous.version === version ? previous : null;

if (clean) fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });

const platforms = { ...(carry ? carry.platforms : {}) };
const staged = [];

function stage(file) {
  if (!fs.existsSync(file)) return false;
  const name = path.basename(file);
  fs.copyFileSync(file, path.join(releaseDir, name));
  staged.push(name);
  return true;
}

const sigOf = (file) => fs.readFileSync(`${file}.sig`, "utf8").trim();
const urlOf = (name) => `${repo}/releases/download/${tag}/${name}`;

// ---------------------------------------------------------------- Windows

const installer = `MarkdownAura_${version}_x64-setup.exe`;
const installerPath = path.join(bundleDir, "nsis", installer);
if (fs.existsSync(installerPath) && fs.existsSync(`${installerPath}.sig`)) {
  platforms["windows-x86_64"] = { signature: sigOf(installerPath), url: urlOf(installer) };
  stage(installerPath);
  stage(`${installerPath}.sig`);

  /* The two-file portable is distributed as a zip rather than as two loose assets: the pair only
   * works together (the exe imports the DLL), so a reader who downloads one of them has nothing. The
   * zip has a single top-level folder, which keeps "Extract All" from scattering files into
   * Downloads. */
  const appExe = path.join(root, "src-tauri", "target", "release", "markdownaura.exe");
  const loaderDll = path.join(root, "src-tauri", "target", "release", "WebView2Loader.dll");
  const folderName = `MarkdownAura-${version}-portable`;
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
const appImagePath = path.join(bundleDir, "appimage", appImage);
const deb = `MarkdownAura_${version}_amd64.deb`;
const debPath = path.join(bundleDir, "deb", deb);

if (fs.existsSync(appImagePath) && fs.existsSync(`${appImagePath}.sig`)) {
  // The AppImage is what the Linux updater replaces, so it is the platform's updater artifact.
  platforms["linux-x86_64"] = { signature: sigOf(appImagePath), url: urlOf(appImage) };
  stage(appImagePath);
  stage(`${appImagePath}.sig`);
}
if (fs.existsSync(debPath)) {
  // Published for installation, not for updating: the package manager owns that path.
  stage(debPath);
  stage(`${debPath}.sig`);
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
console.log("assets to upload (var/release/):");
for (const file of fs.readdirSync(releaseDir).sort()) {
  const size = fs.statSync(path.join(releaseDir, file)).size;
  console.log(`  ${(size / 1048576).toFixed(2).padStart(7)} MB  ${file}`);
}
