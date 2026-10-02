/* Reading-width presets (SPEC §8, §10).
 *
 * The text column is a *setting*, not a typographic constant: a fixed measure is a fraction of the
 * pane that depends on the pane, and on a 3440px display the old fixed 72ch came to 19% of the
 * content area (measured). But it is a preset rather than a free slider, because line length is the
 * one typographic knob a reader can genuinely wreck.
 *
 * The two measured presets are in `ch` — the only unit that keeps a line *readable* whatever the
 * window size — and `full` is a percentage, because there the request is "use the pane", which is
 * exactly what a percentage measures. `comfortable` was raised from 72ch to 100ch on the reader's
 * call: 72 sits in the classic 45–75 band, while on-screen technical reading (docs sites, code
 * hosts) runs 80–120; `narrow` is there for long-form prose, and the tooltip always reports the
 * resolved width and its share of the pane so the number is never a mystery.
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
  // No text cap and no wide-content exemption either: every block shares the column, so `full`
  // means the pane's content box. The pane already carries its own gutter as padding.
  full: { key: "measure.full", ch: null },
};

/** Display and cycle order, narrowest first. */
export const MEASURE_ORDER: Measure[] = ["narrow", "comfortable", "full"];

export const DEFAULT_MEASURE: Measure = "comfortable";

export function isMeasure(value: unknown): value is Measure {
  return typeof value === "string" && Object.hasOwn(MEASURES, value);
}

let cachedFont = "";
let cachedChPx = 0;

/** `ch` is resolved against the *using* element's font size, so a token written as `72ch` used by
 *  an `h1` (22px) is 40% wider than the same token on a paragraph (16px) — the reading column came
 *  out ragged, heading by heading. The measure is therefore resolved **once**, against the prose
 *  font, into a pixel value every block shares. */
function chToPx(ch: number): string {
  // Measured in the preview pane: it is the element whose font the token describes, so the probe
  // inherits the exact family, size and zoom without duplicating the CSS here.
  const host = document.querySelector<HTMLElement>("#out-preview") ?? document.body;
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
  const { ch } = MEASURES[id];
  document.documentElement.style.setProperty("--measure", ch === null ? "100%" : chToPx(ch));
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
