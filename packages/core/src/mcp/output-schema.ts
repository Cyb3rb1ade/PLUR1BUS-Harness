// A server's `outputSchema` is third-party input that this process compiles with AJV and runs, synchronously on the core
// thread, against that same server's `structuredContent` (connection.ts). Two keyword families make AJV run a
// server-chosen regular expression: `pattern` (against string values) and `patternProperties` (against property names).
// V8's backtracking engine has no time limit, so `^(a+)+$` against 30 characters freezes every agent for ~15 s.
//
// Node has no linear-time regular expression engine and this layer takes no new dependency, so these two keywords are
// dropped from the schema that gets compiled (the descriptor handed to callers is untouched). Everything else (type,
// required, enum, bounds, composition) is still enforced. The check is defence in depth against a server that
// misreports its own output; losing the pattern check cannot admit anything that the structural checks reject.
// The server's tool-call result is untrusted data either way (ADR-014 §3).

/** Keywords whose value maps arbitrary names to subschemas: the names are not keywords and must be kept as they are. */
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions", "dependentSchemas", "dependencies"]);
/** Keywords whose value is plain data, not a schema: an instance such as `{ "pattern": "x" }` must stay byte-identical. */
const DATA = new Set(["enum", "const", "default", "examples"]);

export function sanitizeOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return clean(schema) as Record<string, unknown>;
}

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (node === null || typeof node !== "object") return node;
  const source = node as Record<string, unknown>;
  const hadPatternProperties = Object.hasOwn(source, "patternProperties");
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(source)) {
    if (key === "pattern" || key === "patternProperties") continue;
    // Without its patterns, `additionalProperties` would also judge the properties `patternProperties` used to claim.
    if (hadPatternProperties && (key === "additionalProperties" || key === "unevaluatedProperties")) continue;
    if (DATA.has(key)) entries.push([key, value]);
    else if (SCHEMA_MAPS.has(key) && value !== null && typeof value === "object" && !Array.isArray(value)) {
      entries.push([key, Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, clean(sub)]))]);
    } else entries.push([key, clean(value)]);
  }
  // fromEntries defines own properties, so a `__proto__` key stays data instead of replacing the prototype.
  return Object.fromEntries(entries);
}
