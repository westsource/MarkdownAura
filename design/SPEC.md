# MarkdownAura — interface spec

Design source of truth. `mockup.html` is the reference implementation — open it in a
browser and click through it; this document explains the *why* behind each decision.

Stack assumption: Tauri 2 shell + WebView2, frontend framework-agnostic. The mockup is
vanilla JS so it ports without rework; the shipped app is vanilla TypeScript + Vite
(`IMPL.md` §1).

Scope convention: this document describes the **target** UX. Every section that differs
from the shipped app carries a **v1 status** note naming three things: what is
implemented, what is deferred *with its feature*, and what deliberately deviates. The
notes were last revised on 2026-10-04 against the running build (34 Rust tests, `tsc`
clean, production asset-protocol render verified, and the same build run on Linux).

Three terms are used precisely, because the difference between them is the whole point
of the status notes:

- **implemented** — the app does this today.
- **deferred** — designed, the structure is in place, the events are not wired; a v2
  wire-up, not a refactor.
- **deviates** — the app does something else and the difference is intentional. The
  target text stays so the deviation is a decision rather than an accident.

---

## 1. Product position

**A reader first, and now editable in place — on request.** Amended 2026-10-04 (product owner's
call): the reader's guarantees are unchanged and are still the default. What changed is that the
source pane can be edited deliberately; §12 is the design.

- The source view is read-only **until you ask otherwise**. In the reader's default state there is no
  caret, no undo and no save; the pane is a `<pre>`, not a `<textarea>`, and the `read-only` pill is
  the control that changes that (§12).
- Vertical space goes to content: the title bar hosts the tabs, the status bar is 26px.
- Chrome disappears on demand (`F11` immersive, `ctrl B` sidebar, `ctrl alt O` outline).
- Reading comfort is the product: `--measure` (a preset — 60ch, 100ch, or the whole pane),
  `line-height: 1.7`, two font weights only.

**Still out of scope:** editing the *rendered* view (WYSIWYG), and anything that would make this an
IDE — project-wide editing, completion, Git. Editing is a mode you enter; it is never the state the
app opens in.

## 2. Window anatomy

```
┌─ title bar (38px) ── logo · tab strip · [⋯] · ─ □ × ──────────────────┐
├─ toolbar (40px) ──── [sidebar] [preview|split|source] [↻] … [find] ────┤
│                               [outline] [↔] [theme] [settings] [i]      │
├─ sidebar (224px) ─┬─ content ───────────────────┬─ outline (200px) ───┤
│  explorer         │  preview / split / source   │  headings           │
│  filter           │  + find bar (floating)      │  diagrams           │
│  tree             │  + diagram overlay          │                     │
│  watching N files │                             │                     │
├─ status bar (26px) ── path · words · encoding · engine health · ms ───┤
└──────────────────────────────────────────────────────────────────────┘
```

**v1 status — title bar buttons.** The target has `[+]` (new tab, `ctrl T`) and `[⋯]`
(all tabs). The app shell carries `[⋯]` and it is **wired**: it lists every tab as a menu
with the current one marked, and `ctrl shift A` does the same from the keyboard. The `[+]`
button exists only in the mockup; the app has no new-tab button because `ctrl T` is not
bound. The rest of the tab context menu (close others / close to the right / pin / duplicate)
is still deferred (§5).

Tab overflow scrolls horizontally instead of wrapping, and the active tab is scrolled
into view on every switch — a jumping title bar is worse than a hidden tab.

**v1 status — window creation.** The window is built programmatically in
`src-tauri/src/lib.rs` (`WebviewWindowBuilder`), and `tauri.conf.json` carries
`"windows": []` on purpose. A restricted session (remote desktop, some sandboxes)
crashes the WebView2 browser process at startup — a correctly sized, perfectly dark
window and one Crashpad dump per launch, no error surfaced anywhere. `--no-sandbox`
fixes it, and that flag must never be a shipped default, so it is opt-in through the
`MARKDOWNAURA_BROWSER_ARGS` environment variable. Reading it requires the window to be
built in code. Settings: 1200×800, min 720×480, centred, `decorations: false`, drag-drop
enabled. `transparent` is left at its default (false).

Everything inside the title bar except the drag surface needs
`-webkit-app-region: no-drag` (already in `components.css`). Three chrome heights are
tokens (`--h-title`, `--h-toolbar`, `--h-status`) and must never grow.

## 3. Layout regions

### Sidebar (explorer)

- Resizable **180–640px** by dragging its right edge; the bounds are the `--w-sidebar-min` /
  `--w-sidebar-max` tokens, read at drag time so the design file stays the single source. The floor
  and the cap exist so a drag cannot leave the reading column no room; 360px was the cap and it is
  narrower than the paths the tree has to show on a wide display.
  `ctrl B` collapses it entirely.
- Skips the ignored directory names (`node_modules`, `.git`, build output).
- **Lists markdown only, by default.** A `md` switch at the right end of the foot row — accent when on,
  grey when off — shows files whose extension is `md` / `markdown` / `mdx` / `mdown` / `mkd`; switching it
  off lists every file.
  Directories always show — the tree is read a level at a time, so whether a folder holds markdown is
  not knowable without opening it. The rule is one list in `src/ipc.ts`, shared with the open dialog's
  filter and the drop/argument check.
- **The name filter is asked for, not in the way.** It sits in the foot row too, hidden until the funnel
  beside it reveals it — the input appears *before* the funnel and takes the free space, the watcher label
  yielding with an ellipsis. Revealing focuses the field, and its placeholder says how to leave: `esc`
  closes it. Closing **clears** the filter: a filtered tree with an invisible control is a state the
  reader can neither see nor undo. The reveal is a control, not a preference, so it is not persisted.
- Single click opens a **preview tab**, double click pins it (VS Code semantics — this is
  what keeps a folder with 200 files from becoming 200 tabs).
- Filter box narrows the visible tree; it does not search content.
- Foot shows `watching N files`. This makes the watcher observable instead of silently
  failing.

**v1 status.** The ignore list is **fixed in Rust** (`fs_ops::is_ignored_dir`): any name
starting with `.`, plus `node_modules`, `target`, `dist`. It is deliberately *not* a
setting — the tree and the watcher's `N files` counter read the same function, so they
cannot disagree about what exists. The settings-panel chips in §10 are therefore target
UX, not shipped.

**The explorer's markdown-only toggle ships, on by default.** It is a *view* filter in
`src/ui/tree.ts`, not a change to `fs_ops::list_dir`: `TreeEntry.ext` (lowercase, dotless) decides,
the `md` switch in the foot row is the control, and the choice persists in the session
(`IMPL.md` §6). Applying it in Rust was the other candidate and was rejected: the watcher's
`watching N files` counts what is *watched*, not what is *shown* — a `.txt` beside a document still
reloads it — and a listing that hides files would have to be re-fetched on every toggle. An empty
result says `no files match the filter` when the filter box has text, and `no markdown files here`
otherwise.

