// Shared helpers for the new toolcall tests (new file; the existing edge/eval/reliability/sqlite tests are left alone).
import { afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CapabilityEntry } from "../../src/toolcall/capabilities.ts";

/** Seeded PRNG (mulberry32): the only source of randomness in these tests; every failure message carries the seed. */
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

/** The exact title of a documented-behaviour deviation: used as test name and as the `todo` reason. */
export function gap(fn: string, expected: string, actual: string): string {
  return `KNOWN GAP: core/toolcall ${fn}: erwartet ${expected}, tatsächlich ${actual}`;
}

/** Temp directories removed after each test of the calling scope. */
export function useTempDirs(): () => string {
  const made: string[] = [];
  afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return () => { const d = mkdtempSync(path.join(tmpdir(), "p1b-toolcall-new-")); made.push(d); return d; };
}

/** A valid capability entry; override what the test is about. */
export function entry(over: Partial<CapabilityEntry> = {}): CapabilityEntry {
  return { id: "cap-1", name: "make_report", description: "Create a document report", category: "docs.create", kind: "tool", effect: "read", risk: "low", source: "synthetic", version: "1", ...over };
}

/** A promise whose settlement the test controls (no timers involved). */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let all already-queued microtasks run. */
export async function flushMicrotasks(rounds = 20): Promise<void> { for (let i = 0; i < rounds; i++) await Promise.resolve(); }

/** Recording full-result store: remembers what was put and returns a short stable reference. */
export function recordingStore(reference = (n: number) => `ref-${n}`): { puts: unknown[]; put(value: unknown): Promise<string> } {
  const puts: unknown[] = [];
  return { puts, async put(value: unknown) { puts.push(value); return reference(puts.length); } };
}

/** Random JSON value from a seeded PRNG (depth-bounded). */
export function randomJson(rnd: () => number, depth = 0): unknown {
  const pick = Math.floor(rnd() * (depth >= 3 ? 5 : 7));
  switch (pick) {
    case 0: return null;
    case 1: return rnd() < 0.5;
    case 2: return Math.floor(rnd() * 2000) - 1000;
    case 3: return Math.round(rnd() * 1e6) / 1000;
    case 4: return randomString(rnd);
    case 5: return Array.from({ length: Math.floor(rnd() * 5) }, () => randomJson(rnd, depth + 1));
    default: { const o: Record<string, unknown> = {}; for (let i = Math.floor(rnd() * 5); i > 0; i--) o[randomString(rnd, 6)] = randomJson(rnd, depth + 1); return o; }
  }
}

const ALPHABET = ["a", "b", "z", "0", " ", "\"", "\\", "\n", "é", "€", "😀", "ß", "́", "/", "~"];
export function randomString(rnd: () => number, max = 24): string {
  let s = ""; for (let i = Math.floor(rnd() * max); i > 0; i--) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)]!; return s;
}
