// Small numeric helpers. Accumulation is done in float64 so a 3072-dimensional float32 vector does not lose the norm.
import { AdapterError } from "./errors.ts";

export function norm(v: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  return Math.sqrt(sum);
}

/** Cosine similarity; 0 when either vector has no length. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new RangeError(`cosine of vectors with different lengths (${a.length} vs ${b.length})`);
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  const d = norm(a) * norm(b);
  return d === 0 ? 0 : dot / d;
}

/** A new unit-length copy; the input is untouched. A zero vector has no direction and is a bad response. */
export function l2Normalize(v: Float32Array, provider: string): Float32Array {
  const n = norm(v);
  if (n === 0 || !Number.isFinite(n)) throw new AdapterError("bad_response", "cannot normalise a zero vector", { provider });
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}
