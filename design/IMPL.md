# MarkdownAura — implementation contract

`SPEC.md` says what the interface is. This file says **what to build**, so the skeleton is
filling in blanks rather than making decisions. Where a choice was genuinely architectural it was
marked **[sign-off wanted]** and the reasoning given — none are open: every architectural call in
here is decided and dated. Reopen one only with a reason, not a preference.

Measured facts live in SPEC §4 (engine sizes). Read that before touching packaging.

Revised 2026-10-02 against the shipped code: the command surface, state shape, session
fields, CSP, window creation and engine APIs below are what the code does, not what an
earlier draft expected it to do. Where the code does not yet do what this contract says,
the gap is marked **not implemented** rather than described as if it existed.

---

## 1. Build and stack

| layer | choice | why |
|---|---|---|
| shell | Tauri 2 (`2.12.1`), WebView2 | given |
| external links | `tauri-plugin-opener` `2`, capability-scoped | the About sheet's GitHub line is the only URL the app opens; the plugin beats shelling out to `cmd /C start`, and the scope is what makes "only that URL" true |
| frontend | **vanilla TypeScript + Vite 6** | No framework runtime. The mockup's logic (`design/mockup.js`) ports almost line for line, and the app's UI is a handful of panes plus a tab strip — a virtual DOM earns nothing and costs 40–150 KB. |
| markdown | **Rust side, `pulldown-cmark` 0.13.4** | decided 2026-10-01, see §4 |
| watching | `notify` 8 | coalesced in our own thread, see §3 |
| styling | `design/*.css`, imported directly | the design files stay the single source of truth; never fork them into `src/` |

`design/` is not build output and not a scratch directory — it is the spec. Vite gets an alias so
the app imports `@design/tokens.css` rather than a copy (plus an `@ -> src` alias).

### Build commands (they are not interchangeable)

- `npm run dev` — Vite only.
- `npm run build` — `tsc --noEmit` then `vite build` into `dist/`.
- `npm run build:prod` — `npm run build` then `build:prod:rust`.
- `npm run build:prod:rust` — `cargo build --release -j 1 --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol`.
- `npm run notices` — regenerates `THIRD-PARTY.md`. Run it whenever a dependency changes; nothing
  else keeps that file true.

Both flags on that line are load-bearing:

- **`--features tauri/custom-protocol`.** `cargo build --release` on its own produces a
  *dev* binary: Tauri's build script keys `DEP_TAURI_DEV` off the feature, and only the
  official `tauri build` CLI adds it. The symptom is a release binary that still loads
  `http://127.0.0.1:1420` and shows `chrome-error` when no dev server is running.
  Check with `grep rustc-cfg target/release/build/markdownaura-*/output | grep dev`.
- **`-j 1`.** On this GNU target, concurrent `dlltool` runs collide writing the
  `kernel32.dll_imports.*` temp files and fail with `Permission denied`; serialising fixes
  it. It is slow and it is a one-time cost.

Measured: the release binary is 15.28 MiB (debug is 173 MB). Chunk resolution over the
`tauri://` asset protocol was verified in the release build, not only in dev.

### Repo layout

```
MarkdownAura/
├─ LICENSE                     # MIT, copyright 道荣（黄超） — the About sheet's chip without it is
│                              # a declaration, not a grant
├─ THIRD-PARTY.md              # generated notices: engines, frontend packages, shipping Rust crates
├─ design/                     # spec: tokens.css, components.css, prose.css, SPEC.md, IMPL.md
│  ├─ mockup.html / mockup.js  # interactive reference + behaviour spec
│  ├─ check-raw-html.mjs       # asserts the mockup honours §4's allow-list
│  └─ check-prose-css.mjs      # asserts the reading column stays centred and its sizes stay relative (§5)
├─ tools/
│  ├─ make-icons.mjs           # regenerates src-tauri/icons from one geometry description
│  ├─ make-notices.mjs         # regenerates THIRD-PARTY.md from cargo metadata + node_modules
│  ├─ make-latest-json.mjs     # writes var/release/latest.json and stages the release assets (§12)
│  ├─ unpack-binutils.mjs      # Windows/GNU only; see the note below
│  └─ rc-preprocessor.rs       # Windows/GNU only; a no-op `gcc` for windres, see below
├─ index.html                  # shell markup, mirrors design/mockup.html
├─ vite.config.ts              # `@design` alias — design/*.css is imported, never copied
├─ src-tauri/
│  ├─ Cargo.toml               # crate-type = ["rlib"], and why — see the note below
│  ├─ build.rs                 # tauri-build + the test-target link-arg repair
│  ├─ tauri.conf.json          # CSP, asset protocol, bundle; `windows: []` on purpose (§8)
│  ├─ capabilities/default.json
│  └─ src/
│     ├─ main.rs               # entry; keeps the console in debug builds
│     ├─ lib.rs                # CLI parse, single-instance, window build, state, handler wiring
│     ├─ commands.rs           # the invoke surface (§3)
│     ├─ error.rs              # ApiError, the tagged enum that crosses the boundary
│     ├─ fs_ops.rs             # tree walk, read, encoding, ignore rules
│     ├─ markdown.rs           # pulldown-cmark -> html + headings + diagram blocks (§4)
│     ├─ watcher.rs            # notify -> coalesced 120 ms batches
│     ├─ session.rs            # persistence (§6)
│     └─ engines.rs            # engine availability for the status bar dots (§7)
├─ src/                        # frontend
│  ├─ main.ts                  # boot, theming, layout, keyboard, session
│  ├─ i18n.ts                  # en + zh-CN catalogues, t(), data-i18n scanner
│  ├─ env.d.ts                 # build-time constants declared once (__APP_VERSION__)
│  ├─ measure.ts               # reading-width presets (record + guard + token writer)
│  ├─ ipc.ts                   # typed wrappers over invoke/listen (the only place invoke appears)
│  ├─ state.ts                 # tab record + window state (§5)
│  ├─ ui/
│  │  ├─ dom.ts                # $, maybe$, esc, toast, menus, shared icons
│  │  ├─ document.ts           # the three views, splitter, source highlight, scroll spy
│  │  ├─ panels.ts             # side-panel resize handles -> --w-sidebar / --w-outline
│  │  ├─ tabs.ts  tree.ts  outline.ts  statusbar.ts
│  │  └─ find.ts  viewer.ts  settings.ts  help.ts  about.ts  immersive.ts
│  └─ render/
│     ├─ types.ts              # EngineId + isEngineId
│     ├─ pipeline.ts           # markdown html -> DOM -> cards -> engines
│     ├─ engines.ts            # registry: state machine + lazy import
│     └─ cache.ts              # (engine, source hash) -> svg, capped in bytes
└─ var/                        # local verification scratch (gitignored): fixtures, CDP probes, shots
```

`vendor/d2/` from the earlier draft **does not exist and is not needed**: d2 is a bundled npm
dependency (`@d2lang/d2`), not something vendored into the tree (§7).

The six overlay modules (find, viewer, settings, help, about, immersive) are implemented and wired
in `main.ts`. One of them deliberately stops short of a full feature: `ctrl shift P` shows the recent
list as a menu rather than a picker. The settings panel used to have a second one — a d2 install
button that reported the unimplemented download — and that row is gone now that d2 is bundled. The
`index.html` shell carries the markup for all six.

Three things in `src-tauri/` are repairs for this machine and must not be "cleaned up":

- `tools/unpack-binutils.mjs` — the GNU Rust toolchain on Windows is a linker-only shim
  with no assembler, and `dlltool` cannot run without one. Not part of the build. Its
  extracted exes also need four runtime DLLs (`libintl-8.dll`, `libiconv-2.dll`,
  `libzstd.dll`, `zlib1.dll`) copied beside them in `~/.cargo/bin`; all four are in Git for
  Windows' `mingw64/bin`. Missing them fails the **build script** — `windres ... exit code:
  0xc0000135` from `tauri-winres`, before our code compiles — which is why the check is
  `windres --version` printing a banner, not cargo's error text.
- `tools/rc-preprocessor.rs` — this machine has no C compiler at all, so `windres` cannot
  preprocess the `.rc` `tauri-winres` generates and the build dies with `preprocessing
  failed`. The tool is a byte-copy `gcc`; it is correct because that resource script has no
  `#include`/`#define`, only `#pragma code_page`. Installed as `~/.cargo/bin/gcc.exe`;
  **delete it before installing a real C toolchain.**
- `Cargo.toml`'s `crate-type = ["rlib"]` and the two `indexmap` entries, each explained in
  the file. `cdylib` on this target overflows PE export ordinals (`ordinal too large:
  103647`); `indexmap` with `std` unpins the `schemars 0.8` build (the two entries are
  needed because build- and normal dependencies do not share feature unification under the
  2021 resolver).

One rule that bit during implementation, worth keeping visible: `dom.ts` exports `$` (throws when
the element is missing — it guards the shell) and `maybe$` (returns null — for elements that come
and go with rendered content). `$(sel)?.x` is a trap: the throw happens before `?.` is evaluated.
This was a real bug — a `d2` install button rendered as a `<span>` in the failed state made `$()`
throw and the settings panel silently refused to open.

## 2. Ground rules

1. `design/*.css` is imported, never edited from the app side. If a style is wrong, fix it in
   `design/` so the mockup and the app stay in sync.
2. The frontend never writes to disk directly. All I/O is a `#[tauri::command]`.
3. The backend boundary is `src/ipc.ts`: the only module that calls `invoke`/`listen` or the
   opener/updater/process plugins. Everything else calls a typed function — `openExternal` is the
   opener plugin's `openUrl` behind that boundary, not a second door. `main.ts` is the one
   exception, and only for the shell's own UI: `@tauri-apps/api/window` and `dpi` for the window
   rect and the titlebar buttons, and `plugin-dialog` for open file / open folder. A new *backend*
   call still belongs in `ipc.ts`.
4. Rust holds no UI state. Tab state, theme, zoom, panel widths live in the frontend (§5) and are
   only *persisted* through Rust. Rust state is limited to the startup hint, the watcher and
   the last-read session.
5. No `unwrap()` on anything reachable from a file path. A malformed file must degrade (inline
   error, §4) — never panic the app.
6. Every frontend module that produces markup must reuse the mockup's class names verbatim.
   No compiler checks the two sides; §4's contract guards are the only net.

## 3. IPC surface

### Commands (frontend → Rust)

Fifteen commands, all registered in `lib.rs`. All are `async` — except `startup_target` and
`data_directory`, which are pure reads of state and of a path — and the filesystem-heavy ones
(`open_folder`, `read_dir`, `resolve_target`, `read_file`, `render_doc`,
`reveal_in_explorer`, `session_load`, `session_save`, `engine_status`, `note_recent`) hop
to a blocking thread through one `spawn_blocking` helper, because the §9 budgets assume no
command stalls the UI thread. Two exceptions are deliberate and named so they stay
decisions: the watcher commands do their work inline while holding the watcher mutex
(`watch_set` includes a directory walk for the file count), and `startup_target` is a
synchronous mutex read (`data_directory` is synchronous for the same reason — it just builds a
path).

