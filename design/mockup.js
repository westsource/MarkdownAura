/* MarkdownAura — mockup.js
   Interactive reference implementation of the UI. No build step, no deps.
   Everything here is throwaway: it exists so the real frontend has a
   behaviour spec to copy (state shape, transitions, keyboard map). */

(function () {
  "use strict";

  /* ===================== fake filesystem ===================== */

  const DOCS = {
    "README.md": `# MarkdownAura

A small, fast markdown viewer for Windows — mermaid, dot and d2 diagrams render locally, with zero network calls.

## Why another viewer

Most markdown tools are editors first. MarkdownAura is a *reader*: point it at a folder, get instant preview with rendered diagrams, and keep the chrome out of the way.

All three engines run as WASM inside WebView2 — offline, private, and fast enough that render time is worth showing in the status bar.

## Pipeline

\`\`\`mermaid
flowchart LR
  A[open file] --> B[parse md]
  B --> C[wasm render]
  C --> D[webview2]
\`\`\`

## Diagram engines

| engine | syntax | shipped size | notes |
|---|---|---|---|
| mermaid | flowchart, sequence, er | 29 KB entry + chunks on demand | ESM build, code-split per diagram type |
| dot | graphviz digraph | ~0.9 MB | \`@hpcc-js/wasm-graphviz\` |
| d2 | d2 sketch | ~11 MB | opt-in, by far the heaviest |

Fenced blocks become cards — click to open the viewer, copy the source, or export SVG. Render errors stay inline with file and line, so a broken block never blanks the page.

## Raw HTML

The renderer accepts a short allow-list and nothing else. Inline <kbd>Ctrl</kbd> and H<sub>2</sub>O survive.

<details>
<summary>What gets dropped, and why</summary>

Every tag that is not on the list — including \`<div align="center">\`, \`<table>\` and \`<img>\`. Markdown's own equivalents still work, and the list is small on purpose: a tag is dropped whole rather than cleaned, so there is no stripping logic to get wrong.

</details>

## Quick start

\`\`\`
markdownaura .\\docs\\       open a folder (watched live)
markdownaura README.md     open a single file
markdownaura --last        reopen the last session
\`\`\`

- Double-click any .md, or drag a folder onto the window
- \`ctrl P\` jumps between files, \`F11\` hides everything else

## License

MIT`,

    "architecture.md": `# Architecture

Rust core, WebView2 shell, three WASM engines. Nothing talks to the network.

## Layers

\`\`\`dot
digraph {
  main -> parse -> render -> cache
  watch -> parse [style=dashed]
}
\`\`\`

The Rust side owns the filesystem: reading, watching, and resolving relative asset paths. The webview never touches disk directly.

## Process map

\`\`\`d2
app: {
  ui: webview2
  core: rust (tauri)
  fs: watcher
}
engines: {
  mermaid
  graphviz
  d2
}
app.core -> engines: render
\`\`\`

## State

Per-tab state is view mode, scroll position, outline highlight and find query. Window-level state is theme, zoom and sidebar width.

### Why split

> Reading a diagram-heavy document means comparing source and output. Split view is not a nicety here — it is the main workflow for anyone maintaining docs with d2 blocks.

## Caching

Rendered SVG is keyed by \`(engine, source hash)\` and kept in memory. Re-opening a tab is instant.`,

    "quickstart.md": `# Quick start

## Install

Download the \`.msi\` from releases, or \`winget install markdownaura\`.

WebView2 Runtime ships with Windows 11 and most Windows 10 installs; the installer falls back to the bootstrapper if it is missing.

## Open something

1. Drag a folder onto the window
2. Or \`ctrl O\` for a single file
3. Or right-click any \`.md\` in Explorer and choose *Open with MarkdownAura*

## Read

- \`ctrl B\` hides the sidebar
- \`ctrl alt O\` hides the outline
- \`F11\` for full screen
- \`ctrl F\` to find in the document

## Diagrams

Click any diagram card to open it full size. Scroll to zoom, drag to pan, \`esc\` to close.`,

    "CHANGELOG.md": `# Changelog

## 0.1.0

First release.

- Markdown rendering with GFM tables, task lists and footnotes
- mermaid, dot and d2 diagram cards
- Folder watching with debounced re-render
- Light and dark themes
- Split view with synced scrolling

## Known issues

- d2 engine is not bundled by default (11 MB)
- Middle-click on a tab does not close it yet`,

    "examples/diagrams.md": `# Diagram examples

Every engine, one block each.

\`\`\`mermaid
sequenceDiagram
  User->>App: open folder
  App->>Rust: watch(path)
  Rust-->>App: changed(file)
  App->>Wasm: render(source)
  Wasm-->>App: svg
\`\`\`

\`\`\`dot
digraph {
  rankdir=LR
  node [shape=box]
  source -> lex -> parse -> layout -> svg
}
\`\`\`

\`\`\`d2
direction: right
md: markdown {
  frontmatter
  body
}
render: {
  html
  svg
}
md -> render
\`\`\`

## A broken block

\`\`\`mermaid
flowchart LR
  A[unclosed
\`\`\`

Errors render inline with the line number instead of blanking the page.`
  };

  const TREE = [
    { name: "markdownaura", depth: 0, dir: true, open: true },
    { name: "docs", depth: 1, dir: true, open: true },
    { name: "README.md", depth: 2, file: "README.md" },
    { name: "architecture.md", depth: 2, file: "architecture.md" },
    { name: "quickstart.md", depth: 2, file: "quickstart.md" },
    { name: "notes.txt", depth: 2, file: "docs/notes.txt" },
    { name: "examples", depth: 1, dir: true, open: true },
    { name: "diagrams.md", depth: 2, file: "examples/diagrams.md" },
    { name: "CHANGELOG.md", depth: 1, file: "CHANGELOG.md" }
  ];

  /* ===================== diagram stand-ins ===================== */
  /* The mockup draws these by hand. The real app calls the engines. */

  const DIAGRAMS = {
    "mermaid:flowchart": `<svg viewBox="0 0 420 64" role="img" aria-label="mermaid flowchart">
      <defs><marker id="am" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1.5L8.5 5L2 8.5" fill="none" stroke="var(--tx-2)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
      <g fill="var(--ac-bg)" stroke="var(--ac)" stroke-width="0.75">
        <rect x="6" y="12" width="88" height="40" rx="7"/><rect x="112" y="12" width="88" height="40" rx="7"/>
        <rect x="218" y="12" width="88" height="40" rx="7"/><rect x="324" y="12" width="88" height="40" rx="7"/>
      </g>
      <g fill="var(--tx)" font-size="12" font-family="var(--font-sans)" text-anchor="middle">
        <text x="50" y="32" dominant-baseline="central">open file</text><text x="156" y="32" dominant-baseline="central">parse md</text>
        <text x="262" y="32" dominant-baseline="central">wasm render</text><text x="368" y="32" dominant-baseline="central">webview2</text>
      </g>
      <g stroke="var(--tx-2)" stroke-width="1.1" fill="none" marker-end="url(#am)"><path d="M94 32h12"/><path d="M200 32h12"/><path d="M306 32h12"/></g>
    </svg>`,

    "mermaid:sequence": `<svg viewBox="0 0 460 190" role="img" aria-label="mermaid sequence diagram">
      <defs><marker id="as" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1.5L8.5 5L2 8.5" fill="none" stroke="var(--tx-2)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
      <g fill="var(--ac-bg)" stroke="var(--ac)" stroke-width="0.75">
        <rect x="16" y="10" width="70" height="26" rx="6"/><rect x="140" y="10" width="70" height="26" rx="6"/>
        <rect x="264" y="10" width="70" height="26" rx="6"/><rect x="380" y="10" width="70" height="26" rx="6"/>
      </g>
      <g fill="var(--tx)" font-size="11.5" font-family="var(--font-sans)" text-anchor="middle">
        <text x="51" y="24" dominant-baseline="central">user</text><text x="175" y="24" dominant-baseline="central">app</text>
        <text x="299" y="24" dominant-baseline="central">rust</text><text x="415" y="24" dominant-baseline="central">wasm</text>
      </g>
      <g stroke="var(--line-3)" stroke-width="0.75" stroke-dasharray="3 3"><path d="M51 36v140"/><path d="M175 36v140"/><path d="M299 36v140"/><path d="M415 36v140"/></g>
      <g stroke="var(--tx-2)" stroke-width="1.1" fill="none" marker-end="url(#as)">
        <path d="M51 56h124"/><path d="M175 82h124"/><path d="M415 134h-240"/>
      </g>
      <g stroke="var(--tx-2)" stroke-width="1.1" fill="none" stroke-dasharray="4 3" marker-end="url(#as)">
        <path d="M299 108h-124"/><path d="M415 160h-240"/>
      </g>
      <g fill="var(--tx-2)" font-size="10.5" font-family="var(--font-sans)" text-anchor="middle">
        <text x="113" y="50">open folder</text><text x="237" y="76">watch(path)</text><text x="237" y="102">changed(file)</text>
        <text x="295" y="128">render(source)</text><text x="295" y="154">svg</text>
      </g>
    </svg>`,

    "dot:digraph": `<svg viewBox="0 0 560 130" role="img" aria-label="graphviz digraph">
      <defs><marker id="ad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1.5 1.5L9 5L1.5 8.5" fill="none" stroke="var(--tx-2)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
      <g fill="var(--card)" stroke="var(--line-3)" stroke-width="1">
        <ellipse cx="48" cy="44" rx="34" ry="16"/><ellipse cx="168" cy="44" rx="34" ry="16"/>
        <ellipse cx="288" cy="44" rx="34" ry="16"/><ellipse cx="444" cy="44" rx="46" ry="16"/><ellipse cx="168" cy="104" rx="34" ry="16"/>
      </g>
      <g fill="var(--tx)" font-size="11.5" font-family="var(--font-sans)" text-anchor="middle">
        <text x="48" y="45" dominant-baseline="central">main</text><text x="168" y="45" dominant-baseline="central">parse</text>
        <text x="288" y="45" dominant-baseline="central">render</text><text x="444" y="45" dominant-baseline="central">cache</text>
        <text x="168" y="105" dominant-baseline="central">watch</text>
      </g>
      <g stroke="var(--tx-2)" stroke-width="1.1" fill="none" marker-end="url(#ad)">
        <path d="M82 44h46"/><path d="M202 44h46"/><path d="M322 44h70"/>
        <path d="M48 60c0 30 52 44 82 44" stroke-dasharray="4 3"/><path d="M198 94c28-4 52-18 68-36"/>
      </g>
    </svg>`,

    "dot:lr": `<svg viewBox="0 0 620 74" role="img" aria-label="graphviz pipeline">
      <defs><marker id="al" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1.5 1.5L9 5L1.5 8.5" fill="none" stroke="var(--tx-2)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
      <g fill="var(--card)" stroke="var(--line-3)" stroke-width="1">
        <rect x="8" y="20" width="86" height="34" rx="5"/><rect x="132" y="20" width="86" height="34" rx="5"/>
        <rect x="256" y="20" width="86" height="34" rx="5"/><rect x="380" y="20" width="86" height="34" rx="5"/>
        <rect x="504" y="20" width="86" height="34" rx="5"/>
      </g>
      <g fill="var(--tx)" font-size="11.5" font-family="var(--font-sans)" text-anchor="middle">
        <text x="51" y="37" dominant-baseline="central">source</text><text x="175" y="37" dominant-baseline="central">lex</text>
        <text x="299" y="37" dominant-baseline="central">parse</text><text x="423" y="37" dominant-baseline="central">layout</text>
        <text x="547" y="37" dominant-baseline="central">svg</text>
      </g>
      <g stroke="var(--tx-2)" stroke-width="1.1" fill="none" marker-end="url(#al)"><path d="M94 37h32"/><path d="M218 37h32"/><path d="M342 37h32"/><path d="M466 37h32"/></g>
    </svg>`,

    "d2:app": `<svg viewBox="0 0 560 150" role="img" aria-label="d2 app map">
      <defs><marker id="ax" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M2 1.5L8.5 5L2 8.5" fill="none" stroke="var(--tx-2)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
      <g fill="var(--code)" stroke="var(--line-3)" stroke-width="1"><rect x="10" y="10" width="250" height="130" rx="10"/><rect x="330" y="20" width="220" height="112" rx="10"/></g>
      <text x="24" y="28" font-size="11" font-family="var(--font-sans)" fill="var(--tx-2)" font-weight="500">app</text>
      <text x="344" y="38" font-size="11" font-family="var(--font-sans)" fill="var(--tx-2)" font-weight="500">engines</text>
      <g fill="var(--ac-bg)" stroke="var(--ac)" stroke-width="0.75">
        <rect x="26" y="40" width="218" height="26" rx="5"/><rect x="26" y="74" width="218" height="26" rx="5"/>
        <rect x="26" y="108" width="130" height="24" rx="5"/><rect x="344" y="46" width="192" height="22" rx="5"/>
        <rect x="344" y="74" width="192" height="22" rx="5"/><rect x="344" y="102" width="192" height="22" rx="5"/>
      </g>
      <g fill="var(--tx)" font-size="11.5" font-family="var(--font-sans)" text-anchor="middle">
        <text x="135" y="53" dominant-baseline="central">ui · webview2</text><text x="135" y="87" dominant-baseline="central">core · rust (tauri)</text>
        <text x="91" y="120" dominant-baseline="central">fs watcher</text><text x="440" y="57" dominant-baseline="central">mermaid</text>
        <text x="440" y="85" dominant-baseline="central">graphviz</text><text x="440" y="113" dominant-baseline="central">d2</text>
      </g>
      <g stroke="var(--tx-2)" stroke-width="1.1" fill="none" marker-end="url(#ax)"><path d="M260 87h64"/></g>
      <text x="292" y="79" font-size="11" font-family="var(--font-sans)" fill="var(--tx-2)" text-anchor="middle">render</text>
    </svg>`,

    "d2:md": `<svg viewBox="0 0 420 120" role="img" aria-label="d2 markdown map">
      <defs><marker id="ay" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M2 1.5L8.5 5L2 8.5" fill="none" stroke="var(--tx-2)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
      <g fill="var(--code)" stroke="var(--line-3)" stroke-width="1"><rect x="10" y="14" width="160" height="92" rx="9"/><rect x="250" y="24" width="160" height="72" rx="9"/></g>
      <text x="22" y="32" font-size="11" font-family="var(--font-sans)" fill="var(--tx-2)" font-weight="500">md · markdown</text>
      <text x="262" y="42" font-size="11" font-family="var(--font-sans)" fill="var(--tx-2)" font-weight="500">render</text>
      <g fill="var(--ac-bg)" stroke="var(--ac)" stroke-width="0.75"><rect x="24" y="42" width="132" height="24" rx="5"/><rect x="24" y="72" width="132" height="24" rx="5"/><rect x="264" y="50" width="132" height="20" rx="5"/><rect x="264" y="74" width="132" height="20" rx="5"/></g>
      <g fill="var(--tx)" font-size="11.5" font-family="var(--font-sans)" text-anchor="middle"><text x="90" y="54" dominant-baseline="central">frontmatter</text><text x="90" y="84" dominant-baseline="central">body</text><text x="330" y="60" dominant-baseline="central">html</text><text x="330" y="84" dominant-baseline="central">svg</text></g>
      <g stroke="var(--tx-2)" stroke-width="1.1" fill="none" marker-end="url(#ay)"><path d="M170 60h80"/></g>
    </svg>`
  };

  const ENGINE_LABEL = { mermaid: "mermaid.js", dot: "graphviz-wasm", d2: "d2-wasm" };

  /* ===================== tiny markdown renderer =====================
     Deliberately minimal, and a stand-in: the real app parses in Rust with pulldown-cmark
     (IMPL.md §4). What is contractual here is the *output shape* — heading ids, diagram card
     markup, inline render errors — not the parser. */

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /* Raw HTML, modelled on IMPL.md §4. A tag on the allow-list passes through in its canonical
     form; anything else is dropped whole and the text around it stays. Nothing inspects a tag
     to decide what to strip — unlisted simply means gone. That is the whole difference between
     an allow-list and a sanitiser, and it is why this file does not try to be cleverer. */
  const HTML_INLINE_TAGS = "kbd|sub|sup|br|hr|summary";
  const HTML_BLOCK_EMIT = {
    "<details>": "<details>",
    "<details open>": "<details open>",
    "</details>": "</details>",
    "<summary>": "<summary>",
    "</summary>": "</summary>",
    "<br>": "<br>",
    "<br/>": "<br>",
    "<br />": "<br>",
    "<hr>": "<hr>",
    "<hr/>": "<hr>",
    "<hr />": "<hr>",
  };
  const RE_TAG_ANY = /<\/?[a-z][^>]*>/gi;
  const RE_TAG_TEST = /<\/?[a-z][^>]*>/i;
  const RE_TAG_ALLOWED = new RegExp(`^</?(?:${HTML_INLINE_TAGS})\\s*/?>$`, "i");
  const RE_RESTORE_INLINE = new RegExp(`&lt;(/?)(${HTML_INLINE_TAGS})(\\s*/)?&gt;`, "gi");

  function inline(s) {
    /* Strip unlisted tags from the raw text first, so they leave no trace at all; esc() then
       neutralises whatever remains, and the allow-listed tags are put back afterwards. */
    const kept = s.replace(RE_TAG_ANY, (m) => (RE_TAG_ALLOWED.test(m) ? m : ""));
    return esc(kept)
      .replace(RE_RESTORE_INLINE, "<$1$2$3>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  }

  /** Pick a hand-drawn stand-in for a fenced diagram block. */
  function diagramSvg(lang, code) {
    if (code.includes("unclosed") || code.includes("[A[unclosed")) return null;
    if (lang === "mermaid") return DIAGRAMS[code.includes("sequenceDiagram") ? "mermaid:sequence" : "mermaid:flowchart"];
    if (lang === "dot") return DIAGRAMS[code.includes("rankdir=LR") ? "dot:lr" : "dot:digraph"];
    if (lang === "d2") return DIAGRAMS[code.includes("direction: right") ? "d2:md" : "d2:app"];
    return null;
  }

  function renderMarkdown(src, lineOffset) {
    const lines = src.split("\n");
    const out = [];
    const headings = [];
    const diagrams = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      /* Raw HTML, block forms (IMPL.md §4). Inline tags are filtered inside inline(). */
      const rawTrim = line.trim().toLowerCase();
      if (HTML_BLOCK_EMIT[rawTrim]) { out.push(HTML_BLOCK_EMIT[rawTrim]); i++; continue; }
      const sum = line.trim().match(/^<summary>([\s\S]*?)<\/summary>$/i);
      if (sum) { out.push(`<summary>${inline(sum[1])}</summary>`); i++; continue; }

      /* A line that opens with an unlisted tag is a raw HTML block, and pulldown-cmark hands
         those over as one event — so the whole line goes, text included, not just the tag. */
      const firstTag = line.trim().match(/^<\/?[a-z][^>]*>/i);
      if (firstTag && !RE_TAG_ALLOWED.test(firstTag[0])) { i++; continue; }

      if (/^```/.test(line)) {
        const lang = line.slice(3).trim().toLowerCase();
        const start = i + 1;
        let j = start;
        while (j < lines.length && !/^```/.test(lines[j])) j++;
        const code = lines.slice(start, j).join("\n");
        const lineNo = lineOffset ? lineOffset + start : start + 1;

        if (["mermaid", "dot", "d2"].includes(lang)) {
          const svg = diagramSvg(lang, code);
          const id = "d" + diagrams.length;
          const title = (code.match(/^\s*(?:flowchart|graph|digraph|sequenceDiagram)\s*(\w+)?/) || [])[0] || lang + " diagram";
          diagrams.push({ id, lang, title: title.trim(), line: lineNo, svg, code });
          out.push(svg
            ? `<figure class="diagram" data-diagram="${id}">
                 <div class="diagram-head">
                   <span class="badge ${lang}">${lang}</span>
                   <span class="diagram-title">${esc(title.trim())} · line ${lineNo}</span>
                   <div class="spacer"></div>
                   <button class="iconbtn" data-act="zoom" style="width:22px;height:22px" title="open viewer"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M3 6.2V3h3.2M13 6.2V3H9.8M3 9.8V13h3.2M13 9.8V13H9.8"/></svg></button>
                   <button class="iconbtn" data-act="copy" style="width:22px;height:22px" title="copy source"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="5.6" y="5.6" width="7.6" height="7.6" rx="1.5"/><path d="M10.4 5.6V2.8H2.8v7.6h2.8"/></svg></button>
                 </div>
                 <div class="diagram-body">${svg}</div>
               </figure>`
            : `<div class="diagram">
                 <div class="diagram-head"><span class="badge ${lang}">${lang}</span><span class="diagram-title">line ${lineNo}</span></div>
                 <div class="diagram-error"><span>render failed at line ${lineNo}</span><code>${esc(code.split("\n")[0] || "")}</code></div>
               </div>`);
          diagrams[diagrams.length - 1].svg = diagrams[diagrams.length - 1].svg || null;
        } else {
          out.push(`<pre><code>${esc(code)}</code></pre>`);
        }
        i = j + 1;
        continue;
      }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const level = h[1].length;
        const text = h[2].trim();
        const id = "h" + headings.length;
        headings.push({ id, level, text, line: lineOffset ? lineOffset + i : i + 1 });
        out.push(`<h${level} id="${id}">${inline(text)}<a class="anchor" href="#${id}">#</a></h${level}>`);
        i++; continue;
      }

      if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
        const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
        out.push("<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>"
          + rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</tbody></table>");
        continue;
      }

      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
        out.push("<ul>" + items.map((t) => `<li>${inline(t)}</li>`).join("") + "</ul>");
        continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
        out.push("<ol>" + items.map((t) => `<li>${inline(t)}</li>`).join("") + "</ol>");
        continue;
      }

      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
        out.push("<blockquote><p>" + inline(buf.join(" ")) + "</p></blockquote>");
        continue;
      }

      if (/^\s*$/.test(line)) { i++; continue; }

      const para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|>|\s*[-*]\s|\s*\d+\.\s|\s*\|)/.test(lines[i])) { para.push(lines[i]); i++; }
      if (para.length) out.push("<p>" + inline(para.join(" ")) + "</p>");
      else i++;
    }

    return { html: out.join("\n"), headings, diagrams };
  }

  /** Read-only syntax highlighting for the source / split views. */
  function highlightSource(src) {
    return src.split("\n").map((l) => {
      if (/^```/.test(l)) return `<span class="meta">${esc(l)}</span>`;
      if (/^(#{1,6})\s/.test(l)) return `<span class="h">${esc(l)}</span>`;
      if (/^>\s?/.test(l)) return `<span class="quote">${esc(l)}</span>`;
      return esc(l)
        .replace(/`[^`]*`/g, (m) => `<span class="code">${m}</span>`)
        .replace(/\*\*[^*]+\*\*/g, (m) => `<span class="em">${m}</span>`);
    }).join("\n");
  }

  /* ===================== app state ===================== */

  const state = {
    tabs: [],          // {id, file, name, view, scroll, findQ, preview, missing, reloading, pinned,
                       //  editing, dirty, buffer, blocked}  — the last four are SPEC §12
    active: -1,
    theme: "light",
    zoom: 100,
    sidebar: true,
    outline: true,
    docs: []           // cache: fileId -> {headings, diagrams}
  };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  /* ===================== tabs ===================== */

  const FILE_ICON = '<svg class="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.15"><path d="M4 1.9h4.9L12 5v9.1H4z"/><path d="M8.9 1.9V5H12"/></svg>';

  function middleEllipsis(name, max) {
    if (name.length <= max) return name;
    const keep = Math.floor((max - 1) / 2);
    return name.slice(0, keep) + "…" + name.slice(name.length - keep);
  }

  function openFile(file, { preview = false } = {}) {
    if (!DOCS[file]) return;
    // a single-click reuses the existing preview tab instead of piling up
    if (preview) {
      const p = state.tabs.findIndex((t) => t.preview);
      if (p >= 0) {
        state.tabs[p] = makeTab(file, true);
        state.active = p;
        renderAll();
        return;
      }
    }
    const existing = state.tabs.findIndex((t) => t.file === file);
    if (existing >= 0) {
      state.tabs[existing].preview = false;
      state.active = existing;
    } else {
      state.tabs.push(makeTab(file, preview));
      state.active = state.tabs.length - 1;
    }
    renderAll();
  }

  function makeTab(file, preview) {
    return {
      id: "t" + Math.random().toString(36).slice(2, 8),
      file, name: file.split("/").pop(),
      view: "preview", scroll: 0, findQ: "", findCase: false,
      preview, missing: false, reloading: false, pinned: false,
      /* SPEC §12: the mode, whether the buffer differs from the file, the buffer itself (null = the
         fixture, i.e. "not touched"), and a refusal reason when the file cannot be edited. */
      editing: false, dirty: false, buffer: null, blocked: null
    };
  }

  function closeTab(i, force = false) {
    const t = state.tabs[i];
    if (!t) return;
    /* Closing a dirty tab asks first (SPEC §12): the buffer is not in the file yet. */
    if (!force && t.dirty) return askUnsaved("Close " + t.name, () => closeTab(i, true));
    state.tabs.splice(i, 1);
    if (!state.tabs.length) { state.active = -1; renderAll(); return; }
    state.active = Math.min(i, state.tabs.length - 1);
    renderAll();
  }

  const tab = () => state.tabs[state.active];

  function renderTabs() {
    const strip = $("#tabstrip");
    strip.innerHTML = "";
    state.tabs.forEach((t, i) => {
      const on = i === state.active;
      const el = document.createElement("div");
      el.className = "tab" + (on ? " active" : "") + (t.preview ? " preview" : "") + (t.pinned ? " pinned" : "") + (t.missing ? " missing" : "") + (t.reloading ? " reloading" : "") + (t.dirty ? " dirty" : "");
      el.title = (t.reloading ? t.file + " — changed on disk" : t.file) + (t.dirty ? " — unsaved changes" : "");
      el.innerHTML = FILE_ICON +
        `<span class="tab-name">${esc(middleEllipsis(t.name, 22))}</span>` +
        (t.dirty ? '<span class="tab-dirty" aria-hidden="true"></span>' : "") +
        `<span class="tab-close" role="button" aria-label="close tab">×</span>`;
      el.addEventListener("click", () => { state.active = i; renderAll(); });
      el.addEventListener("auxclick", (e) => { if (e.button === 1) closeTab(i); });
      el.addEventListener("contextmenu", (e) => { e.preventDefault(); tabMenu(e, i); });
      el.querySelector(".tab-close").addEventListener("click", (e) => { e.stopPropagation(); closeTab(i); });
      strip.appendChild(el);
    });
    $("#empty").hidden = state.tabs.length > 0;
    $$(".view").forEach((v) => (v.style.display = state.tabs.length ? "" : "none"));
  }

  /* ===================== content ===================== */

  function doc(file) {
    if (!state.docs[file]) state.docs[file] = renderMarkdown(DOCS[file]);
    return state.docs[file];
  }

  /** The text a tab shows: its buffer once it has been touched, otherwise the fixture (SPEC §12). */
  function textOf(t) {
    return t.buffer !== null ? t.buffer : DOCS[t.file];
  }

  function renderContent() {
    const t = tab();
    if (!t) {
      $("#stPath").textContent = "—";
      $("#stWords").textContent = "0 words";
      $("#stRender").textContent = "rendered in 0 ms";
      $("#stDirty").hidden = true;
      $("#outlineList").innerHTML = "";
      $("#diagramList").innerHTML = "";
      paintMode(null);
      return;
    }
    const t0 = performance.now();
    const text = textOf(t);
    /* An edited buffer is not the fixture, so it renders fresh rather than from the cache. */
    const d = t.buffer !== null ? renderMarkdown(text) : doc(t.file);

    $("#out-preview").innerHTML = d.html;
    $("#out-split").innerHTML = d.html;
    const hl = highlightSource(text);
    $("#out-source").innerHTML = hl;
    $("#out-split-src").innerHTML = hl;
    paintMode(t, hl);

    const ms = Math.max(1, Math.round(performance.now() - t0 + 6));
    const words = text.split(/\s+/).filter(Boolean).length;

    $("#stPath").textContent = t.file;
    $("#stWords").textContent = words + " words";
    $("#stRender").textContent = "rendered in " + ms + " ms";
    $("#stDirty").hidden = !t.dirty;

    setView(t.view);
    renderOutline(d);
    wireDiagrams($("#out-preview"), d);
    wireDiagrams($("#out-split"), d);
    restoreScroll();
    scrollspy();
    if (t.findQ) { $("#findInput").value = t.findQ; runFind(false); } else { $("#findCount").textContent = "0/0"; }
  }

  function wireDiagrams(root, d) {
    root.querySelectorAll(".diagram").forEach((fig) => {
      const rec = d.diagrams.find((x) => x.id === fig.dataset.diagram);
      if (!rec) return;
      fig.addEventListener("click", (e) => {
        if (e.target.closest('[data-act="copy"]')) { copy(rec.code); return; }
        openViewer(rec);
      });
    });
  }

  function renderOutline(d) {
    $("#outlineList").innerHTML = d.headings.map((h) =>
      `<div class="outline-item" data-level="${h.level}" data-target="${h.id}" title="${esc(h.text)}">${esc(h.text)}</div>`).join("");
    $("#outlineList").querySelectorAll(".outline-item").forEach((el) => {
      el.addEventListener("click", () => {
        const target = document.getElementById(el.dataset.target);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    $("#diagramList").innerHTML = d.diagrams.map((g) =>
      `<div class="outline-item outline-diagram" data-diagram="${g.id}"><span class="badge ${g.lang}">${g.lang}</span><span style="overflow:hidden;text-overflow:ellipsis;">${esc(g.title)}</span></div>`).join("")
      || `<div class="outline-item" style="opacity:.6">none</div>`;
    $("#diagramList").querySelectorAll("[data-diagram]").forEach((el) => {
      el.addEventListener("click", () => {
        const rec = d.diagrams.find((x) => x.id === el.dataset.diagram);
        const node = document.querySelector(`#out-preview .diagram[data-diagram="${rec.id}"]`);
        if (node) node.scrollIntoView({ behavior: "smooth", block: "center" });
        if (rec.svg) openViewer(rec);
      });
    });
  }

  function setView(v) {
    $$(".view").forEach((el) => el.classList.toggle("on", el.id === "view-" + v));
    $("#viewSwitch").querySelectorAll("button").forEach((b) => {
      const on = b.dataset.view === v;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    });
    const t = tab();
    if (t) t.view = v;
  }

  function activeScroller() {
    const v = tab() ? tab().view : "preview";
    if (v === "source") return $("#view-source .source-view");
    if (v === "split") return $("#view-split .pane-out");
    return $("#view-preview .prose-wrap");
  }

  /* outline scrollspy — the highlighted heading follows the reading position */
  function scrollspy() {
    const d = tab() && doc(tab().file);
    if (!d) return;
    const scroller = activeScroller();
    const top = scroller.getBoundingClientRect().top;
    let current = d.headings[0] ? d.headings[0].id : null;
    for (const h of d.headings) {
      const el = document.getElementById(h.id);
      if (el && el.getBoundingClientRect().top - top <= 48) current = h.id;
    }
    $$("#outlineList .outline-item").forEach((el) => el.classList.toggle("active", el.dataset.target === current));
  }

  function saveScroll() { const t = tab(); if (t) t.scroll = activeScroller().scrollTop; scrollspy(); }
  function restoreScroll() { const t = tab(); if (t) activeScroller().scrollTop = t.scroll || 0; }

  /* ===================== diagram viewer ===================== */

  let ovState = { rec: null, zoom: 100 };

  function openViewer(rec) {
    if (!rec.svg) { toast("this block failed to render", "err"); return; }
    ovState = { rec, zoom: 100 };
    $("#ovBadge").className = "badge " + rec.lang;
    $("#ovBadge").textContent = rec.lang;
    $("#ovTitle").textContent = rec.title + " — " + (tab() ? tab().name : "") + ":" + rec.line;
    $("#ovEngine").textContent = ENGINE_LABEL[rec.lang] + " · " + (6 + Math.round(Math.random() * 14)) + " ms";
    $("#ovBody").innerHTML = rec.svg;
    applyOvZoom();
    $("#diagramOverlay").classList.add("on");
  }

  function applyOvZoom() {
    const svg = $("#ovBody svg");
    if (svg) svg.style.width = ovState.zoom + "%";
    $("#ovPct").textContent = ovState.zoom + "%";
  }

  function closeViewer() { $("#diagramOverlay").classList.remove("on"); ovState.rec = null; }

  $("#ovIn").addEventListener("click", () => { ovState.zoom = Math.min(400, ovState.zoom + 10); applyOvZoom(); });
  $("#ovOut").addEventListener("click", () => { ovState.zoom = Math.max(20, ovState.zoom - 10); applyOvZoom(); });
  $("#ovPct").addEventListener("click", () => { ovState.zoom = 100; applyOvZoom(); });
  $("#ovClose").addEventListener("click", closeViewer);
  $("#diagramOverlay").addEventListener("click", (e) => { if (e.target.id === "diagramOverlay") closeViewer(); });
  $("#ovBody").addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    ovState.zoom = Math.min(400, Math.max(20, ovState.zoom + (e.deltaY < 0 ? 10 : -10)));
    applyOvZoom();
  }, { passive: false });
  $("#ovCopySrc").addEventListener("click", () => ovState.rec && copy(ovState.rec.code));
  $("#ovCopySvg").addEventListener("click", () => {
    const svg = $("#ovBody svg");
    if (svg) copy(svg.outerHTML);
  });

  /* ===================== find ===================== */

  let findCase = false;

  function runFind(jump = true) {
    const q = $("#findInput").value;
    const t = tab();
    if (t) t.findQ = q;
    const root = activeScroller();
    // clear previous marks
    root.querySelectorAll("mark[data-find]").forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
    root.normalize();
    if (!q) { $("#findCount").textContent = "0/0"; return; }

    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), findCase ? "g" : "gi");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest("script,style,mark") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    let hits = 0;
    nodes.forEach((n) => {
      const text = n.nodeValue;
      if (!re.test(text)) { re.lastIndex = 0; return; }
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, m;
      while ((m = re.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const mk = document.createElement("mark");
        mk.dataset.find = String(hits++);
        mk.textContent = m[0];
        frag.appendChild(mk);
        last = m.index + m[0].length;
        if (m[0].length === 0) re.lastIndex++;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      n.replaceWith(frag);
    });

    $("#findCount").textContent = hits ? "1/" + hits : "0/0";
    if (hits && jump) gotoHit(0);
  }

  function gotoHit(n) {
    const root = activeScroller();
    const all = root.querySelectorAll("mark[data-find]");
    if (!all.length) return;
    const idx = ((n % all.length) + all.length) % all.length;
    all.forEach((m) => m.classList.remove("current"));
    all[idx].classList.add("current");
    all[idx].scrollIntoView({ block: "center", behavior: "smooth" });
    $("#findCount").textContent = (idx + 1) + "/" + all.length;
  }

  let hitCursor = 0;
  function stepHit(d) {
    const all = activeScroller().querySelectorAll("mark[data-find]");
    if (!all.length) return;
    hitCursor += d;
    gotoHit(hitCursor);
  }

  function showFind(on) {
    $("#findbar").classList.toggle("on", on);
    if (on) { $("#findInput").focus(); $("#findInput").select(); }
    else { $("#findInput").value = ""; runFind(false); const t = tab(); if (t) t.findQ = ""; }
  }

  $("#findTrigger").addEventListener("click", () => showFind(true));
  $("#findClose").addEventListener("click", () => showFind(false));
  $("#findInput").addEventListener("input", () => { hitCursor = 0; runFind(true); });
  $("#findInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); }
    if (e.key === "Escape") { e.preventDefault(); showFind(false); }
  });
  $("#findNext").addEventListener("click", () => stepHit(1));
  $("#findPrev").addEventListener("click", () => stepHit(-1));
  $("#findCase").addEventListener("click", function () {
    findCase = !findCase;
    this.classList.toggle("on", findCase);
    hitCursor = 0; runFind(true);
  });

  /* ===================== tree ===================== */

  const CHEV_OPEN = '<svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 4.5L6 8l3.5-3.5"/></svg>';
  const CHEV_SHUT = '<svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4.5 2.5L8 6l-3.5 3.5"/></svg>';
  const DIR_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M1.9 4.4h4.2l1.5 2h6.5v7.7H1.9z"/></svg>';
  const FILE_TREE_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M4 1.9h4.9L12 5v9.1H4z"/><path d="M8.9 1.9V5H12"/></svg>';

  /** Markdown files only (default on). Directories are never hidden by this: the tree is a flat
   *  fixture here and one level at a time in the app, so whether a folder holds markdown is not
   *  knowable without reading it. */
  let mdOnly = true;
  const MD_EXT = /\.(md|markdown|mdx|mdown|mkd)$/i;

  function renderTree() {
    const filter = $("#fileFilter").value.trim().toLowerCase();
    const hidden = new Set();
    // collapse children of a closed dir
    TREE.forEach((n, i) => {
      if (n.dir && !n.open) {
        for (let j = i + 1; j < TREE.length && TREE[j].depth > n.depth; j++) hidden.add(j);
      }
    });
    const cur = tab();
    const html = TREE.map((n, i) => {
      if (hidden.has(i)) return "";
      // The text filter exempts directories, like the app's: the tree is read one level at a time, and
      // hiding a folder because its *name* does not match hides the files inside it too.
      if (filter && !n.dir && !n.name.toLowerCase().includes(filter)) return "";
      if (mdOnly && !n.dir && !MD_EXT.test(n.name)) return "";
      const icon = n.dir ? DIR_ICON : FILE_TREE_ICON;
      const chev = n.dir ? (n.open ? CHEV_OPEN : CHEV_SHUT) : '<span class="chev"></span>';
      const active = cur && cur.file === n.file;
      return `<div class="tree-row${active ? " active" : ""}" style="--depth:${n.depth}" data-i="${i}" data-file="${n.file || ""}" title="${esc(n.name)}">${chev}${icon}<span style="overflow:hidden;text-overflow:ellipsis;">${esc(n.name)}</span></div>`;
    }).join("");
    // No empty-tree hint in the mockup: its fixture draws the root as a row and directories are never
    // filtered, so this list cannot be empty. The app's tree shows a folder's *children* (no row for the
    // root), so a folder whose files are all filtered out does get a one-line hint — SPEC §3.
    $("#tree").innerHTML = html;

    $$("#tree .tree-row").forEach((el) => {
      const i = +el.dataset.i;
      el.addEventListener("click", () => {
        if (TREE[i].dir) { TREE[i].open = !TREE[i].open; renderTree(); return; }
        openFile(TREE[i].file, { preview: true });   // single click -> preview tab
      });
      el.addEventListener("dblclick", () => { if (TREE[i].file) openFile(TREE[i].file, { preview: false }); });
    });
    const files = Object.keys(DOCS).length;
    $("#watchLabel").textContent = "watching " + files + " files";
  }

  $("#fileFilter").addEventListener("input", renderTree);
  // The filter box sits in the foot row, hidden until the funnel asks for it; hiding it clears it, like
  // the app (SPEC §3).
  const revealFilter = (on) => {
    $("#fileFilter").hidden = !on;
    $("#filterToggle").setAttribute("aria-expanded", String(on));
    if (on) $("#fileFilter").focus();
    else if ($("#fileFilter").value) { $("#fileFilter").value = ""; renderTree(); }
  };
  $("#filterToggle").addEventListener("click", () => revealFilter($("#fileFilter").hidden));
  $("#fileFilter").addEventListener("keydown", (event) => { if (event.key === "Escape") revealFilter(false); });
  $("#mdOnlyBtn").addEventListener("click", () => {
    mdOnly = !mdOnly;
    $("#mdOnlyBtn").classList.toggle("on", mdOnly);
    $("#mdOnlyBtn").setAttribute("aria-pressed", String(mdOnly));
    renderTree();
  });
  $("#openFolderBtn").addEventListener("click", () => toast("opens the native folder picker (tauri dialog plugin)"));
  $("#newTabBtn").addEventListener("click", (e) => { e.stopPropagation(); openMenuAt($("#newTabBtn"), newTabMenu()); });
  $("#listTabsBtn").addEventListener("click", (e) => { e.stopPropagation(); openMenuAt($("#listTabsBtn"), allTabsMenu()); });

  /* ===================== menus ===================== */

  function menuItem(label, shortcut, disabled) {
    return `<div class="menu-item"${disabled ? ' aria-disabled="true"' : ""}><span>${esc(label)}</span>${shortcut ? `<kbd>${shortcut}</kbd>` : ""}</div>`;
  }
  const menuSep = () => '<div class="menu-sep"></div>';
  const menuHead = (t) => `<div class="menu-head">${esc(t)}</div>`;

  function newTabMenu() {
    return {
      html: menuHead("open") + menuItem("open file…", "ctrl O") + menuItem("open folder…", "ctrl shift O") + menuSep()
        + menuHead("recent") + menuItem("E:\\notes\\index.md") + menuItem("docs\\architecture.md") + menuItem("README.md"),
      actions: [() => openFile("README.md"), () => toast("native folder picker"), null, null,
        () => openFile("README.md"), () => openFile("architecture.md"), () => openFile("README.md")]
    };
  }

  function allTabsMenu() {
    const acts = state.tabs.map((t, i) => () => { state.active = i; renderAll(); });
    return {
      html: menuHead("all tabs · " + state.tabs.length) + state.tabs.map((t, i) =>
        menuItem((i === state.active ? "● " : "") + t.name, "", i === state.active)).join(""),
      actions: acts
    };
  }

  function tabMenu(e, i) {
    openMenu(e.clientX, e.clientY, {
      html: menuItem("close", "ctrl W") + menuItem("close others") + menuItem("close to the right")
        + menuItem("close all", "ctrl shift W", state.tabs.length < 2) + menuSep()
        + menuItem(tab() && tab().pinned ? "unpin tab" : "pin tab")
        + menuItem("copy path", "ctrl shift C") + menuItem("reveal in explorer") + menuSep()
        + menuItem("duplicate tab"),
      actions: [
        () => closeTab(i),
        () => { state.tabs = [state.tabs[i]]; state.active = 0; renderAll(); },
        () => { state.tabs = state.tabs.slice(0, i + 1); state.active = i; renderAll(); },
        () => { state.tabs = []; state.active = -1; renderAll(); },
        null,
        () => { state.tabs[i].pinned = !state.tabs[i].pinned; renderAll(); },
        () => copy("E:\\OpenCode\\MarkdownAura\\" + state.tabs[i].file.replace(/\//g, "\\")),
        () => toast("shell: explorer /select,path"),
        null,
        () => { const c = { ...state.tabs[i], id: "t" + Math.random().toString(36).slice(2, 8) }; state.tabs.splice(i + 1, 0, c); state.active = i + 1; renderAll(); }
      ]
    });
  }

  function openMenu(x, y, def) {
    const m = $("#menu");
    const r = $("#main").getBoundingClientRect();
    m.innerHTML = def.html;
    m.classList.add("on");
    const mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.min(x - r.left, r.width - mw - 6) + "px";
    m.style.top = Math.min(y - r.top, r.height - mh - 6) + "px";
    wireMenu(m, def);
  }

  function openMenuAt(btn, def) {
    const m = $("#menu");
    /* Toggle: the control that opened the menu closes it again. Anchors stopPropagation, so the
       document-level dismissal below never sees their clicks. */
    if (m.classList.contains("on") && m.dataset.anchor === btn.id) {
      m.classList.remove("on");
      return;
    }
    m.dataset.anchor = btn.id;
    const r = $("#main").getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    m.innerHTML = def.html;
    m.classList.add("on");
    m.style.left = Math.max(6, Math.min(b.left - r.left - m.offsetWidth + b.width, r.width - m.offsetWidth - 6)) + "px";
    m.style.top = Math.min(b.bottom - r.top + 4, r.height - m.offsetHeight - 6) + "px";
    wireMenu(m, def);
  }

  function wireMenu(m, def) {
    m.querySelectorAll(".menu-item").forEach((el, k) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        m.classList.remove("on");
        const fn = def.actions[k];
        if (fn) fn();
      });
    });
  }

  document.addEventListener("click", () => $("#menu").classList.remove("on"));

  /* ===================== theme, panels, zoom ===================== */

  const MOON = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M13 9.5A5.6 5.6 0 0 1 6.5 3a5.9 5.9 0 1 0 6.5 6.5z"/></svg>';
  const SUN = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1.2v1.8M8 13v1.8M1.2 8h1.8M13 8h1.8M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M12.8 3.2l-1.3 1.3M4.5 11.5l-1.3 1.3"/></svg>';

  function setTheme(t) {
    state.theme = t;
    document.documentElement.dataset.theme = t;
    $("#toggleTheme").innerHTML = t === "dark" ? SUN : MOON;
  }

  /* the toolbar toggle sets an explicit theme; it is the same field the settings sheet edits */
  $("#toggleTheme").addEventListener("click", () => {
    settings.theme = state.theme === "dark" ? "light" : "dark";
    applyTheme();
    if (isOn("settingsOverlay")) renderSettings();
  });
  $("#toggleSidebar").addEventListener("click", function () {
    state.sidebar = !state.sidebar;
    $("#sidebar").style.display = state.sidebar ? "" : "none";
    this.classList.toggle("on", state.sidebar);
  });
  $("#toggleOutline").addEventListener("click", function () {
    state.outline = !state.outline;
    $("#outline").style.display = state.outline ? "" : "none";
    this.classList.toggle("on", state.outline);
  });
  /* ===================== settings / help / immersive =====================
     Three panels, one overlay shell (.overlay > .sheet). Settings is an overlay
     rather than a second window: a reader has no use for window management, and
     one document keeps all state in one place. See SPEC §11. */

  const settings = {
    theme: "system",           // system | light | dark — SPEC §8: follow the OS by default
    fontSize: 15,
    reduceMotion: false,
    // The app switches UI copy from this choice; the mockup only shows the row, because it is
    // the layout reference and carrying a second catalogue would drift (SPEC §10).
    lang: "system",            // system | en | zh-CN
    // Reading width (SPEC §8): the app persists a preset name; the mockup applies the token so the
    // control can be reviewed. Keep the values in step with src/measure.ts.
    measure: "comfortable",
    ignore: ["node_modules", ".git", "target", "dist"],
    cacheBytes: 12400000,
  };

  const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");

  /* Reading-width presets — keep in step with src/measure.ts (SPEC §8). [id, label, ch|null] */
  const MEASURES = [
    ["narrow", "narrow", 60],
    ["comfortable", "comfortable", 100],
    ["full", "full", null],
  ];
  const measureCh = (id) => (MEASURES.find((m) => m[0] === id) || MEASURES[1])[2];

  /* The column is resolved once, against the prose font — a `ch` value used by a child resolves
     against *that* child's font, which made headings ~40% wider than body text. Keep in step with
     src/measure.ts (including the probe's `max-width: none`). */
  let measureFont = "";
  let measureChPx = 0;
  function resolveMeasure(ch) {
    if (ch === null) return "100%";
    const host = $("#out-preview") || document.body;
    const font = getComputedStyle(host).font;
    if (font !== measureFont) {
      const probe = document.createElement("span");
      probe.textContent = "0".repeat(100);
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;max-width:none;width:auto";
      host.appendChild(probe);
      measureChPx = probe.getBoundingClientRect().width / 100;
      probe.remove();
      measureFont = font;
    }
    return Math.round(ch * measureChPx) + "px";
  }

  function applyMeasure() {
    const ch = measureCh(settings.measure);
    document.documentElement.style.setProperty("--measure", resolveMeasure(ch));
    const label = ch === null ? "full" : ch + "ch";
    $("#stMeasureLabel").textContent = label;
    $("#imMeasureLabel").textContent = label;
  }

  /* The help panel renders from this table.
     NOTE: the keydown handler further down is still an if-chain, so the same fact
     lives in two places. The app must dispatch from the table instead (SPEC §7) —
     rewriting the mockup's dispatch is not worth the silent-regression risk here. */
  const KEYMAP = [
    { group: "file", keys: "ctrl O",        label: "open file" },
    { group: "file", keys: "ctrl shift O",  label: "open folder" },
    { group: "file", keys: "ctrl shift P",  label: "recent files" },
    { group: "file", keys: "ctrl shift A",  label: "list all tabs" },
    { group: "file", keys: "ctrl T",        label: "new tab" },
    { group: "file", keys: "ctrl W",        label: "close tab" },
    { group: "file", keys: "ctrl tab",      label: "next tab" },
    { group: "view", keys: "ctrl B",        label: "toggle sidebar" },
    { group: "view", keys: "ctrl alt O",    label: "toggle outline" },
    { group: "view", keys: "ctrl R",        label: "re-render" },
    { group: "view", keys: "ctrl ,",        label: "settings" },
    { group: "view", keys: "ctrl + / −",    label: "zoom in / out" },
    { group: "view", keys: "F11",           label: "immersive" },
    { group: "view", keys: "F1",            label: "help" },
    { group: "find", keys: "ctrl F",        label: "find in document" },
    { group: "find", keys: "enter",         label: "next match" },
    { group: "find", keys: "shift enter",   label: "previous match" },
    { group: "find", keys: "esc",           label: "close the topmost layer" },
    { group: "edit", keys: "ctrl E",        label: "edit the source pane" },
    { group: "edit", keys: "ctrl S",        label: "save" },
    { group: "edit", keys: "ctrl Z",        label: "undo (in the editable pane)" },
    { group: "edit", keys: "ctrl Y",        label: "redo (in the editable pane)" },
  ];

  const SYNTAX = [
    { lang: "mermaid", note: "", code: "flowchart LR\n  A --> B" },
    { lang: "dot", note: "", code: "digraph {\n  a -> b\n}" },
    { lang: "d2", note: "not installed — install from settings", code: "direction: right\nx -> y" },
  ];

  function renderHelp() {
    const groups = [...new Set(KEYMAP.map((k) => k.group))];
    $("#helpKeys").innerHTML = groups.map((g) =>
      `<div class="section-head">${g}</div><div class="keys">`
      + KEYMAP.filter((k) => k.group === g).map((k) => `<kbd>${k.keys}</kbd><span>${esc(k.label)}</span>`).join("")
      + `</div>`).join("");
    $("#helpSyntax").innerHTML = `<div class="section-head">diagram syntax</div><div class="syntax">`
      + SYNTAX.map((s) => `<div><span class="badge ${s.lang}">${s.lang}</span>`
        + `<pre>${esc(s.code)}</pre>`
        + (s.note ? `<p class="note">${esc(s.note)}</p>` : "") + `</div>`).join("") + `</div>`;
  }

  function formRow(label, sub, control, cls) {
    return `<div class="form-row${cls ? " " + cls : ""}">`
      + `<div class="grow"><div>${esc(label)}</div>`
      + (sub ? `<div class="form-sub">${esc(sub)}</div>` : "")
      + `</div>${control}</div>`;
  }

  function renderSettings() {
    const seg = `<div class="segmented text" data-set="theme">`
      + ["system", "light", "dark"].map((t) =>
        `<button data-val="${t}" class="${t === settings.theme ? "on" : ""}">${t}</button>`).join("")
      + `</div>`;

    // Language names stay in their own language — a picker written in a language you cannot read
    // is useless. Only `system` is a word the catalogue translates.
    const langSeg = `<div class="segmented text" data-set="lang">`
      + [["system", "system"], ["en", "English"], ["zh-CN", "简体中文"]].map(([v, label]) =>
        `<button data-val="${v}" class="${v === settings.lang ? "on" : ""}">${label}</button>`).join("")
      + `</div>`;

    const measureSeg = `<div class="segmented text" data-set="measure">`
      + MEASURES.map(([id, label]) =>
        `<button data-val="${id}" class="${id === settings.measure ? "on" : ""}">${label}</button>`).join("")
      + `</div>`;

    $("#setBody").innerHTML =
      `<div class="section-head">reading</div>`
      + formRow("theme", "follows the system by default", seg)
      + formRow("language", "the app switches its copy; this mockup stays English", langSeg)
      + formRow("document font size", "", `<div class="stepper" data-stepper>`
          + `<button data-step="-1" aria-label="smaller">−</button>`
          + `<span>${settings.fontSize} px</span>`
          + `<button data-step="1" aria-label="larger">+</button></div>`)
      + formRow("reduce motion", "also respects the OS setting",
          `<button class="switch${settings.reduceMotion ? " on" : ""}" data-toggle="motion" aria-label="reduce motion"></button>`)
      + formRow("reading width", "the column every block shares — headings, tables and code included", measureSeg)

      + `<div class="section-head">engines</div>`
      + `<div class="form-row"><span class="badge mermaid">mermaid</span>`
        + `<div class="grow form-sub" style="margin:0">29 KB entry, chunks on demand</div>`
        + `<span class="state-ok">bundled</span></div>`
      + `<div class="form-row"><span class="badge dot">dot</span>`
        + `<div class="grow form-sub" style="margin:0">~0.9 MB</div>`
        + `<span class="state-ok">bundled</span></div>`
      + `<div class="form-row"><span class="badge d2">d2</span>`
        + `<div class="grow form-sub" style="margin:0">11 MB, wasm inlined in its chunk</div>`
        + `<span class="state-ok">bundled</span></div>`

      + `<div class="section-head">files</div>`
      + formRow("ignore", "", `<div class="chips">${settings.ignore.map((i) => `<span class="chip">${esc(i)}</span>`).join("")}<span class="chip">+</span></div>`,
          settings.ignore.length > 3 ? "stack" : "")
      + formRow("watch debounce", "", `<span class="state-off">120 ms</span>`)

      + `<div class="section-head">cache</div>`
      + formRow("rendered svg", "%APPDATA%\\MarkdownAura\\session.json",
          `${settings.cacheBytes ? `<span class="state-off">${fmtBytes(settings.cacheBytes)}</span>` : `<span class="state-off">empty</span>`}`
          + `<button class="ghost-btn" id="clearCache"${settings.cacheBytes ? "" : ` aria-disabled="true"`}>clear</button>`);

    const body = $("#setBody");
    body.querySelectorAll('[data-set="theme"] button').forEach((b) =>
      b.addEventListener("click", () => { settings.theme = b.dataset.val; applyTheme(); renderSettings(); }));
    body.querySelectorAll('[data-set="lang"] button').forEach((b) =>
      b.addEventListener("click", () => { settings.lang = b.dataset.val; renderSettings(); }));
    body.querySelectorAll('[data-set="measure"] button').forEach((b) =>
      b.addEventListener("click", () => { settings.measure = b.dataset.val; applyMeasure(); renderSettings(); }));
    body.querySelectorAll("[data-stepper] button").forEach((b) =>
      b.addEventListener("click", () => {
        settings.fontSize = Math.min(22, Math.max(12, settings.fontSize + Number(b.dataset.step)));
        applyDocSize(); renderSettings();
      }));
    body.querySelectorAll("[data-toggle]").forEach((b) =>
      b.addEventListener("click", () => { settings.reduceMotion = !settings.reduceMotion; applyMotion(); renderSettings(); }));
    body.querySelectorAll('[data-set="theme"] button, [data-set="lang"] button, [data-stepper] button, [data-toggle]').forEach((b) =>
      b.addEventListener("click", (e) => e.stopPropagation()));

    if ($("#clearCache") && settings.cacheBytes) {
      $("#clearCache").addEventListener("click", () => { settings.cacheBytes = 0; renderSettings(); toast("cache cleared", "ok"); });
    }
  }

  function applyTheme() {
    const t = settings.theme === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : settings.theme;
    setTheme(t);
  }
  function applyDocSize() { document.documentElement.style.setProperty("--doc-size", settings.fontSize + "px"); applyMeasure(); }
  function applyMotion() { document.documentElement.dataset.motion = settings.reduceMotion ? "reduce" : ""; }

  const isOn = (id) => $("#" + id).classList.contains("on");
  function openSettings() { renderSettings(); $("#settingsOverlay").classList.add("on"); }
  function closeSettings() { $("#settingsOverlay").classList.remove("on"); }
  function openHelp() { renderHelp(); $("#helpOverlay").classList.add("on"); }
  function closeHelp() { $("#helpOverlay").classList.remove("on"); }
  /* About: static in the mockup — the version and the data path are the app's business (it injects
     the version from package.json and asks Rust for %APPDATA%). */
  function openAbout() { $("#aboutOverlay").classList.add("on"); }
  function closeAbout() { $("#aboutOverlay").classList.remove("on"); }

  /* F11 — every piece of chrome goes. The 5px hot zone at the top edge and esc
     are the only ways back, so entry is announced once rather than silently. */
  function setImmersive(on) {
    state.immersive = on;
    $("#win").classList.toggle("immersive", on);
    if (on) {
      const t = tab();
      $("#imFile").textContent = t
        ? t.name + " · " + (state.active + 1) + " of " + state.tabs.length + " tabs"
        : "nothing open";
      toast("immersive — hover the top edge or press esc to exit");
    }
  }

  $("#openSettings").addEventListener("click", openSettings);
  $("#setClose").addEventListener("click", closeSettings);
  $("#helpClose").addEventListener("click", closeHelp);
  $("#openAbout").addEventListener("click", openAbout);
  /* The chip is the other route into About: it only exists after the check finds something. */
  $("#stUpdate").addEventListener("click", openAbout);
  $("#aboutClose").addEventListener("click", closeAbout);
  $("#aboutOverlay").addEventListener("click", (e) => { if (e.target.id === "aboutOverlay") closeAbout(); });
  $("#aboutReveal").addEventListener("click", () => toast("shell: explorer /select,%APPDATA%\\MarkdownAura"));
  /* The app opens this through the opener plugin; the mockup must not navigate itself away. */
  $("#aboutGithub").addEventListener("click", (e) => { e.preventDefault(); toast("opens github.com/westsource/MarkdownAura in your browser"); });

  // The update row is a stub in the mockup: the real app asks the GitHub release for one manifest and
  // verifies the installer against the project's signing key (SPEC §10). Here it only shows the states.
  $("#aboutUpdateCheck").addEventListener("click", () => {
    const state = $("#aboutUpdateState");
    const install = $("#aboutUpdateInstall");
    $("#aboutUpdateCheck").textContent = "checking…";
    state.textContent = "";
    setTimeout(() => {
      $("#aboutUpdateCheck").textContent = "check for updates";
      state.textContent = "v0.2.0 is available";
      install.hidden = false;
      // A hit is what makes the status bar grow the chip, exactly as the app does (SPEC §10).
      $("#stUpdate").hidden = false;
      $("#stUpdateLabel").textContent = "v0.2.0 available";
      toast("the mockup has no updater — the real app would fetch latest.json from the release");
    }, 600);
  });
  $("#aboutUpdateInstall").addEventListener("click", () => {
    $("#aboutUpdateState").textContent = "downloading…";
    toast("the real app downloads the signed installer, then runs it and restarts");
  });
  $("#settingsOverlay").addEventListener("click", (e) => { if (e.target.id === "settingsOverlay") closeSettings(); });
  $("#helpOverlay").addEventListener("click", (e) => { if (e.target.id === "helpOverlay") closeHelp(); });

  function setZoom(z) {
    state.zoom = Math.min(200, Math.max(50, z));
    $("#stZoom").textContent = state.zoom + "%";
    $("#imZoom").textContent = state.zoom + "%";
    /* zoom and the settings font size are multiplied in prose.css, so this only ever
       writes --zoom. Writing inline font-size here would silently defeat the setting. */
    document.documentElement.style.setProperty("--zoom", state.zoom / 100);
    applyMeasure();   // the column is a resolved pixel value, so it must follow the text size
  }
  $("#stZoom").addEventListener("click", () => setZoom(100));
  function measureMenu() {
    return {
      html: menuHead("reading width") + MEASURES.map(([id, label]) =>
        menuItem((id === settings.measure ? "● " : "") + label, "", id === settings.measure)).join(""),
      actions: MEASURES.map(([id]) => () => { settings.measure = id; applyMeasure(); renderSettings(); }),
    };
  }
  $("#stMeasure").addEventListener("click", (e) => { e.stopPropagation(); openMenuAt($("#stMeasure"), measureMenu()); });
  $("#measureBtn").addEventListener("click", (e) => { e.stopPropagation(); openMenuAt($("#measureBtn"), measureMenu()); });
  $("#imMeasure").addEventListener("click", (e) => { e.stopPropagation(); openMenuAt($("#imMeasure"), measureMenu()); });
  $("#imZoom").addEventListener("click", () => setZoom(100));

  $("#viewSwitch").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $("#rerender").addEventListener("click", () => {
    const t = tab();
    if (!t) return;
    t.reloading = true; renderTabs();
    setTimeout(() => { t.reloading = false; renderTabs(); renderContent(); toast("re-rendered " + t.name, "ok"); }, 320);
  });

  /* splitter drag in split view */
  (function () {
    let dragging = false;
    const sp = $("#splitter");
    sp.addEventListener("pointerdown", (e) => { dragging = true; sp.setPointerCapture(e.pointerId); });
    sp.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const v = $("#view-split");
      const r = v.getBoundingClientRect();
      const pct = Math.min(80, Math.max(20, ((e.clientX - r.left) / r.width) * 100));
      v.querySelector(".pane-src").style.flex = "0 0 " + pct + "%";
      v.querySelector(".pane-out").style.flex = "1 1 auto";
    });
    sp.addEventListener("pointerup", () => (dragging = false));
  })();

  /* panel resize (SPEC §3): the width is a token, and the handle lives inside the panel it
     resizes, so hiding the panel hides the handle. Bounds come from the matching tokens. */
  (function () {
    const specs = [
      { sel: "#sidebarResizer", varName: "--w-sidebar", min: 180, max: 360, side: "left" },
      { sel: "#outlineResizer", varName: "--w-outline", min: 160, max: 360, side: "right" },
    ];
    const read = (name, fallback) => {
      const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
      return Number.isFinite(value) ? value : fallback;
    };
    for (const spec of specs) {
      const handle = $(spec.sel);
      const panel = handle.parentElement;
      let dragging = false;
      handle.addEventListener("pointerdown", (e) => {
        dragging = true;
        handle.setPointerCapture(e.pointerId);
        handle.classList.add("dragging");
        e.preventDefault();
      });
      handle.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const r = panel.getBoundingClientRect();
        const raw = spec.side === "left" ? e.clientX - r.left : r.right - e.clientX;
        const next = Math.round(
          Math.min(read(spec.varName + "-max", spec.max), Math.max(read(spec.varName + "-min", spec.min), raw)),
        );
        document.documentElement.style.setProperty(spec.varName, next + "px");
      });
      const stop = (e) => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove("dragging");
        if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      };
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    }
  })();

  /* ===================== toasts ===================== */

  function copy(text) {
    navigator.clipboard?.writeText(text).catch(() => {});
    toast("copied to clipboard", "ok");
  }

  function toast(msg, kind) {
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = (kind ? `<span class="dot ${kind}"></span>` : "") + "<span>" + esc(msg) + "</span>";
    $("#toasts").appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity 200ms"; }, 1800);
    setTimeout(() => el.remove(), 2100);
  }

  /* ===================== editing (SPEC §12) =====================
     Read-only is the default; this is a mode you enter. The mockup has no file writer, so saving is
     simulated — but everything the design is about is real: the caret, the dirty marks, the promotion
     of a preview tab, the refusals, and the live render beside the buffer. */

  const PANES = [
    { host: "#view-source .source-view", editor: "#editor-source", input: "#out-source-edit", back: "#out-source-back", ro: "#out-source" },
    { host: "#view-split .pane-src",     editor: "#editor-split",  input: "#out-split-edit",  back: "#out-split-back",  ro: "#out-split-src" },
  ];

  const BLOCKED_REASON = {
    truncated: "not editable — the file is past the 8 MiB cap, so the buffer holds only its start",
    lossy: "not editable — the file is not valid UTF-8, and saving would make the replacement permanent",
    missing: "not editable — the file is gone",
    readonly: "not editable — the file is read-only for this user",
  };

  let saidMockupOnce = false;

  /** Paints the mode across both panes and the pill. The only writer of `.editing`, so the two panes
   *  and the pill cannot disagree about what state they are in. */
  function paintMode(t, hl) {
    const on = !!(t && t.editing);
    for (const pane of PANES) {
      $(pane.host).classList.toggle("editing", on);
      $(pane.editor).hidden = !on;
      /* The read-only pane is *emptied*, not merely hidden: find walks text nodes and does not skip
         `display: none`, so leaving the same text in both layers would double every hit and scroll the
         invisible copy instead of the one on screen. */
      $(pane.ro).innerHTML = on ? "" : (hl ?? "");
      if (!on) continue;
      $(pane.back).innerHTML = hl ?? "";
      const input = $(pane.input);
      /* Never assign the value unless it differs: assigning collapses the caret to the end, which would
         happen on every unrelated re-render — a save, a tab switch, the live-preview refresh. */
      if (input.value !== textOf(t)) input.value = textOf(t);
    }
    paintPill(t);
  }

  function paintPill(t) {
    const blocked = !!(t && t.blocked);
    /* Both panes carry a pill. The mode's pointer path has to exist wherever the pane is visible, and
       in split view the source pane is the left half — a control that only exists in another view is
       not a path, it is a footnote. (Found by driving the prototype: clicking the pill in split view
       was impossible.) */
    for (const pill of $$(".readonly-pill")) {
      pill.textContent = t && t.editing ? "editing" : "read-only";
      pill.classList.toggle("editing", !!(t && t.editing));
      pill.setAttribute("aria-disabled", blocked ? "true" : "false");
      pill.title = !t ? "" : blocked ? BLOCKED_REASON[t.blocked] : t.editing ? "done (esc)" : "edit (ctrl E)";
    }
  }

  function toggleEdit() {
    const t = tab();
    if (!t) return;
    if (t.editing) return leaveEdit();
    enterEdit(t);
  }

  function enterEdit(t) {
    if (t.blocked || t.missing) {
      toast(BLOCKED_REASON[t.blocked ?? "missing"], "err");
      return;
    }
    if (t.preview) {
      /* SPEC §12: a preview tab is reused in place by the next single click in the tree, so a buffer
         with edits in it would be replaced without a word. Entering the mode pins it first. */
      t.preview = false;
      toast("pinned — a preview tab is reused in place, so edits would be replaced by the next click", "ok");
    }
    t.editing = true;
    if (!saidMockupOnce) {
      saidMockupOnce = true;
      toast("the mockup's editor is a textarea over the highlighter — the app uses CodeMirror 6");
    }
    renderAll();
    /* Focus the caret in the pane that is actually on screen. Both editors exist, but the one in the
       inactive view has no layout, and focusing an unrendered element silently does nothing — which
       is how the first run of this prototype ended up with the caret on `body` and every keystroke
       going nowhere. */
    const pane = PANES.find((p) => $(p.editor).offsetParent !== null);
    if (pane) $(pane.input).focus();
  }

  function leaveEdit() {
    const t = tab();
    if (!t) return;
    if (t.dirty) {
      return askUnsaved("Leave the editable pane", () => { t.editing = false; renderAll(); });
    }
    t.editing = false;
    renderAll();
  }

  function saveTab(t) {
    if (!t) return;
    const wasDirty = t.dirty;
    t.dirty = false;
    renderAll();
    if (wasDirty) toast("saved — the mockup has no file writer; the app writes atomically, keeping the encoding and the line endings", "ok");
  }

  function markDirty(t) {
    if (t.dirty) return;
    t.dirty = true;
    /* No full re-render here: this runs on every keystroke, and a re-render would fight the caret. */
    renderTabs();
    $("#stDirty").hidden = false;
  }

  /* The live render is the point of editing in split view (SPEC §12). Debounced, and deliberately
     narrow: it refreshes the rendered panes, the outline and the counters, and touches nothing else. */
  let previewTimer = 0;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const t = tab();
      if (!t || !t.editing) return;
      const t0 = performance.now();
      const d = renderMarkdown(textOf(t));
      $("#out-preview").innerHTML = d.html;
      $("#out-split").innerHTML = d.html;
      wireDiagrams($("#out-preview"), d);
      wireDiagrams($("#out-split"), d);
      renderOutline(d);
      $("#stWords").textContent = textOf(t).split(/\s+/).filter(Boolean).length + " words";
      $("#stRender").textContent = "rendered in " + Math.max(1, Math.round(performance.now() - t0 + 6)) + " ms";
    }, 160);
  }

  function wireEditor(pane) {
    const input = $(pane.input);
    const back = $(pane.back);
    let syncing = false;
    /* Whichever layer scrolls, the other follows. One direction is not enough: find's `scrollIntoView`
       scrolls the backdrop, and the backdrop is the layer that shows the glyphs. */
    const follow = (from, to) => {
      if (syncing) return;
      syncing = true;
      to.scrollTop = from.scrollTop;
      to.scrollLeft = from.scrollLeft;
      syncing = false;
    };
    input.addEventListener("scroll", () => follow(input, back));
    back.addEventListener("scroll", () => follow(back, input));
    input.addEventListener("input", () => {
      const t = tab();
      if (!t || !t.editing) return;
      t.buffer = input.value;
      back.innerHTML = highlightSource(input.value);
      markDirty(t);
      schedulePreview();
      /* The marks lived in the layer that was just rebuilt; the count would be a lie. */
      if (isOn("findbar")) $("#findCount").textContent = "0/0";
    });
  }

  /* ===================== the unsaved-changes sheet ===================== */

  let pendingAction = null;

  function askUnsaved(what, action) {
    pendingAction = action;
    $("#unsavedText").textContent = what + "? This buffer has changes that are not in the file.";
    $("#unsavedOverlay").classList.add("on");
  }

  function closeUnsaved() {
    pendingAction = null;
    $("#unsavedOverlay").classList.remove("on");
  }

  /* ===================== keyboard ===================== */

  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (e.key === "Escape") {
      /* ordered: one layer closes per press, topmost first */
      if (isOn("diagramOverlay")) return closeViewer();
      if (isOn("helpOverlay")) return closeHelp();
      if (isOn("aboutOverlay")) return closeAbout();
      if (isOn("settingsOverlay")) return closeSettings();
      if (isOn("unsavedOverlay")) return closeUnsaved();
      if (state.immersive) return setImmersive(false);
      if (isOn("findbar")) return showFind(false);
      if (tab() && tab().editing) return leaveEdit();
      return $("#menu").classList.remove("on");
    }
    if (mod && key === "e") { e.preventDefault(); return toggleEdit(); }
    if (mod && key === "s") { e.preventDefault(); const t = tab(); if (t && t.editing) return saveTab(t); return; }
    if (mod && key === "f") { e.preventDefault(); return showFind(true); }
    if (mod && key === "w") { e.preventDefault(); if (state.active >= 0) return closeTab(state.active); }
    if (mod && key === "t") { e.preventDefault(); return openFile(pickNextFile(), { preview: false }); }
    if (mod && key === "b") { e.preventDefault(); return $("#toggleSidebar").click(); }
    if (mod && key === "r") { e.preventDefault(); return $("#rerender").click(); }
    if (mod && key === ",") { e.preventDefault(); return $("#openSettings").click(); }
    if (mod && e.altKey && key === "o") { e.preventDefault(); return $("#toggleOutline").click(); }
    if (mod && e.shiftKey && key === "o") { e.preventDefault(); return $("#openFolderBtn").click(); }
    if (mod && e.shiftKey && key === "a") { e.preventDefault(); return $("#listTabsBtn").click(); }
    if (mod && e.shiftKey && key === "w") {
      e.preventDefault();
      const closeAll = () => { state.tabs = []; state.active = -1; renderAll(); };
      const dirty = state.tabs.filter((t) => t.dirty).length;
      if (dirty) return askUnsaved("Close " + dirty + " unsaved tab" + (dirty === 1 ? "" : "s"), closeAll);
      return closeAll();
    }
    if (mod && e.shiftKey && key === "c") {
      e.preventDefault();
      const t = tab();
      if (t) copy("E:\\OpenCode\\MarkdownAura\\" + t.file.replace(/\//g, "\\"));
      return;
    }
    if (mod && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      const i = +e.key - 1;
      if (state.tabs[i]) { state.active = i; renderAll(); }
      return;
    }
    if (mod && key === "tab") {
      e.preventDefault();
      if (!state.tabs.length) return;
      state.active = (state.active + (e.shiftKey ? -1 : 1) + state.tabs.length) % state.tabs.length;
      return renderAll();
    }
    if (mod && (key === "=" || key === "+")) { e.preventDefault(); return setZoom(state.zoom + 10); }
    if (mod && key === "-") { e.preventDefault(); return setZoom(state.zoom - 10); }
    if (mod && key === "0") { e.preventDefault(); return setZoom(100); }
    if (e.key === "F11") { e.preventDefault(); return setImmersive(!state.immersive); }
    if (e.key === "F1") { e.preventDefault(); return openHelp(); }
  });

  /* scroll positions are per-tab */
  ["#view-preview .prose-wrap", "#view-split .pane-out", "#view-source .source-view"].forEach((sel) => {
    const el = document.querySelector(sel);
    if (el) el.addEventListener("scroll", saveScroll, { passive: true });
  });

  /* synced scrolling in split view */
  (function () {
    const src = $("#view-split .pane-src");
    const out = $("#view-split .pane-out");
    let lock = false;
    function sync(from, to) {
      if (lock) return;
      lock = true;
      const p = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
      to.scrollTop = p * (to.scrollHeight - to.clientHeight);
      requestAnimationFrame(() => (lock = false));
    }
    src.addEventListener("scroll", () => sync(src, out), { passive: true });
    out.addEventListener("scroll", () => sync(out, src), { passive: true });
  })();

  function pickNextFile() {
    const all = Object.keys(DOCS);
    const used = new Set(state.tabs.map((t) => t.file));
    return all.find((f) => !used.has(f)) || all[0];
  }

  /* drag-and-drop onto the window (the empty state's main affordance) */
  ["dragover", "drop"].forEach((ev) => {
    document.addEventListener(ev, (e) => {
      e.preventDefault();
      $("#empty").classList.toggle("dragover", ev === "dragover" && !state.tabs.length);
      if (ev === "drop" && !state.tabs.length) toast("drop received — tauri resolves the path and opens it");
    });
  });

  /* ===================== boot ===================== */

  function renderAll() {
    renderTabs();
    renderTree();
    renderContent();
  }

  /* ===================== wire the editable panes ===================== */

  PANES.forEach(wireEditor);
  /* The pill is not `disabled`, it is `aria-disabled`: a refusal has to be clickable, or the reason
     would be unreachable — a control that does nothing and says nothing is worse than no control. */
  $$(".readonly-pill").forEach((pill) => {
    /* A toolbar-style control must not take focus on click: the browser focuses the clicked button
       after the handler runs, so entering the mode left the caret unfocused and the next keystrokes
       went nowhere. (Found by driving the prototype.) */
    pill.addEventListener("mousedown", (e) => e.preventDefault());
    pill.addEventListener("click", () => {
      const t = tab();
      if (t && t.blocked) { toast(BLOCKED_REASON[t.blocked], "err"); return; }
      toggleEdit();
    });
  });
  /* The dirty mark in the status bar *is* the save control. It already says the one thing that is
     wrong ("this buffer is not in the file yet"), it is already in the accent colour, and it already
     exists — so the mouse path to saving costs no new chrome. `mousedown` is prevented for the same
     reason as on the pill: a control that steals the caret from the pane it is reporting on would
     break the next keystroke. */
  $("#stDirty").addEventListener("mousedown", (e) => e.preventDefault());
  $("#stDirty").addEventListener("click", () => {
    const t = tab();
    if (t && t.dirty) saveTab(t);
  });
  $("#unsavedSave").addEventListener("click", () => {
    const t = tab();
    closeUnsaved();
    saveTab(t);
  });
  $("#unsavedDiscard").addEventListener("click", () => {
    const action = pendingAction;
    const t = tab();
    if (t) { t.buffer = null; t.dirty = false; }
    closeUnsaved();
    if (t) renderAll();
    if (action) action();
  });
  $("#unsavedCancel").addEventListener("click", closeUnsaved);
  $("#unsavedClose").addEventListener("click", closeUnsaved);
  $("#unsavedOverlay").addEventListener("click", (e) => { if (e.target.id === "unsavedOverlay") closeUnsaved(); });

  /* ?view= & ?theme= & ?tab= & ?preview= & ?panel= & ?immersive= let screenshots target a state */
  const q = new URLSearchParams(location.search);

  if (q.get("theme")) settings.theme = q.get("theme");
  applyTheme();
  applyDocSize();
  applyMotion();
  applyMeasure();
  setZoom(100);
  openFile("README.md", { preview: false });
  openFile("architecture.md", { preview: false });
  openFile("examples/diagrams.md", { preview: false });
  state.active = Math.min(Math.max(parseInt(q.get("tab") || "0", 10) || 0, 0), state.tabs.length - 1);
  renderAll();
  /* ?preview=N marks tab N as the italic preview tab (single-click-from-tree state) */
  if (q.get("preview") !== null) {
    const pi = Math.min(Math.max(parseInt(q.get("preview"), 10) || 0, 0), state.tabs.length - 1);
    if (state.tabs[pi]) state.tabs[pi].preview = true;
    renderAll();
  }
  if (q.get("view")) setView(q.get("view"));
  if (q.get("panel") === "settings") openSettings();
  if (q.get("panel") === "help") openHelp();
  if (q.get("immersive") !== null) {
    setImmersive(true);
    if (q.get("peek") !== null) $("#win").classList.add("peeking");
  }
  if (q.get("find")) { $("#findInput").value = q.get("find"); showFind(true); runFind(true); }
  if (q.get("overlay")) {
    const d = doc(tab().file);
    const rec = d.diagrams[+q.get("overlay") || 0];
    if (rec) openViewer(rec);
  }
  /* ?edit=on boots straight into the mode. That is a **screenshot device, not a product state** — SPEC
     §12 says the app never opens in it. `?edit=truncated|lossy|missing|readonly` reaches the refusals,
     and `?edit=preview` makes the active tab the one a single tree click would reuse, so the promotion
     is visible rather than described. */
  const edit = q.get("edit");
  if (edit) {
    const t = state.tabs[state.active];
    if (t) {
      if (edit === "preview") t.preview = true;
      else if (edit === "lossy") { t.blocked = "lossy"; $("#stEnc").textContent = "utf-8-lossy"; }
      else if (edit === "missing") { t.blocked = "missing"; t.missing = true; }
      else if (edit !== "on") t.blocked = edit;
      renderAll();
      if (edit === "on") enterEdit(t);
    }
  }
})();
