// A restricted YAML reader for the importer: block mappings and sequences, plain/quoted scalars, flow lists of
// scalars and `|`/`>` block scalars — enough for a source's config file and a SKILL.md frontmatter. Anything else
// (anchors, aliases, tags, flow mappings, nested flow collections) is not guessed at: the entry is left out and named
// in `unsupported`, so the caller reports that key as unknown.

interface Line { raw: string; indent: number; no: number }

const INT = /^[-+]?\d+$/;
const FLOAT = /^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/;

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
    while (body.length && body[body.length - 1] === "") body.pop();
    const keep = indicator.includes("+"); const strip = indicator.includes("-");
    let s: string;
    if (indicator.startsWith("|")) s = body.join("\n");
    else s = body.reduce((acc, cur, idx) => (idx === 0 ? cur : cur === "" ? `${acc}\n` : acc.endsWith("\n") ? acc + cur : `${acc} ${cur}`), "");
    return strip ? s : keep ? `${s}\n` : `${s}\n`;
  };

  // Parses the value that follows a key or a "- " (text `rest`, on line `pos`), consuming its lines.
  const inlineValue = (rest: string, indent: number, where: string): { ok: boolean; v?: unknown } => {
    const r = stripComment(rest).trim();
    if (r === "") {
      const j = nextSig(pos + 1);
      if (j < lines.length && (lines[j]!.indent > indent || (lines[j]!.indent === indent && /^-(\s|$)/.test(lines[j]!.raw.trim())))) {
        pos = j;
        return { ok: true, v: block(lines[j]!.indent) };
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

  const block = (indent: number): unknown => {
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
        if (restTrim !== "" && /^("[^"]*"|'[^']*'|[^\s"'#[{][^:#]*?)\s*:(\s|$)/.test(restTrim) && !restTrim.startsWith("[")) {
          const col = indent + 1 + (rest.length - restTrim.length);
          lines[pos] = { ...l, raw: " ".repeat(col) + restTrim, indent: col };
          arr.push(block(col));
        } else {
          const r = inlineValue(rest, indent, `item ${arr.length}`);
          if (r.ok) arr.push(r.v);
        }
      }
      return arr;
    }
    const obj: Record<string, unknown> = {};
    for (;;) {
      pos = nextSig(pos);
      if (pos >= lines.length) break;
      const l = lines[pos]!;
      if (l.indent !== indent) { if (l.indent > indent) { unsupported.push(`line ${l.no}: unexpected indentation`); skipChildren(indent); continue; } break; }
      const t = l.raw.trim();
      const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#[{][^#]*?)\s*:(\s+|$)(.*)$/.exec(t);
      if (!m) { unsupported.push(`line ${l.no}: not a mapping entry`); skipChildren(indent); continue; }
      const key = String(scalar(m[1]!));
      const r = inlineValue(m[3] ?? "", indent, key);
      if (r.ok) Object.defineProperty(obj, key, { value: r.v, enumerable: true, writable: true, configurable: true });
    }
    return obj;
  };

  pos = nextSig(0);
  if (pos >= lines.length) return { value: null, unsupported };
  const value = block(lines[pos]!.indent);
  return { value, unsupported };
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