```rust
// --- tree ---
#[tauri::command] async fn open_folder(app: AppHandle, path: PathBuf) -> Result<FolderView>;
// -> { root, name, entries: TreeEntry[] }   (one level; children load on expand)
//    also widens the asset-protocol scope to `path`: a document in it may reference images beside
//    it, and a document in a subfolder may reach back up to a shared assets folder inside it

#[tauri::command] async fn read_dir(path: PathBuf) -> Result<Vec<TreeEntry>>;
#[tauri::command] async fn resolve_target(app: AppHandle, path: PathBuf) -> Result<FolderView>;
// -> a file resolves to its own folder, a folder to itself. Lives in Rust because
//    `C:\file.md` minus its last segment is `C:`, not `C:\` — don't do this in TypeScript.
//    Widens the scope like `open_folder`: this command adopts a folder too.

#[tauri::command] async fn read_file(path: PathBuf) -> Result<FilePayload>;
#[tauri::command] async fn render_doc(app: AppHandle, path: PathBuf, math: bool) -> Result<RenderedDoc>;
// -> rendering happens in Rust (§4); the frontend never sees raw markdown for the preview
//    view. `encoding` is carried on the render result so the status bar can badge a lossy
//    read without a second round trip for the same file.
//    Widens the scope to the *document's* folder, whatever the tree shows: a document reached
//    from the dialog, the recent list or "Open with" lives wherever it lives, and its images
//    have to load. The app handle is what the scope and `convert_file_src` are reached through.
//    `math` is passed per call rather than read from the stored session (SPEC §13): it is a render
//    *input*, so the same file has two different HTML outputs and turning the setting on re-renders
//    the open documents instead of mutating something the next render silently picks up.
#[tauri::command] async fn reveal_in_explorer(path: PathBuf) -> Result<()>;
// -> the write half (SPEC §12). `save_doc` takes the buffer, the encoding and the EOL the file was
//    read in, and the mtime that load reported; it returns the *new* mtime, which becomes the next
//    save's baseline. It refuses a mixed-ending file, a lossy decode, an unwritable encoding, and any
//    write whose expected mtime no longer matches the disk. A refusal is the feature, not a failure.
#[tauri::command] async fn save_doc(path: PathBuf, text: String, encoding: String, eol: String,
                                   expected_mtime_ms: i64) -> Result<i64>;
// -> a buffer has no file behind it, so the live preview cannot go through `render_doc`. Same
//    `RenderedDoc` shape; `encoding` and `truncated` come back empty because a buffer is neither
//    decoded nor cut, and the caller already holds both facts on the tab. `path` is the document
//    the buffer belongs to: the text is unsaved, but its images are still the file's images.
#[tauri::command] async fn render_text(app: AppHandle, text: String, path: Option<PathBuf>, math: bool)
                                       -> Result<RenderedDoc>;
// -> implemented for Windows (`explorer /select,<path>`) and other platforms (`xdg-open`), but
//    nothing in the UI calls it: the tab menu that would is deferred (SPEC §5).

// --- watching ---
#[tauri::command] async fn watch_set(paths: Vec<PathBuf>) -> Result<WatcherStatus>;
// -> { watching: usize }   replaces the whole watch set; idempotent
#[tauri::command] async fn watch_stop_all() -> Result<()>;
#[tauri::command] async fn watcher_status() -> Result<WatcherStatus>;
// -> neither is called by the UI today. The `watching N files` label is set from `watch_set`'s
//    return value; `watcher_status` exists so a later watcher panel can refresh without
//    re-watching, and `watch_stop_all` so a folder can be released without replacing the set.

// --- session ---
#[tauri::command] async fn session_load() -> Result<Option<Session>>;
#[tauri::command] async fn session_save(session: Session) -> Result<()>;

// --- engines ---
#[tauri::command] async fn engine_status() -> Result<Vec<EngineInfo>>;
// -> { id, version, installed, bytes }[]   feeds the status bar dots (SPEC §3)

// --- boot ---
#[tauri::command] fn startup_target() -> StartupInfo;   // sync; a command, not an event, so a
                                                        // late-mounting frontend cannot miss it
#[tauri::command] async fn note_recent(entry: String) -> Result<Vec<String>>;
// -> pushes onto `recent` in the session file and returns the new list, so the in-memory and
//    on-disk caps cannot drift apart (§6)

#[tauri::command] fn data_directory() -> String;
// -> where the app keeps its state (`%APPDATA%/MarkdownAura`). Sync, like `startup_target`: it is a
//    path computation, not I/O. The About sheet shows it and opens it with `reveal_in_explorer`,
//    which until then had been implemented and unused since the first pass.
```

#[tauri::command] fn default_app_status() -> DefaultAppStatus;
// -> { platform, registered, isDefault, current, action, offer }. `offer` is the installer's one-shot
//    marker, read and cleared, so the first launch after an install can mention it exactly once (§12)
#[tauri::command] async fn set_default_app(path: Option<PathBuf>) -> Result<String>;
// -> Linux runs `xdg-mime default` and answers "set". Windows cannot set it — `UserChoice` is
//    protected — so it opens the *Open with* dialog on `path`, or the Default Apps page when there is
//    no document, and answers "dialog" / "settings". The frontend labels its button from `action`

**Not implemented, and no longer wanted:** `engine_install(id)` and `engine_remove(id)` were
specified in the first draft for the opt-in d2 download. d2 is bundled (SPEC §4), so there is nothing
to install and the only engine command is `engine_status`.

The payload shapes (all `#[serde(rename_all = "camelCase")]`):

```ts
type TreeEntry  = { name: string; path: string; isDir: boolean; ext: string };   // ext lowercased, no dot
type FolderView = { root: string; name: string; entries: TreeEntry[] };
type FilePayload = { text: string; encoding: string; eol: "lf" | "crlf";
                     bytes: number; mtimeMs: number; truncated: boolean };
type Heading = { id: string; level: number; text: string; line: number };
type DiagramBlock = { id: string; lang: "mermaid" | "dot" | "d2"; source: string; line: number };
type FrontmatterField = { key: string; value: string };
type RenderedDoc = { html: string; headings: Heading[]; diagrams: DiagramBlock[];
                     frontmatter: FrontmatterField[]; words: number; lineCount: number;
                     encoding: string; truncated: boolean };
type EngineInfo = { id: string; version: string; installed: boolean; bytes: number };
type WatcherStatus = { watching: number };
type StartupInfo = { path: string | null };
```

`encoding` is one of `utf-8`, `utf-8-bom`, `utf-16le`, `utf-16be`, `utf-8-lossy`.

`ApiError` is a tagged enum, not a string, so the UI can distinguish "file was deleted" (silent,
tab goes `missing`) from "permission denied" (toast) from "not UTF-8":

```rust
#[serde(tag = "kind", rename_all = "camelCase")]
enum ApiError { NotFound { path }, Denied { path }, Io { path, message }, NotText { path } }
```

Two caveats worth stating because both were wrong in the first draft:

- There is **no refusal-for-size variant**. `read_file` truncates at the head
  (`fs_ops::MAX_FILE_BYTES` = 8 MiB) and reports `truncated: true`; `render_doc` carries the
  same flag on `RenderedDoc` and the status bar shows a `truncated` mark. The policy is
  "degrade and say so", never "refuse" — a dead `TooLarge` variant was removed rather than
  left as an unused arm.
- `NotText` is returned for a **directory**, not for invalid UTF-8. Invalid UTF-8 is not an
  error: it decodes lossily and surfaces as `encoding: "utf-8-lossy"` with a status-bar
  badge. The cases the enum separates are "gone", "refused" and "not a text file at all".

The frontend consumes `truncated` (status bar), and since SPEC §12 it also consumes `eol` and
`mtimeMs`, which used to be dropped: `eol` decides how a save joins its lines, and `mtimeMs` is the
baseline the save is checked against. `eol` gained a third value for the same reason — a file carrying
both endings is `mixed`, because the reader's "CRLF wins" heuristic is fine for showing a document and
useless for writing one.

`write_file` is the other half of `read_file`, and its contract is byte fidelity: the file keeps the
encoding it was read in (a UTF-8 BOM is stripped on read and restored on write, UTF-16 is re-encoded
with the same byte order), line endings are joined rather than normalised, and the document's
permissions survive the atomic replace. Three refusals guard that contract — `mixed` endings, a
`utf-8-lossy` decode, an encoding this build cannot produce — and a file that changed under the buffer
is a `Conflict`. Both are tagged variants, so the UI decides what to say rather than parsing a string.

`FilePayload` also carries `writable` — the read-only attribute on Windows, no write bit for anyone on
Unix — so the pane can refuse to edit such a file up front instead of letting the save fail after the
reader has already typed into it. The write itself fails too; that is the backstop, not the plan.

### Events (Rust → frontend)

| event | payload | notes |
|---|---|---|
| `fs://changed` | `{ paths: string[] }` | debounced **120 ms**, coalesced. One event for a batch of edits, never one per file. Consumed by `main.ts` for **every** matching tab: the active one reloads in place with the `reloading` marker, a background one drops its parsed document so it reloads on activation. |
| `fs://removed` | `{ paths: string[] }` | debounced and coalesced like `changed`. Consumed by `main.ts`: every matching tab goes `missing` (strikethrough), and its parsed document is kept so a stricken tab stays readable. A later `fs://changed` for the same path clears the mark and reloads. |
| `app://open` | `string` (a path) | a second launch ("Open with MarkdownAura") hands its path to the running window. |
| `tauri://drag-enter` / `drag-leave` / `drag-drop` | `{ paths: string[] }` | Tauri core events, not ours. Under `dragDropEnabled` the WebView fires no HTML5 drop events, so these are the only drop signal there is (§8). |

**Not implemented, and no longer needed:** `engine://progress`. It was specified for the opt-in d2
download; d2 is bundled now, so there is nothing to report progress about.

Watcher ignore rules live in Rust, not the frontend: `fs_ops::is_ignored_dir` skips any name
starting with `.` plus `node_modules`, `target`, `dist`. The tree and the `watching N files`
counter read the same function, so they cannot disagree. There is no user-editable ignore
list (SPEC §3 v1 status). The watcher itself is optional: if `notify` cannot start, the app
logs and reads markdown without live reload — `None` is a state, not a panic.

Debounce detail worth keeping: an event pushes the window out, so a burst of twenty
notifications collapses into one. Remove followed by create is classified as a *change*, not
a removal, so a save-by-rewrite does not flicker a tab into `missing`.

## 4. Markdown pipeline — **decided 2026-10-01**

**Render in Rust with `pulldown-cmark` 0.13.4** (MIT, three light dependencies: `bitflags`,
`memchr`, `unicase`; built with `default-features = false, features = ["html"]`).

The mockup's `renderMarkdown()` (`design/mockup.js`) hand-rolls a parser in the browser. That was
right for a mockup and wrong for the app — but note what is actually the contract there: **the
output shape** (heading ids, diagram card markup, inline render errors), not the parser. Rust
replaces the parser and keeps the shape.

Why Rust:

- The file is already open in Rust. Rendering there means we never ship a JS markdown parser at
  all — `marked` is ~40 KB, `markdown-it` ~100 KB, both avoidable.
- Headings *and* diagram blocks fall out of one parse. The frontend needs both (outline, diagram
  list, cards). Parsing twice — once in Rust for the outline, once in JS for the HTML — is the
  obvious way to get them out of sync.
- We control the HTML, so sanitising is an allow-list applied *while generating*, not a filter run
  over arbitrary input — see **Raw HTML policy** below. No DOMPurify, and no `ammonia` either.

Concretely:

```rust
pulldown_cmark::Options::ENABLE_TABLES
  | ENABLE_TASKLISTS | ENABLE_FOOTNOTES | ENABLE_STRIKETHROUGH
```

- Frontmatter is stripped before the parse and returned as `frontmatter: FrontmatterField[]`
  on the render result; `pipeline.ts::frontmatterHtml()` turns it into pills that
  `document.ts` inserts `afterbegin` so they sit above the document instead of inside it.
  A leading `---` is only frontmatter if a second `---` closes it — an unterminated one is a
  thematic break and the document is left alone.
- A fenced block whose info string is `mermaid` / `dot` / `graphviz` / `d2` is **not** rendered
  to HTML. It becomes a `DiagramBlock { id, lang, source, line }` and the frontend emits the card
  markup and calls the engine. `graphviz` normalises to the `dot` engine id. Everything else
  becomes a normal `<pre><code>`.
- Diagram blocks are left in the HTML as an empty placeholder element carrying `data-diagram="id"`
  (`<div data-diagram="d0"></div>`), so document order survives and the frontend just fills them
  in. The placeholder carries no class — the frontend replaces the node wholesale.
- Heading ids are assigned in Rust (`h0`, `h1`, …) — the outline links must match the preview
  after a re-render, so ids cannot be regenerated per view.
- Heading *text* is collected from both `Text` and `Code` events, so `# use \`render_doc\``
  outlines as `use render_doc here`. `Code` is a separate event from `Text`; handling only
  `Text` silently drops the identifier, which is the part of a heading people scan for.
- Image destinations go through a resolver the caller supplies (`render_with(src, resolver)`;
  `render(src)` is the no-op case). A webview resolves a relative `src` against *its own* origin,
  never against the folder the document came from, so `![x](images/a.png)` is a broken icon until
  the destination becomes an asset-protocol URL — the only origin the CSP lets an image through.
  `commands.rs` passes one that joins the destination to the document's folder (percent-decoding
  it, resolving `.`/`..` lexically, because the protocol refuses any URL that still contains `..`)
  and converts the result with `WebviewWindow::convert_file_src`. `None` leaves the destination
  byte-for-byte as parsed: a `data:` URI or a remote URL is the CSP's business, not the renderer's.
- UTF-8 that will not decode is rendered lossily and the encoding rides back on the render
  result. An unreadable file must not blank the window.
- One `push_html` over the whole event stream, never one call per event: the writer carries state
  (table alignment, tight/loose lists) across events and per-event calls would shred it. Footnote
  *definitions* are the one exception, and a deliberate one: each note's buffered events go through
  their own writer while the end section is assembled, because by then a note is a fragment with its
  own numbering. There is a test for the section's shape.
- **Footnotes and math are rewritten in the same walk, and both need the whole document** (SPEC §13).
  A reference becomes a slot in the event stream (`Event::Html("")`) that is filled after the walk,
  because a reference can appear before its definition and one with no definition has to revert to the
  `[^id]` the author typed; the numbered section is appended as the last event. Math's
  display-versus-inline decision is patched when the paragraph closes, since "is this formula alone in
  its paragraph" is only knowable then. Both follow the heading-id rule: one parse produces the
  preview *and* the data the UI needs.
- The whole body is truncated at 8 MiB (`fs_ops::MAX_FILE_BYTES`) before parsing.

Rule to carry over from the mockup: an engine failure renders **inline, in the card, with the line
number** and never clears the rest of the page.

### Raw HTML policy

