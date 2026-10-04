/* The document area: the three views, the splitter, the source highlighter and the scroll spy.
 *
 * View mode and scroll position are per-tab (IMPL.md §5). Losing scroll on a tab switch is the
 * failure mode SPEC §5 calls out by name, so `capture()` is called before every switch away and
 * `restore()` after every switch in.
 */
import type { RenderedDoc } from "../ipc";
import { frontmatterHtml, paint } from "../render/pipeline";
import type { Tab } from "../state";
import { $, $$, esc } from "./dom";
import * as editor from "./editor";

export type ViewMode = "preview" | "split" | "source";

const MODES: ViewMode[] = ["preview", "split", "source"];

let current: ViewMode = "preview";

export function currentView(): ViewMode {
  return current;
}

export function setView(mode: ViewMode): void {
  current = mode;
  for (const candidate of MODES) {
    document.getElementById(`view-${candidate}`)?.classList.toggle("on", candidate === mode);
  }
  $$("#viewSwitch button").forEach((button) => {
    const on = button.dataset.view === mode;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", String(on));
  });
}

/** The element that actually scrolls for the current view. */
export function activeScroller(): HTMLElement {
  if (current === "split") return $(".pane-out");
  if (current === "source") return $(".source-view");
  return $(".prose-wrap");
}

/** The element that actually scrolls a pane: the editor's scroller while the pane is editable, the pane
 *  itself otherwise. SPEC §12 promises the reading features "address the pane's scroller, which becomes
 *  the editor's" — this is that sentence, in one place. */
function scrollerOf(pane: HTMLElement): HTMLElement {
  const key = pane.classList.contains("source-view") ? "source" : pane.classList.contains("pane-src") ? "split" : null;
  return (key && editor.scroller(key)) || pane;
}

export function captureScroll(tab: Tab): void {
  tab.scroll = scrollerOf(activeScroller()).scrollTop;
}

export function restoreScroll(tab: Tab): void {
  scrollerOf(activeScroller()).scrollTop = tab.scroll;
}

/**
 * Renders `tab` into whichever containers the current view uses.
 *
 * Returns the render time in ms, or 0 if there was nothing to paint.
 */
export async function renderDocument(tab: Tab): Promise<number> {
  const doc: RenderedDoc | null = tab.doc;
  if (!doc) return 0;

  const started = performance.now();

  // The anchors both panes can identify, in document order. Split-view scroll sync interpolates
  // between these; nothing else is addressable in both panes.
  anchorIds = [...doc.headings, ...doc.diagrams]
    .sort((a, b) => a.line - b.line)
    .map((item) => item.id);

  if (current === "source") {
    $("#out-source").innerHTML = highlightSource(tab.source ?? "", doc);
  } else if (current === "preview") {
    await paintInto($("#out-preview"), doc);
  } else {
    $("#out-split-src").innerHTML = highlightSource(tab.source ?? "", doc);
    await paintInto($("#out-split"), doc);
  }

  restoreScroll(tab);
  return performance.now() - started;
}

/**
 * Repaints only the *rendered* panes from the tab's current document — no view switch, no scroll
 * restore.
 *
 * This is the live preview of an edited buffer (SPEC §12): in split view the right half has to follow
 * the typing. It deliberately does not go through `renderDocument`, because that restores the tab's
 * stored scroll position, and doing that on every keystroke would yank the pane the reader is
 * reading back to wherever the tab was last switched away from.
 */
export async function paintRendered(tab: Tab): Promise<void> {
  const doc: RenderedDoc | null = tab.doc;
  if (!doc) return;
  if (current === "preview") await paintInto($("#out-preview"), doc);
  else if (current === "split") await paintInto($("#out-split"), doc);
}

async function paintInto(container: HTMLElement, doc: RenderedDoc): Promise<void> {
  await paint(container, doc);
  // Frontmatter sits above the document rather than inside it, so it is inserted after paint
  // instead of being handed to the pipeline as a prefix.
  const pills = frontmatterHtml(doc.frontmatter);
  if (pills) container.insertAdjacentHTML("afterbegin", pills);
}

/**
 * Read-only syntax highlighting for the source view, with a jump anchor on the lines the outline
 * can target.
 *
 * Only headings and diagram fences get a `data-anchor`, not every line: a large file would
 * otherwise carry one attribute per line for anchors nobody can reach. The five highlight roles
 * are what `prose.css` styles under `.src`; the anchor wrapper is unstyled on purpose.
 */