**v1 status — resizing ships.** Both side panels are draggable: the sidebar's right edge and
the outline's left edge. Widths live in `--w-sidebar` / `--w-outline`, written by JS, so a drag
is one `setProperty` and never a layout rewrite; the bounds come from the matching
`--w-*-min` / `--w-*-max` tokens. The handle is a child of the panel it resizes, which is why a
closed panel (user toggle or the responsive media query) cannot leave a stray handle behind —
there is no second place deciding whether a handle shows. Widths persist in the session
(`IMPL.md` §6).

Two consequences worth keeping: the outline's own box no longer scrolls (an absolutely
positioned handle inside a scroll container scrolls away with the content), so its list lives in
an inner `.outline-scroll`; and the split view's `#splitter` keeps its own fixed range, it is not
the same control.

### Content area

Three view modes, one segmented control:

| mode | icon | content | use |
|---|---|---|---|
| `preview` | single column, text lines | rendered markdown, full measure | reading — the default |
| `split` | column split by a vertical rule, lines only on the left | source left (soft-wrapped), rendered right, draggable splitter | checking a diagram block against its output |
| `source` | chevrons `‹ ›` in a frame | read-only highlighted markdown, editable on request (§12) | copying a block, checking raw syntax |

**The switch is icons, not text.** (Decision confirmed 2026-10-01; implemented in the
mockup, `index.html` and `components.css`.) Rationale: view mode is a set-once,
low-frequency control — it must not carry the heaviest visual weight in the toolbar (text
was ~196px; icons are ~86px, leaving `find` as the only text-labelled control, which is
correct since find is high-frequency and its kbd hint teaches the shortcut). The three
modes are layout shapes, so their meaning is directly drawable. Icon+text hybrid was
rejected: wider than text alone, fully redundant.

Icon rules: all three share one outer frame; they differ **only by interior marks** —
frame-shape variation is invisible at 15px. Do not use a file icon for `preview`, it
collides with the tree's file icon. Discoverability is covered by tooltip, `aria-label`,
and an accent-coloured active state (colour, not just background).

**The active segment must not be a background step alone.** `.segmented button.on` paints the accent
tint with the accent icon — the same "engaged" treatment `.iconbtn.on` gives the sidebar and outline
toggles, and the text variant takes `--ac-tx` plus weight 500. The first version was a `--bg` chip on
a `--code` track: #ffffff on #f5f4f1 is a ~4% luminance step, and it read as "no state at all" — the
mode you were looking at was the one thing the switch did not say. The accent tint is the app's
existing signal for "this one is on"; do not replace it with a subtler one.

`split` stays. Diagram-heavy docs are maintained by comparing source and output; removing
it would push users back into an editor. The right pane gets `.prose.compact` (13px, and
`prose.css` multiplies `--doc-size` by .867 with `--zoom`) because it has half the width; the left
pane multiplies the *same* two knobs by the *same* .867, so the source and its rendering sit beside
each other at one size. In the source *view* there is no compaction — the pane is set at exactly the
prose body size, which is what makes source and preview the same document at the same scale.

**Source text soft-wraps.** Both the source view and the split source pane wrap
(`white-space: pre-wrap`), and long unbreakable tokens break (`overflow-wrap: anywhere`) — otherwise
a single URL pushes the pane back into horizontal scrolling, which is what wrapping was for. The
source *view* always did this; the split pane was the one place it did not, which is why it grew a
horizontal scrollbar in a pane that is half the window. If line integrity ever matters more than
width, that is one rule in `prose.css`.

### Reading width — one column for everything

The measure is a *setting*, not a typographic constant: a fixed value is a fraction of the pane that
depends on the pane, and on a 3440px display the old fixed `72ch` came to 582px in a 3016px content
area — 19% of the screen (measured at 15px). It stays a **preset with three values** rather than a
free slider, because line length is the one typographic knob a reader can genuinely wreck.

- **One column for everything.** Every direct child of `.prose` carries the same limit — headings,
  body text, tables, fenced code and diagram cards — so both edges line up across block types. The
  alignment is structural (one rule, one token), not a convention a new block type can quietly opt
  out of. Two consequences are accepted rather than worked around: a table wider than the column
  scrolls horizontally inside it (`.prose table { overflow-x: auto }`), and a large diagram is scaled
  down to the column — the diagram viewer is where you look at one big.
  - The rule is `max-width: var(--measure); margin-inline: auto` on the **children**: the container
    fills the pane and the blocks are centred. On the container instead, a block could never be
    narrower or wider than the text column.
  - It is also why no block rule in `prose.css` may use the `margin` **shorthand**: a shorthand zeroes
    `margin-inline` for that element, and its specificity (0,1,1) beats the centring rule (0,1,0) —
    leaving exactly that block flush left while every other block stays centred. That shipped once
    (`.prose p`, and it is invisible to a width measurement: the box is the right size, in the wrong
    place), so `node design/check-prose-css.mjs` now fails instead (`IMPL.md` §10).
- **The limit is resolved once, into pixels, not left as `ch`.** `ch` is resolved against the *using*
  element's font, so a `72ch` token on an `h1` (22px) is 40% wider than the same token on a
  paragraph (16px): the "column" came out ragged, with headings jutting past the body text by up to
  40% (measured 733px vs 518px at 60ch before the fix). One measurement against the prose font
  (`src/measure.ts`) gives every block the same column — measured after: 518px for `p`, `h1`, `h2`,
  `ul` and `blockquote` alike at 60ch. The token therefore has to be recomputed whenever the
  document font size or the zoom changes, and once more when webfonts settle; the status-bar tooltip
  shows the resolved figure and its share of the pane (`阅读宽度 — 舒适 · 1035px · 57%`) so the number
  on screen is never a mystery.
- Consequence worth knowing: the resolved column is the same pixel value in both split panes, and a
  half-width pane is narrower than it, so in split view the pane — not the measure — is the binding
  constraint.
- **Three presets: narrow 60ch / comfortable 100ch / full 100% of the pane.** `comfortable` was 72ch
  and was raised to 100ch on the reader's call: 72 sits in the classic 45–75-character band, while
  on-screen technical reading (docs sites, code hosts) runs 80–120, and `narrow` covers long-form
  prose. The two measured presets are in `ch` because that is the only unit that keeps a line
  *readable* whatever the window size; `full` is a percentage, because there the request is "use the
  pane", which is what a percentage measures. Mixed units are deliberate — the preset names say what
  each one is for.
  - Cost of `full`, stated plainly: on a 3016px pane a 100% column is ~350 characters per line at
    16px. That is the reader's explicit choice, and the tooltip reports the resolved width and its
    share of the pane (`阅读宽度 — 撑满 · 100%`) so the number is never a mystery.
- **Four entry points, one field** (see §10): the status-bar chip (carrying a `↔` icon, because its
  meaning is not its value) and the toolbar button both open the preset menu, `ctrl shift M` cycles
  from the keyboard in any mode, and the immersive bar repeats the chip. All of them write
  `state.measure`, persisted by *preset name* so the table in `src/measure.ts` stays the single
  definition.

**Split scroll — synced, both directions.** Scrolling either pane moves the other continuously;
entering split from a scrolled preview opens already aligned. The mapping is **anchor + pixel
fraction within the segment**, because anchors alone would make ordinary prose snap from heading
to heading:

