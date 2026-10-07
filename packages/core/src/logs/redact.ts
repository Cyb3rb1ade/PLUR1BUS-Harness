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
const URL_FIND = new RegExp(rule("url").find, "g");
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

export interface RedactOptions {
  /** Rule `pii` (`logs.redactPii`); default false. */
  pii?: boolean;
  /** Rule `secret`: exact secret values this process holds (≥ 8 characters), with their base64 and URL-encoded forms. */
  secrets?: Iterable<string>;
}

export interface Redactor {
  text(s: string): string;
  /** Deep copy of a JSON value with every string redacted and every value under a secret-looking key replaced. */
  value<T>(v: T): T;
}

export function createRedactor(o: RedactOptions = {}): Redactor {
  const secretForms: string[] = [];
  for (const s of o.secrets ?? []) {
    if (typeof s !== "string" || s.length < (rule("secret").minLength as number)) continue;
    secretForms.push(s, Buffer.from(s).toString("base64"), encodeURIComponent(s));
  }
  secretForms.sort((a, b) => b.length - a.length);

  const text = (input: string): string => {
    let s = input;
    for (const f of secretForms) if (f.length > 0) s = s.split(f).join(tag("secret"));
    s = s.replace(/\b((?:proxy-)?authorization|(?:set-)?cookie)([ \t]*:[ \t]*)([^\r\n]*)/gi,
      (_m, name: string, sep: string) => `${name}${sep}${tag("key")}`);
    // Header values can contain spaces and semicolon-separated cookies: redact the whole line.
    s = s.replace(/^([A-Za-z0-9_-]+)([ \t]*:[ \t]*)([^\r\n]+)/gm, (m, name: string, sep: string) => isSecretKey(name) ? `${name}${sep}${tag("key")}` : m);
    // `key=value` / `"key": "value"` inside free text
    s = s.replace(/(["']?)([A-Za-z0-9_.-]+)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|(?:Bearer|Basic)\s+[^\s,;&"']+|[^\s,;&"']+)/gi, (m, q: string, name: string, sep: string, val: string) => {
      if (!isSecretKey(name)) return m;
      const quote = val.startsWith('"') ? '"' : val.startsWith("'") ? "'" : "";
      return `${q}${name}${q}${sep}${quote}${tag("key")}${quote}`;
    });
    for (const p of PATTERNS) s = applyPattern(s, p, "pattern");
    s = s.replace(URL_FIND, (u) => { let r = u; for (const st of URL_STEPS) r = applyPattern(r, st, "url"); return r; });
    for (const p of SPACE_PATHS) s = redactSpacedPath(s, p);
    s = s.replace(PATH_TOKEN, (tok) => {
      const segs = canonical(tok.startsWith("~") ? tok.slice(1) : tok);
      const cls = denyClassOf(segs);
      return cls ? `<deny:${cls}>/…#${sha6(segs.join("/"))}` : tok;
    });
    if (o.pii === true) for (const p of PII) s = applyPattern(s, p, "pii");
    return s;
  };

  const value = <T>(v: T): T => {
    if (typeof v === "string") return text(v) as T;
    if (Array.isArray(v)) return v.map((x) => value(x)) as T;
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        out[k] = isSecretKey(k) && x !== null && x !== undefined ? tag("key") : value(x);
      }
      return out as T;
    }
    return v;
  };
  return { text, value };
}
