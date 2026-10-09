// CommonMark (subset, as LLMs write it) -> Slack mrkdwn. Everything that is not recognised markup is literal text:
// `&`, `<`, `>` are always escaped, so model or user text can never form `<!channel>`, `<@U...>` or `<url|label>`
// tokens. Only the converter itself emits angle-bracket tokens, and only for validated http(s)/mailto links.
// Slack has no backslash escape, so literal `*`, `_`, `~` and backticks that could open or close markup are wrapped in
// zero-width spaces (best effort: Slack only formats at word boundaries).

const ZWSP = "​";
const MARKERS = "*_~`";
const PUNCT = /[!-/:-@[-`{-~]/;

const isAlnum = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

/** Escapes the three characters Slack treats as control syntax. */
export function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function lit(c: string, prev: string | undefined, next: string | undefined): string {
  if (c === "&") return "&amp;";
  if (c === "<") return "&lt;";
  if (c === ">") return "&gt;";
  if (MARKERS.includes(c)) {
    if (c !== "`" && isAlnum(prev) && isAlnum(next)) return c;
    return ZWSP + c + ZWSP;
  }
  return c;
}

/** Literal text: escapes control syntax and neutralises markup. For `format: "plain"` turns. */
export function escapeSlackText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += lit(text[i]!, text[i - 1], text[i + 1]);
  return out;
}

