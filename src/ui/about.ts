/* About (SPEC §10) — the fourth panel, same overlay shell as settings and help.
 *
 * A colophon page, not a form: it answers three questions in order — what is this (name, version,
 * licence, the one link that leaves the app, then a sentence and the capabilities as prose), who
 * made it, and where does it keep my data (path, openable). Engine licences sit inside the facts
 * because naming them is part of the licence story, not decoration.
 *
 * Two details are load-bearing:
 *
 *  - The version comes from `package.json` at build time (`__APP_VERSION__`), so it cannot drift
 *    from the release it ships in — the help panel reads the same constant.
 *  - The GitHub line is an `<a>` for semantics and cursor, but its click is intercepted: an `<a>`
 *    inside the webview would try to navigate the webview itself. The URL goes through the opener
 *    plugin, which the capability scopes to that single URL.
 *  - The update row is the **only** network call the app makes, and only when it is clicked: the check
 *    asks for one release asset, and the installer it points at is verified against the public key in
 *    `tauri.conf.json` before anything is written to disk (SPEC §10). Nothing here runs at startup.
 */
import {
  dataDirectory,
  diagReport,
  diagStatus,
  openExternal,
  openLogFolder,
  relaunchApp,
  revealInExplorer,
  saveDiagReport,
  updateCheck,
  updateDownload,
  updateInstall,
  type PreviousRun,
} from "../ipc";
import { t } from "../i18n";
import * as diag from "../diag";
import { $, copyText, toast } from "./dom";
import * as status from "./statusbar";

/** The only external URL in the app, and the only one the capability allows. */
const GITHUB_URL = "https://github.com/westsource/MarkdownAura";

let path = "";
/** The effective log directory and the previous run, read from Rust. The directory can change in
 *  Settings, so it is refreshed rather than read once at boot. */
let logPath = "";
let unclean: PreviousRun | null = null;

type UpdateState = "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "failed";

let updateState: UpdateState = "idle";
let updateText = "";

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The row is a small state machine, and this is the only writer of its three elements — so a progress
 *  event and a language change cannot disagree about what it says. */
function renderUpdate(): void {
  const check = $<HTMLButtonElement>("#aboutUpdateCheck");
  const install = $<HTMLButtonElement>("#aboutUpdateInstall");
  $("#aboutUpdateState").textContent = updateText;
  check.disabled = updateState === "checking" || updateState === "downloading" || updateState === "installing";
  check.textContent = updateState === "checking" ? t("about.checking") : t("about.checkUpdate");
  install.hidden = updateState !== "available";
}

async function runUpdateCheck(): Promise<void> {
  updateState = "checking";
  updateText = "";
  renderUpdate();
  try {
    const found = await updateCheck();
    updateState = found ? "available" : "current";
    updateText = found ? t("about.available", { v: found.version }) : t("about.upToDate", { v: __APP_VERSION__ });
  } catch (err) {
    updateState = "failed";
    updateText = t("about.updateFailed", { msg: message(err) });
  }
  renderUpdate();
}

/** The boot-time check (SPEC §10). Quiet by design: no sheet, no spinner, no failure surfaced — an
 *  offline launch has to look exactly like a launch that found nothing. The status bar is the only
 *  place the answer appears, and clicking its chip opens this sheet with the state already set. */
export async function checkQuietly(): Promise<void> {
  try {
    const found = await updateCheck();
    if (!found) return;
    updateState = "available";
    updateText = t("about.available", { v: found.version });
    status.setUpdateAvailable(found.version);
    if (isOpen()) renderUpdate();
  } catch {
    // Offline, rate-limited, or no release published yet: all the same from here, and all silent.
  }
}

async function runUpdateInstall(): Promise<void> {
  updateState = "downloading";
  updateText = t("about.downloadingUnknown");
  renderUpdate();
  try {
    await updateDownload((percent) => {
      updateText = percent === null ? t("about.downloadingUnknown") : t("about.downloading", { n: percent });
      renderUpdate();
    });
    updateState = "installing";
    updateText = t("about.installing");
    renderUpdate();
    await updateInstall();
    // The installer replaces this process; push whatever the queue still holds before it goes.
    diag.flush();
    await relaunchApp();
  } catch (err) {
    updateState = "failed";
    updateText = t("about.updateFailed", { msg: message(err) });
    renderUpdate();
  }
}

