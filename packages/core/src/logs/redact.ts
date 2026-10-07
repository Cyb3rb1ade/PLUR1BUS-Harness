// Reader-side redaction for log records, from the D111 §4 data in @plur1bus/log-schema (rules in order: secret, key,
// pattern, url, path, pii). RULING: the foundation writer that redacts at write time is not on main yet, and files may
// have been written by any process under the OS user (module-guide §9), so nothing leaves the core unredacted. The
// pass is idempotent: `[REDACTED:<rule>]` contains nothing any rule matches, so a line the writer already redacted
// comes out unchanged.
import { createHash } from "node:crypto";
import { REDACTION } from "@plur1bus/log-schema";

interface PatternDef { id: string; pattern: string; flags?: string; leftBoundary?: boolean; valueGroup?: number; replacement?: string; exemptWhenWholeMatchIs?: string }
interface Rule { id: string; [k: string]: any }

export interface RedactorOptions {
  /** Exact secret values this process holds (ADR-005): replaced in raw, base64 and URL-encoded form; shorter than 8 chars are ignored. */
  secrets?: () => readonly string[];
  /** `logs.redactPii`: email addresses and phone numbers too. Default false. */
  redactPii?: () => boolean;
}
export interface Redactor {
  text(s: string): string;
  /** Redacts every string and every key of a JSON-like value; a value under a credential-named key is replaced whole. */
  value(v: unknown): unknown;
  /** True when `key` names a credential (the §4 rule 2 key-name test). */
  isSecretKey(key: string): boolean;
}

const tmpl = (id: string): string => String((REDACTION as any).replacementTemplate ?? "[REDACTED:{rule}]").replace("{rule}", id);
const ruleOf = (id: string): Rule => {
  const r = ((REDACTION as any).rules as Rule[]).find((x) => x.id === id);
  if (!r) throw new Error(`log-schema redaction data lacks rule ${id}`);
  return r;
};

/** Replaces `match[g]` (or the whole match) of every `re` match; `re` must carry the `g` and `d` flags. */
function replaceMatches(s: string, re: RegExp, fn: (m: RegExpExecArray) => { from: number; to: number; with: string } | null): string {
  let out = "";
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const r = fn(m);
    if (r && r.from >= last) { out += s.slice(last, r.from) + r.with; last = r.to; }
  }
  return out + s.slice(last);
}

const compile = (pattern: string, flags = ""): RegExp => new RegExp(pattern, `${flags.replace(/[gdy]/g, "")}gd`);
const span = (m: RegExpExecArray, group: number | undefined): { from: number; to: number } => {
  const idx = (m as any).indices as Array<[number, number] | undefined>;
  const g = group !== undefined ? idx[group] : undefined;
  return g ? { from: g[0], to: g[1] } : { from: m.index, to: m.index + m[0].length };
};

