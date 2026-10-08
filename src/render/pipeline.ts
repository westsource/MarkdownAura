/* Turns a `RenderedDoc` into DOM: fill the diagram placeholders with cards, then render them.
 *
 * The markup here is the mockup's, verbatim — `design/components.css` styles these exact class
 * names and `mockup.js` (`renderMarkdown`) is the reference for the shape. If a class changes,
 * it changes in three places, which is exactly why the class-name lint in IMPL.md §4 exists.
 * The one state the mockup has no markup for is the card's *pending* body: the mockup draws its
 * diagrams synchronously, so it never shows one (IMPL.md §4).
 *
 * The rules that must never regress:
 *
 *  - **An engine failure renders inline, in the card, with the line number.** It never clears the
 *    rest of the page and it never silently disappears.
 *  - **A card keeps its identity whatever happens to it.** `data-diagram` and `data-source` are the
 *    only anchors the outline, the viewer and split-view scroll sync have; an error card that drops
 *    them is a card that cannot be jumped to, opened or followed. (This is where we differ from
 *    marktext on purpose: its failed block keeps the block, ours used to lose the id.)
 *  - **Every engine's SVG must scale.** An SVG with pixel width/height and no `viewBox` does not
 *    shrink with the card — it gets clipped — so a missing `viewBox` is derived from those pixels.
 */
import type { DiagramBlock, RenderedDoc } from "../ipc";
import { t } from "../i18n";
import { log } from "../diag";
import { cacheKey, get as cacheGet, put as cachePut } from "./cache";
import { preloadD2, renderDiagram, warmHeaviestEngineOnIdle } from "./engines";
import { highlight } from "./highlight";
import { renderMath } from "./math";
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

/** Replaces a placeholder with its card, in its place in the document, and hands the card back.
 *  The body starts in the pending state so the reader sees the head — and a body of the height a
 *  diagram will take — before the engine has answered. */
function openCard(slot: HTMLElement, block: DiagramBlock): HTMLElement {
  slot.insertAdjacentHTML(
    "beforebegin",
    `<figure class="diagram" data-diagram="${block.id}" data-source="${attr(block.source)}" aria-busy="true">` +
      `<div class="diagram-head">` +
      `<span class="badge ${block.lang}">${block.lang}</span>` +
      `<span class="diagram-title">${esc(titleOf(block))} · line ${block.line}</span>` +
      `<div class="spacer"></div>` +
      `<button class="iconbtn" data-act="zoom" style="width:22px;height:22px" title="open viewer">${ZOOM_ICON}</button>` +
      `<button class="iconbtn" data-act="copy" style="width:22px;height:22px" title="copy source">${COPY_ICON}</button>` +
      `</div>` +
      `<div class="diagram-body"><div class="diagram-pending">${esc(t("diagram.loading"))}</div></div>` +
      `</figure>`,
  );
  const figure = slot.previousElementSibling as HTMLElement;
  slot.remove();
  return figure;
}

function bodyOf(figure: HTMLElement): HTMLElement {
  return figure.querySelector<HTMLElement>(".diagram-body")!;
}

/**
 * Gives a fixed-size SVG that has no `viewBox` one derived from its pixels.
 *
 * Without it, `max-width: 100%` shrinks the SVG's box but not its contents: the drawing stays at its
 * authored coordinate size inside a smaller viewport and the overflow is clipped — a wide graph
 * loses its right-hand side instead of scaling down. Measured, not assumed: `design/components.css`
 * (`.diagram-body svg`) with a 900×120 SVG in a 698px body renders the box at 674 while the inner
 * `<rect>` still measures 900.
 */
