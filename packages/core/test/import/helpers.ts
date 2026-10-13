// Shared helpers for the new import tests (new file; the existing import tests and fixtures are left alone).
import { afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Seeded PRNG (mulberry32); the seed is always part of a failure message. */
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

export function gap(fn: string, expected: string, actual: string): string {
  return `KNOWN GAP: core/import ${fn}: erwartet ${expected}, tatsächlich ${actual}`;
}

/** mkdtemp directories removed after each test of the calling scope. */
export function useTempDirs(): () => string {
  const made: string[] = [];
  afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return () => { const d = mkdtempSync(path.join(tmpdir(), "p1b-import-new-")); made.push(d); return d; };
}

/** Names of all own properties of the shared prototypes, to prove a parse did not add or change any. */
export function prototypeFingerprint(): string {
  const protos: [string, object][] = [["Object", Object.prototype], ["Array", Array.prototype], ["Function", Function.prototype], ["String", String.prototype], ["Number", Number.prototype]];
  return JSON.stringify(protos.map(([n, p]) => [n, Object.getOwnPropertyNames(p).sort(), Object.getPrototypeOf(p) === (n === "Object" ? null : Object.prototype) || n === "Function" || n === "Array" || n === "String" || n === "Number"]));
}

/** A random JSON-compatible value. Object keys are plain words plus the dangerous names. */
export const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "polluted"];
export function randomValue(rnd: () => number, depth = 0, opts: { dangerous?: boolean; emptyObjects?: boolean; nestedArrays?: boolean } = {}): unknown {
  const pick = Math.floor(rnd() * (depth >= 4 ? 5 : 7));
  switch (pick) {
    case 0: return null;
    case 1: return rnd() < 0.5;
    case 2: return Math.floor(rnd() * 20000) - 10000;
    case 3: return Math.round((rnd() * 2000 - 1000) * 100) / 100 + 0.25;
    case 4: return randomText(rnd);
    case 5: {
      const n = Math.floor(rnd() * 4) + (opts.nestedArrays === false ? 0 : 0);
      return Array.from({ length: n }, () => { let v = randomValue(rnd, depth + 1, opts); while (opts.nestedArrays === false && Array.isArray(v)) v = randomValue(rnd, depth + 1, opts); return v; });
    }
    default: {
      const o: Record<string, unknown> = {};
      const n = Math.floor(rnd() * 4) + (opts.emptyObjects === false ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const key = opts.dangerous && rnd() < 0.25 ? DANGEROUS_KEYS[Math.floor(rnd() * DANGEROUS_KEYS.length)]! : `k${Math.floor(rnd() * 50)}`;
        Object.defineProperty(o, key, { value: randomValue(rnd, depth + 1, opts), enumerable: true, writable: true, configurable: true });
      }
      return o;
    }
  }
}
const TEXT_PARTS = ["alpha", "beta gamma", "über", "ß", "😀", "日本", "a'b", "q\"r", "back\\slash", "tab\there", "line\nbreak", "#hash", "x: y", " lead", "trail ", "", "1234", "true", "null", "~", "[b]", "{c}", "- dash", "a\u2028b", "é"];
export function randomText(rnd: () => number): string {
  let s = ""; for (let i = Math.floor(rnd() * 3); i >= 0; i--) s += TEXT_PARTS[Math.floor(rnd() * TEXT_PARTS.length)]!; return s;
}

// ---------------------------------------------------------------------------------------------------------------------
// Generators for the parser fuzz tests (used by fuzz-worker.ts, which runs them under a watchdog).
// ---------------------------------------------------------------------------------------------------------------------

