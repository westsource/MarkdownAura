/* Boot and wiring.
 *
 * Everything the app can do to itself is orchestrated here, so the modules stay about rendering
 * and this file stays about order of operations. The two things worth reading closely are
 * `openFile` (the tab reuse rules in IMPL.md §5 are easy to get subtly wrong and impossible to
 * notice until someone loses a tab) and `scheduleSave` (the 500 ms debounce from §6).
 */
import "@design/tokens.css";
import "@design/components.css";
import "@design/prose.css";

import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";

import * as ipc from "./ipc";
import * as diag from "./diag";
import * as i18n from "./i18n";
import * as measure from "./measure";
import { invalidateEngineThemes } from "./render/engines";
import { preloadMath } from "./render/math";
import {
  activeTab,
  applySession,
  makeTab,
  previewTab,
  samePath,
  state,
  tabByFile,
  toSession,
  type Tab,
  type WindowRect,
} from "./state";
import * as doc from "./ui/document";
import * as editor from "./ui/editor";
import * as about from "./ui/about";
import { $, $$, copyText, hideMenu, menuIsOpen, showMenu, toast, type MenuItem } from "./ui/dom";
import * as find from "./ui/find";
import * as help from "./ui/help";
import * as immersive from "./ui/immersive";
import * as outline from "./ui/outline";
import * as panels from "./ui/panels";
import * as settings from "./ui/settings";
import * as status from "./ui/statusbar";
import * as tabs from "./ui/tabs";
import * as tree from "./ui/tree";
import * as viewer from "./ui/viewer";

// The markdown extension test lives in `ipc.ts` now: the open dialog's filter, the drop and argument
// checks, and the explorer's markdown-only toggle all read one definition (SPEC §3).

// Installed before anything else runs. `install()` is what captures every later exception and
// rejected promise, so it has to be the first statement a module can make (IMPL.md §13.6) — an
// import is the only place earlier than this.
diag.install();

const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;

// ---------------------------------------------------------------- theme & layout

