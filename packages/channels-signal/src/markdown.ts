export type TextStyleName = "BOLD" | "ITALIC" | "STRIKETHROUGH" | "MONOSPACE" | "SPOILER";
/** Range in UTF-16 code units, which is what signal-cli (Java String indices) expects. */
export interface TextStyle {
  start: number;
  length: number;
  style: TextStyleName;
}
export interface StyledText {
  text: string;
  styles: TextStyle[];
}

type Frag = StyledText;
interface Delim {
  k: "d";
  ch: string;
  n: number;
  orig: number;
  open: boolean;
  close: boolean;
}
type Tok = { k: "t"; s: string } | { k: "f"; f: Frag } | Delim | { k: "o" | "c"; style: TextStyleName };

const WS = /[\s ]/u;
const PUNCT = /[\p{P}\p{S}]/u;
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

// Mention placeholder (U+FFFC) and control characters never leave this converter: model output must not forge mentions.
function clean(s: string): string {
  return s.replace(/￼/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function lastChar(s: string, end: number): string {
  if (end <= 0) return " ";
  const c = s.charCodeAt(end - 1);
  if (c >= 0xdc00 && c <= 0xdfff && end >= 2) return s.slice(end - 2, end);
  return s[end - 1]!;
}
function firstChar(s: string, at: number): string {
  if (at >= s.length) return " ";
  const cp = s.codePointAt(at)!;
  return String.fromCodePoint(cp);
}

function concat(parts: Frag[], sep = ""): Frag {
  let text = "";
  const styles: TextStyle[] = [];
  parts.forEach((p, i) => {
    if (i > 0) text += sep;
    for (const s of p.styles) styles.push({ ...s, start: s.start + text.length });
    text += p.text;
  });
  return { text, styles };
}

function matchBracket(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "`") {
      let n = 1;
      while (src[i + n] === "`") n++;
      const close = src.indexOf("`".repeat(n), i + n);
      if (close >= 0) i = close + n - 1;
      else i += n - 1;
    } else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    } else if (c === "\n") return -1;
  }
  return -1;
}

