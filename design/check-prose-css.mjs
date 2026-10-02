/* Guards the rule that keeps the reading column centred (SPEC §3, IMPL.md §5).
 *
 * The column is `max-width: var(--measure)` + `margin-inline: auto` on `.prose > *`. Any block rule
 * in prose.css that uses the `margin` *shorthand* on an element that can be a direct child of
 * `.prose` zeroes that centring for that element — and its specificity (0,1,1) beats the rule doing
 * the centring (0,1,0), so it wins silently. The damage is invisible to a width measurement and
 * obvious to an eye: headings and tables stay centred while paragraphs hug the left edge. That
 * shipped once (`.prose p`), which is why it is checked here.
 *
 *     node design/check-prose-css.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Comments first: a rule preceded by one otherwise parses with the comment glued to its selector,
// which silently takes it out of scope — a guard that cannot see the bug is worse than none.
const css = fs.readFileSync(path.join(here, "prose.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

let failed = 0;
const check = (ok, label) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
};

check(
  /\.prose > \*[^{]*\{[^}]*max-width:\s*var\(--measure\)/.test(css),
  "`.prose > *` carries max-width: var(--measure)",
);
check(
  /\.prose > \*[^{]*\{[^}]*margin-inline:\s*auto/.test(css),
  "`.prose > *` centres with margin-inline: auto",
);

/* Elements that can be a direct child of the rendered markdown. */
const DIRECT_CHILDREN = [
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "pre", "blockquote",
  "hr", "figure", "figcaption", "details", "summary", "div", "section", "img", "dl", "dt", "dd",
];

for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  const selector = match[1].trim().replace(/\s+/g, " ");
  const body = match[2];

  const inScope = selector.split(",").some((part) => {
    const single = part.trim();
    if (single === ".prose > *") return false; // the centring rule itself
    const m = /^\.prose(?:\s*>\s*|\s+)([a-z0-9]+)$/.exec(single);
    return m !== null && DIRECT_CHILDREN.includes(m[1]);
  });
  if (!inScope) continue;

  check(!/(^|[\s;])margin\s*:/.test(body), `no \`margin\` shorthand in \`${selector}\``);
}

console.log(
  failed
    ? `\n${failed} assertion(s) failed — see IMPL.md §5`
    : "\nprose.css keeps the reading column centred",
);
process.exit(failed ? 1 : 0);
