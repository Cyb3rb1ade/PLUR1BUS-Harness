// HTML → readable Markdown for web.fetch (D94 step 3), dependency-free. Not a full HTML5 parser: a forgiving
// tokenizer with a handful of implied-end-tag rules, a node and depth cap (hostile or enormous documents degrade,
// they do not hang or overflow the stack), main-content selection, boilerplate removal, and a Markdown renderer for
// the structures that matter (headings, lists, tables, code, links as absolute URLs, image alt text).
//
// Output is DATA. Nothing here interprets page text; tags that appear as text (`&lt;script&gt;`) stay text.

export interface Extracted {
  markdown: string;
  title?: string;
  lang?: string;
  canonicalUrl?: string;
  publishedAt?: string;
  /** Almost no text but scripts present: a client-rendered shell (D94 step 4, `needs-render`). */
  looksClientRendered: boolean;
}

export interface Section {
  id: string;
  title: string;
  level: number;
  text: string;
  tokens: number;
}

const MAX_NODES = 300_000;
const MAX_DEPTH = 200;

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

// ---------------------------------------------------------------- entities

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", mdash: "—", ndash: "–",
  hellip: "…", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„", euro: "€",
  pound: "£", yen: "¥", cent: "¢", sect: "§", deg: "°", plusmn: "±", times: "×", divide: "÷", middot: "·", bull: "•",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", hearts: "♥", para: "¶", frac12: "½", frac14: "¼", frac34: "¾", micro: "µ",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", eacute: "é", egrave: "è", agrave: "à",
  aacute: "á", ccedil: "ç", ntilde: "ñ", oacute: "ó", uacute: "ú", iacute: "í", ecirc: "ê", acirc: "â", ocirc: "ô", shy: "",
  zwj: "", zwnj: "", ensp: " ", emsp: " ", thinsp: " ",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,10}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, body: string) => {
    if (body[0] === "#") {
      const n = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(n) || n > 0x10ffff) return whole;
      if (n === 0 || (n >= 0xd800 && n <= 0xdfff)) return "�";
      return String.fromCodePoint(n);
    }
    return Object.hasOwn(NAMED, body) ? NAMED[body]! : whole;
  });
}

// ---------------------------------------------------------------- parser

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Array<El | string>;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "div", "dl", "fieldset", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul"]);

function parseTree(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [] };
  const stack: El[] = [root];
  const top = (): El => stack[stack.length - 1]!;
  let lower: string | undefined;
  let nodes = 0;
  const closeUntil = (names: string[], stopAt: string[]): void => {
    for (let k = stack.length - 1; k > 0; k--) {
      const t = stack[k]!.tag;
      if (stopAt.includes(t)) return;
      if (names.includes(t)) {
        stack.length = k;
        return;
      }
    }
  };
  let i = 0;
  const n = html.length;
  while (i < n && nodes < MAX_NODES) {
    if (html.charCodeAt(i) !== 60 /* < */) {
      let j = html.indexOf("<", i);
      if (j === -1) j = n;
      top().children.push(decodeEntities(html.slice(i, j)));
      i = j;
      continue;
    }
    if (html.startsWith("<!--", i)) {
      const j = html.indexOf("-->", i + 4);
      i = j === -1 ? n : j + 3;
      continue;
    }
    const c = html[i + 1] ?? "";
    if (c === "!" || c === "?") {
      const j = html.indexOf(">", i + 2);
      i = j === -1 ? n : j + 1;
      continue;
    }
    if (c === "/") {
      const m = /^<\/([A-Za-z][^\s/>]*)[^>]*>?/.exec(html.slice(i, i + 300));
      if (!m) {
        top().children.push("<");
        i++;
        continue;
      }
      i += m[0].length;
      const tag = m[1]!.toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.tag === tag) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    if (!/[A-Za-z]/.test(c)) {
      top().children.push("<");
      i++;
      continue;
    }
    // start tag
    let j = i + 1;
    while (j < n && !/[\s/>]/.test(html[j]!)) j++;
    const tag = html.slice(i + 1, j).toLowerCase();
    const attrs: Record<string, string> = {};
    for (;;) {
      while (j < n && /[\s/]/.test(html[j]!)) j++;
      if (j >= n) break;
      if (html[j] === ">") {
        j++;
        break;
      }
      const ns = j;
      while (j < n && !/[\s=/>]/.test(html[j]!)) j++;
      const name = html.slice(ns, j).toLowerCase();
      while (j < n && /\s/.test(html[j]!)) j++;
      let value = "";
      if (html[j] === "=") {
        j++;
        while (j < n && /\s/.test(html[j]!)) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const e = html.indexOf(q, j + 1);
          value = html.slice(j + 1, e === -1 ? n : e);
          j = e === -1 ? n : e + 1;
        } else {
          const vs = j;
          while (j < n && !/[\s>]/.test(html[j]!)) j++;
          value = html.slice(vs, j);
        }
      }
      if (name !== "" && !Object.hasOwn(attrs, name)) attrs[name] = decodeEntities(value);
      else if (name === "") j++;
    }
    i = j;
    nodes++;

    // implied end tags
    if (CLOSES_P.has(tag) && top().tag === "p") stack.pop();
    if (tag === "li") closeUntil(["li"], ["ul", "ol"]);
    else if (tag === "dt" || tag === "dd") closeUntil(["dt", "dd"], ["dl"]);
    else if (tag === "tr") closeUntil(["tr"], ["table"]);
    else if (tag === "td" || tag === "th") closeUntil(["td", "th"], ["tr", "table"]);
    else if (tag === "option") closeUntil(["option"], ["select"]);

    const el: El = { tag, attrs, children: [] };
    top().children.push(el);
    if (RAW.has(tag)) {
      lower ??= html.toLowerCase();
      const e = lower.indexOf(`</${tag}`, i);
      const body = html.slice(i, e === -1 ? n : e);
      if (body !== "") el.children.push(tag === "script" || tag === "style" ? body : decodeEntities(body));
      if (e === -1) i = n;
      else {
        const g = html.indexOf(">", e);
        i = g === -1 ? n : g + 1;
      }
      continue;
    }
    if (!VOID.has(tag) && stack.length < MAX_DEPTH) stack.push(el);
  }
  return root;
}