function resolvedTheme(): "light" | "dark" {
  if (state.theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return state.theme;
}

function applyTheme(): void {
  const resolved = resolvedTheme();
  document.documentElement.dataset.theme = resolved;
  // Mermaid bakes its palette into the SVG at render time, so a theme change invalidates it and
  // the next render has to re-read the tokens.
  invalidateEngineThemes();
  // The editor needs no reset here: its colours are CSS classes on tokens, so a theme switch reaches
  // it the way it reaches the rest of the chrome.
  renderThemeButton(resolved);
}

const SUN_ICON =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><circle cx="8" cy="8" r="3.1"/><path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1"/></svg>';
const MOON_ICON =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"><path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8 5.6 5.6 0 1 0 13.2 9.6z"/></svg>';

function renderThemeButton(resolved: "light" | "dark"): void {
  const button = $("#toggleTheme");
  button.innerHTML = resolved === "dark" ? SUN_ICON : MOON_ICON;
  button.title = resolved === "dark" ? i18n.t("theme.switchLight") : i18n.t("theme.switchDark");
}

function applyLayout(): void {
  // Single source of truth for panel visibility. `components.css` also hides panels at narrow
  // window widths, and an inline style would silently override that — so nothing here sets
  // `display` when the panel should be visible. The SPEC §3 note explains why that matters.
  $("#sidebar").style.display = state.sidebar.open ? "" : "none";
  $("#outline").style.display = state.outlineOpen ? "" : "none";
  $("#toggleSidebar").classList.toggle("on", state.sidebar.open);
  $("#toggleOutline").classList.toggle("on", state.outlineOpen);

  document.documentElement.style.setProperty("--zoom", String(state.zoom / 100));
  document.documentElement.style.setProperty("--doc-size", `${state.fontSize}px`);
  document.documentElement.dataset.motion = state.reduceMotion ? "reduce" : "";
  panels.applyWidths();
  measure.applyMeasure(state.measure);
  status.setZoomLabel(state.zoom);
  // The tooltip names the preset *and* what it resolved to: "72ch" is the preset's identity, the
  // pixel width and pane share are what the reader actually sees, and both move with the font size
  // and the zoom.
  const measureTitle = i18n.t("status.measureTitle", { name: measure.measureName(state.measure) }) +
    " · " + measure.measureReadout(state.measure);
  status.setMeasureLabel(measure.measureChip(state.measure), measureTitle);
  immersive.setReadingLabels({
    measure: measure.measureChip(state.measure),
    measureTitle,
    zoom: `${state.zoom}%`,
    zoomTitle: i18n.t("status.resetZoom"),
  });
}

/**
 * Applies the language and re-renders everything that carries copy.
 *
 * `applyStatic()` covers the shell's own text, but a module-owned string (the watcher count, a
 * section head, a help row) is generated at render time, so the surfaces have to be re-rendered
 * or they keep the previous language. This is the only place that knows the full list.
 */
function applyLang(): void {
  i18n.setLang(state.lang);
  i18n.applyStatic();
  applyTheme(); // the theme button's tooltip is language-dependent
  // The pill's text is a state label, so it cannot ride on `data-i18n`; it is repainted instead.
  paintEditorChrome(activeTab());
  applyLayout(); // the width chip and its tooltip carry language too
  renderChrome();
  status.setWatchLabel(state.watching);
  if (settings.isOpen()) settings.open();
  if (help.isOpen()) help.open();
  if (about.isOpen()) about.open();
}

/** One field, two surfaces: the status-bar chip and the settings row both come through here. */
function setMeasure(next: ipc.Measure): void {
  if (next === state.measure) return;
  state.measure = next;
  applyLayout();
  scheduleSave();
}

function setZoom(percent: number): void {
  state.zoom = Math.min(200, Math.max(50, Math.round(percent)));
  // Every layout token goes through applyLayout — that is what keeps the status bar chip and the
  // immersive bar's chip in step. Writing a font-size straight onto `.prose` would also beat
  // `--doc-size` from settings and make that control silently do nothing.
  applyLayout();
  scheduleSave();
}

// ---------------------------------------------------------------- rendering

function renderChrome(): void {
  const tab = activeTab();
  tabs.renderTabs();
  outline.renderOutline(tab?.doc ?? null);
  status.setStatus(tab);
  status.setRenderTime(tab?.renderMs ?? 0);
  paintEditorChrome(tab);
  tree.setActiveFile(tab?.file ?? null);
  $("#empty").hidden = state.tabs.length > 0;
}

async function paintActive(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  // View mode is per-tab state (SPEC §5): the segmented control follows the active tab, in both
  // directions. Without this, switching tabs — or restoring a session — leaves the previous
  // tab's view showing, and the restored scroll position lands in the wrong scroller.
  if (doc.currentView() !== tab.view) doc.setView(tab.view);
  const started = performance.now();
  await doc.renderDocument(tab);
  tab.renderMs = performance.now() - started;
  status.setRenderTime(tab.renderMs);
  status.refreshEngineDots();
  // The editable pane is the other half of the same paint: whichever pane shows source gets the
  // document, and the read-only `<pre>` keeps the text for the panes that are not editable.
  await syncEditor(tab);
  // Re-rendering replaced the DOM, so any find marks are gone; put them back.
  find.refresh(tab);
}

/** The source view is the only place that needs the raw text, so it is fetched lazily. */
async function ensureSource(tab: Tab): Promise<void> {
  if (tab.source !== null) return;
  try {
    const payload = await ipc.readFile(tab.file);
    tab.source = payload.text;
    tab.encoding = payload.encoding;
    tab.eol = payload.eol;
    tab.bytes = payload.bytes;
    tab.truncated = payload.truncated;
    // The mtime is the baseline the save is checked against, and the two flags below are what the
    // reader only *badges* — a badge is safe only while nothing can write (SPEC §12).
    tab.loadedMtimeMs = payload.mtimeMs;
    tab.blocked = blockedReason(payload);
  } catch (err) {
    const { message, silent } = ipc.describeError(err);
    if (!silent) toast(message, "err");
    tab.source = "";
  }
}

async function loadTab(tab: Tab): Promise<void> {
  try {
    const rendered = await ipc.renderDoc(tab.file, state.math);
    tab.doc = rendered;
    tab.words = rendered.words;
    tab.encoding = rendered.encoding || tab.encoding;
    tab.truncated = rendered.truncated;
    tab.missing = false;
    if (tab.view !== "preview") await ensureSource(tab);
  } catch (err) {
    const { message, silent } = ipc.describeError(err);
    if (!silent) toast(message, "err");
    // A file that cannot be read does not blank the window and does not lose the tab.
    tab.missing = true;
    tab.doc = {
      html: "",
      diagrams: [],
      headings: [],
      frontmatter: [],
      words: 0,
      lineCount: 0,
      encoding: tab.encoding,
      truncated: false,
    };
  }
  // The tab is on screen again, so the out-of-date mark goes: this is its single owner, which is why a
  // deferred background reload clears it here rather than in the watcher's handler.
  tab.reloading = false;
  renderChrome();
  await paintActive();
  scheduleSave();
}

function reloadActive(): void {
  const tab = activeTab();
  if (!tab) return;
  tab.source = null;
  void loadTab(tab);
}

// ---------------------------------------------------------------- editing (SPEC §12)

/** Why a file cannot be edited, if it cannot. The reader only *badges* these states, and a badge is
 *  safe only while nothing can write — which is exactly what the mode changes. */
function blockedReason(payload: ipc.FilePayload): Tab["blocked"] {
  if (payload.truncated) return "truncated";
  if (payload.encoding === "utf-8-lossy") return "lossy";
  if (payload.eol === "mixed") return "mixed";
  if (!payload.writable) return "readonly";
  return null;
}

const BLOCKED_KEY: Record<NonNullable<Tab["blocked"]>, Parameters<typeof i18n.t>[0]> = {
  truncated: "view.blocked.truncated",
  lossy: "view.blocked.lossy",
  mixed: "view.blocked.mixed",
  missing: "view.blocked.missing",
  readonly: "view.blocked.readonly",
};

/** The two pills and the status bar's save mark. Their only writer, so a language change and a state
 *  change cannot disagree about what they say — the rule the About sheet's update row follows. */
function paintEditorChrome(tab: Tab | null): void {
  const blocked = tab?.blocked ?? null;
  for (const pill of $$(".readonly-pill")) {
    pill.textContent = tab?.editing ? i18n.t("view.editing") : i18n.t("view.readonly");
    pill.classList.toggle("editing", Boolean(tab?.editing));
    pill.setAttribute("aria-disabled", blocked ? "true" : "false");
    pill.title = blocked
      ? i18n.t(BLOCKED_KEY[blocked])
      : tab?.editing
        ? i18n.t("view.doneTitle")
        : editor.editorState() === "failed"
          ? i18n.t("edit.failed")
          : i18n.t("view.editTitle");
  }
  const chip = $("#stDirty") as HTMLButtonElement;
  chip.hidden = !tab?.dirty;
  chip.textContent = i18n.t("edit.unsaved");
  chip.title = i18n.t("edit.saveTitle");
}

/**
 * Puts the mode, the text and the read-only state into whichever pane shows source.
 *
 * The read-only `<pre>` is *emptied*, not merely hidden, while the editor owns the pane: find walks
 * DOM text nodes and does not skip `display: none`, so leaving the same text in both layers would
 * double every hit and scroll the invisible copy.
 */
async function syncEditor(tab: Tab, retried = false): Promise<void> {
  const panes: Array<{ key: editor.PaneKey; host: string; pre: string; container: string }> = [
    { key: "source", host: "#editor-source", pre: "#out-source", container: "#view-source .source-view" },
    { key: "split", host: "#editor-split", pre: "#out-split-src", container: "#view-split .pane-src" },
  ];
  for (const pane of panes) {
    const on = tab.editing && tab.source !== null;
    $(pane.container).classList.toggle("editing", on);
    $(pane.host).hidden = !on;
    $(pane.pre).hidden = on;
    if (on) $(pane.pre).innerHTML = "";
    if (!on) continue;
    if (!(await editor.mount(pane.key, $(pane.host)))) {
      // The chunk would not load. The pane stays read-only and says why, instead of showing an empty box.
      tab.editing = false;
      toast(i18n.t("edit.failed"), "err");
      if (!retried) await syncEditor(tab, true);
      return;
    }
    editor.show(pane.key, tab.id, tab.buffer ?? tab.source ?? "", tab.blocked !== null);
  }
}

function toggleEdit(): void {
  const tab = activeTab();
  if (!tab) return;
  if (tab.editing) leaveEdit();
  else void enterEdit();
}

async function enterEdit(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  /* The flags that decide whether a file may be edited come from *reading* it, and a tab that was
     opened as a preview has never been read — so the read has to happen before the check. Getting this
     order wrong let a mixed-ending file open in the mode: the refusal was evaluated against `null`
     and only became visible afterwards. */
  if (tab.source === null) await ensureSource(tab);
  if (tab.blocked || tab.missing) {
    toast(i18n.t(BLOCKED_KEY[tab.blocked ?? "missing"]), "err");
    renderChrome();
    return;
  }
  if (tab.preview) {
    // A preview tab is reused *in place* by the next single click in the tree, so a buffer with edits
    // in it would be replaced without a word. Entering the mode pins it first (SPEC §12).
    tab.preview = false;
    toast(i18n.t("edit.pinned"), "ok");
  }
  // Preview view has no source pane, so the mode would be invisible there. The useful shape is the
  // one where the render sits beside the buffer, which is the split.
  if (tab.view === "preview") await setView("split");
  tab.editing = true;
  // The pills, the tab strip (a promoted preview tab stops being italic) and the status bar all change
  // with the mode, and `paintActive` paints the panes, not the chrome — so the chrome is repainted
  // here. Without this the pill kept saying "read-only" while the pane was editable.
  renderChrome();
  await paintActive();
  editor.focus(tab.view === "split" ? "split" : "source");
  scheduleSave();
}

function leaveEdit(force = false): void {
  const tab = activeTab();
  if (!tab) return;
  if (tab.dirty && !force) {
    askUnsaved(i18n.t("unsaved.leave"), () => leaveEdit(true));
    return;
  }
  tab.editing = false;
  renderChrome();
  void paintActive();
  scheduleSave();
}

/** Writes one tab's buffer back, then re-reads through the normal path. Returns whether anything was
 *  written. Re-reading is not ceremony: afterwards the file on disk is the truth, and going back through
 *  `read_file` + `render_doc` is what proves the round-trip — the preview that comes back is built from
 *  the bytes that were just written, not from the buffer that wrote them. */
async function saveTab(tab: Tab): Promise<boolean> {
  if (!tab.editing || !tab.dirty) return false;
  try {
    tab.loadedMtimeMs = await ipc.saveDoc(
      tab.file,
      tab.buffer ?? tab.source ?? "",
      tab.encoding,
      tab.eol,
      tab.loadedMtimeMs,
    );
    tab.dirty = false;
    tab.buffer = null;
    tab.source = null;
    /* Re-reading is not ceremony: afterwards the file on disk is the truth, and going back through
       `read_file` + `render_doc` is what proves the round-trip — the preview that comes back is built
       from the bytes that were just written, not from the buffer that wrote them. An off-screen tab
       defers that to its next activation, the way the watcher does. */
    if (tab === activeTab()) await loadTab(tab);
    else tab.doc = null;
    return true;
  } catch (err) {
    // A refusal is the point of the guard, not a crash: the buffer keeps its state and the toast says why.
    const { message, silent } = ipc.describeError(err);
    if (!silent) toast(message, "err");
    return false;
  }
}

async function saveActiveTab(): Promise<void> {
  const tab = activeTab();
  if (tab && (await saveTab(tab))) toast(i18n.t("edit.saved"), "ok");
}

/** Every dirty buffer — for the one moment where "the active tab" is the wrong question: quitting. */
async function saveAllDirty(): Promise<void> {
  let saved = 0;
  for (const tab of state.tabs.filter((candidate) => candidate.dirty)) {
    if (await saveTab(tab)) saved++;
  }
  if (saved) toast(i18n.t("edit.saved"), "ok");
}

let previewTimer = 0;

/**
 * The live render beside the buffer (SPEC §12).
 *
 * Debounced, and narrow: it re-parses through the same Rust renderer as everything else — a buffer has
 * no file, which is what `render_text` exists for — and repaints only the rendered panes, never the
 * scroll.
 */
function schedulePreview(tab: Tab): void {
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    void (async () => {
      if (!tab.editing || tab.buffer === null) return;
      try {
        const rendered = await ipc.renderText(tab.buffer, tab.file, state.math);
        rendered.encoding = tab.encoding;
        rendered.truncated = false;
        tab.doc = rendered;
        tab.words = rendered.words;
        await doc.paintRendered(tab);
        outline.renderOutline(rendered);
        status.setStatus(tab);
      } catch {
        // A failed live render leaves the last one on screen; the next keystroke tries again.
      }
    })();
  }, 160);
}

