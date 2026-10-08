//! CJK emphasis widening (SPEC §13, IMPL.md §4).
//!
//! **The problem.** CommonMark decides whether `*`/`_` may open or close by flanking rules that treat
//! a CJK ideograph exactly like a Latin letter. Chinese and Japanese have no word spacing, so the
//! punctuation-adjacent shape is ordinary prose: `中文**"加粗"**中文`. There the run before `"` cannot
//! open (`next` is punctuation and `prev` is neither whitespace nor punctuation), and the run after the
//! closing quote cannot close, so the whole thing renders literally. `marktext` widens the same way and
//! documents it as `NON-STANDARD EXTENSION — a deliberate divergence from CommonMark`; Typora, VS Code
//! and Joplin do as well.
//!
//! **The rule here, and why it is narrow.** A run is widened only when the neighbour that CommonMark
//! refuses *is* CJK and the other side is punctuation:
//!
//! * open: `prev` is CJK and `next` is punctuation — `中文**"x"**` opens;
//! * close: `prev` is punctuation and `next` is CJK — `"x"**中文` closes.
//!
//! Nothing else changes: whitespace still blocks both directions (a space before a closer must never
//! close), a Latin neighbour is untouched, a run whose length is not one or two is left alone, and a run
//! the parser already accepted never reaches this pass at all (only literal text does). The widening is
//! **additive** — it can turn a refusal into an acceptance, never the other way — so a document that
//! renders one way today cannot render differently because of it, except by gaining the emphasis its
//! author typed.
//!
//! `_` is deliberately *not* widened even though CommonMark's rules for it are narrower still. `*` is
//! what Chinese and Japanese writers type for emphasis, and `_` intraword is a rule readers of Latin
//! text rely on; widening it would be a divergence nothing asked for.
//!
//! **Why the pass works on a flattened run.** The parser splits text at every token boundary, so
//! `中文**"加粗"**中文` arrives as *six* `Text` events (`中文`, `*`, `*`, `"加粗"`, `*`, `*`) — one
//! marker per event, each with no neighbour inside its own event. Reading a `Text` event in isolation
//! therefore finds nothing at all: the two halves of the run are in different events, and the character
//! that decides flanking is in a third. The run's text is concatenated back into one string (with a
//! byte → `(event, offset)` map so a cut lands in the event it really came from), the markers are found
//! there, and they are cut back out of the events they were in. Inline containers whose children are
//! rendered — emphasis, strong, links — contribute no bytes and are *not* boundaries, so a widened span
//! may contain them.

use pulldown_cmark::{CowStr, Event, Tag, TagEnd};

/// The longest marker run this pass will pair. `***` mixes strong and emphasis in ways that are not a
/// widening question, so it keeps CommonMark's answer.
const MAX_RUN: usize = 2;

/// Is this character written without word spacing — Han, kana, Hangul?
///
/// Ranges rather than a Unicode script table: the alternative is a new dependency for one predicate.
/// A false negative costs nothing here (the text keeps rendering the way it does today), which is what
/// makes an approximation acceptable at all.
fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{2e80}'..='\u{2eff}'       // CJK radicals
        | '\u{3000}'..='\u{303f}'     // CJK symbols and punctuation
        | '\u{3040}'..='\u{30ff}'     // hiragana, katakana
        | '\u{3100}'..='\u{312f}'     // bopomofo
        | '\u{3400}'..='\u{4dbf}'     // CJK extension A
        | '\u{4e00}'..='\u{9fff}'     // CJK unified ideographs
        | '\u{ac00}'..='\u{d7af}'     // hangul syllables
        | '\u{f900}'..='\u{faff}'     // CJK compatibility ideographs
        | '\u{ff00}'..='\u{ffef}'     // fullwidth forms
        | '\u{20000}'..='\u{2ffff}') // CJK extension B and beyond
}

