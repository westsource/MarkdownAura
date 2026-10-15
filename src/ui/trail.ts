/* The reading trail as a sheet (SPEC §6, §7).
 *
 * One row per document or folder: what it is, where it lives, and the one fact that makes the list
 * worth having — that the reader was in the middle of it. Grouped by *last touch*, filterable, and
 * clearable, because a store that remembers what you read has to have a way out that is not "delete a
 * file in %APPDATA%".
 *
 * The list is `state.trail`, which Rust answers with and which every writer replaces wholesale
 * (`state.ts`). Nothing here opens anything: a row hands the entry back to `main.ts`, which owns
 * `openFile` — the same shape `outline.ts` uses for its jumps.
 *
 * Every label a menu would also want (`whenLabel`, `rowLabels`) lives here rather than in `main.ts`, so
 * a row cannot describe itself two different ways in the menu and in the sheet.
 */
import { TRAIL_CAP, TRAIL_DAYS, trailClear, type TrailEntry } from "../ipc";
import { t, type Key } from "../i18n";
import { state } from "../state";
import { $, esc, toast } from "./dom";

export interface TrailHooks {
  /** A row was chosen. `main.ts` decides whether that is a document or a folder. */
  onOpen: (entry: TrailEntry) => void;
  /** The list changed underneath us (only `clear` today): repaint the empty state, the mark's title
   *  and the two menus, all of which are built from `state.trail`. */
  onChanged: () => void;
}

let query = "";
let hooks: TrailHooks = { onOpen: () => {}, onChanged: () => {} };

export function wire(next: TrailHooks): void {
  hooks = next;
  $("#trailClose").addEventListener("click", close);
  $("#trailFilter").addEventListener("input", (event) => {
    query = (event.target as HTMLInputElement).value;
    render();
  });
  $("#trailClear").addEventListener("click", () => void forgetEverything());
}

export function isOpen(): boolean {
  return $("#trailOverlay").classList.contains("on");
}

export function open(): void {
  query = "";
  const filter = $("#trailFilter") as HTMLInputElement;
  filter.value = "";
  render();
  $("#trailOverlay").classList.add("on");
  // The filter takes the focus: the sheet is opened to find something, and typing is how you find it in
  // a list of a hundred. `esc` still closes, because the filter is not a layer of its own.
  filter.focus();
}

export function close(): void {
  $("#trailOverlay").classList.remove("on");
}

async function forgetEverything(): Promise<void> {
  const had = state.trail.length;
  try {
    await trailClear();
  } catch (err) {
    // A failed clear is not silent: the reader asked for something to be forgotten, and believing it
    // happened when it did not is the one outcome this must not produce.
    toast(`${t("trail.clearFailed")}`, "err");
    return;
  }
  state.trail = [];
  render();
  hooks.onChanged();
  if (had > 0) toast(t("trail.cleared", { n: had }), "warn");
}

/** The entry's last touch: read or opened, whichever is later. Everything visible below — the group, the
 *  order, the window — measures from here, so a document opened in March and read this morning files
 *  under `today` rather than under March. */
function touchOf(entry: TrailEntry): number {
  return Math.max(entry.openedAt, entry.lastRead?.at ?? 0);
}

const BUCKETS = ["today", "yesterday", "thisWeek", "earlier"] as const;
type Bucket = (typeof BUCKETS)[number];

function bucketOf(at: number): Bucket {
  // Calendar-relative, not "n hours ago": yesterday that means 26 hours is wrong at 01:00, which is
  // exactly when a reader notices.
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const t0 = midnight.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (at >= t0) return "today";
  if (at >= t0 - day) return "yesterday";
  if (at >= t0 - 6 * day) return "thisWeek";
  return "earlier";
}

const two = (n: number) => String(n).padStart(2, "0");

/** The exact time, for the tooltip. A column of absolute timestamps is a log; what a reader needs from
 *  this list is "roughly when" plus "where exactly", and the second one is a hover away. */