let pendingAction: (() => void) | null = null;
/** What the sheet's `save` button runs. Not always "the active tab": quitting has to write every
 *  dirty buffer, and the sheet is the same sheet either way. */
let pendingSave: (() => Promise<void>) | null = null;
/** Set once the quit has been confirmed, so the window can actually close. `close()` fires the close
 *  request again, and without this the app would ask the same question forever. */
let closing = false;

/** Leaving a dirty buffer — closing its tab, or quitting — asks first (SPEC §12). The sheet reuses the
 *  existing overlay shell, so the mode adds no new surface type. */
function askUnsaved(what: string, action: () => void, save: () => Promise<void> = saveActiveTab): void {
  pendingAction = action;
  pendingSave = save;
  $("#unsavedText").textContent = i18n.t("unsaved.body", { what });
  $("#unsavedOverlay").classList.add("on");
}

function closeUnsaved(): void {
  pendingAction = null;
  pendingSave = null;
  $("#unsavedOverlay").classList.remove("on");
}

// ---------------------------------------------------------------- tabs

/**
 * Opening an already-open file activates its tab; a single tree click reuses the one preview
 * tab; a double click pins it (IMPL.md §5 invariants). Getting this wrong is how you end up
 * with eleven copies of README.md.
 */
async function openFile(path: string, preview: boolean): Promise<void> {
  const existing = tabByFile(path);
  if (existing) {
    // Reaching an open file by double click pins it; reaching it by single click leaves the
    // preview flag alone rather than un-pinning something the user pinned on purpose.
    if (!preview) existing.preview = false;
    // This path activates a tab without going through `activate()`, so the outgoing tab has to be
    // captured here too — otherwise clicking a file that is already open loses the scroll position of
    // the tab it leaves, which is the one thing a multi-tab reader must not do (SPEC §5).
    const leaving = activeTab();
    if (leaving && leaving !== existing) doc.captureScroll(leaving);
    state.activeTab = state.tabs.indexOf(existing);
    renderChrome();
    await paintActive();
    return;
  }

  let tab: Tab;
  const reusable = preview ? previewTab() : null;

  if (reusable) {
    // Reuse in place: the preview tab keeps its position in the strip, which is what makes
    // single-click browsing feel stable instead of shuffling.
    doc.captureScroll(reusable);
    reusable.file = path;
    reusable.name = basename(path);
    reusable.doc = null;
    reusable.source = null;
    reusable.scroll = 0;
    reusable.find = { q: "", case: false, hit: 0 };
    reusable.missing = false;
    tab = reusable;
    state.activeTab = state.tabs.indexOf(reusable);
  } else {
    tab = makeTab(path, basename(path), preview);
    state.tabs.push(tab);
    state.activeTab = state.tabs.length - 1;
  }

  renderChrome();
  await loadTab(tab);
}

