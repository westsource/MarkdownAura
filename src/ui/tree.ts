/* The explorer.
 *
 * The real tree is loaded lazily from disk, unlike the mockup's flat array — but the row markup
 * is the mockup's, including the `--depth` custom property that `components.css` uses for
 * indentation, so the sidebar looks identical.
 *
 * Directories are skipped by Rust (`fs_ops::is_ignored_dir`), not here, so the tree and the
 * watcher's file count can never disagree about what exists.
 */
import { describeError, isMarkdownExt, readDir, type FolderView, type TreeEntry } from "../ipc";
import { t } from "../i18n";
import { $, $$, CHEV_OPEN, CHEV_SHUT, DIR_ICON, esc, FILE_ICON, toast } from "./dom";

interface Node extends TreeEntry {
  depth: number;
  open: boolean;
  children: Node[] | null;
  loading: boolean;
}

let root: Node | null = null;
let pick: (path: string, preview: boolean) => void = () => {};
let activePath: string | null = null;

/** Markdown files only (SPEC §3). Pushed in by `main.ts` rather than read from app state, the same
 *  split as `setActiveFile`: this module renders, `main.ts` decides. */
let markdownOnly = true;

export function setMarkdownOnly(on: boolean): void {
  if (markdownOnly === on) return;
  markdownOnly = on;
  renderTree();
}

const toNode = (entry: TreeEntry, depth: number): Node => ({
  ...entry,
  depth,
  open: false,
  children: null,
  loading: false,
});

export function setPickHandler(handler: (path: string, preview: boolean) => void): void {
  pick = handler;
}

export function setTree(folder: FolderView): void {
  root = {
    name: folder.name,
    path: folder.root,
    isDir: true,
    ext: "",
    depth: 0,
    open: true,
    children: folder.entries.map((entry) => toNode(entry, 1)),
    loading: false,
  };
  renderTree();
}

export function clearTree(): void {
  root = null;
  renderTree();
}

export function setActiveFile(path: string | null): void {
  activePath = path;
  renderTree();
}

/** Rows in display order, honouring collapsed folders and the filter. */
function visibleRows(): Array<{ node: Node; index: number }> {
  const rows: Array<{ node: Node; index: number }> = [];
  if (!root) return rows;

  const filter = $<HTMLInputElement>("#fileFilter").value.trim().toLowerCase();
  const walk = (node: Node) => {
    // Directories are never filtered, by either rule: the tree is read one level at a time, so
    // whether a folder holds markdown is not knowable without opening it (SPEC §3).
    if (!node.isDir) {
      if (markdownOnly && !isMarkdownExt(node.ext)) return;
      if (filter && !node.name.toLowerCase().includes(filter)) return;
    }
    rows.push({ node, index: rows.length });
    if (node.isDir && node.open && node.children) node.children.forEach(walk);
  };

  root.children?.forEach(walk);
  return rows;
}

export function renderTree(): void {
  const container = $("#tree");
  const rows = visibleRows();

  container.innerHTML = rows
    .map(({ node, index }) => {
      const dir = node.isDir;
      const chev = dir
        ? node.open
          ? CHEV_OPEN
          : CHEV_SHUT
        : '<span class="chev"></span>';
      const isActive = !dir && activePath !== null && node.path === activePath;
      return (
        `<div class="tree-row${isActive ? " active" : ""}" style="--depth:${node.depth}"` +
        ` data-i="${index}" data-path="${esc(node.path)}" title="${esc(node.name)}">` +
        `${chev}${dir ? DIR_ICON : FILE_ICON}` +
        `<span style="overflow:hidden;text-overflow:ellipsis;">${esc(node.name)}</span></div>`
      );
    })
    .join("");
  if (rows.length === 0) container.insertAdjacentHTML("beforeend", emptyHint());

  $$(".tree-row", container).forEach((el) => {
    const index = Number(el.dataset.i);
    const node = rows[index]?.node;
    if (!node) return;

    el.addEventListener("click", async () => {
      if (node.isDir) {
        await toggleDir(node);
        return;
      }
      // Single click opens a preview tab; double click pins it (IMPL.md §5 invariant).
      pick(node.path, true);
    });
    el.addEventListener("dblclick", () => {
      if (!node.isDir) pick(node.path, false);
    });
  });
}

async function toggleDir(node: Node): Promise<void> {
  node.open = !node.open;
  if (node.open && node.children === null && !node.loading) {
    node.loading = true;
    try {
      const entries = await readDir(node.path);
      node.children = entries.map((entry) => toNode(entry, node.depth + 1));
    } catch (err) {
      const { message } = describeError(err);
      toast(message, "err");
      node.open = false;
    } finally {
      node.loading = false;
    }
  }
  renderTree();
}

/** Wires the filter box and the funnel that reveals it. The box is hidden by default so the tree is just
 *  a tree; hiding it again **clears** the filter, because a filtered tree whose control is invisible is a
 *  state the reader can neither see nor undo (SPEC §3). The reveal itself is not persisted — it is a
 *  transient control, not a preference. */
export function wireFilter(): void {
  const input = $<HTMLInputElement>("#fileFilter");
  const row = input.closest<HTMLElement>(".sidebar-search");
  const toggle = $<HTMLButtonElement>("#filterToggle");

  const show = (on: boolean): void => {
    if (row) row.hidden = !on;
    toggle.setAttribute("aria-expanded", String(on));
    if (on) {
      input.focus();
    } else if (input.value !== "") {
      input.value = "";
      renderTree();
    }
  };

  input.addEventListener("input", renderTree);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") show(false);
  });
  toggle.addEventListener("click", () => show(row?.hidden ?? false));
}

/** One muted line when the tree has nothing to show — and the message depends on *why*, because "the
 *  filter matched nothing" and "this folder has no markdown" are different situations. A folder that
 *  is simply empty still shows nothing, which is what it did before the toggle existed. */
function emptyHint(): string {
  if (!root) return "";
  if ($<HTMLInputElement>("#fileFilter").value.trim() !== "") {
    return `<div class="tree-hint">${esc(t("sidebar.noMatches"))}</div>`;
  }
  if (markdownOnly) return `<div class="tree-hint">${esc(t("sidebar.noMarkdown"))}</div>`;
  return "";
}