`pulldown-cmark` hands raw HTML through as `Event::Html` / `Event::InlineHtml`. That is the one
place where a source file gets to inject markup, so it is the one place that needs a rule.
**The rule is an exact-match allow-list, not a sanitiser.**

```
allow  — matched after trim + ASCII lowercase + whitespace-collapse + ` />`/` >` folding
  block    <details>   <details open>   </details>   <summary>   </summary>
           <br>  <br/>  <br />  <hr>  <hr/>  <hr />
  inline   <br>  <br/>  <br />  <kbd>  </kbd>  <sub>  </sub>  <sup>  </sup>
drop   — everything else, including every tag that carries an attribute
```

- The normalisation (`markdown.rs::normalize_tag`) exists so `<BR />` and `<br  />` match
  the table; it is *not* parsing, and the normalised string must still match a table entry
  exactly or the tag is dropped. `<script >` and `<details onclick=x>` normalise to
  something not on the list and die.
- **Emit the canonical string from the table, never the source slice.** If a match is ever loose,
  the output is still the literal we chose rather than something we merely tolerated.
- **Do not decode entities on the way through, and do not strip attributes from a tag that has
  them.** A tag we do not match exactly is dropped whole. Stripping is where the bugs live; failing
  to match has no bug surface at all.
- Intentional consequence: `<div align="center">`, `<table>`, `<img>`, `<a>` written as raw HTML
  are dropped. Markdown's own equivalents still work, and `![]()` goes through `pulldown-cmark`,
  which already validates and percent-encodes the URL.
- **Why not `ammonia`.** It is the right crate for sanitising untrusted HTML, but it pulls
  `html5ever` + `cssparser` + `url` — a complete HTML5 parser — to solve a problem we can avoid by
  not accepting the input. `pulldown-cmark` stays at three light dependencies. If a later version
  genuinely needs to sanitise arbitrary HTML, add `ammonia` then; do not grow one by hand.
- The allowed tags are the ones READMEs actually use, and dropping them would be *visible*. They
  do need styles or they fall back to UA defaults — `prose.css` carries them. Note that
  `components.css` has a **global** `kbd` rule for the chrome, which is exactly the kind of leak
  the `.prose kbd` rule exists to pin down.
- This is a security boundary, so it gets a hostile unit test (§10), not only a happy path. It is
  also the one thing CSP must not be relied on for: `script-src 'self'` blocks inline handlers
  today, but CSP strings get loosened for unrelated reasons and the allow-list has to stand alone.

### The HTML shape is a cross-language contract

Rust emits class names that `prose.css` and `components.css` must match, and **no compiler checks
either side**. This is the weakest seam in the whole architecture.

**What guards it today:**

- Rust unit tests in `markdown.rs` cover the allow-list, normalisation, hostile input, allowed
  tags inside paragraphs, stable heading ids/lines, diagram placeholders, the `graphviz` alias,
  ordinary fences, frontmatter, unterminated rules, the footnote section (shape, numbering order,
  undefined reference, unreferenced definition) and the math rules (off by default, prices stay
  prices, display demoted inside a sentence).
- `npm run check:rawhtml` asserts the same allow-list holds in the mockup, so the
  two renderers cannot quietly disagree.
- `src/render/pipeline.ts` copies mockup.js's card markup verbatim; review keeps it so. **One state
  is app-only**: the mockup draws its diagrams synchronously, so it has no `diagram-pending` body
  and no `rendering…` string. A class that exists only in the app is the one place this rule cannot
  be honoured symmetrically — the mockup is the spec for the card, and the pending state is the
  app's answer to "the engine has not answered yet".
- **The card is opened before its engine answers** and its body is filled afterwards
  (`openCard` → `showDiagram`/`showFailure`), so the head, the `zoom`/`copy` buttons and the
  `data-diagram`/`data-source` anchors exist for the whole render, and `figure.isConnected` is what
  tells a slow render that a newer paint owns the DOM now (SPEC §4).

**The seam has bitten.** The card head holds two `<svg>` **icons** (zoom, copy), so anything that wants
the diagram itself must select `.diagram-body svg`: a bare `querySelector("svg")` returns the first
button's 12×12 glyph. That is what the viewer cloned until 2026-10-03 — a full-panel overlay showing a
speck, which reads as "blank" — and it was blank for all three engines for the same reason, because the
icon is always first. When a selector is about to pick an element out of rendered content, name the
container (`figcaption`, `.diagram-body`), not the tag.

**The same seam, the other half.** Of the three engines only dot writes a size into its SVG (`265pt`);
mermaid writes `width="100%"`, and d2 writes neither, relying on being 100% of a parent that has a
width. So a cloned diagram needs a parent with a definite width: the card's `.diagram-body` is one, and
the viewer's `.ov-stage` had no rule at all, which made the d2 clone 0×0 — present in the DOM, invisible
on screen. `.ov-stage` now mirrors `.diagram-body`'s sizing. A new engine is a new answer to "does this
SVG size itself?", and the card is the thing to check it against.

**What does not exist yet, and should:** `insta` is a dev-dependency but there is no
snapshot test and no `src-tauri/tests/` directory, and there is no class-name lint that
extracts `class="…"` from the rendered HTML and asserts each name appears in a
`design/*.css` file. The failure mode they exist for is the real one — rename
`.diagram-head` in CSS, keep emitting the old name, and nothing fails at build time; it
just looks like a styling bug later. Landing both is an open item (§11). Do not describe
them as existing guards until they do.

### Payload

`html` dominates the `render_doc` response: 1 MB of markdown is roughly 2–3 MB of HTML, and the
default IPC response path serialises the payload. That overhead is real, but the fix is not free
either — Tauri's raw byte channel (`tauri::ipc::Response`) can only carry the *whole* return value,
so using it means splitting `render_doc` in two and keeping a small render cache in Rust to stay at
one parse.

**Do not do that up front.** Add the round trip to the §9 budget, measure it on a 1 MB document,
and split only if it is a meaningful share of the render budget. If it comes to that, the shape is
`render_doc(path) -> { docId, headings, diagrams, words, lineCount }` followed by
`take_html(docId) -> Response`, with Rust holding the last few rendered documents by `docId`.

## 5. State

Single source of truth in the frontend (`src/state.ts`). The mockup's record plus the fields
the UI actually needs:

```ts
type Tab = {
  id: string;            // `t0`, `t1`, … — stable, survives reorder
  file: string;          // absolute path — the identity for "already open"
  name: string;
  view: "preview" | "split" | "source";
  scroll: number;
  outlineHit: string | null;   // present, not wired (SPEC §5 v1 status)
  find: { q: string; case: boolean; hit: number };
  preview: boolean;      // italic: opened by a single tree click
  // v2 contract — the fields exist, `missing` and `reloading` are wired, `pinned` is not
  missing: boolean; reloading: boolean; pinned: boolean;

  // loaded document (null until the first render finishes)
  doc: RenderedDoc | null;
  source: string | null;         // lazily fetched; only split/source need it
  encoding: string;
  eol: "lf" | "crlf";
  words: number;
  bytes: number;
  renderMs: number;
  truncated: boolean;      // file past the 8 MiB cap; the status bar shows a mark
  // SPEC §12 — the editable pane. `blocked` is why the file cannot be edited at all, derived from the
  // same flags the reader only *badges*: a badge is safe only while nothing can write.
  editing: boolean;
  dirty: boolean;
  buffer: string | null;   // null = untouched; the buffer is line-normalised, the file is not
  loadedMtimeMs: number;   // the baseline `save_doc` checks the disk against
  blocked: null | "truncated" | "lossy" | "mixed" | "missing" | "readonly";
};

type WindowState = {
  theme: "light" | "dark" | "system";
  zoom: number;                  // 50…200, multiplied with fontSize by prose.css
  fontSize: number;              // 12…22, written to `--doc-size`
  reduceMotion: boolean;
  math: boolean;                 // `$…$` becomes math; a render input, default false (SPEC §13)
  lang: "system" | "en" | "zh-CN";  // SPEC §10; `system` is resolved inside i18n.ts
  measure: Measure;              // reading-width preset -> `--measure` (SPEC §8)
  sidebar: { open: boolean; width: number };   // width -> `--w-sidebar`
  outlineOpen: boolean;
  outlineWidth: number;          // -> `--w-outline`
  mdOnly: boolean;               // explorer lists markdown files only; default true (SPEC §3)
  activeTab: number;
  tabs: Tab[];
  recent: string[];
  root: string | null;           // folder currently in the explorer, null for the empty state
  watching: number;              // last watcher count; not persisted, needed to re-render its label
  windowRect: WindowRect;        // cached last rect; refreshed from the real window at save time
};
```

Invariants worth stating because they are the bugs:

- Opening an already-open file **activates** the tab, never duplicates it. Identity is
  `normalizePath` — lowercase, `/` → `\`, trailing separators stripped — because Windows
  paths are case-insensitive and the same file arrives with either separator.
- A single tree click reuses *the one* preview tab (it keeps its position in the strip,
  which is what makes browsing feel stable); a double click pins it. Reaching an already
  open preview tab by double click clears the preview flag; reaching it by single click
  leaves it alone rather than un-pinning something deliberately pinned.
- Switching tabs restores **all** per-tab values. Losing scroll on tab switch is the failure
  mode SPEC §5 singles out; view mode is the same bug in slower motion. `activate()` calls
  `captureScroll()` before leaving and `paintActive()` re-selects the view, so both directions
  are covered — a regression here is a bug, not a polish item.
- `scheduleSave()` calls `captureScroll()` before serialising: scroll lives in the DOM until
  something switches away, and a save reading the stale `tab.scroll` restored every tab to the
  top. The scroll spy also schedules a save, so the position survives a restart without a tab
  switch.
- Rendering is keyed by `(engine, FNV-1a(source))` in an in-memory LRU (`render/cache.ts`),
  capped at **6 MiB of SVG**, evicting oldest-first and never the last entry. Size the cache by
  total SVG bytes, not entry count — one large graph is worth more than fifty small ones.
  Re-entering a tab must not re-render.
- Watcher batches fan out to **every** matching tab, not just the visible one. The active tab
  reloads in place (`reloading` marker on); a background tab's `doc` is cleared so `activate()`
  reloads it, which is what keeps a background tab from reading as up to date when it is not. A
  `fs://removed` batch flags matching tabs `missing` and deliberately keeps their last render —
  strikethrough says the file is gone, the text stays readable until it returns.
- The reading measure is a **resolved length** (`src/measure.ts`): pixels for the two measured
  presets, `100%` for "full" — never a `ch` length left for each child to resolve itself, which made
  headings 40% wider than body text. The pixel value comes from a probe inside `#out-preview`; the
  probe must keep `max-width: none`, or the measure rule clamps the probe to the *current*
  `--measure` and the number feeds back on itself (745px → 386px → 278px, once per re-layout). It
  must be recomputed on every font-size or zoom change (`applyLayout`) and once after
  `document.fonts.ready`.
- **Every size on the reading surface is relative to that same base**, and the source panes are part of
  the reading surface. `prose.css` sizes headings and everything else in `em` off `.prose`'s
  `calc(var(--doc-size) * var(--zoom))`; a px heading silently stops following the size control and the
  zoom, and if it comes from the 13px UI scale (`--fs-*`) it also starts *below* the body text it
  heads — which is what h3–h6 did until 2026-10-03. The source panes are set from the same two
  variables (`.source-view pre` at the prose body size, `.view.split .pane-src pre` at the compact
  0.867 of it) so source, split and preview are one document at one scale. `design/check-prose-css.mjs`
  enforces this; both halves of it were reported broken from the running app, which is the only place
  they are visible.
- `.source-view` carries `flex: 1 1 auto; min-width: 0` and must keep it: `.view.on` is a flex row, so
  a lone item at the default `flex: 0 1 auto` is sized by its **content** — the longest line of the
  source — and the pane came out a fraction of the window for any document with short lines.
- The measure lives on the **children** of `.prose`, not on `.prose` itself, and **every** child takes
  it — there is no wide-content exemption (`prose.css`). Both facts are load-bearing: on the
  container a table could be neither narrower nor wider than the text column, and re-adding an
  exemption is a design change (SPEC §3), not a fix. Every block rule in `prose.css` must use
  `margin-block`, never the `margin` shorthand — a shorthand silently zeroes the `margin-inline: auto`
  that centres the column (vertical margins still collapse, so the rhythm is unchanged by design).
  `design/check-prose-css.mjs` enforces both halves of this; it is a build-side check because no
  measurement that looks at widths can see the failure (the box has the right size, in the wrong
  place).
- Menus have exactly one dismissal path: `dom.ts` installs a **capture-phase `pointerdown`** listener
  that closes any open menu whose target is neither the menu nor the control that opened it, and
  `showMenu(items, x, y, opener)` turns that control into a toggle. Keep it in the capture phase —
  it must run *before* the opener's own click handler, which is what lets the opener tell a press on
  an open menu (toggle) from one on a closed menu (open). The mockup reaches the same behaviour
  differently (a bubble-phase document click plus `stopPropagation` on its anchors) because it has
  no capture-phase listener; do not copy that half of it into the app.