async function activate(index: number): Promise<void> {
  if (index === state.activeTab) return;
  const leaving = activeTab();
  if (leaving) doc.captureScroll(leaving);

  state.activeTab = index;
  const tab = activeTab();
  if (!tab) return;

  if (tab.doc === null && !tab.missing) {
    await loadTab(tab);
    return;
  }
  if (tab.view !== "preview") await ensureSource(tab);

  renderChrome();
  await paintActive();
  find.syncInput(tab);
  tabs.scrollActiveTabIntoView();
  scheduleSave();
}

function closeTab(index: number, force = false): void {
  if (index < 0 || index >= state.tabs.length) return;
  const target = state.tabs[index];
  // Closing a dirty tab asks first (SPEC §12): the buffer is not in the file yet.
  if (!force && target?.dirty) {
    askUnsaved(i18n.t("unsaved.close", { name: target.name }), () => closeTab(index, true));
    return;
  }
  if (target) editor.forgetTab(target.id);
  state.tabs.splice(index, 1);
  // Closing a tab to the *left* of the active one shifts it left with the rest; without this the
  // reader would be moved to a different document. The tab strip's own × only ever closes the
  // active tab, so this path is reachable only from the right-click menu.
  if (index < state.activeTab) state.activeTab--;
  state.activeTab = Math.max(0, Math.min(state.activeTab, state.tabs.length - 1));

  renderChrome();
  if (state.tabs.length > 0) void paintActive();
  scheduleSave();
}

/** Closes a set of tabs, asking *once* for any dirty buffers among them rather than once per tab
 *  (the single-tab path in `closeTab` already asks for itself). Descending order, so each splice
 *  leaves the lower indices pointing at the same tabs. */
function closeTabs(indices: number[]): void {
  const valid = [...new Set(indices)]
    .filter((index) => index >= 0 && index < state.tabs.length)
    .sort((a, b) => a - b);
  if (valid.length === 0) return;

  const run = (): void => {
    for (let i = valid.length - 1; i >= 0; i--) closeTab(valid[i], true);
  };
  const dirty = valid.filter((index) => state.tabs[index]?.dirty).length;
  if (dirty > 0) askUnsaved(i18n.t("unsaved.closeMany", { n: dirty }), run);
  else run();
}

/** SPEC §5's tab right-click menu. It belongs to the tab under the pointer — never the active one
 *  by assumption — and it does not activate that tab: closing, copying and revealing are things you
 *  do *to* a tab, not to the document in front of you. */
function showTabMenu(index: number, x: number, y: number): void {
  const tab = state.tabs[index];
  if (!tab) return;
  const last = state.tabs.length - 1;
  showMenu(
    [
      { label: i18n.t("tab.menu.close"), run: () => closeTab(index) },
      {
        label: i18n.t("tab.menu.closeOthers"),
        disabled: state.tabs.length <= 1,
        run: () => closeTabs(state.tabs.map((_, i) => i).filter((i) => i !== index)),
      },
      {
        label: i18n.t("tab.menu.closeRight"),
        disabled: index === last,
        run: () => closeTabs(state.tabs.map((_, i) => i).filter((i) => i > index)),
      },
      {
        label: i18n.t("tab.menu.closeAll"),
        run: () => closeTabs(state.tabs.map((_, i) => i)),
      },
      "sep",
      {
        label: i18n.t("tab.menu.copyPath"),
        run: () => {
          copyText(tab.file);
          toast(i18n.t("toast.pathCopied"), "ok");
        },
      },
      {
        label: i18n.t("tab.menu.reveal"),
        run: () => {
          void ipc.revealInExplorer(tab.file).catch(() => toast(i18n.t("toast.revealFailed"), "err"));
        },
      },
    ],
    x,
    y,
  );
}

async function setView(mode: doc.ViewMode): Promise<void> {
  const tab = activeTab();
  if (!tab) {
    doc.setView(mode);
    return;
  }

  // Read where the reader is *before* the view class changes. Measured after, the outgoing pane is
  // hidden and every rect it would report is zero, which is how switching views used to drop the
  // position and open the new one at the top (SPEC §5).
  const from = doc.capturePosition();
  doc.captureScroll(tab);
  tab.view = mode;
  doc.setView(mode);
  if (mode !== "preview") await ensureSource(tab);
  await paintActive();
  // `renderDocument` restored the tab's pixel, which belongs to the mode we just left. Put the reader
  // where they were instead, through the anchors both panes render, and store the pixel that the new
  // mode actually landed on so a tab switch or a session save is right from here on.
  doc.applyPosition(from);
  doc.captureScroll(tab);
  scheduleSave();
}

// ---------------------------------------------------------------- folder

/** Everything that has to happen when a folder becomes the one on screen. */
async function adoptFolder(view: ipc.FolderView): Promise<void> {
  state.root = view.root;
  tree.setTree(view);
  const watcher = await ipc.watchSet([view.root]);
  state.watching = watcher.watching;
  status.setWatchLabel(watcher.watching);
  state.recent = await ipc.noteRecent(view.root);
  renderRecent();
}

async function applyFolder(root: string): Promise<void> {
  try {
    await adoptFolder(await ipc.openFolder(root));
  } catch (err) {
    toast(ipc.describeError(err).message, "err");
  }
}

/**
 * Opens whatever the CLI or a shell integration handed us: a folder opens itself, a file opens
 * its folder *and* itself.
 *
 * The parent-directory arithmetic deliberately happens in Rust. Doing it here means hand-rolling
 * separator handling, and `C:\file.md` minus its last path segment is `C:` — not `C:\`.
 */
async function openPath(path: string): Promise<void> {
  if (!ipc.isMarkdownPath(path)) {
    await applyFolder(path);
    return;
  }
  try {
    await adoptFolder(await ipc.resolveTarget(path));
  } catch (err) {
    toast(ipc.describeError(err).message, "err");
  }
  await openFile(path, false);
}

async function pickFolder(): Promise<void> {
  const chosen = await ipc.pickDirectory("Open folder");
  if (chosen) await applyFolder(chosen);
}

async function pickFile(): Promise<void> {
  const chosen = await ipc.pickFile("Open markdown", ipc.MD_EXTENSIONS);
  if (chosen) await openFile(chosen, false);
}

