/* The Prism grammars this app ships (SPEC §13, IMPL.md §7).
 *
 * **The import order is a dependency order, not a preference.** A Prism component registers itself
 * on import, and several of them `extend()` a base grammar that must already be registered:
 * `cpp` needs `c`, `objectivec` needs `c`, `scala` needs `java`, `tsx` needs `jsx` + `typescript`,
 * `git` needs `diff`, `json5` needs `json`, `php` needs `markup-templating`. Importing a component
 * whose base is missing throws at module-evaluation time, so a reordering here is not cosmetic — it
 * is a runtime error the first time a document contains that language.
 *
 * **Why one lazy chunk with a curated set, not a per-language `import()`**: a fence naming a
 * language nothing ships has to degrade to plain text, and per-language loading needs either
 * `import.meta.glob` over all 599 shipped components (which makes Vite emit 599 chunks) or its own
 * dependency-ordered table — this list, only spread out. One chunk of ~50 grammars is ~35 KB
 * gzipped, loads on the first code fence, and never loads for a document without one.
 *
 * The four core grammars (`markup`, `css`, `clike`, `javascript`) come with `prismjs` itself and are
 * deliberately not imported here.
 */

// ---- bases first, so nothing below `extend()`s a grammar that is not there yet.
import "prismjs/components/prism-c.js";
import "prismjs/components/prism-java.js";
import "prismjs/components/prism-javascript.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-diff.js";
import "prismjs/components/prism-markup-templating.js";
import "prismjs/components/prism-javascript.js";
import "prismjs/components/prism-typescript.js";

// ---- then everything else, alphabetically, so the list stays scannable.
import "prismjs/components/prism-awk.js";
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-batch.js";
import "prismjs/components/prism-clojure.js";
import "prismjs/components/prism-cpp.js";
import "prismjs/components/prism-csharp.js";
import "prismjs/components/prism-csv.js";
import "prismjs/components/prism-dart.js";
import "prismjs/components/prism-docker.js";
import "prismjs/components/prism-elixir.js";
import "prismjs/components/prism-erlang.js";
import "prismjs/components/prism-git.js";
import "prismjs/components/prism-go.js";
import "prismjs/components/prism-graphql.js";
import "prismjs/components/prism-groovy.js";
import "prismjs/components/prism-haskell.js";
import "prismjs/components/prism-http.js";
import "prismjs/components/prism-ini.js";
import "prismjs/components/prism-jq.js";
import "prismjs/components/prism-json5.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-kotlin.js";
import "prismjs/components/prism-latex.js";
import "prismjs/components/prism-lua.js";
import "prismjs/components/prism-makefile.js";
import "prismjs/components/prism-markdown.js";
import "prismjs/components/prism-nginx.js";
import "prismjs/components/prism-objectivec.js";
import "prismjs/components/prism-perl.js";
import "prismjs/components/prism-php.js";
import "prismjs/components/prism-powershell.js";
import "prismjs/components/prism-protobuf.js";
import "prismjs/components/prism-python.js";
import "prismjs/components/prism-r.js";
import "prismjs/components/prism-regex.js";
import "prismjs/components/prism-ruby.js";
import "prismjs/components/prism-rust.js";
import "prismjs/components/prism-scala.js";
import "prismjs/components/prism-scheme.js";
import "prismjs/components/prism-sql.js";
import "prismjs/components/prism-swift.js";
import "prismjs/components/prism-toml.js";
import "prismjs/components/prism-tsx.js";
import "prismjs/components/prism-vim.js";
import "prismjs/components/prism-wasm.js";
import "prismjs/components/prism-yaml.js";
import "prismjs/components/prism-zig.js";
