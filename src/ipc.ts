/* The only module allowed to call `invoke` or `listen` (IMPL.md §2 rule 3).
 *
 * Two reasons this matters more than it looks:
 *  - The command names and payload shapes are the contract in IMPL.md §3. Keeping them in one
 *    file makes a drift visible in one diff instead of scattered across the UI.
 *  - `ApiError` is a tagged enum, so the decision "what does the user see for this failure" can
 *    be made once, here, instead of at twenty call sites.
 */
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n";

export type ViewMode = "preview" | "split" | "source";
export type ThemeChoice = "light" | "dark" | "system";
/** UI language. `system` follows the OS; the two explicit values are the shipped catalogues. */
export type Lang = "system" | "en" | "zh-CN";
/** Reading-width preset (SPEC §8). Persisted by name, not by pixel value, so the table in
 *  `src/measure.ts` stays the single place the choice is defined. */
export type Measure = "narrow" | "comfortable" | "full";

/** Runtime log level (IMPL.md §13). The same five values Rust accepts; anything else is `info`. */
const LOG_LEVELS = ["off", "error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Narrows a level that came from a session file, which may have been hand-edited. Rust sanitises
 *  at its end, but the front end filters on this value too, so it needs the same rule. */
export const isLogLevel = (value: unknown): value is LogLevel =>
  typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);

/** Mirrors `ApiError` in src-tauri/src/error.rs. */
export type ApiError =
  | { kind: "notFound"; path: string }
  | { kind: "denied"; path: string }
  | { kind: "io"; path: string; message: string }
  | { kind: "notText"; path: string }
  | { kind: "conflict"; path: string }
  | { kind: "refused"; path: string; reason: string };

export function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && "kind" in value;
}

/** One line of user-facing text for an error, plus the flag that decides silent vs toast. */
export function describeError(err: unknown): { message: string; silent: boolean } {
  if (!isApiError(err)) return { message: String(err), silent: false };
  switch (err.kind) {
    case "notFound":
      // "The file was deleted" is not an error the user needs to be told about — the tab goes
      // `missing` instead (IMPL.md §3).
      return { message: t("err.gone", { path: err.path }), silent: true };
    case "denied":
      return { message: t("err.denied", { path: err.path }), silent: false };
    case "notText":
      return { message: t("err.notText", { path: err.path }), silent: false };
    case "conflict":
      // Something else wrote the file after this buffer was loaded. The reader's policy is that an
      // external change wins (SPEC §12), so this is a refusal rather than an overwrite.
      return { message: t("err.conflict", { path: err.path }), silent: false };
    case "refused":
      // A backstop, not a path the UI should reach: the pane already refuses to edit a file that
      // is truncated or lossily decoded. The localised half is the prefix; the specific reason
      // comes from Rust, which is where the byte-level rule lives.
      return { message: `${t("err.refused", { path: err.path })} — ${err.reason}`, silent: false };
    case "io":
      return { message: err.message, silent: false };
  }
}

// ---------------------------------------------------------------- file kinds

/* The one definition of "this is a markdown file" (SPEC §3). Three callers read it: the open
 * dialog's extension filter, the drop/argument check, and the explorer's markdown-only toggle — which
 * is what `TreeEntry.ext` was being carried for. Rust deliberately has no copy of this list: the tree
 * filters what it *shows*, and the watcher counts what it *watches*, so the two are allowed to differ
 * (a `.txt` next to a document is still watched and still reloads). */
export const MD_EXTENSIONS = ["md", "markdown", "mdx", "mdown", "mkd"];

const MD_RE = new RegExp(`\\.(${MD_EXTENSIONS.join("|")})$`, "i");
const MD_SET = new Set(MD_EXTENSIONS);

/** For a path as the dialog, a drop or a command-line argument delivers it. */
export const isMarkdownPath = (path: string): boolean => MD_RE.test(path);

/** For `TreeEntry.ext`, which is lowercase, dotless, and empty for directories and extensionless files. */
export const isMarkdownExt = (ext: string): boolean => MD_SET.has(ext);

// ---------------------------------------------------------------- shapes

export interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  ext: string;
}

export interface FolderView {
  root: string;
  name: string;
  entries: TreeEntry[];
}

