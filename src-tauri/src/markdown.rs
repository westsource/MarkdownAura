//! Markdown -> HTML, headings and diagram blocks, in one pass (IMPL.md §4).
//!
//! Two things here are contractual and easy to erode:
//!
//! 1. **One parse produces everything.** The outline and the preview must never disagree, so
//!    headings and diagram blocks fall out of the same walk that produces the HTML. Do not
//!    "optimise" this into two parses. Footnotes and math are the same story: a reference becomes a
//!    numbered end-note section, and a `$$…$$` inside a sentence becomes inline math (SPEC §13).
//! 2. **Raw HTML is an exact-match allow-list, not a sanitiser.** A tag on the list is emitted
//!    in its canonical form; any other tag is dropped whole. There is no attribute stripping,
//!    no entity decoding, no partial rewriting — those are where the bugs live, and not
//!    matching has no bug surface at all.
//!
//! The HTML *shape* is a contract shared with `design/prose.css` and `design/components.css`,
//! and no compiler checks it. The tests at the bottom of this module are the guard.

use std::collections::HashMap;
use std::ops::Range;

use pulldown_cmark::{html, CodeBlockKind, CowStr, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::Serialize;

/// Languages that become diagram cards instead of `<pre><code>`.
fn diagram_lang(info: &str) -> Option<&'static str> {
    match info.split_whitespace().next().unwrap_or("").to_ascii_lowercase().as_str() {
        "mermaid" => Some("mermaid"),
        "dot" => Some("dot"),
        // People write ```graphviz as often as ```dot; both are graphviz, and the badge
        // should say the engine's name either way.
        "graphviz" => Some("dot"),
        "d2" => Some("d2"),
        _ => None,
    }
}

/// Normalise an HTML slice just enough to compare it against the table: trim, lowercase, and
/// collapse whitespace runs. **This is not parsing.** The result must still match a table entry
/// exactly or the tag is dropped, which is what keeps this an allow-list.
fn normalize_tag(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_space = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch.to_ascii_lowercase());
            prev_space = false;
        }
    }
    // ` />` and ` >` carry no meaning; fold both so the table stays short.
    if out.ends_with(" >") {
        out.pop();
        out.pop();
        out.push('>');
    }
    if out.ends_with(" />") {
        out.pop();
        out.pop();
        out.pop();
        out.push_str("/>");
    }
    out
}

/// The allow-list. Everything not in here is dropped.
fn canonical_tag(raw: &str) -> Option<&'static str> {
    match normalize_tag(raw).as_str() {
        "<details>" => Some("<details>"),
        "<details open>" => Some("<details open>"),
        "</details>" => Some("</details>"),
        "<summary>" => Some("<summary>"),
        "</summary>" => Some("</summary>"),
        "<br>" | "<br/>" => Some("<br>"),
        "<hr>" | "<hr/>" => Some("<hr>"),
        "<kbd>" => Some("<kbd>"),
        "</kbd>" => Some("</kbd>"),
        "<sub>" => Some("<sub>"),
        "</sub>" => Some("</sub>"),
        "<sup>" => Some("<sup>"),
        "</sup>" => Some("</sup>"),
        _ => None,
    }
}

/// Rewrites one markdown image destination into a URL the webview can actually load, or `None` to
/// leave the author's URL alone.
///
/// It is a parameter rather than something this module decides because the rewrite needs the
/// document's own folder and the webview's asset-protocol origin — and because a relative image is
/// dead in *any* webview: `images/a.png` resolves against the app's own origin, not the folder the
/// document came from. `markdown.rs` stays a pure function of its input; `commands.rs` supplies the
/// mapping.
pub type ImageResolver<'a> = &'a dyn Fn(&str) -> Option<String>;

/// The parse options.
///
/// `math` is the one option that is not always on, and it is off by default on purpose: enabling it
/// takes `$` away from ordinary text, so a document that quotes prices renders differently. It is a
/// setting (SPEC §10), not a constant.
fn options(math: bool) -> Options {
    let base = Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH;
    if math {
        base | Options::ENABLE_MATH
    } else {
        base
    }
}

