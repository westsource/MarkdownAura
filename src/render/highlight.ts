/* Code-fence highlighting (SPEC §13, IMPL.md §7).
 *
 * The shape of this file is marktext's, and it was worth copying:
 *
 *  - **Highlight the text, never re-highlight the DOM.** `Prism.highlight(source, grammar, language)`
 *    escapes as it tokenizes, so `code.textContent` in and `innerHTML` out is the whole contract.
 *  - **A language nothing ships stays plain text.** No error, no warning in the reader's face: an
 *    unknown ```` ```foo ```` fence is not a failure, and a fence that is *never* highlighted is
 *    still readable. The same rule covers a grammar that failed to load.
 *  - **Aliases come from Prism's own index** (`prismjs/components.js`), not from a hand-written
 *    table: `js`/`ts`/`sh`/`yml`/`c++` and friends are Prism's facts, and a copy of them drifts.
 *
 * The only thing this module adds is a memo: `paint()` runs on every debounced keystroke while a
 * buffer is being edited (SPEC §12), and re-tokenising every fence per keystroke is work whose
 * answer cannot have changed unless the text did.
 *
 * **Why the imports below are dynamic (and must stay dynamic)**: a static import would put Prism,
 * its alias index and every grammar in `prism-languages.ts` into the initial bundle, which the size
 * budget in SPEC §4 counts, and a document without a code fence would pay for all of it. This is the
 * same rule `engines.ts` follows for mermaid/dot/d2 and `ui/editor.ts` for CodeMirror: the reader's
 * first paint never waits for a language implementation.
 */
import { log } from "../diag";
import { hash } from "./cache";

/** The slice of Prism's API this file uses. The package is CommonJS and `@types/prismjs` describes
 *  it as an ES module, so the runtime value comes from the interop default and is narrowed here
 *  instead of being trusted through a synthetic default import. */
interface PrismApi {
  languages: Record<string, unknown>;
  highlight(code: string, grammar: unknown, language: string): string;
}

interface PrismComponents {
  languages: Record<string, { alias?: string | string[] }>;
}

let prismPromise: Promise<PrismApi> | null = null;
let aliasesPromise: Promise<Map<string, string>> | null = null;

/** Highlighted HTML, keyed `language:hash(source)`. Insertion-ordered, so the cap evicts oldest. */
const memo = new Map<string, string>();
const MEMO_CAP = 128;

async function loadPrism(): Promise<PrismApi> {
  if (!prismPromise) {
    prismPromise = import("prismjs")
      .then(async (mod) => {
        // The grammars register themselves on import, in the order that file documents.
        await import("./prism-languages");
        const interop = mod as unknown as { default?: PrismApi } & Partial<PrismApi>;
        const prism = interop.default ?? (interop as PrismApi);
        if (!prism || typeof prism.highlight !== "function") {
          throw new Error("prismjs did not expose highlight()");
        }
        return prism;
      })
      .catch((err: unknown) => {
        // A failed load must not poison the session: the next paint tries again.
        prismPromise = null;
        throw err;
      });
  }
  return prismPromise;
}

/** `js` → `javascript`, `c++` → `cpp`, and every other alias Prism declares for a grammar it ships.
 *  A language that is neither a canonical name nor an alias maps to itself and is then simply not
 *  found in `prism.languages` — which is the plain-text outcome we want. */
async function loadAliases(): Promise<Map<string, string>> {
  if (!aliasesPromise) {
    aliasesPromise = import("prismjs/components.js")
      .then((mod) => {
        const interop = mod as unknown as { languages?: Record<string, unknown>; default?: unknown };
        const index = (interop.languages ?? (interop.default as PrismComponents | undefined)?.languages) as
          | PrismComponents["languages"]
          | undefined;
        const table = new Map<string, string>();
        for (const [name, meta] of Object.entries(index ?? {})) {
          table.set(name, name);
          const alias = meta?.alias;
          for (const one of Array.isArray(alias) ? alias : alias ? [alias] : []) {
            table.set(one, name);
          }
        }
        return table;
      })
      .catch((err: unknown) => {
        // Without the index the canonical names still work; only the aliases are lost.
        aliasesPromise = null;
        log("warn", "render", "prism alias index failed to load", {
          err: err instanceof Error ? err.message : String(err),
        });
        return new Map<string, string>();
      });
  }
  return aliasesPromise;
}

/** The language of a fence, or null. `class="language-rust"`, possibly with more classes. */
function languageOf(className: string, aliases: Map<string, string>): string | null {
  const match = /language-([^\s]+)/.exec(className);
  if (!match) return null;
  const raw = match[1].toLowerCase();
  return aliases.get(raw) ?? raw;
}

function remember(key: string, html: string): void {
  memo.set(key, html);
  if (memo.size <= MEMO_CAP) return;
  const oldest = memo.keys().next();
  if (!oldest.done) memo.delete(oldest.value);
}

/**
 * Highlights every fenced code block inside `container`, in place, and returns how many were
 * highlighted. Blocks are found by the class `pulldown-cmark` emits (`language-x`) — the same
 * contract the diagram pipeline relies on for its placeholders.
 */
export async function highlight(container: HTMLElement): Promise<number> {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>("pre > code[class*='language-']"));
  if (blocks.length === 0) return 0;

  const prism = await loadPrism();
  const aliases = await loadAliases();

  let highlighted = 0;
  for (const block of blocks) {
    const language = languageOf(block.className, aliases);
    const grammar = language ? prism.languages[language] : undefined;
    // Not a language we ship: leave the text exactly as the parser wrote it.
    if (!language || !grammar) continue;

    const source = block.textContent ?? "";
    const key = `${language}:${hash(source)}`;
    let html = memo.get(key);
    if (html === undefined) {
      html = prism.highlight(source, grammar, language);
      remember(key, html);
    }
    // The same guard marktext uses: everything here runs on every keystroke in the live preview,
    // and an unchanged block must not be written back.
    if (block.innerHTML !== html) block.innerHTML = html;
    highlighted++;
  }

  return highlighted;
}
