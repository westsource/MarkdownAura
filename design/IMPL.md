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

Measured: the release binary is 6.7 MB (debug is 173 MB). Chunk resolution over the
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

The five overlay modules (find, viewer, settings, help, immersive) are implemented and wired in
`main.ts`. One of them deliberately stops short of a full feature: `ctrl shift P` shows the recent
list as a menu rather than a picker. The settings panel used to have a second one — a d2 install
button that reported the unimplemented download — and that row is gone now that d2 is bundled. The
`index.html` shell carries the markup for all five.

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
3. Exactly one module (`src/ipc.ts`) may call `invoke`/`listen` **or a plugin API**. Everything else
   calls a typed function. Verified: nothing outside `ipc.ts` names any of them — `openExternal` is
   the opener plugin's `openUrl` behind the same boundary, not a second door.
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
//    also widens the asset-protocol scope to `path`, or every relative image is a broken icon

#[tauri::command] async fn read_dir(path: PathBuf) -> Result<Vec<TreeEntry>>;
#[tauri::command] async fn resolve_target(path: PathBuf) -> Result<FolderView>;
// -> a file resolves to its own folder, a folder to itself. Lives in Rust because
//    `C:\file.md` minus its last segment is `C:`, not `C:\` — don't do this in TypeScript.

#[tauri::command] async fn read_file(path: PathBuf) -> Result<FilePayload>;
#[tauri::command] async fn render_doc(path: PathBuf) -> Result<RenderedDoc>;
// -> rendering happens in Rust (§4); the frontend never sees raw markdown for the preview
//    view. `encoding` is carried on the render result so the status bar can badge a lossy
//    read without a second round trip for the same file.
#[tauri::command] async fn reveal_in_explorer(path: PathBuf) -> Result<()>;
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
// -> { id, version, installed, bytes, path, optIn }[]   feeds the status bar dots (SPEC §3)

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
type EngineInfo = { id: string; version: string; installed: boolean; bytes: number;
                    path: string; optIn: boolean };
type WatcherStatus = { watching: number };
type StartupInfo = { path: string | null; last: boolean };
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

The frontend consumes `truncated` (status bar) but still ignores `eol` and `mtimeMs` — they
cross the boundary and are dropped. `eol` is harmless; `mtimeMs` is where a "file changed on
disk while you were not looking" check would come from if one is ever wanted.

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
- UTF-8 that will not decode is rendered lossily and the encoding rides back on the render
  result. An unreadable file must not blank the window.
- One `push_html` over the whole event stream, never one call per event: the writer carries
  footnote state across events and per-event calls shred footnote sections. There is a test
  for exactly this.
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
  ordinary fences, frontmatter, unterminated rules, footnote state and the line index.
- `node design/check-raw-html.mjs` asserts the same allow-list holds in the mockup, so the
  two renderers cannot quietly disagree.
- `src/render/pipeline.ts` copies mockup.js's card markup verbatim; review keeps it so.

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
};

