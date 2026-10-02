/* Side-panel resizing (SPEC §3).
 *
 * The sidebar and the outline are widths in CSS variables (`--w-sidebar` / `--w-outline`), so a
 * drag only writes one number — it never rewrites layout, and the responsive media queries that
 * hide the panels at 720/1000px keep working because they act on the elements, not the tokens.
 *
 * Two rules worth keeping:
 *
 *  - The bounds are read from the `--w-*-min` / `--w-*-max` tokens at drag time, so `tokens.css`
 *    stays the single source of truth and a resize cannot walk past what the design allows.
 *  - The handle lives *inside* the panel it resizes, so hiding the panel (user toggle or media
 *    query) hides the handle too. There is no second place that decides whether a handle shows.
 */
import { state } from "../state";

interface PanelSpec {
  id: string;
  minToken: string;
  maxToken: string;
  fallbackMin: number;
  fallbackMax: number;
  set: (px: number) => void;
  /** Panel width for a pointer x, measured from the panel's own edge. */
  measure: (panel: HTMLElement, clientX: number) => number;
}

const SPECS: PanelSpec[] = [
  {
    id: "sidebarResizer",
    minToken: "--w-sidebar-min",
    maxToken: "--w-sidebar-max",
    fallbackMin: 180,
    fallbackMax: 360,
    set: (px) => {
      state.sidebar.width = px;
    },
    measure: (panel, x) => x - panel.getBoundingClientRect().left,
  },
  {
    id: "outlineResizer",
    minToken: "--w-outline-min",
    maxToken: "--w-outline-max",
    fallbackMin: 160,
    fallbackMax: 360,
    set: (px) => {
      state.outlineWidth = px;
    },
    measure: (panel, x) => panel.getBoundingClientRect().right - x,
  },
];

function tokenPx(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Pushes the stored widths into the tokens. Called from `applyLayout`, so a restored session
 *  lands here and nowhere else. */
export function applyWidths(): void {
  document.documentElement.style.setProperty("--w-sidebar", `${state.sidebar.width}px`);
  document.documentElement.style.setProperty("--w-outline", `${state.outlineWidth}px`);
}

export function wirePanelResizers(onCommit: () => void): void {
  for (const spec of SPECS) {
    const handle = document.getElementById(spec.id);
    const panel = handle?.parentElement;
    if (!handle || !panel) continue;

    let dragging = false;

    handle.addEventListener("pointerdown", (event) => {
      dragging = true;
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const min = tokenPx(spec.minToken, spec.fallbackMin);
      const max = tokenPx(spec.maxToken, spec.fallbackMax);
      const next = Math.round(Math.min(max, Math.max(min, spec.measure(panel, event.clientX))));
      spec.set(next);
      applyWidths();
    });

    const stop = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      // Commit once at the end: a save per pointermove would write the session file ~60x/s.
      onCommit();
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }
}
