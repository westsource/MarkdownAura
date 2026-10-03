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

import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import * as ipc from "./ipc";
import * as i18n from "./i18n";
import * as measure from "./measure";
import { invalidateEngineThemes } from "./render/engines";
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
  } catch (err) {
    const { message, silent } = ipc.describeError(err);
    if (!silent) toast(message, "err");
    tab.source = "";
  }
}

async function loadTab(tab: Tab): Promise<void> {
  try {
    const rendered = await ipc.renderDoc(tab.file);
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

function closeTab(index: number): void {
  if (index < 0 || index >= state.tabs.length) return;
  state.tabs.splice(index, 1);
  state.activeTab = Math.min(state.activeTab, Math.max(0, state.tabs.length - 1));

  renderChrome();
  if (state.tabs.length > 0) void paintActive();
  scheduleSave();
}

async function setView(mode: doc.ViewMode): Promise<void> {
  const tab = activeTab();
  doc.setView(mode);
  if (!tab) return;

  doc.captureScroll(tab);
  tab.view = mode;
  if (mode !== "preview") await ensureSource(tab);
  await paintActive();
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
  const chosen = await openDialog({ directory: true, multiple: false, title: "Open folder" });
  if (typeof chosen === "string") await applyFolder(chosen);
}

async function pickFile(): Promise<void> {
  const chosen = await openDialog({
    multiple: false,
    title: "Open markdown",
    filters: [{ name: "Markdown", extensions: ipc.MD_EXTENSIONS }],
  });
  if (typeof chosen === "string") await openFile(chosen, false);
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

/** The window rect is part of the session (IMPL §6), so it is read at save time rather than
 *  assumed. Physical units, because that is what `outerSize` reports and what `setSize` takes
 *  back — round-tripping through logical would drift on fractional display scales. */
async function currentWindowRect(): Promise<WindowRect> {
  const win = getCurrentWindow();
  const [size, position, maximized] = await Promise.all([
    win.outerSize(),
    win.outerPosition(),
    win.isMaximized(),
  ]);
  return {
    w: size.width,
    h: size.height,
    x: position.x,
    y: position.y,
    maximized,
  };
}

async function restoreWindowRect(rect: WindowRect): Promise<void> {
  const win = getCurrentWindow();
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
      .catch(() => {
        // A failed save is not worth interrupting reading for; the next change retries it.
      });
  }, 500);
}

async function restoreSession(): Promise<void> {
  const session = await ipc.sessionLoad();
  if (!session) return;

  applySession(session);
  state.recent = session.recent.slice();
  state.windowRect = { ...session.window };
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
    onLangChange: applyLang,
    onSave: scheduleSave,
  });
  help.wire();
  about.wire();
  immersive.wire({
    onZoomReset: () => setZoom(100),
    onMeasureMenu: (anchor) => showMeasureMenu(anchor),
  });

  // Diagram card buttons are delegated: cards are recreated on every render, so per-card
  // listeners would leak. One listener on each prose container covers every card that ever
  // exists in it.
  for (const container of ["#out-preview", "#out-split"]) {
    document.querySelector<HTMLElement>(container)?.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (!button) return;
      const card = button.closest<HTMLElement>("figure.diagram");
      if (!card) return;
      const id = card.dataset.diagram ?? "";
      if (button.dataset.act === "zoom") viewer.openById(id);
      if (button.dataset.act === "copy") {
        copyText(card.dataset.source ?? "");
        toast(i18n.t("toast.sourceCopied"), "ok");
      }
    });
  }

  // The titlebar is ours, so its buttons are wired by hand.
  const win = getCurrentWindow();
  $("#winMin").addEventListener("click", () => void win.minimize());
  $("#winMax").addEventListener("click", () => void win.toggleMaximize());
  $("#winClose").addEventListener("click", () => void win.close());

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

      if (tab === activeTab()) {
        tab.reloading = true;
        tabs.renderTabs();
        tab.source = null;
        void loadTab(tab).finally(() => {
          tab.reloading = false;
          tabs.renderTabs();
        });
      } else {
        // Off screen: drop the parse so `activate` reloads it, and clear `missing` in case the
        // file is on its way back. Reloading it now would repaint the wrong DOM.
        tab.doc = null;
        tab.source = null;
        tab.missing = false;
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

  // The session may carry an explicit language; re-render everything once it is known.
  applyLang();

  if (startup.path) await openPath(startup.path);

  renderChrome();
}

void boot();
