/* Turns a `RenderedDoc` into DOM: fill the diagram placeholders with cards, then render them.
 *
 * The markup here is the mockup's, verbatim — `design/components.css` styles these exact class
 * names and `mockup.js` (`renderMarkdown`) is the reference for the shape. If a class changes,
 * it changes in three places, which is exactly why the class-name lint in IMPL.md §4 exists.
 *
 * The one rule that must never regress: **an engine failure renders inline, in the card, with
 * the line number.** It never clears the rest of the page and it never silently disappears.
 */
import type { DiagramBlock, RenderedDoc } from "../ipc";
import { cacheKey, get as cacheGet, put as cachePut } from "./cache";
import { renderDiagram } from "./engines";
import { isEngineId, type EngineId } from "./types";

export interface PaintResult {
  rendered: number;
  failed: number;
  cached: number;
  ms: number;
}

const esc = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Attribute-safe: the diagram source rides on the card so the viewer can copy it without a
 *  round trip, and sources contain quotes and angle brackets by nature. */
const attr = (value: string): string =>
  esc(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The card's caption. The first meaningful line of the source reads better than "mermaid
 *  diagram" for every block, which is what the mockup does and what people actually scan for. */
function titleOf(block: DiagramBlock): string {
  const first = block.source
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const text = first ?? `${block.lang} diagram`;
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

const ZOOM_ICON =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M3 6.2V3h3.2M13 6.2V3H9.8M3 9.8V13h3.2M13 9.8V13H9.8"/></svg>';
const COPY_ICON =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="5.6" y="5.6" width="7.6" height="7.6" rx="1.5"/><path d="M10.4 5.6V2.8H2.8v7.6h2.8"/></svg>';

function card(block: DiagramBlock, svg: string): string {
  return (
    `<figure class="diagram" data-diagram="${block.id}" data-source="${attr(block.source)}">` +
    `<div class="diagram-head">` +
    `<span class="badge ${block.lang}">${block.lang}</span>` +
    `<span class="diagram-title">${esc(titleOf(block))} · line ${block.line}</span>` +
    `<div class="spacer"></div>` +
    `<button class="iconbtn" data-act="zoom" style="width:22px;height:22px" title="open viewer">${ZOOM_ICON}</button>` +
    `<button class="iconbtn" data-act="copy" style="width:22px;height:22px" title="copy source">${COPY_ICON}</button>` +
    `</div>` +
    `<div class="diagram-body">${svg}</div>` +
    `</figure>`
  );
}

function errorCard(block: DiagramBlock, message: string): string {
  return (
    `<div class="diagram">` +
    `<div class="diagram-head">` +
    `<span class="badge ${block.lang}">${block.lang}</span>` +
    `<span class="diagram-title">line ${block.line}</span>` +
    `</div>` +
    `<div class="diagram-error"><span>render failed at line ${block.line}</span>` +
    `<code>${esc(message)}</code></div>` +
    `</div>`
  );
}

/**
 * Writes `doc.html` into `container` and resolves every diagram placeholder.
 *
 * Renders run in sequence rather than in parallel: mermaid's `render()` is not safe to call
 * concurrently, and a document with a handful of diagrams is not worth the risk of racing it.
 */
export async function paint(container: HTMLElement, doc: RenderedDoc): Promise<PaintResult> {
  const started = performance.now();
  container.innerHTML = doc.html;

  const slots = Array.from(container.querySelectorAll<HTMLElement>("[data-diagram]"));
  const blocks = new Map(doc.diagrams.map((block) => [block.id, block]));

  let rendered = 0;
  let failed = 0;
  let cached = 0;

  for (const slot of slots) {
    const id = slot.dataset.diagram ?? "";
    const block = blocks.get(id);
    if (!block) {
      // A placeholder with no matching block means the two lists disagree; drop it rather than
      // leaving an invisible hole in the document.
      slot.remove();
      continue;
    }

    if (!isEngineId(block.lang)) {
      slot.outerHTML = errorCard(block, `unknown diagram engine: ${block.lang}`);
      failed++;
      continue;
    }

    const engine: EngineId = block.lang;
    const key = cacheKey(engine, block.source);

    const hit = cacheGet(key);
    if (hit !== undefined) {
      slot.outerHTML = card(block, hit);
      cached++;
      continue;
    }

    try {
      const svg = await renderDiagram(engine, block.source, key);
      cachePut(key, svg);
      slot.outerHTML = card(block, svg);
      rendered++;
    } catch (err) {
      slot.outerHTML = errorCard(block, err instanceof Error ? err.message : String(err));
      failed++;
    }
  }

  return { rendered, failed, cached, ms: performance.now() - started };
}

/** Frontmatter pills, rendered above the document rather than inside it. */
export function frontmatterHtml(fields: { key: string; value: string }[]): string {
  if (fields.length === 0) return "";
  return (
    `<div class="frontmatter">` +
    fields
      .map((f) => `<span class="pill">${esc(f.key)}: ${esc(f.value)}</span>`)
      .join("") +
    `</div>`
  );
}
