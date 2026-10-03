**English** · [简体中文](README.zh-CN.md)

# MarkdownAura

A Markdown **reader** for Windows — built for reading well, not for editing.

- Three views — preview / split / source — one click apart, with a draggable split
- Diagrams render **locally**: mermaid, graphviz (dot) and d2 all ship inside the app, with no network at runtime and no telemetry
- Close it and open it again: tabs, scroll positions, folder, window size and every setting come back

---

## Why use it

**It is a reader, not an editor.**
The source view is read-only — no caret, no undo, no save, and no unsaved-changes nagging. Sidebar, outline and toolbar fold away on demand, so the vertical space goes to the text.

**All three diagram engines ship inside the app, and nothing goes over the network.**
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
| Tabs | a single click in the tree opens a *preview tab* (italic), a double click pins it; `⋯` lists every tab; `ctrl W` closes one; `+` opens a new one |
| Views | preview / split / source; the splitter drags; each pane keeps its own scroll position |
| Diagrams | mermaid / dot / d2 cards with an engine badge, the first source line as a title and the source line number; `zoom` opens the viewer (wheel to zoom, drag to pan, copy SVG, copy source, `esc` to close) |
| Find | `ctrl F`, match case, a hit counter, next / previous |
| Outline | headings (levels 1–4) and diagrams, click to jump, draggable width |
| Reading | body size 12–22px; three reading widths (narrow 60ch / comfortable 100ch / full); light / dark / follow the system; UI language follows the system (Chinese / English); reduce motion |
| Immersive | `F11` hides every piece of chrome; `esc` or `F11` leaves |
| Help | `F1` — the keyboard map and the licence summary |
| About | version, author, licence, the engines with their sizes, the data folder (openable from there) and a link to the project |
| Settings (an overlay, not a second window) | theme / language / font size / reading width / reduce motion / engine sizes / watch debounce / render-cache size and clear |
| Data | `%APPDATA%\MarkdownAura\session.json`, written atomically (a crash cannot lose the previous session); the render cache is measured in SVG bytes and clears in one click |

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
| Find | `ctrl F`, `enter` / `shift enter`, `esc` | find, next / previous, close |

---

## Install and run

- **Portable**: keep `MarkdownAura.exe` and `WebView2Loader.dll` side by side and double-click the exe. Copying the exe on its own will not start — it needs that DLL.
- **Installer**: `MarkdownAura_0.1.0_x64-setup.exe`. The wizard shows the licence page and puts `LICENSE` and `THIRD-PARTY.md` in the install directory.
- **Requirements**: Windows 10 / 11 (x64) with the WebView2 Runtime (already present on Windows 11 and on Windows 10 with Edge).
- **Sizes**: portable exe ≈ 14.7 MB (plus the 161 KB `WebView2Loader.dll` beside it); installer 11.6 MB.

---

## Build from source

Prerequisites: Node 22+, Rust (MSVC toolchain) and the WebView2 Runtime.

```bash
npm install
npm run dev          # frontend only, in a browser
npm run tauri dev    # the real window
npm run build:prod   # production build: frontend + release binary
npm run typecheck    # TypeScript check
npm run check:prose  # design-constraint check (centred column, relative sizes)
```

---

## UI preview

Open `design/mockup.html` in a browser: no build step, no network, and you can click through the whole interface. It doubles as the design reference.

---

## Licence

MIT — see [`LICENSE`](LICENSE). Third-party components and licences are in [`THIRD-PARTY.md`](THIRD-PARTY.md), generated by `npm run notices` from what the build actually resolves.