function safeUrl(raw: string): string | undefined {
  const url = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f​\s]/.test(url)) return undefined;
  if (!/^(https?:\/\/[^/?#\s]+|mailto:[^\s]+)/i.test(url)) return undefined;
  return url;
}
function encodeUrl(url: string): string {
  return escapeSlack(url).replace(/\|/g, "%7C");
}

interface Ctx {
  bold: boolean;
  italic: boolean;
  strike: boolean;
}

function skipCode(s: string, k: number): number {
  let n = 0;
  while (s[k + n] === "`") n++;
  const close = findBackticks(s, k + n, n);
  return close < 0 ? k + n : close + n;
}
function findBackticks(s: string, from: number, n: number): number {
  let k = from;
  while (k < s.length) {
    if (s[k] === "`") {
      let m = 0;
      while (s[k + m] === "`") m++;
      if (m === n) return k;
      k += m;
    } else k++;
  }
  return -1;
}

function findClose(s: string, from: number, marker: string): number {
  const c = marker[0]!;
  let k = from;
  while (k < s.length) {
    const ch = s[k]!;
    if (ch === "\\") {
      k += 2;
      continue;
    }
    if (ch === "`") {
      k = skipCode(s, k);
      continue;
    }
    if (ch === c) {
      let run = 0;
      while (s[k + run] === c) run++;
      const ok =
        !isSpace(s[k - 1]) &&
        (marker.length === 1 ? run === 1 : run >= marker.length) &&
        (c !== "_" || !isAlnum(s[k + marker.length]));
      if (ok) return k;
      k += run;
      continue;
    }
    k++;
  }
  return -1;
}

function matchBracket(s: string, i: number): number {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const ch = s[k]!;
    if (ch === "\\") k++;
    else if (ch === "`") k = skipCode(s, k) - 1;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return k;
  }
  return -1;
}

function parseDestination(s: string, i: number): { url: string; end: number } | undefined {
  let k = i;
  while (s[k] === " " || s[k] === "\n") k++;
  let url = "";
  if (s[k] === "<") {
    const e = s.indexOf(">", k);
    if (e < 0) return undefined;
    url = s.slice(k + 1, e);
    k = e + 1;
  } else {
    let depth = 0;
    const start = k;
    for (; k < s.length; k++) {
      const ch = s[k]!;
      if (ch === "\\") k++;
      else if (/\s/.test(ch)) break;
      else if (ch === "(") depth++;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    url = s.slice(start, k);
  }
  while (s[k] === " " || s[k] === "\n") k++;
  const q = s[k];
  if (q === '"' || q === "'" || q === "(") {
    const closeCh = q === "(" ? ")" : q;
    const e = s.indexOf(closeCh, k + 1);
    if (e < 0) return undefined;
    k = e + 1;
    while (s[k] === " " || s[k] === "\n") k++;
  }
  if (s[k] !== ")") return undefined;
  return { url: url.replace(/\\(.)/g, "$1"), end: k + 1 };
}

function inline(s: string, ctx: Ctx): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1]!)) {
      out += lit(s[i + 1]!, s[i - 1], s[i + 2]);
      i += 2;
      continue;
    }
    if (c === "\\" && s[i + 1] === "\n") {
      out += "\n";
      i += 2;
      continue;
    }
    if (c === "`") {
      let n = 0;
      while (s[i + n] === "`") n++;
      const close = findBackticks(s, i + n, n);
      if (close < 0) {
        for (let k = 0; k < n; k++) out += ZWSP + "`" + ZWSP;
        i += n;
        continue;
      }
      let content = s.slice(i + n, close).replace(/\n/g, " ");
      if (content.length > 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim()) content = content.slice(1, -1);
      out += content.includes("`") || !content.trim() ? escapeSlack(content) : "`" + escapeSlack(content) + "`";
      i = close + n;
      continue;
    }
    if (c === "[" || (c === "!" && s[i + 1] === "[")) {
      const image = c === "!";
      const open = image ? i + 1 : i;
      const close = matchBracket(s, open);
      if (close > 0 && s[close + 1] === "(") {
        const dest = parseDestination(s, close + 2);
        if (dest) {
          const labelSrc = s.slice(open + 1, close);
          const label = inline(labelSrc, ctx).replace(/\s*\n\s*/g, " ");
          const url = safeUrl(dest.url);
          if (url) {
            const enc = encodeUrl(url);
            out += label && labelSrc.trim() !== url ? `<${enc}|${label}>` : `<${enc}>`;
          } else {
            out += label + (dest.url.trim() ? ` (${escapeSlack(dest.url.trim())})` : "");
          }
          i = dest.end;
          continue;
        }
      }
    }
    if (c === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]*)>/i.exec(s.slice(i));
      if (m && safeUrl(m[1]!)) {
        out += `<${encodeUrl(m[1]!)}>`;
        i += m[0].length;
        continue;
      }
      const mail = /^<([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/.exec(s.slice(i));
      if (mail) {
        out += `<mailto:${encodeUrl(mail[1]!)}|${escapeSlack(mail[1]!)}>`;
        i += mail[0].length;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      let n = 0;
      while (s[i + n] === c) n++;
      const prev = s[i - 1];
      const canOpen = !isSpace(s[i + n]) && (c === "*" || !isAlnum(prev));
      if (canOpen) {
        const tries: number[] = n >= 3 ? [3, 2, 1] : n === 2 ? [2, 1] : [1];
        let done = false;
        for (const len of tries) {
          const marker = c.repeat(len);
          const close = findClose(s, i + len, marker);
          if (close < 0) continue;
          const inner = s.slice(i + len, close);
          if (!inner || isSpace(inner[0])) continue;
          const wrap = (inner2: string, ch: string, on: boolean, sub: Ctx): string =>
            on ? inline(inner2, sub) : ch + inline(inner2, sub) + ch;
          if (len === 3) {
            const a = ctx.bold ? "" : "*";
            const b = ctx.italic ? "" : "_";
            out += a + b + inline(inner, { ...ctx, bold: true, italic: true }) + b + a;
          } else if (len === 2) out += wrap(inner, "*", ctx.bold, { ...ctx, bold: true });
          else out += wrap(inner, "_", ctx.italic, { ...ctx, italic: true });
          i = close + len;
          done = true;
          break;
        }
        if (done) continue;
      }
      for (let k = 0; k < n; k++) out += lit(c, s[i + k - 1] ?? prev, s[i + k + 1]);
      i += n;
      continue;
    }
    if (c === "~" && s[i + 1] === "~" && !isSpace(s[i + 2])) {
      const close = findClose(s, i + 2, "~~");
      if (close > i + 2) {
        const inner = s.slice(i + 2, close);
        out += ctx.strike ? inline(inner, ctx) : "~" + inline(inner, { ...ctx, strike: true }) + "~";
        i = close + 2;
        continue;
      }
    }
    out += lit(c, s[i - 1], s[i + 1]);
    i++;
  }
  return out;
}