fn heading_level_u8(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// Byte offset -> 1-based line number. Built once per document; a diagram card and a heading
/// both need to report the line they came from, and scanning the source per lookup would make
/// rendering O(n²) on a large file.
struct LineIndex {
    starts: Vec<usize>,
}

impl LineIndex {
    fn new(src: &str) -> Self {
        let mut starts = vec![0usize];
        for (i, b) in src.bytes().enumerate() {
            if b == b'\n' {
                starts.push(i + 1);
            }
        }
        Self { starts }
    }

    fn line_of(&self, offset: usize) -> usize {
        match self.starts.binary_search(&offset) {
            Ok(i) => i + 1,
            Err(i) => i.max(1),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Heading {
    pub id: String,
    pub level: u8,
    pub text: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramBlock {
    pub id: String,
    pub lang: String,
    pub source: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FrontmatterField {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedDoc {
    pub html: String,
    pub headings: Vec<Heading>,
    pub diagrams: Vec<DiagramBlock>,
    pub frontmatter: Vec<FrontmatterField>,
    pub words: usize,
    pub line_count: usize,
    /// How the source decoded (`utf-8`, `utf-8-bom`, `utf-16le`, `utf-16be`, `utf-8-lossy`).
    /// Carried here rather than fetched separately so the status bar can badge a lossy decode
    /// without a second read of the file.
    #[serde(default)]
    pub encoding: String,
    /// True when the source was cut at `fs_ops::MAX_FILE_BYTES` before parsing. The caller
    /// must say so: the document on screen is then a prefix of the file on disk, and silence
    /// is how a reader ends up quoting a document that does not exist.
    #[serde(default)]
    pub truncated: bool,
}

/// Returns the frontmatter fields and the byte offset where the body starts.
///
/// A leading `---` is only frontmatter if it is closed by another `---` line; otherwise it is a
/// thematic break and the document is left alone.
fn split_frontmatter(src: &str) -> (Vec<FrontmatterField>, usize) {
    if !src.starts_with("---\n") && !src.starts_with("---\r\n") {
        return (Vec::new(), 0);
    }

    let mut fields = Vec::new();
    let mut offset = src.find('\n').map(|i| i + 1).unwrap_or(src.len());

    while offset < src.len() {
        let line_end = src[offset..]
            .find('\n')
            .map(|i| offset + i)
            .unwrap_or(src.len());
        let line = src[offset..line_end].trim_end_matches('\r');

        if line.trim() == "---" {
            let body_start = (line_end + 1).min(src.len());
            return (fields, body_start);
        }
        if let Some((key, value)) = line.split_once(':') {
            fields.push(FrontmatterField {
                key: key.trim().to_string(),
                value: value.trim().trim_matches('"').trim().to_string(),
            });
        }
        offset = line_end + 1;
    }

    // Unterminated — not frontmatter after all. Do not eat the document.
    (Vec::new(), 0)
}

/// Footnote bookkeeping, and the two rewrites that go with it (SPEC §13).
///
/// A definition is never emitted where the author wrote it: its events are buffered and rendered
/// into one `<section class="footnotes">` at the end of the document, because that is where a
/// reader looks for a note and where GFM/pandoc put it. Two things are only knowable once the whole
/// document has been read, which is why references are emitted as empty slots that `finish` fills:
///
/// * a reference can appear **before** its definition, so the numbers cannot be assigned while
///   walking (numbering follows first reference, as pandoc and GFM do);
/// * a reference with no definition must go back to the literal `[^id]` the author typed, and a
///   definition nothing refers to is dropped rather than printed.
#[derive(Default)]
struct Footnotes<'a> {
    /// The label of the definition being buffered.
    label: Option<String>,
    /// Its events, while it is being read.
    body: Option<Vec<Event<'a>>>,
    /// Every definition, in source order.
    definitions: Vec<(String, Vec<Event<'a>>)>,
    /// (label, index into the emitted events) for each reference, in document order.
    slots: Vec<(String, usize)>,
}

impl<'a> Footnotes<'a> {
    fn is_buffering(&self) -> bool {
        self.body.is_some()
    }

    fn open_definition(&mut self, label: String) {
        self.label = Some(label);
        self.body = Some(Vec::new());
    }

    fn push_body(&mut self, event: Event<'a>) {
        if let Some(body) = self.body.as_mut() {
            body.push(event);
        }
    }

    fn close_definition(&mut self) {
        if let (Some(label), Some(body)) = (self.label.take(), self.body.take()) {
            self.definitions.push((label, body));
        }
    }

    fn reference(&mut self, label: &str, out: &mut Vec<Event<'a>>) {
        self.slots.push((label.to_string(), out.len()));
        // A slot, not the final markup: its content depends on facts that arrive later.
        out.push(Event::Html(CowStr::from("")));
    }

    fn defines(&self, label: &str) -> bool {
        self.definitions.iter().any(|(name, _)| name == label)
    }

    /// Fills every reference slot and returns the end section (empty when there is nothing to show).
    fn finish(self, out: &mut Vec<Event<'a>>) -> String {
        let mut numbers: HashMap<String, usize> = HashMap::new();
        for (label, _) in &self.slots {
            if !numbers.contains_key(label) && self.defines(label) {
                let next = numbers.len() + 1;
                numbers.insert(label.clone(), next);
            }
        }
        if numbers.is_empty() {
            return String::new();
        }

        let mut seen: HashMap<String, usize> = HashMap::new();
        for (label, index) in &self.slots {
            let Some(&number) = numbers.get(label) else {
                // No definition: hand the author's text back rather than a dead link.
                out[*index] = Event::Text(CowStr::from(format!("[^{label}]")));
                continue;
            };
            let occurrence = seen.entry(label.clone()).or_insert(0);
            *occurrence += 1;
            let anchor = reference_anchor(number, *occurrence);
            out[*index] = Event::Html(CowStr::from(format!(
                "<sup class=\"footnote-ref\"><a href=\"#fn-{number}\" id=\"{anchor}\">{number}</a></sup>"
            )));
        }

        let mut ordered: Vec<(&String, usize)> = numbers.iter().map(|(l, n)| (l, *n)).collect();
        ordered.sort_by_key(|(_, number)| *number);

        let mut items = String::new();
        for (label, number) in ordered {
            let Some((_, events)) = self.definitions.iter().find(|(name, _)| name == label) else {
                continue;
            };
            let mut body = String::new();
            html::push_html(&mut body, events.iter().cloned());
            let references = *seen.get(label).unwrap_or(&1);
            items.push_str(&format!(
                "<li id=\"fn-{number}\">{}</li>\n",
                with_backrefs(&body, number, references)
            ));
        }

        format!("\n<section class=\"footnotes\">\n<ol>\n{items}</ol>\n</section>\n")
    }
}

/// `fnref-1`, then `fnref-1-2` … : an `id` has to be unique, and a note referenced twice needs a
/// way back to *each* reference (GFM numbers them the same way).
fn reference_anchor(number: usize, occurrence: usize) -> String {
    if occurrence == 1 {
        format!("fnref-{number}")
    } else {
        format!("fnref-{number}-{occurrence}")
    }
}

/// Appends one `↩` per reference, inside the note's last paragraph so the arrows sit next to the
/// last word — the shape pandoc produces. A note that does not end in a paragraph (rare: one ending
/// in a list) gets them after the block instead.
fn with_backrefs(html: &str, number: usize, references: usize) -> String {
    let mut backrefs = String::new();
    for occurrence in 1..=references {
        let anchor = reference_anchor(number, occurrence);
        let label = if occurrence == 1 {
            "↩".to_string()
        } else {
            format!("↩{occurrence}")
        };
        backrefs.push_str(&format!(
            " <a class=\"footnote-backref\" href=\"#{anchor}\">{label}</a>"
        ));
    }

    match html.rfind("</p>") {
        Some(at) => format!("{}{}{}", &html[..at], backrefs, &html[at..]),
        None => format!("{html}{backrefs}"),
    }
}

/// Renders without touching image destinations and with math off — the shape every caller with no
/// file behind the text wants.
///
/// It is the tests' shorthand, and only the tests': every shipping caller passes a resolver and the
/// reader's math setting (`render_doc`/`render_text` in `commands.rs`), so this stays out of the
/// binary rather than being a second entry point nobody uses.
#[cfg(test)]
pub fn render(src: &str) -> RenderedDoc {
    render_with(src, &|_| None, false)
}

/// `image` is called once per markdown image with the destination as the author wrote it. `None`
/// leaves the destination byte-for-byte as parsed, which is the only safe default: a `data:` URI or
/// a remote URL must not be rewritten into a local path.
///
/// `math` enables `$…$` / `$$…$$` (SPEC §10). See `options` for why it is a parameter.
pub fn render_with(src: &str, image: ImageResolver<'_>, math: bool) -> RenderedDoc {
    let (frontmatter, body_start) = split_frontmatter(src);
    let body = src.get(body_start..).unwrap_or("");
    let lines = LineIndex::new(src);

    let mut out: Vec<Event> = Vec::with_capacity(256);
    let mut headings: Vec<Heading> = Vec::new();
    let mut diagrams: Vec<DiagramBlock> = Vec::new();

    let mut heading_counter = 0usize;
    let mut current_heading: Option<usize> = None;
    // (id, lang, source, line) while inside a fenced diagram block.
    let mut capture: Option<(String, &'static str, String, usize)> = None;

    // Footnotes are collected and re-emitted as one section at the end (SPEC §13), which is what
    // makes a reference at the top of a long document clickable to a note at the bottom.
    let mut footnotes = Footnotes::default();

    // `$$…$$` is a display formula only when its paragraph holds nothing else, or the centred block
    // lands in the middle of a sentence (pandoc's rule; marktext does the same). The candidates are
    // patched in `Footnotes`-independent `out` indices when the paragraph closes.
    let mut paragraph_has_other_content = false;
    let mut display_math_candidates: Vec<usize> = Vec::new();

    for (event, range) in Parser::new_ext(body, options(math)).into_offset_iter() {
        let at = |r: &Range<usize>| lines.line_of(body_start + r.start);

        // Only `source` is written here; the rest of the tuple is read when the block closes.
        if let Some((_, _, source, _)) = capture.as_mut() {
            match event {
                Event::Text(text) => source.push_str(&text),
                Event::End(TagEnd::CodeBlock) => {
                    let (id, lang, source, line) = capture.take().expect("capture is Some");
                    diagrams.push(DiagramBlock {
                        id,
                        lang: lang.to_string(),
                        source,
                        line,
                    });
                }
                // Anything else inside a diagram fence is dropped; the source is what matters.
                _ => {}
            }
            continue;
        }

        // Inside a footnote definition: the body is buffered and rendered into the end section
        // instead of in place. A reference inside a note body does not resolve — pandoc has no
        // nested notes — so it reverts to the text the author typed.
        if footnotes.is_buffering() {
            match event {
                Event::End(TagEnd::FootnoteDefinition) => footnotes.close_definition(),
                Event::FootnoteReference(name) => {
                    footnotes.push_body(Event::Text(CowStr::from(format!("[^{name}]"))))
                }
                other => footnotes.push_body(other),
            }
            continue;
        }

        // Heading text is read through a borrow so `event` can still be moved below. Inline code
        // in a heading arrives as `Code`, not `Text`; without it the outline would drop it.
        if let Some(i) = current_heading {
            match &event {
                Event::Text(text) | Event::Code(text) => headings[i].text.push_str(text),
                _ => {}
            }
        }

        // "Does this paragraph hold anything besides the formula": text that is not whitespace, and
        // any inline construct. Soft and hard breaks do not count — a formula alone on its line is
        // still alone (marktext draws the same line), and neither does another formula.
        match &event {
            Event::Text(text) => paragraph_has_other_content |= !text.trim().is_empty(),
            Event::Code(_) | Event::Html(_) | Event::InlineHtml(_) | Event::TaskListMarker(_) => {
                paragraph_has_other_content = true
            }
            Event::Start(tag) if !matches!(tag, Tag::Paragraph | Tag::Emphasis | Tag::Strong | Tag::Link { .. }) => {
                paragraph_has_other_content = true
            }
            _ => {}
        }

        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                let id = format!("h{heading_counter}");
                heading_counter += 1;
                headings.push(Heading {
                    id: id.clone(),
                    level: heading_level_u8(level),
                    text: String::new(),
                    line: at(&range),
                });
                current_heading = Some(headings.len() - 1);

                // The id is injected here, not in the frontend: outline links must survive a
                // re-render, so ids cannot be regenerated per view.
                out.push(Event::Start(Tag::Heading {
                    level,
                    id: Some(CowStr::from(id)),
                    classes: Vec::new(),
                    attrs: Vec::new(),
                }));
            }
            Event::End(TagEnd::Heading(_)) => {
                current_heading = None;
                out.push(event);
            }
            // Math. A `$$…$$` that shares its paragraph with anything else is demoted to inline:
            // `.math-display` is a centred block, and a centred block inside a sentence is a
            // broken paragraph (pandoc and marktext agree).
            Event::DisplayMath(_) => {
                display_math_candidates.push(out.len());
                out.push(event);
            }
            Event::InlineMath(_) => out.push(event),
            Event::End(TagEnd::Paragraph) => {
                if paragraph_has_other_content {
                    for index in display_math_candidates.drain(..) {
                        if let Event::DisplayMath(text) = &out[index] {
                            out[index] = Event::InlineMath(text.clone());
                        }
                    }
                }
                display_math_candidates.clear();
                paragraph_has_other_content = false;
                out.push(event);
            }
            Event::Start(Tag::FootnoteDefinition(label)) => {
                footnotes.open_definition(label.to_string())
            }
            // Its matching `End` never arrives here: a definition body is buffered above.
            Event::End(TagEnd::FootnoteDefinition) => {}
            Event::FootnoteReference(label) => footnotes.reference(&label, &mut out),
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) => {
                match diagram_lang(&info) {
                    Some(lang) => {
                        let id = format!("d{}", diagrams.len());
                        // A placeholder, so document order survives and the frontend fills it
                        // in. No class: the frontend replaces the node with the real card.
                        out.push(Event::Html(CowStr::from(format!(
                            "<div data-diagram=\"{id}\"></div>\n"
                        ))));
                        capture = Some((id, lang, String::new(), at(&range)));
                    }
                    None => out.push(Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info)))),
                }
            }
            // Every other image destination is rewritten through the resolver (or left alone when
            // it says `None`): the `<img src>` that comes out is what the webview will actually
            // request, and only the caller knows what a relative path is relative to.
            Event::Start(Tag::Image {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                let dest_url = match image(&dest_url) {
                    Some(url) => CowStr::from(url),
                    None => dest_url,
                };
                out.push(Event::Start(Tag::Image {
                    link_type,
                    dest_url,
                    title,
                    id,
                }));
            }
            // The allow-list. `Html` is block-level raw HTML, `InlineHtml` is inside a
            // paragraph; both go through the same table.
            Event::Html(raw) | Event::InlineHtml(raw) => {
                if let Some(tag) = canonical_tag(&raw) {
                    out.push(Event::Html(CowStr::from(tag)));
                }
                // Not on the list: dropped whole, and the surrounding text is untouched.
            }
            other => out.push(other),
        }
    }

    footnotes.close_definition();
    let footnotes_html = footnotes.finish(&mut out);
    if !footnotes_html.is_empty() {
        out.push(Event::Html(CowStr::from(footnotes_html)));
    }

    // The last rewrite, and the last chance to change the event stream: CJK text writes emphasis where
    // CommonMark refuses it (`中文**"加粗"**中文`), so the runs the parser left as literal text are
    // paired here (SPEC §13, `emphasis.rs`). Additive by construction: it can only add emphasis.
    let out = crate::emphasis::widen_stream(out);

    // One `push_html` over the whole transformed stream, never one call per event — the writer
    // carries state (table alignment, tight/loose lists) across events, and per-event calls would
    // shred it.
    let mut html_out = String::with_capacity(body.len() * 3 / 2);
    html::push_html(&mut html_out, out.into_iter());

    RenderedDoc {
        html: html_out,
        headings,
        diagrams,
        frontmatter,
        words: body.split_whitespace().count(),
        line_count: src.lines().count(),
        encoding: String::new(),
        // Set by the caller from `FilePayload`, which is the only place that knows.
        truncated: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_list_keeps_only_the_listed_tags() {
        for raw in [
            "<details>",
            "</details>",
            "<details open>",
            "<br>",
            "<br/>",
            "<br />",
            "<hr>",
            "<kbd>",
            "</kbd>",
            "<sub>",
            "</sub>",
        ] {
            assert!(canonical_tag(raw).is_some(), "{raw} should be allowed");
        }
        for raw in [
            "<div align=\"center\">",
            "<script>",
            "<img src=x onerror=alert(1)>",
            "<a href=\"javascript:alert(1)\">",
            "<iframe src=\"//evil\">",
            "<span>",
            "<style>",
        ] {
            assert!(canonical_tag(raw).is_none(), "{raw} should be dropped");
        }
    }

    #[test]
    fn tags_are_normalised_before_matching_but_emitted_canonically() {
        assert_eq!(canonical_tag("<BR />"), Some("<br>"));
        assert_eq!(canonical_tag("  </KBD>  "), Some("</kbd>"));
        assert_eq!(canonical_tag("<br  />"), Some("<br>"));
        // Normalisation must not turn a bad tag into a good one.
        assert_eq!(canonical_tag("<script >"), None);
        assert_eq!(canonical_tag("<details onclick=x>"), None);
    }

    #[test]
    fn hostile_html_never_reaches_the_output() {
        let src = "# T\n\n<script>alert(1)</script>\n\n<img src=x onerror=\"steal()\">\n\n\
                   <div align=\"center\">centered</div>\n\n<a href=\"javascript:alert(1)\">x</a>\n";
        let doc = render(src);
        for needle in [
            "<script", "onerror", "javascript:", "<img", "<div", "align=",
        ] {
            assert!(
                !doc.html.contains(needle),
                "{needle} leaked into:\n{}",
                doc.html
            );
        }
    }

    #[test]
    fn allowed_tags_survive_inside_paragraphs() {
        let doc = render("Press <kbd>Ctrl</kbd> for H<sub>2</sub>O.\n");
        assert!(doc.html.contains("<kbd>Ctrl</kbd>"), "{}", doc.html);
        assert!(doc.html.contains("H<sub>2</sub>O"), "{}", doc.html);
    }

    #[test]
    fn headings_get_stable_ids_and_lines() {
        let doc = render("# One\n\ntext\n\n## Two\n");
        assert_eq!(doc.headings.len(), 2);
        assert_eq!(doc.headings[0].id, "h0");
        assert_eq!(doc.headings[0].text, "One");
        assert_eq!(doc.headings[0].line, 1);
        assert_eq!(doc.headings[1].id, "h1");
        assert_eq!(doc.headings[1].level, 2);
        assert_eq!(doc.headings[1].line, 5);
        assert!(doc.html.contains("id=\"h1\""));
    }

    #[test]
    fn diagram_fences_become_placeholders_not_code_blocks() {
        let doc = render("```mermaid\nflowchart LR\n  A --> B\n```\n");
        assert_eq!(doc.diagrams.len(), 1);
        assert_eq!(doc.diagrams[0].id, "d0");
        assert_eq!(doc.diagrams[0].lang, "mermaid");
        assert!(doc.diagrams[0].source.contains("A --> B"));
        assert_eq!(doc.diagrams[0].line, 1);
        assert!(doc.html.contains("data-diagram=\"d0\""));
        assert!(!doc.html.contains("<pre><code"), "{}", doc.html);
    }

    #[test]
    fn heading_text_includes_inline_code() {
        // `Code` is a separate event from `Text`; dropping it loses the identifier a reader
        // scans the outline for.
        let doc = render("# use `render_doc` here\n");
        assert_eq!(doc.headings[0].text, "use render_doc here");
    }

    #[test]
    fn graphviz_is_an_alias_for_dot() {
        let doc = render("```graphviz\ndigraph { a -> b }\n```\n");
        assert_eq!(doc.diagrams[0].lang, "dot");
    }

    #[test]
    fn ordinary_fences_stay_code_blocks() {
        let doc = render("```rust\nfn main() {}\n```\n");
        assert!(doc.diagrams.is_empty());
        assert!(doc.html.contains("<pre><code class=\"language-rust\">"));
    }

    #[test]
    fn frontmatter_is_stripped_and_returned() {
        let src = "---\ntitle: Test\ntags: demo\n---\n\n# Body\n";
        let doc = render(src);
        assert_eq!(doc.frontmatter.len(), 2);
        assert_eq!(doc.frontmatter[0].key, "title");
        assert_eq!(doc.frontmatter[0].value, "Test");
        assert!(doc.html.contains("Body"));
        assert!(!doc.html.contains("title: Test"));
    }

    #[test]
    fn an_unterminated_rule_is_not_frontmatter() {
        let src = "---\n\n# Body\n";
        let doc = render(src);
        assert!(doc.frontmatter.is_empty());
        assert!(doc.html.contains("Body"));
    }

    #[test]
    fn footnotes_become_an_end_section_with_backrefs() {
        // SPEC §13: the reference is numbered inline, the note itself moves to a section at the end,
        // and every reference gets its own way back.
        let doc = render("Text[^1] and again[^1].\n\n[^1]: The note.\n");
        assert!(
            doc.html.contains(
                "<sup class=\"footnote-ref\"><a href=\"#fn-1\" id=\"fnref-1\">1</a></sup>"
            ),
            "{}",
            doc.html
        );
        assert!(doc.html.contains("id=\"fnref-1-2\""), "{}", doc.html);
        assert!(doc.html.contains("<section class=\"footnotes\">"), "{}", doc.html);
        assert!(doc.html.contains("<li id=\"fn-1\">"), "{}", doc.html);
        assert!(
            doc.html.contains("class=\"footnote-backref\" href=\"#fnref-1\""),
            "{}",
            doc.html
        );
        // The definition is not rendered where it was written any more.
        assert!(!doc.html.contains("footnote-definition"), "{}", doc.html);
        // …and the section follows the paragraph that references it.
        let reference = doc.html.find("<sup class=\"footnote-ref\"").expect("reference");
        let section = doc.html.find("<section class=\"footnotes\">").expect("section");
        assert!(reference < section, "{}", doc.html);
    }

    #[test]
    fn footnote_numbers_follow_the_first_reference_not_the_definition_order() {
        // pandoc/GFM both number in reading order; the definition list here is deliberately reversed.
        let doc = render("a[^b] c[^a]\n\n[^a]: A note.\n[^b]: B note.\n");
        let b = doc.html.find("href=\"#fn-1\"").expect("note b is first");
        let a = doc.html.find("href=\"#fn-2\"").expect("note a is second");
        assert!(b < a, "{}", doc.html);
        let section = &doc.html[doc.html.find("<section class=\"footnotes\">").expect("section")..];
        let b_note = section.find("B note.").expect("b body");
        let a_note = section.find("A note.").expect("a body");
        assert!(b_note < a_note, "{section}");
    }

    #[test]
    fn a_reference_without_a_definition_goes_back_to_literal_text() {
        let doc = render("text[^nope] more\n");
        assert!(doc.html.contains("[^nope]"), "{}", doc.html);
        assert!(!doc.html.contains("<section class=\"footnotes\">"), "{}", doc.html);
    }

    #[test]
    fn a_definition_nothing_refers_to_is_not_printed() {
        let doc = render("body\n\n[^unused]: nobody points here\n");
        assert!(doc.html.contains("body"), "{}", doc.html);
        assert!(!doc.html.contains("nobody points here"), "{}", doc.html);
        assert!(!doc.html.contains("<section class=\"footnotes\">"), "{}", doc.html);
    }

    #[test]
    fn math_is_off_unless_it_is_asked_for() {
        // The whole reason the flag exists: `$` stays an ordinary character.
        let doc = render("inline $x^2$ here\n");
        assert!(doc.html.contains("$x^2$"), "{}", doc.html);
        assert!(!doc.html.contains("class=\"math"), "{}", doc.html);

        let doc = render_with("inline $x^2$ here\n", &|_| None, true);
        assert!(
            doc.html.contains("<span class=\"math math-inline\">x^2</span>"),
            "{}",
            doc.html
        );
    }

    #[test]
    fn prices_are_not_math() {
        let doc = render_with("Revenue rose from $13B to $24B.\n", &|_| None, true);
        assert!(doc.html.contains("$13B to $24B"), "{}", doc.html);
        assert!(!doc.html.contains("class=\"math"), "{}", doc.html);
    }

    #[test]
    fn display_math_alone_stays_display_and_a_sentence_demotes_it() {
        let alone = render_with("$$\na = 1\n$$\n", &|_| None, true);
        assert!(alone.html.contains("math math-display"), "{}", alone.html);

        // A centred block inside a sentence is a broken paragraph, so it renders inline instead.
        let sentence = render_with("text $$a = 1$$ text\n", &|_| None, true);
        assert!(sentence.html.contains("math math-inline"), "{}", sentence.html);
        assert!(!sentence.html.contains("math-display"), "{}", sentence.html);
    }

    #[test]
    fn line_index_handles_edges() {
        let idx = LineIndex::new("a\nbb\nccc");
        assert_eq!(idx.line_of(0), 1);
        assert_eq!(idx.line_of(2), 2);
        assert_eq!(idx.line_of(3), 2);
        assert_eq!(idx.line_of(5), 3);
    }

    #[test]
    fn the_image_resolver_rewrites_only_what_it_answers_for() {
        // A destination the resolver declines (`None`) must come out byte-for-byte as parsed —
        // that is what keeps a remote URL or a `data:` URI out of the rewrite.
        let resolve = |dest: &str| {
            if dest.starts_with("http") || dest.starts_with("data:") {
                None
            } else {
                Some(format!("asset://localhost/{dest}"))
            }
        };
        let doc = render_with(
            "![local](images/a.png)\n\n![remote](https://evil/x.png)\n\n![inline](data:image/png;base64,AA)\n",
            &resolve,
            false,
        );
        assert!(doc.html.contains("src=\"asset://localhost/images/a.png\""), "{}", doc.html);
        assert!(doc.html.contains("src=\"https://evil/x.png\""), "{}", doc.html);
        assert!(doc.html.contains("src=\"data:image/png;base64,AA\""), "{}", doc.html);
        // The alt text and the surrounding paragraph are untouched by the rewrite.
        assert!(doc.html.contains("alt=\"local\""), "{}", doc.html);
    }

    #[test]
    fn render_leaves_image_destinations_alone() {
        let doc = render("![x](images/a.png)\n");
        assert!(doc.html.contains("src=\"images/a.png\""), "{}", doc.html);
    }
}