type WindowState = {
  theme: "light" | "dark" | "system";
  zoom: number;                  // 50…200, multiplied with fontSize by prose.css
  fontSize: number;              // 12…22, written to `--doc-size`
  reduceMotion: boolean;
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

`%APPDATA%/MarkdownAura/session.json` (fallback `~/.config/markdownaura`), written on a
500 ms debounce that every mutating action schedules, and read once at boot. There is **no
save-on-exit hook**: a change followed by a close inside the debounce window is lost. If
that matters, the fix is a `getCurrentWindow().onCloseRequested()` that flushes the timer
— noted so the omission is a decision, not a surprise.

```json
{
  "version": 1,
  "window": { "w": 1216, "h": 809, "x": 680, "y": 116, "maximized": false },
  "theme": "system", "zoom": 100, "fontSize": 15, "reduceMotion": false,
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
- `fontSize`, `reduceMotion`, `lang`, `measure`, `outlineWidth` and `mdOnly` were each added after the
  first session format; all six are `#[serde(default)]`, so an older file still loads. Keep that
  property on any new field — the version stays 1 and a missing field must never mean "start clean".
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

`assetProtocol.enable: true` with an empty static scope: the scope is widened at runtime to
the folder the user opens (`open_folder`), not declared up front.

d2 is in the installer like every other engine, which is what makes the app's "no network at
runtime" claim unconditional. `IMPL.md` §9 carries the resulting sizes.

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
- `capabilities/default.json` is the app's whole permission surface: the window controls it needs,
  `dialog:allow-open`, and **one scoped opener permission** —
  `opener:allow-open-url` with `allow: [{ "url": "https://github.com/westsource/MarkdownAura" }]`.
  That single entry is what makes "the app can open exactly one URL" a fact rather than an
  intention; widening it is a security change, not a convenience one.
- native drag-drop is **a trap**: with `dragDropEnabled` the WebView never fires HTML5
  `dragover`/`drop`, so the empty state's tint cannot come from a CSS `:drop` state. It is
  driven from Tauri's drag events, which toggle the mockup's `.empty.dragover` class
  (`components.css` paints `--ac-bg`). The earlier note to "toggle `--ac-bg` yourself" was
  wrong in the mechanism and right in the requirement: the class is the mechanism.
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` is ineffective on this stack — wry passes explicit
  args that override it, which is why the app has its own variable.

CLI and single-instance:

- `markdownaura <folder|file>`. Parsing: the first non-flag argument wins, unknown flags are
  ignored (a stray argument from a shell integration must not stop the window from opening).
  There is no `--last`; session restore is unconditional (§6), and the flag was removed rather
  than kept as a no-op.
- `tauri-plugin-single-instance` (Windows only): a second launch forwards its path to the
  running window via `app://open` and focuses it, rather than opening a second window.
  Without this, "Open with MarkdownAura" on a `.md` file gives you a new window per file.
- `open_folder` widens the asset-protocol scope to the opened folder, or every relative
  image in every document is a broken icon.
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

**Bundle cost, measured 2026-10-03 (release).** `dist/` is 17 MB; the d2 chunk alone is 11.0 MB and is
code-split, so it is fetched on the first `d2` block rather than at boot. The release binary is 14.7 MB
(6.9 MB before d2 was bundled) and the NSIS installer is 11.58 MiB (3.36 MiB before). All of it is
install-time bytes — nothing is fetched at runtime (SPEC §4).

**d2's first card is the slow one, measured 2026-10-03** on `var/typecheck/diagrams.md`: the first d2
block reported 3837 ms (parsing the 11 MB module) and a re-render of the same document reported 19 ms.
The document's own text is painted before any card is resolved, so the wait is one card, not the page.
That is the whole price of not making d2 a download: no install step, and a slow first d2 block — the
status bar's `rendered in N ms` is where a reader sees it.

## 10. Testing

- **Rust: 31 unit tests, in-module** (`cargo test --lib`) — `session` (round-trip, unknown
  version, corrupt file, missing file, no temp file left, recent cap/dedupe/order);
  `fs_ops` (ignore rules, BOM detection, UTF-16 byte orders, truncation at the 8 MiB cap);
  `markdown` (the allow-list, normalisation, hostile input, allowed tags in paragraphs,
  heading ids/lines, heading text with inline code, diagram placeholders, `graphviz` alias,
  ordinary fences, frontmatter, unterminated rule, footnote state, line index); `watcher`
  (count skips ignored dirs, single file, missing root); `engines` (mermaid/dot always
  available, d2 the only `optIn`); `lib` (arg parsing, unknown flags ignored). An
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
- `node design/check-raw-html.mjs` asserts the allow-list holds in the mockup's stand-in
  renderer. It passes today. The mockup is the behaviour spec, so it must not quietly
  disagree with §4.
- `node design/check-prose-css.mjs` asserts the reading column is still centred: the centring rule
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
  `PrintWindow` returns black for WebView2, so it must use `CopyFromScreen`). Tauri's
  `listen` is an internal IPC channel, not a DOM event, so `emit()` from the page can
  synthesise `tauri://drag-*` for a drop-zone test. Two environment facts that cost time:
  a dev instance holds the build-script output file so `cargo test` fails with
  `os error 32` until the app is killed, and background jobs die with the turn, so the whole
  verify chain must run in one turn.
- The three states worth a screenshot on every change: empty state, a document with all three
  engines, and a document with a deliberately broken block.

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
  `catppuccin`-style syntax highlighting for non-diagram code fences is not designed; export
  (SVG/PNG/PDF) is out of scope for v1 (SPEC §11); raw HTML — the allow-list is deliberately
  short, revisit only if real documents need a tag that is missing, and add it as an
  exact-match entry, never as a parsing rule.
