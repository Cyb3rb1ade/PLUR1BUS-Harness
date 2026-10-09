// A small, safe CommonMark subset -> (plain text body, Matrix custom HTML). Safe by construction: the parser builds a tiny AST
// whose text nodes are always escaped on output; raw HTML in the input is never passed through. Only the tag allowlist of the
// Matrix client-server spec is ever emitted, and `href` only for http(s) and mailto URLs.

type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del"; c: Inline[] }
  | { t: "link"; href: string | undefined; c: Inline[] }
  | { t: "br" };
type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "code"; lang: string | undefined; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

export interface MatrixText {
  /** Plain text fallback (Markdown markers stripped). */
  body: string;
  /** `org.matrix.custom.html`; present only when the text actually carries markup. */
  formattedBody?: string;
}

const PUNCT = /[!-/:-@[-`{-~]/;
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ ]?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** http(s) and mailto only; anything else (javascript:, data:, vbscript:, relative, whitespace tricks) yields undefined. */
export function safeHref(raw: string): string | undefined {
  const u = raw.replace(/\\([!-/:-@[-`{-~])/g, "$1").trim();
  if (!u || u.length > 2048 || /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(u)) return undefined;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(u)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") {
    try {
      const url = new URL(u);
      return url.hostname && !url.username && !url.password ? u : undefined;
    } catch {
      return undefined;
    }
  }
  if (scheme === "mailto") return /^mailto:[^\s?#]+(?:\?[^\s#]*)?$/i.test(u) ? u : undefined;
  return undefined;
}

// ---------------------------------------------------------------- inline

function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\\") {
      const next = s[i + 1];
      if (next === "\n") {
        buf = buf.replace(/ +$/, "");
        flush();
        out.push({ t: "br" });
        i += 2;
      } else if (next !== undefined && PUNCT.test(next)) {
        buf += next;
        i += 2;
      } else {
        buf += "\\";
        i++;
      }
      continue;
    }
    if (ch === "\n") {
      buf = buf.replace(/ +$/, "");
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }
    if (ch === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const close = findBacktickRun(s, i + n, n);
      if (close >= 0) {
        let code = s.slice(i + n, close).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        flush();
        out.push({ t: "code", v: code });
        i = close + n;
      } else {
        buf += "`".repeat(n);
        i += n;
      }
      continue;
    }
    if (ch === "!" && s[i + 1] === "[") {
      const link = tryLink(s, i + 1);
      if (link) {
        flush();
        out.push(link.node);
        i = link.end;
      } else {
        buf += "!";
        i++;
      }
      continue;
    }
    if (ch === "[") {
      const link = tryLink(s, i);
      if (link) {
        flush();
        out.push(link.node);
        i = link.end;
      } else {
        buf += "[";
        i++;
      }
      continue;
    }
    if (ch === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i));
      if (m) {
        flush();
        out.push({ t: "link", href: safeHref(m[1]!), c: [{ t: "text", v: m[1]! }] });
        i += m[0].length;
      } else {
        buf += "<";
        i++;
      }
      continue;
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      let n = 1;
      while (s[i + n] === ch) n++;
      const parsed = tryEmphasis(s, i, ch, n);
      if (parsed) {
        flush();
        out.push(parsed.node);
        i = parsed.end;
      } else {
        buf += ch.repeat(n);
        i += n;
      }
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

function findBacktickRun(s: string, from: number, n: number): number {
  let i = from;
  while (i < s.length) {
    if (s[i] !== "`") {
      i++;
      continue;
    }
    let m = 1;
    while (s[i + m] === "`") m++;
    if (m === n) return i;
    i += m;
  }
  return -1;
}

function tryEmphasis(s: string, i: number, ch: string, run: number): { node: Inline; end: number } | undefined {
  const len = ch === "~" ? (run === 2 ? 2 : 0) : run >= 3 ? 3 : run;
  if (len === 0) return undefined;
  const after = s[i + len];
  const before = s[i - 1];
  if (after === undefined || /\s/.test(after)) return undefined;
  if (ch === "_" && before !== undefined && /[A-Za-z0-9]/.test(before)) return undefined;
  if (run > len) return undefined;
  let j = i + len;
  while (j < s.length) {
    const c = s[j]!;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (s[j + n] === "`") n++;
      const close = findBacktickRun(s, j + n, n);
      j = close >= 0 ? close + n : j + n;
      continue;
    }
    if (c === ch) {
      let m = 1;
      while (s[j + m] === ch) m++;
      const prev = s[j - 1]!;
      const next = s[j + m];
      const closes =
        m === len && !/\s/.test(prev) && !(ch === "_" && next !== undefined && /[A-Za-z0-9]/.test(next));
      if (closes && j > i + len) {
        const inner = parseInline(s.slice(i + len, j));
        const node: Inline =
          len === 3
            ? { t: "strong", c: [{ t: "em", c: inner }] }
            : len === 2
              ? { t: ch === "~" ? "del" : "strong", c: inner }
              : { t: "em", c: inner };
        return { node, end: j + m };
      }
      j += m;
      continue;
    }
    j++;
  }
  return undefined;
}