function ensureScalable(body: HTMLElement): Element | null {
  const media = body.querySelector("svg, img");
  if (!media) return null;
  if (media.tagName.toLowerCase() !== "svg") return media;

  if (!media.getAttribute("viewBox")) {
    const width = Number.parseFloat(media.getAttribute("width") ?? "");
    const height = Number.parseFloat(media.getAttribute("height") ?? "");
    if (width > 0 && height > 0) media.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
  return media;
}

/** The diagram's accessible name: an explicit `aria-label`, else the SVG's own `<title>`/`<desc>`,
 *  else the card's caption. Raphael-based renderers stamp a boilerplate description on every
 *  diagram, which says nothing about this one. */
function accessibleName(media: Element, fallback: string): string {
  if (media.tagName.toLowerCase() !== "svg") return fallback;

  const explicit = media.getAttribute("aria-label");
  if (explicit) return explicit;

  let title = "";
  let desc = "";
  for (const child of Array.from(media.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "title" && !title) title = (child.textContent ?? "").trim();
    else if (tag === "desc" && !desc) desc = (child.textContent ?? "").trim();
  }
  if (/^Created with Rapha/.test(desc)) desc = "";

  return [title, desc].filter(Boolean).join(". ") || fallback;
}

/** Puts a rendered SVG in the card, makes it scale, and names it. */
function showDiagram(figure: HTMLElement, block: DiagramBlock, svg: string): void {
  const body = bodyOf(figure);
  body.innerHTML = svg;
  const media = ensureScalable(body);
  figure.removeAttribute("aria-busy");
  figure.setAttribute("role", "img");
  figure.setAttribute("aria-label", media ? accessibleName(media, titleOf(block)) : titleOf(block));
}

/** The failure stays inside the card — and the card stays addressable, which is what keeps a broken
 *  diagram in the outline, openable in the viewer and copyable. */
function showFailure(figure: HTMLElement, block: DiagramBlock, message: string): void {
  bodyOf(figure).innerHTML =
    `<div class="diagram-error"><span>render failed at line ${block.line}</span>` +
    `<code>${esc(message)}</code></div>`;
  figure.removeAttribute("aria-busy");
  figure.removeAttribute("role");
  figure.querySelector(".iconbtn[data-act='zoom']")?.remove();
}

/**
 * Writes `doc.html` into `container`, resolves every diagram placeholder, then highlights code and
 * renders math in place.
 *
 * Renders run in sequence rather than in parallel: mermaid's `render()` is not safe to call
 * concurrently, and a document with a handful of diagrams is not worth the risk of racing it.
 *
 * Nothing here is allowed to fail the page. Engines fail inside their card, and the two
 * post-passes (Prism, KaTeX) are best-effort: a document that cannot be highlighted is still a
 * document.
 */
export async function paint(container: HTMLElement, doc: RenderedDoc): Promise<PaintResult> {
  const started = performance.now();
  container.innerHTML = doc.html;

  // The loop below renders cards in document order, so a d2 block behind a mermaid one waits for it and
  // *then* parses 11 MB. Start that parse now, and only when a d2 block actually needs rendering — a
  // cached one does not, and warming for it would cost the whole parse for nothing.
  if (doc.diagrams.some((b) => b.lang === "d2" && cacheGet(cacheKey("d2", b.source)) === undefined)) {
    preloadD2();
  }

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

    const figure = openCard(slot, block);

    if (!isEngineId(block.lang)) {
      showFailure(figure, block, `unknown diagram engine: ${block.lang}`);
      failed++;
      continue;
    }

    const engine: EngineId = block.lang;
    const key = cacheKey(engine, block.source);

    const hit = cacheGet(key);
    if (hit !== undefined) {
      showDiagram(figure, block, hit);
      cached++;
      continue;
    }

    try {
      const svg = await renderDiagram(engine, block.source, key);
      // The document may have been repainted while this render was in flight (a tab switch, an
      // edit): that paint owns the DOM now, and writing into a detached card would lose the work.
      if (!figure.isConnected) continue;
      cachePut(key, svg);
      showDiagram(figure, block, svg);
      rendered++;
    } catch (err) {
      if (!figure.isConnected) continue;
      showFailure(figure, block, err instanceof Error ? err.message : String(err));
      failed++;
    }
  }

  // A document with diagrams is the signal that this reader may need d2 next; warm it while they read.
  if (rendered + cached > 0) warmHeaviestEngineOnIdle();

  // Both post-passes are best-effort by design: a grammar that cannot be loaded, or a KaTeX that
  // fails to import, must leave the document readable rather than blank.
  for (const [what, run] of [
    ["highlight", () => highlight(container)],
    ["math", () => renderMath(container)],
  ] as const) {
    try {
      await run();
    } catch (err) {
      log("warn", "render", `${what} pass failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
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