export interface FilePayload {
  text: string;
  encoding: string;
  /** `lf`, `crlf`, or `mixed` — a file with both endings. A writer cannot use the reader's
   *  "CRLF wins" heuristic, so the save path refuses `mixed` instead of guessing (SPEC §12). */
  eol: "lf" | "crlf" | "mixed";
  bytes: number;
  mtimeMs: number;
  truncated: boolean;
  /** The read-only attribute (Windows) or a file with no write bit at all (Unix). The pane refuses to
   *  edit such a file rather than letting the save fail later (SPEC §12). */
  writable: boolean;
}

export interface Heading {
  id: string;
  level: number;
  text: string;
  line: number;
}

export interface DiagramBlock {
  id: string;
  /** Normalised by the Rust side: a `graphviz` fence arrives as `dot`. */
  lang: "mermaid" | "dot" | "d2";
  source: string;
  line: number;
}

export interface FrontmatterField {
  key: string;
  value: string;
}

export interface RenderedDoc {
  html: string;
  headings: Heading[];
  diagrams: DiagramBlock[];
  frontmatter: FrontmatterField[];
  words: number;
  lineCount: number;
  /** `utf-8`, `utf-8-bom`, `utf-16le`, `utf-16be`, or `utf-8-lossy`. */
  encoding: string;
  /** The source was cut at 8 MiB before parsing; what is on screen is a prefix. */
  truncated: boolean;
}

export interface EngineInfo {
  id: string;
  version: string;
  installed: boolean;
  bytes: number;
}

export interface WatcherStatus {
  watching: number;
}

export interface SessionTab {
  file: string;
  view: ViewMode;
  scroll: number;
  preview: boolean;
  find: { q: string; case: boolean; hit: number };
}

export interface Session {
  version: number;
  window: { w: number; h: number; x: number | null; y: number | null; maximized: boolean };
  theme: ThemeChoice;
  zoom: number;
  fontSize?: number;
  reduceMotion?: boolean;
  /** Render `$…$` / `$$…$$` as math (SPEC §13). Optional so a session from before the setting
   *  existed still loads; the loader treats absence as `false`, which is the shipped default. */
  math?: boolean;
  lang?: Lang;
  measure?: Measure;
  sidebar: { open: boolean; width: number };
  outlineOpen: boolean;
  outlineWidth?: number;
  /** Explorer shows markdown files only (SPEC §3). Optional so a session from before this existed
   *  still loads; the loader treats absence as `true`, which is the shipped default. */
  mdOnly?: boolean;
  /** Diagnostics (IMPL.md §13.8). Both optional so a session from before this existed still loads;
   *  Rust's defaults are `info` and the platform directory. */
  logLevel?: LogLevel;
  /** Empty means the platform default log directory. */
  logDir?: string;
  activeTab: number;
  tabs: SessionTab[];
  recent: string[];
}

export interface StartupInfo {
  path: string | null;
}

// ---------------------------------------------------------------- invoke wrapper

/** One failed command, in the shape `diag.ts` logs: the command name and the raw error, never the
 *  arguments (`saveDoc`'s arguments are the whole document — IMPL.md §13.7). */
export interface LogEvent {
  level: LogLevel;
  module: string;
  message: string;
  data?: unknown;
}

let errorReporter: ((event: LogEvent) => void) | null = null;

/** `diag.ts` installs the sink once, at boot. A function rather than an import because `diag`
 *  imports `ipc`: this reporter is the only arrow back, and it keeps the graph acyclic. */
export function setErrorReporter(fn: (event: LogEvent) => void): void {
  errorReporter = fn;
}

/** Locale-free and variant-aware on purpose. `describeError` is the user-facing prose; this is what
 *  the log gets, so it must not depend on the active language. */
function rawError(err: unknown): string {
  if (!isApiError(err)) return err instanceof Error ? err.message : String(err);
  switch (err.kind) {
    case "io":
      return `io ${err.path}: ${err.message}`;
    case "refused":
      return `refused ${err.path}: ${err.reason}`;
    default:
      return `${err.kind} ${err.path}`;
  }
}

/** The single place every command goes through (IMPL.md §13.7): on rejection the command name and
 *  the error are reported, then the rejection is passed on untouched. `log_event` is excluded — a
 *  failed log write must never enqueue another log write. */
function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args).catch((err: unknown) => {
    if (cmd !== "log_event") {
      errorReporter?.({ level: "error", module: "ipc", message: `${cmd}: ${rawError(err)}` });
    }
    throw err;
  });
}

// ---------------------------------------------------------------- commands

