/* Settings — an overlay sheet, not a second window (SPEC §10).
 *
 * Four sections: reading / engines / files / cache. The d2 row is the only row in the whole app
 * whose action touches the network, so it is marked `.form-row.hot` and says so out loud; hiding
 * that in a footnote would be dishonest about what the button does.
 *
 * Every control writes to `state` and schedules a session save. Nothing here talks to Rust
 * directly except the cache row, which reports what the render cache currently holds.
 *
 * All copy comes from the i18n catalogue at render time, so a language change just re-renders
 * this sheet (main.ts applyLang) — there is nothing cached in this module.
 */
import { engineState } from "../render/engines";
import { stats as cacheStats, clear as clearCache } from "../render/cache";
import { state } from "../state";
import type { EngineInfo, Lang, ThemeChoice } from "../ipc";
import { t, type Key } from "../i18n";
import { MEASURE_ORDER, isMeasure, measureName } from "../measure";
import { $, $$, esc, maybe$, toast } from "./dom";

export interface SettingsHooks {
  onThemeChange: () => void;
  onFontSizeChange: () => void;
  onMeasureChange: () => void;
  onMotionChange: () => void;
  onLangChange: () => void;
  onSave: () => void;
}

let hooks: SettingsHooks | null = null;
let engines: EngineInfo[] = [];

export function setEngines(list: EngineInfo[]): void {
  engines = list;
  if (isOpen()) render();
}

export function isOpen(): boolean {
  return $("#settingsOverlay").classList.contains("on");
}

export function open(): void {
  render();
  $("#settingsOverlay").classList.add("on");
}

export function close(): void {
  $("#settingsOverlay").classList.remove("on");
}

const formRow = (label: string, sub: string, control: string, cls = ""): string =>
  `<div class="form-row${cls ? ` ${cls}` : ""}">` +
  `<div class="grow"><div>${esc(label)}</div>` +
  (sub ? `<div class="form-sub">${esc(sub)}</div>` : "") +
  `</div>${control}</div>`;

const segment = (set: string, values: Array<[string, string]>, current: string): string =>
  `<div class="segmented text" data-set="${set}">` +
  values
    .map(
      ([value, label]) =>
        `<button data-val="${value}" class="${value === current ? "on" : ""}">${esc(label)}</button>`,
    )
    .join("") +
  `</div>`;

const bytes = (n: number): string =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

// Language names are shown in their own language on purpose — a language picker that is written
// in the language you cannot read is useless. Only `system` is translated.
const LANGUAGES: Array<[Lang, string]> = [
  ["system", ""],
  ["en", "English"],
  ["zh-CN", "简体中文"],
];

const THEMES: Array<[ThemeChoice, Key]> = [
  ["system", "theme.system"],
  ["light", "theme.light"],
  ["dark", "theme.dark"],
];

