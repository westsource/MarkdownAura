/* The tab strip (SPEC §5, v1 scope).
 *
 * v1 ships four states — active, inactive, hover, preview — and the per-tab document state that
 * makes tabs mean anything. `missing` and `reloading` ship; `pinned` is the one still reserved. The
 * right-click menu (close / close others / close right / close all / copy path / show in explorer)
 * lives in `main.ts`: it is delegated on the strip because these tabs are rebuilt every render.
 * `pinned`'s field and its CSS already exist and must not be cleaned up (SPEC §5).
 *
 * Close is always laid out on the active tab and hidden-but-space-reserved elsewhere, so tabs do
 * not jitter when the pointer moves across them.
 */
import { state, type Tab } from "../state";
import { t } from "../i18n";
import { middleEllipsis } from "./dom";

const CLOSE_ICON =
  '<svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

let onActivate: (index: number) => void = () => {};
let onClose: (index: number) => void = () => {};

export function setTabHandlers(activate: (index: number) => void, close: (index: number) => void): void {
  onActivate = activate;
  onClose = close;
}

export function renderTabs(): void {
  const strip = document.getElementById("tabstrip");
  if (!strip) return;

  strip.innerHTML = state.tabs
    .map((tab, index) => {
      const classes = ["tab"];
      if (index === state.activeTab) classes.push("active");
      if (tab.preview) classes.push("preview");
      // `missing` and `reloading` both ship (SPEC §5): a failed read strikes the tab through, and a
      // watcher batch marks it — for the tab re-rendering right now, and for a background one whose
      // reload is deferred until it is activated. `pinned` is the one still reserved.
      if (tab.missing) classes.push("missing");
      if (tab.reloading) classes.push("reloading");
      if (tab.pinned) classes.push("pinned");
      // The buffer differs from the file (SPEC §12). This mark existed in the mockup and in the status
      // bar from the start, and this file — the app's real tab renderer — never learned about it, so an
      // edited buffer showed no mark on its tab at all.
      if (tab.dirty) classes.push("dirty");

      const marker = tab.reloading
        ? '<span class="dot warn"></span>'
        : '<svg class="tab-icon" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M3.6 1.8h5.6l3.2 3.2v9.2H3.6z"/><path d="M9.2 1.8v3.2h3.2"/></svg>';

      // One tooltip for both conditions, so hovering the tab explains whichever mark is showing.
      const notes = [tab.reloading ? t("tab.changed") : null, tab.dirty ? t("edit.unsaved") : null].filter(Boolean);
      const title = notes.length ? `${tab.file} — ${notes.join(" · ")}` : tab.file;

      return (
        `<div class="${classes.join(" ")}" data-i="${index}" title="${escapeAttr(title)}">` +
        marker +
        `<span class="tab-name">${escapeHtml(middleEllipsis(tab.name, 22))}</span>` +
        (tab.dirty ? '<span class="tab-dirty" aria-hidden="true"></span>' : "") +
        `<button class="tab-close" data-close="${index}" aria-label="${t("tab.close")}">${CLOSE_ICON}</button>` +
        `</div>`
      );
    })
    .join("");

  strip.querySelectorAll<HTMLElement>(".tab").forEach((el) => {
    const index = Number(el.dataset.i);
    el.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("[data-close]")) return;
      onActivate(index);
    });
    // Middle click closes, matching every editor the user already has muscle memory for.
    el.addEventListener("auxclick", (event) => {
      if (event.button === 1) {
        event.preventDefault();
        onClose(index);
      }
    });
  });

  strip.querySelectorAll<HTMLElement>("[data-close]").forEach((el) => {
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      onClose(Number(el.dataset.close));
    });
  });
}

export function scrollActiveTabIntoView(): void {
  const el = document.querySelector<HTMLElement>(`.tab[data-i="${state.activeTab}"]`);
  el?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

export type { Tab };
