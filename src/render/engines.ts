/* The engine registry (IMPL.md §7).
 *
 * Rules this file exists to enforce:
 *  - Every engine is a lazy `import()` behind one four-state machine, `off → loading → ready /
 *    failed`. `off` exists only for d2, and it is a *different thing* from `failed` — the
 *    status bar shows a different colour for each, because "you have not installed this" and
 *    "this is broken" are not the same message.
 *  - mermaid is never imported as the monolith. The ESM entry is 29 KB and code-splits the
 *    rest on demand; `dist/mermaid.min.js` is 5.3 MB for the same functionality (SPEC §4).
 *  - Colours come from `design/tokens.css` via `getComputedStyle`, so the design file stays the
 *    single source of truth and a theme change does not need a second palette in TypeScript.
 */
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

async function renderD2(): Promise<string> {
  // d2 is an 11 MB opt-in download and is not bundled (SPEC §4). Until the download ships, the
  // honest answer is "not installed" rather than a silent failure.
  throw new Error("d2 is not installed — enable it in settings to download it (~11 MB)");
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
