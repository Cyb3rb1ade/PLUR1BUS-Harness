// Reader-side redaction (D111 §4): the writer redacts before it writes, and the reader redacts again from the same data
// (`@plur1bus/log-schema` redaction.json) before anything leaves the core, so a line written by an older or foreign
// writer, or one that predates the writer-side redactor, still reaches a client without a raw secret. Defence in depth,
// never a replacement for the writer's own redaction. Pure: no I/O, no clock.
import { createHash } from "node:crypto";
import { REDACTION } from "@plur1bus/log-schema";

interface PatternDef { id: string; pattern: string; flags?: string; leftBoundary?: boolean; valueGroup?: number; replacement?: string; exemptWhenWholeMatchIs?: string }
interface Compiled { id: string; re: RegExp; leftBoundary: boolean; valueGroup?: number; replacement?: string; exempt?: RegExp }
interface DenyClass { id: string; segments?: string[][]; files?: string[] }

const TEMPLATE: string = REDACTION.replacementTemplate;
const tag = (rule: string): string => TEMPLATE.replace("{rule}", rule);
const rule = (id: string): Record<string, any> => (REDACTION.rules as Array<Record<string, any>>).find((r) => r.id === id)!;

const compile = (p: PatternDef): Compiled => ({
  id: p.id, re: new RegExp(p.pattern, `g${(p.flags ?? "").replace(/[^i]/g, "")}d`), leftBoundary: p.leftBoundary === true,
  ...(p.valueGroup !== undefined ? { valueGroup: p.valueGroup } : {}), ...(p.replacement !== undefined ? { replacement: p.replacement } : {}),
  ...(p.exemptWhenWholeMatchIs ? { exempt: new RegExp(p.exemptWhenWholeMatchIs) } : {}),
});

const KEY_RE = new RegExp(rule("key").pattern, rule("key").flags ?? "");
const KEY_CAMEL_RE = new RegExp(rule("key").camelPattern);
const PATTERNS: Compiled[] = (rule("pattern").patterns as PatternDef[]).map(compile);
const PII: Compiled[] = (rule("pii").patterns as PatternDef[]).map(compile);
const URL_STEPS: Compiled[] = (rule("url").steps as PatternDef[]).map(compile);
const DENY: DenyClass[] = rule("path").classes;
const escapePattern = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Data contains credential roots with literal spaces (Application Support, Group Containers).
const SPACE_PATHS = DENY.flatMap((c) => (c.segments ?? []).filter(seq => seq.some(seg => seg.includes(" "))).map(seq => ({
  cls: c.id,
  re: new RegExp(String.raw`[\\/]` + seq.map(escapePattern).join(String.raw`[\\/]`) + String.raw`(?:[\\/][^\s"'<>|:;,()[\]{}]*)?`, "gi"),
})));

/** True when a JSON key / header name / env name denotes a credential (rule `key`). */
export const isSecretKey = (name: string): boolean => KEY_RE.test(name) || KEY_CAMEL_RE.test(name);

function applyPattern(text: string, p: Compiled, label: string): string {
  const re = new RegExp(p.re.source, p.re.flags); // own lastIndex: patterns are shared module state
  let out = ""; let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const at = m.index;
    if ((p.leftBoundary && at > 0 && /[A-Za-z0-9]/.test(text[at - 1]!)) || p.exempt?.test(m[0])) continue;
    const rep = p.replacement ?? tag(label);
    const span = p.valueGroup !== undefined ? m.indices?.[p.valueGroup] : undefined;
    const [s, e] = span ?? [at, at + m[0].length];
    out += text.slice(last, s) + rep; last = e;
  }
  return out + text.slice(last);
}

const sha6 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 6);