function renderRecent(): void {
  const el = $("#emptyRecent");
  el.innerHTML = state.recent.length
    ? i18n.t("empty.recentHead") +
      " — " +
      state.recent
        .slice(0, 3)
        .map((entry) => `<a data-recent="${encodeURIComponent(entry)}">${escapeHtml(entry)}</a>`)
        .join(" · ")
    : "";

  el.querySelectorAll<HTMLElement>("[data-recent]").forEach((link) => {
    link.addEventListener("click", () => {
      const path = decodeURIComponent(link.dataset.recent ?? "");
      if (!path) return;
      void (ipc.isMarkdownPath(path) ? openFile(path, false) : applyFolder(path));
    });
  });
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** ctrl shift P: the recent list as a menu, most recent first. */
function showRecentMenu(): void {
  if (state.recent.length === 0) {
    toast(i18n.t("toast.noRecent"), "warn");
    return;
  }
  showMenu(
    [
      i18n.t("menu.recent"),
      ...state.recent.slice(0, 8).map((entry) => ({
        label: entry,
        run: () => void openPath(entry),
      })),
    ],
    window.innerWidth / 2 - 140,
    96,
  );
}

/** Opens a menu attached to the control that opened it: placed on the opposite side of the window
 *  from that control, and toggling when the same control is pressed again. Every menu opened by a
 *  control goes through here, so placement and dismissal cannot drift between them. */
function openMenuAt(anchor: HTMLElement, items: Array<MenuItem | "sep" | string>): void {
  const rect = anchor.getBoundingClientRect();
  const below = rect.top < window.innerHeight / 2;
  showMenu(items, rect.left, below ? rect.bottom + 4 : rect.top - 210, anchor);
}

/** ctrl shift A and the `⋯` button: every tab as a menu, the current one marked. */
function showTabsMenu(): void {
  if (state.tabs.length === 0) {
    toast(i18n.t("toast.noTabs"), "warn");
    return;
  }
  openMenuAt($("#listTabsBtn"), [
    i18n.t("tabs.all", { n: state.tabs.length }),
    ...state.tabs.map((tab, index) => ({
      label: `${index === state.activeTab ? "● " : ""}${tab.name}`,
      disabled: index === state.activeTab,
      run: () => void activate(index),
    })),
  ]);
}

/** The status-bar chip, the toolbar button and the immersive bar's chip all land here: the same
 *  three presets, next to the text they change. */
function showMeasureMenu(anchor: HTMLElement = $("#stMeasure")): void {
  openMenuAt(anchor, [
    i18n.t("settings.measure"),
    ...measure.MEASURE_ORDER.map((id) => ({
      label: `${id === state.measure ? "● " : ""}${measure.measureName(id)}`,
      disabled: id === state.measure,
      run: () => setMeasure(id),
    })),
  ]);
}

// ---------------------------------------------------------------- session

/** The window's own default size and floor, as `lib.rs` builds it (SPEC §2). A saved geometry that
 *  is smaller than the floor is not a place this window can be. */
const WINDOW_DEFAULT = { w: 1200, h: 800 };
const WINDOW_MIN = { w: 720, h: 480 };

/** The window rect is part of the session (IMPL §6), so it is read at save time rather than
 *  assumed. Physical units, because that is what `innerSize`/`outerPosition` report and what
 *  `setSize`/`setPosition` take back — round-tripping through logical would drift on fractional
 *  display scales.
 *
 *  **Inner** size, not outer: `setSize` sets the inner box, so storing the outer one grew the window
 *  by its frame on every launch — measured 1000×700 → 1016×709 → 1032×718, one frame per restart,
 *  which is the classic bug this pairing exists to avoid. The position stays the outer one, which is
 *  what `setPosition` sets and what a reader recognises as "where the window is". */
async function currentWindowRect(): Promise<WindowRect> {
  const win = getCurrentWindow();
  // A minimised window answers with its *iconic* rect — 272×91 at (-32000, -32000) on Windows — so
  // saving it stores a window that is off screen at icon size, and the next launch puts it there:
  // the window exists, 32000px to the left of everything, and no gesture brings it back (this is
  // what a reader reported as "it starts minimised and cannot be restored"). The last good rect is
  // kept instead.
  if (await win.isMinimized()) return state.windowRect;

  const [size, position, maximized] = await Promise.all([
    win.innerSize(),
    win.outerPosition(),
    win.isMaximized(),
  ]);
  const rect: WindowRect = {
    w: size.width,
    h: size.height,
    x: position.x,
    y: position.y,
    maximized,
  };
  // Remember it as the last good one: the branch above hands this back whenever the window is
  // minimised, so a session saved then keeps the geometry the reader last had rather than the one the
  // window booted with (a move or a resize since boot would otherwise be forgotten).
  state.windowRect = rect;
  return rect;
}

/** Whether a saved rect still describes somewhere a window can be: no smaller than the window's own
 *  minimum, and overlapping a monitor that exists **now** — a laptop undocked since the session was
 *  written has no screen where the second one used to be, and honouring that rect puts the window
 *  out of reach just as surely as the icon rect does. */
async function rectIsUsable(rect: WindowRect): Promise<boolean> {
  if (rect.w < WINDOW_MIN.w || rect.h < WINDOW_MIN.h) return false;
  if (rect.x === null || rect.y === null) return true; // "let the OS place it" — a first run
  try {
    const monitors = await availableMonitors();
    return monitors.some((monitor) => {
      const left = monitor.position.x;
      const top = monitor.position.y;
      const right = left + monitor.size.width;
      const bottom = top + monitor.size.height;
      return rect.x! < right && rect.x! + rect.w > left && rect.y! < bottom && rect.y! + rect.h > top;
    });
  } catch {
    // Unanswerable is not a reason to trust it: the default is centred and on screen either way.
    return false;
  }
}

async function restoreWindowRect(rect: WindowRect): Promise<void> {
  const win = getCurrentWindow();

  // An unusable rect means the window keeps what `lib.rs` built for it: the default size, centred
  // (SPEC §2). Nothing is applied and nothing is wrong — the next save writes what the window
  // actually has.
  if (!(await rectIsUsable(rect))) {
    state.windowRect = { ...WINDOW_DEFAULT, x: null, y: null, maximized: false };
    return;
  }

  if (rect.maximized) {
    await win.maximize();
    return;
  }
  await win.setSize(new PhysicalSize(Math.round(rect.w), Math.round(rect.h)));
  // A null position means "let the OS place it", which is what a first run should get.
  if (rect.x !== null && rect.y !== null) {
    await win.setPosition(new PhysicalPosition(Math.round(rect.x), Math.round(rect.y)));
  }
}

let saveTimer: number | undefined;

/** The explorer's markdown-only toggle (SPEC §3). One writer: state -> button -> tree, so a restored
 *  session and a click cannot disagree about what the tree is showing. */
function applyMdOnly(): void {
  const button = $<HTMLButtonElement>("#mdOnlyBtn");
  button.classList.toggle("on", state.mdOnly);
  button.setAttribute("aria-pressed", String(state.mdOnly));
  tree.setMarkdownOnly(state.mdOnly);
}

/** 500 ms debounce, per IMPL.md §6. Saving on every scroll frame would be absurd. */
function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    // Capture before serialising: scroll position lives in the DOM until something switches
    // away from the tab, and a save that reads the stale `tab.scroll` would restore every tab
    // to the top. The scroll is part of the session, not just of the interaction.
    const tab = activeTab();
    if (tab) doc.captureScroll(tab);
    void currentWindowRect()
      .then((rect) => ipc.sessionSave(toSession(rect)))
      .catch((err: unknown) => {
        // A failed save is not worth interrupting reading for; the next change retries it. It is
        // worth a line, though — a session that never persists otherwise leaves no evidence.
        diag.log("error", "session", "session save failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
  }, 500);
}

async function restoreSession(): Promise<void> {
  const session = await ipc.sessionLoad();
  if (!session) return;

  applySession(session);
  state.recent = session.recent.slice();
  state.windowRect = { ...session.window };
  // The setting is on, so the next document with a formula will want KaTeX: pay for the parse now,
  // between the reader's actions, rather than in front of the first formula (SPEC §4).
  if (state.math) preloadMath();
  renderRecent();
  applyTheme();
  applyLayout();
  applyMdOnly();
  await restoreWindowRect(session.window);

  // The folder comes back from `recent`. Tabs come back by path, and a path that no longer
  // exists stays a tab (marked missing when the load fails) rather than disappearing.
  const recent = session.recent[0];
  if (recent) await openPath(recent);

  const tab = activeTab();
  if (tab) await loadTab(tab);
  renderChrome();
}

// ---------------------------------------------------------------- keyboard

const isMac = navigator.platform.toLowerCase().includes("mac");

function wireKeyboard(): void {
  document.addEventListener("keydown", (event) => {
    // Overlays close in the reverse order they would have been opened: a menu over a viewer over
    // a panel over the find bar. `esc` never closes two things at once.
    if (event.key === "Escape") {
      if (menuIsOpen()) return hideMenu();
      if (viewer.isOpen()) return viewer.close();
      if (settings.isOpen()) return settings.close();
      if (help.isOpen()) return help.close();
      if (about.isOpen()) return about.close();
      if (find.isOpen()) {
        const tab = activeTab();
        if (tab) find.close(tab);
        return;
      }
      // Edit mode sits inside the chain rather than beside it, because leaving a dirty buffer asks
      // first — the same reason the chain exists (SPEC §7).
      if (activeTab()?.editing) return leaveEdit();
      if (immersive.isActive()) return immersive.set(false);
      return;
    }

    if (event.key === "F1") {
      event.preventDefault();
      help.isOpen() ? help.close() : help.open();
      return;
    }
    if (event.key === "F11") {
      event.preventDefault();
      immersive.toggle();
      return;
    }

    // Find navigation lives outside the ctrl guard: enter / shift enter are plain keys, and they
    // only mean anything while the bar is open.
    if (find.isOpen() && event.key === "Enter") {
      event.preventDefault();
      const tab = activeTab();
      if (!tab) return;
      event.shiftKey ? find.prev(tab) : find.next(tab);
      return;
    }

    const primary = isMac ? event.metaKey : event.ctrlKey;
    if (!primary) return;

    const key = event.key.toLowerCase();

    // ctrl shift O opens a folder; ctrl alt O toggles the outline. This split is the resolved
    // conflict from SPEC §7 — do not re-merge them onto one binding.
    if (event.shiftKey && key === "o") {
      event.preventDefault();
      void pickFolder();
      return;
    }
    if (event.shiftKey && key === "p") {
      event.preventDefault();
      showRecentMenu();
      return;
    }
    if (event.shiftKey && key === "a") {
      event.preventDefault();
      showTabsMenu();
      return;
    }
    // ctrl shift M cycles the reading width — the same field the chip and the settings row write.
    if (event.shiftKey && key === "m") {
      event.preventDefault();
      setMeasure(measure.nextMeasure(state.measure));
      return;
    }
    if (event.altKey && key === "o") {
      event.preventDefault();
      state.outlineOpen = !state.outlineOpen;
      applyLayout();
      scheduleSave();
      return;
    }

    // ctrl tab / ctrl 1..9 are handled before the shift guard: they are valid with shift held
    // (reverse tab order), while the rest of the letters are not.
    if (key === "tab" && !event.altKey) {
      event.preventDefault();
      if (state.tabs.length === 0) return;
      const step = event.shiftKey ? -1 : 1;
      void activate((state.activeTab + step + state.tabs.length) % state.tabs.length);
      return;
    }
    if (!event.shiftKey && key >= "1" && key <= "9" && key.length === 1) {
      const index = Number(key) - 1;
      if (index < state.tabs.length) {
        event.preventDefault();
        void activate(index);
      }
      return;
    }

    if (event.shiftKey || event.altKey) return;

    switch (key) {
      case "b":
        event.preventDefault();
        state.sidebar.open = !state.sidebar.open;
        applyLayout();
        scheduleSave();
        break;
      case "f": {
        event.preventDefault();
        const tab = activeTab();
        if (tab) find.open(tab);
        break;
      }
      case "e":
        event.preventDefault();
        toggleEdit();
        break;
      case "s":
        event.preventDefault();
        void saveActiveTab();
        break;
      case ",":
        event.preventDefault();
        settings.isOpen() ? settings.close() : settings.open();
        break;
      case "o":
        event.preventDefault();
        void pickFile();
        break;
      case "r":
        event.preventDefault();
        reloadActive();
        break;
      case "w":
        event.preventDefault();
        closeTab(state.activeTab);
        break;
      case "0":
        event.preventDefault();
        setZoom(100);
        break;
      case "=":
      case "+":
        event.preventDefault();
        setZoom(state.zoom + 10);
        break;
      case "-":
        event.preventDefault();
        setZoom(state.zoom - 10);
        break;
      default:
        break;
    }
  });
}

// ---------------------------------------------------------------- boot

async function boot(): Promise<void> {
  // The shell's own copy first: `state.lang` is `system` until a session says otherwise, so this
  // paints in the OS language and `applyLang()` corrects it right after the session is restored.
  i18n.setLang(state.lang);
  i18n.applyStatic();
  applyTheme();
  applyLayout();
  doc.setView("preview");

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "system") applyTheme();
  });

  tabs.setTabHandlers((index) => void activate(index), closeTab);

  /* The tab strip is rebuilt on every render, so its right-click menu is delegated: one listener on
     the stable strip covers every tab that ever exists in it. The menu belongs to the tab under the
     pointer, which is not necessarily the active one — and opening it activates nothing. */
  $("#tabstrip").addEventListener("contextmenu", (event) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>(".tab");
    if (!el) return;
    event.preventDefault();
    showTabMenu(Number(el.dataset.i), event.clientX, event.clientY);
  });

  // The editable pane (SPEC §12). Both pills are the pointer path into the mode and the status bar's
  // mark is the pointer path out of a dirty buffer; neither takes focus on click, or the caret would
  // leave the very pane they report on.
  for (const pill of $$(".readonly-pill")) {
    pill.addEventListener("mousedown", (event) => event.preventDefault());
    pill.addEventListener("click", () => {
      const tab = activeTab();
      if (tab?.blocked) {
        toast(i18n.t(BLOCKED_KEY[tab.blocked]), "err");
        return;
      }
      toggleEdit();
    });
  }
  for (const key of ["source", "split"] as editor.PaneKey[]) {
    editor.onChange(key, () => {
      const tab = activeTab();
      if (!tab?.editing) return;
      tab.buffer = editor.doc(key, tab.id);
      find.invalidate();
      /* Dirty means "this differs from the file", not "a key was pressed": undoing back to the original
         text has to clear it, or the mark would outlive the difference it reports. `tab.source` is the
         file as read (CRLF and all), so the comparison normalises it the way the editor's document is. */
      const sameAsFile = tab.buffer === (tab.source ?? "").replace(/\r\n/g, "\n");
      if (tab.dirty === sameAsFile) {
        tab.dirty = !sameAsFile;
        tabs.renderTabs();
        paintEditorChrome(tab);
      }
      schedulePreview(tab);
    });
  }
  const dirtyChip = $("#stDirty") as HTMLButtonElement;
  dirtyChip.addEventListener("mousedown", (event) => event.preventDefault());
  dirtyChip.addEventListener("click", () => void saveActiveTab());
  $("#unsavedSave").addEventListener("click", () => {
    const save = pendingSave;
    closeUnsaved();
    if (save) void save();
  });
  $("#unsavedDiscard").addEventListener("click", () => {
    const action = pendingAction;
    const tab = activeTab();
    if (tab) {
      /* Discard means "the file's text wins" — for the tab *and* for the editor, which keeps its own
         copy of the buffer. Clearing the tab's fields alone left the pane showing the discarded text,
         and the next sync read it straight back and re-marked the tab dirty. */
      tab.buffer = null;
      tab.dirty = false;
      for (const key of ["source", "split"] as editor.PaneKey[]) editor.reset(key, tab.id, tab.source ?? "");
    }
    closeUnsaved();
    // The tab strip and the status chip both carry the dirty mark, so the chrome is repainted too —
    // the editor reset above already put the file's text back in the pane.
    if (tab) renderChrome();
    if (tab) void paintActive();
    action?.();
  });
  $("#unsavedCancel").addEventListener("click", closeUnsaved);
  $("#unsavedClose").addEventListener("click", closeUnsaved);
  $("#unsavedOverlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeUnsaved();
  });
  tree.setPickHandler((path, preview) => void openFile(path, preview));
  outline.setJumpHandler((target) => {
    // Headings (`hN`) and diagrams (`dN`) both carry their line in the render result, so the jump
    // is computed once and applied to whichever panes the view shows (SPEC §3).
    doc.jumpTo(target);
  });
  doc.wireSplitter();
  panels.wirePanelResizers(scheduleSave);
  doc.wireScrollSpy((headingId) => {
    outline.setOutlineActive(headingId);
    // Scrolling is part of the session too. The spy is already rAF-throttled and the save is
    // debounced, so this costs nothing while the wheel spins and lands one write per pause.
    scheduleSave();
  });
  tree.wireFilter();
  wireKeyboard();

  find.wire(
    (tab) => {
      // The input handler: re-run the search as the query changes.
      find.refresh(tab);
      scheduleSave();
    },
    activeTab,
  );
  viewer.wire();
  settings.wire({
    onThemeChange: () => {
      applyTheme();
      void paintActive();
    },
    onFontSizeChange: applyLayout,
    onMeasureChange: applyLayout,
    onMotionChange: applyLayout,
    onMathChange: () => {
      // The reader just asked for math: start the parse now so the re-render below is not the first
      // thing that waits for KaTeX.
      if (state.math) preloadMath();
      // Math is a render *input*, so every open document's HTML is now stale: drop them all and
      // re-render the one on screen. The others re-render when they are activated, which is what
      // `activate` already does for a tab whose `doc` is null.
      const tab = activeTab();
      for (const open of state.tabs) open.doc = null;
      if (!tab) return;
      // A buffer is not in the file yet, so the file is the wrong thing to re-render (SPEC §12).
      if (tab.editing && tab.buffer !== null) {
        schedulePreview(tab);
        return;
      }
      if (!tab.missing) void loadTab(tab);
      else void paintActive();
    },
    onLangChange: applyLang,
    onLogDirChange: about.refreshLogPath,
    onSave: scheduleSave,
  });
  help.wire();
  about.wire();
  immersive.wire({
    onZoomReset: () => setZoom(100),
    onMeasureMenu: (anchor) => showMeasureMenu(anchor),
  });

  // Diagram card and code-block buttons are delegated: both are recreated on every render, so
  // per-element listeners would leak. One listener on each prose container covers everything that
  // ever exists in it.
  for (const container of ["#out-preview", "#out-split"]) {
    document.querySelector<HTMLElement>(container)?.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (!button) return;

      const card = button.closest<HTMLElement>("figure.diagram");
      if (card) {
        const id = card.dataset.diagram ?? "";
        if (button.dataset.act === "zoom") viewer.openById(id);
        if (button.dataset.act === "copy") {
          copyText(card.dataset.source ?? "");
          toast(i18n.t("toast.sourceCopied"), "ok");
        }
        return;
      }

      // A code block's text is the code itself, before or after Prism rewrote the markup: the text
      // is what `textContent` reports either way.
      const code = button.closest<HTMLElement>("figure.code");
      if (code && button.dataset.act === "copy-code") {
        copyText(code.querySelector("code")?.textContent ?? "");
        toast(i18n.t("toast.codeCopied"), "ok");
      }
    });
  }

  // Images are created per render, so their two states are delegated as well. `load` and `error` do
  // not bubble, which is why both listeners capture: on the container, they see every image inside it
  // whatever the document's markup looks like.
  for (const container of ["#out-preview", "#out-split"]) {
    const root = document.querySelector<HTMLElement>(container);
    root?.addEventListener(
      "load",
      (event) => {
        const img = event.target;
        if (img instanceof HTMLImageElement) delete img.dataset.loading;
      },
      true,
    );
    root?.addEventListener(
      "error",
      (event) => {
        const img = event.target;
        if (!(img instanceof HTMLImageElement)) return;
        // The `alt` stays: it is the author's description, and it is what the reader gets instead of
        // the picture. The `title` says why the box is empty.
        delete img.dataset.loading;
        img.classList.add("failed");
        img.title = i18n.t("img.failed");
      },
      true,
    );
  }

  // The titlebar is ours, so its buttons are wired by hand.
  const win = getCurrentWindow();
  $("#winMin").addEventListener("click", () => void win.minimize());
  $("#winMax").addEventListener("click", () => void win.toggleMaximize());
  $("#winClose").addEventListener("click", () => void win.close());

  /* Quitting with unsaved work asks first (SPEC §12) — the same sheet, because a buffer that is not in
     the file is the same problem wherever it is about to be lost. The titlebar's ×, the taskbar and
     Alt+F4 all end up here. */
  await win.onCloseRequested((event) => {
    if (closing) return;
    const dirty = state.tabs.filter((tab) => tab.dirty);
    if (dirty.length === 0) return;
    event.preventDefault();
    askUnsaved(
      i18n.t("unsaved.quit", { n: dirty.length }),
      () => {
        /* `destroy`, not `close`: the request has already been prevented once, and asking again is what
           `close()` does — it re-emits the event, which is exactly the loop this flag exists to break.
           The reader has answered the question, so the window goes. */
        closing = true;
        void win.destroy();
      },
      saveAllDirty,
    );
  });

  // The titlebar's `⋯` is a real control, not decoration: it lists every tab (SPEC §5).
  $("#listTabsBtn").addEventListener("click", (event) => {
    event.stopPropagation();
    showTabsMenu();
  });

  $("#openFolderBtn").addEventListener("click", () => void pickFolder());
  $("#mdOnlyBtn").addEventListener("click", () => {
    state.mdOnly = !state.mdOnly;
    applyMdOnly();
    scheduleSave();
  });
  $("#emptyOpenFolder").addEventListener("click", () => void pickFolder());
  $("#emptyOpenFile").addEventListener("click", () => void pickFile());
  $("#toggleSidebar").addEventListener("click", () => {
    state.sidebar.open = !state.sidebar.open;
    applyLayout();
    scheduleSave();
  });
  $("#toggleOutline").addEventListener("click", () => {
    state.outlineOpen = !state.outlineOpen;
    applyLayout();
    scheduleSave();
  });
  $("#toggleTheme").addEventListener("click", () => {
    state.theme = resolvedTheme() === "dark" ? "light" : "dark";
    applyTheme();
    void paintActive();
    scheduleSave();
  });
  $("#rerender").addEventListener("click", reloadActive);
  $("#stZoom").addEventListener("click", () => setZoom(100));
  $("#stMeasure").addEventListener("click", () => showMeasureMenu());
  $("#measureBtn").addEventListener("click", () => showMeasureMenu($("#measureBtn")));

  $$<HTMLElement>("#viewSwitch button").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.view;
      if (mode === "preview" || mode === "split" || mode === "source") void setView(mode);
    });
  });

  // Live reload: one batch of edits per event, already coalesced and debounced in Rust. Every
  // matching tab is handled, not only the visible one — a background tab that silently keeps
  // showing stale text is the failure this watcher exists to prevent.
  await ipc.onFsChanged((payload) => {
    for (const tab of state.tabs) {
      if (!payload.paths.some((path) => samePath(path, tab.file))) continue;

      /* The policy is the product owner's: an external change wins, silently (SPEC §12). Applied to an
         editable pane that means the *buffer* is replaced, not kept — and when it was dirty that is
         announced, because text vanishing under the cursor with no explanation is indistinguishable from
         a bug. Clearing `dirty` is also what keeps the save honest: the reload refreshes the mtime
         baseline, so a buffer left dirty would sail past the conflict check and overwrite the change
         that just arrived. */
      if (tab.editing && tab.dirty) {
        tab.buffer = null;
        tab.dirty = false;
        toast(i18n.t("edit.reloaded", { name: tab.name }), "warn");
      }

      /* Out of date is what the mark means, and it is the same mark in both cases: the tab you are
         looking at re-renders now, and a background tab keeps the amber dot until it is activated —
         which is when `loadTab` (the mark's single owner) clears it. Before this, a background tab
         changed under the reader with no sign at all, and reloaded only when they happened to look. */
      tab.reloading = true;
      if (tab === activeTab()) {
        tabs.renderTabs();
        tab.source = null;
        void loadTab(tab).finally(() => tabs.renderTabs());
      } else {
        // Off screen: drop the parse so `activate` reloads it, and clear `missing` in case the
        // file is on its way back. Reloading it now would repaint the wrong DOM.
        tab.doc = null;
        tab.source = null;
        tab.missing = false;
        tabs.renderTabs();
      }
    }
  });

  // A file removed from disk marks its tab `missing` (SPEC §3). The Rust watcher emits this
  // separately from `fs://changed`; without a listener the tab kept rendering a deleted file.
  // The parsed document is deliberately kept: the strikethrough tab says the file is gone,
  // while the last render stays readable until the file returns or the tab is reloaded.
  await ipc.onFsRemoved((payload) => {
    let touched = false;
    for (const tab of state.tabs) {
      if (tab.missing) continue;
      if (!payload.paths.some((path) => samePath(path, tab.file))) continue;
      tab.missing = true;
      touched = true;
    }
    if (touched) renderChrome();
  });

  await ipc.onOpenRequest((path) => void openPath(path));

  // Drag & drop. With `dragDropEnabled` the WebView fires no HTML5 drop events at all (IMPL §8),
  // so the drop zone highlight cannot be a CSS state — it is driven by these core events. The
  // highlight class is the mockup's: `.empty.dragover` paints the accent background.
  const emptyState = $("#empty");
  await ipc.onDragEnter(() => {
    if (state.tabs.length === 0) emptyState.classList.add("dragover");
  });
  await ipc.onDragLeave(() => emptyState.classList.remove("dragover"));
  await ipc.onDragDrop((payload) => {
    emptyState.classList.remove("dragover");
    for (const path of payload.paths) void openPath(path);
  });

  const engineList = await ipc.engineStatus();
  status.applyEngineDots(engineList);
  // The measure is resolved to pixels against the prose font (measure.ts), so a webfont that
  // arrives after the first layout changes the right answer.
  void document.fonts?.ready.then(() => applyLayout());

  const startup = await ipc.startupTarget();
  await restoreSession();

  // The session carries the level; now that it is restored, apply it to the running logger too.
  // Rust read the same session at boot, so this only matters when the two disagree — but it also
  // fires `set_log_level`, which is what makes a change in Settings take effect without a relaunch.
  diag.setLevel(state.logLevel);

  // The session may carry an explicit language; re-render everything once it is known.
  applyLang();

  if (startup.path) await openPath(startup.path);

  // Deliberately last and not awaited: a launch must never wait on the network, and a failed check is
  // invisible (about.ts). The status bar is where an answer shows up.
  void about.checkQuietly();

  renderChrome();
}

void boot();