// ---------------------------------------------------------------- render

const DROP = new Set(["script", "style", "noscript", "template", "svg", "iframe", "object", "embed", "canvas", "head", "select", "button", "input", "textarea", "form", "nav", "footer", "aside", "dialog", "audio", "video", "map"]);
const BLOCK = new Set(["address", "article", "aside", "blockquote", "details", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "thead", "tfoot", "tr", "td", "th", "ul", "body", "html", "#root"]);
const BANNER = /cookie|consent|gdpr|onetrust|cc-banner|cc-window/i;
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden/i;

interface Ctx {
  base: URL | null;
  keepHeader: boolean;
}

function skip(el: El, ctx: Ctx): boolean {
  if (el.tag === "header" && ctx.keepHeader) return false;
  if (DROP.has(el.tag) || el.tag === "header") return true;
  const a = el.attrs;
  if (a.hidden !== undefined || a["aria-hidden"] === "true") return true;
  if (a.style !== undefined && HIDDEN_STYLE.test(a.style)) return true;
  if (a.role === "navigation" || a.role === "banner" || a.role === "contentinfo" || a.role === "dialog") return true;
  if (BANNER.test(a.id ?? "") || BANNER.test(a.class ?? "")) return true;
  return false;
}

const collapse = (s: string): string => s.replace(/[\s ]+/g, " ");

function absUrl(href: string | undefined, ctx: Ctx, schemes: string[]): string | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), ctx.base ?? undefined);
    return schemes.includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function wrap(inner: string, mark: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  return m[2] === "" ? inner : `${m[1]}${mark}${m[2]}${mark}${m[3]}`;
}

function inline(n: El | string, ctx: Ctx): string {
  if (typeof n === "string") return collapse(n);
  if (skip(n, ctx)) return "";
  const kids = (): string => n.children.map((c) => inline(c, ctx)).join("");
  switch (n.tag) {
    case "br":
      return "\n";
    case "b":
    case "strong":
      return wrap(kids(), "**");
    case "i":
    case "em":
      return wrap(kids(), "*");
    case "del":
    case "s":
      return wrap(kids(), "~~");
    case "code":
    case "kbd":
    case "samp": {
      const t = textOf(n).replace(/\s+/g, " ");
      return t.trim() === "" ? "" : `\`${t}\``;
    }
    case "a": {
      const text = kids().trim();
      const href = absUrl(n.attrs.href, ctx, ["http:", "https:", "mailto:"]);
      if (text === "") return "";
      return href ? `[${text}](${href})` : text;
    }
    case "img": {
      const alt = collapse(n.attrs.alt ?? "").trim();
      const src = absUrl(n.attrs.src, ctx, ["http:", "https:"]);
      return alt !== "" && src ? `![${alt}](${src})` : "";
    }
    default:
      return BLOCK.has(n.tag) ? ` ${kids()} ` : kids();
  }
}

/** Raw text with whitespace preserved (for <pre> and inline code). */
function textOf(n: El | string): string {
  if (typeof n === "string") return n;
  if (n.tag === "br") return "\n";
  if (DROP.has(n.tag) && n.tag !== "head") return "";
  return n.children.map(textOf).join("");
}