- The anchors are the headings and the diagram cards — `hN` / `dN`, the only positions both panes
  can identify (the source pane carries them as `data-anchor`, the rendered pane as `id` /
  `data-diagram`).
- Between two anchors the mapping is linear in pixels. The two panes render the same document at
  different heights (in the sample doc the rendered pane is ~1.9× the source), so "the same place"
  is exact *at* an anchor and approximate in between — tens of pixels over a ~900px viewport.
  Closing that gap needs per-line line numbers on the rendered output, which `markdown.rs` does not
  emit; do not pretend the current mapping is pixel-identical.
- A programmatic write is remembered per pane, and the scroll event it causes is ignored. Without
  that echo guard the two panes push each other forever.
- The per-tab scroll position (SPEC §5) is the **rendered pane's**; the source pane is aligned from
  it on restore, so a session never stores two positions that can disagree.
- A document with no headings and no diagrams falls back to proportional scrolling: wrong in
  detail, right in direction.

### Outline

- **Expanded by default**, 200px, resizable **160–360px** by dragging its left edge
  (`--w-outline-min` / `--w-outline-max`), `ctrl alt O` to hide.
- Two sections: heading tree (indented by `data-level`, headings of level 1–4 only),
  then a diagram list with engine badges.
- **Clicking an entry scrolls every pane the current view shows**: preview scrolls the rendered
  pane, split scrolls the rendered pane *and* the source pane, source scrolls the source pane.
  The target lands 12px below the pane's top edge. Split scrolling both is the point of split —
  a jump that moved only the right pane leaves the reader comparing two unrelated regions.
- Anchors: the rendered pane uses the heading `id` (`h0`) or the card's `data-diagram` (`d0`);
  the source pane gets a `data-anchor` on exactly those lines (`markdown.rs` reports the line for
  both kinds). Only those lines carry an anchor — stamping every line would add an attribute per
  line for anchors nothing can reach.
- A document-wide query is **not** acceptable here: it finds the first match, which may live in a
  hidden view, and then scrolls nothing at all. The lookup is scoped to the visible panes.
- Auto-hides below 1000px window width; sidebar below 720px. Both are CSS media queries in
  `components.css` so the responsive fallback works even before JS wires up.
- **Implementation warning — now handled in the app.** The mockup toggles panels with an
  inline `style.display`, which wins over those media queries — at narrow widths the
  toolbar button keeps its `.on` state while the panel is hidden, i.e. the button lies.
  `main.ts applyLayout()` implements the fix the mockup lacks: it stamps
  `display: ""` (never `none`) when a panel is open, so the media query keeps ownership of
  the narrow case, and only sets `display: none` when the *user* closed the panel. Keep it
  that way; re-introducing a blanket inline `display` re-breaks the responsive fallback.

**v1 status — diagram entries.** The target is "scrolls to the card *and* opens the
viewer". The app scrolls the card into view — plus the matching source line when the pane is
showing — and does not open the viewer; that stays a deliberate click on the card's zoom button
(§4). Deviates.

### Status bar

Left: path, word count, encoding. Right: three engine health dots, render time, **the update chip when a
release is newer** (absent otherwise — it is the only control in this row that comes and goes), **reading
width**, zoom. The path is the only unbounded item in the row, so it ellipsises rather than pushing the
controls off the edge.

The engine dots are the honest answer to "is this thing offline?" — green when the WASM
module loaded, amber while loading, red if it failed, and **grey until the engine has been
loaded at all**. All three engines ship inside the app (§4), so grey is a "not yet", never
a "you have to install this". `off` and `failed` are different states with different
colours; do not merge them. Render time in milliseconds is shown because it is the
product's whole claim.

Two decode facts change the status bar's shape, both as warn marks rather than silent
substitutions. A `utf-8-lossy` decode turns the encoding text into a warn dot plus the
label, with a tooltip saying invalid bytes were replaced — the file still renders, and the
mark says the screen is not byte-exact. A document past the 8 MiB read cap adds a
`truncated` mark after the encoding: what is on screen is a prefix of the file on disk, and
saying so is the only honest option short of refusing to open it.

## 4. Diagram cards

Fenced ` ```mermaid `, ` ```dot `, ` ```graphviz ` and ` ```d2 ` blocks become cards, not
inline SVG dumps. `graphviz` is an alias for `dot` (`markdown.rs::diagram_lang`): people
write it as often, and the badge should name the engine either way.

```
┌ badge · title · line N ──────────────── [zoom] [copy] ┐
│                                                        │
│                     rendered svg                       │
│                                                        │
└────────────────────────────────────────────────────────┘
```

- Badge colour identifies the engine: mermaid purple, dot teal, d2 amber
  (`--eng-*` tokens). Consistent in cards, outline list and the viewer header.
- Card head carries the source line number — that is the bridge back to `split` view.
- The card's `[zoom]` button opens the **viewer overlay**; `[copy]` copies the diagram
  source. **The whole card is not clickable** — the app opens the viewer from the button
  only, where the target said the card would open it. Deviates; the target text stands as
  the design if it is revisited.
- **Failures render inline** as a red band with the line number and the offending engine
  message. A broken block must never blank the page or throw away the rest of the
  document. This is the one rule that must not regress.
- Viewer overlay: `− / % / +` zoom (the `%` resets to 100% and re-centres), wheel zoom,
  drag to pan, `copy svg`, `copy source`, `esc` to close. The SVG is **cloned from the
  card**, never re-rendered — re-rendering a large graph to open a viewer would be a
  visible stall. The footer names the engine and repeats the interaction hints.

**v1 status — viewer footer.** The target footer carried the engine's render time. The app
shows the engine name plus `scroll to zoom · drag to pan · esc to close`; the card's render
time is on the card and in the status bar, not duplicated here. Deviates (harmless).

### Engine loading — measured, not assumed

Sizes below were read off the npm registry on 2026-10-01, not estimated. The "~1.2 / 0.8 / 2.1 MB"
figures this document previously carried were wrong; the corrections matter enough to change the
packaging plan.

| engine | package (licence) | shipped cost | notes |
|---|---|---|---|
| mermaid | `mermaid@12` (MIT) | **29 KB entry**, chunks on demand | The ESM build is code-split: 104 chunks, 5.18 MB on disk, but only the entry plus the chunks for the diagram types actually used get loaded. `dist/mermaid.min.js` — the monolith — is 5.3 MB and must **not** be used. |
| dot | `@hpcc-js/wasm-graphviz@1.29.2` (Apache-2.0) | **~0.9 MB** | 13 files, zero dependencies. The wasm is inlined into the JS, so there is no separate `.wasm` to ship or fetch. |
| dot (alternative) | `@viz-js/viz@3.31.0` (MIT) | ~1.2 MB | One self-contained file, MIT rather than Apache-2.0. Take this one only if the Apache licence or the `@hpcc-js` API is a problem. |
| d2 | `@d2lang/d2@0.1.34` (MPL-2.0) | **11.5 MB** | `dist/browser/index.js` (11,514,165 bytes) is the one file the frontend imports: wasm inlined, and the package runs it in its own worker. Bundled, like the other two. The document's text paints before any card does, so the first `d2` block is the only thing that waits — measured 3.8 s for that parse on this machine, and 19 ms for a re-render once the module is resident. The module is started early on purpose: `paint()` preloads it the moment a document is known to contain an **uncached** d2 block, and `warmHeaviestEngineOnIdle()` preloads it once per session, on idle, after any document that has diagrams has rendered. So the parse normally happens while the reader is still reading, and what remains for the first d2 card is the render, not the parse. |