export function highlightSource(src: string, doc: RenderedDoc): string {
  const anchors = new Map<number, string>();
  for (const heading of doc.headings) anchors.set(heading.line, heading.id);
  for (const diagram of doc.diagrams) anchors.set(diagram.line, diagram.id);

  return src
    .split("\n")
    .map((line, index) => {
      const body = highlightLine(line);
      const anchor = anchors.get(index + 1);
      return anchor ? `<span data-anchor="${esc(anchor)}">${body}</span>` : body;
    })
    .join("\n");
}

function highlightLine(line: string): string {
  if (/^```/.test(line)) return `<span class="meta">${esc(line)}</span>`;
  if (/^#{1,6}\s/.test(line)) return `<span class="h">${esc(line)}</span>`;
  if (/^>\s?/.test(line)) return `<span class="quote">${esc(line)}</span>`;
  return esc(line)
    .replace(/`[^`]*`/g, (m) => `<span class="code">${m}</span>`)
    .replace(/\*\*[^*]+\*\*/g, (m) => `<span class="em">${m}</span>`);
}

// ---------------------------------------------------------------- splitter

export function wireSplitter(): void {
  const splitter = $("#splitter");
  const source = document.querySelector<HTMLElement>("#view-split .pane-src");
  if (!source) return;

  let dragging = false;

  splitter.addEventListener("pointerdown", (event) => {
    dragging = true;
    splitter.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
  });

  splitter.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const bounds = $("#view-split").getBoundingClientRect();
    const percent = ((event.clientX - bounds.left) / bounds.width) * 100;
    // Clamped so neither pane can be dragged to nothing.
    source.style.flex = `0 0 ${Math.min(78, Math.max(22, percent))}%`;
  });

  const stop = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    splitter.releasePointerCapture(event.pointerId);
  };
  splitter.addEventListener("pointerup", stop);
  splitter.addEventListener("pointercancel", stop);
}

// ---------------------------------------------------------------- split scroll sync

/** Anchor ids in document order — headings and diagram cards, the only positions both panes can
 *  identify. Refreshed by `renderDocument`. */
let anchorIds: string[] = [];

/** Where a programmatic scroll put a pane. Its echo must not be mistaken for a user scroll, or the
 *  two panes would push each other forever. */
const expectedScroll = new WeakMap<HTMLElement, number>();

const SRC_PANE = ".pane-src";
const OUT_PANE = ".pane-out";

/** Content-space top of every anchor this pane actually renders. Rect-based so it is independent
 *  of the current scroll position, and measured on demand — the anchor set is headings plus
 *  diagrams (dozens), never one element per line. */
function paneTops(pane: HTMLElement, isSource: boolean): Map<string, number> {
  const paneTop = pane.getBoundingClientRect().top;
  const scroll = scrollerOf(pane).scrollTop;
  const tops = new Map<string, number>();
  for (const id of anchorIds) {
    const escaped = CSS.escape(id);
    const el = pane.querySelector<HTMLElement>(
      isSource ? `[data-anchor="${escaped}"]` : `[id="${escaped}"], [data-diagram="${escaped}"]`,
    );
    if (el) tops.set(id, el.getBoundingClientRect().top - paneTop + scroll);
  }
  return tops;
}

function mapScroll(from: HTMLElement, to: HTMLElement, fromIsSource: boolean, toIsSource: boolean): number {
  const fromEl = scrollerOf(from);
  const toEl = scrollerOf(to);
  const a = paneTops(from, fromIsSource);
  const b = paneTops(to, toIsSource);
  const shared = anchorIds.filter((id) => a.has(id) && b.has(id));

  if (shared.length === 0) {
    // Nothing common — an empty pane, or a document with neither headings nor diagrams. Fall back
    // to proportional scrolling: wrong in detail, right in direction.
    const fromMax = Math.max(0, fromEl.scrollHeight - fromEl.clientHeight);
    const toMax = Math.max(0, toEl.scrollHeight - toEl.clientHeight);
    return fromMax === 0 ? 0 : (fromEl.scrollTop / fromMax) * toMax;
  }

  const y = fromEl.scrollTop;
  let prev = shared[0];
  let next: string | null = null;
  for (const id of shared) {
    if (a.get(id)! <= y) prev = id;
    else {
      next = id;
      break;
    }
  }

  const prevA = a.get(prev)!;
  const prevB = b.get(prev)!;
  if (next === null) {
    // Past the last anchor: 1:1 from it. Nothing is left to interpolate against.
    return Math.max(0, prevB + (y - prevA));
  }
  // Linear between the anchors. `fraction` is deliberately not clamped to [0,1]: above the first
  // anchor it extrapolates upwards, which is the correct direction and gets floored at 0 anyway.
  const spanA = a.get(next)! - prevA;
  const spanB = b.get(next)! - prevB;
  const fraction = spanA > 0 ? (y - prevA) / spanA : 0;
  return Math.max(0, prevB + fraction * spanB);
}

