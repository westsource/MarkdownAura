//! Markdown -> HTML, headings and diagram blocks, in one pass (IMPL.md §4).
//!
//! Two things here are contractual and easy to erode:
//!
//! 1. **One parse produces everything.** The outline and the preview must never disagree, so
//!    headings and diagram blocks fall out of the same walk that produces the HTML. Do not
//!    "optimise" this into two parses.
//! 2. **Raw HTML is an exact-match allow-list, not a sanitiser.** A tag on the list is emitted
//!    in its canonical form; any other tag is dropped whole. There is no attribute stripping,
//!    no entity decoding, no partial rewriting — those are where the bugs live, and not
//!    matching has no bug surface at all.
//!
//! The HTML *shape* is a contract shared with `design/prose.css` and `design/components.css`,
//! and no compiler checks it. `tests/shape.rs` is the guard.

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

fn options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
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

pub fn render(src: &str) -> RenderedDoc {
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

    for (event, range) in Parser::new_ext(body, options()).into_offset_iter() {
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

        // Heading text is read through a borrow so `event` can still be moved below. Inline code
        // in a heading arrives as `Code`, not `Text`; without it the outline would drop it.
        if let Some(i) = current_heading {
            match &event {
                Event::Text(text) | Event::Code(text) => headings[i].text.push_str(text),
                _ => {}
            }
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

    // One `push_html` over the whole transformed stream, never one call per event — the writer
    // carries footnote state across events, and per-event calls would shred footnote sections.
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
    fn footnotes_survive_the_single_push_html_pass() {
        // Guards the reason `render` collects events instead of calling push_html per event:
        // the writer carries footnote state across the whole stream.
        let doc = render("Text[^1]\n\n[^1]: The note.\n");
        assert!(doc.html.contains("footnote"), "{}", doc.html);
        assert!(doc.html.contains("The note."), "{}", doc.html);
    }

    #[test]
    fn line_index_handles_edges() {
        let idx = LineIndex::new("a\nbb\nccc");
        assert_eq!(idx.line_of(0), 1);
        assert_eq!(idx.line_of(2), 2);
        assert_eq!(idx.line_of(3), 2);
        assert_eq!(idx.line_of(5), 3);
    }
}