export const openFolder = (path: string) => call<FolderView>("open_folder", { path });
export const readDir = (path: string) => call<TreeEntry[]>("read_dir", { path });

/** A file resolves to its own folder, a folder to itself. The arithmetic is Rust's job — see the
 *  note on `resolve_target` in src-tauri/src/commands.rs. */
export const resolveTarget = (path: string) => call<FolderView>("resolve_target", { path });

export const readFile = (path: string) => call<FilePayload>("read_file", { path });

/** `math` is passed per call rather than read from the session in Rust: it is the reader's current
 *  setting (SPEC §13), and the render is a pure function of its inputs — toggling it re-renders the
 *  open documents instead of mutating a global the next render would silently pick up. */
export const renderDoc = (path: string, math: boolean) =>
  call<RenderedDoc>("render_doc", { path, math });

/** Renders a buffer that has no file behind it yet, so the split view can show what is being typed
 *  (SPEC §12). `encoding` and `truncated` come back empty/false — the caller overrides them from the
 *  tab, which is where those two facts live.
 *
 *  `path` is still the document's: the text is unsaved, but its relative images are not, and they
 *  resolve against the folder the file lives in (null for text with no file behind it). */
export const renderText = (text: string, path: string | null, math: boolean) =>
  call<RenderedDoc>("render_text", { text, path, math });

/** Writes an edited buffer back (SPEC §12), and returns the file's new mtime — that becomes the
 *  next save's baseline. The Rust side refuses a mixed-ending file, a lossy decode, and any write
 *  whose expected mtime no longer matches what is on disk. */
export const saveDoc = (
  path: string,
  text: string,
  encoding: string,
  eol: FilePayload["eol"],
  expectedMtimeMs: number,
) => call<number>("save_doc", { path, text, encoding, eol, expectedMtimeMs });

/** What the system opens `.md` with, and what this platform will let the app do about it (SPEC §10).
 *  On Linux that is `xdg-mime`; on Windows the choice is the user's and the app can only hand it over. */
export interface DefaultAppStatus {
  platform: string;
  /** Is MarkdownAura among the applications that can open a `.md`? */
  registered: boolean;
  isDefault: boolean;
  /** A friendly name for whatever is the handler now, or the raw identifier. */
  current: string;
  /** What `setDefaultApp` will do: set it, or open a dialog / the settings page. */
  action: "set" | "dialog" | "settings" | string;
  /** Set once by the installer, consumed by the first launch that asks. */
  offer: boolean;
}

export const defaultAppStatus = () => call<DefaultAppStatus>("default_app_status");

/** `path` is the open document, which the Windows *Open with* dialog needs; Linux ignores it. */
export const setDefaultApp = (path: string | null) => call<string>("set_default_app", { path });
export const revealInExplorer = (path: string) => call<void>("reveal_in_explorer", { path });

export const watchSet = (paths: string[]) => call<WatcherStatus>("watch_set", { paths });
export const watchStopAll = () => call<void>("watch_stop_all");
export const watcherStatus = () => call<WatcherStatus>("watcher_status");

export const sessionLoad = () => call<Session | null>("session_load");
export const sessionSave = (session: Session) => call<void>("session_save", { session });

export const engineStatus = () => call<EngineInfo[]>("engine_status");
export const startupTarget = () => call<StartupInfo>("startup_target");
export const noteRecent = (entry: string) => call<string[]>("note_recent", { entry });

/** Where the app keeps its state, for the About sheet to show and open. */
export const dataDirectory = () => call<string>("data_directory");

// ---------------------------------------------------------------- diagnostics

/** Mirrors `PreviousRun` in src-tauri/src/diag.rs. */
export interface PreviousRun {
  run: string;
  started: string;
}

/** Mirrors `DiagStatus` in src-tauri/src/diag.rs. */
export interface DiagStatus {
  level: string;
  run: string;
  logDir: string;
  previousUnclean: PreviousRun | null;
}

/** One diagnostic line. `diag.ts` never awaits it, and a failure here is deliberately not reported
 *  back through the wrapper above: that would be the loop `log_event` is excluded from. */
export const logEvent = (level: LogLevel, module: string, message: string, data?: unknown) =>
  call<void>("log_event", { level, module, message, data });

/** Sets the Rust in-process level; the returned string is what it actually applied. */
export const setLogLevel = (level: LogLevel) => call<string>("set_log_level", { level });

