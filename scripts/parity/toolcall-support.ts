// Shared pieces of the tool-call exporters (P4-K K9b, plan P4-42): how a string JSON cannot hold is written, how a large
// or generated input is described instead of stored, the seeded generator, and the short hash a case carries where its
// full answer would only make the file large. Used by `export-toolcall.ts` and `export-capabilities.ts`; the replay side
// is `crates/plur1bus-core/src/toolcall/vectors.rs`.
import { createHash } from "node:crypto";

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A string with a lone surrogate is recorded as `{ "$u16": "<four hex digits per code unit>" }` (a fixture is UTF-8 and
 *  cannot hold one). */
export function str(v: string): unknown {
  return LONE.test(v) ? { $u16: Array.from({ length: v.length }, (_, i) => v.charCodeAt(i).toString(16).padStart(4, "0")).join("") } : v;
}

/** What a raw input is, as the fixture describes it: a string, `{ $u16 }`, `{ gen: [prefix, fill, count, suffix] }` (a
 *  string too large to store), `{ parts: [...] }` (secret-shaped material, joined), `{ value: "<json>" }` (an already
 *  parsed value) or `{ undefined: true }`. */
export function rawOf(spec: any): unknown {
  if (typeof spec === "string") return spec;
  if (spec && typeof spec.$u16 === "string") return String.fromCharCode(...(spec.$u16.match(/.{4}/g) ?? []).map((h: string) => parseInt(h, 16)));
  if (spec && Array.isArray(spec.gen)) return spec.gen[0] + String(spec.gen[1]).repeat(spec.gen[2]) + spec.gen[3];
  if (spec && Array.isArray(spec.parts)) return spec.parts.join("");
  if (spec && typeof spec.value === "string") return JSON.parse(spec.value);
  if (spec && spec.undefined === true) return undefined;
  throw new Error(`unknown raw spec ${JSON.stringify(spec)}`);
}

export const gen = (prefix: string, fill: string, count: number, suffix: string) => ({ gen: [prefix, fill, count, suffix] });
export const parts = (...p: string[]) => ({ parts: p });
export const value = (v: unknown) => ({ value: JSON.stringify(v) });

/** The first 16 hex digits of SHA-256 over the UTF-8 of `text` (lone surrogates as U+FFFD, as `Buffer.from` writes them). */
export const hash16 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

/** A recorded answer: the text itself where it is short or `full` is asked for, else `{ h, n }` (hash and UTF-16 length). */
export function answer(text: string, full: boolean): unknown {
  return full || text.length <= 160 ? str(text) : { h: hash16(text), n: text.length };
}

/** What a thrown value is, as far as a replay can compare it: the error's name and, for everything but a `SyntaxError`
 *  (whose text is the engine's own), its message. */
export function thrown(e: any): unknown {
  const name = String(e?.name ?? "Error");
  return { throws: name === "SyntaxError" ? { name } : { name, message: String(e?.message).toWellFormed() } };
}

/** mulberry32, the generator of `packages/core/test/toolcall/helpers.ts` (copied so an exporter does not load node:test). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ["a", "b", "z", "0", " ", "\"", "\\", "\n", "é", "€", "😀", "ß", "/", "~", String.fromCharCode(0x301), String.fromCharCode(0xd83d), String.fromCharCode(0xde00), String.fromCharCode(0x0), String.fromCharCode(0xfeff), String.fromCharCode(0x2028), String.fromCharCode(0x212a), String.fromCharCode(0x17f), String.fromCharCode(0xa0)];
export function randomString(rnd: () => number, max = 24): string {
  let s = ""; for (let i = Math.floor(rnd() * max); i > 0; i--) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)]!; return s;
}
export const pick = <T>(rnd: () => number, list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;

/** A random JSON value (depth-bounded), with the numbers and keys that separate JavaScript from other JSON readers. */
export function randomJson(rnd: () => number, depth = 0): unknown {
  switch (Math.floor(rnd() * (depth >= 3 ? 6 : 8))) {
    case 0: return null;
    case 1: return rnd() < 0.5;
    case 2: return Math.floor(rnd() * 2000) - 1000;
    case 3: return pick(rnd, [0.1, -0, 1e21, 1e-7, 123456789012345680000, 5e-324, 1.5, -2.25, 9007199254740993, 0.000001, 1e300]);
    case 4: return randomString(rnd);
    case 5: return Math.round(rnd() * 1e6) / 1000;
    case 6: return Array.from({ length: Math.floor(rnd() * 5) }, () => randomJson(rnd, depth + 1));
    default: {
      const o: Record<string, unknown> = {};
      for (let i = Math.floor(rnd() * 5); i > 0; i--) {
        const key = rnd() < 0.2 ? pick(rnd, ["2", "10", "01", "-1", "__proto__", "constructor", "4294967294", "4294967295", "a/b", "a~b", ""]) : randomString(rnd, 6);
        Object.defineProperty(o, key, { value: randomJson(rnd, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return o;
    }
  }
}
