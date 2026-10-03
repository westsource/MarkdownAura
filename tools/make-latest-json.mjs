/* Writes the updater manifest and stages every release asset, from what the bundle step produced.
 *
 *     node tools/make-latest-json.mjs --notes "what changed in this release"
 *
 * Why generated rather than hand-written: the manifest has to name the exact installer file and carry
 * the exact signature that build produced. A hand-edited manifest is how a release ends up pointing at
 * the previous version's artifact — and because the updater verifies the signature against the public
 * key in `tauri.conf.json`, a mismatch is refused at install time on every client, not caught here.
 *
 * The manifest is fetched from
 * `https://github.com/westsource/MarkdownAura/releases/latest/download/latest.json`, so it has to be
 * uploaded as an asset of the newest release (the URL resolves to whatever that is).
 *
 * Requires a build made with `TAURI_SIGNING_PRIVATE_KEY` set: that is what produces the `.sig` beside
 * the installer. Everything lands in `var/release/` (gitignored) ready to upload.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const args = process.argv.slice(2);
const notesIndex = args.indexOf("--notes");
const notes = notesIndex >= 0 ? args[notesIndex + 1] : "";

const pkg = readJson(path.join(root, "package.json"));
const version = pkg.version;
const tag = `v${version}`;
const repo = "https://github.com/westsource/MarkdownAura";
const target = "windows-x86_64";

const bundleDir = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
const installer = `MarkdownAura_${version}_x64-setup.exe`;
const installerPath = path.join(bundleDir, installer);
const sigPath = `${installerPath}.sig`;

if (!fs.existsSync(installerPath) || !fs.existsSync(sigPath)) {
  console.error(`missing ${installer} or its .sig in ${bundleDir}`);
  console.error("build with TAURI_SIGNING_PRIVATE_KEY set (and bundle.createUpdaterArtifacts on) first");
  process.exit(1);
}

const releaseDir = path.join(root, "var", "release");
fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    [target]: {
      signature: fs.readFileSync(sigPath, "utf8").trim(),
      url: `${repo}/releases/download/${tag}/${installer}`,
    },
  },
};

const assets = [
  installerPath,
  sigPath,
  path.join(root, "LICENSE"),
  path.join(root, "THIRD-PARTY.md"),
  path.join(root, "src-tauri", "target", "release", "markdownaura.exe"),
  path.join(root, "src-tauri", "target", "release", "WebView2Loader.dll"),
];

const manifestPath = path.join(releaseDir, "latest.json");
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

for (const asset of assets) {
  if (fs.existsSync(asset)) fs.copyFileSync(asset, path.join(releaseDir, path.basename(asset)));
}

console.log(`latest.json -> ${path.relative(root, manifestPath)}`);
console.log(`  version ${version}  tag ${tag}`);
console.log(`  url     ${manifest.platforms[target].url}`);
console.log(`  sig     ${manifest.platforms[target].signature.slice(0, 24)}…`);
console.log("assets to upload (var/release/):");
for (const file of fs.readdirSync(releaseDir).sort()) {
  const size = fs.statSync(path.join(releaseDir, file)).size;
  console.log(`  ${(size / 1048576).toFixed(2).padStart(7)} MB  ${file}`);
}

// The portable pair is what a reader downloads instead of the installer; name it clearly on the
// release page by keeping the exe's own name. Nothing else to do here.
if (!fs.existsSync(path.join(releaseDir, "MarkdownAura.exe"))) {
  console.warn("warning: the portable exe is not in var/release — build first");
}
