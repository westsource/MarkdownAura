/* The editable source pane (SPEC §12, IMPL.md §11).
 *
 * CodeMirror 6 is a lazy `import()` behind the same four-state discipline as the diagram engines
 * (`src/render/engines.ts`), for the same reason: a reader must not pay for an editor it is not
 * using. Measured with this repo's own bundler, the control is 498.8 KB minified / 173.4 KB gzip as
 * its own chunk, so it never lands in the first paint.
 *
 * Every CodeMirror name is imported as a *type* at the top and as a *value* inside `load()`: a static
 * `import` of anything real would defeat the lazy load.
 *
 * Two things here are deliberate:
 *
 * * **One state per tab, per pane.** `EditorState` is what carries the undo history, so swapping a
 *   single document between tabs would silently drop the history of the tab you left. The states live
 *   here rather than on `Tab` because they are the control's business, not the app's.
 * * **Only CodeMirror's own defaults are overridden in the theme.** Typography — the family, the size
 *   from `--doc-size` × `--zoom`, the line-height, the reading measure — is set on `.cm-editor` /
 *   `.cm-content` in `design/components.css`, so the design file stays the single source of truth for
 *   how text looks (IMPL.md §1). What is in the theme is only what has to beat the control's defaults:
 *   the caret, the selection, the background.
 */
import type { Compartment, EditorState as EditorStateType, Extension } from "@codemirror/state";
import type { EditorView as EditorViewType } from "@codemirror/view";

export type EditorStateName = "off" | "loading" | "ready" | "failed";
/** The two panes that show source: the source view, and the left half of the split. */
export type PaneKey = "source" | "split";

type StateNs = typeof import("@codemirror/state");
type ViewNs = typeof import("@codemirror/view");
type CommandsNs = typeof import("@codemirror/commands");
type LanguageNs = typeof import("@codemirror/language");
type MarkdownNs = typeof import("@codemirror/lang-markdown");

interface Runtime {
  state: StateNs;
  view: ViewNs;
  commands: CommandsNs;
  language: LanguageNs;
  markdown: MarkdownNs;
}

interface Pane {
  key: PaneKey;
  view: EditorViewType | null;
  /** Undo history and selection, per tab (see the header). */
  states: Map<string, EditorStateType>;
  /** Which tab the view is currently showing, so a state can be written back on every update. */
  current: string | null;
  readOnly: Compartment | null;
  theme: Compartment | null;
}

const panes = new Map<PaneKey, Pane>();
/** Change handlers live outside `Pane` because they are registered at boot, before anything is
 *  mounted — a handler stored on the pane would be dropped on the floor until the first edit. */
const handlers = new Map<PaneKey, () => void>();
let stateName: EditorStateName = "off";
let runtime: Runtime | null = null;
let loading: Promise<Runtime | null> | null = null;

export const editorState = (): EditorStateName => stateName;

const cssVar = (name: string, fallback: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

async function load(): Promise<Runtime | null> {
  if (runtime) return runtime;
  if (!loading) {
    stateName = "loading";
    loading = (async () => {
      try {
        const [state, view, commands, language, markdown] = await Promise.all([
          import("@codemirror/state"),
          import("@codemirror/view"),
          import("@codemirror/commands"),
          import("@codemirror/language"),
          import("@codemirror/lang-markdown"),
        ]);
        runtime = { state, view, commands, language, markdown };
        stateName = "ready";
        return runtime;
      } catch {
        // A chunk that will not load is not fatal to a reader: the pane stays read-only. `failed` and
        // `off` are different messages, which is exactly why they are different states.
        stateName = "failed";
        loading = null;
        return null;
      }
    })();
  }
  return loading;
}

function themeOf(rt: Runtime): Extension {
  return rt.view.EditorView.theme({
    "&": { backgroundColor: "transparent", color: cssVar("--tx", "#2a2a2e") },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: cssVar("--ac", "#534ab7") },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: cssVar("--ac-bg", "#eeedfe"),
    },
    ".cm-activeLine": { backgroundColor: "transparent" },
  });
}

function extensionsFor(pane: Pane, rt: Runtime, readOnly: boolean): Extension[] {
  const { EditorState } = rt.state;
  const { EditorView, keymap, drawSelection } = rt.view;
  const { defaultKeymap, history, historyKeymap } = rt.commands;
  const { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } = rt.language;
  const { markdown, markdownKeymap } = rt.markdown;

  return [
    history(),
    drawSelection(),
    /* The pane soft-wraps (`pre-wrap`), so the editor has to wrap identically — otherwise the same
       document is two different shapes depending on whether it is editable. */
    EditorView.lineWrapping,
    indentOnInput(),
    bracketMatching(),
    syntaxHighlighting(defaultHighlightStyle),
    markdown(),
    /* Markdown's own keys come first: Enter continues a list item or a quote, and its markup-aware
       deletions only fire where they make sense. Then CodeMirror's defaults, then history — the window
       owns everything else (ctrl E / ctrl S / ctrl F / esc), which is why nothing here claims those. */
    keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
    pane.theme!.of(themeOf(rt)),
    pane.readOnly!.of(EditorState.readOnly.of(readOnly)),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      // The state is the history, so it has to be written back before anything can switch tabs.
      if (pane.current) pane.states.set(pane.current, update.state);
      handlers.get(pane.key)?.();
    }),
  ];
}

