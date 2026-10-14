import { h } from "preact";
import type { View } from "../../view.ts";

export type MarkdownNode =
  | { kind: "h"; level: number; text: string; id: string }
  | { kind: "p"; children: InlineNode[] }
  | { kind: "codeblock"; lang?: string; code: string }
  | { kind: "ul"; items: InlineNode[][] }
  | { kind: "ol"; items: InlineNode[][] }
  | { kind: "table"; headers: InlineNode[][]; rows: InlineNode[][][] };

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "link"; text: string; href: string };

const SPECIAL = /[`[*]/g;

function parseInlines(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  // A closer that is absent after position i is absent after every later position: remember it, so a line of unclosed
  // openers is scanned once, not once per opener (quadratic on a long line of "[" or "`").
  const gone = new Set<string>();
  const find = (needle: string, from: number): number => {
    if (gone.has(needle)) return -1;
    const at = text.indexOf(needle, from);
    if (at < 0) gone.add(needle);
    return at;
  };
  let i = 0;
  while (i < text.length) {
    // Inline code `...`
    if (text[i] === "`") {
      const end = find("`", i + 1);
      if (end > i) {
        nodes.push({ kind: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Markdown link [text](url)
    if (text[i] === "[") {
      const closeB = find("]", i + 1);
      if (closeB > i && text[closeB + 1] === "(") {
        const closeP = find(")", closeB + 2);
        if (closeP > closeB) {
          const linkText = text.slice(i + 1, closeB);
          const href = text.slice(closeB + 2, closeP).trim();
          nodes.push({ kind: "link", text: linkText, href });
          i = closeP + 1;
          continue;
        }
      }
    }

    // Strong **text**
    if (text.startsWith("**", i)) {
      const end = find("**", i + 2);
      if (end > i) {
        nodes.push({ kind: "strong", text: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }

    // Em *text*
    if (text[i] === "*" && text[i + 1] !== "*") {
      const end = find("*", i + 1);
      if (end > i) {
        nodes.push({ kind: "em", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Plain text up to next special char
    SPECIAL.lastIndex = i;
    const nextSpecial = SPECIAL.exec(text)?.index ?? text.length;
    // A special character that opened no construct (lone `*`, unclosed backtick, `[` without `](`) is literal text.
    const stop = nextSpecial === i ? i + 1 : nextSpecial;
    const plain = text.slice(i, stop);
    const last = nodes[nodes.length - 1];
    if (last?.kind === "text") last.text += plain;
    else nodes.push({ kind: "text", text: plain });
    i = stop;
  }
  return nodes;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_ -]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Heading ids are unique within a document (a repeated heading gets -1, -2, ...) and never empty ("!!!" -> "section"). */
function uniqueId(text: string, used: Set<string>): string {
  const base = slugify(text) || "section";
  let id = base;
  for (let n = 1; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

export function parseMarkdown(markdown: string): MarkdownNode[] {
  const lines = markdown.split(/\r?\n/);
  const nodes: MarkdownNode[] = [];
  const usedIds = new Set<string>();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block ```
    if (/^\s{0,3}```/.test(line)) {
      const lang = line.replace(/^\s{0,3}```/, "").trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s{0,3}```/.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      i++; // skip closing fence
      nodes.push({
        kind: "codeblock",
        ...(lang ? { lang } : {}),
        code: codeLines.join("\n"),
      });
      continue;
    }

    // Headings # .. ######
    const hMatch = line.match(/^(\#{1,6})\s+(.+)$/);
    if (hMatch && hMatch[1] && hMatch[2]) {
      const level = hMatch[1].length;
      const text = hMatch[2].trim();
      nodes.push({ kind: "h", level, text, id: uniqueId(text, usedIds) });
      i++;
      continue;
    }

    // Setext headings (e.g. === or ---)
    const nextLine = lines[i + 1] ?? "";
    if (i + 1 < lines.length && /^\s*(=+|-+)\s*$/.test(nextLine) && line.trim()) {
      const level = nextLine.trim().startsWith("=") ? 1 : 2;
      const text = line.trim();
      nodes.push({ kind: "h", level, text, id: uniqueId(text, usedIds) });
      i += 2;
      continue;
    }

    // Table: starts with | and next line has |---|
    if (line.trim().startsWith("|") && i + 1 < lines.length && /^\|\s*[-:]+/.test(nextLine.trim())) {
      const splitRow = (r: string) =>
        r
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => parseInlines(c.trim()));

      const headers = splitRow(line);
      i += 2; // skip header and separator
      const rows: InlineNode[][][] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
        rows.push(splitRow(lines[i] ?? ""));
        i++;
      }
      nodes.push({ kind: "table", headers, rows });
      continue;
    }

    // Unordered list (- or *)
    if (/^\s{0,3}[-*]\s+/.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^\s{0,3}[-*]\s+/.test(lines[i] ?? "")) {
        const itemText = (lines[i] ?? "").replace(/^\s{0,3}[-*]\s+/, "").trim();
        items.push(parseInlines(itemText));
        i++;
      }
      nodes.push({ kind: "ul", items });
      continue;
    }

    // Ordered list (1. 2. etc)
    if (/^\s{0,3}\d+\.\s+/.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^\s{0,3}\d+\.\s+/.test(lines[i] ?? "")) {
        const itemText = (lines[i] ?? "").replace(/^\s{0,3}\d+\.\s+/, "").trim();
        items.push(parseInlines(itemText));
        i++;
      }
      nodes.push({ kind: "ol", items });
      continue;
    }

    // Paragraph (accumulate consecutive non-empty lines)
    const pLines: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !/^\s{0,3}```/.test(lines[i] ?? "") &&
      !/^(\#{1,6})\s+/.test(lines[i] ?? "") &&
      !(lines[i] ?? "").trim().startsWith("|") &&
      !/^\s{0,3}[-*]\s+/.test(lines[i] ?? "") &&
      !/^\s{0,3}\d+\.\s+/.test(lines[i] ?? "")
    ) {
      pLines.push((lines[i] ?? "").trim());
      i++;
    }
    if (pLines.length > 0) {
      nodes.push({ kind: "p", children: parseInlines(pLines.join(" ")) });
    }
  }

  return nodes;
}

export type RenderOptions = {
  /** Slug of the document being rendered: a bare `#anchor` link becomes `#/help/<slug>#anchor`, because a bare hash would be taken for a route. */
  slug?: string;
  /** Whether a handbook page with this slug exists; a `.md` link to anything else (docs outside the handbook) is shown as text, not as a dead link. */
  hasDoc?: (slug: string) => boolean;
};

const DOC_LINK = /(?:^|\/)([\p{L}\p{N}_-]+)\.md(?:#([^\s#]*))?$/u;

/** Where a markdown link may point. Only http(s) and mailto leave the app, in a new tab without opener; handbook pages and
 *  anchors stay inside the hash router. Everything else (javascript:, data:, vbscript:, protocol-relative, unknown relative
 *  paths) yields null: the link text is rendered, the target is dropped. */
export function resolveHref(raw: string, opts: RenderOptions = {}): { href: string; external: boolean } | null {
  // Browsers ignore tabs, newlines and other control characters inside a URL scheme ("java\tscript:"), so judge the cleaned form.
  const href = raw.replace(/[\u0000-\u0020\u007f-\u009f]+/g, "");
  if (href === "") return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (scheme !== undefined) return scheme === "http" || scheme === "https" || scheme === "mailto" ? { href, external: true } : null;
  if (href.startsWith("//") || href.startsWith("\\")) return null;
  if (href.startsWith("#/")) return { href, external: false };
  if (href.startsWith("#")) return { href: opts.slug ? `#/help/${opts.slug}${href}` : href, external: false };
  const md = DOC_LINK.exec(href);
  if (md?.[1] && (!opts.hasDoc || opts.hasDoc(md[1]))) return { href: `#/help/${md[1]}${md[2] ? `#${md[2]}` : ""}`, external: false };
  return null;
}

function renderInline(node: InlineNode, key: number | string, opts: RenderOptions): View {
  switch (node.kind) {
    case "text":
      return h("span", { key }, node.text);
    case "code":
      return h("code", { key }, node.text);
    case "strong":
      return h("strong", { key }, node.text);
    case "em":
      return h("em", { key }, node.text);
    case "link": {
      const target = resolveHref(node.href, opts);
      if (target === null) return h("span", { key }, node.text);
      return h("a", { key, href: target.href, ...(target.external ? { target: "_blank", rel: "noopener noreferrer" } : {}) }, node.text);
    }
  }
}

export function renderMarkdown(nodes: MarkdownNode[], opts: RenderOptions = {}): View {
  return h(
    "div",
    { class: "markdown-body" },
    nodes.map((node, idx) => {
      switch (node.kind) {
        case "h": {
          const tag = `h${Math.min(node.level + 1, 6)}`; // Offset so page h1 remains top
          return h(tag, { key: idx, id: node.id }, node.text);
        }
        case "p":
          return h("p", { key: idx }, node.children.map((c, i) => renderInline(c, i, opts)));
        case "codeblock":
          return h("pre", { key: idx, tabIndex: 0 }, h("code", { class: node.lang ? `language-${node.lang}` : undefined }, node.code));
        case "ul":
          return h("ul", { key: idx }, node.items.map((item, i) => h("li", { key: i }, item.map((c, ci) => renderInline(c, ci, opts)))));
        case "ol":
          return h("ol", { key: idx }, node.items.map((item, i) => h("li", { key: i }, item.map((c, ci) => renderInline(c, ci, opts)))));
        case "table":
          return h(
            "div",
            { key: idx, class: "table-wrap" },
            h(
              "table",
              {},
              h("thead", {}, h("tr", {}, node.headers.map((hdr, hi) => h("th", { key: hi }, hdr.map((c, ci) => renderInline(c, ci, opts)))))),
              h(
                "tbody",
                {},
                node.rows.map((row, ri) =>
                  h("tr", { key: ri }, row.map((cell, ci) => h("td", { key: ci }, cell.map((c, cii) => renderInline(c, cii, opts))))),
                ),
              ),
            ),
          );
      }
    }),
  );
}
