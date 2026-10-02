/* The tab strip (SPEC §5, v1 scope).
 *
 * v1 ships four states — active, inactive, hover, preview — and the per-tab document state that
 * makes tabs mean anything. `missing`, `reloading`, `pinned` and the right-click menu are v2;
 * the fields and the CSS for them already exist and must not be cleaned up (SPEC §5).
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
      // v2 states — emitted so the CSS is exercised, never set by v1 code.
      if (tab.missing) classes.push("missing");
      if (tab.reloading) classes.push("reloading");
      if (tab.pinned) classes.push("pinned");

      const marker = tab.reloading
        ? '<span class="dot warn"></span>'
        : '<svg class="tab-icon" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M3.6 1.8h5.6l3.2 3.2v9.2H3.6z"/><path d="M9.2 1.8v3.2h3.2"/></svg>';

      return (
        `<div class="${classes.join(" ")}" data-i="${index}" title="${escapeAttr(tab.file)}">` +
        marker +
        `<span class="tab-name">${escapeHtml(middleEllipsis(tab.name, 22))}</span>` +
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