function codeBlock(body: string): string {
  const safe = escapeSlack(body).replace(/```/g, "``" + ZWSP + "`");
  return "```\n" + safe + "\n```";
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}>/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$|^\s*\|\s*:?-+:?\s*\|\s*$/;

function splitRow(row: string): string[] {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < r.length; i++) {
    if (r[i] === "\\" && r[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (r[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += r[i];
  }
  cells.push(cur.trim());
  return cells;
}
function plainCell(c: string): string {
  return c
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, "$1$2");
}
function renderTable(lines: string[]): string {
  const [head, , ...body] = lines;
  const rows = [splitRow(head!), ...body.map(splitRow)].map((r) => r.map(plainCell));
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(1, ...rows.map((r) => [...(r[c] ?? "")].length)));
  const fmt = (r: string[]) => widths.map((w, c) => (r[c] ?? "").padEnd(w)).join(" | ").trimEnd();
  const out = [fmt(rows[0]!), widths.map((w) => "-".repeat(w)).join("-+-"), ...rows.slice(1).map(fmt)];
  return codeBlock(out.join("\n"));
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEP.test(next))
  );
}

function blocks(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const none: Ctx = { bold: false, italic: false, strike: false };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (!line.trim()) {
      out.push("");
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const f = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l);
        if (close && close[1]![0] === f[0] && close[1]!.length >= f.length) {
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      out.push(codeBlock(body.join("\n")));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const text = inline(heading[2]!, { ...none, bold: true }).trim();
      if (text) out.push(`*${text}*`);
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push("──────────");
      i++;
      continue;
    }
    if (line.includes("|") && lines[i + 1] !== undefined && TABLE_SEP.test(lines[i + 1]!)) {
      const rows = [line, lines[i + 1]!];
      i += 2;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) rows.push(lines[i++]!);
      out.push(renderTable(rows));
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) inner.push(lines[i++]!.replace(/^ {0,3}(?:>[ \t]?)+/, ""));
      const body = blocks(inner.join("\n"));
      out.push(body.split("\n").map((l) => (l ? "> " + l : ">")).join("\n"));
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const indent = item[1]!.replace(/\t/g, "    ").length;
      const depth = Math.min(6, Math.floor(indent / 2));
      const bullet = /^\d/.test(item[2]!) ? item[2]!.replace(")", ".") : "•";
      const textLines = [item[3]!];
      i++;
      while (i < lines.length && lines[i]!.trim() && !ITEM.test(lines[i]!) && !startsBlock(lines[i]!, lines[i + 1]) && /^\s+/.test(lines[i]!)) {
        textLines.push(lines[i++]!.trim());
      }
      let text = textLines.join("\n");
      const task = /^\[( |x|X)\][ \t]+/.exec(text);
      let mark = "";
      if (task) {
        mark = task[1] === " " ? "☐ " : "☑ ";
        text = text.slice(task[0].length);
      }
      const pad = "    ".repeat(depth);
      out.push(pad + bullet + " " + mark + inline(text, none).split("\n").join("\n" + pad + "  "));
      continue;
    }
    const para = [line.trimStart()];
    i++;
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!, lines[i + 1])) para.push(lines[i++]!.trim());
    out.push(inline(para.join("\n"), none));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Converts CommonMark to Slack mrkdwn. Never emits `<!...>`, `<@...>` or `<#...>` tokens. */
export function toSlackMrkdwn(markdown: string): string {
  return blocks(markdown).trim();
}

/** Inbound direction: Slack's wire text to readable plain text (links unwrapped, entities decoded). */
export function slackToPlain(text: string): string {
  return text
    .replace(/<!(?:here|channel|everyone)(?:\|[^>]*)?>/g, (m) => "@" + /!(\w+)/.exec(m)![1]!)
    .replace(/<!subteam\^[A-Z0-9]+\|(@[^>]+)>/g, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<(https?:\/\/[^|>\s]+|mailto:[^|>\s]+)\|([^>]*)>/g, (_m, u: string, l: string) => (l && l !== u ? `${l} (${u})` : u))
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