Consequences, in order:

1. **d2 ships bundled — a reversal, decided 2026-10-03.** The first pass kept it out of the bundle on
   size grounds (11 MB against a then-3.4 MB installer) and made it an opt-in download driven from
   settings. The product owner reversed that: the offline guarantee is worth more than the bytes, so
   all three engines ship and nothing has an install step. The download it replaces — `engine_install`,
   `engine://progress`, a scan of `%APPDATA%/MarkdownAura/engines/d2/` — was never built and is now
   deleted rather than deferred (`IMPL.md` §3, §7). What it cost, measured: `dist/` is 17 MB, of which
   the d2 chunk is **11.0 MB and is not part of the initial load** — Vite code-splits it and the
   browser fetches it on the first `d2` block, like mermaid's chunks — and the release binary grew
   from 6.9 MB to **15.3 MB**. Installer figures: `IMPL.md` §9.
2. **Never import the mermaid monolith.** 5.3 MB versus a 29 KB entry point. This is the single
   largest packaging decision in the app. Verified in production: the code-split chunks resolve
   over the `tauri://` asset protocol.
3. **The d2 package was renamed** to `@d2lang/d2`; `@terrastruct/d2` survives only as a
   compatibility alias. Pin the new name.
4. **Licences differ per engine** — MIT / Apache-2.0 / MPL-2.0. MPL-2.0 is file-level copyleft:
   fine to ship unmodified, but d2's files must stay separable and the notices must ship. That is
   why `THIRD-PARTY.md` exists, is generated from what the build actually resolves
   (`npm run notices`), and ships next to the executable together with `LICENSE`; the engine table in
   the About sheet is the in-app half of the same obligation. The Rust dependency graph is listed by
   SPDX identifier rather than with each crate's full licence text — if the app is ever published,
   generate the texts (e.g. `cargo about`) and ship those too.

Nothing is fetched while you read — every engine's wasm is inlined in the bundle, which is what makes
"no network calls" literally true. The two exceptions are both explicit and neither happens on its own:
the installer's WebView2 bootstrapper, on a machine with no WebView2 Runtime (`IMPL.md` §8), and the
update check in the About sheet, which runs when it is clicked (§10).

**v1 status — d2 ships.** It was the one opt-in download, and the download was never built; it is a
bundled engine now, so `engine_status` reports `installed: true` for all three and there is no install
step left to detect. `IMPL.md` §7 has the loading details, §9 the resulting sizes.

## 5. Tabs

Minimal by design, but correct:

- Six states: `active`, `inactive`, `hover`, `preview` (italic), `missing` (strikethrough —
  the file could not be read), `reloading` (amber dot replaces the file icon while the watcher
  re-renders).
- Class naming, so the two do not collide: the shipped preview state is **`.tab.preview`**;
  **`.tab.pinned`** is reserved for manual pinning (§v1 status below) and must not borrow
  the preview italic. No pin action ships, and `components.css` has **no rule for
  `.tab.pinned`** — the class is emitted because the mockup emits it, nothing more. Do not
  read its presence as a styled state.
- Close button is always laid out on the active tab and hidden-but-space-reserved elsewhere,
  so tabs do not jitter on hover. It is a `<button>` inside a `<span>`-era stylesheet, so
  `.tab-close` must strip the UA chrome (`border`, `padding`, `background`, `cursor`) the
  way `.tabbtn` and `.iconbtn` do — without that the app rendered a native grey beveled box
  on every tab while the mockup's `<span class="tab-close">` did not, and the shared
  stylesheet hid the difference. It is a real regression that shipped once; the reset is not
  optional. Hover state uses `var(--tx)` on `var(--line-2)` and must be written as
  `.tab .tab-close:hover` so it outranks the resting rule.
- Geometry: height 30, radius `8 8 0 0`, min 96, max 200, middle-ellipsis for long names.
- Overflow: compress to min width → scroll horizontally → the `⋯` / `ctrl shift A` all-tabs
  menu. All three ship.

### v1 status — what the app actually ships

**Implemented**

- open / switch / close tabs; one tab per file, opening an already-open file activates it
  (path comparison is case-insensitive and separator-insensitive — Windows identity)
- preview-tab semantics: a single tree click reuses *the one* preview tab rather than
  opening a second, a double click pins it
- the four reader states `active`, `inactive`, `hover`, `preview`, **plus `missing` and
  `reloading`**: a failed load marks the tab `missing`, a removal event from the watcher
  marks it `missing` too, and a watcher batch marks it `reloading` for the duration of the
  re-render. Wiring the two v2 fields cost nothing — the record and the CSS already existed
  — so they ship rather than being documented as absent.
- per-tab state: view mode, scroll position, find query/case/hit
- overflow: compress to min width, then horizontal scroll, active tab scrolled into view,
  then the `⋯` / `ctrl shift A` all-tabs menu
- `ctrl W` close, `ctrl tab` / `ctrl shift tab` cycle, `ctrl 1…9` jump
- middle-click closes a tab
- live reload reaches **every** open tab: the visible one re-renders, a background one drops
  its parsed document and reloads when it is activated. A background tab silently showing
  stale text is the failure the watcher exists to prevent.
- session restore: the last tab set reopens on launch

**Deferred (target UX above, not shipped)**

- the right-click tab menu (close / close others / close right / close all / pin / copy
  path / reveal in explorer / duplicate)
- tab drag-to-reorder and drag-out-to-new-window
- pin/unpin as a user action, and with it any `.tab.pinned` styling
- `ctrl T`, `ctrl shift W` (§7)

**v1 status — `missing`.** Both routes now work: a failed load marks the tab `missing`, and
the watcher's `fs://removed` batch — which Rust emits separately from `fs://changed` — marks
every matching tab. The parsed document is deliberately *kept* on removal, so a stricken tab
stays readable until the file returns; a `fs://changed` for the same path clears the mark and
reloads. Only the tab *strip* changes on removal; the content pane is not blanked.

### Per-tab state — the part that is easy to get wrong

Each tab remembers its own:

- view mode (`preview` / `split` / `source`)
- scroll position
- find query, match-case flag and hit index

Window-level (shared, *not* per tab): theme, zoom, document font size, reduce-motion,
language, sidebar/outline visibility, and both panel widths.

Switching tabs must restore all values. Losing the scroll position on every tab switch is
the single most annoying failure mode of a multi-tab reader; view mode is the same bug in
slower motion, and both were real regressions caught in verification — `paintActive()`
re-selects the tab's view on every switch, and `captureScroll()` runs before every switch
away.

**v1 status — outline highlight is not per-tab.** `Tab.outlineHit` exists in the record but
is never written or read; the outline shows the active tab's current heading from the
scroll spy only. Per-tab outline memory is deferred with the field. Do not "clean up" the
unused field — it is the v2 contract.

## 6. Empty state

The window opens here when no folder is loaded. It is also the drop target.

