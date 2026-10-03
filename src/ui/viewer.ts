/* The diagram viewer overlay (SPEC §4, §10).
 *
 * Opens one rendered diagram large, with scroll-to-zoom and drag-to-pan. The SVG is cloned from
 * the card rather than re-rendered: re-rendering a large graph to open a viewer would be a
 * visible stall for something that should feel instant.
 *
 * Copying the SVG puts real markup on the clipboard, which pastes into anything that takes an
 * image or a file — copying the source is the separate, explicit action next to it.
 */
import { t } from "../i18n";
import { $, copyText, toast } from "./dom";

interface OpenDiagram {
  lang: string;
  title: string;
  source: string;
  svg: string;
}

let current: OpenDiagram | null = null;
let zoom = 1;
let panX = 0;
let panY = 0;

export function isOpen(): boolean {
  return $("#diagramOverlay").classList.contains("on");
}

/** Opens the viewer for the card whose `data-diagram` id is given. */
export function openById(id: string): void {
  const card = document.querySelector<HTMLElement>(`figure.diagram[data-diagram="${CSS.escape(id)}"]`);
  if (!card) return;
  // `.diagram-body svg`, not `svg`: the card head's zoom and copy buttons are `<svg>` icons and come
  // first in document order, so a bare `querySelector("svg")` cloned a 12×12 button glyph into a
  // full-panel viewer — a blank overlay for every engine.
  const svg = card.querySelector(".diagram-body svg")?.outerHTML;
  if (!svg) {
    toast(t("viewer.noOutput"), "warn");
    return;
  }
  open({
    lang: card.querySelector(".badge")?.textContent?.trim() ?? "diagram",
    title: card.querySelector(".diagram-title")?.textContent?.trim() ?? "diagram",
    source: card.dataset.source ?? "",
    svg,
  });
}

export function close(): void {
  $("#diagramOverlay").classList.remove("on");
  current = null;
}

/** Opens the viewer. The SVG is cloned markup, not a re-render: opening a viewer must feel
 *  instant, and re-rendering a large graph to do it would be a visible stall. */
export function open(diagram: OpenDiagram): void {
  current = diagram;
  zoom = 1;
  panX = 0;
  panY = 0;

  const badge = $("#ovBadge");
  badge.className = `badge ${diagram.lang}`;
  badge.textContent = diagram.lang;
  $("#ovTitle").textContent = diagram.title;
  $("#ovEngine").textContent = engineLabel(diagram.lang);
  $("#ovBody").innerHTML = `<div class="ov-stage">${diagram.svg}</div>`;

  applyTransform();
  $("#diagramOverlay").classList.add("on");
}

function engineLabel(lang: string): string {
  switch (lang) {
    case "mermaid":
      return "mermaid.js";
    case "dot":
      return "graphviz-wasm";
    case "d2":
      return "d2-wasm";
    default:
      return lang;
  }
}

function applyTransform(): void {
  const stage = document.querySelector<HTMLElement>("#ovBody .ov-stage");
  if (!stage) return;
  stage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  $("#ovPct").textContent = `${Math.round(zoom * 100)}%`;
}

function setZoom(next: number): void {
  zoom = Math.min(4, Math.max(0.25, next));
  applyTransform();
}

export function wire(): void {
  const overlay = $("#diagramOverlay");

  overlay.addEventListener("wheel", (event) => {
    if (!isOpen()) return;
    event.preventDefault();
    setZoom(zoom * (event.deltaY < 0 ? 1.1 : 0.9));
  }, { passive: false });

  let dragging = false;
  let startX = 0;
  let startY = 0;

  $("#ovBody").addEventListener("pointerdown", (event) => {
    dragging = true;
    startX = event.clientX - panX;
    startY = event.clientY - panY;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  });
  $("#ovBody").addEventListener("pointermove", (event) => {
    if (!dragging) return;
    panX = event.clientX - startX;
    panY = event.clientY - startY;
    applyTransform();
  });
  const stop = () => {
    dragging = false;
  };
  $("#ovBody").addEventListener("pointerup", stop);
  $("#ovBody").addEventListener("pointercancel", stop);

  $("#ovIn").addEventListener("click", () => setZoom(zoom * 1.2));
  $("#ovOut").addEventListener("click", () => setZoom(zoom / 1.2));
  $("#ovPct").addEventListener("click", () => {
    zoom = 1;
    panX = 0;
    panY = 0;
    applyTransform();
  });

  $("#ovCopySvg").addEventListener("click", () => {
    if (!current) return;
    copyText(current.svg);
    toast(t("toast.svgCopied"), "ok");
  });
  $("#ovCopySrc").addEventListener("click", () => {
    if (!current) return;
    copyText(current.source);
    toast(t("toast.sourceCopied"), "ok");
  });
  $("#ovClose").addEventListener("click", close);

  overlay.addEventListener("click", (event) => {
    // Clicking the backdrop closes; clicks inside the sheet must not.
    if (event.target === overlay) close();
  });
}