const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** JSON5 text for `v`, decorated with comments, trailing commas, odd whitespace, hex numbers, both quote styles and line continuations. */
export function toJson5(v: unknown, rnd: () => number, depth = 0): string {
  // U+FEFF is whitespace in JSON5 but parseJson5 reads it as an identifier character (KNOWN GAP in json5.test.ts), so the
  // generator emits it only directly after punctuation (wsP), never after a key, literal or number.
  const ws = (): string => pick(rnd, ["", "", " ", "\n", "\t", "  ", " ", "\r\n", " /* c */ ", " // note\n", "\u000b", "\u000c"]);
  const wsP = (): string => (rnd() < 0.15 ? "\u00a0" : rnd() < 0.2 ? "\ufeff" : ws());
  const str = (s: string): string => {
    const q = rnd() < 0.5 ? "'" : "\"";
    let out = q;
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (ch === q || ch === "\\") out += "\\" + ch;
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\u2028" || ch === "\u2029" || c < 0x20 || (c >= 0xd800 && c <= 0xdfff)) out += "\\u" + c.toString(16).padStart(4, "0");
      else out += ch;
      if (rnd() < 0.03) out += "\\\n"; // line continuation between complete tokens
    }
    return out + q;
  };
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (Number.isInteger(v) && rnd() < 0.25) return (v < 0 ? "-" : rnd() < 0.3 ? "+" : "") + "0x" + Math.abs(v).toString(16);
    if (v >= 0 && rnd() < 0.15) return "+" + String(v);
    return String(v);
  }
  if (typeof v === "string") return str(v);
  const trailing = (): string => (rnd() < 0.4 ? "," : "");
  if (Array.isArray(v)) return "[" + wsP() + v.map(x => toJson5(x, rnd, depth + 1)).join(ws() + "," + wsP()) + (v.length ? ws() + trailing() : "") + ws() + "]";
  const entries = Object.keys(v as object).map(k => {
    const key = IDENT.test(k) && rnd() < 0.6 ? k : str(k);
    return key + ws() + ":" + wsP() + toJson5((v as Record<string, unknown>)[k], rnd, depth + 1);
  });
  return "{" + wsP() + entries.join(ws() + "," + wsP()) + (entries.length ? ws() + trailing() : "") + ws() + "}";
}

