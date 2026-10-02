/* Extracts the mingw-w64 binutils we need out of an MSYS2 .pkg.tar.zst.
 *
 * Why this exists: the Rust GNU toolchain on this machine is a *linker-only* shim. It ships
 * dlltool.exe but no assembler, and dlltool needs `as` to build the import libraries rustc
 * generates for kernel32 and friends. Without it, nothing links — not even a build script.
 *
 *     node tools/unpack-binutils.mjs
 *
 * Reads var/binutils/binutils.pkg.tar.zst, writes the mingw64/bin contents to
 * var/binutils/out/, and prints what it found. Copying to ~/.cargo/bin is a separate,
 * deliberate step.
 *
 * **The package ships programs, not their runtime libraries.** Every extracted exe imports
 * `libintl-8.dll`, `libiconv-2.dll`, `libzstd.dll` and `zlib1.dll`; without them each one
 * dies before printing anything with 0xc0000135 (ERROR_DLL_NOT_FOUND — a shell reports
 * exit 53). Git for Windows ships all four in `C:\Program Files\Git\mingw64\bin`; copy them
 * next to the copied exes in ~/.cargo/bin.
 *
 * The failure does not look like a missing-toolchain problem, which is why it is written
 * down: cargo blames the build script —
 *
 *     tauri-winres ... windres failed to compile "...\resource.rc" into "...\libresource.a"
 *     with exit code: 0xc0000135
 *
 * — before a single line of our code is compiled. `windres --version` printing nothing and
 * exiting non-zero is the one-command check.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const archive = path.join(root, "var", "binutils", "binutils.pkg.tar.zst");
const outDir = path.join(root, "var", "binutils", "out");

if (!fs.existsSync(archive)) {
  console.error(`missing ${archive}`);
  process.exit(1);
}

const tar = zlib.zstdDecompressSync(fs.readFileSync(archive));
console.log(`decompressed ${(tar.length / 1048576).toFixed(1)} MB of tar`);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

/** ustar header field, NUL-terminated. */
const field = (buf, start, length) =>
  buf.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "").trim();

const oct = (buf, start, length) => {
  const text = field(buf, start, length).replace(/[^0-7]/g, "");
  return text ? parseInt(text, 8) : 0;
};

let offset = 0;
let pendingName = null;
let kept = 0;
const listing = [];

while (offset + 512 <= tar.length) {
  const header = tar.subarray(offset, offset + 512);
  // Two zero blocks end the archive.
  if (header.every((byte) => byte === 0)) break;

  let name = field(header, 0, 100);
  const prefix = field(header, 345, 155);
  if (prefix) name = `${prefix}/${name}`;
  const size = oct(header, 124, 12);
  const typeflag = String.fromCharCode(header[156] || 0x30);

  const dataStart = offset + 512;
  const data = tar.subarray(dataStart, dataStart + size);
  // Headers and data are both padded to 512.
  offset = dataStart + Math.ceil(size / 512) * 512;

  // GNU long name: the real name is in this entry's data, the file follows.
  if (typeflag === "L") {
    pendingName = data.toString("utf8").replace(/\0.*$/, "");
    continue;
  }
  if (pendingName) {
    name = pendingName;
    pendingName = null;
  }

  if (typeflag !== "0" && typeflag !== "\0") continue;
  if (!name.startsWith("mingw64/bin/")) continue;
  if (name.endsWith("/")) continue;

  const fileName = path.basename(name);
  fs.writeFileSync(path.join(outDir, fileName), data);
  listing.push({ fileName, size });
  kept++;
}

listing.sort((a, b) => a.fileName.localeCompare(b.fileName));
console.log(`\nextracted ${kept} files from mingw64/bin:\n`);
for (const { fileName, size } of listing) {
  console.log(`  ${(size / 1024).toFixed(0).padStart(7)} KB  ${fileName}`);
}

// `ld.exe` is a symlink in the MSYS2 package and arrives as `ld.bfd.exe`; we do not need a
// linker from here anyway (the rust toolchain's self-contained one is used), so it is only
// listed to catch a package that suddenly stopped shipping binutils at all.
const wanted = ["as.exe", "ar.exe", "dlltool.exe", "objcopy.exe", "strip.exe", "ld.bfd.exe"];
const missing = wanted.filter((w) => !listing.some((f) => f.fileName === w));
if (missing.length) {
  console.error(`\nmissing the tools we came for: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("\nall required toolchain programs are present");
console.log(
  "reminder: copy libintl-8.dll, libiconv-2.dll, libzstd.dll and zlib1.dll next to them\n" +
    "          (Git for Windows has all four in `C:\\Program Files\\Git\\mingw64\\bin`), or\n" +
    "          every one of these exes fails with 0xc0000135 before it prints anything.",
);
