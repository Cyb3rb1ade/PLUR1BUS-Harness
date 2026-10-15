// Shared helpers for the new catalog tests (new file; the existing signing.ts / trust.test.ts are left alone).
import { afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
  return `KNOWN GAP: core/catalog ${fn}: erwartet ${expected}, tatsächlich ${actual}`;
}

/** Temp directories removed after each test of the calling scope. */
export function useTempDirs(): () => string {
  const made: string[] = [];
  afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return () => { const d = mkdtempSync(path.join(tmpdir(), "p1b-catalog-new-")); made.push(d); return d; };
}

/**
 * Every object key that appears twice in the same object of a JSON text, as a dotted path. `JSON.parse` silently keeps
 * the last one, so a duplicated id in a data file is invisible after loading; this scans the text itself.
 */
export function duplicateKeys(text: string): string[] {
  let i = 0; const found: string[] = [];
  const ws = () => { while (i < text.length && " \t\r\n".includes(text[i]!)) i++; };
  const str = (): string => {
    if (text[i] !== '"') throw new Error(`expected string at ${i}`);
    let j = i + 1; let out = "";
    while (j < text.length && text[j] !== '"') { if (text[j] === "\\") { out += text.slice(j, j + 2); j += 2; } else out += text[j++]; }
    if (j >= text.length) throw new Error("unterminated string");
    i = j + 1; return JSON.parse(`"${out}"`) as string;
  };
  const value = (p: string): void => {
    ws(); const c = text[i];
    if (c === "{") {
      i++; ws(); const seen = new Set<string>();
      if (text[i] === "}") { i++; return; }
      for (;;) {
        ws(); const k = str(); ws(); if (text[i++] !== ":") throw new Error(`expected ':' at ${i - 1}`);
        const here = p === "" ? k : `${p}.${k}`; if (seen.has(k)) found.push(here); seen.add(k);
        value(here); ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return; }
        throw new Error(`expected ',' or '}' at ${i}`);
      }
    } else if (c === "[") {
      i++; ws(); if (text[i] === "]") { i++; return; }
      for (let n = 0; ; n++) { value(`${p}[${n}]`); ws(); if (text[i] === ",") { i++; continue; } if (text[i] === "]") { i++; return; } throw new Error(`expected ',' or ']' at ${i}`); }
    } else if (c === '"') str();
    else { const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?|^true|^false|^null/.exec(text.slice(i)); if (!m) throw new Error(`unexpected token at ${i}`); i += m[0].length; }
  };
  value(""); ws(); if (i !== text.length) throw new Error(`trailing content at ${i}`);
  return found;
}
