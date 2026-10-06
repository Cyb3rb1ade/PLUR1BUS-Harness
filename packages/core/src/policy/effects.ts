// D109 §2: the one effect vocabulary. D103 `sideEffects`, extension `tools[].effect` and MCP annotations all map onto it.
// Pure data and functions; nothing here touches the filesystem, the clock or a store.

export const EFFECTS = ["read", "local-write", "local-destructive", "external", "money"] as const;
export type Effect = (typeof EFFECTS)[number];

export function effectRank(e: Effect): number {
  return EFFECTS.indexOf(e);
}

export function maxEffect(a: Effect, b: Effect): Effect {
  return effectRank(a) >= effectRank(b) ? a : b;
}

export function isEffect(v: unknown): v is Effect {
  return typeof v === "string" && (EFFECTS as readonly string[]).includes(v);
}

/** D103 `sideEffects` (none/local/external/money); `local` is destructive when irreversible. */
export function fromSideEffects(side: "none" | "local" | "external" | "money", irreversible = false): Effect {
  switch (side) {
    case "none": return "read";
    case "local": return irreversible ? "local-destructive" : "local-write";
    case "external": return "external";
    case "money": return "money";
    default: return "external"; // RULING: an unknown value is read as the most open non-money effect (fail closed)
  }
}

/** Extension manifest `tools[].effect`; a write with network, or with the network unknown, is external. */
export function fromExtensionEffect(effect: "read" | "write" | "destructive", network: "none" | "declared" | undefined): Effect {
  if (effect === "read") return "read";
  if (effect === "destructive") return network === "none" ? "local-destructive" : "external";
  return network === "none" ? "local-write" : "external";
}

export interface McpAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }

/**
 * A third-party MCP tool: no declared effect means `external`; annotations may only raise it, never lower it
 * (`readOnlyHint` is deliberately ignored: a server cannot lower its own tool's class).
 */
export function fromMcp(declared: Effect | undefined, ann: McpAnnotations = {}): Effect {
  let e: Effect = declared ?? "external";
  if (ann.destructiveHint === true) e = maxEffect(e, "local-destructive");
  if (ann.openWorldHint === true) e = maxEffect(e, "external");
  return e;
}