/// Punctuation as the *neighbour of a widened run* sees it: ASCII punctuation plus the general and
/// fullwidth punctuation blocks CJK text actually uses (`"…"`, `「…」`, `，`, `。`, `！`, `？`, `：`, `；`).
///
/// Same trade as [`is_cjk`]: a miss simply leaves CommonMark's answer standing, so an approximation is
/// safe in one direction only — and this is that direction.
fn is_punct_like(c: char) -> bool {
    c.is_ascii_punctuation()
        || matches!(c,
            '\u{2010}'..='\u{2027}'  // general punctuation: dashes, quotes, ellipsis
            | '\u{2030}'..='\u{205e}'
            | '\u{3001}'..='\u{3003}' // 、。〈 〉
            | '\u{3008}'..='\u{3011}' // 〈〉《》「」『』【】
            | '\u{3014}'..='\u{301f}' // 〔〕〖〗
            | '\u{ff01}'..='\u{ff03}' // ！＂＃
            | '\u{ff05}'..='\u{ff0a}' // ％＆＇（）＊
            | '\u{ff0c}'..='\u{ff0f}' // ，－．／
            | '\u{ff1a}'..='\u{ff1b}' // ：；
            | '\u{ff1c}'..='\u{ff1e}' // ＜＝＞
            | '\u{ff1f}'..='\u{ff20}' // ？＠
            | '\u{ff3b}'..='\u{ff3d}' // ［＼］
            | '\u{ff5b}'..='\u{ff5e}' // ｛｜｝～
            | '\u{ff5f}'..='\u{ff65}') // ｟｠｡｢｣､･
}

/// A marker run found in the flattened text of one inline run.
struct Delim {
    /// Byte range in the flattened text.
    start: usize,
    end: usize,
    /// `1` (emphasis) or `2` (strong) — the tag this run pairs into.
    len: usize,
    can_open: bool,
    can_close: bool,
}

/// How one event gets rewritten.
enum Kind {
    /// Push `Start(tag)` at `at`, before anything else at that offset.
    Open(Tag<'static>),
    /// Push `End(tag)` at `at`.
    Close(TagEnd),
    /// Drop `len` bytes from `at`.
    Cut(usize),
}

impl Kind {
    /// Ordering for edits that share an offset: the tag goes outside the marker it replaces.
    fn rank(&self) -> u8 {
        match self {
            Kind::Open(_) => 0,
            Kind::Cut(_) => 1,
            Kind::Close(_) => 2,
        }
    }
}

/// One edit to one event. `at` is a byte offset in that event's text.
struct Edit {
    event: usize,
    at: usize,
    kind: Kind,
}

/// A run's text, plus where each byte of it came from.
struct Flat {
    text: String,
    /// One entry per byte of `text`: the event it came from and its offset inside that event. A break
    /// event contributes a newline with the break's own index, which is never a cut target.
    origin: Vec<(usize, usize)>,
}

impl Flat {
    fn push_text(&mut self, event: usize, text: &str) {
        self.text.push_str(text);
        self.origin.reserve(text.len());
        for offset in 0..text.len() {
            self.origin.push((event, offset));
        }
    }

    /// A soft or hard break is whitespace for flanking purposes: it blocks both directions, exactly
    /// like a space.
    fn push_break(&mut self, event: usize) {
        self.text.push('\n');
        self.origin.push((event, 0));
    }
}

/// Widens the CJK-adjacent markers inside one inline run, or returns `None` when there is nothing to do
/// — the common case, and the reason the caller can skip the rebuild entirely.
pub(crate) fn widen<'a>(events: &[Event<'a>]) -> Option<Vec<Event<'a>>> {
    // Cheap refusal first: most runs hold no marker byte at all, and this pass runs on every render.
    if !events.iter().any(|event| match event {
        Event::Text(text) => text.as_bytes().contains(&b'*'),
        _ => false,
    }) {
        return None;
    }

    let flat = flatten(events);
    let delims = markers(&flat);
    if delims.is_empty() {
        return None;
    }
    let pairs = pair(&delims);
    if pairs.is_empty() {
        return None;
    }
    let mut edits = edits_for(&flat, &delims, &pairs);
    Some(rebuild(events, &mut edits))
}