function parseLinkDest(raw: string): string | undefined {
  const t = raw.trim();
  let m = /^<([^<>\s]*)>(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?$/.exec(t);
  if (m) return m[1]!;
  m = /^(\S+?)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?$/.exec(t);
  return m ? m[1]! : undefined;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let lit = "";
  const flush = () => {
    if (lit) toks.push({ k: "t", s: lit });
    lit = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      const n = src[i + 1];
      if (n !== undefined && ASCII_PUNCT.test(n)) {
        lit += n;
        i += 2;
      } else {
        lit += c;
        i++;
      }
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (src[i + n] === "`") n++;
      const fence = "`".repeat(n);
      let j = src.indexOf(fence, i + n);
      while (j >= 0 && src[j + n] === "`") {
        let m = n;
        while (src[j + m] === "`") m++;
        j = src.indexOf(fence, j + m);
      }
      if (j < 0) {
        lit += fence;
        i += n;
        continue;
      }
      let body = src.slice(i + n, j).replace(/\n/g, " ");
      if (body.length > 2 && body.startsWith(" ") && body.endsWith(" ") && body.trim()) body = body.slice(1, -1);
      flush();
      toks.push({ k: "f", f: { text: body, styles: body ? [{ start: 0, length: body.length, style: "MONOSPACE" }] : [] } });
      i = j + n;
      continue;
    }
    if (c === "<") {
      const m = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(src.slice(i, i + 2048));
      if (m) {
        lit += m[1];
        i += m[0].length;
        continue;
      }
    }
    if (c === "[" || (c === "!" && src[i + 1] === "[")) {
      const image = c === "!";
      const open = image ? i + 1 : i;
      const close = matchBracket(src, open);
      if (close >= 0 && src[close + 1] === "(") {
        const pclose = matchParen(src, close + 1);
        const dest = pclose >= 0 ? parseLinkDest(src.slice(close + 2, pclose)) : undefined;
        if (dest !== undefined) {
          const label = inline(src.slice(open + 1, close));
          const url = dest.replace(/\\([!-/:-@[-`{-~])/g, "$1");
          let f: Frag;
          if (!url) f = label;
          else if (label.text === url || !label.text.trim()) f = { text: url, styles: [] };
          else f = concat([label, { text: ` (${url})`, styles: [] }]);
          flush();
          toks.push({ k: "f", f });
          i = pclose + 1;
          continue;
        }
      }
    }
    if (c === "*" || c === "_" || c === "~" || c === "|") {
      let n = 1;
      while (src[i + n] === c) n++;
      if ((c === "~" || c === "|") && n < 2) {
        lit += c.repeat(n);
        i += n;
        continue;
      }
      const before = lastChar(src, i);
      const after = firstChar(src, i + n);
      const bws = WS.test(before),
        aws = WS.test(after),
        bp = PUNCT.test(before),
        ap = PUNCT.test(after);
      const left = !aws && (!ap || bws || bp);
      const right = !bws && (!bp || aws || ap);
      const open = c === "_" ? left && (!right || bp) : left;
      const close = c === "_" ? right && (!left || ap) : right;
      flush();
      toks.push({ k: "d", ch: c, n, orig: n, open, close });
      i += n;
      continue;
    }
    lit += c;
    i++;
  }
  flush();
  return toks;
}

function processEmphasis(toks: Tok[]): void {
  let ci = 0;
  while (ci < toks.length) {
    const c = toks[ci]!;
    if (c.k !== "d" || !c.close || c.n === 0) {
      ci++;
      continue;
    }
    const strongOnly = c.ch === "~" || c.ch === "|";
    let found = -1;
    for (let oi = ci - 1; oi >= 0; oi--) {
      const o = toks[oi]!;
      if (o.k !== "d" || o.ch !== c.ch || !o.open || o.n === 0) continue;
      if (strongOnly && (o.n < 2 || c.n < 2)) continue;
      if (!strongOnly && (o.close || c.open) && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0))
        continue;
      found = oi;
      break;
    }
    if (found < 0) {
      if (!c.open) c.close = false;
      ci++;
      continue;
    }
    const o = toks[found] as Delim;
    const use = strongOnly || (o.n >= 2 && c.n >= 2) ? 2 : 1;
    const style: TextStyleName =
      c.ch === "~" ? "STRIKETHROUGH" : c.ch === "|" ? "SPOILER" : use === 2 ? "BOLD" : "ITALIC";
    o.n -= use;
    c.n -= use;
    for (let k = found + 1; k < ci; k++) {
      const t = toks[k]!;
      if (t.k === "d") toks[k] = { k: "t", s: t.ch.repeat(t.n) };
    }
    toks.splice(ci, 0, { k: "c", style });
    toks.splice(found + 1, 0, { k: "o", style });
    ci += 2;
    if (c.n === 0) ci++;
  }
}

function inline(src: string): Frag {
  const toks = tokenize(src);
  // processEmphasis is quadratic in the number of delimiter runs; past this bound the runs simply stay literal.
  if (toks.filter((t) => t.k === "d").length <= 1500) processEmphasis(toks);
  let text = "";
  const styles: TextStyle[] = [];
  const stack: Array<{ style: TextStyleName; start: number }> = [];
  for (const t of toks) {
    if (t.k === "t") text += t.s;
    else if (t.k === "f") {
      for (const s of t.f.styles) styles.push({ ...s, start: s.start + text.length });
      text += t.f.text;
    } else if (t.k === "d") text += t.ch.repeat(t.n);
    else if (t.k === "o") stack.push({ style: t.style, start: text.length });
    else {
      const top = stack.pop();
      if (top && text.length > top.start) styles.push({ start: top.start, length: text.length - top.start, style: top.style });
    }
  }
  return { text, styles };
}

function wrap(f: Frag, style: TextStyleName): Frag {
  return f.text ? { text: f.text, styles: [{ start: 0, length: f.text.length, style }, ...f.styles] } : f;
}
function prefixed(prefix: string, f: Frag): Frag {
  return concat([{ text: prefix, styles: [] }, f]);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^(\s*)[-*+][ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;

/** CommonMark subset → plain text + Signal text-style ranges. Unknown markup stays literal; nothing is ever interpreted as a mention. */
export function toSignalText(markdown: string): StyledText {
  const lines = clean(markdown.replace(/\r\n?/g, "\n")).split("\n");
  const blocks: Frag[] = [];
  let i = 0;
  const special = (l: string) => FENCE.test(l) || HEADING.test(l) || HR.test(l) || BULLET.test(l) || QUOTE.test(l) || !l.trim();
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence && !(fence[1]![0] === "`" && fence[2]!.includes("`"))) {
      const ch = fence[1]![0]!;
      const len = fence[1]!.length;
      const close = new RegExp(`^ {0,3}\\${ch}{${len},}[ \\t]*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      const text = body.join("\n");
      blocks.push({ text, styles: text ? [{ start: 0, length: text.length, style: "MONOSPACE" }] : [] });
      continue;
    }
    let m: RegExpExecArray | null;
    if (!line.trim()) {
      blocks.push({ text: "", styles: [] });
      i++;
    } else if ((m = HEADING.exec(line))) {
      blocks.push(wrap(inline(m[1]!), "BOLD"));
      i++;
    } else if (HR.test(line)) {
      blocks.push({ text: "──────", styles: [] });
      i++;
    } else if ((m = BULLET.exec(line))) {
      blocks.push(prefixed(`${m[1]}• `, inline(m[2]!)));
      i++;
    } else if ((m = QUOTE.exec(line))) {
      blocks.push(prefixed("> ", inline(m[1]!)));
      i++;
    } else {
      const para = [line];
      i++;
      while (i < lines.length && !special(lines[i]!)) para.push(lines[i++]!);
      blocks.push(inline(para.join("\n")));
    }
  }
  const out = concat(blocks, "\n");
  out.styles.sort((a, b) => a.start - b.start || b.length - a.length);
  return out;
}
export const toPlatformMarkdown = toSignalText;

/** signal-cli `textStyle` parameter values: "start:length:STYLE". */
export function formatTextStyles(styles: readonly TextStyle[]): string[] {
  return styles.map((s) => `${s.start}:${s.length}:${s.style}`);
}
