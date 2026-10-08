//! CommonMark / GFM spec conformance, with the failures locked as a baseline (IMPL.md §10).
//!
//! Why this exists. `pulldown-cmark` is close to the CommonMark spec on its own; the interesting
//! question is what *our* pipeline does to that, because the pipeline deliberately leaves the spec in
//! five places: the raw-HTML allow-list drops most tags, diagram fences become placeholders, headings
//! get `h{N}` ids, footnotes are collected and renumbered, and `$…$` is a setting. Those are decisions,
//! and this test is what turns them from prose into numbers.
//!
//! The contract is **compliance can only go up**. Every example either matches the reference HTML or is
//! listed in `expected-failures.json`: an example that starts passing while it is listed fails the test
//! (remove the line), and an example that starts failing while it is *not* listed fails it as well. So a
//! change to the allow-list, the footnote rewrite or the placeholder pass cannot quietly move the
//! renderer further from the reference — it has to be written down here as a new expected failure, in a
//! diff a reviewer can see.
//!
//! The comparison is not byte-exact: [`normalize`] folds what is not meaning — the space in `<br />`,
//! whitespace between two tags, a trailing newline, the `id="h{N}"` this app puts on a heading, and the
//! three ways a writer can spell a quote character. What remains is a difference in the tree a reader
//! gets. Attribute *order* is deliberately not folded, and neither is pulldown's use of
//! `style="text-align: left"` where cmark writes `align="left"` — those examples are expected failures,
//! which is the honest place for them. Heading ids are folded rather than listed because the id is an
//! anchor this app adds, not a difference in the document; its *values* (unique, stable, in document
//! order) are pinned by the unit tests in `markdown.rs` instead.
//!
//! Two fixture conventions are undone before the comparison, both because the spec source is a document
//! meant to be *read*: a tab is written `→` in the source so it is visible, and the reference runner
//! substitutes it back before comparing (`spec_tests.py` does the same — which is why the arrow is
//! restored in the expected HTML too, a tab inside a code block survives into the output). Nothing else
//! about a fixture is rewritten; the JSON is otherwise the published file, byte for byte.
//!
//! Fixtures are test data only (`tests/spec/README.md` has the provenance; both are CC-BY-SA 4.0).
//! Nothing in this module ships: it is `#[cfg(test)]`.

use crate::markdown;
use serde::Deserialize;
use std::collections::BTreeSet;
use std::path::PathBuf;

/// One spec example. CommonMark numbers them `example`, the GFM fixture `number`.
#[derive(Debug, Deserialize)]
struct Example {
    markdown: String,
    html: String,
    #[serde(default)]
    example: Option<usize>,
    #[serde(default)]
    number: Option<usize>,
    #[serde(default)]
    section: String,
}

impl Example {
    fn number(&self) -> usize {
        self.example.or(self.number).unwrap_or(0)
    }
}

/// The locked baseline. `_comment` is required so the file cannot be mistaken for data: refreshing it
/// is a decision, not a step in the test.
#[derive(Debug, Deserialize)]
struct Baseline {
    #[allow(dead_code)]
    #[serde(rename = "_comment")]
    comment: String,
    #[serde(default)]
    commonmark: BTreeSet<usize>,
    #[serde(default)]
    gfm: BTreeSet<usize>,
}

fn spec_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("spec")
}

fn read_json<T: for<'a> Deserialize<'a>>(file: &str) -> T {
    let path = spec_dir().join(file);
    let body = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("{} is missing or unreadable: {err}", path.display()));
    serde_json::from_str(&body)
        .unwrap_or_else(|err| panic!("{} is not the shape this test expects: {err}", path.display()))
}

/// The spec source writes a tab as `→` so it is visible in the published document; the reference runner
/// substitutes it back before comparing. This applies to the expected HTML as well, because a tab inside
/// a code block survives into the output (and `\→` is an *escaped* tab, which is what one of the
/// backslash-escape examples is about).
fn detab(text: &str) -> String {
    text.replace('\u{2192}', "\t")
}

/// `<h2 id="h5">` → `<h2>`. The id is the app's anchor for scrolling and links, not part of the
/// document; `markdown.rs` pins the values it produces.
fn fold_heading_ids(html: &str) -> String {
    let mut out = html.to_string();
    for level in 1..=6 {
        let open = format!("<h{level} id=\"");
        while let Some(at) = out.find(&open) {
            let rest = &out[at + open.len()..];
            let Some(close) = rest.find('"') else { break };
            out.replace_range(at..at + open.len() + close + 1, &format!("<h{level}"));
        }
    }
    out
}

