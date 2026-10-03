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
 */
import { dataDirectory, openExternal, revealInExplorer } from "../ipc";
import { t } from "../i18n";
import { $, toast } from "./dom";

/** The only external URL in the app, and the only one the capability allows. */
const GITHUB_URL = "https://github.com/westsource/MarkdownAura";

let path = "";

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

  // Fetched once at boot: the path never changes while the app runs, and failing to get it must not
  // stop the sheet from opening — it shows "—" instead.
  void dataDirectory()
    .then((dir) => {
      path = dir;
      if (isOpen()) render();
    })
    .catch(() => {});
}