function tidy(s: string): string {
  return s
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/ {2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function renderList(el: El, ctx: Ctx, ordered: boolean): string {
  const lines: string[] = [];
  let k = 0;
  for (const c of el.children) {
    if (typeof c === "string" || c.tag !== "li" || skip(c, ctx)) continue;
    k++;
    const body = blocksOf(c.children, ctx).join("\n");
    if (body === "") {
      k--;
      continue;
    }
    const mark = ordered ? `${k}. ` : "- ";
    const pad = " ".repeat(mark.length);
    lines.push(
      body
        .split("\n")
        .map((l, idx) => (idx === 0 ? mark + l : l === "" ? l : pad + l))
        .join("\n"),
    );
  }
  return lines.join("\n");
}

function collectRows(el: El, rows: El[]): void {
  for (const c of el.children) {
    if (typeof c === "string") continue;
    if (c.tag === "tr") rows.push(c);
    else if (c.tag === "thead" || c.tag === "tbody" || c.tag === "tfoot") collectRows(c, rows);
  }
}

function renderTable(el: El, ctx: Ctx): string {
  const rows: El[] = [];
  collectRows(el, rows);
  const grid = rows
    .map((r) =>
      r.children
        .filter((c): c is El => typeof c !== "string" && (c.tag === "td" || c.tag === "th"))
        .map((c) => tidy(c.children.map((x) => inline(x, ctx)).join("")).replace(/\n/g, " ").replace(/\|/g, "\\|")),
    )
    .filter((r) => r.length > 0);
  if (grid.length === 0) return "";
  const width = Math.max(...grid.map((r) => r.length));
  const line = (r: string[]): string => `| ${[...r, ...new Array<string>(width - r.length).fill("")].join(" | ")} |`;
  return [line(grid[0]!), line(new Array<string>(width).fill("---")), ...grid.slice(1).map(line)].join("\n");
}

function renderBlock(el: El, ctx: Ctx): string[] {
  const t = el.tag;
  if (/^h[1-6]$/.test(t)) {
    const text = tidy(el.children.map((c) => inline(c, ctx)).join("")).replace(/\n/g, " ");
    return text === "" ? [] : [`${"#".repeat(Number(t[1]))} ${text}`];
  }
  switch (t) {
    case "ul":
    case "ol": {
      const s = renderList(el, ctx, t === "ol");
      return s === "" ? [] : [s];
    }
    case "pre": {
      const code = el.children.find((c): c is El => typeof c !== "string" && c.tag === "code");
      const lang = /(?:^|\s)(?:language|lang)-([A-Za-z0-9_+-]{1,20})/.exec(code?.attrs.class ?? el.attrs.class ?? "")?.[1] ?? "";
      const body = textOf(el).replace(/^\n/, "").replace(/\s+$/, "");
      return body === "" ? [] : [`\`\`\`${lang}\n${body}\n\`\`\``];
    }
    case "table": {
      const s = renderTable(el, ctx);
      return s === "" ? [] : [s];
    }
    case "blockquote": {
      const inner = blocksOf(el.children, ctx).join("\n\n");
      return inner === "" ? [] : [inner.split("\n").map((l) => (l === "" ? ">" : `> ${l}`)).join("\n")];
    }
    case "hr":
      return ["---"];
    case "dt": {
      const text = tidy(el.children.map((c) => inline(c, ctx)).join(""));
      return text === "" ? [] : [wrap(text, "**")];
    }
    default:
      return blocksOf(el.children, ctx);
  }
}

function blocksOf(nodes: Array<El | string>, ctx: Ctx): string[] {
  const out: string[] = [];
  let buf = "";
  const flush = (): void => {
    const s = tidy(buf);
    if (s !== "") out.push(s);
    buf = "";
  };
  for (const node of nodes) {
    if (typeof node === "string") {
      buf += collapse(node);
      continue;
    }
    if (skip(node, ctx)) continue;
    if (BLOCK.has(node.tag)) {
      flush();
      out.push(...renderBlock(node, ctx));
    } else buf += inline(node, ctx);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- metadata and selection

function walk(root: El, visit: (el: El) => void): void {
  const todo: El[] = [root];
  while (todo.length > 0) {
    const el = todo.pop()!;
    visit(el);
    for (let k = el.children.length - 1; k >= 0; k--) {
      const c = el.children[k]!;
      if (typeof c !== "string") todo.push(c);
    }
  }
}

function findAll(root: El, pred: (el: El) => boolean): El[] {
  const hits: El[] = [];
  walk(root, (el) => {
    if (pred(el)) hits.push(el);
  });
  return hits;
}

export function htmlToMarkdown(html: string, baseUrl: string): Extracted {
  let base: URL | null = null;
  try {
    base = new URL(baseUrl);
  } catch {
    /* relative links stay unresolved */
  }
  const root = parseTree(html);
  const meta: Extracted = { markdown: "", looksClientRendered: false };
  let scripts = 0;
  walk(root, (el) => {
    switch (el.tag) {
      case "title":
        if (meta.title === undefined) {
          const t = collapse(textOf(el)).trim();
          if (t !== "") meta.title = t;
        }
        break;
      case "html":
        if (el.attrs.lang && meta.lang === undefined) meta.lang = el.attrs.lang.trim();
        break;
      case "link":
        if (/(^|\s)canonical(\s|$)/i.test(el.attrs.rel ?? "") && meta.canonicalUrl === undefined) {
          const u = absUrl(el.attrs.href, { base, keepHeader: false }, ["http:", "https:"]);
          if (u) meta.canonicalUrl = u;
        }
        break;
      case "meta": {
        const key = (el.attrs.property ?? el.attrs.name ?? el.attrs.itemprop ?? "").toLowerCase();
        if (meta.publishedAt === undefined && (key === "article:published_time" || key === "date" || key === "datepublished" || key === "og:published_time") && el.attrs.content) meta.publishedAt = el.attrs.content.trim();
        break;
      }
      case "time":
        if (meta.publishedAt === undefined && el.attrs.datetime) meta.publishedAt = el.attrs.datetime.trim();
        break;
      case "script":
        scripts++;
        break;
    }
  });

  const bodyEl = findAll(root, (e) => e.tag === "body")[0] ?? root;
  const mains = findAll(root, (e) => e.tag === "main" || e.attrs.role === "main");
  const articles = findAll(root, (e) => e.tag === "article");
  const picked = mains[0] ?? (articles.length === 1 ? articles[0] : undefined);

  const render = (el: El, keepHeader: boolean): string => {
    const blocks = blocksOf(el.tag === "#root" || el.tag === "body" ? el.children : [el], { base, keepHeader });
    return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  };
  let markdown = render(picked ?? bodyEl, picked !== undefined);
  if (picked !== undefined && markdown.length < 200) {
    const whole = render(bodyEl, false);
    if (whole.length >= markdown.length * 10) markdown = whole; // the picked node was a stub, not the content
  }
  meta.markdown = markdown;
  meta.looksClientRendered = markdown.trim().length < 80 && scripts > 0;
  return meta;
}

// ---------------------------------------------------------------- sections

export function splitSections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const parts: Array<{ title: string; level: number; lines: string[] }> = [];
  let cur: { title: string; level: number; lines: string[] } = { title: "(start)", level: 0, lines: [] };
  let fenced = false;
  for (const line of lines) {
    if (/^```/.test(line)) fenced = !fenced;
    const m = !fenced && !/^```/.test(line) ? /^(#{1,6}) +(.+?)\s*$/.exec(line) : null;
    if (m) {
      parts.push(cur);
      cur = { title: m[2]!, level: m[1]!.length, lines: [line] };
    } else cur.lines.push(line);
  }
  parts.push(cur);
  const nonEmpty = parts.filter((p, idx) => !(idx === 0 && p.lines.join("\n").trim() === ""));
  return nonEmpty.map((p, idx) => {
    const text = p.lines.join("\n").replace(/\s+$/, "").replace(/^\n+/, "");
    return { id: `s${idx}`, title: p.title, level: p.level, text, tokens: estimateTokens(text) };
  });
}

// ---------------------------------------------------------------- charset

const BOMS: Array<[number[], string]> = [
  [[0xef, 0xbb, 0xbf], "utf-8"],
  [[0xff, 0xfe], "utf-16le"],
  [[0xfe, 0xff], "utf-16be"],
];

function tryDecode(buf: Uint8Array, label: string): string | null {
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return null;
  }
}

/** Charset detection per D94: Content-Type header → BOM → `<meta>` in the first 2 KB → UTF-8. Never throws. */
export function decodeBody(buf: Uint8Array, contentType: string | undefined): string {
  const fromHeader = /charset\s*=\s*["']?([A-Za-z0-9_.:-]+)/i.exec(contentType ?? "")?.[1];
  if (fromHeader) {
    const t = tryDecode(buf, fromHeader);
    if (t !== null) return t;
  }
  for (const [bom, label] of BOMS) if (bom.every((b, i) => buf[i] === b)) return tryDecode(buf, label) ?? "";
  const head = Buffer.from(buf.subarray(0, 2048)).toString("latin1");
  const meta = /<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9_.:-]+)/i.exec(head)?.[1];
  if (meta) {
    const t = tryDecode(buf, meta);
    if (t !== null) return t;
  }
  return new TextDecoder("utf-8").decode(buf);
}
