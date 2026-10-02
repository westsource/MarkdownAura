/* Render cache, keyed by (engine, source hash) and sized in *bytes* (IMPL.md §5).
 *
 * Why bytes and not entries: one large graph is worth more memory than fifty small ones, so an
 * entry-count cap either evicts the big chart constantly or lets a document full of small ones
 * blow the budget. The cap is on the thing that actually costs something.
 *
 * Re-entering a tab must not re-render. That is the whole point — a diagram that flickers back
 * into place every time you switch tabs makes the app feel slower than it is.
 */
import type { EngineId } from "./types";

/** Comfortably under the `idle RAM with 10 tabs open ≤ 150 MB` budget in IMPL.md §9. */
const MAX_BYTES = 6 * 1024 * 1024;

interface Entry {
  svg: string;
  bytes: number;
}

/** Insertion-ordered, which makes it an LRU as soon as `get` re-inserts. */
const entries = new Map<string, Entry>();
let totalBytes = 0;

export function cacheKey(engine: EngineId, source: string): string {
  return `${engine}:${fnv1a(source)}`;
}

export function get(key: string): string | undefined {
  const hit = entries.get(key);
  if (!hit) return undefined;
  // Re-insert so the most recently used entry is last in iteration order.
  entries.delete(key);
  entries.set(key, hit);
  return hit.svg;
}

export function put(key: string, svg: string): void {
  const bytes = svg.length * 2; // UTF-16 code units, which is what the string actually holds
  const existing = entries.get(key);
  if (existing) {
    entries.delete(key);
    totalBytes -= existing.bytes;
  }
  entries.set(key, { svg, bytes });
  totalBytes += bytes;

  while (totalBytes > MAX_BYTES && entries.size > 1) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    const victim = entries.get(oldest.value);
    entries.delete(oldest.value);
    if (victim) totalBytes -= victim.bytes;
  }
}

export function clear(): void {
  entries.clear();
  totalBytes = 0;
}

export function stats(): { entries: number; bytes: number } {
  return { entries: entries.size, bytes: totalBytes };
}

/** FNV-1a. Not cryptographic — it only has to make two different sources collide rarely. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