export function isOpen(): boolean {
  return $("#aboutOverlay").classList.contains("on");
}

export function open(): void {
  render();
  $("#aboutOverlay").classList.add("on");
}

export function close(): void {
  $("#aboutOverlay").classList.remove("on");
}

function render(): void {
  $("#aboutVersionChip").textContent = `v${__APP_VERSION__}`;
  $("#aboutDataPath").textContent = path || "—";
  $("#aboutLogPath").textContent = logPath || "—";
  $("#aboutUncleanRow").hidden = unclean === null;
  $("#aboutUnclean").textContent = unclean ? t("about.unclean", { run: unclean.run }) : "";
  $("#aboutGithub").setAttribute("title", t("about.github"));
  renderUpdate();
}

/** Re-reads what Rust knows about the log, including the previous run's cleanliness. Settings calls
 *  this after a directory change; the About sheet shows the same directory, so it must not keep the
 *  stale one. A failure leaves the last known values rather than breaking the sheet. */
export function refreshLogPath(): void {
  void diagStatus()
    .then((found) => {
      logPath = found.logDir;
      unclean = found.previousUnclean;
      if (isOpen()) render();
    })
    .catch(() => {});
}

export function wire(): void {
  $("#openAbout").addEventListener("click", open);
  $("#aboutClose").addEventListener("click", close);
  $("#aboutOverlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) close();
  });

  $("#aboutGithub").addEventListener("click", (event) => {
    event.preventDefault();
    openExternal(GITHUB_URL).catch(() => toast(GITHUB_URL, "warn"));
  });

  $("#aboutReveal").addEventListener("click", () => {
    if (!path) return;
    revealInExplorer(path).catch(() => toast(path, "warn"));
  });

  // The log folder, not a path inside it: the sheet shows a directory and this opens that directory.
  $("#aboutLogOpen").addEventListener("click", () => {
    openLogFolder().catch(() => toast(t("toast.logOpenFailed"), "warn"));
  });

  // Export writes the full report, then reveals the file and says where. Revealing is best-effort:
  // a written report is still worth the toast even if the shell cannot select it.
  $("#aboutExportReport").addEventListener("click", () => {
    void saveDiagReport()
      .then(async (saved) => {
        await revealInExplorer(saved).catch(() => {});
        toast(t("toast.reportSaved", { path: saved }), "ok");
      })
      .catch(() => toast(t("toast.reportFailed"), "warn"));
  });

  $("#aboutCopySummary").addEventListener("click", () => {
    void diagReport()
      .then(async (report) => {
        // The toast follows the write, not the click: WebView2 can refuse the clipboard (it asks, and a
        // refusal is silent), and a reader who is told "copied" has to be able to paste.
        const copied = await copyText(report);
        toast(copied ? t("toast.reportCopied") : t("toast.reportCopyFailed"), copied ? "ok" : "warn");
      })
      .catch(() => toast(t("toast.reportFailed"), "warn"));
  });

  $("#aboutUpdateCheck").addEventListener("click", () => void runUpdateCheck());
  $("#aboutUpdateInstall").addEventListener("click", () => void runUpdateInstall());

  // The chip is created hidden and only the boot check reveals it. Clicking it is the route to the
  // update: the sheet opens showing whatever that check already found.
  $("#stUpdate").addEventListener("click", open);

  // Fetched once at boot: the data path never changes while the app runs, and failing to get it must
  // not stop the sheet from opening — it shows "—" instead. The log path is the same fetch plus the
  // previous-run flag, and Settings can change it, so it has its own refresh.
  void dataDirectory()
    .then((dir) => {
      path = dir;
      if (isOpen()) render();
    })
    .catch(() => {});
  refreshLogPath();
}