export function createRedactor(o: RedactorOptions = {}): Redactor {
  const key = ruleOf("key");
  const keyRe = new RegExp(key.pattern, key.flags ?? "");
  const camelRe = new RegExp(key.camelPattern);
  const isSecretKey = (k: string): boolean => keyRe.test(k) || camelRe.test(k);
  const KEY_MARK = tmpl("key");

  const patterns = (ruleOf("pattern").patterns as PatternDef[]).map((p) => ({ def: p, re: compile(p.pattern, p.flags), exempt: p.exemptWhenWholeMatchIs ? new RegExp(p.exemptWhenWholeMatchIs) : null }));
  const PATTERN_MARK = tmpl("pattern");
  const url = ruleOf("url");
  const urlFind = compile(url.find);
  const urlSteps = (url.steps as PatternDef[]).map((st) => ({ st, re: compile(st.pattern, st.flags) }));
  const URL_MARK = tmpl("url");
  const pathRule = ruleOf("path");
  const PATH_RE = /(?:[A-Za-z]:)?[^\s"'<>|]*[\\/][^\s"'<>|]*/gd;
  const pii = ruleOf("pii");
  const piiPatterns = (pii.patterns as PatternDef[]).map((p) => compile(p.pattern, p.flags));
  const PII_MARK = tmpl("pii");
  const SECRET_MARK = tmpl("secret");

  const secretForms = (): string[] => {
    const out = new Set<string>();
    for (const s of o.secrets?.() ?? []) {
      if (typeof s !== "string" || s.length < (ruleOf("secret").minLength ?? 8)) continue;
      out.add(s); out.add(Buffer.from(s, "utf8").toString("base64")); out.add(encodeURIComponent(s));
    }
    return [...out].filter((f) => f.length >= 8).sort((a, b) => b.length - a.length);
  };

  const redactSecrets = (s: string): string => { let r = s; for (const f of secretForms()) if (r.includes(f)) r = r.split(f).join(SECRET_MARK); return r; };

  // key=value and `Header: value` and "key":"value" inside free text. A header-style value runs to the end of the line.
  const KV_EQ = /([A-Za-z0-9_.-]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gd;
  const KV_JSON = /("(?:[^"\\]|\\.)*")(\s*:\s*)("(?:[^"\\]|\\.)*"|[^\s,}\]]+)/gd;
  const KV_HEADER = /(^|[\r\n])([A-Za-z][A-Za-z0-9_-]*)(\s*:\s*)([^\r\n]+)/gd;
  const redactKeys = (s: string): string => {
    let r = replaceMatches(s, KV_JSON, (m) => (isSecretKey(m[1]!.slice(1, -1)) ? { ...span(m, 3), with: `"${KEY_MARK}"` } : null));
    r = replaceMatches(r, KV_EQ, (m) => (isSecretKey(m[1]!) ? { ...span(m, 3), with: KEY_MARK } : null));
    return replaceMatches(r, KV_HEADER, (m) => (isSecretKey(m[2]!) ? { ...span(m, 4), with: KEY_MARK } : null));
  };

  const redactPatterns = (s: string): string => {
    let r = s;
    for (const { def, re, exempt } of patterns) {
      r = replaceMatches(r, re, (m) => {
        if (def.leftBoundary && m.index > 0 && /[A-Za-z0-9]/.test(r[m.index - 1]!)) return null;
        if (exempt && exempt.test(m[0])) return null;
        return { ...span(m, def.valueGroup), with: PATTERN_MARK };
      });
    }
    return r;
  };

  const redactUrls = (s: string): string => replaceMatches(s, urlFind, (m) => {
    let u = m[0];
    for (const { st, re } of urlSteps) u = replaceMatches(u, re, (x) => ({ ...span(x, st.valueGroup), with: st.replacement ?? URL_MARK }));
    return { from: m.index, to: m.index + m[0].length, with: u };
  });

  const segmentsMatch = (segs: string[], want: string[]): boolean => {
    for (let i = 0; i + want.length <= segs.length; i++) if (want.every((w, j) => segs[i + j]!.toLowerCase() === w.toLowerCase())) return true;
    return false;
  };
  const fileMatch = (name: string, globs: string[]): boolean => globs.some((g) => (g.endsWith(".*") ? name.toLowerCase().startsWith(g.slice(0, -1).toLowerCase()) : name.toLowerCase() === g.toLowerCase()));
  const denyClass = (token: string): string | null => {
    const segs = token.split(/[\\/]+/).filter((x) => x.length > 0);
    for (const c of pathRule.classes as Array<{ id: string; segments?: string[][]; files?: string[] }>) {
      if (c.segments?.some((w) => segmentsMatch(segs, w))) return c.id;
      if (c.files && segs.length > 0 && fileMatch(segs[segs.length - 1]!, c.files)) return c.id;
    }
    return null;
  };
  const redactPaths = (s: string): string => replaceMatches(s, PATH_RE, (m) => {
    const cls = denyClass(m[0]);
    if (!cls) return null;
    const canon = m[0].replace(/\\/g, "/").replace(/\/+/g, "/");
    const h = createHash("sha256").update(canon).digest("hex").slice(0, Number(pathRule.hash?.hexChars ?? 6));
    return { from: m.index, to: m.index + m[0].length, with: String(pathRule.format).replace("{class}", cls).replace("{hash}", h) };
  });

  const redactPii = (s: string): string => { let r = s; for (const re of piiPatterns) r = replaceMatches(r, re, (m) => ({ ...span(m, undefined), with: PII_MARK })); return r; };

  const text = (s: string): string => {
    let r = redactSecrets(s);
    r = redactKeys(r);
    r = redactPatterns(r);
    r = redactUrls(r);
    r = redactPaths(r);
    if (o.redactPii?.() === true) r = redactPii(r);
    return r;
  };

  const MAX_DEPTH = 8;
  const value = (v: unknown, depth = 0): unknown => {
    if (typeof v === "string") return text(v);
    if (v === null || typeof v === "number" || typeof v === "boolean") return v;
    if (depth >= MAX_DEPTH) return "[TRUNCATED]";
    if (Array.isArray(v)) return v.map((x) => value(x, depth + 1));
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        out[text(k)] = isSecretKey(k) && x !== null && x !== undefined ? KEY_MARK : value(x, depth + 1);
      }
      return out;
    }
    return undefined;
  };
  return { text, value: (v) => value(v), isSecretKey };
}
