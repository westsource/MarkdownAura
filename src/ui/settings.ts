/* Settings — an overlay sheet, not a second window (SPEC §10).
 *
 * Four sections: reading / files / cache / diagnostics. Every row changes something: a fact nothing can
 * act on belongs in the About sheet (the engines, their licences, their costs) or in the status bar
 * (their live health), not in a settings sheet — which is why the engines section and the watch-debounce
 * read-out are gone.
 *
 * Every control writes to `state` and schedules a session save. Nothing here talks to Rust
 * directly except the cache row, which reports what the render cache currently holds.
 *
 * All copy comes from the i18n catalogue at render time, so a language change just re-renders
 * this sheet (main.ts applyLang) — there is nothing cached in this module.
 */
import { stats as cacheStats, clear as clearCache } from "../render/cache";
import { state } from "../state";
import { isLogLevel, type Lang, type LogLevel, type ThemeChoice } from "../ipc";
import { t, type Key } from "../i18n";
import { MEASURE_ORDER, isMeasure, measureName } from "../measure";
import { setLevel } from "../diag";
import { $, $$, esc, maybe$, middleEllipsis, toast } from "./dom";
import {
  defaultAppStatus,
  diagStatus,
  pickDirectory,
  setDefaultApp,
  setLogDir,
  type DefaultAppStatus,
} from "../ipc";

export interface SettingsHooks {
  onThemeChange: () => void;
  onFontSizeChange: () => void;
  onMeasureChange: () => void;
  onMotionChange: () => void;
  /** Math changes the *rendered HTML*, not a style, so the app has to re-render what is on screen
   *  (SPEC §13) — this is not the same hook shape as `onMotionChange`. */
  onMathChange: () => void;
  onLangChange: () => void;
  /** The log directory moved; the About sheet shows it too, so it has to re-read it. */
  onLogDirChange: () => void;
  onSave: () => void;
}

let hooks: SettingsHooks | null = null;

/** Cached so `render` can stay synchronous. Refreshed when the sheet is wired and after a change.
 *  Asking also consumes the installer's one-shot marker, which is why the offer is toasted here. */
let defaultApp: DefaultAppStatus | null = null;

/** The log directory in effect. Rust resolves the stored `""` (the "use the default" setting) to a
 *  real path, so the row shows what the command returned rather than what `state` holds. */
let logDir = "";

function refreshLogDir(): void {
  void diagStatus()
    .then((status) => {
      logDir = status.logDir;
      if (isOpen()) render();
    })
    .catch(() => {});
}

