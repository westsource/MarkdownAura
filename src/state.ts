/* The single source of truth for everything the UI shows (IMPL.md §5).
 *
 * The shape is the mockup's record with its internal fields dropped, so `mockup.js` and this
 * file stay comparable when someone wonders why a behaviour differs.
 *
 * The three v2 fields are present on purpose and deliberately unwired. Removing them would
 * make the eventual v2 work a refactor instead of a wire-up; SPEC §5 spells this out.
 */
import { DEFAULT_MEASURE, isMeasure } from "./measure";
import { isLogLevel } from "./ipc";
import type { Lang, LogLevel, Measure, RenderedDoc, Session, SessionTab, ThemeChoice, ViewMode } from "./ipc";

export interface Tab {
  id: string;
  /** Absolute path. This — not the id — is the identity for "already open". */
  file: string;
  name: string;
  view: ViewMode;
  scroll: number;
  outlineHit: string | null;
  find: { q: string; case: boolean; hit: number };
  /** Italic in the tab strip: opened by a single click in the tree. */
  preview: boolean;

  // v2 contract — keep the fields, do not wire them (SPEC §5).
  missing: boolean;
  reloading: boolean;
  pinned: boolean;

  // Loaded document. Null until the first render finishes.
  doc: RenderedDoc | null;
  source: string | null;
  encoding: string;
  /** `lf`, `crlf`, or `mixed`. A mixed file can be read and shown, but not edited: a buffer is
   *  line-normalised, so saving one would rewrite half its endings (SPEC §12). */
  eol: "lf" | "crlf" | "mixed";

  /** SPEC §12 — the editable pane. `editing` is the mode, `buffer` is the text once it differs from
   *  the file (`null` = untouched), `dirty` says the two differ, `loadedMtimeMs` is the baseline the
   *  save is checked against, and `blocked` is why this file cannot be edited at all. */
  editing: boolean;
  dirty: boolean;
  buffer: string | null;
  loadedMtimeMs: number;
  blocked: null | "truncated" | "lossy" | "mixed" | "missing" | "readonly";
  words: number;
  bytes: number;
  renderMs: number;
  /** The file is larger than the 8 MiB read cap; the status bar says so. */
  truncated: boolean;
}

export interface WindowState {
  theme: ThemeChoice;
  zoom: number;
  /** Reading size in px, written to `--doc-size`. Multiplies with `zoom`, never overrides it. */
  fontSize: number;
  reduceMotion: boolean;
  /** UI language; `system` resolves against the OS and is persisted as-is. */
  lang: Lang;
  /** Reading-width preset, written to `--measure` (SPEC §8). */
  measure: Measure;
  sidebar: { open: boolean; width: number };
  outlineOpen: boolean;
  /** Outline width in px, written to `--w-outline` (SPEC §3). */
  outlineWidth: number;
  /** The explorer lists markdown files only. Default `true`: a folder of images should not bury the
   *  documents. Directories always show — the tree is loaded a level at a time, so "does this folder
   *  hold markdown?" is not knowable without reading it (SPEC §3). */
  mdOnly: boolean;
  /** Diagnostics (IMPL.md §13.8): the level `diag.ts` filters on, and the log directory Settings
   *  shows. Empty `logDir` is the platform default, which is also what Rust assumes. */
  logLevel: LogLevel;
  logDir: string;
  activeTab: number;
  tabs: Tab[];
  recent: string[];
  /** Folder currently open in the explorer, or null for the empty state. */
  root: string | null;
  /** Watched file count, last read from the watcher. Not persisted — a language change has to
   *  re-render the label, which needs the number without asking Rust again. */
  watching: number;
  /** Last known window rect, refreshed at save time. Not live state — a cache for the session. */
  windowRect: WindowRect;
}

let tabSeq = 0;

export function makeTab(file: string, name: string, preview: boolean): Tab {
  return {
    id: `t${tabSeq++}`,
    file,
    name,
    view: "preview",
    scroll: 0,
    outlineHit: null,
    find: { q: "", case: false, hit: 0 },
    preview,
    missing: false,
    reloading: false,
    pinned: false,
    doc: null,
    source: null,
    encoding: "utf-8",
    eol: "lf",
    editing: false,
    dirty: false,
    buffer: null,
    loadedMtimeMs: 0,
    blocked: null,
    words: 0,
    bytes: 0,
    renderMs: 0,
    truncated: false,
  };
}

