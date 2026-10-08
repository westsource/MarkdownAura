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
 * Gives every fenced or indented code block a caption row: its language (when the fence named one)
 * and a copy button.
 *
 * The row is markup the *app* adds, like the diagram card's pending body: the parser emits
 * `<pre><code>`, and no document can spell this. That is also why a bare fence — and an indented
 * block — still gets the row, with no badge: "copy this code" is the same gesture whatever the
 * fence said, and the language is the only part that can be absent.
 *
 * Copying reads `code.textContent`, so it works the same before and after Prism has rewritten the
 * block's inner HTML: highlighting changes the markup, never the text.
 */
function addCodeHeads(container: HTMLElement): number {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>("pre > code"));
  let headed = 0;

  for (const code of blocks) {
    const pre = code.parentElement;
    if (!pre || pre.closest("figure.code")) continue;

    const language = /language-([^\s]+)/.exec(code.className)?.[1] ?? "";
    const figure = document.createElement("figure");
    figure.className = "code";
    figure.innerHTML =
      `<div class="code-head">` +
      (language ? `<span class="badge code">${esc(language)}</span>` : "") +
      `<div class="spacer"></div>` +
      `<button class="iconbtn" data-act="copy-code" style="width:22px;height:22px" title="${attr(t("code.copy"))}" aria-label="${attr(t("code.copy"))}">${COPY_ICON}</button>` +
      `</div>`;

    pre.replaceWith(figure);
    figure.append(pre);
    headed++;
  }

  return headed;
}

/* One number per container, bumped by every `paint` on it. Mermaid, d2 and graphviz have no
 * `cancel`: once an engine is asked to render, that work runs to completion and cannot be called
 * off. What *can* be called off is the **write** — and that is the whole of this map. A tab switch
 * or a re-render replaces the container's HTML while an engine is still thinking; the old paint's
 * `figure` is then detached, and every later write it makes is stale. `isConnected` alone covers
 * only the figure-level half: the code heads, the Prism pass and the KaTeX pass write into
 * `container` itself, so they need the generation check as well. */
const generations = new WeakMap<HTMLElement, number>();

/** The generation `container` is currently on. `paint` takes the next number when it starts, so a
 *  caller that awaited a paint can compare and learn whether that paint still owned the DOM when it
 *  finished (used by `document.ts` before it inserts the frontmatter pills). */
export function paintGeneration(container: HTMLElement): number {
  return generations.get(container) ?? 0;
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
 *
 * A run is abandoned whole — no card writes, no code heads, no highlight or math — the moment it is
 * superseded by a newer paint on the same container. There is no partial ownership: the newer paint
 * owns the DOM, and anything the old one still had queued would bleed into it.
 */
export async function paint(container: HTMLElement, doc: RenderedDoc): Promise<PaintResult> {
  const started = performance.now();
  // Take this container's number. A later `paint` on the same container bumps it, which is how this
  // run learns it has been superseded (the engines cannot be cancelled, so this is the only check).
  const generation = paintGeneration(container) + 1;
  generations.set(container, generation);
  const current = (): boolean => generations.get(container) === generation;
  // A superseded run produced nothing the reader can see: the newer paint replaced its HTML. Report
  // zeros rather than counts for cards that no longer exist — the timing is still this run's.
  const abandoned = (): PaintResult => ({
    rendered: 0,
    failed: 0,
    cached: 0,
    ms: performance.now() - started,
  });

  container.innerHTML = doc.html;

  // Every image starts as "on the wire": the CSS reserves height for that state, and the load/error
  // listeners in `main.ts` clear it. Marking them here is one loop over the document's images.
  for (const img of container.querySelectorAll("img")) img.dataset.loading = "1";

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
      // The engine cannot be cancelled, so the only question the await leaves is who owns the DOM.
      // A tab switch or an edit may have repainted this container while it worked: that paint owns
      // the DOM now, so this run is dropped whole rather than writing into a detached card.
      if (!current() || !figure.isConnected) return abandoned();
      cachePut(key, svg);
      showDiagram(figure, block, svg);
      rendered++;
    } catch (err) {
      if (!current() || !figure.isConnected) return abandoned();
      showFailure(figure, block, err instanceof Error ? err.message : String(err));
      failed++;
    }
  }

  // Everything below writes into `container` (the code heads) or reads its DOM (Prism, KaTeX), and
  // the awaits above may have let a newer paint take over. A superseded run stops here, before any
  // of it.
  if (!current()) return abandoned();

  // A document with diagrams is the signal that this reader may need d2 next; warm it while they read.
  if (rendered + cached > 0) warmHeaviestEngineOnIdle();

  // The code heads are markup and cannot fail; the two passes after them can, and are best-effort by
  // design: a grammar that cannot be loaded, or a KaTeX that fails to import, must leave the document
  // readable rather than blank.
  addCodeHeads(container);
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