/// Concatenates the run's visible text. Inline containers contribute nothing (they are not boundaries,
/// so the span may contain them), and a break contributes a newline.
fn flatten(events: &[Event<'_>]) -> Flat {
    let bytes: usize = events
        .iter()
        .map(|event| match event {
            Event::Text(text) => text.len(),
            Event::SoftBreak | Event::HardBreak => 1,
            _ => 0,
        })
        .sum();
    let mut flat = Flat {
        text: String::with_capacity(bytes),
        origin: Vec::with_capacity(bytes),
    };
    for (index, event) in events.iter().enumerate() {
        match event {
            Event::Text(text) => flat.push_text(index, text),
            Event::SoftBreak | Event::HardBreak => flat.push_break(index),
            _ => {}
        }
    }
    flat
}

/// Every marker run in the flattened text, with the flanking characters that decide whether it may open
/// or close.
fn markers(flat: &Flat) -> Vec<Delim> {
    let bytes = flat.text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'*' {
            i += 1;
            continue;
        }
        let mut end = i;
        while end < bytes.len() && bytes[end] == b'*' {
            end += 1;
        }
        let len = end - i;
        if len <= MAX_RUN {
            // Flanking looks at the character *outside* the run, on both sides.
            let prev = flat.text[..i].chars().next_back();
            let next = flat.text[end..].chars().next();
            let can_open = prev.is_some_and(|prev| is_cjk(prev) && next.is_some_and(is_punct_like));
            let can_close = next.is_some_and(|next| is_cjk(next) && prev.is_some_and(is_punct_like));
            if can_open || can_close {
                out.push(Delim {
                    start: i,
                    end,
                    len,
                    can_open,
                    can_close,
                });
            }
        }
        i = end;
    }
    out
}

/// Pairs openers with the nearest unused closer of the same length, left to right. Nearest-closer is
/// what CommonMark does; equal length keeps the result to the one shape this pass is for.
fn pair(delims: &[Delim]) -> Vec<(usize, usize)> {
    let mut used = vec![false; delims.len()];
    let mut pairs = Vec::new();
    for i in 0..delims.len() {
        if used[i] || !delims[i].can_open {
            continue;
        }
        let closer = (i + 1..delims.len())
            .find(|&k| !used[k] && delims[k].can_close && delims[k].len == delims[i].len);
        if let Some(k) = closer {
            used[i] = true;
            used[k] = true;
            pairs.push((i, k));
        }
    }
    pairs
}

/// Turns a pair into the edits that drop both markers and put the tag where they were.
fn edits_for(flat: &Flat, delims: &[Delim], pairs: &[(usize, usize)]) -> Vec<Edit> {
    let mut edits = Vec::with_capacity(pairs.len() * 4);
    for &(open, close) in pairs {
        let (opening, closing) = (&delims[open], &delims[close]);
        // `Start` carries a `Tag`, `End` carries a `TagEnd`; one of each is built here.
        let (start, end) = if opening.len == 2 {
            (Tag::Strong, TagEnd::Strong)
        } else {
            (Tag::Emphasis, TagEnd::Emphasis)
        };
        // The marker may straddle two events (`*` and `*`), so the cut is emitted per event.
        let (event, at) = flat.origin[opening.start];
        edits.push(Edit {
            event,
            at,
            kind: Kind::Open(start),
        });
        cut(flat, opening.start, opening.end, &mut edits);
        cut(flat, closing.start, closing.end, &mut edits);
        let (event, at) = flat.origin[closing.end - 1];
        edits.push(Edit {
            event,
            at: at + 1,
            kind: Kind::Close(end),
        });
    }
    edits
}