- Dashed dropzone, one line of copy, `open folder` (primary) / `open file`.
- Three shortcut hints (`ctrl O`, `ctrl shift P`, `F1`).
- Recent entries as links (the three most recent).
- Dragging a file over it tints the whole area (`--ac-bg`) so the drop affordance is
  obvious. With native drag-drop enabled the WebView fires no HTML5 drop events, so the
  tint is driven by Tauri's core drag events adding `.empty.dragover` — see `IMPL.md` §8.

## 7. Keyboard map

| key | action | v1 |
|---|---|---|
| `ctrl O` | open file | implemented |
| `ctrl shift O` | open folder | implemented |
| `ctrl alt O` | toggle outline | implemented |
| `ctrl T` | new tab | **not bound** (mockup-only, §5) |
| `ctrl W` | close tab | implemented |
| `ctrl shift P` | recent files (top 8, as a menu) | implemented |
| `ctrl shift W` | close all tabs | **not bound** |
| `ctrl tab` / `ctrl shift tab` | next / previous tab | implemented |
| `ctrl 1…9` | jump to tab N | implemented |
| `ctrl shift A` | list all tabs | implemented |
| `ctrl B` | toggle sidebar | implemented |
| `ctrl F` | find in document | implemented |
| `enter` / `shift enter` | next / previous match (while the find bar is open) | implemented |
| `ctrl R` | re-render | implemented |
| `ctrl E` | edit the source pane (toggle) | **not bound** (§12) |
| `ctrl S` | save | **not bound** (§12) |
| `ctrl ,` | settings | implemented |
| `ctrl +` / `ctrl -` / `ctrl 0` | zoom in / out / reset | implemented |
| `ctrl shift M` | cycle reading width | implemented |
| `F11` | immersive | implemented |
| `F1` | help | implemented |
| `esc` | dismiss one layer (see below) | implemented |

Keys marked **not bound** are design intent that has no handler in the app yet; they
exist in the mockup's keymap so the shape is recorded.

> **Resolved 2026-10-01.** `ctrl shift O` was bound to both "open folder" and "toggle
> outline". **Open folder keeps `ctrl shift O`** (VS Code muscle memory, and it is the
> higher-frequency action); **toggle outline moves to `ctrl alt O`**. Both are implemented.
>
> **AltGr caveat:** Windows synthesises AltGr as ctrl+alt, so on layouts where AltGr+O
> composes a character, `ctrl alt O` is unreachable. If that surfaces on the dev machine,
> fall back to `ctrl shift K` (currently unbound).

`esc` dismissal is ordered, and the app's order is the **reverse of opening order**: menu
→ diagram viewer → settings → help → about → find bar → **edit mode (§12)** → immersive. Only one
layer closes per keypress. Leaving edit mode with unsaved changes asks first, which is why it belongs
inside this chain rather than beside it.

**A menu also closes on any pointer press outside it, and a second press on the control that opened
it closes it** — the control is a toggle. One rule, one implementation (`dom.ts`): every menu opened
by a control passes that control to `showMenu`, which is also what positions the menu. Menus opened
from the keyboard (recent files) have no control and simply dismiss on the next press anywhere.

**The help table and the dispatcher are two lists.** `src/ui/help.ts` owns `KEYMAP` and the
panel is generated from it; `main.ts` owns a hand-written `switch`, and the two are kept in
step by review. They agree today, but nothing enforces that — either generate the dispatch
from the table, or add a test that asserts the two lists match. Until one of those exists,
adding a key means editing two files and the help panel can silently go stale.

## 8. Visual language

- **Flat.** No gradients, no shadows, no blur. Elevation comes from 0.5px hairlines at three
  strengths (`--line`, `--line-2`, `--line-3`) plus background shifts.
- **Two weights on the reading surface**, 400 and 600 (`--fw-emphasis`). 500 would be the obvious
  middle and it is the one weight these fonts do not have: "Microsoft YaHei UI" ships Regular and
  Bold only, so a request for 500 was rendered as Regular and every heading and every `**bold**` run
  in a Chinese document came out at body-text weight — the failure was invisible in English and
  total in Chinese. 600 takes Segoe UI Variable's Semibold and makes YaHei reach for Bold, so
  emphasis reads in both scripts. Chrome may still ask for 500 on a UI label
  (`.segmented button.on`), where colour is carrying the state anyway.
- **Heading sizes are `em`, never px** — multiples of the prose base (`--doc-size` x `--zoom`), so one
  control moves the whole document. The scale is 1.47 / 1.27 / 1.13 / 1em for h1–h4 (22 / 19 / 17 /
  15px at the default size; h5 and h6 are grouped with h4 and carry their level through weight and
  spacing). Fixed-px headings fell behind the body the moment the reader raised the size or the zoom,
  and h3–h6 shipped *smaller* than body text because their values were lifted from the 13px UI scale.
- **One accent.** Purple `#534ab7` (the "aura"), used for: active tab bar, active tree row,
  links, focus rings, primary buttons, mermaid badge. Nothing else is saturated.
- **Sentence case everywhere** — `open folder`, not `Open Folder`. Lowercase UI reads as
  tool-like rather than corporate.
- Radii: 6px badges/chips, 8px buttons/inputs/tabs, 12px cards/overlays/window.
- Icons are inline SVG, 1.1–1.3px strokes, no icon font, no emoji.
- Motion is 90ms/140ms `ease-out`. Reduce-motion is honoured twice: the OS query in
  `tokens.css` zeroes the motion tokens, and the settings toggle stamps
  `[data-motion="reduce"]` which does the same — the in-app control exists because the OS
  setting is not always the reader's wish. Nothing animates on scroll or on render.

Dark mode is a full token swap under `[data-theme="dark"]`, not a filter. The accent lifts
from `#534ab7` to `#b3adf0` to hold contrast on dark surfaces; semantic and engine colours
do the same. Follow the OS by default, with a manual override in settings; a `system`
selection re-resolves on OS change rather than freezing the value at startup.

See `tokens.css` for the complete palette — it is the only place colours may be defined.

## 9. Files

| file | role |
|---|---|
| `tokens.css` | every colour, size, radius, height, duration. Import first. |
| `components.css` | chrome: window, tabs, toolbar, panels, cards, overlays, menus, status bar |
| `prose.css` | rendered markdown only, scoped under `.prose`. Also the source-view highlighting (`.src .h/.em/.code/.meta/.quote`) |
| `mockup.html` | interactive reference — open in a browser, no build step |
| `mockup.js` | behaviour spec: state shape, tab logic, find, menus, keyboard map |
| `check-raw-html.mjs` | asserts the mockup honours the raw-HTML allow-list (`IMPL.md` §4) |
| `check-prose-css.mjs` | asserts the reading column stays centred (`IMPL.md` §5): no `margin` shorthand may reach a direct child of `.prose` |
| `IMPL.md` | the build contract: repo layout, IPC surface, state shape, persistence, engine packaging |

`prose.css` is kept separate because it is the one stylesheet that styles rendered content, and
it is scoped under `.prose` so it cannot reach the chrome.