- Floating menus (`.menu`) are `position: fixed` because `showMenu` positions and clamps them in
  **viewport** coordinates. As an absolutely positioned child of `#main` the same numbers were
  resolved in `#main`'s coordinate space, and a menu anchored near the right edge — the
  reading-width chip is the one that found it — was laid out entirely off-screen while reporting
  itself open. Changing that `position` silently reintroduces the bug; a screenshot of the *menu*
  is the check, not `menu.classList.contains("on")`.
- Every layout token (`--zoom`, `--doc-size`, `--measure`, the panel widths, the motion flag) is
  written by `applyLayout()` and nowhere else. A surface that hand-writes one — as `setZoom` used to
  — refreshes that token but not the labels derived from it, and the second surface that shows the
  same value (`#stZoom`, the immersive bar's chips) silently goes stale. This bit once; it is one
  function call, not an optimisation worth making.
- Reading width is a preset name in the session, resolved by `src/measure.ts` — never a pixel value
  written into the session. An unknown name is sanitised by `state.applySession` (a hand-edited or
  older session must not be able to write garbage into the token).
- Split view keeps its two panes on the same document position, in both directions
  (`document.ts syncSplit`): anchors are headings + diagram cards, and the position between two
  anchors is interpolated by pixel fraction. Two details are the whole bug surface:
  **`.pane-src` must be in the scroll-listener list** (it is a scroller like any other, and leaving
  it out makes one direction silently dead), and a programmatic write is recorded per pane so its
  echo is not treated as a user scroll — without the guard the panes drive each other in a loop.
  The mapping is exact at anchors and approximate between them; do not "fix" that by measuring
  per line unless `markdown.rs` starts emitting line numbers for rendered blocks.

## 6. Session persistence

`%APPDATA%/MarkdownAura/session.json` (fallback `~/.config/MarkdownAura`), written on a
500 ms debounce that every mutating action schedules, and read once at boot. There is **no
save-on-exit hook**: a change followed by a close inside the debounce window is lost. If
that matters, the fix is a `getCurrentWindow().onCloseRequested()` that flushes the timer
— noted so the omission is a decision, not a surprise.

```json
{
  "version": 1,
  "window": { "w": 1216, "h": 809, "x": 680, "y": 116, "maximized": false },
  "theme": "system", "zoom": 100, "fontSize": 15, "reduceMotion": false,
  "math": false,
  "lang": "system", "measure": "comfortable",
  "sidebar": { "open": true, "width": 343 }, "outlineOpen": true, "outlineWidth": 259,
  "mdOnly": true,
  "activeTab": 1,
  "tabs": [
    { "file": "E:\\notes\\README.md", "view": "preview", "scroll": 0, "preview": false,
      "find": { "q": "", "case": false, "hit": 0 } }
  ],
  "recent": ["E:\\notes", "E:\\notes\\docs\\architecture.md"]
}
```

- `version` is checked on load. Unknown version → ignore the file and start empty; never migrate
  destructively. Missing/unreadable/corrupt → `None`, which is not an error.
- `fontSize`, `reduceMotion`, `math`, `lang`, `measure`, `outlineWidth` and `mdOnly` were each added
  after the first session format; all of them carry a default, so an older file still loads. Keep that
  property on any new field — the version stays 1 and a missing field must never mean "start clean".
  (`math` is the newest, and its default is the shipped one: a session written before the setting
  existed must keep rendering prices as prices.)
  `mdOnly` is the one whose default is `true`, so it uses a named function rather than a bare
  `#[serde(default)]` (which would mean `false` and silently list every file in the explorer); the
  test `a_session_without_the_toggle_opens_with_it_on` is what keeps that honest, and `round_trips`
  sets the field away from its default so a round trip that drops it fails.
- `measure` stores the *preset name* (`comfortable`), not a pixel count: the values are a design
  decision that may be retuned, and a stored `90ch` would then be a stale copy. It also makes
  retiring a preset cheap — an unknown name falls back to the default on load (verified with a
  session holding the removed `xwide`), so dropping a preset costs a silent fallback, never a broken
  layout. `lang` follows the same rule (it stores the choice, `system` included).
- `outlineWidth` is the same kind of value as `sidebar.width`: pixels, written back into a token.
- Panel widths are written on **pointer-up only** (a save per pointermove would rewrite the
  session file ~60×/s while dragging) and are clamped to the `--w-*-min`/`-max` tokens at drag
  time, so a corrupt or absurd stored value is corrected on the next drag, not on load.
- `window` is read from the live window at save time in **physical** units (`outerSize` /
  `outerPosition` / `isMaximized`), because that is what rounds-trip; restore uses
  `setSize`/`setPosition`/`maximize`. `x`/`y` null means "let the OS place it".
- A path that no longer exists is restored as a `missing` tab, not dropped. Losing someone's tab
  because a file was temporarily renamed is worse than showing a struck-through tab.
- `recent` is capped at 10 and feeds both the empty state (top 3) and `ctrl shift P` (top 8 as a
  menu). `session::RECENT_CAP` and the frontend list must be the same number;
  `session::push_recent` de-duplicates case-insensitively and is most-recent-first.
- Writing is atomic: temp file + rename in the same directory. A crash mid-write must not lose
  the previous session, and must not leave `session.json.tmp` behind.
- **The editing mode and the buffer are deliberately absent from the session.** A restored session comes
  back read-only, because "the app never opens in it" has to hold across a restart, not only on a cold
  start (SPEC §12). An unsaved buffer is not restored either, which is the cost the mode pays for being
  per-tab and asking before it is left.
- **Session restore is unconditional**, and there is no flag for it: `--last` was parsed, never
  read by the frontend, and has been removed rather than kept as a control that does nothing.
  `boot()` always calls `restoreSession()` and the folder to reopen comes from `recent[0]`. A
  future opt-out belongs as an explicit flag whose effect is wired, not as a leftover argument.

## 7. Engine loading

Each engine is a lazy `import()` behind one registry (`src/render/engines.ts`) with a four-state
machine — `off` → `loading` → `ready` / `failed`. All three engines start at `off`, not only d2;
`off` is what the status bar renders grey (`statusbar.ts` maps `off`→`grey`, `loading`→amber,
ready→green, `failed`→red). All three engines ship in the bundle (SPEC §4), so no dot means "not
installed" any more: `off` is simply "not loaded yet". Renders run **in sequence, not in parallel** —
mermaid's `render()` is not safe to call concurrently.

| engine | package | load | notes |
|---|---|---|---|
| mermaid | `mermaid` | `await import("mermaid")` | **Never** import the monolith (SPEC §4). `initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables })`, where the variables are read from `tokens.css` with `getComputedStyle` so the design file stays the colour source. A theme switch nulls the cached promise so the next render re-initialises. The ESM build is code-split; chunk resolution over the Tauri asset protocol was **verified in a release build**, because a wrong `base` silently breaks every diagram at runtime. |
| dot | `@hpcc-js/wasm-graphviz` | `await import(...)` → `Graphviz.load()` → `graphviz.dot(source)` | Wasm is inlined in the JS, so nothing extra ships. Note the API: the method is `.dot()`, **not** `.layout(src, "svg", "dot")` as an earlier draft said. There is no `unload()` call; graphviz stays resident once loaded. |
| d2 | `@d2lang/d2` | `await import("@d2lang/d2")` → `new D2()` → `compile(source)` → `render(diagram, opts)` | The browser build inlines its wasm and runs it in its **own worker** (`dispose()` shuts that worker down), so no worker or second artifact is ours to manage; `worker-src 'self' blob:` in the CSP is what lets it start. The SVG is returned as a string: `themeID` picks the palette — d2's own ids, **0** Neutral Default for light and **200** Dark Mauve for dark, chosen from the app's theme (`data-theme`), never from the OS, because the app's theme can disagree with it — `salt` keeps element ids unique across identical diagrams in one page, and `noXMLTag` because the SVG is injected rather than saved. `themeID` is read per render, so there is no reset hook; the *cache* is what has to be dropped on a theme switch, and `invalidateEngineThemes()` does that (`./cache`). The first d2 block in a document pays the parse of the module, which is why the import is started early: `paint()` calls `preloadD2()` as soon as a document has an **uncached** d2 block (a cached one would pay 11 MB for nothing), and `warmHeaviestEngineOnIdle()` calls it once per session after any document with diagrams has rendered. Moving that parse off the reader's critical path is the difference between a d2 card that takes four seconds and one that does not wait — `engine_state` still reports `off → loading → ready` in the meantime, so the dot stays honest. |

**The d2 download was dropped.** It existed as `engine_install` + `engine://progress` + a scan of
`%APPDATA%/MarkdownAura/engines/d2/`; on 2026-10-03 d2 became a bundled dependency instead (SPEC §4)
and all of that went with it: no install command, no progress event, no `engines/` directory, and
`EngineInfo` no longer carries `path` or `optIn`. The remaining CSP line it needed — `worker-src
'self' blob:` — is still required, for the package's own worker.

CSP (from `tauri.conf.json`, verbatim — the earlier three-line version was incomplete and
would have broken the worker and the asset protocol):

```
default-src 'self';
script-src  'self' 'wasm-unsafe-eval';
style-src   'self' 'unsafe-inline';   /* mermaid injects its own <style> */
img-src     'self' data: blob: asset: http://asset.localhost;
font-src    'self' data:;
connect-src 'self' ipc: http://ipc.localhost blob: data:;
worker-src  'self' blob:;
```

`assetProtocol.enable: true` with an empty static scope: the scope is widened at runtime, not
declared up front — to the folder the user opens (`open_folder`, `resolve_target`) and to the
folder of every document that gets rendered (`render_doc`, `render_text`), because a document
reached from the dialog, the recent list or "Open with" is not necessarily under the open root.

d2 is in the installer like every other engine, which is what makes the app's "no network at
runtime" claim unconditional. `IMPL.md` §9 carries the resulting sizes.

### The two post-passes: Prism and KaTeX (SPEC §13)

Neither is an engine (no card, no `EngineState`, nothing in the status bar) but both follow the same
loading rule, and both are lazy for the same reason: a document that has neither a code fence nor a
formula must not pay for either.

| pass | package | load | notes |
|---|---|---|---|
| code highlighting | `prismjs` | `await import("prismjs")` then `await import("./prism-languages")` | The grammar list is **one chunk of ~50 grammars** (`src/render/prism-languages.ts`), and its import order is a dependency order: `cpp` needs `c`, `tsx` needs `jsx`+`typescript`, `git` needs `diff`, `php` needs `markup-templating`. Per-language `import()` would need either `import.meta.glob` over all 599 shipped components (599 chunks) or its own dependency table — the same list, spread out. Aliases come from `prismjs/components.js` (7.5 KB) instead of a hand-written table. `Prism.highlight(text, grammar, language)` takes the *text*: nothing here re-highlights existing DOM. A grammar that is not loaded, or a language nothing ships, leaves the fence alone. Results are memoised (`language:hash(source)`, 128 entries) because `paint()` runs on every debounced keystroke of the live preview. |
| math | `katex` + `katex/dist/contrib/mhchem.mjs` | `await import("katex")` | `renderToString(tex, { displayMode, throwOnError: false })`, where the TeX is the span's `textContent` and `displayMode` is the class the Rust side chose. `throwOnError: false` renders a parse failure in KaTeX's own red instead of throwing, and the pass adds `.math-error` for the sheet; a failure never moves the text. mhchem is a side-effect import in one place, so `\ce{…}` works. **Its CSS is imported statically** (`katex/dist/katex.min.css`, 23 KB minified) so there is no unstyled flash when the first formula arrives — the JS, the fonts and the whole grammar chunk stay lazy. `preloadMath()` starts the import when the setting is switched on. |

## 8. Shell details

The window is built in `lib.rs` (`WebviewWindowBuilder`); `tauri.conf.json` carries
`"windows": []` deliberately, so that `MARKDOWNAURA_BROWSER_ARGS` can be applied to
`additional_browser_args` at runtime (§1 and SPEC §2 explain why: `--no-sandbox` is needed
on restricted sessions and must never be a default). Settings: 1200×800, min 720×480,
centred, `decorations: false`, `drag_and_drop(true)`. `transparent` is not set.

- `bundle.licenseFile` (`../LICENSE`) puts the MIT text on the installer's licence page, and
  `bundle.resources` ships `LICENSE` and `THIRD-PARTY.md` next to the installed executable. The map's
  keys are paths relative to `src-tauri/`; the values are where they land in the install directory.
  Re-run `npm run notices` before packaging, or the shipped notices describe the previous dependency
  set.
- **`tauri.conf.json` does not accept comments.** Adding one fails the build script with
  `unable to parse JSON … key must be a string`, which reads like a schema error and is not one —
  the rationale for a setting lives here, never in that file.
- **`WebView2Loader.dll` is dynamic on this toolchain, and it cannot be made static here.** The exe
  imports it (that is why the DLL sits beside the portable exe and inside the installer), and
  `webview2-com-sys` chooses the *static* loader only under `cfg(target_env = "msvc")` — this machine
  builds `x86_64-pc-windows-gnu`, so the dynamic branch is taken. There is no feature flag for it.
  Renaming the shipped `WebView2LoaderStatic.lib` to `libWebView2LoaderStatic.a` so the GNU linker would
  find it was tried and fails: its objects are MSVC-compiled, so `ld` reports undefined
  `__security_cookie` / `__security_check_cookie` and MSVC-mangled names. Static linking therefore needs
  the MSVC toolchain, which would also mean re-checking the GNU-specific repairs in this file. Leaving it
  dynamic costs one 161 KB file that both deliverables already ship.
- **There was a single-file edition; 0.1.2 removed it.** `tools/portable/` was a zero-dependency launcher
  that embedded the app and the loader at compile time (`include_bytes!`, so the payload could not drift
  from the build) and unpacked them into `%LOCALAPPDATA%\MarkdownAura\portable\<version>\`. It earned its
  complexity twice over: it had to prefer a *newer installed copy* — an update taken from inside the app
  installs through the NSIS installer, so re-launching the single file would otherwise start the version it
  shipped with — which meant comparing PE version resources at runtime (`GetFileVersionInfoW`, resolved from
  `version.dll` because this toolchain has no `libversion.a`). "One file to double-click" is not worth a
  second updater of the app's own, so the crate, its build script and the `build:portable` script are gone.
  Portable means the zip: `markdownaura.exe` plus the loader, which is also what the installer unpacks.
`capabilities/default.json` is the app's whole permission surface: `core:default`, the eleven window
permissions the custom titlebar, the session's window rect and the confirmed quit need (`allow-destroy`
is the last of them: a close request that has already been answered once cannot be answered again, so
the quit goes through `destroy()` rather than re-emitting the event), `core:event:allow-listen` /
  `allow-unlisten` for the `fs://` and `app://` events, `dialog:allow-open`, the updater pair
  (`updater:default`, `process:allow-restart`) that the About sheet's check-for-updates path uses,
  and **one scoped opener permission** —
  `opener:allow-open-url` with `allow: [{ "url": "https://github.com/westsource/MarkdownAura" }]`.
  That single entry is what makes "the app can open exactly one URL" a fact rather than an
  intention; widening it is a security change, not a convenience one.
- **The installer cannot set the default handler either, so it leaves a marker instead.**
  `bundle.windows.nsis.installerHooks` points at `nsis/hooks.nsh`, whose `NSIS_HOOK_POSTINSTALL` writes
  `HKCU\Software\MarkdownAura\OfferDefaultApp = 1` (HKCU because the installer is per-user by default, and
  because the app reads the same hive). The app reads that value and clears it, so the first launch after an
  install toasts once and the Settings row is where the action lives. Setting `UserChoice` from an installer
  is not a thing Windows permits; pretending otherwise would produce an installer that silently does nothing.
- **The `.desktop` file is written by three separate config keys, and getting only some of them costs
  behaviour.** `bundle.fileAssociations[].mimeType` becomes `MimeType=` — without it a file manager has no
  reason to offer the app; `bundle.category` becomes `Categories=` (Tauri maps `Productivity` to the
  registered `Office;` rather than copying the word); and `Exec=` only carries `%U` if
  `bundle.linux.deb.desktopTemplate` supplies it, because Tauri's default template has a bare
  `Exec=<binary>` — so the association exists but the path never arrives. `src-tauri/desktop/MarkdownAura.desktop`
  is that template. All three were found by reading the generated file back out of a built deb, which is the
  only place the truth is.
- native drag-drop is **a trap**: with `dragDropEnabled` the WebView never fires HTML5
  `dragover`/`drop`, so the empty state's tint cannot come from a CSS `:drop` state. It is
  driven from Tauri's drag events, which toggle the mockup's `.empty.dragover` class
  (`components.css` paints `--ac-bg`). The earlier note to "toggle `--ac-bg` yourself" was
  wrong in the mechanism and right in the requirement: the class is the mechanism.
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` is ineffective on this stack — wry passes explicit
  args that override it, which is why the app has its own variable.
- **`drag_and_drop(true)` is a Windows-only builder method** — tauri gates it `#[cfg(windows)]`, and
  it is a different switch from `disable_drag_drop_handler`. A Linux build fails on it with
  `E0599: no method named drag_and_drop`, which is how the port found it. Off Windows the drag-drop
  *handler* is what decides whether the WebView receives HTML5 drop events, and it is on by default —
  the same suppression the bullet above describes — so `main.ts`'s Tauri-event path is the one that
  works everywhere and no HTML5 fallback is needed.

CLI and single-instance:

- `markdownaura <folder|file>`. Parsing: the first non-flag argument wins, unknown flags are
  ignored (a stray argument from a shell integration must not stop the window from opening).
  There is no `--last`; session restore is unconditional (§6), and the flag was removed rather
  than kept as a no-op.
- `tauri-plugin-single-instance` (every desktop platform, registered under `cfg(desktop)`): a
  second launch forwards its path to the running window via `app://open` and focuses it, rather than
  opening a second window. Without this, "Open with MarkdownAura" on a `.md` file gives you a new
  window per file. It used to be gated to Windows, which silently cost the Linux build that
  behaviour; on Linux the plugin goes through the session D-Bus, so a Flatpak or Snap whose id
  differs from the app identifier has to set `DBUS_ID`.
- The asset-protocol scope is widened, not declared: `open_folder` and `resolve_target` allow the
  folder they adopt, and `render_doc`/`render_text` allow the folder of the document they render
  (a document opened from the dialog or the recent list may live outside the open root). Without
  this, a relative image resolves against the app's origin and every one of them is a broken icon —
  §4 covers the destination rewrite that goes with it.
- Windows shell integration (context-menu entry) is a separate installer concern, out of scope here.
- Vite must bind `127.0.0.1`, not the default `localhost`: Node resolves `localhost` to
  `::1` here, Vite ends up IPv6-only, and WebView2 reaches for IPv4 — the symptom is a
  correctly sized, black window with no error anywhere.

## 9. Budgets

The product's claim is speed, so the numbers are part of the contract:

| moment | budget |
|---|---|
| window shown → empty state painted | ≤ 400 ms cold |
| `open_folder` on 500 files (one level) | ≤ 50 ms |
| 1 MB markdown → HTML (Rust, parse only) | ≤ 100 ms |
| 1 MB markdown, end to end (parse + IPC + `innerHTML`) | ≤ 200 ms |
| tab switch, document already parsed | ≤ 16 ms (one frame, no re-render) |
| first mermaid block → SVG | ≤ 250 ms after the chunk is resident |
| idle RAM with 10 tabs open | ≤ 150 MB |

The status bar's `rendered in N ms` is measured in Rust around `render_doc` and around each engine
call, and shown as-is. If a budget is missed, the number is already on screen — do not hide it.

Measured 2026-10-02 (fixture with frontmatter, one mermaid and one dot diagram, d2 inline
error): dev-mode first render ≈336 ms including both engines; the release build's
cache-hit re-render of the same document reported 4 ms. The budgets above stay as the
contract; these are one data point each, not a pass.

**Bundle cost, measured 2026-10-03 (release).** `dist/` is 16.8 MiB; the d2 chunk alone is 11.0 MB and is
code-split, so it is fetched on the first `d2` block rather than at boot. The release binary is 15.28 MiB
(6.9 MB before d2 was bundled) and the NSIS installer is 11.83 MiB (3.36 MiB before). All of it is
install-time bytes — nothing is fetched at runtime (SPEC §4). On Linux the same build gives a 12.55 MiB
`.deb` and an 87.89 MiB AppImage, and the difference is not the app: the AppImage carries WebKitGTK itself —
`libwebkit2gtk-4.1.so.0` alone is 90.79 MiB of the 263 MiB that unpacks, against a 15.96 MiB binary. That is
the trade AppImage exists for (it runs on a distribution with no WebKitGTK installed); the deb depends on
the system's copy instead.

**Code highlighting and math, measured 2026-10-07 (`npm run build`).** `prism-languages` is
`120.31 kB` raw / **`41.73 kB` gzipped**, loaded on the first code fence. The app's own entry chunk did
not grow. KaTeX is **`260.01 kB` raw / `77.34 kB` gzipped** (a second, identically sized chunk has
been in the graph since mermaid started using KaTeX, so the *incremental* cost is the one chunk), plus
**19 `woff2` font files** and `23.3 kB` of CSS. The CSS is in the main stylesheet on purpose (no
unstyled flash); the fonts are fetched by the browser only when a formula actually renders. All of it
is install-time bytes and nothing is fetched at runtime, same as the engines. `dist/` is 20 MB after
this change.

**d2's first card is the slow one, measured 2026-10-03** on `var/typecheck/diagrams.md`: the first d2
block reported 3837 ms (parsing the 11 MB module) and a re-render of the same document reported 19 ms.
The document's own text is painted before any card is resolved, so the wait is one card, not the page.
That is the whole price of not making d2 a download: no install step, and a slow first d2 block — the
status bar's `rendered in N ms` is where a reader sees it.

## 10. Testing

- **Rust: 67 unit tests, in-module** (`cargo test --lib`) — `session` (round-trip, unknown
  version, corrupt file, missing file, no temp file left, recent cap/dedupe/order);
  `fs_ops` (ignore rules, BOM detection, UTF-16 byte orders, truncation at the 8 MiB cap);
  `markdown` (the allow-list, normalisation, hostile input, allowed tags in paragraphs,
  heading ids/lines, heading text with inline code, diagram placeholders, `graphviz` alias,
  ordinary fences, frontmatter, unterminated rule, line index; and since 2026-10-07 the
  footnote section's shape, numbering by first reference, an undefined reference, an
  unreferenced definition, math off by default, prices staying prices, and a `$$…$$` demoted
  inside a sentence); `watcher`
  (count skips ignored dirs, single file, missing root, a removal followed by a recreate);
  `engines` (all three bundled and always installed, no opt-in); `lib` (arg parsing, unknown
  flags ignored). An
  integration-test target would need `build.rs`'s link-arg repair, which is why the tests
  live in `#[cfg(test)]` modules — do not "move them out" without reading that comment.
- **`markdown` gets hostile fixtures that are not happy paths** (required by §4): raw
  `<script>`, `<img onerror>`, `<iframe>`, `<a href="javascript:…">`, attribute-carrying
  tags, and the same tags with mixed case or extra whitespace. The assertion is that the
  output contains none of them, and that the allowed tags still survive.
- **Missing guards** (open item, §11): the `insta` snapshot test and the class-name lint.
  `insta` is in `[dev-dependencies]` and unused.
- **Frontend:** `npx tsc --noEmit` is clean and is the only automated frontend gate. It also
  enforces i18n completeness: `zh` is `Record<Key, string>` typed against `en`, so a missing or
  stray translation fails the type check rather than falling back silently at runtime. The
  behavioural net is `design/mockup.html` plus a real render.
- `npm run check:rawhtml` asserts the allow-list holds in the mockup's stand-in
  renderer. It passes today. The mockup is the behaviour spec, so it must not quietly
  disagree with §4.
- `npm run check:prose` asserts the reading column is still centred: the centring rule
  exists, and no rule that can match a direct child of `.prose` uses the `margin` shorthand — a
  shorthand zeroes `margin-inline` for that one block type with a specificity that beats the centring
  rule, which is invisible to every measurement that looks at widths. Verified against the real bug
  by reintroducing `.prose p { margin: … }` and watching the check fail.
- The same script asserts the second invariant of the reading surface: **every `font-size` in
  `prose.css` is relative to the prose base, the two source panes read `--doc-size` and `--zoom`, and
  `.source-view` is `flex: 1 1 auto` with `min-width: 0`**. All three failures were reported from the
  running app on 2026-10-03 (headings smaller than body text; the source pane never matching the
  preview; the source pane sometimes only as wide as the split pane). Verified against those bugs the
  same way, by reintroducing each defect in a temp copy: `node var/guardtest.mjs` does exactly that
  and asserts the checker fails on each one and passes on the fix. The harness lives in `var/`
  (gitignored) because it is a one-off proof, not a gate; if these assertions start changing often,
  move it next to the checker and wire it into `npm run check:prose`.
- **Anything that spawns a process fails misleadingly from a bash-launched app.** The About sheet's
  "open data folder" button calls `reveal_in_explorer`, which returns `io` / `os error 50`
  (ERROR_NOT_SUPPORTED) when the app was started from the MSYS bash here and succeeds from a
  PowerShell-launched app — same binary, same command, same path. It is the launch environment, not
  the code; test that path from a normal Windows shell before believing it is broken.
- **The URL capability is verified in both directions**, from the page:
  `invoke("plugin:opener|open_url", { url })` returns for the GitHub URL and fails with
  `Not allowed to open url …` for anything else. A scope that is never tested in the deny direction
  is a scope nobody knows is working.
- **How the app itself gets verified** (kept in `var/`, gitignored): a fixture folder
  (`var/demo-docs/`), a CDP probe (`var/cdp-run.mjs`) against
  `--remote-debugging-port=9222`, and Win32 screen capture (`var/capture-screen.ps1`;
  `PrintWindow` returns black for WebView2, so it must use `CopyFromScreen`). **The README frames
  are a viewport capture, never a window grab** (`var/shot-readme-editing.mjs`): `GetWindowRect` is
  the window *plus* its invisible frame ring, so a `PrintWindow` frame comes back 1312×818 with a
  black border around a 1280×800 document, while `Page.captureScreenshot` is the document alone.
  Tauri's `listen` is an internal IPC channel, not a DOM event, so `emit()` from the page can
  synthesise `tauri://drag-*` for a drop-zone test. Two environment facts that cost time:
  a dev instance holds the build-script output file so `cargo test` fails with
  `os error 32` until the app is killed, and background jobs die with the turn, so the whole
  verify chain must run in one turn.
- The three states worth a screenshot on every change: empty state, a document with all three
  engines, and a document with a deliberately broken block.
- **A frontend-only change can be verified without the shell** (added 2026-10-07, used for
  SPEC §13). A throwaway page under `var/` imports the real modules through the dev server
  (`@/render/highlight`, `@/render/math`, `@/render/pipeline`) and the real stylesheets, gets the
  parser's actual HTML (printed from a temporary Rust test), drives the modules, and prints a JSON
  report plus a screenshot. It caught nothing, which is the point — it confirmed what the Rust tests
  cannot see: Prism's token classes on a real `js` fence, an unknown language left alone, KaTeX
  rendering `\ce{}`, a bad formula keeping its place, the pending card, the derived `viewBox`, and
  the error card keeping `data-diagram`. `var/` is gitignored, so the page is deleted with the batch;
  the alternative (booting the Tauri shell and driving it over CDP) costs minutes per iteration and
  cannot inspect a module in isolation.

## 11. Open items

- **The two contract guards in §4**: the `insta` snapshot over fixture documents and the
  class-name lint against `design/*.css`. `insta` is already a dev-dependency.
- **`KEYMAP` and the dispatcher** are still two hand-kept lists (SPEC §7). They agree today;
  nothing enforces it.
- **`.tab.pinned`** has no CSS rule while the class is emitted (SPEC §5).
- **Per-tab outline highlight** (SPEC §5): the field exists, but the spy does not remember it per
  tab. The outline jump landing both panes on the same anchor ships, as does continuous split-view
  sync (IMPL §5); what is left is remembering the highlight per tab.
- **Resize handles are pointer-only**, like the split-view `#splitter`: no `tabindex`, no arrow
  keys. `role="separator"` without a keyboard path is incomplete accessibility; fixing one
  without the other would make the two handles behave differently, so fix both together.
- **Unchanged from the original draft**, each still needing its own decision:
  export (SVG/PNG/PDF) is out of scope for v1 (SPEC §11); raw HTML — the allow-list is deliberately
  short, revisit only if real documents need a tag that is missing, and add it as an
  exact-match entry, never as a parsing rule.
  (*Syntax* highlighting for non-diagram code fences left this list on 2026-10-07: it is now
  designed and shipped in SPEC §13, and its Prism setup is IMPL §7. Its *theme* — what a
  `catppuccin`-style code palette would look like as a second theme — is still undesigned; the
  colours are the eight `--code-*` tokens, and a light/dark pair is all there is.)
- **The editable source pane ships; this is what its control was chosen on.** SPEC §1 was rewritten for it
  on 2026-10-04 (product owner's call) — it had been a rule ("a reader, not an editor") that several
  shipped decisions were justified by: the `read-only` pill, a `<pre>` rather than a `<textarea>`, no
  caret/undo/save, and the `ctrl B` / `ctrl alt O` / `F11` map. An editor was a product decision before it
  was a technical one, and §12 now says which editing is in scope. Measured 2026-10-04 with this repo's own
  toolchain (Vite 6.4.3 + Rollup, `target:
  chrome110`, esbuild minify) and each candidate built as its own entry — that is, as the lazy chunk it
  would actually be, not as something in the first paint (`var/editor-probe/measure.mjs`):

  | candidate | minified | gzip | brotli |
  |---|---|---|---|
  | Monaco, editor core + markdown | 2769.4 KB | 703.2 KB | 560.4 KB |
  | CodeMirror 6, `basicSetup` | 596.0 KB | 204.0 KB | 172.0 KB |
  | Ace, markdown mode | 531.1 KB | 148.9 KB | 124.7 KB |
  | CodeMirror 6, explicit extensions | 498.8 KB | 173.4 KB | 146.8 KB |
  | plain `<textarea>` | 0.2 KB | 0.2 KB | 0.1 KB |

  Monaco also emits a separate 96.9 KB stylesheet and needs a worker story. Ace is the smallest on the wire,
  but it is built for *runtime* mode loading — its markdown mode only measured as bundled because the probe
  imported it explicitly — and it themes through its own classes instead of CSS custom properties. The
  recommendation is **CodeMirror 6 with an explicit extension list**: modular ESM with no runtime fetches,
  `EditorState.readOnly` as a first-class facet, and theming from `design/tokens.css` exactly the way
  `engines.ts` themes mermaid. Size alone does not decide it — the app's initial chunk is already 11.2 MB
  with d2's wasm inlined — and Ace's smaller gzip does not buy back its loading and theming model.
  **Shipped, the editor is a lazy chunk and not a line in the first paint.** Entering the mode in a real
  build loads five chunks plus one stylesheet — 483.5 KB minified / 167.2 KB gzip in total, the largest
  single chunk being 214.9 KB — and nothing before that, which is the whole point of the four-state
  discipline. The single-entry probe above is the worst case (no sharing and no tree-shaking across the
  entry boundary), which is why it reads slightly higher at 498.8 KB.
- **Four things an editable pane must get right, measured rather than assumed** (`var/editor-probe/`,
  driven over CDP on 2026-10-04):
  - The reading column can be imposed on the editor from *outside*: `#host .cm-content { max-width:
    var(--measure) }` resolved `60ch` to 527 px against the mono font, with no JS. Today `--measure` reaches
    only `.prose > *` (`prose.css:228`), so the source pane has no reading column at all. If the editable
    pane gets one, note that `measure.ts`'s `chToPx` probes `#out-preview` (`measure.ts:48-51`) — a *sans*
    element — so the same preset would mean a different number of columns in a *mono* pane.
  - Geometry lags CSS by exactly one measure pass. Changing the font size 15 px → 22 px applied the CSS
    synchronously (`font-size: 22px`) while `view.contentHeight` still read 155; only after
    `requestMeasure({ read })` did it report 224 with a 30.8 px line. Anything that writes `--zoom` /
    `--doc-size` and then reads geometry in the same tick — scroll sync, the scroll spy, the measure
    readout — gets the previous numbers.
  - The editor brings its own metrics: CM6 defaults to `line-height: 1.4`, while the pane it would replace is
    set at `1.8` (`components.css:497-504`) and `.prose` uses `--lh-body`, which is `1.7`
    (`tokens.css:61`). Without an explicit override, toggling read-only ↔ editable changes the leading.
  - Read-only is a *runtime* state, so it has to be a `Compartment`: `EditorState.readOnly` is a facet and
    cannot be reconfigured in place. Verified by typing real keys into a read-only editor (refused) and again
    after the reconfigure (accepted). Composition events do not throw, but real IME behaviour still has to be
    tried by hand on Windows with the actual input method.
- **The unsaved-buffer conflict policy is decided: an external change reloads silently.** That is what the
  watcher already does (`main.ts:814-831` drops `tab.source`/`tab.doc` and re-reads through Rust), so it needs
  no new code — and its accepted cost is that an unsaved buffer is lost when something else writes the file.
  Recorded as the product owner's call on 2026-10-04, so that it is not later mistaken for an oversight.
  Whatever does the saving still has to refuse the two states the reader merely *badges*: a truncated file
  (> 8 MiB) and a lossy decode would both round-trip into permanent data loss.

## 12. Releasing

Two things ship together: the installer (which is also the update artifact) and the manifest the updater
reads.

**The signing key is the one secret in this project.** `npx tauri signer generate -w var/updater/markdownaura.key`
writes a private key (gitignored, under `var/`) and a public one. The **public** key is pasted into
`plugins.updater.pubkey` in `tauri.conf.json`; the **private** key never enters the repository and has to be
backed up — losing it means every installed copy refuses every future update, because the key that signed
them is gone. Regenerating the pair and shipping a new public key only helps versions built after it.

**Build.** `TAURI_SIGNING_PRIVATE_KEY` has to be in the environment (a path to the key file is accepted) or
the bundle step produces no `.sig`:

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cygpath -wa var/updater/markdownaura.key)" npm run tauri build
```

`bundle.createUpdaterArtifacts: true` is what makes the bundle emit `MarkdownAura_<v>_x64-setup.exe.sig`
beside the installer. `plugins.updater.windows.installMode` is `passive`: a small progress window, no
prompts.

**Staged names carry the platform.** The bundler names what it emits (`…_x64-setup.exe`, `…_amd64.deb`),
and `stage(file, as)` renames on the way into `var/release/`: `…_windows-x64-setup.exe`,
`…-windows-x64-portable.zip`, `…_linux-amd64.deb`, `…_linux-amd64.AppImage`. Without it a reader looking at
a release page sees `x64` beside `amd64` and no system word anywhere — the portable zip in particular named
nothing at all. The arch spelling stays each bundler's own; only the platform word is added. `latest.json`
points at the staged names, so the rename cannot desync the updater.

**Manifest and assets.** `node tools/make-latest-json.mjs --notes "…"` reads the version from `package.json`
and the signature from the bundle, writes `var/release/latest.json` and stages every asset: the installer,
its `.sig`, `latest.json`, `LICENSE`, `THIRD-PARTY.md`, and — as one **zip** with a single top-level folder —
the portable pair (`markdownaura.exe` + `WebView2Loader.dll`), because that pair only works together and two
loose assets invite downloading one of them. `bash var/publish-release.sh --prune-missing` makes the release mirror that directory,
deleting assets that are no longer staged — that is how the loose pair was retired. The endpoint
in `tauri.conf.json` is `…/releases/latest/download/latest.json`, which GitHub resolves to the *newest*
release — so the manifest has to be uploaded to the release tagged `v<version>`; leaving it on an older
release points the updater at an older installer, which the version check then refuses.

**Staging is multi-platform, assembled one machine at a time.** Each run stages what *that* machine can
build and merges into the same `latest.json`: the Windows run adds `windows-x86_64` (the NSIS installer is
the updater artifact there), the Linux run adds `linux-x86_64` (the AppImage is, because that is what the
updater replaces) plus the `.deb`, which is published for installation but is not an update path — the
package manager owns that. `--clean` restores the old wipe-first behaviour; without it the staging directory
accumulates, which is what lets two machines fill one release. A manifest from a *different* version is
never merged into. **When the staging directory still holds another version's assets, pass `--clean`** — the
publisher uploads *every* file in `var/release/`, and `--prune-missing` cannot remove what is still staged
there. Staging 0.3.0 on a machine that had staged 0.2.1 would otherwise have uploaded both versions' assets
into the 0.3.0 release.

**The app checks this at launch now, not only when asked.** `boot()` calls `about.checkQuietly()` once the
window is up and does not await it: an offline launch has to look exactly like one that found nothing, so no
failure is surfaced. A hit sets the About sheet's state and reveals the status bar's update chip, whose click
opens the sheet; the install path itself is unchanged. The copy that claimed the check was "the app's only
network call, and it takes a click" is gone from the sheet, the SPEC and both READMEs — with a launch check,
that sentence would be false.

**Pushing needs the credential helper named explicitly here.** `$HOME` is empty in this shell and
`credential.helper` is `manager`, which wants a prompt it cannot have, so `git push` dies with
`unable to read askpass response from 'false'` — even in a session where an earlier push went through,
because that one was answered from the manager's cache. The store file lives under the Windows profile, and
naming it makes the push non-interactive (this is also why both publish scripts glob for it themselves):

```bash
git -c credential.helper= -c credential.helper="store --file=C:/Users/rong/.git-credentials" push origin main
```

**Gitee gets the same artifacts, as a mirror.** `node var/publish-gitee-release.mjs` publishes `var/release/`
as a Gitee release for the same tag: it creates the release when the tag has none (`MarkdownAura v<version>`,
with the same notes read from `latest.json`) and uploads every staged file, skipping any already attached —
Gitee's delete-attachment path is not documented well enough to trust, so a file whose content changed has to
be detached in the web UI first. The token (scope `projects`) comes from `GITEE_TOKEN` or
`var/gitee-token.txt`; no proxy is involved, because gitee.com is reachable from this machine even when
github.com is not. The Gitee repository is private, so its assets need a login to download, and the updater
endpoint above still points at GitHub: this release is a download mirror, not an update channel.

**"The same artifacts" stops at the Linux AppImage, and that is accepted (2026-10-08).** The repository's
attachment quota is **1 GB**, and as of 1.3.0 it holds **1015.4 MB across 11 releases** — about 8.6 MB free,
against a 93 MB AppImage. The AppImage stopped fitting at **1.2.0** (that release's Gitee mirror has 9 files
and 37.3 MB; the AppImage is not among them) and every older release that does carry one is from before the
quota filled. So the mirror ships the installer, the portable zip, both `.sig` files, the `.deb`, the two
manifests and `THIRD-PARTY.md`, and the **Linux AppImage is GitHub-only** — which costs nothing on the update
path, because the AppImage is fetched from the updater endpoint (GitHub) anyway and Gitee is a download
mirror. `node var/gitee-quota-audit.mjs` (read-only, `var/`) prints the per-release totals; run it before
staging, and when it reports the quota full, accept as above or prune old releases' assets by hand — pruning
is a decision for the product owner, never a script.

**An 88 MB attachment can outlive undici's 300 s response-header timeout** (the script's comment documents
this and reads the release back rather than retrying blindly). When the read-back says the file is *not*
attached either — which is what the quota rejection looks like — upload that one file with `curl`, whose
default has no such timeout:

```bash
curl --max-time 3000 -F "access_token=$TOKEN" \
     -F "file=@var/release/MarkdownAura_<v>_linux-amd64.AppImage" \
     https://gitee.com/api/v5/repos/westsource/MarkdownAura/releases/<release-id>/attach_files
```

The response says which it was: `HTTP 201` with the file attached, or `HTTP 400` naming the quota.

**The updater refuses a non-`https` endpoint before anything else runs.** Pointing `plugins.updater.endpoints`
at a local `http://127.0.0.1:…` fixture does not give you a cheap offline test — the config fails to
deserialize and the app panics on startup with *"must use a secure protocol like `https`"*. Verify the launch
check against the live release instead, with the version lowered (next paragraph) and a CDP probe like
`var/cdp-verify-chip.mjs`: wrap-and-fake is not an option, because `__TAURI_INTERNALS__.invoke` is not
writable from the page (a wrapper records nothing and the real call goes through anyway). Note also that the
app's own `reqwest` reaches GitHub when `curl` times out on the release-asset redirect — do not conclude the
endpoint is unreachable from a failed `curl`.

**Testing the path without shipping a downgrade.** Build once at the released version (the manifest's), and
once with the version lowered in **all three** places (`package.json`, `tauri.conf.json`, `Cargo.toml`) — the
updater compares against `tauri.conf.json`'s version, so changing `package.json` alone verifies nothing. The lowered build sees the release as
newer, downloads it, verifies the signature, and stops before `install()`. The install step runs the NSIS
installer, which is the only part that cannot be exercised without installing.

**The portable pair has no self-update.** The updater installs through the NSIS installer, so a copy that
was unpacked by hand gets a proper installation when it updates. Someone who wants to stay portable
downloads the new zip from the release page.

**Two naming traps in the update path.** The capability id is `process:allow-restart` — the plugin's
command is `restart`, while its JavaScript wrapper is called `relaunch()`, so guessing
`process:allow-relaunch` fails the build with the plugin's whole permission list printed at you. And the
plugin's default TLS backend is `rustls-tls`, which drags in `ring`; this machine's windows-gnu toolchain
cannot build `ring` (`ar` cannot find the objects `cc` just wrote), so the dependency is declared with
`native-tls` instead — schannel, the system stack, no C build (see `Cargo.toml`).

**The key path must be absolute, and `cygpath -w` is not enough.** `TAURI_SIGNING_PRIVATE_KEY` accepts
either a path or the key's contents; anything the bundler cannot resolve is silently treated as contents and
base64-decoded, so the error names a character of the *path*: a posix relative path dies on symbol 46 (`.`,
the first character of `var/…`), and a relative *Windows* path dies on symbol 92 (`\`, at offset 3 of
`var\updater\…`) — which is what `cygpath -w` produces, because it converts a relative path into a relative
path. Use `cygpath -wa var/updater/markdownaura.key`. The 0.1.2 build failed exactly this way, and it fails
*after* the bundle has been written, so it leaves an installer with no `.sig` beside it — `make-latest-json`
then refuses, which is the right outcome.

## 13. Diagnostics — a log for crashes that leave nothing behind

**Status: implemented 2026-10-06, verified in a release build — §13.11 has the cases and the numbers.**
Numbered last on purpose: it is an appendix to §2–§12, and appending avoids renumbering the
cross-references that source comments make to `IMPL §3`, `§5`, `§6`, `§8`.

### 13.1 What is invisible today

A crash reported from another machine had **no evidence of any kind**, and that is a design gap rather than a
user's mistake. Four separate blind spots, each verified in the tree:

| failure | why there is nothing to read |
|---|---|
| Rust panic | release builds are `panic = "abort"` + `strip = true`, and `main.rs` sets `windows_subsystem = "windows"`. No console, no hook, no panic message, no location — the process is simply gone |
| front-end exception | no global handler exists (`grep -rn "onerror\|unhandledrejection" src/` → nothing). Every `catch` in `ipc.ts` is silent by construction |
| WebView2 renderer dies | tauri 2.12's `WindowEvent` has no render-process-gone variant (`tauri-runtime-2.12.1/src/window.rs:30`), and `wry` exposes no `ProcessFailed` callback. The window stays, the page is dead, and §2's "one Crashpad dump per launch, no error surfaced anywhere" was written from experience |
| abort / power loss / force-kill | no marker, no `run.end`, nothing |

The three `eprintln!` calls that *do* exist (`lib.rs:119`, `lib.rs:129`, `commands.rs:43` — a fourth,
`fs_ops.rs:472`, is test-only) reach no one: the release binary is a windowed process with no console
attached, so the text is discarded. The watcher additionally drops notify's error stream on the floor
(`watcher.rs:205`, `Ok(Err(_)) => {}`), which is the most likely silent degradation in the whole app: a
watcher that stopped working looks exactly like a file that stopped changing.

### 13.2 Decision: a hand-rolled `diag.rs`, and no new crates

`log`, `time`, `tracing` and `windows-sys` are already in `Cargo.lock` as transitive dependencies, and none
of them is needed. `src-tauri/src/diag.rs` is roughly 260 lines including tests, and it keeps the app's
one-dependency-one-justification rule intact (see the `getopts` removal and the `native-tls` note in §12).

`tauri-plugin-log` was the alternative and was rejected on coverage, not taste: it has no unclean-exit
detection, no crash-report file, and no way to locate the WebView2 data folder; its size-based rotation has a
public open issue (`plugins-workspace#707`, `max_file_size` has no effect on a `LogTarget::Folder` target —
verify against the current release before reconsidering). Its panic hook and rotation would cover perhaps half
of §13.5, and the rest would still be ours to write.

Two hard constraints on the module:

- **`diag::init()` is the first statement of `run()`**, before `tauri::Builder::default()`. A panic inside
  plugin init or `window.build()` has to be loggable, so nothing here may depend on a Tauri `AppHandle`.
- **Directory resolution is pure `std` + env**, in the same shape as `session::data_dir()`
  (`session.rs:161`). Tauri's path API needs a `Manager`, which does not exist that early.

Timestamps: epoch seconds to ISO-8601 UTC via a hand-written civil-date conversion (Hinnant's algorithm,
~15 lines, unit-tested against known instants). The machine's timezone offset is not computed in Rust — it
arrives once from the front end (below), which is also where the WebView2 version lives.

### 13.3 Where the logs live

```
Windows:  %LOCALAPPDATA%\MarkdownAura\logs\       (never the roaming %APPDATA%)
Linux:    $XDG_STATE_HOME/MarkdownAura/logs       (fallback ~/.local/state/MarkdownAura/logs)

logs/
  app.log                 the current file, 1 MB at most
  app.1.log … app.3.log   rotation, ≤ 4 MB in total
  crash/<ts>-<run>.md     one self-contained report per crash, 10 kept
  run.json                written while running, deleted on a clean exit
```

`session.json` stays in `%APPDATA%` (§6). Logs go to the state/data directory for two reasons that are not
interchangeable: a roaming profile has no business syncing 4 MB of rolling logs, and `XDG_STATE_HOME` is the
specified home for state that is not configuration. The About sheet already prints one directory with an
*open* button; §13.8 mirrors the row instead of introducing a new concept.

Resolution order, decided 2026-10-06 (§13.13): `MARKDOWNAURA_LOG_DIR`, else `Session.logDir` when non-empty,
else the platform default above. Pointing it at a synced folder is how a log from a second machine reaches
you without a server — which is the whole reason this section exists. A configured directory that cannot be
created falls back to the platform default and says so.

### 13.4 Line format, rotation, and two processes

One JSON object per line (NDJSON): greppable, machine-readable, and consistent with a tree whose other
persistent formats are all JSON.

```json
{"ts":"2026-10-06T13:22:04.512Z","lvl":"warn","run":"7f3a21","mod":"watcher","msg":"notify error","d":{"path":"E:\\notes","err":"…"}}
```

- A single `Mutex<File>` opened in append mode; one `write_all` per line. Lines are capped at 4 KB and
  truncated with `"trunc":true`, so one pathological message cannot eat the rotation budget.
- Rotation: `app.log` over 1 MB is renamed at startup, and again in-process once the byte counter crosses the
  cap. Same temp-then-rename discipline the session already uses (§6), for the same reason.
- Two processes coexist for a moment when a second launch hands its path over (the single-instance plugin
  kills it — see its `callback` docs). Append mode plus a 4 KB line cap makes the worst case one interleaved
  line, and `run.json` is only ever deleted by the process whose pid it records (below), so the marker
  survives a second instance cleanly.
- `run` is a 6-hex-digit id minted per launch, so lines from one run can be selected without a timestamp
  range — the front end reuses the same id on every line it reports.

### 13.5 The four capture paths

```
Rust panic ──► std::panic::set_hook ──┐
front-end error ──► diag.ts + IPC ────┼──► logs/app.log  (+ logs/crash/*.md)
unclean exit ──► run.json residual ───┤
WebView2 dies ──► crashpad dump + heartbeat gap
```

**1. Rust panic.** `set_hook` runs even under `panic = "abort"` — the hook is called, then the process
aborts, so this is the only recourse there is. The hook:

- writes `crash/<ts>-<run>.md` through a **freshly created** `File`, never through the main writer's mutex,
  which the panicking thread may already hold. The one-line entry in `app.log` is written only if
  `try_lock` succeeds; no flush, no deadlock, no second panic.
- records the message, `PanicHookInfo::location()` (compiled-in `file:line`, which survives `strip` and is
  usually the whole answer), the thread name, a backtrace or its raw frames, the last 50 lines of `app.log`,
  and the environment block.
- is guarded by an `AtomicBool` so a panic inside the hook cannot recurse.

**2. Front-end exceptions.** `src/diag.ts` installs `window.onerror` and `unhandledrejection`, plus a
pass-through for `console.error`/`warn`, and ships them to Rust over a new `log_event` command. A 250 ms
batch, a hard limit of 200 lines per minute per module (over that, one `suppressed=n` line), and a flush
before `relaunchApp()` — a render loop must not be able to fill a disk or to spam the IPC bridge.

**3. WebView2 death.** The data directory is **not** moved (that would be a behaviour change for every
existing install); it is *located and recorded*. Four candidates are probed in order — `<exe name>.exe.WebView2`
and `<exe name>.WebView2` next to the executable, then the same two under `%LOCALAPPDATA%` — and the first that
exists is written into the startup line; `unknown` when none does, which is the honest answer on
a machine whose runtime never created one. The Crashpad minidumps live under that folder's `EBWebView\Crashpad\`
(not confirmed on this machine: no profile directory exists beside the dev-build executable here, and the
release never moved it). Relocation stays available behind `MARKDOWNAURA_WEBVIEW_DATA` via
`WebviewWindowBuilder::data_directory`, which exists
(`tauri-2.12.1/src/webview/webview_window.rs:1089`) — an escape hatch in the same spirit as
`MARKDOWNAURA_BROWSER_ARGS` in §8, not a default.

The runtime's version needs no registry read: `navigator.userAgent` carries `Edg/<version>` on Windows and
the WebKitGTK version on Linux (the front end reports both, §13.7). The v1 limitation is standing: the app
cannot be *told* that the renderer died, so the evidence is the dump plus the shape of the log. The heartbeat
is Rust-side for exactly this reason, and it is what makes the two deaths distinguishable: a heartbeat that
keeps arriving while the front end's lines stop means the render process died and the window is a corpse; a
heartbeat that stops with no `run.end` means the process itself died.

**4. Unclean exit.** `run.json` holds `{pid, run, started}` and is written in `setup` — the earliest point at
which the single-instance plugin has already decided that this process owns the main window, so the
short-lived second process never writes or deletes it. `RunEvent::Exit` (and `ExitRequested`, which also
records whether the exit came from the window's close button or from `relaunch()`) deletes it when the pid
matches and writes `app.exit`. A residual file at startup therefore means the previous run aborted, and the
next launch logs `prev_run=unclean` with the old run id.

**The previous run is read once, at that moment, and kept in memory** — not re-read when the About sheet or
the report asks. The marker is a single file, so writing this run's destroys the evidence of the last one, and
a lazily-read `previous_unclean()` would return "clean" forever: the About row's unclean line could never
appear on any machine. The pure reader is correct either way, which is why this survived the unit tests and
only fell out of driving the shipped build over CDP with a seeded marker (§13.11).

`RunEvent::ExitRequested` is worth the second callback because the updater's relaunch is exactly the path that
must not be mistaken for a crash: `tauri-plugin-process` calls `app.request_restart()`, not `restart()`, so
`ExitRequested` and `Exit` are both delivered (tauri 2.12.1 `app.rs:606`) and the marker is removed before the
new process starts. A direct `restart()` from the main thread would skip both events — which is why making the
marker's deletion depend on the event *and* on the recorded pid is the safe pairing.

This is why `lib.rs` moves from `builder.run(context)` to `builder.build(context)?.run(|_app, event| …)`.

### 13.6 Instrumentation points

| where | what is logged |
|---|---|
| `lib.rs:62` `run()` | version, pid, argv, OS/arch, exe path, log dir, WebView2 data dir, whether `MARKDOWNAURA_BROWSER_ARGS` is set |
| `lib.rs:119`, `lib.rs:129`, `commands.rs:43` | the three surviving `eprintln!` sites, re-pointed at the logger (debug builds keep mirroring to stderr) |
| `watcher.rs:205` | notify's error stream, currently discarded |
| `watcher.rs:100` and every `#[tauri::command]` | already covered by the IPC wrapper in §13.7 — no per-command code |
| `session::save` failure, engine load/render failure, render over budget | `warn` / `debug` |
| front-end `main.ts:753` (session save swallowed) and `render/engines.ts:134` (d2 preload swallowed) | the two silent real failures; `dom.ts:38`-style clipboard misses are deliberately not logged |
| every file switch / view-mode switch | one low-frequency breadcrumb, so a report says which document and which mode was on screen |

### 13.7 Front-end: one wrapper covers every IPC failure

`ipc.ts` is the app's entire Tauri boundary (§2 rule 3), so wrapping `invoke` there logs **every** command
failure with the command name and the error, and none of the nineteen commands changes. The rule that comes
with it is absolute: **the wrapper logs the command name and the error, never the arguments** — `saveDoc`'s
arguments include the whole document text.

`src/diag.ts` (≈130 lines) owns the global handlers, the queue, the rate limit, and the environment block
that is sent once per run: `userAgent` (hence the WebView2/WebKitGTK version), timezone offset, screen size,
device pixels, UI language, and a best-effort WebGL renderer string. Rust cannot see any of these and a crash
report is much weaker without them.

### 13.8 Where it surfaces

No new window, no new overlay — the existing sheet shell (§10) and the existing rows:

- **About**: a diagnostics row next to the existing data row — the log directory with *open*. The row
  carried *export* (a `report-<ts>.md` written into that directory and revealed) and *copy* (the same
  Markdown to the clipboard) until 2026-10-08, when the product owner cut both: opening the folder is
  enough, because the files in it *are* the report, and the crash report a panic writes
  (`crash/<ts>-<run>.md`) never went through them. When the previous run was unclean, the row says so
  with its run id.
- **Settings**: two diagnostics rows. *Log level* (`off` / `error` / `warn` / `info` / `debug`, persisted as
  `Session.logLevel` with `#[serde(default)]` so existing session files load unchanged and
  `SESSION_VERSION` stays 1; `MARKDOWNAURA_LOG` overrides it for a reproduction run), and *log directory*
  (`Session.logDir`, empty meaning the platform default, with the dialog plugin's directory picker and a
  reset) — the control that puts the logs where a second machine can reach them.
- Startup is deliberately passive: a crashed run produces **no dialog**, only a line in the log and a
  sentence in the About sheet, matching the quiet boot check in §10.

New strings go into both catalogues in `i18n.ts` (the `zh` object is typed against `en`, so a miss is a
compile error).

### 13.9 Privacy rules

- Paths, byte counts, counts, durations and error kinds only. **Never document content, never a buffer.**
- No IPC arguments (§13.7) — that is the one place a document could leak in by accident.
- Front-end messages are `Error.message`, truncated to 200 characters. Diagram sources are never attached:
  mermaid's parse errors echo the offending line of the document, which may be private.
- The crash report's header states that it contains local paths, so a reader knows before attaching it.
- Nothing leaves the machine. The CSP already forbids it (`connect-src 'self' ipc: http://ipc.localhost
  blob: data:`, `tauri.conf.json:15`), the front end makes no request of any kind, and the app's one network
  call remains the click-driven updater (§10). **Diagnostics adds no server, no endpoint, and no telemetry.**

### 13.10 Files and size

| file | change | ≈ lines |
|---|---|---|
| `src-tauri/src/diag.rs` | new: writer, rotation, panic hook, `run.json`, tail, civil-time helper + tests | 260 |
| `src-tauri/src/lib.rs` | `init`, marker lifecycle, `RunEvent` callback, three `eprintln!` sites | 25 |
| `src-tauri/src/commands.rs` | five new commands (`log_event`, `set_log_level`, `set_log_dir`, `diag_status`, `open_log_folder`); two more (`diag_report`, `save_diag_report`) were removed on 2026-10-08 with the About row's *export* / *copy* buttons | 60 |
| `src-tauri/src/{watcher,session,markdown}.rs` | instrumentation | 12 |
| `src/diag.ts` | new: handlers, queue, rate limit, environment block | 130 |
| `src/ipc.ts` | `invoke` wrapper + five wrappers (two removed on 2026-10-08, with the report commands) | 36 |
| `src/main.ts` | `diag.install()`, two silent catches, flush before relaunch | 15 |
| `src/ui/{about,settings}.ts`, `index.html` | the About row and the two settings rows | 75 |
| `src/i18n.ts`, `session.rs`, `state.ts` | copy and the two new setting fields | 45 |

Unchanged: `tauri.conf.json` (no plugin, no CSP edit), `Cargo.toml` (no dependency),
`capabilities/default.json` (the new commands ride the existing IPC permission).

### 13.11 Build order and how each phase is verified

1. **`diag.rs` + hooks.** `cargo test --lib` for rotation, tail reading, the 4 KB truncation, the residual
   `run.json` decision and the civil-date conversion. Smoke: `MARKDOWNAURA_LOG=debug npm run tauri dev` and
   read the file that appears.
2. **Self-destruct hooks, in a release build.** `MARKDOWNAURA_SELFTEST=panic|abort|jserror` (compiled in,
   inert unless the variable is set — the same shape as `MARKDOWNAURA_BROWSER_ARGS`) plus a manual
   `taskkill /f /im msedgewebview2.exe` for the renderer case. **This is the acceptance test for the whole
   section**: three crashes that the old build reported as nothing must each produce a readable report.
3. **Front end.** Throw from the devtools console, reject a promise, break an engine load; confirm the lines
   carry the run id.
4. **UI.** Open the log folder, switch the level, and (with a `run.json` left behind on purpose) see the About row
   report the unclean exit.
5. **Docs.** SPEC §10 (the two rows), README's data row, release notes — see §13.14.

**How it was verified (2026-10-06, release build, rustc 1.99).** `cargo test --lib`: 61 pass. The cases below
ran against the tree as it stood before the 1.2.0 version bump — the code that ships is the same code, one
version string apart.
`var/diag-acceptance.ps1` — one PowerShell run, one log directory per case, driving the release binary
(Windows process control has to be PowerShell; a bash `taskkill` in this environment is not resolvable):

| case | observed |
|---|---|
| `MARKDOWNAURA_SELFTEST=panic` | exit `0xC0000409`, `run.json` left behind, one `crash/*.md` with `location: src\lib.rs:220`, thread `markdownaura-selftest`, the run id, the last 50 lines and the `env` entry |
| the launch after it | `previous run did not exit cleanly` naming that run id, then a clean close writes `app.exit` and removes `run.json` |
| `=abort` | exit `0xC0000409`, `run.json` left behind, **no** crash report — nothing can hook an abort |
| `=jserror` | the process survives and the file gets `{"mod":"ui","msg":"Uncaught Error: MARKDOWNAURA_SELFTEST"}` with source/line/col |
| the heartbeat | `{"msg":"alive","d":{"lines":3,"uptime":300}}` after five minutes, then a clean close |

`var/cdp-verify-diag.mjs` drives the shipped page over CDP (the recipe in §12); `var/cdp-shot-diag.mjs` is the
same driver with a screenshot, and `var/shots/diag-about.png` / `diag-settings.png` are what it produced. It
found the two defects the unit tests could not:

1. **`previous_unclean()` could never report anything.** It re-read `run.json`, which `mark_running` had
   already overwritten with this run's marker, so `status()` filtered out the only marker there was and the
   About row's unclean line was unreachable on every machine. Fixed by remembering what was on disk at
   startup (§13.5.4); the seeded-marker CDP run now shows `上次运行没有正常退出（运行 deadbe）`.
2. **The copy toast lied.** `dom.ts`'s `copyText` swallowed the clipboard promise, and About toasted
   "copied" regardless — and WebView2 *does* refuse the write (Chromium puts up a permission dialog). It now
   returns whether the write landed, and the toast follows it. (The About row that exposed it is gone —
   2026-10-08 — but `copyText` still backs the viewer's and the cards' copy buttons, so the fix and the
   lesson stay.)

Same run, positively: the About sheet renders the `logs` fact row with the effective path, the Settings level
control is wired to both halves of the filter — with the level at `off` a `console.error` produced **no** line,
and after switching back to `info` the same call produced exactly one. That run also exported the report
(`report-<ts>.md`: header, sharing warning, `previous run: unclean (run deadbe, …)`, the `env` entry scanned out
of the whole file, the last 200 lines) and revealed it — **removed 2026-10-08** with the row's *export* / *copy*
buttons (SPEC §10), along with `diag::report`/`report_in`/`save_report`, their commands, and the `report_in` test
that pinned that shape. The folder the remaining *open* button reveals holds the same evidence: `app.log` plus
`crash/<ts>-<run>.md` for a death.

### 13.12 Non-goals and honest limits

- **No automatic upload.** The app makes one network call, on a click (§10). It stays that way.
- **Import-time front-end errors are covered only from `main.ts` onwards.** ES module imports are evaluated
  before any statement of the module that imports them, so a throw while a dependency module is being
  evaluated happens before `diag.install()` can run. Closing that would mean a separate entry module that
  installs the handlers and only then imports `main.ts` — a `vite.config.ts` entry change this pass does not
  make. Dynamically imported engine chunks *are* covered: they load after boot.
- **No WebView2 `ProcessFailed` subscription.** It needs `webview2-com` and COM plumbing to learn something
  the Crashpad dump and the heartbeat gap already imply.
- **`panic = "abort"` costs the symbol names.** A backtrace from a stripped release binary is addresses, not
  names; `file:line` from `location()` is what actually locates the bug. Changing the strip or unwind policy
  for diagnostics is not worth the size and the behaviour change.
- **Nothing survives a hard kill mid-write.** The front-end queue is flushed on a 250 ms timer, so up to that
  much of the front-end's tail can be lost. Rust-side lines are already on disk.
- **A log proves what the app was doing, not always why it died.** If the root cause is a GPU/WebView2
  failure, the minidump is the artifact and the log is its context.

### 13.13 Decisions (2026-10-06, product owner)

1. **Default level `info`, with a 5-minute heartbeat.** ≈30 KB/day, and the heartbeat is what separates the
   two deaths in §13.5.3 — it is cheap and it is the reason the file is worth writing at all.
2. **`%LOCALAPPDATA%\MarkdownAura\logs` (Linux `$XDG_STATE_HOME`), with a configurable override in the same
   pass**: `MARKDOWNAURA_LOG_DIR`, a `Session.logDir` setting and a directory picker in Settings. The
   override is not a nicety — it is the only zero-server way for a log from a second machine to reach the
   person who has to read it.
3. **~~Clipboard *and* a saved file.~~ Reversed 2026-10-08 (product owner): the About row's `logs` fact
   keeps only *open*.** The original decision was *export* writing `logs/report-<ts>.md` and revealing it (so
   it can be dragged into an issue) plus *copy* putting the same text on the clipboard for pasting inline.
   Opening the folder is enough: the files in it are the report, and the panic hook's crash report never went
   through either button. The reasoning about *no pre-filled-issue button* still holds for any future
   affordance: it would cost a new entry in the `opener` allow-list (`capabilities/default.json:24`) and cannot
   carry a log through a URL.

### 13.14 Docs

Already written into this pass: SPEC §10 (the About `logs` fact row and the settings `diagnostics` row),
README and README.zh-CN (the About, Settings and Data rows). `THIRD-PARTY.md` is unaffected because no
dependency is added. Still owed at ship time: the release notes have to say where the log lives and how to
send it, and the version bump that ships this should mention the new `%LOCALAPPDATA%` directory so a reader
knows a second location now exists.
