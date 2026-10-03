/* The engine registry (IMPL.md §7).
 *
 * Rules this file exists to enforce:
 *  - Every engine is a lazy `import()` behind one four-state machine, `off → loading → ready /
 *    failed`. `off` means "not loaded yet" and is a *different thing* from `failed`: the status bar
 *    colours them differently, because "this has not run yet" and "this is broken" are not the same
 *    message. All three engines start `off` — d2 included, even though it ships in the bundle.
 *  - mermaid is never imported as the monolith. The ESM entry is 29 KB and code-splits the
 *    rest on demand; `dist/mermaid.min.js` is 5.3 MB for the same functionality (SPEC §4).
 *  - Colours come from `design/tokens.css` via `getComputedStyle`, so the design file stays the
 *    single source of truth and a theme change does not need a second palette in TypeScript.
 */
import { clear as clearCache } from "./cache";
import type { D2 } from "@d2lang/d2";
import type { EngineId } from "./types";

export type EngineState = "off" | "loading" | "ready" | "failed";

interface Runtime {
  state: EngineState;
  render(source: string, key: string): Promise<string>;
  resetTheme?(): void;
}

const cssVar = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};

// ---------------------------------------------------------------- mermaid

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

async function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({
        // The app renders explicitly; mermaid must not go hunting for `class="mermaid"`.
        startOnLoad: false,
        // Diagram sources come from files on disk, so treat them as untrusted input.
        securityLevel: "strict",
        theme: "base",
        themeVariables: mermaidThemeVars(),
        fontFamily: cssVar("--font-sans", "system-ui, sans-serif"),
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

function mermaidThemeVars(): Record<string, string> {
  return {
    background: cssVar("--bg", "#ffffff"),
    primaryColor: cssVar("--ac-bg", "#eeedfe"),
    primaryBorderColor: cssVar("--ac", "#534ab7"),
    primaryTextColor: cssVar("--ac-tx", "#3c3489"),
    secondaryColor: cssVar("--code", "#f5f4f1"),
    tertiaryColor: cssVar("--side", "#faf9f7"),
    lineColor: cssVar("--line-3", "rgba(0,0,0,.28)"),
    textColor: cssVar("--tx", "#2a2a2e"),
    mainBkg: cssVar("--card", "#ffffff"),
    nodeBorder: cssVar("--ac", "#534ab7"),
    clusterBkg: cssVar("--code", "#f5f4f1"),
    clusterBorder: cssVar("--line-2", "rgba(0,0,0,.16)"),
    edgeLabelBackground: cssVar("--bg", "#ffffff"),
  };
}

let mermaidSeq = 0;

async function renderMermaid(source: string): Promise<string> {
  const mermaid = await loadMermaid();
  // mermaid needs an id it can attach a temporary element to; collisions produce blank output.
  const id = `mmd-${++mermaidSeq}`;
  const { svg } = await mermaid.render(id, source);
  return svg;
}

/** Mermaid bakes its theme into the SVG, so a theme switch needs a fresh initialise. */
function resetMermaidTheme(): void {
  if (!mermaidPromise) return;
  mermaidPromise = null;
}

// ---------------------------------------------------------------- graphviz (dot)

type Graphviz = { dot(source: string): string };
let graphvizPromise: Promise<Graphviz> | null = null;

async function loadGraphviz(): Promise<Graphviz> {
  if (!graphvizPromise) {
    graphvizPromise = import("@hpcc-js/wasm-graphviz").then(async (mod) => {
      // The wasm is inlined in the package, so this resolves with no network access.
      const GraphvizCtor = (mod as unknown as { Graphviz: { load(): Promise<Graphviz> } }).Graphviz;
      return GraphvizCtor.load();
    });
  }
  return graphvizPromise;
}

async function renderDot(source: string): Promise<string> {
  const graphviz = await loadGraphviz();
  return graphviz.dot(source);
}

// ---------------------------------------------------------------- d2

/* d2 ships in the bundle (SPEC §4): the package's browser build is one 11.5 MB module with its wasm
 * inlined, and it runs its own worker internally — `dispose()` is what shuts that worker down. So there
 * is no install step, no `engine_install` command and nothing fetched at runtime; the first d2 block in
 * a document pays for parsing the module, and later ones reuse it. */

let d2Promise: Promise<D2> | null = null;

async function loadD2(): Promise<D2> {
  if (!d2Promise) d2Promise = import("@d2lang/d2").then((mod) => new mod.D2());
  return d2Promise;
}

/* d2's own catalogue, by the ids its source assigns: 0 Neutral Default (light), 200 Dark Mauve. The
   *app's* theme picks one — never the OS — because the app's theme can disagree with it. */
const D2_THEME_LIGHT = 0;
const D2_THEME_DARK = 200;

let d2Seq = 0;

/** Starts the d2 import and does not wait for it. The parse is the 11 MB cost in SPEC §4, so both
 *  callers exist to move it off the critical path: the pipeline calls it the moment a document is known
 *  to contain an uncached d2 block, and a document that has diagrams warms it on idle (see
 *  `warmHeaviestEngineOnIdle`). A failure is dropped here — the render that needs it reports it. */
export function preloadD2(): void {
  loadD2().catch(() => {
    // A failed import must not poison the engine for the rest of the session: drop the rejected promise
    // so the next document tries again.
    d2Promise = null;
  });
}

let warmScheduled = false;

/** Warms **the heaviest engine** (d2, by an order of magnitude — SPEC §4) once per session, on idle,
 *  after a document that actually has diagrams has rendered. Paying the parse between the reader's
 *  actions is what makes the first d2 card feel immediate instead of taking seconds; the price is a
 *  burst of main-thread work for a reader who may never render d2, which is why it is gated on "a
 *  diagram was rendered" and cannot repeat. A text-only reader never triggers it. */
export function warmHeaviestEngineOnIdle(): void {
  if (warmScheduled) return;
  warmScheduled = true;
  if (window.requestIdleCallback) {
    window.requestIdleCallback(() => preloadD2(), { timeout: 8000 });
  } else {
    window.setTimeout(() => preloadD2(), 1200);
  }
}

async function renderD2(source: string): Promise<string> {
  const d2 = await loadD2();
  const compiled = await d2.compile(source);
  return d2.render(compiled.diagram, {
    themeID: document.documentElement.dataset.theme === "dark" ? D2_THEME_DARK : D2_THEME_LIGHT,
    // Two identical diagrams in one document would otherwise emit the same element ids.
    salt: `d2-${++d2Seq}`,
    // The SVG is injected into the page, not written to a file.
    noXMLTag: true,
  });
}

// ---------------------------------------------------------------- registry

const runtimes: Record<EngineId, Runtime> = {
  mermaid: { state: "off", render: renderMermaid, resetTheme: resetMermaidTheme },
  dot: { state: "off", render: renderDot },
  d2: { state: "off", render: renderD2 },
};

export function engineState(id: EngineId): EngineState {
  return runtimes[id].state;
}

/** Called after a theme change so the next render picks up the new variables. */
export function invalidateEngineThemes(): void {
  // The cache as well as the engines: every engine bakes its palette into the SVG it returns, so a
  // cached one would come back wearing the old theme. This used to be forgotten and a theme switch
  // left already-rendered diagrams in the previous theme.
  clearCache();
  for (const runtime of Object.values(runtimes)) {
    runtime.resetTheme?.();
    if (runtime.state === "ready") runtime.state = "off";
  }
}

export async function renderDiagram(id: EngineId, source: string, key: string): Promise<string> {
  const runtime = runtimes[id];
  if (runtime.state !== "ready") runtime.state = "loading";
  try {
    const svg = await runtime.render(source, key);
    runtime.state = "ready";
    return svg;
  } catch (err) {
    runtime.state = "failed";
    throw err;
  }
}