/// One `Cut` per (event, contiguous range) inside `start..end`.
fn cut(flat: &Flat, start: usize, end: usize, out: &mut Vec<Edit>) {
    let mut i = start;
    while i < end {
        let (event, at) = flat.origin[i];
        let mut j = i + 1;
        while j < end && flat.origin[j] == (event, at + (j - i)) {
            j += 1;
        }
        out.push(Edit {
            event,
            at,
            kind: Kind::Cut(j - i),
        });
        i = j;
    }
}

/// Drops each paired marker from its text and puts the tag where it was.
fn rebuild<'a>(events: &[Event<'a>], edits: &mut Vec<Edit>) -> Vec<Event<'a>> {
    edits.sort_by_key(|edit| (edit.event, edit.at, edit.kind.rank()));

    let mut out = Vec::with_capacity(events.len() + edits.len() + 1);
    let mut offset = 0usize;
    for (index, event) in events.iter().enumerate() {
        let mine = &edits[offset..];
        let count = mine.iter().take_while(|edit| edit.event == index).count();
        if count == 0 {
            out.push(event.clone());
            continue;
        }
        offset += count;

        let Event::Text(text) = event else {
            // Edits only ever land in `Text` events (`flatten` gives no other event a byte a cut can
            // reach), so this is unreachable — but pushing the event keeps the stream well-formed.
            debug_assert!(false, "edit landed in a non-text event");
            out.push(event.clone());
            continue;
        };

        let piece = |from: usize, to: usize| -> Option<Event<'a>> {
            (to > from).then(|| Event::Text(CowStr::from(text[from..to].to_string())))
        };
        let mut pos = 0usize;
        for edit in &mine[..count] {
            match &edit.kind {
                Kind::Open(tag) => {
                    if let Some(piece) = piece(pos, edit.at) {
                        out.push(piece);
                    }
                    out.push(Event::Start(tag.clone()));
                    pos = edit.at;
                }
                Kind::Cut(len) => {
                    if let Some(piece) = piece(pos, edit.at) {
                        out.push(piece);
                    }
                    pos = edit.at + len;
                }
                Kind::Close(tag) => {
                    if let Some(piece) = piece(pos, edit.at) {
                        out.push(piece);
                    }
                    out.push(Event::End(tag.clone()));
                    pos = edit.at;
                }
            }
        }
        if let Some(piece) = piece(pos, text.len()) {
            out.push(piece);
        }
    }
    out
}

/// The whole stream: split into inline runs, widen each one, and hand the writer an ordinary stream
/// (IMPL.md §4 — this runs before `push_html`, so the writer sees real `Start(Strong)`/`End(Strong)`).
pub(crate) fn widen_stream(events: Vec<Event<'_>>) -> Vec<Event<'_>> {
    fn flush<'a>(run: &mut Vec<Event<'a>>, out: &mut Vec<Event<'a>>) {
        if run.is_empty() {
            return;
        }
        match widen(run) {
            Some(widened) => {
                out.extend(widened);
                run.clear();
            }
            None => out.append(run),
        }
    }

    let mut out = Vec::with_capacity(events.len() + 8);
    let mut run = Vec::new();
    // An image's children are not rendered: they become the `alt` attribute, so a cut inside one would
    // edit an attribute value. The whole element is copied verbatim, nested images included.
    let mut inside_image = 0usize;
    for event in events {
        if inside_image > 0 {
            match &event {
                Event::Start(Tag::Image { .. }) => inside_image += 1,
                Event::End(TagEnd::Image) => inside_image -= 1,
                _ => {}
            }
            out.push(event);
            continue;
        }
        if matches!(event, Event::Start(Tag::Image { .. })) {
            flush(&mut run, &mut out);
            inside_image = 1;
            out.push(event);
        } else if is_boundary(&event) {
            flush(&mut run, &mut out);
            out.push(event);
        } else {
            run.push(event);
        }
    }
    flush(&mut run, &mut out);
    out
}