function tryLink(s: string, i: number): { node: Inline; end: number } | undefined {
  // s[i] === "["; find the matching "]".
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    const c = s[j]!;
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (s[j + n] === "`") n++;
      const close = findBacktickRun(s, j + n, n);
      j = close >= 0 ? close + n - 1 : j + n - 1;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
  }
  if (j >= s.length || s[j + 1] !== "(") return undefined;
  const text = s.slice(i + 1, j);
  let k = j + 2;
  while (s[k] === " " || s[k] === "\t") k++;
  let dest = "";
  if (s[k] === "<") {
    const e = s.indexOf(">", k);
    if (e < 0 || s.slice(k, e).includes("\n")) return undefined;
    dest = s.slice(k + 1, e);
    k = e + 1;
  } else {
    let parens = 0;
    while (k < s.length && !/\s/.test(s[k]!)) {
      if (s[k] === "\\") {
        dest += s[k]! + (s[k + 1] ?? "");
        k += 2;
        continue;
      }
      if (s[k] === "(") parens++;
      if (s[k] === ")") {
        if (parens === 0) break;
        parens--;
      }
      dest += s[k];
      k++;
    }
  }
  while (s[k] === " " || s[k] === "\t" || s[k] === "\n") k++;
  const q = s[k];
  if (q === '"' || q === "'") {
    const e = s.indexOf(q, k + 1);
    if (e < 0) return undefined;
    k = e + 1;
    while (s[k] === " " || s[k] === "\t") k++;
  }
  if (s[k] !== ")") return undefined;
  return { node: { t: "link", href: safeHref(dest), c: parseInline(text) }, end: k + 1 };
}

// ---------------------------------------------------------------- blocks

const isBlank = (l: string): boolean => l.trim() === "";
const indentOf = (l: string): number => /^ */.exec(l)![0].length;

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (t[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(l: string): boolean {
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || ITEM.test(l);
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]!);
        if (m && m[1]![0] === marker[0] && m[1]!.length >= marker.length) {
          i++;
          break;
        }
        body.push(lines[i]!);
        i++;
      }
      out.push({ t: "code", lang: fence[2] || undefined, v: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push({ t: "h", level: h[1]!.length, c: parseInline((h[2] ?? "").trim()) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) inner.push(lines[i]!.replace(QUOTE, "")), i++;
      out.push({ t: "quote", c: parseBlocks(inner) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]!);
      const start = ordered ? Number.parseInt(item[2]!, 10) : 1;
      const items: Block[][] = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]!);
        if (!m || /\d/.test(m[2]!) !== ordered) break;
        const content = m[1]!.length + m[2]!.length + 1;
        const body: string[] = [m[3] ?? ""];
        i++;
        while (i < lines.length) {
          const l = lines[i]!;
          if (isBlank(l)) {
            let j = i;
            while (j < lines.length && isBlank(lines[j]!)) j++;
            if (j < lines.length && indentOf(lines[j]!) >= content) {
              for (; i < j; i++) body.push("");
              continue;
            }
            break;
          }
          if (indentOf(l) >= content) {
            body.push(l.slice(content));
            i++;
          } else if (!startsBlock(l) && !isBlank(body[body.length - 1]!)) {
            body.push(l.trim());
            i++;
          } else break;
        }
        items.push(parseBlocks(body));
        let j = i;
        while (j < lines.length && isBlank(lines[j]!)) j++;
        const nx = j < lines.length ? ITEM.exec(lines[j]!) : null;
        if (nx && /\d/.test(nx[2]!) === ordered && nx[1]!.length < content) i = j;
        else break;
      }
      out.push({ t: "list", ordered, start, items });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const head = splitRow(line);
      const delim = splitRow(lines[i + 1]!);
      if (head.length === delim.length && lines[i + 1]!.includes("|")) {
        const rows: Inline[][][] = [];
        i += 2;
        while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes("|")) {
          const cells = splitRow(lines[i]!);
          rows.push(head.map((_, k) => parseInline(cells[k] ?? "")));
          i++;
        }
        out.push({ t: "table", head: head.map((c) => parseInline(c)), rows });
        continue;
      }
    }
    const para: string[] = [line.replace(/^\s+/, "")];
    i++;
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!)) para.push(lines[i++]!.replace(/^\s+/, ""));
    out.push({ t: "p", c: parseInline(para.join("\n").replace(/\s+$/, "")) });
  }
  return out;
}

