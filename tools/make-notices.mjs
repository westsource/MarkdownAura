/* Regenerates THIRD-PARTY.md from what the build actually resolves.
 *
 *     node tools/make-notices.mjs
 *
 * Why generated rather than hand-written: the notices exist to be *accurate*, and a hand-kept list
 * of licences drifts the first time a dependency is bumped (`mermaid` 'MIT' is easy; 150 transitive
 * Rust crates are not). The sources are the real ones — `cargo metadata` for the Rust side, the
 * installed `node_modules` for the frontend side — so a version or an SPDX identifier can only be
 * wrong if the toolchain says it is.
 *
 * Only what *ships* is listed: the frontend's runtime dependencies (devDependencies never reach the
 * bundle) and every crate in the default dependency graph. All three diagram engines ship bundled, so
 * there is no "downloaded later" section any more; d2 is called out in its own sentence because it is
 * the one MPL-2.0 component and that licence has an obligation the others do not.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const pkg = readJson(path.join(root, "package.json"));
const shipped = Object.keys(pkg.dependencies ?? {});

/* Frontend: the installed version and, when the licence file has a real one, its copyright line.
 * Apache-2.0 files carry a *placeholder* ("Copyright [yyyy] [name of copyright owner]") and picking
 * that up as a holder is worse than leaving the cell empty — the notice would name nobody, in the
 * voice of naming someone. */
const PLACEHOLDER = /\[|\[yyyy\]|name of copyright owner|owner or entity/i;
const frontend = shipped.map((name) => {
  const dir = path.join(root, "node_modules", name);
  const meta = fs.existsSync(path.join(dir, "package.json")) ? readJson(path.join(dir, "package.json")) : {};
  const licenceFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE"].find((f) => fs.existsSync(path.join(dir, f)));
  let holder = "";
  if (licenceFile) {
    const text = fs.readFileSync(path.join(dir, licenceFile), "utf8");
    const line = (text.match(/copyright[^\n]*/i) ?? [""])[0].replace(/\s+/g, " ").trim();
    if (line && !PLACEHOLDER.test(line)) holder = line;
  }
  return {
    name,
    version: meta.version ?? "?",
    license: meta.license ?? (licenceFile ? "see licence file" : "?"),
    holder,
    repo: typeof meta.repository === "string" ? meta.repository : meta.repository?.url ?? "",
  };
});

/* Rust: the resolved graph, as Cargo sees it. `--offline` because `cargo metadata` resolves
 * dev-dependencies and optional features too — far more than a build needs — so it must find every
 * one of them in the local cache. Run `cargo fetch --manifest-path src-tauri/Cargo.toml` first if it
 * complains that a crate is missing. */
const cargoRoot = path.join(root, "src-tauri");
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--offline", "--format-version", "1", "--manifest-path", path.join(cargoRoot, "Cargo.toml")],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ),
);
const own = new Set(metadata.workspace_members ?? []);
/* Walk the resolve graph from the crate itself, following **normal** dependencies only and only
 * those that apply to this target. That is what actually ships: `cargo metadata` resolves
 * dev-dependencies and every platform's crates too (487 packages here versus a few dozen that end up
 * in the binary), and a notices file padded with test-only and Linux-only crates is a notices file
 * nobody trusts. */
/* Cargo encodes a normal dependency as `kind: null` — not the string "normal" — which is the whole
 * reason the first version of this walk found zero crates. */
const isNormal = (kind) => kind === null || kind === "normal";
const shipsToWindows = (target) => target === null || /windows/i.test(target);

const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
const shipping = new Set();
const stack = [...own];
while (stack.length > 0) {
  const id = stack.pop();
  if (shipping.has(id)) continue;
  shipping.add(id);
  for (const dep of nodes.get(id)?.deps ?? []) {
    if (dep.dep_kinds.some((k) => isNormal(k.kind) && shipsToWindows(k.target))) stack.push(dep.pkg);
  }
}

const crates = metadata.packages
  .filter((p) => shipping.has(p.id) && !own.has(p.id) && p.source !== null) // path deps are ours
  .map((p) => ({ name: p.name, version: p.version, license: p.license ?? (p.license_file ? "see licence file" : "?"), repo: p.repository ?? "" }))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const row = (cells) => `| ${cells.join(" | ")} |`;
const optional = (value) => value || "—";

const output = `# Third-party notices

MarkdownAura itself is MIT — see [LICENSE](LICENSE), copyright 道荣（黄超）.

This file lists the third-party components that ship with the app, with the licence each one is
distributed under. **Generated** by \`node tools/make-notices.mjs\` from \`cargo metadata\` and the
installed \`node_modules\`: do not edit it by hand, and re-run the generator when a dependency changes.

## Bundled diagram engines

| component | version | licence | copyright |
|---|---|---|---|
${["mermaid", "@hpcc-js/wasm-graphviz", "@d2lang/d2"]
  .map((name) => frontend.find((d) => d.name === name))
  .map((e) => row([`\`${e.name}\``, e.version, e.license, optional(e.holder)]))
  .join("\n")}

The mermaid ESM build is code-split: the entry plus the chunks for the diagram types actually used
are bundled, and the rest ship in the installer as chunks (\`SPEC.md\` §4).

**d2 is the one MPL-2.0 component.** MPL-2.0 is file-level copyleft: its files ship unmodified inside
the frontend bundle, separate from the app's own files, which is what the licence asks for. Its
licence text is \`node_modules/@d2lang/d2/LICENSE.txt\` in the source tree.

## Frontend runtime dependencies

| package | version | licence | copyright |
|---|---|---|---|
${frontend.map((d) => row([`\`${d.name}\``, d.version, d.license, optional(d.holder)])).join("\n")}

## Rust crates

The ${crates.length} crates that ship in the release build (normal dependencies for this target, as
resolved by Cargo — dev-dependencies and other platforms' crates are excluded because they are not
in the binary). Where a crate offers a choice of licence (\`MIT OR Apache-2.0\` and the like),
MarkdownAura takes it under the MIT terms.

| crate | version | licence |
|---|---|---|
${crates.map((c) => row([`\`${c.name}\``, c.version, c.license])).join("\n")}

## Full licence texts

Each component's own licence text is available in its package (Rust: the crate source in the
registry; frontend: \`node_modules/<package>/LICENSE*\`) and from the repositories listed above. The
two texts that apply to MarkdownAura itself, MIT and the engine licences, are reproduced or
referenced here and in \`LICENSE\`.
`;

fs.writeFileSync(path.join(root, "THIRD-PARTY.md"), output);
console.log(`THIRD-PARTY.md written: ${frontend.length} frontend packages, ${crates.length} Rust crates`);