/// Where an inline run stops.
///
/// Block structure is a boundary because flanking must not reach across it. `Code`, `InlineMath`,
/// `FootnoteReference` and `Html`/`InlineHtml` are boundaries too: a marker next to one of them is left
/// alone rather than reasoned about, which costs the widening in `中文**"注[^1]"**中文` and buys never
/// having to decide what a raw element inside an emphasis span means. `Image` is a boundary for a
/// different reason — its children are not rendered, they become the `alt` attribute, so a tag inserted
/// inside one would land in an attribute. Inline containers whose children *are* rendered (emphasis,
/// strong, strikethrough, links) are deliberately not boundaries: a widened span may contain them, and
/// the tag inserted at the closer still lands after them.
fn is_boundary(event: &Event<'_>) -> bool {
    match event {
        Event::Text(_) | Event::SoftBreak | Event::HardBreak => false,
        Event::Start(tag) => !matches!(
            tag,
            Tag::Emphasis | Tag::Strong | Tag::Strikethrough | Tag::Link { .. }
        ),
        Event::End(tag) => !matches!(
            tag,
            TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link
        ),
        _ => true,
    }
}

/// Renders markdown with the widening applied — the shape the tests below use.
#[cfg(test)]
fn render_widened(src: &str) -> String {
    let events: Vec<Event> =
        pulldown_cmark::Parser::new_ext(src, pulldown_cmark::Options::empty()).collect();
    let mut out = String::new();
    pulldown_cmark::html::push_html(&mut out, widen_stream(events).into_iter());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use pulldown_cmark::{Options, Parser};

    /// The same document through the parser alone: what CommonMark already does without this pass. Used
    /// where the assertion is "the pass adds nothing", so the test does not also pin the parser's own
    /// output for a shape the parser half-accepts.
    fn render_plain(src: &str) -> String {
        let events: Vec<Event> = Parser::new_ext(src, Options::empty()).collect();
        let mut out = String::new();
        pulldown_cmark::html::push_html(&mut out, events.into_iter());
        out
    }

    #[test]
    fn a_cjk_neighbour_lets_a_punctuation_adjacent_run_open_and_close() {
        assert_eq!(
            render_widened("中文**\"加粗\"**中文\n"),
            "<p>中文<strong>\"加粗\"</strong>中文</p>\n"
        );
        assert_eq!(
            render_widened("中文*\"斜体\"*中文\n"),
            "<p>中文<em>\"斜体\"</em>中文</p>\n"
        );
    }

    #[test]
    fn cjk_punctuation_counts_as_punctuation_too() {
        assert_eq!(
            render_widened("中文**「加粗」**中文\n"),
            "<p>中文<strong>「加粗」</strong>中文</p>\n"
        );
        assert_eq!(
            render_widened("中文**，加粗。**中文\n"),
            "<p>中文<strong>，加粗。</strong>中文</p>\n"
        );
    }

    #[test]
    fn latin_neighbours_are_left_to_commonmark() {
        // The widening is only for the shape CommonMark refuses *because* the neighbour is CJK.
        assert_eq!(render_widened("word**\"x\"**word\n"), "<p>word**\"x\"**word</p>\n");
        // `a **"x"** b` is the classical case and already works.
        assert_eq!(render_widened("a **\"x\"** b\n"), "<p>a <strong>\"x\"</strong> b</p>\n");
    }

    #[test]
    fn whitespace_still_blocks_both_directions() {
        // A space before a closer must never close, and a space after an opener is the same rule from
        // the other side. Neither is a widening shape, so the pass leaves the parser's answer standing.
        assert_eq!(render_widened("中文**加粗 **中文\n"), render_plain("中文**加粗 **中文\n"));
        assert_eq!(render_widened("中文 **加粗**中文\n"), render_plain("中文 **加粗**中文\n"));
    }

    #[test]
    fn strings_that_already_parse_are_untouched() {
        // Nothing here is literal text, so the pass never sees a marker.
        assert_eq!(
            render_widened("中文 **加粗** 中文\n"),
            "<p>中文 <strong>加粗</strong> 中文</p>\n"
        );
        assert_eq!(render_widened("中文*斜体*中文\n"), "<p>中文<em>斜体</em>中文</p>\n");
    }

    #[test]
    fn an_unmatched_opener_stays_literal() {
        assert_eq!(render_widened("中文**\"没有闭合\n"), "<p>中文**\"没有闭合</p>\n");
    }

    #[test]
    fn three_character_runs_are_left_alone() {
        assert_eq!(
            render_widened("中文***加粗***中文\n"),
            render_plain("中文***加粗***中文\n")
        );
    }

    #[test]
    fn code_spans_are_not_text_and_are_never_touched() {
        // The marker next to a code span is not widened: `Code` is a boundary, so the character that
        // would decide flanking is invisible to the pass and the pass declines. Inside the span there is
        // nothing to widen at all — it is text, not markup.
        assert_eq!(render_widened("中文**`code`**中文\n"), render_plain("中文**`code`**中文\n"));
        assert_eq!(
            render_widened("中文**\"`code`\"**中文\n"),
            render_plain("中文**\"`code`\"**中文\n")
        );
        assert!(render_widened("中文**`code`**中文\n").contains("<code>code</code>"));
    }

    #[test]
    fn a_widened_span_can_contain_inline_markup() {
        // `*乙*` is the parser's; the outer pair is this pass's, and its tags land outside the `<em>`.
        assert_eq!(
            render_widened("中文**\"甲\"*乙*\"丙\"**中文\n"),
            "<p>中文<strong>\"甲\"<em>乙</em>\"丙\"</strong>中文</p>\n"
        );
    }

    #[test]
    fn markers_inside_a_link_are_widened_in_place() {
        assert_eq!(
            render_widened("[中文**\"甲\"**中文](https://example.com)\n"),
            "<p><a href=\"https://example.com\">中文<strong>\"甲\"</strong>中文</a></p>\n"
        );
    }

    #[test]
    fn an_image_alt_is_a_boundary() {
        // An image's children become the `alt` attribute, so a tag inserted among them would land in an
        // attribute. Nothing here is widened.
        assert_eq!(
            render_widened("![中文**\"甲\"**中文](i.png)\n"),
            render_plain("![中文**\"甲\"**中文](i.png)\n")
        );
    }

    #[test]
    fn a_break_counts_as_whitespace() {
        // `中文**` at the end of a line: the character after the marker is a newline, which blocks an
        // opener exactly like a space does.
        let rendered = render_widened("中文**\n\"甲\"**中文\n");
        assert!(
            !rendered.contains("<strong>"),
            "break did not block the opener: {rendered}"
        );
    }

    #[test]
    fn emphasis_is_never_double_wrapped() {
        assert_eq!(
            render_widened("中文**\"外 *内* 外\"**中文\n"),
            "<p>中文<strong>\"外 <em>内</em> 外\"</strong>中文</p>\n"
        );
    }

    #[test]
    fn two_spans_in_one_run_wrap_separately() {
        // The parser takes the middle `**和**` for itself — for `*`, an opener only needs a
        // non-punctuation character after it, and `和` qualifies — and this pass then wraps the two
        // outer spans around it, so `和` ends up inside the widened strong as well. That is the reading
        // the author typed: one span, whose text contains an emphasis the parser had already found.
        assert_eq!(
            render_widened("中文**\"甲\"**和**\"乙\"**中文\n"),
            "<p>中文<strong>\"甲\"<strong>和</strong>\"乙\"</strong>中文</p>\n"
        );
    }

    #[test]
    fn underscore_is_left_to_commonmark() {
        assert_eq!(
            render_widened("中文__\"加粗\"__中文\n"),
            "<p>中文__\"加粗\"__中文</p>\n"
        );
    }

    #[test]
    fn a_marker_at_the_paragraph_edge_needs_a_neighbour_to_widen() {
        // The closing run's next character is CJK, but the opening run is at the very start of the
        // paragraph: there is no `prev` to judge, so this pass declines.
        assert_eq!(render_widened("**\"加粗\"**中文\n"), "<p>**\"加粗\"**中文</p>\n");
    }
}
