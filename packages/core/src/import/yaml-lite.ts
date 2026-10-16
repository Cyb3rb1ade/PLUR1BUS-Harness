// A restricted YAML reader for the importer: block mappings and sequences, plain/quoted scalars, flow lists of
// scalars and `|`/`>` block scalars — enough for a source's config file and a SKILL.md frontmatter. Anything else
// (anchors, aliases, tags, flow mappings, nested flow collections) is not guessed at: the entry is left out and named
// in `unsupported`, so the caller reports that key as unknown.

interface Line { raw: string; indent: number; no: number }

const INT = /^[-+]?\d+$/;
const FLOAT = /^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/;

const MAX_DEPTH = 2048;
const TOO_DEEP = Symbol("too deep");
const QUOTED_ENTRY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(\s+|$)(.*)$/;
const isWs = (c: string | undefined) => c !== undefined && /\s/.test(c);

/**
 * Splits a trimmed line into a mapping key and the text after the colon, or null if it is not an entry. The plain key is
 * found with a single linear scan (a lazy regex over a long run of whitespace backtracks quadratically). `inSeq`: the
 * entry follows "- " and a plain key may not contain ':' (so "- a: b: c" is not read as the key "a: b").
 */
function entry(t: string, inSeq: boolean): { key: string; rest: string } | null {
  if (t === "") return null;
  const q = QUOTED_ENTRY.exec(t);
  if (q) return { key: q[1]!, rest: q[3] ?? "" };
  if (/[\s"'#[{]/.test(t[0]!)) return null;
  for (let j = 1; j < t.length; j++) {
    const c = t[j];
    if (c === "#") return null;
    if (c === ":") {
      if (j + 1 === t.length || isWs(t[j + 1])) return { key: t.slice(0, j).trimEnd(), rest: t.slice(j + 1).trimStart() };
      if (inSeq) return null;
    }
  }
  return null;
}

function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) { if (q === "'" && s[i + 1] === "'") { i++; continue; } q = null; } else if (c === "\\" && q === '"') i++; continue; }
    if (c === '"' || c === "'") { if (i === 0 || /[\s:[,-]/.test(s[i - 1]!)) q = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

export function scalar(s: string): unknown {
  const t = s.trim();
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replaceAll("''", "'");
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try { return JSON.parse(t.replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1")); } catch { return t.slice(1, -1); }
  }
  if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") return null;
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (INT.test(t)) return Number(t);
  if (FLOAT.test(t)) return Number(t);
  return t;
}

function splitFlow(inner: string): string[] | null {
  const out: string[] = []; let cur = ""; let q: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === "[" || c === "{") return null;
    if (c === ",") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() !== "" || out.length > 0) out.push(cur);
  return out.map((x) => x.trim()).filter((x, idx, all) => !(x === "" && idx === all.length - 1));
}

export function readYaml(text: string): { value: unknown; unsupported: string[] } {
  const unsupported: string[] = [];
  // A leading BOM (Notepad, PowerShell 5.1 `Out-File -Encoding utf8`) would count as indentation of the first line.
  const lines: Line[] = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n").map((raw, idx) => ({ raw, indent: raw.length - raw.trimStart().length, no: idx + 1 }));
  const blank = (l: Line) => { const t = l.raw.trim(); return t === "" || t.startsWith("#") || (l.indent === 0 && (t === "---" || t === "...")); };
  let pos = 0;
  const nextSig = (from: number) => { let j = from; while (j < lines.length && blank(lines[j]!)) j++; return j; };
  const skipChildren = (indent: number) => { pos++; for (;;) { const j = nextSig(pos); if (j >= lines.length || lines[j]!.indent <= indent) return; pos = j + 1; } };

  const blockScalar = (indicator: string, parentIndent: number): string => {
    pos++;
    const body: string[] = [];
    let ind = -1;
    while (pos < lines.length) {
      const l = lines[pos]!;
      if (l.raw.trim() === "") { body.push(""); pos++; continue; }
      if (l.indent <= parentIndent) break;
      if (ind < 0) ind = l.indent;
      body.push(l.raw.slice(Math.min(ind, l.indent)));
      pos++;
    }
    const keep = indicator.includes("+"); const strip = indicator.includes("-");
    // The final empty element of the split is the line terminator of the last line, not a blank line.
    if (keep && pos >= lines.length && lines[lines.length - 1]!.raw === "" && body.length) body.pop();
    let trailing = 0;
    while (body.length && body[body.length - 1] === "") { body.pop(); trailing++; }
    let s: string;
    if (indicator.startsWith("|")) s = body.join("\n");
    else s = body.reduce((acc, cur, idx) => (idx === 0 ? cur : cur === "" ? `${acc}\n` : acc.endsWith("\n") ? acc + cur : `${acc} ${cur}`), "");
    return strip ? s : keep && s !== "" ? `${s}\n${"\n".repeat(trailing)}` : `${s}\n`;
  };

  // Parses the value that follows a key or a "- " (text `rest`, on line `pos`), consuming its lines.
  const inlineValue = (rest: string, indent: number, where: string, inSeq = false): { ok: boolean; v?: unknown } => {
    const r = stripComment(rest).trim();
    if (r === "") {
      const j = nextSig(pos + 1);
      if (j < lines.length && (lines[j]!.indent > indent || (!inSeq && lines[j]!.indent === indent && /^-(\s|$)/.test(lines[j]!.raw.trim())))) {
        pos = j;
        const v = block(lines[j]!.indent);
        return v === TOO_DEEP ? { ok: false } : { ok: true, v };
      }
      pos++;
      return { ok: true, v: null };
    }
    if (/^[|>][+-]?\d*$/.test(r)) return { ok: true, v: blockScalar(r, indent) };
    if (/^[&*!]/.test(r) || r.startsWith("{")) { unsupported.push(`${where} (line ${lines[pos]!.no}): ${r[0] === "{" ? "flow mapping" : "anchor/alias/tag"}`); skipChildren(indent); return { ok: false }; }
    if (r.startsWith("[")) {
      const items = r.endsWith("]") ? splitFlow(r.slice(1, -1)) : null;
      if (!items) { unsupported.push(`${where} (line ${lines[pos]!.no}): nested or multi-line flow list`); skipChildren(indent); return { ok: false }; }
      pos++;
      return { ok: true, v: items.map(scalar) };
    }
    pos++;
    return { ok: true, v: scalar(r) };
  };

  let depth = 0;
  const block = (indent: number): unknown => {
    if (depth >= MAX_DEPTH) {
      unsupported.push(`line ${lines[pos]!.no}: nesting deeper than ${MAX_DEPTH} levels`);
      skipChildren(indent - 1);
      return TOO_DEEP;
    }
    depth++;
    const first = lines[pos]!;
    const isSeq = /^-(\s|$)/.test(first.raw.trim());
    if (isSeq) {
      const arr: unknown[] = [];
      for (;;) {
        pos = nextSig(pos);
        if (pos >= lines.length) break;
        const l = lines[pos]!;
        if (l.indent !== indent || !/^-(\s|$)/.test(l.raw.trim())) break;
        const rest = l.raw.trim().slice(1);
        const restTrim = rest.trimStart();
        if (restTrim !== "" && (/^-(\s|$)/.test(restTrim) || (!restTrim.startsWith("[") && entry(restTrim, true)))) {
          const col = indent + 1 + (rest.length - restTrim.length);
          lines[pos] = { ...l, raw: " ".repeat(col) + restTrim, indent: col };
          const v = block(col);
          if (v !== TOO_DEEP) arr.push(v);
        } else {
          const r = inlineValue(rest, indent, `item ${arr.length}`, true);
          if (r.ok) arr.push(r.v);
        }
      }
      depth--;
      return arr;
    }
    const obj: Record<string, unknown> = {};
    for (;;) {
      pos = nextSig(pos);
      if (pos >= lines.length) break;
      const l = lines[pos]!;
      if (l.indent !== indent) { if (l.indent > indent) { unsupported.push(`line ${l.no}: unexpected indentation`); skipChildren(indent); continue; } break; }
      const t = l.raw.trim();
      const m = entry(t, false);
      if (!m) { unsupported.push(`line ${l.no}: not a mapping entry`); skipChildren(indent); continue; }
      const key = String(scalar(m.key));
      const r = inlineValue(m.rest, indent, key);
      if (r.ok) Object.defineProperty(obj, key, { value: r.v, enumerable: true, writable: true, configurable: true });
    }
    depth--;
    return obj;
  };

  pos = nextSig(0);
  if (pos >= lines.length) return { value: null, unsupported };
  const value = block(lines[pos]!.indent);
  return { value: value === TOO_DEEP ? null : value, unsupported };
}

/** The YAML frontmatter of a Markdown file (between a leading `---` line and the next `---` line), or null. */
export function frontmatter(text: string): Record<string, unknown> | null {
  const t = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!t.startsWith("---\n")) return null;
  const end = t.indexOf("\n---", 3);
  if (end < 0) return null;
  const after = t[end + 4];
  if (after !== undefined && after !== "\n") return null;
  const { value } = readYaml(t.slice(4, end + 1));
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
