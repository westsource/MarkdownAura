**English** · [简体中文](README.zh-CN.md)

# MarkdownAura

**A Markdown reader for Windows and Linux — read-only by default, editable on request.**

![MarkdownAura: a document open in the preview view, with the explorer, the outline and the status bar](assets/readme-preview.png)

- Three views — preview / split / source — one click apart, with a draggable split
- Diagrams render **locally**: mermaid, graphviz (dot) and d2 all ship inside the app — drawing a diagram needs no network, and no telemetry is collected
- Close it and open it again: tabs, scroll positions, folder, window size and every setting come back

---

## Why use it

**It is a reader first, and an editor when you ask.**
The source view opens read-only — no caret, no undo, no save, and no unsaved-changes nagging — and stays that way until you enter the editor with `ctrl E`, or by clicking the `read-only` pill, which then reads `editing`. The mode belongs to one tab and is never restored, so a session always comes back read-only. Saving (`ctrl S`) writes the file back in its own encoding and with its own line endings, and refuses rather than damages anything it cannot round-trip faithfully. Sidebar, outline and toolbar fold away on demand, so the vertical space goes to the text.

**All three diagram engines ship inside the app, so drawing a diagram needs no network. The one thing the app does fetch by itself is the update manifest at launch** — a version number and a download URL, and nothing about you (the About sheet says the same).
`mermaid`, `dot` / `graphviz` and `d2` render locally: there is no remote service to call and no engine to install first. When an engine fails, the error lands inside the diagram card with the source line number — it never blanks the page.

**Big files and odd encodings do not get in the way.**
A single file is read up to 8 MiB, and anything past that is marked "truncated" rather than quietly dropped. UTF-8, UTF-8 BOM, UTF-16LE and UTF-16BE are detected, and LF / CRLF is reported in the status bar.

**Every tab remembers its own state.**
View mode, scroll position, the find query and the hit you were on are kept per tab, so switching back does not re-render.

**Session restore means "it came back", not "it started over".**
The next launch restores the tabs (preview tab included), the folder you had open, window geometry, theme, font size, zoom, reading width and both panel widths. A file that is temporarily missing is struck through, not dropped.

**Chinese text gets real weight.**
Headings and bold use 600 rather than 500: `Microsoft YaHei UI` has only Regular and Bold, so a request for 500 is matched down to Regular and a Chinese heading looks un-bolded.

**One size base for everything.**
Body text, headings, code, tables and the source pane are all relative to "font-size setting × zoom", so changing either moves the whole document together — a heading can never end up smaller than the body it introduces, and the source pane never disagrees with the preview.

**Installing needs no network.**
The installer carries the WebView2 loader. It only fetches the WebView2 Runtime on a machine that does not have it (Windows 11 and Windows 10 with Edge already do).

---

## Features

| Area | What it does |
|---|---|
| Explorer | open a folder; drag its width (180–640px); an **md only** switch (on by default); filter by file name, revealed from the foot row on demand; directories always listed; ignored directories are dot-prefixed names plus `node_modules`, `target`, `dist`; the foot shows `watching N files` |
| Open with | the app registers itself as the handler for Markdown files — the Windows installer and both Linux packages — so a file manager's *open with* passes the path in; a second launch hands it to the window that is already open instead of opening another |
| Tabs | a single click in the tree opens a *preview tab* (italic), a double click pins it; `⋯` lists every tab; `ctrl W` closes one |
| Views | preview / split / source; the splitter drags; the split panes scroll in sync, and the position is kept per tab |
| Editing | `ctrl E` (or the `read-only` pill) puts a caret in the source pane of that tab, per tab and never restored; in split view the preview follows what you type; `ctrl S` saves — back in the file's own encoding and line endings, atomically, with its permissions — and the status bar's `unsaved` mark is also the save button; a file that changed on disk, is read-only, has mixed line endings, or is not valid UTF-8 is refused rather than damaged. CodeMirror 6 loads on demand |
| Diagrams | mermaid / dot / d2 cards with an engine badge, the first source line as a title and the source line number; `zoom` opens the viewer (wheel to zoom, drag to pan, copy SVG, copy source, `esc` to close) |
| Find | `ctrl F`, match case, a hit counter, next / previous |
| Outline | headings (levels 1–4) and diagrams, click to jump, draggable width |
| Reading | body size 12–22px; three reading widths (narrow 60ch / comfortable 100ch / full); light / dark / follow the system; UI language follows the system (Chinese / English); reduce motion |
| Immersive | `F11` hides every piece of chrome; `esc` or `F11` leaves |
| Help | `F1` — the keyboard map plus a diagram-syntax card for each engine |
| About | version, author, licence, the three diagram engines plus the editor, each with its licence and (where the UI shows one) its size, the data folder (openable from there), a link to the project, and a **check for updates** row. That row also runs by itself at launch: it fetches one small manifest (a version and a download URL) and, when something is newer, the status bar grows a chip that opens this sheet — nothing about you is sent either way |
| Settings (an overlay, not a second window) | theme / language / font size / reading width / reduce motion / default app / engine sizes / watch debounce / render-cache size and clear |
| Data | `%APPDATA%\MarkdownAura\session.json` on Windows, `~/.config/MarkdownAura/session.json` on Linux, written atomically (a crash cannot lose the previous session); the render cache is measured in SVG bytes and clears in one click |

Raw HTML: only a short fixed list of tags is allowed through (`details`, `summary`, `kbd`, `sub`, `sup`, `br`, `hr`) and everything else is dropped — what a document contains cannot touch the app's own interface.

---

## Diagram engines

