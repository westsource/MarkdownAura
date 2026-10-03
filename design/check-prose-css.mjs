/* Guards two invariants of the reading surface (SPEC §3, §8; IMPL.md §5, §10).
 *
 * 1. The reading column stays centred: the column is `max-width: var(--measure)` + `margin-inline:
 * auto` on `.prose > *`. Any block rule
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

/* 2. Every size on the reading surface is a multiple of the prose base, and both source panes are set
 *    from that base.
 *
 * Both halves of this shipped broken and were reported on 2026-10-03: h2–h6 were px values lifted
 * from the 13px UI scale, so they rendered *smaller* than the body text they headed and stopped
 * following the size control and the zoom; the source panes were a bare `12px`, so they never matched
 * the preview and ignored both controls. A measure is the only thing that sees either failure — and
 * only at a size or zoom other than the default, which is why the default screenshot looked fine.
 *
 * The related layout rule is here too: `.source-view` must not be content-sized. `.view.on` is a flex
 * row, so a lone item left at `flex: 0 1 auto` is sized by the longest source line — the pane came out
 * a fraction of the window for any document with short lines (reported the same day as "sometimes the
 * source view is only as wide as the split view"). `min-width: 0` is what lets the wrapped `pre`
 * shrink instead of forcing the pane wider.
 */
const components = fs
  .readFileSync(path.join(here, "components.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const rulesOf = (source) => {
  const map = new Map();
  for (const match of source.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    map.set(match[1].trim().replace(/\s+/g, " "), match[2]);
  }
  return map;
};
const proseRules = rulesOf(css);
const componentRules = rulesOf(components);
const sizeOf = (map, selector) => /font-size:\s*([^;}]+)/.exec(map.get(selector) ?? "")?.[1].trim() ?? null;

// `em`/`%` inherit the base; `calc(var(--doc-size…))` *is* the base. `rem` is not acceptable here
// (it resolves against the 13px UI root), which is why the `em` test insists on a number in front.
const relative = (value) => value !== null && (/\d(?:\.\d+)?em\b|%/.test(value) || /calc\(var\(--doc-size/.test(value));

for (const [selector, body] of proseRules) {
  const declared = /font-size:\s*([^;}]+)/.exec(body)?.[1].trim();
  if (declared === undefined) continue;
  check(relative(declared), `prose.css font-size is relative to the prose base: \`${selector}\` -> ${declared}`);
}

const sourceView = componentRules.get(".source-view") ?? "";
check(/flex:\s*1 1 auto/.test(sourceView), "`.source-view` is `flex: 1 1 auto`, not content-sized");
check(/min-width:\s*0/.test(sourceView), "`.source-view` carries `min-width: 0`");

for (const selector of [".source-view pre", ".view.split .pane-src pre"]) {
  const declared = sizeOf(componentRules, selector);
  check(
    declared !== null && /calc\(var\(--doc-size/.test(declared),
    `\`${selector}\` reads --doc-size and --zoom (found: ${declared ?? "no font-size"})`,
  );
}

console.log(
  failed
    ? `\n${failed} assertion(s) failed — see IMPL.md §5`
    : "\nprose.css keeps the reading column centred and its sizes relative to the reading base",
);
process.exit(failed ? 1 : 0);