/** RULING: a simplified canonicalisation (separators unified, `.`/`..` resolved, case folded for the match only). */
function canonical(p: string): string[] {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop(); else out.push(seg);
  }
  return out;
}
const fileMatches = (name: string, pattern: string): boolean => (pattern.endsWith(".*") ? name.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase()) : name.toLowerCase() === pattern.toLowerCase());
function denyClassOf(segs: string[]): string | null {
  const low = segs.map((s) => s.toLowerCase());
  for (const c of DENY) {
    for (const seq of c.segments ?? []) {
      const want = seq.map((s) => s.toLowerCase());
      for (let i = 0; i + want.length <= low.length; i++) if (want.every((w, j) => low[i + j] === w)) return c.id;
    }
    const base = segs[segs.length - 1];
    if (base && (c.files ?? []).some((f) => fileMatches(base, f))) return c.id;
  }
  return null;
}
/** Match the fixed root first; a nested arbitrary-path prefix can backtrack exponentially on foreign output. */
function redactSpacedPath(text: string, p: { re: RegExp; cls: string }): string {
  let out = ""; let last = 0;
  for (const m of text.matchAll(new RegExp(p.re.source, p.re.flags))) {
    let start = m.index;
    while (start > last && !/[\s"'<>|:;,()[\]{}]/.test(text[start - 1]!)) start--;
    if (start >= last + 2 && /^[A-Za-z]:$/.test(text.slice(start - 2, start))) start -= 2;
    const end = m.index + m[0].length;
    const segs = canonical(text.slice(start, end)); const cls = denyClassOf(segs);
    out += text.slice(last, start) + (cls ? `<deny:${cls}>/…#${sha6(segs.join("/"))}` : text.slice(start, end)); last = end;
  }
  return out + text.slice(last);
}
const PATH_TOKEN = /(?:[A-Za-z]:)?(?:[\\/][^\s"'<>|:;,()[\]{}]+)+|~[\\/][^\s"'<>|:;,()[\]{}]+|\.env(?:\.[A-Za-z0-9_-]+)?\b/g;

const NAME_CHAR = /[A-Za-z0-9_.-]/;
const isNameChar = (c: string | undefined): boolean => c !== undefined && NAME_CHAR.test(c);
const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);
const VALUE_STOP = /[\s,;&"']/;
/** End of a bare value starting at `i` (exclusive), `i` itself when it is empty. */
function bareEnd(s: string, i: number): number { let e = i; while (e < s.length && !VALUE_STOP.test(s[e]!)) e++; return e; }
/**
 * `key=value` / `"key": "value"` inside free text, in one linear pass (a regex with a greedy name and a leading
 * optional quote retried every start of a long word run, which is quadratic). Only a secret-looking name consumes its
 * value; for any other name scanning resumes at the value, so `Error: token=x` and `{"msg":"password=x"}` are seen.
 */
function redactPairs(s: string): string {
  let out = ""; let last = 0; let i = 0;
  const n = s.length;
  while (i < n) {
    if (!isNameChar(s[i])) { i++; continue; }
    const start = i;
    while (i < n && isNameChar(s[i])) i++;
    const name = s.slice(start, i);
    // optional matching quote around the name (only if not already consumed by an earlier replacement)
    let q = ""; let j = i;
    const open = start > last ? s[start - 1] : undefined;
    if ((open === '"' || open === "'") && s[i] === open) { q = open; j = i + 1; }
    for (;;) {
      let k = j; while (isSpace(s[k])) k++;
      if (s[k] !== ":" && s[k] !== "=") { if (q) { q = ""; j = i; continue; } break; }
      const sepEnd = k + 1; let v = sepEnd; while (isSpace(s[v])) v++;
      if (v >= n) break;
      if (!isSecretKey(name)) { i = v; break; } // not a credential name: look inside its value (and never scan it twice)
      let end = -1; let quote = "";
      const c = s[v]!;
      if (c === '"' || c === "'") {
        const close = s.indexOf(c, v + 1);
        if (close >= 0) { end = close + 1; quote = c; }
      } else {
        const m = /^(?:Bearer|Basic)\s+/i.exec(s.slice(v, v + 12));
        if (m) { const e = bareEnd(s, v + m[0].length); if (e > v + m[0].length) end = e; }
        if (end < 0) { const e = bareEnd(s, v); if (e > v) end = e; }
      }
      if (end < 0) break;
      out += s.slice(last, v) + quote + tag("key") + quote; last = end; i = end;
      break;
    }
  }
  return out + s.slice(last);
}

/**
 * Rule `url` `find` (`scheme://` and the characters up to whitespace, a quote or an angle bracket), found by walking
 * out from each `://` instead of a regex that retries every start of a long scheme-like run (quadratic).
 */
function mapUrls(s: string, fn: (url: string) => string): string {
  const scheme = /[A-Za-z0-9+.-]/; const stop = /[\s"'<>]/;
  let out = ""; let last = 0;
  for (let at = s.indexOf("://"); at >= 0; at = s.indexOf("://", at + 3)) {
    let b = at; while (b > last && scheme.test(s[b - 1]!)) b--;
    while (b < at && !/[A-Za-z]/.test(s[b]!)) b++;
    if (b === at) continue; // no scheme
    let e = at + 3; while (e < s.length && !stop.test(s[e]!)) e++;
    if (e === at + 3) continue; // nothing after `://`
    out += s.slice(last, b) + fn(s.slice(b, e)); last = e; at = e - 3;
  }
  return out + s.slice(last);
}
const MAX_DEPTH = 64;

export interface RedactOptions {
  /** Rule `pii` (`logs.redactPii`); default false. */
  pii?: boolean;
  /** Rule `secret`: exact secret values this process holds (≥ 8 characters), with their base64, base64url, hex and URL-encoded forms. */
  secrets?: Iterable<string>;
}

export interface Redactor {
  text(s: string): string;
  /** Deep copy of a JSON value with every string redacted and every value under a secret-looking key replaced. */
  value<T>(v: T): T;
}

/** Rule `secret` forms of one registered value (same set as the Rust first-aid redactor): raw, base64 and base64url each with and
 *  without padding, hex in lower and upper case, and URL-encoded. The length check happens before this derivation. Duplicates
 *  (no padding needed, an ASCII value with nothing to encode) are dropped. */
export function secretFormsOf(s: string): string[] {
  const buf = Buffer.from(s);
  const std = buf.toString("base64"); const url = buf.toString("base64url");
  const hex = buf.toString("hex");
  return [...new Set([s, std, std.replace(/=+$/, ""), url, url + "=".repeat((4 - (url.length % 4)) % 4), hex, hex.toUpperCase(), encodeURIComponent(s)])];
}

export function createRedactor(o: RedactOptions = {}): Redactor {
  const secretForms: string[] = [];
  for (const s of o.secrets ?? []) {
    if (typeof s !== "string" || s.length < (rule("secret").minLength as number)) continue;
    secretForms.push(...secretFormsOf(s));
  }
  secretForms.sort((a, b) => b.length - a.length);

  const text = (input: string): string => {
    let s = input;
    for (const f of secretForms) if (f.length > 0) s = s.split(f).join(tag("secret"));
    s = s.replace(/\b((?:proxy-)?authorization|(?:set-)?cookie)([ \t]*:[ \t]*)([^\r\n]*)/gi,
      (_m, name: string, sep: string) => `${name}${sep}${tag("key")}`);
    // Header values can contain spaces and semicolon-separated cookies: redact the whole line.
    s = s.replace(/^([A-Za-z0-9_-]+)([ \t]*:[ \t]*)([^\r\n]+)/gm, (m, name: string, sep: string) => isSecretKey(name) ? `${name}${sep}${tag("key")}` : m);
    s = redactPairs(s);
    for (const p of PATTERNS) s = applyPattern(s, p, "pattern");
    s = mapUrls(s, (u) => { let r = u; for (const st of URL_STEPS) r = applyPattern(r, st, "url"); return r; });
    for (const p of SPACE_PATHS) s = redactSpacedPath(s, p);
    s = s.replace(PATH_TOKEN, (tok) => {
      const segs = canonical(tok.startsWith("~") ? tok.slice(1) : tok);
      const cls = denyClassOf(segs);
      return cls ? `<deny:${cls}>/…#${sha6(segs.join("/"))}` : tok;
    });
    if (o.pii === true) for (const p of PII) s = applyPattern(s, p, "pii");
    return s;
  };

  // A line is JSON-parsed from a file anyone with log access may have written to: nesting is bounded so one record cannot
  // overflow the stack (and fail a whole query); what is deeper is replaced, never passed on unredacted.
  const walk = (v: unknown, ancestors: object[]): unknown => {
    if (typeof v === "string") return text(v);
    if (v !== null && typeof v === "object") {
      if (ancestors.includes(v)) throw new TypeError("circular value"); // the callers turn this into log.redaction.failed
      if (ancestors.length >= MAX_DEPTH) return "[TRUNCATED:depth]";
      ancestors.push(v);
      try {
        if (Array.isArray(v)) return v.map((x) => walk(x, ancestors));
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          // defineProperty: a plain assignment to `__proto__` would set the prototype and lose the key.
          Object.defineProperty(out, k, { value: isSecretKey(k) && x !== null && x !== undefined ? tag("key") : walk(x, ancestors), enumerable: true, writable: true, configurable: true });
        }
        return out;
      } finally { ancestors.pop(); }
    }
    return v;
  };
  const value = <T>(v: T): T => walk(v, []) as T;
  return { text, value };
}
