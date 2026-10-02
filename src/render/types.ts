/** Engine ids shared by the registry, the cache and the status bar. */
export type EngineId = "mermaid" | "dot" | "d2";

export function isEngineId(value: string): value is EngineId {
  return value === "mermaid" || value === "dot" || value === "d2";
}
