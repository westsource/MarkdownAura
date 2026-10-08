/* KaTeX (SPEC §13, §10).
 *
 * Math is a **setting**, off by default, and this file is the whole reason that setting can be
 * honest: the Rust side stops turning `$…$` into `<span class="math …">` when it is off, so a
 * document that talks about prices keeps talking about prices.
 *
 * What is deliberately *not* here, and why (all four come from marktext, which learned them in
 * production):
 *
 *  - **No macros.** marktext has no `\newcommand` support anywhere, so there is nothing to copy; a
 *    half-supported macro system that does not survive into the render cache is worse than none.
 *  - **No custom options.** `open` and `rust`'s `\int_0^1` matter, so the KaTeX options are the two
 *    that change behaviour: `displayMode` and `throwOnError: false`.
 *  - **`mhchem` is a side-effect import, in exactly one place.** It patches the KaTeX instance that
 *    is already loaded, so importing it anywhere else would be a second, silent patch.
 *  - **A failure never moves the text.** Inline math that fails keeps its place and carries the
 *    reason, because a swapped-in error block in the middle of a sentence breaks the line it sits in.
 *
 * **Why the imports are dynamic (and must stay dynamic)**: KaTeX's JS, its ~250 KB of woff2 fonts and
 * the CSS it needs must not all load for a reader who never sees a formula, and the setting is off
 * for most sessions. The one piece that is *not* lazy is the stylesheet itself (imported at the top
 * of this file, so it lands in the main stylesheet): the JS import is what the first formula waits
 * for, and paying 23 KB of CSS up front buys the absence of a flash of unstyled math. This is the
 * `engines.ts` rule again, with that one deliberate exception.
 */
import "katex/dist/katex.min.css";

/** The slice of KaTeX this file uses. The package ships its own types, but only this much of the
 *  surface is a contract we own. */
interface KatexApi {
  renderToString(tex: string, options: { displayMode: boolean; throwOnError: boolean }): string;
}

let katexPromise: Promise<KatexApi> | null = null;

async function loadKatex(): Promise<KatexApi> {
  if (!katexPromise) {
    katexPromise = import("katex")
      .then(async (mod) => {
        // `\ce{…}` support; the patch applies to the instance imported just above.
        await import("katex/dist/contrib/mhchem.mjs");
        const interop = mod as unknown as { default?: KatexApi } & Partial<KatexApi>;
        const katex = interop.default ?? (interop as KatexApi);
        if (!katex || typeof katex.renderToString !== "function") {
          throw new Error("katex did not expose renderToString()");
        }
        return katex;
      })
      .catch((err: unknown) => {
        // A failed import must not poison the session: the next paint tries again.
        katexPromise = null;
        throw err;
      });
  }
  return katexPromise;
}

/** Starts the KaTeX import and does not wait for it.
 *
 *  Called the moment the reader turns the setting on, so the first document with a formula does not
 *  pay for the module: the parse behind this is the second-largest cost we ship (SPEC §4). A failure
 *  is dropped here — the render that needs KaTeX reports its own. */
export function preloadMath(): void {
  loadKatex().catch(() => {});
}

/**
 * Renders every `span.math` inside `container` in place and returns how many were rendered.
 *
 * The spans are pulldown-cmark's: it strips the delimiters and labels the maths `math-inline` or
 * `math-display` (the Rust side demotes a `$$…$$` that shares its paragraph with anything else, so
 * `math-display` really is a formula on its own line).
 */
export async function renderMath(container: HTMLElement): Promise<number> {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>("span.math"));
  if (nodes.length === 0) return 0;

  const katex = await loadKatex();

  let rendered = 0;
  for (const node of nodes) {
    if (!node.isConnected) continue;
    const tex = node.textContent ?? "";
    const displayMode = node.classList.contains("math-display");
    try {
      node.innerHTML = katex.renderToString(tex, { displayMode, throwOnError: false });
      // `throwOnError: false` renders a parse failure in KaTeX's own red rather than throwing, and
      // marks it — the class lets the sheet match the surrounding prose.
      if (node.querySelector(".katex-error")) node.classList.add("math-error");
      rendered++;
    } catch (err) {
      // Nothing should reach here with `throwOnError: false`; a failure must still leave the source
      // readable instead of a half-swapped node.
      node.classList.add("math-error");
      node.title = err instanceof Error ? err.message : String(err);
    }
  }

  return rendered;
}