/** Mounts an editor into `host`. Loading happens on the first call, once. */
export async function mount(key: PaneKey, host: HTMLElement): Promise<boolean> {
  const rt = await load();
  if (!rt) return false;

  const pane = panes.get(key) ?? {
    key,
    view: null,
    states: new Map<string, EditorStateType>(),
    current: null,
    readOnly: null,
    theme: null,
  };
  pane.readOnly ??= new rt.state.Compartment();
  pane.theme ??= new rt.state.Compartment();
  if (!pane.view) pane.view = new rt.view.EditorView({ state: rt.state.EditorState.create({ doc: "" }), parent: host });
  panes.set(key, pane);
  return true;
}

/** CodeMirror's document is line-normalised, so any comparison against file text has to be too: the
 *  file may carry CRLF, and a "differs" test that did not normalise would dispatch a whole-document
 *  change — killing the caret and the undo history — every time the pane was repainted after a save. */
const normalize = (text: string): string => text.replace(/\r\n/g, "\n");

/** Shows `tabId`'s document in that pane, creating its state on first sight. */
export function show(key: PaneKey, tabId: string, text: string, readOnly: boolean): void {
  const pane = panes.get(key);
  if (!pane?.view || !runtime) return;

  const wanted = normalize(text);
  let state = pane.states.get(tabId);
  if (!state) {
    state = runtime.state.EditorState.create({ doc: wanted, extensions: extensionsFor(pane, runtime, readOnly) });
  } else if (state.doc.toString() !== wanted) {
    /* Never assign unless it differs: this runs on every render — a save, a tab switch, a preview
       refresh — and assigning collapses the caret to the end. */
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: wanted } }).state;
  }
  pane.states.set(tabId, state);
  pane.current = tabId;
  if (pane.view.state !== state) pane.view.setState(state);
}

/** The text a tab's state currently holds. Falls back to the view when the tab is on screen. */
export function doc(key: PaneKey, tabId: string): string {
  const pane = panes.get(key);
  if (!pane) return "";
  if (pane.view && pane.current === tabId) return pane.view.state.doc.toString();
  return pane.states.get(tabId)?.doc.toString() ?? "";
}

export function setReadOnly(key: PaneKey, on: boolean): void {
  const pane = panes.get(key);
  if (!pane?.view || !pane.readOnly || !runtime) return;
  pane.view.dispatch({ effects: pane.readOnly.reconfigure(runtime.state.EditorState.readOnly.of(on)) });
  if (pane.current) pane.states.set(pane.current, pane.view.state);
}

export function focus(key: PaneKey): void {
  panes.get(key)?.view?.focus();
}

export function onChange(key: PaneKey, handler: (() => void) | null): void {
  if (handler) handlers.set(key, handler);
  else handlers.delete(key);
}

/** Rebuilds the theme from the tokens; called when the theme changes, like the engines' reset. */
export function resetTheme(): void {
  if (!runtime) return;
  for (const pane of panes.values()) {
    if (pane.view && pane.theme) pane.view.dispatch({ effects: pane.theme.reconfigure(themeOf(runtime)) });
  }
}

/** Selects a range and centres it. This is how the app's find bar reaches into the pane: the bar
 *  keeps its query, its count and enter/shift-enter, and the current hit is the selection — which is
 *  what a document that renders itself can offer in place of a `<mark>` element. */
export function revealRange(key: PaneKey, from: number, to: number): void {
  const pane = panes.get(key);
  if (!pane?.view || !runtime) return;
  pane.view.dispatch({
    selection: runtime.state.EditorSelection.range(from, to),
    effects: runtime.view.EditorView.scrollIntoView(from, { y: "center" }),
  });
}

/** The element that actually scrolls this pane while the editor owns it.
 *
 *  `document.ts` needs this because the pane itself stops scrolling in the mode (`overflow: hidden`),
 *  so reading `pane.scrollTop` there would always give zero — which is how per-tab scroll restore and
 *  the split-view sync would quietly stop working (SPEC §12 promises both). */
export function scroller(key: PaneKey): HTMLElement | null {
  return panes.get(key)?.view?.scrollDOM ?? null;
}

/** Drops a closed tab's history. Without this the map would keep every document ever opened. */
export function forgetTab(tabId: string): void {
  for (const pane of panes.values()) pane.states.delete(tabId);
}