Raw HTML in a source document is **not** passed through. Only a short exact-match allow-list
survives, and the tags on it — `<details>`, `<summary>`, `<kbd>`, `<sub>`, `<sup>`, `<br>`,
`<hr>` — are the ones `prose.css` styles. `components.css` also carries a *global* `kbd`
rule for the chrome, which is exactly the leak `.prose kbd` exists to pin down. The policy,
and the reason it is an allow-list rather than a sanitiser, live in `IMPL.md` §4.

The mockup hand-draws its diagram SVGs. The real app calls the engines — the card, badge,
overlay and error markup in `mockup.js` (`renderMarkdown`) is what was ported, and
`src/render/pipeline.ts` keeps the class names byte-identical so the two share one
stylesheet.

## 10. Settings, immersive, help

Three entry points had been in the chrome with nothing behind them. All three reuse the
existing overlay shell (`.overlay` > `.sheet`), so the app gains no new window and no new
surface type. This section is the design; `IMPL.md` is where each row's state is specified
and persisted.

### One shell, four panels

| panel | sheet | body |
|---|---|---|
| settings | `.sheet.tight` (560px) | top-aligned, scrolling (`.sheet.form`) |
| help | `.sheet.wide` (640px) | top-aligned, two columns |
| about | `.sheet.tight` (560px) | top-aligned, scrolling — a colophon page, not form rows |
| diagram viewer | `.sheet` (full bleed) | centred (unchanged, §4) |

### About

The toolbar's last control answers "what is this, who made it, and where does it keep my data"
without leaving the window, in that order. Its own overlay sheet, because a separate window for a
few read-only rows would cost a window lifecycle for nothing.

The sheet is a **colophon page, not a form** — revised 2026-10-03 from the settings-shaped first
version. No section heads, no cards, no bullet lists: hairlines, type and hanging labels, read like
the front matter of the book this app wants `.md` to be. The only boxes left are the engine badges,
which carry colour because they carry identity.

| block | content |
|---|---|
| brand line | logo · `MarkdownAura` · `v0.3.0` (mono) · `MIT` · `github.com/westsource/MarkdownAura ↗`, set off by a hairline |
| update | its own area below the facts block, after a hairline, and nothing else: `check for updates` (ghost) → `v0.3.0 is available` + `download and install` (primary), with the state beside the button. The note that used to sit under it — claiming this was the app's only network call — is gone: the launch check exists now, so that sentence stopped being true |
| what it is | **one** paragraph: what the app is, then the six capabilities after a `capabilities:` lead-in — same size, same colour, no separate block |
| facts | hanging labels (`author` / `engines` / `data`): 道荣（黄超） · the three engine badges with their licence (and a version where the UI shows one) · the data path in mono with an `open` button |
| foot | `LICENSE · THIRD-PARTY.md` (both ship next to the executable) |

Decisions inside that shape, each of which was made deliberately:

- **The licence sits in the brand, not the foot.** It is a fact about the build like the version is,
  so it belongs beside the version; the foot is left for the one claim that is not a noun.
- **The homepage sits on the brand line too**, right after the licence and separated by a hairline.
  It is a fact about the build, and the brand line is where those facts live; it also keeps the
  facts block to the three questions the sheet exists to answer.
- **The version comes from `package.json`, injected at build time** (`vite.config.ts` →
  `__APP_VERSION__`). The help panel's footer reads the same constant, so bumping the package version
  is the whole change and no panel can lie about its own build.
- **No runtime block.** Tauri 2 / WebView2 is how the app is built, not something a reader of the
  About sheet needs; it was in the first version and was removed on review.
- **The author's name carries no role subtitle and is not transliterated** — the Chinese catalogue
  and the English one carry it identically, because a name is spelled the way its owner spells it.
  A second contributor later is another facts row, not a redesign.
- **Capabilities are the tail of the sentence, not a block.** They run on in the same paragraph,
  at the same size and the same colour as the sentence that introduces them (`　`-separated
  phrases), because they are the same claim. A reader opening About wants a reminder of what the
  app does, not a feature matrix to scan — and not a second, quieter grey that reads as a footnote.
- **The capabilities list states facts; the one adjective lives in the lead.** No capability phrase
  carries an adjective ("rendered locally", not "renders instantly"). The lead may name the product
  in its own voice — 2026-10-03, product owner's call: 极速极简 / "fast, minimal" — because that is
  a statement of what the app is for, not a claim about how it performs.