function fmtAt(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * The right-hand column. Inside `today` the useful fact is how long ago (`12m`, `3h`); the older groups
 * already say that in their label, so the column carries the date instead — without which a row reads
 * `yesterday … yesterday` under the heading `yesterday`. `MM-DD` is enough inside this year (the window
 * is 90 days) and it grows a year when it is not, because a bare `01-04` in January is ambiguous rather
 * than terse.
 */
export function whenLabel(entry: TrailEntry): string {
  const at = touchOf(entry);
  if (bucketOf(at) === "today") {
    const since = Date.now() - at;
    const minutes = Math.round(since / 60000);
    if (minutes < 1) return t("trail.now");
    if (minutes < 60) return `${minutes}m`;
    return `${Math.round(minutes / 60)}h`;
  }
  const d = new Date(at);
  const md = `${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/** The row's parts, shared with both menus. `sub` is the sheet's second line, which carries the resume
 *  fact — "read to §Pipeline" — the whole reason this list beats a list of paths; `where` is just the
 *  directory, which is all a one-line menu row has room for. */
export function rowLabels(entry: TrailEntry): { name: string; sub: string; where: string } {
  const name = basename(entry.path);
  const where = dirname(entry.path);
  if (entry.kind === "folder") {
    return { name, where, sub: `${t("trail.folder")} · ${where}` };
  }
  const resume = entry.missing
    ? t("trail.gone")
    : entry.lastRead
      ? t("trail.readTo", { heading: entry.lastRead.heading })
      : t("trail.neverScrolled");
  return { name, where, sub: `${where} · ${resume}` };
}

/** Split on both separators: a path can arrive with either one, and the app normalises them nowhere.
 *  `basename`/`dirname` beat a regex here only in that they read the way the rest of the file does. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function dirname(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join("\\") || path;
}

function matches(entry: TrailEntry, q: string): boolean {
  return [entry.path, entry.lastRead?.heading ?? ""].join(" ").toLowerCase().includes(q);
}

export function render(): void {
  const q = query.trim().toLowerCase();
  const shown = state.trail.filter((entry) => q.length === 0 || matches(entry, q));
  const body = $("#trailBody");

  let html = "";
  let bucket: Bucket | null = null;
  shown.forEach((entry, index) => {
    const next = bucketOf(touchOf(entry));
    if (next !== bucket) {
      html += `<div class="trail-group">${esc(t(`trail.${next}` as Key))}</div>`;
      bucket = next;
    }
    const { name, sub } = rowLabels(entry);
    html +=
      `<div class="trail-row${entry.missing ? " missing" : ""}" data-row="${index}" role="button" tabindex="0"` +
      ` title="${esc(fmtAt(touchOf(entry)))}">` +
      `<div class="trail-main"><div class="trail-name">${esc(name)}</div>` +
      `<div class="trail-sub">${esc(sub)}</div></div>` +
      `<div class="trail-when">${esc(whenLabel(entry))}</div></div>`;
  });
  body.innerHTML =
    html ||
    `<div class="trail-none">${
      state.trail.length > 0 ? esc(t("trail.noMatch", { q: query })) : esc(t("trail.empty"))
    }</div>`;

  $("#trailCount").textContent = String(shown.length);
  $("#trailMeta").textContent = t("trail.bounds", {
    n: state.trail.length,
    cap: TRAIL_CAP,
    days: TRAIL_DAYS,
  });
  ($("#trailClear") as HTMLButtonElement).disabled = state.trail.length === 0;

  // Re-read on every render rather than captured: the list is rebuilt from scratch, and a click handler
  // holding an index into the previous array is how a row opens the wrong document.
  body.querySelectorAll<HTMLElement>("[data-row]").forEach((el) => {
    const index = Number(el.dataset.row ?? "-1");
    el.addEventListener("click", () => hooks.onOpen(shown[index]));
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter") hooks.onOpen(shown[index]);
    });
  });
}