const SAFE_WORD = /^[A-Za-z][A-Za-z0-9 _./-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;

/** YAML text (the subset yaml-lite reads) for a value without empty objects and without arrays directly inside arrays. */
export function toYaml(v: unknown, rnd: () => number): string {
  const step = 1 + Math.floor(rnd() * 4);
  const lines: string[] = [];
  const keyText = (k: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : JSON.stringify(k));
  const scalarText = (x: unknown): string => {
    if (x === null) return rnd() < 0.5 ? "~" : "null";
    if (typeof x === "boolean") return x ? pick(rnd, ["true", "True", "TRUE"]) : pick(rnd, ["false", "False", "FALSE"]);
    if (typeof x === "number") return String(x);
    const s = x as string;
    if (SAFE_WORD.test(s) && !RESERVED.test(s) && s === s.trim() && !/\s#/.test(s) && !/:/.test(s) && rnd() < 0.7) return s;
    return rnd() < 0.2 && !/['\n\r\u2028\u2029]/.test(s) && !/[\u0000-\u001f]/.test(s) ? `'${s.replace(/'/g, "''")}'` : JSON.stringify(s).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  };
  const flow = (arr: unknown[]): string | null => (arr.every(x => x === null || typeof x !== "object") ? "[" + arr.map(scalarText).join(", ") + "]" : null);
  const emit = (x: unknown, indent: number, prefix: string): void => {
    const pad = " ".repeat(indent);
    if (Array.isArray(x)) {
      for (const item of x) {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          const keys = Object.keys(item);
          const [first, ...rest] = keys;
          const inner = indent + 2;
          emitEntry(`${pad}- `, first!, (item as Record<string, unknown>)[first!], inner);
          for (const k of rest) emitEntry(" ".repeat(inner), k, (item as Record<string, unknown>)[k], inner);
        } else lines.push(`${pad}- ${scalarText(item)}`);
      }
      return;
    }
    for (const k of Object.keys(x as object)) emitEntry(pad, k, (x as Record<string, unknown>)[k], indent);
    void prefix;
  };
  const emitEntry = (lead: string, k: string, val: unknown, indent: number): void => {
    const head = `${lead}${keyText(k)}:`;
    if (Array.isArray(val)) {
      if (val.length === 0) { lines.push(`${head} []`); return; }
      const f = rnd() < 0.3 ? flow(val) : null;
      if (f) { lines.push(`${head} ${f}`); return; }
      lines.push(head);
      const seqIndent = rnd() < 0.3 ? indent : indent + step;
      emit(val, seqIndent, "");
      return;
    }
    if (val !== null && typeof val === "object") { lines.push(head); emit(val, indent + step, ""); return; }
    if (typeof val === "string" && /^[^\s].*\n$/s.test(val) && /^[A-Za-z0-9 ]+(\n[A-Za-z0-9 ]+)*\n$/.test(val) && rnd() < 0.5) {
      lines.push(`${head} |`); for (const l of val.slice(0, -1).split("\n")) lines.push(" ".repeat(indent + step) + l); return;
    }
    lines.push(`${head} ${scalarText(val)}`);
  };
  emit(v, 0, "");
  return lines.join(pick(rnd, ["\n", "\n", "\r\n"])) + "\n";
}

/** Value generator shaped for toYaml(): non-empty objects, no array directly in an array, strings of lines for block scalars. */
export function randomYamlValue(rnd: () => number, depth = 0): unknown {
  const top = depth === 0;
  const kind = Math.floor(rnd() * (depth >= 3 ? 5 : top ? 2 : 7));
  if (top) return kind === 0 ? randomObject(rnd, depth) : Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => { let x = randomYamlValue(rnd, depth + 1); while (Array.isArray(x)) x = randomYamlValue(rnd, depth + 1); return x; });
  switch (kind) {
    case 0: return null;
    case 1: return rnd() < 0.5;
    case 2: return Math.floor(rnd() * 20000) - 10000;
    case 3: return Math.round((rnd() * 2000 - 1000) * 100) / 100 + 0.25;
    case 4: return rnd() < 0.15 ? Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(rnd, ["alpha", "beta two", "gamma"])).join("\n") + "\n" : randomText(rnd);
    case 5: return Array.from({ length: Math.floor(rnd() * 4) }, () => { let x = randomYamlValue(rnd, depth + 1); while (Array.isArray(x)) x = randomYamlValue(rnd, depth + 1); return x; });
    default: return randomObject(rnd, depth);
  }
}
function randomObject(rnd: () => number, depth: number): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (let i = 0, n = 1 + Math.floor(rnd() * 3); i < n; i++) {
    const key = rnd() < 0.2 ? pick(rnd, DANGEROUS_KEYS) : rnd() < 0.15 ? `key with space ${i}` : `k${Math.floor(rnd() * 40)}`;
    Object.defineProperty(o, key, { value: randomYamlValue(rnd, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return o;
}

const SOUP_JSON5 = ["{", "}", "[", "]", ",", ":", "\"", "'", "/", "*", "\\", "\n", "\r", " ", "0", "1", "9", "x", "e", ".", "+", "-", "a", "z", "$", "_", "true", "null", "Infinity", "NaN", "0x", "\\u", "\\x", "//", "/*", "*/", "é", "😀", "\u2028", "\u0000", "﻿"];
const SOUP_YAML = [":", "- ", "-", "[", "]", "{", "}", "#", "'", "\"", "|", ">", "&", "*", "!", "%", "@", "`", "\n", "\n  ", "\n    ", " ", "\t", "0", "1", ".5", "a", "key", "~", "null", "true", "---", "...", "? ", ": ", "\\", "é", "😀", "\r\n", "<<", "|-", ">+", "&a ", "*a"];
export function soup(rnd: () => number, kind: "json5" | "yaml", maxParts = 60): string {
  const pool = kind === "json5" ? SOUP_JSON5 : SOUP_YAML; let s = "";
  for (let i = Math.floor(rnd() * maxParts); i > 0; i--) s += pick(rnd, pool); return s;
}

/** One random edit: delete, insert or replace a character, or cut the text. */
export function mutate(text: string, rnd: () => number, kind: "json5" | "yaml"): string {
  if (text.length === 0) return soup(rnd, kind, 5);
  const i = Math.floor(rnd() * text.length); const pool = kind === "json5" ? SOUP_JSON5 : SOUP_YAML;
  switch (Math.floor(rnd() * 4)) {
    case 0: return text.slice(0, i) + text.slice(i + 1);
    case 1: return text.slice(0, i) + pick(rnd, pool) + text.slice(i);
    case 2: return text.slice(0, i) + pick(rnd, pool) + text.slice(i + 1);
    default: return text.slice(0, i);
  }
}
