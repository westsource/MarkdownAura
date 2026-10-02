/* Small DOM helpers shared by the UI modules.
 *
 * The markup produced here mirrors `design/mockup.js` exactly — same class names, same nesting —
 * because the two share `design/*.css`. Anything invented here would be styled by nothing.
 */

export function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`shell element is missing: ${selector}`);
  return found;
}

/** For elements that come and go with rendered content. `$` throws by design — it guards the
 *  shell — so optional elements must not go through it: `$(sel)?.x` would throw before the `?.`
 *  is ever evaluated, which is exactly the bug this function exists to prevent. */
export function maybe$<T extends HTMLElement = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

export function $$<T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

export const esc = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Keeps both ends of a long filename, which is the part that identifies it. */
export function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.floor((max - 1) / 2);
  return `${text.slice(0, keep)}…${text.slice(text.length - keep)}`;
}

export function copyText(text: string): void {
  navigator.clipboard?.writeText(text).catch(() => {
    // Clipboard access can be refused; failing silently is better than a dialog for a copy.
  });
}

export function toast(message: string, kind?: "ok" | "warn" | "err"): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = (kind ? `<span class="dot ${kind}"></span>` : "") + `<span>${esc(message)}</span>`;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 200ms";
  }, 1800);
  setTimeout(() => el.remove(), 2100);
}

// ---------------------------------------------------------------- menu

export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

/** The element that opened the current menu, so a second press on it closes rather than reopens. */
let menuAnchor: HTMLElement | null = null;
/** Set when this pointerdown closed a menu the target itself had opened — the click that follows
 *  must then be swallowed instead of reopening it. */
let togglePending: HTMLElement | null = null;

/* One dismissal listener for every menu, in the capture phase so it runs before the opener's own
   click handler. `design/mockup.js` has always had this (a document-level click closes the menu);
   the app shipped without it, so a menu opened from the reading-width chip or the toolbar stayed
   on screen until `esc` or a click on one of its own items. */
document.addEventListener(
  "pointerdown",
  (event) => {
    const target = event.target as HTMLElement | null;
    // Read the opener *before* hiding: `hideMenu` clears it, and the toggle below needs it.
    const opener = menuAnchor;
    const fromOpener =
      target !== null && opener !== null && (target === opener || opener.contains(target));
    togglePending = null;
    if (!menuIsOpen()) return;
    if (target && $("#menu").contains(target)) return;
    hideMenu();
    if (fromOpener) togglePending = opener;
  },
  true,
);

/** Positions the menu in **viewport** coordinates (`getBoundingClientRect`-style x/y) and flips it
 *  back inside the window. `.menu` must stay `position: fixed` for this to hold — see the rule in
 *  components.css; as an absolute child of `#main` the same numbers meant something else and the
 *  menu could be laid out past the right edge.
 *
 *  Pass `opener` when a control opened the menu: it makes the control a toggle and is what the
 *  dismissal listener compares against. Menus opened from the keyboard pass nothing. */
export function showMenu(
  items: Array<MenuItem | "sep" | string>,
  x: number,
  y: number,
  opener?: HTMLElement,
): void {
  if (opener && opener === togglePending) {
    // The pointerdown that just closed this menu came from its own opener: a toggle, not a reopen.
    togglePending = null;
    return;
  }
  menuAnchor = opener ?? null;

  const menu = $("#menu");
  const actions: Array<() => void> = [];

  menu.innerHTML = items
    .map((item) => {
      if (item === "sep") return '<div class="menu-sep"></div>';
      if (typeof item === "string") return `<div class="menu-head">${esc(item)}</div>`;
      actions.push(item.run);
      const disabled = item.disabled ? ' aria-disabled="true"' : "";
      const shortcut = item.shortcut ? `<kbd>${item.shortcut}</kbd>` : "";
      return `<div class="menu-item"${disabled}><span>${esc(item.label)}</span>${shortcut}</div>`;
    })
    .join("");

  menu.classList.add("on");

  // Position after layout so the menu can be flipped back inside the window.
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 6);
  const top = Math.min(y, window.innerHeight - rect.height - 6);
  menu.style.left = `${Math.max(6, left)}px`;
  menu.style.top = `${Math.max(6, top)}px`;

  let index = -1;
  $$(".menu-item", menu).forEach((el) => {
    const run = actions[++index];
    el.addEventListener("click", () => {
      if (el.getAttribute("aria-disabled") === "true") return;
      hideMenu();
      run?.();
    });
  });
}

export function hideMenu(): void {
  $("#menu").classList.remove("on");
  menuAnchor = null;
}

export function menuIsOpen(): boolean {
  return $("#menu").classList.contains("on");
}

// ---------------------------------------------------------------- icons

export const CHEV_OPEN =
  '<svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5L6 7.5l3-3"/></svg>';
export const CHEV_SHUT =
  '<svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3L7.5 6l-3 3"/></svg>';

export const DIR_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M1.8 4.2h4.4l1.4 1.8h6.6v7.8H1.8z"/></svg>';
export const FILE_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M3.6 1.8h5.6l3.2 3.2v9.2H3.6z"/><path d="M9.2 1.8v3.2h3.2"/></svg>';