function render(): void {
  const themeSeg = segment(
    "theme",
    THEMES.map(([theme, key]) => [theme, t(key)]),
    state.theme,
  );

  const langSeg = segment(
    "lang",
    LANGUAGES.map(([value, label]) => [value, label || t("lang.system")]),
    state.lang,
  );

  const measureSeg = segment(
    "measure",
    MEASURE_ORDER.map((id) => [id, measureName(id)]),
    state.measure,
  );

  const d2 = engines.find((e) => e.id === "d2");
  const d2State = d2 ? engineState("d2") : "off";
  const d2Control =
    d2State === "ready"
      ? `<span class="state-ok">${t("settings.installed")}</span>`
      : d2State === "loading"
        ? `<span class="state-off">${t("settings.downloading")}</span>`
        : d2State === "failed"
          ? `<button class="ghost-btn" id="d2Install">${t("settings.retry")}</button>`
          : `<button class="primary-btn" id="d2Install" aria-disabled="true">${t("settings.install")}</button>`;

  const cache = cacheStats();

  $("#setBody").innerHTML =
    `<div class="section-head">${t("settings.section.reading")}</div>` +
    formRow(t("settings.theme"), t("settings.themeSub"), themeSeg) +
    formRow(t("settings.language"), t("settings.languageSub"), langSeg) +
    formRow(
      t("settings.fontSize"),
      t("settings.fontSizeSub"),
      `<div class="stepper" data-stepper>` +
        `<button data-step="-1" aria-label="${t("settings.smaller")}">−</button>` +
        `<span>${state.fontSize} px</span>` +
        `<button data-step="1" aria-label="${t("settings.larger")}">+</button></div>`,
    ) +
    formRow(t("settings.measure"), t("settings.measureSub"), measureSeg) +
    formRow(
      t("settings.reduceMotion"),
      t("settings.reduceMotionSub"),
      `<button class="switch${state.reduceMotion ? " on" : ""}" data-toggle="motion" aria-label="${t("settings.reduceMotion")}"></button>`,
    ) +
    `<div class="section-head">${t("settings.section.engines")}</div>` +
    `<div class="form-row"><span class="badge mermaid">mermaid</span>` +
    `<div class="grow form-sub" style="margin:0">${t("settings.mermaidSub")}</div>` +
    `<span class="state-ok">${t("settings.bundled")}</span></div>` +
    `<div class="form-row"><span class="badge dot">dot</span>` +
    `<div class="grow form-sub" style="margin:0">${t("settings.dotSub")}</div>` +
    `<span class="state-ok">${t("settings.bundled")}</span></div>` +
    `<div class="form-row hot"><span class="badge d2">d2</span>` +
    `<div class="grow">${d2State === "ready" ? t("settings.installed") : t("settings.notInstalled")}` +
    `<div class="form-sub">${t("settings.d2Cost")}</div></div>${d2Control}</div>` +
    `<div class="section-head">${t("settings.section.files")}</div>` +
    formRow(t("settings.watchDebounce"), t("settings.watchDebounceSub"), `<span class="state-off">120 ms</span>`) +
    `<div class="section-head">${t("settings.section.cache")}</div>` +
    formRow(
      t("settings.cacheSvg"),
      t("settings.cacheSub"),
      `${cache.bytes ? `<span class="state-off">${bytes(cache.bytes)}</span>` : `<span class="state-off">${t("settings.empty")}</span>`}` +
        `<button class="ghost-btn" id="clearCache"${cache.bytes ? "" : ' aria-disabled="true"'}>${t("settings.clear")}</button>`,
    );

  wireControls();
}

function wireControls(): void {
  const body = $("#setBody");

  $$('[data-set="theme"] button', body).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const value = button.dataset.val;
      if (value === "system" || value === "light" || value === "dark") {
        state.theme = value;
        hooks?.onThemeChange();
        hooks?.onSave();
        render();
      }
    });
  });

  $$('[data-set="lang"] button', body).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const value = button.dataset.val;
      if (value === "system" || value === "en" || value === "zh-CN") {
        state.lang = value;
        // The hook re-renders every surface, this sheet included — re-rendering here too would
        // build the body twice for nothing.
        hooks?.onLangChange();
        hooks?.onSave();
      }
    });
  });

  $$('[data-set="measure"] button', body).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const value = button.dataset.val;
      if (isMeasure(value)) {
        state.measure = value;
        hooks?.onMeasureChange();
        hooks?.onSave();
        render();
      }
    });
  });

  $$('[data-stepper] button', body).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.fontSize = Math.min(22, Math.max(12, state.fontSize + Number(button.dataset.step)));
      hooks?.onFontSizeChange();
      hooks?.onSave();
      render();
    });
  });

  $$("[data-toggle]", body).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.reduceMotion = !state.reduceMotion;
      hooks?.onMotionChange();
      hooks?.onSave();
      render();
    });
  });

  // The install button exists so the row is honest about what is possible; the download itself
  // is not implemented (SPEC §4 leaves it opt-in and unbundled). Clicking it says so plainly
  // instead of silently doing nothing.
  maybe$<HTMLButtonElement>("#d2Install")?.addEventListener("click", (event) => {
    event.stopPropagation();
    toast(t("toast.d2"), "warn");
  });

  maybe$<HTMLButtonElement>("#clearCache")?.addEventListener("click", (event) => {
    event.stopPropagation();
    clearCache();
    toast(t("toast.cacheCleared"), "ok");
    render();
  });
}

export function wire(settingsHooks: SettingsHooks): void {
  hooks = settingsHooks;
  $("#openSettings").addEventListener("click", open);
  $("#setClose").addEventListener("click", close);
  $("#settingsOverlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) close();
  });
}
