# Spec fixtures

Test data, and **nothing here ships**: neither file is compiled into the app or bundled with it. They
exist so that `src/spec.rs` can measure the renderer against the reference implementations, and so that
the places where `MarkdownAura` deliberately differs can be listed rather than described.

| file | source | licence |
|---|---|---|
| `commonmark-0.31.2.json` | <https://spec.commonmark.org/0.31.2/spec.json>, fetched 2026-10-08 | **CC-BY-SA 4.0** — upstream's LICENSE: *"The CommonMark spec (spec.txt) and DTD (CommonMark.dtd) are Copyright (C) 2014-16 John MacFarlane … Released under the Creative Commons CC-BY-SA 4.0 license"* |
| `gfm-0.29.json` | the GFM spec 0.29 — `github/cmark-gfm`, `test/spec.txt`, checked 2026-10-08 at commit `27d942c8` (its front matter reads `version: 0.29`); in JSON form copied from `marktext/muya`'s `test/spec/fixtures/gfm-spec-0.29-gfm.json` | **CC-BY-SA 4.0** (the spec's own front matter: `license: '[CC-BY-SA 4.0](http://creativecommons.org/licenses/by-sa/4.0/)'`) |

**A tab is written `→` in the GFM file.** The spec source is a document meant to be read, so a tab is
made visible as an arrow; every reference runner substitutes it back before comparing, and `src/spec.rs`
does the same (`detab`) — in the *expected HTML* as well, because a tab inside a code block survives into
the output, and one backslash-escape example is about an *escaped* tab (`\→`). 13 examples in the GFM file
carry an arrow for this reason and none of them is about the arrow character. The CommonMark file needs no
such treatment: its tabs are real tabs. Getting this wrong is visible — 13 tab and code-block examples
start failing — which is how it was found.

Both files keep their upstream shape:

```json
{ "markdown": "…", "html": "…", "section": "Tabs", "example": 1 }   // CommonMark, 652 examples
{ "markdown": "…", "html": "…", "section": "Tabs", "number": 1 }    // GFM, 672 examples
```

The numbering key differs (`example` vs `number`), which is why `Example::number()` reads both.

**Refreshing.** Fetch the CommonMark JSON from the URL above and copy the GFM one from the GFM spec
tree; keep the file names and the `→`-for-tab convention. Then run `cargo test --lib spec -- --nocapture`
— it prints `actually failing: [...]`, which is what `expected-failures.json` is written from (the test
itself never writes the baseline: a baseline that updates itself measures nothing). Numbers move in one
direction only: an example that stops failing must be removed from the list, and one that starts failing
must be added with the class it belongs to.
