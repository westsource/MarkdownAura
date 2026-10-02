/* Find in document (SPEC §7).
 *
 * Matches are `<mark>` elements inserted around text nodes, never around markup — wrapping a
 * node's parent would break the diagram cards and the tables. The current hit is scrolled into
 * view and given `.on`, which is the only visual difference between hits.
 *
 * State lives on the tab (IMPL.md §5): switching tabs must not lose the query, the case flag or
 * the position.
 */
import type { Tab } from "../state";
import { $, $$ } from "./dom";

export function isOpen(): boolean {
  return $("#findbar").classList.contains("on");
}

export function open(tab: Tab): void {
  const bar = $("#findbar");
  bar.classList.add("on");
  const input = $<HTMLInputElement>("#findInput");
  input.value = tab.find.q;
  $<HTMLButtonElement>("#findCase").classList.toggle("on", tab.find.case);
  input.focus();
  input.select();
  if (tab.find.q) run(tab);
}

export function close(tab: Tab): void {
  $("#findbar").classList.remove("on");
  clearMarks();
  tab.find.hit = 0;
  updateCount(tab, 0);
}

export function setCase(tab: Tab, on: boolean): void {
  tab.find.case = on;
  $<HTMLButtonElement>("#findCase").classList.toggle("on", on);
  run(tab);
}

export function next(tab: Tab): void {
  step(tab, 1);
}

export function prev(tab: Tab): void {
  step(tab, -1);
}

/** Re-runs the search after the document was re-rendered, keeping the position by index.
 *  An empty query is a legitimate input: it must clear the marks, not leave the old ones. */
export function refresh(tab: Tab): void {
  if (!isOpen()) return;
  run(tab);
}

function clearMarks(): void {
  $$("mark[data-hit]").forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
    parent.normalize();
  });
}

function updateCount(tab: Tab, total: number): void {
  const shown = total === 0 ? 0 : (tab.find.hit % total) + 1;
  $("#findCount").textContent = `${shown}/${total}`;
}

function run(tab: Tab): void {
  clearMarks();
  const query = tab.find.q;
  if (!query) {
    updateCount(tab, 0);
    return;
  }

  // Search whatever the reader is actually looking at: the preview prose, both split panes, or
  // the source view. The source view's lines are spans of plain text, so the same text-node walk
  // works there; a match simply cannot span a line break, in either view.
  const root = document.querySelector<HTMLElement>(".view.on") ?? document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if ((node.nodeValue ?? "").length > 0) targets.push(node);
  }

  const flags = tab.find.case ? "g" : "gi";
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, flags);

  let found = 0;
  for (const text of targets) {
    const value = text.nodeValue ?? "";
    pattern.lastIndex = 0;
    if (!pattern.test(value)) continue;

    // Split once, then re-wrap: replacing inside a live Text node invalidates the walker, so the
    // matches are collected first and applied afterwards.
    pattern.lastIndex = 0;
    const parts: Array<string | number> = [];
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value))) {
      if (match.index > last) parts.push(value.slice(last, match.index));
      parts.push(match.index);
      last = match.index + match[0].length;
      if (match[0].length === 0) pattern.lastIndex++;
    }
    if (last < value.length) parts.push(value.slice(last));

    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      if (typeof part === "string") {
        fragment.appendChild(document.createTextNode(part));
      } else {
        const mark = document.createElement("mark");
        mark.className = "";
        mark.dataset.hit = String(found++);
        mark.textContent = value.slice(part, part + query.length);
        fragment.appendChild(mark);
      }
    }
    text.parentNode?.replaceChild(fragment, text);
  }

  if (tab.find.hit >= found) tab.find.hit = 0;
  updateCount(tab, found);
  highlightCurrent(tab, found);
}

function step(tab: Tab, direction: 1 | -1): void {
  const marks = $$("mark[data-hit]");
  if (marks.length === 0) return;
  tab.find.hit = (tab.find.hit + direction + marks.length) % marks.length;
  updateCount(tab, marks.length);
  highlightCurrent(tab, marks.length);
}

function highlightCurrent(tab: Tab, total: number): void {
  const marks = $$("mark[data-hit]");
  marks.forEach((mark) => mark.classList.remove("current"));
  if (total === 0) return;
  const current = marks[tab.find.hit % marks.length];
  if (!current) return;
  current.classList.add("current");
  current.scrollIntoView({ block: "center", behavior: "smooth" });
}

/** Updates the bar to match the tab without stealing focus — used on tab switches, where the
 *  query belongs to the tab but the reader was not asking to search. */
export function syncInput(tab: Tab): void {
  const input = $<HTMLInputElement>("#findInput");
  input.value = tab.find.q;
  $<HTMLButtonElement>("#findCase").classList.toggle("on", tab.find.case);
  if (isOpen()) refresh(tab);
}

export function wire(onInput: (tab: Tab) => void, getTab: () => Tab | null): void {
  $<HTMLInputElement>("#findInput").addEventListener("input", () => {
    const tab = getTab();
    if (!tab) return;
    tab.find.q = $<HTMLInputElement>("#findInput").value;
    tab.find.hit = 0;
    onInput(tab);
  });
  $("#findNext").addEventListener("click", () => {
    const tab = getTab();
    if (tab) next(tab);
  });
  $("#findPrev").addEventListener("click", () => {
    const tab = getTab();
    if (tab) prev(tab);
  });
  $("#findCase").addEventListener("click", () => {
    const tab = getTab();
    if (tab) setCase(tab, !tab.find.case);
  });
  $("#findClose").addEventListener("click", () => {
    const tab = getTab();
    if (tab) close(tab);
  });
  $("#findTrigger").addEventListener("click", () => {
    const tab = getTab();
    if (tab) open(tab);
  });
}
