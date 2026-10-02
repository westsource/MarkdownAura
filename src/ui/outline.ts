/* The right panel: heading outline plus the diagram list (SPEC §3).
 *
 * Clicking a diagram entry jumps to its card, which is why the entries are keyed by the same
 * `data-diagram` id the placeholder carried — never by position, or a re-render would send you
 * to the wrong graph.
 */
import type { RenderedDoc } from "../ipc";
import { t } from "../i18n";
import { $, $$, esc } from "./dom";

let onJump: (target: string, kind: "heading" | "diagram") => void = () => {};

export function setJumpHandler(handler: (target: string, kind: "heading" | "diagram") => void): void {
  onJump = handler;
}

export function renderOutline(doc: RenderedDoc | null): void {
  const list = $("#outlineList");
  const diagrams = $("#diagramList");

  if (!doc) {
    list.innerHTML = "";
    diagrams.innerHTML = "";
    return;
  }

  list.innerHTML =
    doc.headings
      .filter((heading) => heading.level <= 4)
      .map(
        (heading) =>
          `<div class="outline-item" data-level="${heading.level}" data-target="${heading.id}"` +
          ` title="${esc(heading.text)}">${esc(heading.text)}</div>`,
      )
      .join("") || `<div class="outline-item" style="opacity:.6">${t("outline.none")}</div>`;

  diagrams.innerHTML =
    doc.diagrams
      .map(
        (block) =>
          `<div class="outline-item outline-diagram" data-diagram="${block.id}">` +
          `<span class="badge ${block.lang}">${block.lang}</span>` +
          `<span style="overflow:hidden;text-overflow:ellipsis;">${esc(caption(block.source))}</span></div>`,
      )
      .join("") || `<div class="outline-item" style="opacity:.6">${t("outline.none")}</div>`;

  $$("#outlineList .outline-item").forEach((el) => {
    const target = el.dataset.target;
    if (!target) return;
    el.addEventListener("click", () => onJump(target, "heading"));
  });
  $$("#diagramList .outline-item").forEach((el) => {
    const target = el.dataset.diagram;
    if (!target) return;
    el.addEventListener("click", () => onJump(target, "diagram"));
  });
}

function caption(source: string): string {
  const first = source
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const text = first ?? t("outline.diagram");
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** Scroll-spy: exactly one heading is current, and it is the last one above the fold. */
export function setOutlineActive(headingId: string | null): void {
  $$("#outlineList .outline-item").forEach((el) => {
    el.classList.toggle("active", headingId !== null && el.dataset.target === headingId);
  });
}