- **The foot carries the notices and nothing else.** It used to also carry a privacy claim ("nothing
  leaves this machine"); 2026-10-03, product owner's call: removed. Nothing about the reader is ever sent,
  and the runtime fetches only the update manifest (below) — but that is a claim, and the foot is where
  facts about the build live.

- **The update check happens at launch and when asked, and either way it is one small manifest.** The launch
  makes one request for `latest.json` — a version, a download URL and a signature — and does it silently:
  offline, rate-limited and "nothing published yet" are indistinguishable from one another and none of them
  is surfaced. When it does find something, the status bar gains a chip, and clicking that chip opens this
  sheet to do the install — which is also what the *check for updates* button is for. Nothing about the
  reader is sent either way, and an update is refused unless it is signed by the key baked into
  `tauri.conf.json` (key custody and the release steps are in `IMPL.md` §12).
- **It sits below the facts block, not inside it.** Tried under `author` first (2026-10-03, product
  owner's request) and moved again the same day: the facts block is hanging labels answering "what is
  this build", and a button and its state are a control, not one of those answers. A hairline, the button
  and its state are enough to say what it is.
- **The GitHub line is the only external URL in the app**, and it is opened through
`tauri-plugin-opener` rather than by shelling out to `cmd /C start`. The capability allows **that
one URL** (`opener:allow-open-url` with a single-entry `allow` scope); anything else is refused by
the capability layer, not by our code. The element is an `<a>` for semantics and cursor, but its
click is intercepted (`preventDefault`): an `<a href>` inside the webview would try to navigate the
webview itself, and CSP would block it rather than open a browser.

### Settings

**Decision: settings is an in-app overlay sheet, not a second window.** A separate Tauri window
costs a window lifecycle, a second webview and cross-window state sync, for a panel that is two
screens tall. If it ever needs to be a real window the sheet markup moves across unchanged.

Content order — reading, engines, files, cache:

| section | rows (shipped) |
|---|---|
| reading | theme (`system` / `light` / `dark`, segmented), language (`system` / `English` / `简体中文`, segmented), document font size (stepper, 12–22px, the `--doc-size` token), reading width (3 presets — 60ch / 100ch / full, the `--measure` token), reduce motion |
| engines | all three are static `bundled` rows with their measured costs; nothing here can touch the network (SPEC §4) |
| files | default app — a read-out of what opens `.md` now, plus the one action this platform allows: `xdg-mime` on Linux, and on Windows the *Open with* dialog (or the Default Apps page when no document is open), because the choice is the user's and no process may set it; watch debounce (read-out only; the value lives in `IMPL.md` §3) |
| cache | rendered-SVG size + clear (the in-memory cap is 6 MB, `IMPL.md` §5) |

The theme control and the toolbar's theme button are **the same field**: toggling the button sets
an explicit `light`/`dark`, and the sheet's `system` option is what restores OS-following. A
`system` selection re-resolves on OS change (`matchMedia`); it does not freeze the resolved value.

**Principle — anything you want to change while reading must be changeable on the reading
surface.** The settings sheet lists a choice and supplies its default; it does not own it. Three
settings are already wired this way and must stay that way:

| field | reading surface | settings row |
|---|---|---|
| theme | toolbar button | reading ▸ theme |
| reading width | status-bar chip (`↔` icon + value) · toolbar `↔` button · `ctrl shift M` · the immersive bar | reading ▸ reading width |
| zoom | status bar (`100%`) + `ctrl +/-` / `ctrl 0` + the immersive bar | — (surface only is enough) |

`ctrl +/-` and `ctrl 0` reach the zoom from the keyboard in every mode, which is why the immersive
bar can afford to offer only "reset" rather than a stepper.

Language is the deliberate exception: it is a set-once choice, so it has no surface control. Adding
one later means adding it to this table, not inventing a second source of truth.

**v1 status — two rows short.** The target's `files` row is "ignore list as chips, watch
debounce". The chips are not shipped because the ignore list is not a setting (§3); only
the debounce read-out is there. The target's `cache` row also named the session file path;
the app shows size and clear only. Both are deviations, not omissions to be re-added
without a decision.

### Language

Two catalogues ship: **English** and **简体中文**. The setting is `system` / `English` /
`简体中文`, lives in the reading section, defaults to `system`, and is persisted with the session
(`IMPL.md` §6). Like the theme, `system` resolves against the OS and re-resolves on the next
launch — it is a choice, not a frozen value.

Three rules keep it from rotting:

- **English is the key set.** `en` defines the keys; `zh-CN` is typed against them, so a missing
  or stray translation fails the type check instead of silently falling back to English.
- **Two homes for a string, and no third.** Static shell copy sits in `index.html` with a
  `data-i18n` (or `-title` / `-aria-label` / `-placeholder`) attribute and is filled by
  `applyStatic()`; anything a module renders goes through `t()` at render time. A `data-i18n`
  attribute on text a module owns is a bug — `applyStatic()` would overwrite live data (the
  watcher count, the viewer's engine name) with the key's fallback.
- **A language change re-renders.** `main.ts applyLang()` is the single place that knows the
  list of surfaces (chrome, tabs, outline, status, open overlays); nothing caches a translated
  string in a module.

Language names stay in their own language, because a picker written in a language you cannot
read is useless; only `system` is translated. Numbers go through one shared formatter so a count
groups the way the active language expects.

**Not translated, deliberately:** proper nouns and identifiers — engine names (`mermaid`, `dot`,
`d2`), `MarkdownAura`, key names (`ctrl B`, `F11`), encoding values (`utf-8-lossy`), file paths,
and the diagram source. Translating them would make the UI harder to search, not easier to read.

**Scope note.** The mockup carries the language row (layout parity) but stays English: two
catalogues in the reference implementation would drift from `src/i18n.ts`, which is the app's only
catalogue. The mockup's row exists so the four-row reading section can be reviewed at the right
height.

### Immersive (`F11`) — what survives

Everything goes: title bar and with it the tab strip, toolbar, sidebar, outline, status bar. What
survives is the content, plus the diagram cards' own controls — opening the viewer full screen is
still a reading action.

**The way out is a 5px hot zone at the top edge** of the window. Hovering it reveals a single 34px
bar carrying the file name, the two reading controls — reading width and zoom — and `esc exit`.
Nothing is permanently on screen. Entering fires a toast once, because a mode whose exit is
invisible is a mode people get stuck in.

The bar's controls write the same fields the status bar does — immersive takes the chrome away, not
the ability to change what you are looking at. Clicking empty bar space exits; clicking a control
does **not**, and that distinction is the whole reason the exit handler checks for a button first
(`immersive.ts`).

Note the consequence: with `decorations: false` (§2) the window controls leave with the title bar,
so in immersive the exits are `esc`, `F11`, and whatever the OS offers (alt+F4, the taskbar).
Acceptable for a reading mode; the hover bar is what keeps it from being hostile.

**v1 status.** The target bar carried `N of M tabs` alongside the file name. The app shows the file
name plus the two reading controls — the tab count needs a tab-strip lookup the bar does not do.
Deviates; if it returns, it belongs in `immersive.ts set()` next to the filename.

### Help (`F1`)

Two columns: the shortcut table on the left, grouped `file` / `view` / `find`; a diagram-syntax
card per engine on the right. d2 needs no install note any more: it is bundled like the other two.

**The shortcut table is data, not markup.** `KEYMAP` in `src/ui/help.ts` is a
`{ group, keys, label }[]` and the panel is generated from it. It is *not* the dispatcher —
see §7; the mockup's comment claiming "the app must dispatch from this table" is the target,
not the present.

### Screenshot parameters

The mockup takes `?view= &theme= &tab= &preview= &find= &overlay= &edit=`, plus `?panel=settings`,
`?panel=help`, `?immersive=1`, and `?peek=1` to force the immersive hover bar open — a
headless browser cannot hover, so the bar is otherwise uncapturable.

`preview=N` and `overlay=N` are **indices, not booleans**: `?preview=1` marks tab 1 as the
italic preview tab (the single-click-from-tree state), `?overlay=1` opens viewer overlay
number 1. Parameters without an explicit boolean value are still "present" to
`URLSearchParams`, so `?immersive` and `?immersive=1` behave the same — the mockup checks
`!== null`, not truthiness.

## 11. Not designed yet

Deliberately out of scope for this pass; each needs its own decision before implementation.
Tab-related deferrals are not here — they live in §5, already designed and waiting.

- A full recents panel. `ctrl shift P` ships as a menu of the top 8 and the empty state
  shows the top 3 links, but a panel with pinning/clearing is not designed.
- Error toast / notification styling beyond the placeholder in `mockup.js`
  (`dom.ts toast()` is the shipped shape: colour dot, 1.8 s fade).
- Touch and pen input
- Multi-window behaviour — specifically *open a second folder in a second window*. Settings is
  decided (§10) as an overlay rather than a window; the folder case is still open.
- PDF / image export of a rendered document
- Windows high-contrast and forced-colors modes
- Syntax highlighting for ordinary (non-diagram) code fences. The source view's 5-role
  highlighting (§9) covers the source pane; a rendered code block is monochrome today.

## 12. Editing

**Status: designed, nothing built.** §1 was amended for this section on 2026-10-04 (product owner's
call). The control is chosen and measured in `IMPL.md` §11 — CodeMirror 6 with an explicit extension
list, 498.8 KB minified / 173.4 KB gzip as its own lazy chunk — together with the four integration
facts that were measured rather than assumed.

### The stance

- **Read-only stays the default.** Editing is a mode of the *source* pane; the app never opens in it,
  and every reading affordance keeps working while it is on.
- **The rendered view is never edited.** WYSIWYG is a different product: the document is the source
  and the preview is a rendering of it. That relationship is what the split view exists for (§3).
- **The pill becomes the control, in every pane that shows source.** The `read-only` pill already says
  what the pane is; it is the one thing in the pane that can say the other thing, so it is the pointer
  path into the mode — and it therefore has to be present in the split view's left pane as well, not only
  in the source view. `ctrl E` is the same action from the keyboard.
- **Editing is per tab**, like every other per-tab value (§5). Switching tabs or views does not lose
  a buffer, and it does not silently commit one either. The mode itself is **not persisted**: a restored
  session comes back read-only, because "never opens in it" has to hold across a restart too, not only
  on a cold start.

### Entering and leaving

- `ctrl E` toggles the mode; the pill is the same action with a pointer. `esc` leaves it, as the
  outermost layer of the dismissal chain (§7) — so a menu, the find bar or an overlay closes first.
- In **split view** the left pane becomes editable and the right pane keeps rendering. That is the
  most valuable shape this mode has: the app already keeps both panes at one size and syncs their
  scroll (§3), so "edit on the left, watch the render on the right" costs no new layout.
- In **source view** the same pane is the only one, at the uncompacted size (§3).
- Leaving the mode with unsaved changes asks first. Immersive (`F11`), view switches and tab switches
  never ask — they are not a commit and they do not drop the buffer.
- The mode is visible without being loud: the pill changes state and the pane gains a caret. Nothing
  else in the chrome moves.

### What cannot be edited

Five refusals. Four of them exist because the reader only *badges* the condition today (§9 and the
status bar), and a badge is safe only while nothing can write:

- **Truncated** (a file past the 8 MiB cap): the buffer holds the first 8 MiB, so saving would delete
  everything after it.
- **Lossy decode** (`utf-8-lossy`, invalid UTF-8): the replacement characters are already in the
  buffer, so saving would make them permanent.
- **Missing** (the file was deleted or renamed under us, §5): there is nothing to write into.
- **Not writable** (read-only attribute, permissions, a read-only medium): the OS's refusal is
  surfaced as an error, never swallowed.
- **A preview tab is not a refusal but a promotion.** A single tree click reuses the one preview tab
  *in place* (§5), so a buffer with edits in it would be replaced by the next click without a word.
  Entering the mode pins the tab first, and the pin is what the tab strip already reserves
  (`.tab.pinned`, §5).

### Saving

- `ctrl S`. The write is atomic — temp file plus rename — which is the rule the session already
  follows, for the same reason: a crash mid-write must not lose what was there.
- **Byte fidelity is the contract, not a nicety.** The file is written back in the encoding it was
  read in: `utf-8`, `utf-8-bom` (the BOM is restored, since reading strips it), `utf-16le` /
  `utf-16be` (re-encoded, same endianness). Line endings are preserved **per line**, never
  normalised: the `eol` value the reader carries is a display heuristic — "CRLF wins if it appears at
  all" — and trusting it for a write would rewrite every LF in a mixed file. A trailing newline, or
  its absence, is preserved too.
- **Dirty is visible in two places**, because a lost buffer is the failure this mode can cause: the
  tab strip (§5's six states gain a seventh, `dirty`) and the status bar. Closing a dirty tab, or
  quitting with any dirty buffer, asks first.
- **A failed save stays dirty.** The error is a toast (§10's shell) and the buffer keeps its state;
  a failure must never look like a success.
- After a successful save the document is re-rendered through the normal path, so the preview, the
  outline, the word count and `rendered in N ms` all follow the new text.

### External changes

- **Decided 2026-10-04: an external change reloads silently.** That is what the watcher already does
  — it drops the tab's parsed document and source and re-reads through Rust — so the mode adds no
  conflict machinery. The accepted cost, recorded so it is not later mistaken for an oversight: an
  unsaved buffer is lost when something else writes the file.
- One addition is still required: when the buffer **was dirty**, the reload is announced. Text that
  reverts under the cursor with no explanation is indistinguishable from a bug.
- A deleted file keeps today's behaviour (the tab goes `missing`, the last rendering stays) and
  additionally refuses to save into a file that is gone.

### Coexisting with the reading features

This is where the work is; the control itself is the easy part.

- **Find moves into the pane.** Today it walks DOM text nodes and injects `<mark>` elements, which
  cannot work over an editable surface. When the pane is editable, the editor's own search replaces it
  *in that pane only*: the find bar, `ctrl F`, `enter` / `shift enter` and the hit count are unchanged
  from the reader's point of view (§7).
- **Outline jumps, the scroll spy and split scroll sync** keep working: they address the pane's
  scroller, which becomes the editor's.
- **Reading width, zoom and font size reach the editable pane like any other pane.** `--measure`
  applies to its content column, and the same `--doc-size` × `--zoom` multipliers apply. Two measured
  traps: the `ch` preset resolves against the *preview* element's font today, which is sans while this
  pane is mono — the same preset would mean a different number of columns — and the editor brings its
  own `line-height: 1.4` against this pane's `1.8`.
- **The status bar reports the buffer**, not the last render: word count, byte size, encoding and EOL
  follow what is on screen. `rendered in N ms` keeps meaning "the last render" and refreshes on save.
- **One pane, one editor, one state per tab.** Every tab shares the single source element, so the
  mode swaps the editor's document state per tab instead of creating an editor per tab — which is also
  what keeps undo history per tab and the DOM count at one.
- **The keyboard map gains two bindings** (§7), and this mode makes the existing "the help table and
  the dispatcher are two lists" problem worse before it gets better: an editable surface swallows keys
  the reader never noticed. Settle the two-lists question as part of this work, not after it.

### v1 status — nothing is implemented

- **implemented**: nothing in this section. The source view is read-only, there is no save path in the
  frontend or in Rust (the file layer only reads), no dirty state exists on a tab, and neither `ctrl E`
  nor `ctrl S` has a handler.
- **deferred**: all of the above, with the structure it depends on: the per-tab state gains its dirty
  field, the session gains its version decision, and the keyboard map gains its two rows.
- **deviates**: §1's former prohibition ("if a proposed feature turns MarkdownAura into an editor, it
  is out of scope") is kept in the record but no longer governs. This section supersedes it for
  **source** editing only.
- **Deliberately not in this section**, so that it is a boundary rather than a backlog: project-wide or
  multi-file editing, completion and language services, Git, collaborative editing, formatters,
  project-wide search and replace, visual table editing, image drag-and-drop, and WYSIWYG editing of
  the rendered view. Syntax highlighting inside *rendered* code fences stays where it is (§11).
- **The mockup carries this mode** (`design/mockup.html`, `?edit=` for the states below), and it fakes
  exactly two things, both loudly: the editor is a `<textarea>` over the same 5-role highlight layer
  instead of CodeMirror 6, and *save* has no file writer behind it. Everything the design is about is
  real — the caret, the dirty marks, the promotion of a preview tab, the refusals, and the live render
  beside the buffer.
- **Driving that prototype changed two decisions**, which is what it was for. The pill has to exist in
  **both** panes: it lived only in the source view, so in split view — the shape this mode exists for —
  there was no pointer path into it at all. And a toolbar-style control must not take focus on click
  (`mousedown` → `preventDefault`): the browser focuses the clicked button after the handler runs, which
  left the caret unfocused and the next keystrokes going nowhere.
- **Open, and the owner's call**: what ships first. The recommendation is the smallest coherent slice
  — edit, save, the five refusals, byte fidelity, and the coexistence items above — with split
  live-preview and rendered code-fence highlighting after it.