export const state: WindowState = {
  theme: "system",
  zoom: 100,
  fontSize: 15,
  reduceMotion: false,
  lang: "system",
  measure: DEFAULT_MEASURE,
  sidebar: { open: true, width: 224 },
  outlineOpen: true,
  outlineWidth: 200,
  mdOnly: true,
  logLevel: "info",
  logDir: "",
  activeTab: 0,
  tabs: [],
  recent: [],
  root: null,
  watching: 0,
  windowRect: { w: 1200, h: 800, x: null, y: null, maximized: false },
};

export function activeTab(): Tab | null {
  return state.tabs[state.activeTab] ?? null;
}

export function tabByFile(file: string): Tab | null {
  return state.tabs.find((t) => samePath(t.file, file)) ?? null;
}

/** Windows paths are case-insensitive, and the same file can arrive with either separator. */
export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/** Windows and macOS compare paths case-insensitively by default; Linux does not — and on Linux a
 *  backslash is an ordinary character in a filename rather than a separator. So the two need
 *  different normalisation, not a shared lowercasing: doing it the Windows way on Linux conflates
 *  `Notes.md` with `notes.md` and turns a legal name into a path. */
const CASE_INSENSITIVE_PATHS = /^(win|mac)/i.test(navigator.platform);
const WINDOWS_SEPARATORS = /^win/i.test(navigator.platform);

export function normalizePath(p: string): string {
  if (!WINDOWS_SEPARATORS) {
    const trimmed = p.length > 1 ? p.replace(/\/+$/, "") : p;
    return CASE_INSENSITIVE_PATHS ? trimmed.toLowerCase() : trimmed;
  }
  const slashed = p.replace(/\\/g, "/");
  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
  return trimmed.toLowerCase();
}

/** The one preview tab, if there is one. A single tree click reuses it rather than opening a
 *  second tab (IMPL.md §5 invariant). */
export function previewTab(): Tab | null {
  return state.tabs.find((t) => t.preview) ?? null;
}

export interface WindowRect {
  w: number;
  h: number;
  x: number | null;
  y: number | null;
  maximized: boolean;
}

export function toSession(windowRect: WindowRect): Session {
  const tabs: SessionTab[] = state.tabs.map((t) => ({
    file: t.file,
    view: t.view,
    scroll: t.scroll,
    preview: t.preview,
    find: { q: t.find.q, case: t.find.case, hit: t.find.hit },
  }));

  return {
    version: 1,
    window: windowRect,
    theme: state.theme,
    zoom: state.zoom,
    fontSize: state.fontSize,
    reduceMotion: state.reduceMotion,
    lang: state.lang,
    measure: state.measure,
    sidebar: { open: state.sidebar.open, width: state.sidebar.width },
    outlineOpen: state.outlineOpen,
    outlineWidth: state.outlineWidth,
    mdOnly: state.mdOnly,
    logLevel: state.logLevel,
    logDir: state.logDir,
    activeTab: state.activeTab,
    tabs,
    recent: state.recent.slice(),
  };
}

/** Applies a restored session. Tabs whose file no longer exists are *kept*: the loader turns
 *  them into `missing` rather than dropping them, because losing a tab to a temporary rename is
 *  worse than showing a struck-through one (IMPL.md §6). */
export function applySession(session: Session): void {
  state.theme = session.theme;
  state.zoom = session.zoom;
  state.fontSize = session.fontSize ?? 15;
  state.reduceMotion = session.reduceMotion ?? false;
  state.lang = session.lang ?? "system";
  // A hand-edited or older session may name a preset that no longer exists; fall back rather than
  // writing an invalid value into the token.
  state.measure = isMeasure(session.measure) ? session.measure : DEFAULT_MEASURE;
  state.sidebar = { ...session.sidebar };
  state.outlineOpen = session.outlineOpen;
  state.outlineWidth = session.outlineWidth ?? 200;
  state.mdOnly = session.mdOnly ?? true;
  // A hand-edited session may name a level that never existed; `info` is what Rust falls back to.
  state.logLevel = isLogLevel(session.logLevel) ? session.logLevel : "info";
  state.logDir = session.logDir ?? "";
  state.recent = session.recent.slice();
  state.tabs = session.tabs.map((t) => {
    const name = t.file.split(/[\\/]/).pop() ?? t.file;
    const tab = makeTab(t.file, name, t.preview);
    tab.view = t.view;
    tab.scroll = t.scroll;
    tab.find = { ...t.find };
    return tab;
  });
  state.activeTab = Math.min(session.activeTab, Math.max(0, state.tabs.length - 1));
}