| Engine | Fence label | Licence | Shipped size |
|---|---|---|---|
| mermaid | `mermaid` | MIT | 29 KB entry + chunks on demand (5.18 MB on disk; only the diagram types you use are loaded) |
| graphviz | `dot`, `graphviz` | Apache-2.0 | ~0.9 MB (wasm inlined in the JS) |
| d2 | `d2` | MPL-2.0 | 11.5 MB (wasm inlined in the JS) |

All three run inside the application, so no document needs a network connection.

---

## Keyboard

| Group | Keys | Action |
|---|---|---|
| File | `ctrl O` / `ctrl shift O` | open file / open folder |
| File | `ctrl shift P` / `ctrl shift A` | recent files / list tabs |
| File | `ctrl W` / `ctrl tab` / `ctrl 1-9` | close / next / jump to tab |
| View | `ctrl B` / `ctrl alt O` | sidebar / outline |
| View | `ctrl R` | re-render the current document |
| View | `ctrl ,` / `F1` | settings / help |
| View | `F11` | immersive mode |
| View | `ctrl +` `ctrl -` / `ctrl 0` | zoom / reset zoom |
| View | `ctrl shift M` | cycle the reading width |
| File | `ctrl E` / `ctrl S` | edit this tab's source in place / save it |
| Find | `ctrl F`, `enter` / `shift enter`, `esc` | find, next / previous, close |

---

## Install and run

- **Portable (zip)**: `MarkdownAura-<version>-portable.zip` holds `markdownaura.exe` together with the `WebView2Loader.dll` it needs. Unzip it anywhere and double-click the exe; the exe on its own will not start. There is no single-file edition any more — it was dropped in 0.1.2, because the launcher it needed was a second updater of its own and earned nothing the zip does not.
- **Installer**: `MarkdownAura_<version>_x64-setup.exe`. The wizard shows the licence page and puts `LICENSE` and `THIRD-PARTY.md` in the install directory. This is also the update path: when a newer release exists the status bar shows a chip, and clicking it opens the About sheet, whose **check for updates** row downloads the next signed installer from the GitHub release and runs it. A portable copy that updates this way becomes a proper installation; staying portable means downloading the new zip by hand.
- **Linux (x86-64)**: `MarkdownAura_<version>_amd64.deb` installs with `sudo apt install ./MarkdownAura_<version>_amd64.deb` and pulls WebKitGTK 4.1 in as a dependency; `MarkdownAura_<version>_amd64.AppImage` needs nothing installed, because it carries the toolkit inside itself — which is the whole of the size difference between them. Both register the app as a handler for Markdown files. The deb is the package manager's to update; the AppImage is what the in-app updater replaces.
- **Requirements**: Windows 10 / 11 (x64) with the WebView2 Runtime (already present on Windows 11 and on Windows 10 with Edge); Linux (x86-64), where the deb needs WebKitGTK 4.1 and the AppImage needs nothing.
- **Sizes**: portable zip ≈ 12.3 MB; installer 12.0 MB; deb ≈ 12.8 MB; AppImage ≈ 88 MB (it bundles WebKitGTK).

---

## Build from source

Prerequisites: Node 22+, a Rust toolchain targeting `x86_64-pc-windows-gnu`, and the WebView2 Runtime. The GNU build leans on the binutils shim in `tools/unpack-binutils.mjs` and the `gcc` stand-in in `tools/rc-preprocessor.rs`; read `design/IMPL.md` §1 before touching the toolchain. On Linux: Node 22+, a Rust toolchain, and the WebKitGTK 4.1 / GTK 3 development packages (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `libssl-dev`); `npx tauri build --bundles deb,appimage` produces both artifacts.

```bash
npm install
npm run dev            # frontend only, in a browser
npm run tauri dev      # the real window
npm run build:prod     # production build: frontend + release binary
npm run typecheck      # TypeScript check
npm run check:prose    # design-constraint check (centred column, relative sizes)
npm run check:rawhtml  # asserts the mockup honours the raw-HTML allow-list
npm run notices        # regenerates THIRD-PARTY.md from the real dependency tree
```

`build:prod` stops at `dist/` and the release binary. The installer, the portable zip and `latest.json` are a separate signed step — `design/IMPL.md` §12.

---

## Screenshots

Captured from the real app at 1280 × 800, with the document in [`examples/showcase.md`](examples/showcase.md) open — one file that uses every block type the renderer handles, and all three diagram engines.

![The editor open in split view: line numbers and syntax colours on the left, the rendered document following on the right, the tab carrying the unsaved mark](assets/readme-editing.png)

|  |  |
|---|---|
| <img src="assets/readme-diagrams.png" width="440" alt="a document section showing mermaid, graphviz and d2 cards"> | <img src="assets/readme-split.png" width="440" alt="split view: highlighted source on the left, rendered document on the right"> |
| All three engines in one document — each card carries its engine badge, the diagram's first source line and the line number. | Source and preview side by side — the splitter drags, and the two panes scroll in sync. |
| <img src="assets/readme-viewer.png" width="440" alt="the d2 architecture diagram open in the viewer"> | <img src="assets/readme-dark.png" width="440" alt="the same document in dark theme"> |
| The diagram viewer — wheel to zoom, drag to pan, copy the SVG or the source, `esc` to close. | Dark theme — light, dark, or follow the system; the whole interface moves together. |

The design reference is [`design/mockup.html`](design/mockup.html): open it in a browser — no build step, no network — and click through the whole interface.

---

## Licence

MIT — see [`LICENSE`](LICENSE). Third-party components and licences are in [`THIRD-PARTY.md`](THIRD-PARTY.md), generated by `npm run notices` from what the build actually resolves.