// ---------------------------------------------------------------- rendering

function inlineHtml(nodes: Inline[]): string {
  return nodes
    .map((n): string => {
      switch (n.t) {
        case "text":
          return escapeHtml(n.v);
        case "code":
          return `<code>${escapeHtml(n.v)}</code>`;
        case "strong":
          return `<strong>${inlineHtml(n.c)}</strong>`;
        case "em":
          return `<em>${inlineHtml(n.c)}</em>`;
        case "del":
          return `<del>${inlineHtml(n.c)}</del>`;
        case "br":
          return "<br>";
        case "link":
          return n.href ? `<a href="${escapeHtml(n.href)}">${inlineHtml(n.c)}</a>` : inlineHtml(n.c);
      }
    })
    .join("");
}

function blocksHtml(blocks: Block[], top: boolean): string {
  if (top && blocks.length === 1 && blocks[0]!.t === "p") return inlineHtml(blocks[0]!.c);
  return blocks
    .map((b): string => {
      switch (b.t) {
        case "p":
          return `<p>${inlineHtml(b.c)}</p>`;
        case "h":
          return `<h${b.level}>${inlineHtml(b.c)}</h${b.level}>`;
        case "code": {
          const cls = b.lang && /^[A-Za-z0-9_+#.-]{1,32}$/.test(b.lang) ? ` class="language-${escapeHtml(b.lang)}"` : "";
          return `<pre><code${cls}>${escapeHtml(b.v)}</code></pre>`;
        }
        case "quote":
          return `<blockquote>${blocksHtml(b.c, false)}</blockquote>`;
        case "hr":
          return "<hr>";
        case "list": {
          const tag = b.ordered ? "ol" : "ul";
          const attr = b.ordered && b.start !== 1 ? ` start="${b.start}"` : "";
          const items = b.items
            .map((it) => `<li>${it.length === 1 && it[0]!.t === "p" ? inlineHtml(it[0]!.c) : blocksHtml(it, false)}</li>`)
            .join("");
          return `<${tag}${attr}>${items}</${tag}>`;
        }
        case "table": {
          const row = (cells: Inline[][], cell: string): string =>
            `<tr>${cells.map((c) => `<${cell}>${inlineHtml(c)}</${cell}>`).join("")}</tr>`;
          return `<table><thead>${row(b.head, "th")}</thead><tbody>${b.rows.map((r) => row(r, "td")).join("")}</tbody></table>`;
        }
      }
    })
    .join("");
}

function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n): string => {
      switch (n.t) {
        case "text":
        case "code":
          return n.v;
        case "strong":
        case "em":
        case "del":
          return inlineText(n.c);
        case "br":
          return "\n";
        case "link": {
          const text = inlineText(n.c);
          return n.href && text !== n.href ? `${text} (${n.href})` : text;
        }
      }
    })
    .join("");
}

function blocksText(blocks: Block[]): string {
  return blocks
    .map((b): string => {
      switch (b.t) {
        case "p":
        case "h":
          return inlineText(b.c);
        case "code":
          return b.v;
        case "quote":
          return blocksText(b.c)
            .split("\n")
            .map((l) => (l ? `> ${l}` : ">"))
            .join("\n");
        case "hr":
          return "---";
        case "list":
          return b.items
            .map((it, k) => {
              const marker = b.ordered ? `${b.start + k}. ` : "- ";
              const pad = " ".repeat(marker.length);
              return blocksText(it)
                .split("\n")
                .map((l, n) => (n === 0 ? marker + l : l ? pad + l : l))
                .join("\n");
            })
            .join("\n");
        case "table":
          return [b.head, ...b.rows].map((r) => r.map((c) => inlineText(c)).join(" | ")).join("\n");
      }
    })
    .join("\n\n");
}

/** Convert model-written Markdown into a Matrix `m.room.message` text body + optional `org.matrix.custom.html`. */
export function toMatrixText(markdown: string): MatrixText {
  const blocks = parseBlocks(markdown.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").split("\n"));
  const body = blocksText(blocks);
  const html = blocksHtml(blocks, true);
  const hasMarkup = /<[a-z]/.test(html);
  return { body, ...(hasMarkup ? { formattedBody: html } : {}) };
}
export { toMatrixText as toPlatformMarkdown };
