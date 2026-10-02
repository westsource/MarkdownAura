/* Immersive reading (F11, SPEC §10).
 *
 * Every piece of chrome disappears — title bar, tabs, toolbar, sidebar, outline, status bar —
 * leaving only the document and the diagram cards' own controls. The way back is a 5px hot zone
 * along the top edge that reveals a 34px bar on hover; `esc` also exits.
 *
 * The bar carries the two reading controls (reading width, zoom), because a mode whose exit is a
 * hover *and* which cannot be adjusted is a mode people leave rather than read in. Both write the
 * same fields the status bar does; nothing here owns state.
 *
 * The bar is announced once, on first entry, with a toast. Repeating it on every entry would
 * train the reader to ignore it, and the hot zone is discoverable exactly once.
 *
 * All of the hiding is CSS: `.window.immersive` in components.css. This module only flips the
 * class, keeps the bar's labels current and routes its two controls back to the app.
 */
import { activeTab } from "../state";
import { t } from "../i18n";
import { $, toast } from "./dom";

export interface ImmersiveHooks {
  /** The bar's zoom chip resets to 100%, exactly like the status bar's. */
  onZoomReset: () => void;
  /** Opens the reading-width menu anchored to the chip, so the document stays visible. */
  onMeasureMenu: (anchor: HTMLElement) => void;
}

let on = false;
let announced = false;
let hooks: ImmersiveHooks | null = null;

export function isActive(): boolean {
  return on;
}

/** Keeps the two chips in step with the rest of the app; called from `applyLayout`, so they carry
 *  the current language as well as the current values. */
export function setReadingLabels(reading: {
  measure: string;
  measureTitle: string;
  zoom: string;
  zoomTitle: string;
}): void {
  const measure = $("#imMeasureLabel");
  measure.textContent = reading.measure;
  $("#imMeasure").title = reading.measureTitle;
  const zoom = $("#imZoom");
  zoom.textContent = reading.zoom;
  zoom.title = reading.zoomTitle;
}

export function set(next: boolean): void {
  on = next;
  $("#win").classList.toggle("immersive", on);

  if (on) {
    const tab = activeTab();
    $("#imFile").textContent = tab ? tab.file : "—";
    if (!announced) {
      announced = true;
      toast(t("immersive.toast"));
    }
  }
}

export function toggle(): void {
  set(!on);
}

export function wire(immersiveHooks: ImmersiveHooks): void {
  hooks = immersiveHooks;

  // The hot zone itself needs no handler: the reveal is pure CSS (`:hover + .im-bar`).
  const bar = $("#imBar");

  // Clicking empty bar space exits, which is the one affordance CSS cannot give. A *control* in
  // the bar must not exit: clicking the width chip would otherwise close the mode being adjusted.
  bar.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("button")) return;
    set(false);
  });

  $("#imZoom").addEventListener("click", () => hooks?.onZoomReset());
  $("#imMeasure").addEventListener("click", (event) => {
    hooks?.onMeasureMenu(event.currentTarget as HTMLElement);
  });
}