/// Folds the differences that are not the document.
///
/// `<br />`, `<br/>` and `<br>` are one element; whitespace *between* two tags is not content, which is
/// where cmark's and our writer's pretty-printing disagree; a trailing newline is a writer's habit. An
/// escaping choice is the same character: cmark writes `&quot;` where our writer writes `"`.
/// Everything else is compared as written — in particular attribute order, because folding it would
/// hide a real difference in what the reader's CSS sees.
fn normalize(html: &str) -> String {
    let folded = fold_heading_ids(html)
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace(" />", ">")
        .replace("/>", ">");
    let mut out = String::with_capacity(folded.len());
    let mut chars = folded.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '>' {
            // Look ahead: is this `>` followed by whitespace and then another tag? Then the run is
            // layout, not text, and it goes.
            let mut ahead = chars.clone();
            let mut spaces = false;
            while matches!(ahead.peek(), Some(w) if w.is_whitespace()) {
                spaces = true;
                ahead.next();
            }
            if spaces && ahead.peek() == Some(&'<') {
                while matches!(chars.peek(), Some(w) if w.is_whitespace()) {
                    chars.next();
                }
                out.push('>');
                continue;
            }
        }
        out.push(c);
    }

    out.trim().to_string()
}

struct Outcome {
    name: &'static str,
    passed: usize,
    total: usize,
    /// Listed as failing, but now passes: the baseline has to shrink.
    unexpected_pass: Vec<usize>,
    /// Not listed, and fails: the renderer moved away from the reference.
    new_failures: Vec<String>,
}

/// What the renderer produced and what the reference says, each in comparable form. One helper for
/// both, because the count and the "actually failing" list must agree — a second copy of this expression
/// is a second chance for them to drift.
fn compare(example: &Example) -> (String, String) {
    (
        normalize(&markdown::render(&detab(&example.markdown)).html),
        normalize(&detab(&example.html)),
    )
}

fn run(name: &'static str, fixture: &str, listed: &BTreeSet<usize>) -> Outcome {
    let examples: Vec<Example> = read_json(fixture);
    let mut outcome = Outcome {
        name,
        passed: 0,
        total: examples.len(),
        unexpected_pass: Vec::new(),
        new_failures: Vec::new(),
    };

    for example in &examples {
        let (got, want) = compare(example);
        let number = example.number();

        if got == want {
            outcome.passed += 1;
            if listed.contains(&number) {
                outcome.unexpected_pass.push(number);
            }
        } else if !listed.contains(&number) {
            outcome.new_failures.push(format!(
                "#{number} ({}):\n  got:  {}\n  want: {}",
                example.section,
                snippet(&got),
                snippet(&want)
            ));
        }
    }

    // The full failing set, so refreshing the baseline is a copy from the output rather than a guess.
    let failing: Vec<String> = examples
        .iter()
        .filter(|e| {
            let (got, want) = compare(e);
            got != want
        })
        .map(|e| e.number().to_string())
        .collect();
    println!(
        "{}: {}/{} pass . expected failures: {} . actually failing: [{}]",
        outcome.name,
        outcome.passed,
        outcome.total,
        listed.len(),
        failing.join(",")
    );

    outcome
}

fn snippet(html: &str) -> String {
    const MAX: usize = 120;
    let mut text = html.replace('\n', "\\n");
    if text.len() > MAX {
        text.truncate(MAX);
        text.push('…');
    }
    text
}

/// The gate. Two suites, one baseline, and a failure message that says which way compliance moved.
#[test]
fn spec_conformance_is_locked() {
    let baseline: Baseline = read_json("expected-failures.json");
    let outcomes = [
        run("commonmark-0.31.2", "commonmark-0.31.2.json", &baseline.commonmark),
        run("gfm-0.29", "gfm-0.29.json", &baseline.gfm),
    ];

    let mut problems = String::new();
    for outcome in &outcomes {
        for number in &outcome.unexpected_pass {
            problems.push_str(&format!(
                "\n{}: example #{number} passes now but is listed in expected-failures.json — \
                 remove it from the list (compliance only goes up).",
                outcome.name
            ));
        }
        for failure in &outcome.new_failures {
            problems.push_str(&format!(
                "\n{}: {} — a difference the baseline does not list. Either fix the renderer or add \
                 the example to expected-failures.json with a reason.\n{failure}\n",
                outcome.name,
                failure.split(':').next().unwrap_or("example")
            ));
        }
    }

    assert!(
        problems.is_empty(),
        "spec conformance moved:\n{problems}\n\n\
         Rates: {}\n\
         Refresh the baseline only on purpose — it is the record of where the renderer deliberately \
         differs from the reference.",
        outcomes
            .iter()
            .map(|o| format!("{} {}/{}", o.name, o.passed, o.total))
            .collect::<Vec<_>>()
            .join(", ")
    );
}

