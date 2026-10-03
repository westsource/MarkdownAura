/* The only module allowed to call `invoke` or `listen` (IMPL.md §2 rule 3).
 *
 * Two reasons this matters more than it looks:
 *  - The command names and payload shapes are the contract in IMPL.md §3. Keeping them in one
 *    file makes a drift visible in one diff instead of scattered across the UI.
 *  - `ApiError` is a tagged enum, so the decision "what does the user see for this failure" can
 *    be made once, here, instead of at twenty call sites.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "./i18n";

export type ViewMode = "preview" | "split" | "source";
export type ThemeChoice = "light" | "dark" | "system";
/** UI language. `system` follows the OS; the two explicit values are the shipped catalogues. */
export type Lang = "system" | "en" | "zh-CN";
/** Reading-width preset (SPEC §8). Persisted by name, not by pixel value, so the table in
 *  `src/measure.ts` stays the single place the choice is defined. */
export type Measure = "narrow" | "comfortable" | "full";

/** Mirrors `ApiError` in src-tauri/src/error.rs. */
export type ApiError =
  | { kind: "notFound"; path: string }
  | { kind: "denied"; path: string }
  | { kind: "io"; path: string; message: string }
  | { kind: "notText"; path: string };

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
  eol: "lf" | "crlf";
  bytes: number;
  mtimeMs: number;
  truncated: boolean;
}

export interface Heading {
  id: string;
  level: number;
  text: string;
  line: number;
}

export interface DiagramBlock {
  id: string;
  lang: string;
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
  lang?: Lang;
  measure?: Measure;
  sidebar: { open: boolean; width: number };
  outlineOpen: boolean;
  outlineWidth?: number;
  /** Explorer shows markdown files only (SPEC §3). Optional so a session from before this existed
   *  still loads; the loader treats absence as `true`, which is the shipped default. */
  mdOnly?: boolean;
  activeTab: number;
  tabs: SessionTab[];
  recent: string[];
}

export interface StartupInfo {
  path: string | null;
}

// ---------------------------------------------------------------- commands

export const openFolder = (path: string) => invoke<FolderView>("open_folder", { path });
export const readDir = (path: string) => invoke<TreeEntry[]>("read_dir", { path });

/** A file resolves to its own folder, a folder to itself. The arithmetic is Rust's job — see the
 *  note on `resolve_target` in src-tauri/src/commands.rs. */
export const resolveTarget = (path: string) => invoke<FolderView>("resolve_target", { path });

export const readFile = (path: string) => invoke<FilePayload>("read_file", { path });
export const renderDoc = (path: string) => invoke<RenderedDoc>("render_doc", { path });
export const revealInExplorer = (path: string) => invoke<void>("reveal_in_explorer", { path });

export const watchSet = (paths: string[]) => invoke<WatcherStatus>("watch_set", { paths });
export const watchStopAll = () => invoke<void>("watch_stop_all");
export const watcherStatus = () => invoke<WatcherStatus>("watcher_status");

export const sessionLoad = () => invoke<Session | null>("session_load");
export const sessionSave = (session: Session) => invoke<void>("session_save", { session });

export const engineStatus = () => invoke<EngineInfo[]>("engine_status");
export const startupTarget = () => invoke<StartupInfo>("startup_target");
export const noteRecent = (entry: string) => invoke<string[]>("note_recent", { entry });

/** Where the app keeps its state, for the About sheet to show and open. */
export const dataDirectory = () => invoke<string>("data_directory");

/** Opens a URL in the system browser. Wrapped here for the same reason every other call is: this
 *  module is the app's whole Tauri boundary (`IMPL.md` §2 rule 3), plugin APIs included. The plugin
 *  is scoped by capability to the one URL the app links to. */
export const openExternal = (url: string) => openUrl(url);

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
