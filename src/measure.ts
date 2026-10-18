/* Reading-width presets (SPEC §8, §10).
 *
 * The text column is a *setting*, not a typographic constant: a fixed measure is a fraction of the
 * pane that depends on the pane, and on a 3440px display the old fixed 72ch came to 19% of the
 * content area (measured). But it is a preset rather than a free slider, because line length is the
 * one typographic knob a reader can genuinely wreck.
 *
 * The three measured presets are in `ch` — the only unit that keeps a line *readable* whatever the
 * window size — and `full` is a percentage, because there the request is "use the pane", which is
 * exactly what a percentage measures. `comfortable` was raised from 72ch to 100ch on the reader's
 * call: 72 sits in the classic 45–75 band, while on-screen technical reading (docs sites, code
 * hosts) runs 80–120; `narrow` is there for long-form prose, and `wide` (140ch, added for the
 * ultrawide that 100ch leaves two thirds of empty) is the step between "a column" and "the pane".
 * The tooltip always reports the resolved width and its share of the pane, so the number is never
 * a mystery — including the cost of `full`.
 *
 * Both entry points — the status-bar chip and the settings row — read this table and write the same
 * `state.measure` field, exactly like the theme button and the theme row (SPEC §10).
 *
 * The table lives here rather than in `ui/` because `state.ts` needs the guard while sanitising a
 * session file, and state must not depend on a UI module.
 */
import type { Measure } from "./ipc";
import { t, type Key } from "./i18n";

export const MEASURES: Record<Measure, { key: Key; ch: number | null }> = {
  narrow: { key: "measure.narrow", ch: 60 },
  comfortable: { key: "measure.comfortable", ch: 100 },
  // `wide` exists for the ultrawide the other two are too narrow on, and it is the one tier whose
  // *value* is a judgement call rather than a band: 140ch is past the 80–120 the code hosts run at,
  // deliberately — it is still a column, where `full` on the same screen is 365 characters a line.
  // Measured in the mockup at 3440×1440 with both panels open at 15px: 60ch 485px, 100ch 809px,
  // 140ch 1132px, the pane 2948px. Before it, one keystroke went from 27% of the content area to
  // 100%; now the step is 27% → 38% → 100%.
  wide: { key: "measure.wide", ch: 140 },
  // No text cap and no wide-content exemption either: every block shares the column, so `full`
  // means the pane's content box. The pane already carries its own gutter as padding.
  full: { key: "measure.full", ch: null },
};

/** Display and cycle order, narrowest first. */
export const MEASURE_ORDER: Measure[] = ["narrow", "comfortable", "wide", "full"];

export const DEFAULT_MEASURE: Measure = "comfortable";

export function isMeasure(value: unknown): value is Measure {
  return typeof value === "string" && Object.hasOwn(MEASURES, value);
}

let cachedFont = "";
let cachedChPx = 0;

/** `ch` is resolved against the *using* element's font size, so a token written as `72ch` used by
 *  an `h1` (22px) is 40% wider than the same token on a paragraph (16px) — the reading column came
 *  out ragged, heading by heading. The measure is therefore resolved **once**, against the prose
 *  font, into a pixel value every block shares.
 *
 *  `null` means "there is nothing laid out to measure right now" — see the host lookup. */
function chToPx(ch: number): string | null {
  /* Measured in a *laid out* `.prose`, and every view has exactly one: `#out-preview` in the
     preview, `#out-split` in the split, and the `.measure-host` the source view carries because it
     renders no prose of its own (index.html, SPEC §3). This used to hard-code `#out-preview`, which
     is `display: none` in split view (that view renders into `#out-split`) and in source view — and
     a `display: none` element measures **zero**. So changing the font size from either of those
     views resolved the token to `0px`, and `max-width: 0` with `overflow-wrap: anywhere` renders
     exactly one character per line. The preview and the editable pane share this one token, which is
     why both collapsed together — and why the source view, which has no rendered pane to measure,
     could not resolve a preset at all until it got a measuring surface of its own.
     Split view's prose is `.prose.compact`, so the column is resolved against the pane the reader is
     actually looking at — the same thing the token describes. */
  const host = [...document.querySelectorAll<HTMLElement>(".prose")].find((el) => el.offsetParent !== null);
  if (!host) return null;

  const font = getComputedStyle(host).font;
  if (cachedFont !== font) {
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(100);
    // `max-width: none` is load-bearing: the probe is a direct child of `.prose`, so the measure
    // rule would clamp it to the *current* `--measure`, making the measurement depend on its own
    // previous result (745px → 386px → 278px, compounding on every re-layout).
    probe.style.cssText =
      "position:absolute;visibility:hidden;white-space:pre;max-width:none;width:auto";
    host.appendChild(probe);
    cachedChPx = probe.getBoundingClientRect().width / 100;
    probe.remove();
    cachedFont = font;
  }
  return `${Math.round(ch * cachedChPx)}px`;
}

/** Writes the chosen width into the token the prose reads. Re-run whenever the document font or
 *  the zoom changes (`applyLayout`), and once more when webfonts settle (`main.ts` boot), because a
 *  resolved pixel value does not follow either by itself. */
export function applyMeasure(id: Measure): void {
  // The preset as a *selector target*, next to the resolved length it writes below: `wide`/`full`
  // left-align a table narrower than the column while the others centre it (prose.css), and a
  // resolved px/`100%` token is not something a selector can match on. Written every call so the
  // attribute can never disagree with the token beside it.
  document.documentElement.dataset.measure = id;
  const { ch } = MEASURES[id];
  if (ch === null) {
    document.documentElement.style.setProperty("--measure", "100%");
    return;
  }
  const px = chToPx(ch);
  // No laid-out prose anywhere (every view's prose hidden — not a state the shell can reach, every
  // view carries one): leave the token as it is. Writing a number derived from nothing is how the
  // column collapsed to one character per line.
  if (px === null) return;
  document.documentElement.style.setProperty("--measure", px);
}

/** What the tooltip reports: the resolved width, and the share of the pane it uses, so the number
 *  on screen can be checked against what the reader sees rather than trusted. Call after
 *  `applyMeasure`, which is what fills the measurement cache. */
export function measureReadout(id: Measure): string {
  const { ch } = MEASURES[id];
  if (ch === null) return "100%";
  const pane = document.querySelector<HTMLElement>("#out-preview")?.getBoundingClientRect().width ?? 0;
  const px = Math.round(ch * cachedChPx);
  return pane > 0 ? `${px}px · ${Math.round((px / pane) * 100)}%` : `${px}px`;
}

/** What the status-bar chip shows: the value for a measured column, the name when it has none. */
export function measureChip(id: Measure): string {
  const { ch, key } = MEASURES[id];
  return ch === null ? t(key) : `${ch}ch`;
}

export function measureName(id: Measure): string {
  return t(MEASURES[id].key);
}

export function nextMeasure(id: Measure): Measure {
  const index = MEASURE_ORDER.indexOf(id);
  return MEASURE_ORDER[(index + 1) % MEASURE_ORDER.length];
}