function refreshDefaultApp(): void {
  void defaultAppStatus().then((status) => {
    defaultApp = status;
    if (status.offer) toast(t("toast.defaultAppOffer"), "warn");
    if (isOpen()) render();
  });
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

/** The five levels Rust and `diag.ts` share, in the order the control shows them. */
const LOG_LEVELS: LogLevel[] = ["off", "error", "warn", "info", "debug"];

const LEVEL_KEY: Record<LogLevel, Key> = {
  off: "settings.level.off",
  error: "settings.level.error",
  warn: "settings.level.warn",
  info: "settings.level.info",
  debug: "settings.level.debug",
};

/** Persists a new log directory through the session and the running process. The effective path
 *  comes back from Rust, so a configured directory it could not create shows the fallback it used. */
async function applyLogDir(dir: string): Promise<void> {
  try {
    const effective = await setLogDir(dir);
    state.logDir = dir;
    logDir = effective;
    toast(t("toast.logDirChanged", { path: effective }), "ok");
    hooks?.onSave();
    hooks?.onLogDirChange();
    render();
  } catch {
    toast(t("toast.logDirFailed"), "warn");
  }
}

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
      t("settings.math"),
      t("settings.mathSub"),
      `<button class="switch${state.math ? " on" : ""}" data-toggle="math" aria-label="${t("settings.math")}"></button>`,
    ) +
    formRow(
      t("settings.reduceMotion"),
      t("settings.reduceMotionSub"),
      `<button class="switch${state.reduceMotion ? " on" : ""}" data-toggle="motion" aria-label="${t("settings.reduceMotion")}"></button>`,
    ) +
    `<div class="section-head">${t("settings.section.files")}</div>` +
    formRow(
      t("settings.defaultApp"),
      defaultApp?.isDefault
        ? t("settings.defaultAppIs", { name: defaultApp.current })
        : t("settings.defaultAppSub"),
      defaultApp?.isDefault
        ? `<span class="state-ok">${esc(defaultApp.current)}</span>`
        : `<span class="state-off">${esc(defaultApp?.current || t("settings.defaultAppNone"))}</span>` +
          `<button class="ghost-btn" id="setDefaultApp">${t(defaultApp?.action === "dialog" ? "settings.defaultAppChoose" : "settings.defaultAppSet")}</button>`,
    ) +
    `<div class="section-head">${t("settings.section.cache")}</div>` +
    formRow(
      t("settings.cacheSvg"),
      t("settings.cacheSub"),
      `${cache.bytes ? `<span class="state-off">${bytes(cache.bytes)}</span>` : `<span class="state-off">${t("settings.empty")}</span>`}` +
        `<button class="ghost-btn" id="clearCache"${cache.bytes ? "" : ' aria-disabled="true"'}>${t("settings.clear")}</button>`,
    ) +
    // Diagnostics last: it is the one section that exists for a problem, not for reading (IMPL §13.8).
    `<div class="section-head">${t("settings.section.diagnostics")}</div>` +
    formRow(
      t("settings.logLevel"),
      t("settings.logLevelSub"),
      segment("logLevel", LOG_LEVELS.map((id) => [id, t(LEVEL_KEY[id])]), state.logLevel),
    ) +
    formRow(
      t("settings.logDir"),
      t("settings.logDirSub"),
      // One flex line of its own: the path is what gives way (it wraps inside itself), the buttons
      // never do — a button whose label breaks across two lines is always a bug (components.css).
      // A 560px row cannot show a 45-character path and two buttons side by side, so the path is shown
      // middle-shortened: head and leaf are the parts that identify it, and `title` carries the whole
      // value (About prints it in full, and so does the exported report).
      `<div class="form-ctl"><span class="about-path" title="${esc(logDir || "")}">${esc(middleEllipsis(logDir || "—", 36))}</span>` +
        `<button class="ghost-btn" id="changeLogDir">${t("settings.logDirChange")}</button>` +
        `<button class="ghost-btn" id="resetLogDir">${t("settings.logDirReset")}</button></div>`,
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
      // Each row names what it toggles. One switch per row, and no shared handler guessing which
      // setting was meant — the row added next only has to add a case.
      switch (button.dataset.toggle) {
        case "motion":
          state.reduceMotion = !state.reduceMotion;
          hooks?.onMotionChange();
          break;
        case "math":
          state.math = !state.math;
          hooks?.onMathChange();
          break;
        default:
          return;
      }
      hooks?.onSave();
      render();
    });
  });

  $$('[data-set="logLevel"] button', body).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const value = button.dataset.val;
      if (isLogLevel(value)) {
        state.logLevel = value;
        // The running logger changes now; the session save carries it to the next launch.
        setLevel(value);
        hooks?.onSave();
        render();
      }
    });
  });

  maybe$<HTMLButtonElement>("#changeLogDir")?.addEventListener("click", (event) => {
    event.stopPropagation();
    void pickDirectory("Open folder")
      .then((picked) => {
        // Null is the cancelled dialog; leaving the setting alone is the only sane answer.
        if (picked) void applyLogDir(picked);
      })
      .catch(() => {});
  });

  maybe$<HTMLButtonElement>("#resetLogDir")?.addEventListener("click", (event) => {
    event.stopPropagation();
    // Empty is the wire's "platform default"; Rust answers with the path that resolves to.
    void applyLogDir("");
  });

  maybe$<HTMLButtonElement>("#clearCache")?.addEventListener("click", (event) => {
    event.stopPropagation();
    clearCache();
    toast(t("toast.cacheCleared"), "ok");
    render();
  });

  maybe$<HTMLButtonElement>("#setDefaultApp")?.addEventListener("click", (event) => {
    event.stopPropagation();
    // The open document is what the Windows *Open with* dialog acts on; Linux ignores it.
    const path = state.tabs[state.activeTab]?.file ?? null;
    void setDefaultApp(path)
      .then((outcome) => {
        toast(
          outcome === "dialog"
            ? t("toast.defaultAppDialog")
            : outcome === "settings"
              ? t("toast.defaultAppSettings")
              : t("toast.defaultAppSet"),
          "ok",
        );
        refreshDefaultApp();
      })
      .catch(() => toast(t("toast.defaultAppFailed"), "warn"));
  });
}

export function wire(settingsHooks: SettingsHooks): void {
  hooks = settingsHooks;
  refreshDefaultApp();
  refreshLogDir();
  $("#openSettings").addEventListener("click", open);
  $("#setClose").addEventListener("click", close);
  $("#settingsOverlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) close();
  });
}