/**
 * Keeps the two split panes on the same place in the document — the continuous, two-way case.
 *
 * Anchors alone would snap from heading to heading, so the mapping is anchor + pixel fraction
 * within the segment. Only split view participates; the other views have a single pane.
 */
function syncSplit(from: HTMLElement): void {
  if (current !== "split") return;

  const fromEl = scrollerOf(from);
  const echo = expectedScroll.get(from);
  if (echo !== undefined && Math.abs(fromEl.scrollTop - echo) <= 1) return;

  const src = document.querySelector<HTMLElement>(SRC_PANE);
  const out = document.querySelector<HTMLElement>(OUT_PANE);
  if (!src || !out) return;

  const to = from === src ? out : from === out ? src : null;
  if (!to) return;

  const target = mapScroll(from, to, from === src, to === src);
  expectedScroll.set(to, target);
  scrollerOf(to).scrollTop = target;
}

// ---------------------------------------------------------------- scroll spy

/**
 * Reports the heading currently at the top of the document and keeps the split panes together.
 * Uses the pre-collected heading offsets rather than measuring on every scroll event, which is
 * what keeps this cheap on a long file.
 */
export function wireScrollSpy(onActive: (headingId: string | null) => void): void {
  let queued = false;

  const handler = (event: Event) => {
    const pane = event.currentTarget as HTMLElement;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      syncSplit(pane);
      onActive(findCurrentHeading());
    });
  };

  // Every scroller of every view: the preview pane, both split panes (sync needs the source pane
  // too, not just the pane that owns the outline), and the source view. The spy reads
  // `activeScroller()` so a view switch needs no re-wiring and cannot end up listening to a
  // detached element.
  /* `capture` on purpose: `scroll` does not bubble, so a listener on the pane never hears the editor's
     own scroller — and in the mode that inner element is the one doing the scrolling (SPEC §12). The
     capture phase still runs for a non-bubbling event, which is what makes this work. */
  for (const el of [".prose-wrap", OUT_PANE, SRC_PANE, ".source-view"]) {
    document.querySelector<HTMLElement>(el)?.addEventListener("scroll", handler, { passive: true, capture: true });
  }
}

function findCurrentHeading(): string | null {
  const scroller = scrollerOf(activeScroller());
  const top = scroller.getBoundingClientRect().top;
  const headings = $$<HTMLElement>("[id^='h']", scroller);

  let currentId: string | null = null;
  for (const heading of headings) {
    // 8px of slack so a heading that has just reached the top counts as current.
    if (heading.getBoundingClientRect().top - top <= 8) currentId = heading.id;
    else break;
  }
  return currentId;
}

/**
 * Scrolls the panes the current view shows to a heading (`h0`) or diagram (`d0`) anchor.
 *
 * The anchor lives under two names: the rendered pane uses the heading `id` or the card's
 * `data-diagram`, the source pane uses `data-anchor` (stamped by `highlightSource`). **Split
 * scrolls both** — comparing the two panes is what split view is for, and a jump that moved only
 * the right one leaves the reader looking at unrelated source. Full bidirectional scroll syncing
 * is still deferred (SPEC §3); this is the one direction the outline can compute exactly, because
 * the heading and diagram records carry their line.
 *
 * Scoping to the visible panes also matters for correctness: a document-wide query would find a
 * hidden view's copy first and scroll nothing at all.
 */
export function jumpTo(target: string): void {
  const anchor = CSS.escape(target);
  if (current === "source") {
    scrollToAnchor($(".source-view"), `[data-anchor="${anchor}"]`);
    return;
  }
  const rendered = current === "split" ? $(".pane-out") : $(".prose-wrap");
  scrollToAnchor(rendered, `[id="${anchor}"], [data-diagram="${anchor}"]`);
  if (current === "split") scrollToAnchor($(".pane-src"), `[data-anchor="${anchor}"]`);
}

/** Puts the matched child 12px below the container's top edge. Rect-based rather than `offsetTop`,
 *  which is relative to the offset parent and silently wrong inside a padded pane. */
function scrollToAnchor(container: HTMLElement, selector: string): void {
  const el = container.querySelector<HTMLElement>(selector);
  if (!el) return;
  const scroller = scrollerOf(container);
  const delta = el.getBoundingClientRect().top - container.getBoundingClientRect().top - 12;
  scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: "smooth" });
}
