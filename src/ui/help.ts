/* Help (F1) — two columns (SPEC §10).
 *
 * The left column is generated from the key table, which is also the single place the shortcut
 * list lives. Labels are *keys* into the i18n catalogue, not strings, so a language change only
 * needs a re-render (SPEC §7).
 *
 * The right column shows one snippet per engine; the d2 card carries the install note because
 * that is the one engine a reader might reasonably expect to work out of the box and find
 * missing.
 */
import type { Key } from "../i18n";
import { t } from "../i18n";
import { $, esc } from "./dom";

export interface KeyEntry {
  group: "file" | "view" | "find";
  keys: string;
  label: Key;
}

/** The shortcut table as data. Keep in step with the dispatcher in main.ts (SPEC §7). */
export const KEYMAP: KeyEntry[] = [
  { group: "file", keys: "ctrl O", label: "help.key.openFile" },
  { group: "file", keys: "ctrl shift O", label: "help.key.openFolder" },
  { group: "file", keys: "ctrl shift P", label: "help.key.recent" },
  { group: "file", keys: "ctrl shift A", label: "help.key.listTabs" },
  { group: "file", keys: "ctrl W", label: "help.key.closeTab" },
  { group: "file", keys: "ctrl tab", label: "help.key.nextTab" },
  { group: "file", keys: "ctrl 1-9", label: "help.key.goToTab" },
  { group: "view", keys: "ctrl B", label: "help.key.toggleSidebar" },
  { group: "view", keys: "ctrl alt O", label: "help.key.toggleOutline" },
  { group: "view", keys: "ctrl R", label: "help.key.reRender" },
  { group: "view", keys: "ctrl ,", label: "help.key.settings" },
  { group: "view", keys: "F11", label: "help.key.immersive" },
  { group: "view", keys: "F1", label: "help.key.help" },
  { group: "view", keys: "ctrl 0", label: "help.key.zoomReset" },
  { group: "view", keys: "ctrl +/-", label: "help.key.zoom" },
  { group: "view", keys: "ctrl shift M", label: "help.key.measure" },
  { group: "find", keys: "ctrl F", label: "help.key.find" },
  { group: "find", keys: "enter", label: "help.key.nextMatch" },
  { group: "find", keys: "shift enter", label: "help.key.prevMatch" },
  { group: "find", keys: "esc", label: "help.key.closeFind" },
];

const GROUPS: Array<[KeyEntry["group"], Key]> = [
  ["file", "help.group.file"],
  ["view", "help.group.view"],
  ["find", "help.group.find"],
];

const SYNTAX: Array<{ lang: string; code: string; note: Key }> = [
  {
    lang: "mermaid",
    code: "flowchart LR\n  A[open] --> B[render]",
    note: "help.note.mermaid",
  },
  {
    lang: "dot",
    code: "digraph {\n  rankdir=LR\n  a -> b\n}",
    note: "help.note.dot",
  },
  {
    lang: "d2",
    code: "direction: right\na -> b: label",
    note: "help.note.d2",
  },
];

export function isOpen(): boolean {
  return $("#helpOverlay").classList.contains("on");
}

export function open(): void {
  render();
  $("#helpOverlay").classList.add("on");
}

export function close(): void {
  $("#helpOverlay").classList.remove("on");
}

function render(): void {
  $("#helpVersion").textContent = `MarkdownAura ${__APP_VERSION__}`;

  $("#helpKeys").innerHTML = GROUPS.map(
    ([group, headKey]) =>
      `<div class="section-head">${t(headKey)}</div><div class="keys">` +
      KEYMAP.filter((entry) => entry.group === group)
        .map((entry) => `<kbd>${esc(entry.keys)}</kbd><span>${esc(t(entry.label))}</span>`)
        .join("") +
      `</div>`,
  ).join("");

  $("#helpSyntax").innerHTML =
    `<div class="section-head">${t("help.syntaxHead")}</div><div class="syntax">` +
    SYNTAX.map(
      (s) =>
        `<div><span class="badge ${s.lang}">${s.lang}</span>` +
        `<pre>${esc(s.code)}</pre>` +
        `<p class="note">${esc(t(s.note))}</p></div>`,
    ).join("") +
    `</div>`;
}

export function wire(): void {
  $("#helpClose").addEventListener("click", close);
  $("#helpOverlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) close();
  });
}
