/* Builds the single-file portable edition: the launcher with the app and its WebView2 loader inside it.
 *
 *     node tools/make-portable.mjs [--stage]
 *
 * `--stage` also drops the result in `var/release/`, next to the assets a release uploads.
 *
 * Why a build step rather than a hand-made archive: the launcher embeds the two files at compile time
 * (`include_bytes!`), so this script is what guarantees the payload is the build that just happened. The
 * alternative — appending bytes to a launcher and parsing offsets at runtime — is a custom container
 * format with its own failure modes and no upside here, since a PE does not compress usefully.
 *
 * The app must be built first (`npm run build:prod`), because the payload comes from
 * `src-tauri/target/release/`.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const stage = process.argv.includes("--stage");
const pkg = readJson(path.join(root, "package.json"));
const version = pkg.version;

const appExe = path.join(root, "src-tauri", "target", "release", "markdownaura.exe");
const loaderDll = path.join(root, "src-tauri", "target", "release", "WebView2Loader.dll");
for (const file of [appExe, loaderDll]) {
  if (!fs.existsSync(file)) {
    console.error(`missing ${path.relative(root, file)} — run \`npm run build:prod\` first`);
    process.exit(1);
  }
}

const launcherDir = path.join(root, "tools", "portable");
const outDir = path.join(launcherDir, "target", "release");
const outName = `MarkdownAura-${version}-portable.exe`;
const outPath = path.join(outDir, "MarkdownAura-portable.exe");

console.log(`embedding ${(fs.statSync(appExe).size / 1048576).toFixed(2)} MB app + ${fs.statSync(loaderDll).size} B loader`);
execFileSync("cargo", ["build", "--release", "--manifest-path", path.join(launcherDir, "Cargo.toml")], {
  stdio: "inherit",
  env: {
    ...process.env,
    MARKDOWNAURA_PORTABLE_APP: appExe,
    MARKDOWNAURA_PORTABLE_LOADER: loaderDll,
    MARKDOWNAURA_PORTABLE_VERSION: version,
  },
});

const single = path.join(root, "var", "release", outName);
if (stage) {
  fs.mkdirSync(path.dirname(single), { recursive: true });
  fs.copyFileSync(outPath, single);
}

const size = fs.statSync(outPath).size;
console.log(`\n${outName}`);
console.log(`  ${(size / 1048576).toFixed(2)} MB  ${stage ? path.relative(root, single) : path.relative(root, outPath)}`);
console.log("  one file: it unpacks to %LOCALAPPDATA%\\MarkdownAura\\portable\\" + version + " and runs the app");
