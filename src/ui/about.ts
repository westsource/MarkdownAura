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
  openExternal,
  relaunchApp,
  revealInExplorer,
  updateCheck,
  updateDownload,
  updateInstall,
} from "../ipc";
import { t } from "../i18n";
import { $, toast } from "./dom";
import * as status from "./statusbar";

/** The only external URL in the app, and the only one the capability allows. */
const GITHUB_URL = "https://github.com/westsource/MarkdownAura";

let path = "";

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
  $("#aboutGithub").setAttribute("title", t("about.github"));
  renderUpdate();
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

  $("#aboutUpdateCheck").addEventListener("click", () => void runUpdateCheck());
  $("#aboutUpdateInstall").addEventListener("click", () => void runUpdateInstall());

  // The chip is created hidden and only the boot check reveals it. Clicking it is the route to the
  // update: the sheet opens showing whatever that check already found.
  $("#stUpdate").addEventListener("click", open);

  // Fetched once at boot: the path never changes while the app runs, and failing to get it must not
  // stop the sheet from opening — it shows "—" instead.
  void dataDirectory()
    .then((dir) => {
      path = dir;
      if (isOpen()) render();
    })
    .catch(() => {});
}
