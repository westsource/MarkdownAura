/* The status bar.
 *
 * The engine dots are the honest answer to "is this thing offline?" — which is the product's
 * whole claim — so the four states are distinct:
 *   off     (grey)   not installed, and installing it is a choice the user has not made
 *   loading (amber)  the wasm module is being fetched
 *   ready   (green)
 *   failed  (red)
 * `off` and `failed` are not the same thing and must not share a colour (SPEC §3).
 *
 * Every label here is generated, never in the shell markup, so a language change re-renders it
 * through `main.ts applyLang()` rather than leaving a stale string behind.
 */
import { num, t } from "../i18n";
import type { EngineInfo } from "../ipc";
import { $, $$ } from "./dom";
import { engineState } from "../render/engines";
import type { EngineId } from "../render/types";

export function setStatus(
  tab: { file: string; words: number; encoding: string; truncated: boolean } | null,
): void {
  if (!tab) {
    $("#stPath").textContent = "—";
    $("#stWords").textContent = t("status.words", { n: num(0) });
    $("#stEnc").textContent = "utf-8";
    $("#stTrunc").innerHTML = "";
    return;
  }
  $("#stPath").textContent = tab.file;
  $("#stWords").textContent = t("status.words", { n: num(tab.words) });
  setEncoding(tab.encoding);
  // A truncated document is a prefix of the file on disk (IMPL §3). Saying so is the whole
  // point of tracking `truncated`; a silent prefix is a lie about what the reader is looking at.
  $("#stTrunc").innerHTML = tab.truncated
    ? `<span class="cluster" title="${t("status.truncatedTitle")}"><span class="dot warn"></span>${t("status.truncated")}</span>`
    : "";
}

/** A lossy decode means what is on screen is not exactly what is on disk. That deserves a
 *  visible mark, not a silent substitution — the badge is the mark (IMPL §3). */
function setEncoding(encoding: string): void {
  const el = $("#stEnc");
  const lossy = encoding === "utf-8-lossy";
  el.title = lossy ? t("status.lossyTitle") : encoding;
  // The status bar's own vocabulary is the dot: warn for "read, but not faithfully".
  el.innerHTML = lossy
    ? `<span class="cluster"><span class="dot warn"></span>${encoding}</span>`
    : encoding;
}

export function setRenderTime(ms: number): void {
  $("#stRender").textContent = t("status.rendered", { n: Math.round(ms) });
}

export function setZoomLabel(percent: number): void {
  $("#stZoom").textContent = `${percent}%`;
}

/** The reading-width chip: the value (`72ch`) or the preset's name when the column has no cap.
 *  Only the label is written — the chip's icon must survive. */
export function setMeasureLabel(label: string, title: string): void {
  $("#stMeasureLabel").textContent = label;
  $("#stMeasure").title = title;
}

export function setWatchLabel(count: number): void {
  $("#watchLabel").textContent = t("status.watching", { n: num(count) });
}

export function applyEngineDots(engines: EngineInfo[]): void {
  for (const engine of engines) {
    const cluster = document.querySelector<HTMLElement>(`#eng-${engine.id}`);
    if (!cluster) continue;
    if (engine.optIn && !engine.installed) {
      cluster.title = t("status.engineMissing", {
        id: engine.id,
        mb: (engine.bytes / 1048576).toFixed(1),
      });
      cluster.innerHTML = `<span class="dot off"></span>${engine.id}`;
      continue;
    }
    cluster.title = t("status.engine", { id: engine.id });
    cluster.innerHTML = `<span class="dot ${dotClass(engine.id as EngineId)}"></span>${engine.id}`;
  }
}

function dotClass(id: EngineId): string {
  switch (engineState(id)) {
    case "ready":
      return "ok";
    case "loading":
      return "warn";
    case "failed":
      return "err";
    default:
      return "off";
  }
}

/** Called after a render so a dot that just transitioned off → loading → ready is repainted. */
export function refreshEngineDots(): void {
  $$(".statusbar .cluster").forEach((cluster) => {
    const id = cluster.id.replace(/^eng-/, "");
    if (id !== "mermaid" && id !== "dot" && id !== "d2") return;
    const dot = cluster.querySelector(".dot");
    if (!dot) return;
    dot.className = `dot ${dotClass(id)}`;
  });
}
