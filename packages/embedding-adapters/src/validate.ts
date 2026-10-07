// Strict response validation (G2): count equals inputs, every vector has the configured dimension, every component is a
// finite number (checked after the float32 conversion, so 1e39 is caught too). Messages carry indexes and counts only,
// never the offending values: a hostile response must not be able to smuggle text into our errors.
import { AdapterError } from "./errors.ts";

export interface VectorContext {
  provider: string;
  expectedCount: number;
  dimensions: number;
}

const bad = (provider: string, message: string): never => {
  throw new AdapterError("bad_response", message, { provider });
};

export function toFloat32Vectors(raw: unknown, ctx: VectorContext): Float32Array[] {
  const { provider, expectedCount, dimensions } = ctx;
  if (!Array.isArray(raw)) return bad(provider, "expected an array of embeddings");
  if (raw.length !== expectedCount) return bad(provider, `expected ${expectedCount} embeddings, got ${raw.length}`);
  return raw.map((item: unknown, i: number) => {
    if (!Array.isArray(item)) return bad(provider, `embedding ${i} is not an array`);
    if (item.length !== dimensions) return bad(provider, `embedding ${i} has ${item.length} dimensions, expected ${dimensions}`);
    const out = new Float32Array(dimensions);
    for (let j = 0; j < dimensions; j++) {
      const x: unknown = item[j];
      if (typeof x !== "number") return bad(provider, `embedding ${i} contains a value that is not a number`);
      out[j] = x;
      if (!Number.isFinite(out[j])) return bad(provider, `embedding ${i} contains a non-finite value`);
    }
    return out;
  });
}

/**
 * For `{data: [{index, embedding}]}` style responses: the vectors in input order, requiring a complete permutation of
 * 0..count-1 (an index is never inferred from position).
 */
export function orderedEmbeddings(data: unknown, count: number, provider: string, field = "embedding"): unknown[] {
  if (!Array.isArray(data)) return bad(provider, `expected an array of {index, ${field}} items`);
  if (data.length !== count) return bad(provider, `expected ${count} items, got ${data.length}`);
  const out: unknown[] = new Array(count);
  const seen = new Set<number>();
  data.forEach((item: unknown, n: number) => {
    if (typeof item !== "object" || item === null) return bad(provider, `item ${n} is not an object`);
    const rec = item as Record<string, unknown>;
    const index = rec["index"];
    if (typeof index !== "number" || !Number.isInteger(index)) return bad(provider, `item ${n} has no integer index`);
    if (index < 0 || index >= count) return bad(provider, `index ${index} out of range for ${count} inputs`);
    if (seen.has(index)) return bad(provider, `duplicate index ${index}`);
    if (!(field in rec)) return bad(provider, `item ${n} has no ${field}`);
    seen.add(index);
    out[index] = rec[field];
    return undefined;
  });
  return out;
}