/** `dir` empty means "back to the platform default"; the return value is the path now in effect. */
export const setLogDir = (dir: string) => call<string>("set_log_dir", { dir });

export const diagStatus = () => call<DiagStatus>("diag_status");
export const openLogFolder = () => call<void>("open_log_folder");

/** The two file dialogs, behind this boundary like every other plugin call (IMPL.md §2 rule 3).
 *  `title` is the OS dialog's own caption, so it arrives from the caller rather than being copy this
 *  module owns. `null` means the user cancelled. */
export const pickDirectory = async (title: string): Promise<string | null> => {
  const picked = await openDialog({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
};

export const pickFile = async (title: string, extensions: string[]): Promise<string | null> => {
  const picked = await openDialog({ multiple: false, title, filters: [{ name: "Markdown", extensions }] });
  return typeof picked === "string" ? picked : null;
};

/** Opens a URL in the system browser. Wrapped here for the same reason every other call is: this
 *  module is the app's whole Tauri boundary (`IMPL.md` §2 rule 3), plugin APIs included. The plugin
 *  is scoped by capability to the one URL the app links to. */
export const openExternal = (url: string) => openUrl(url);

// ---------------------------------------------------------------- updates

/* The app's one network call (SPEC §10). It is driven entirely by a click in the About sheet — nothing
 * here runs at startup — and the endpoint is a single GitHub release asset (`latest.json`), configured
 * in `tauri.conf.json`. The installer that asset points at is verified against the public key baked
 * into the same file, so an artifact that did not come from this project's signing key is refused
 * before it is written to disk. */

/** What a check found, flattened for the UI. `null` means "already current". */
export interface UpdateOffer {
  version: string;
  date: string | null;
  notes: string;
}

let offer: Update | null = null;

export async function updateCheck(): Promise<UpdateOffer | null> {
  await offer?.close().catch(() => {});
  offer = await check();
  if (!offer) return null;
  return { version: offer.version, date: offer.date ?? null, notes: offer.body ?? "" };
}

/** Downloads the verified installer. `percent` is null when the server sent no content length. */
export async function updateDownload(onProgress: (percent: number | null) => void): Promise<void> {
  if (!offer) throw new Error("no update to download");
  let total = 0;
  let done = 0;
  await offer.download((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
    } else if (event.event === "Progress") {
      done += event.data.chunkLength;
      onProgress(total > 0 ? Math.min(99, Math.round((done / total) * 100)) : null);
    } else {
      onProgress(100);
    }
  });
}

export async function updateInstall(): Promise<void> {
  if (!offer) throw new Error("no update to install");
  await offer.install();
}

/** The installer replaces the files on disk; the running process has to step aside. */
export const relaunchApp = (): Promise<void> => relaunch();

// ---------------------------------------------------------------- events

export interface ChangedPayload {
  paths: string[];
}

/** One batch of edits, never one event per file — the debounce lives in Rust (IMPL.md §3). */
export const onFsChanged = (handler: (payload: ChangedPayload) => void): Promise<UnlistenFn> =>
  listen<ChangedPayload>("fs://changed", (e) => handler(e.payload));

export const onFsRemoved = (handler: (payload: ChangedPayload) => void): Promise<UnlistenFn> =>
  listen<ChangedPayload>("fs://removed", (e) => handler(e.payload));

/** A second launch ("Open with MarkdownAura") hands its path to this window. */
export const onOpenRequest = (handler: (path: string) => void): Promise<UnlistenFn> =>
  listen<string>("app://open", (e) => handler(e.payload));

// ---------------------------------------------------------------- drag & drop

/* With `dragDropEnabled`, the WebView does not fire HTML5 drop events at all (IMPL §8), so the
 * drop zone cannot be a CSS `:drop` state — these core events are the only signal there is. */

export interface DragPayload {
  paths: string[];
  position: { x: number; y: number };
}

export const onDragEnter = (handler: (payload: DragPayload) => void): Promise<UnlistenFn> =>
  listen<DragPayload>("tauri://drag-enter", (e) => handler(e.payload));

export const onDragLeave = (handler: () => void): Promise<UnlistenFn> =>
  listen<unknown>("tauri://drag-leave", () => handler());

export const onDragDrop = (handler: (payload: DragPayload) => void): Promise<UnlistenFn> =>
  listen<DragPayload>("tauri://drag-drop", (e) => handler(e.payload));
