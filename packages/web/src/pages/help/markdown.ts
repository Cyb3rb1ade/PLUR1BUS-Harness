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

function parseInlines(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = 0;
  while (i < text.length) {
    // Inline code `...`
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        nodes.push({ kind: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Markdown link [text](url)
    if (text[i] === "[") {
      const closeB = text.indexOf("]", i + 1);
      if (closeB > i && text[closeB + 1] === "(") {
        const closeP = text.indexOf(")", closeB + 2);
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
      const end = text.indexOf("**", i + 2);
      if (end > i) {
        nodes.push({ kind: "strong", text: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }

    // Em *text*
    if (text[i] === "*" && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i) {
        nodes.push({ kind: "em", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Plain text up to next special char
    let nextSpecial = text.length;
    for (const spec of ["`", "[", "*"]) {
      const pos = text.indexOf(spec, i);
      if (pos >= 0 && pos < nextSpecial) {
        nextSpecial = pos;
      }
    }
    const plain = text.slice(i, nextSpecial);
    if (plain) {
      nodes.push({ kind: "text", text: plain });
    }
    i = nextSpecial === i ? i + 1 : nextSpecial;
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

export function parseMarkdown(markdown: string): MarkdownNode[] {
  const lines = markdown.split(/\r?\n/);
  const nodes: MarkdownNode[] = [];
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
      nodes.push({ kind: "h", level, text, id: slugify(text) });
      i++;
      continue;
    }

    // Setext headings (e.g. === or ---)
    const nextLine = lines[i + 1] ?? "";
    if (i + 1 < lines.length && /^\s*(=+|-+)\s*$/.test(nextLine) && line.trim()) {
      const level = nextLine.trim().startsWith("=") ? 1 : 2;
      const text = line.trim();
      nodes.push({ kind: "h", level, text, id: slugify(text) });
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

function renderInline(node: InlineNode, key: number | string): View {
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
      // Safe link handling: sanitize href
      let href = node.href;
      // Transform relative doc links like quickstart.md or ../en/operations.md to #/help/<slug>
      const mdMatch = href.match(/(?:^|\/)([a-zA-Z0-9_-]+)\.md(?:#([a-zA-Z0-9_-]+))?$/);
      if (mdMatch) {
        const slug = mdMatch[1];
        const hash = mdMatch[2] ? `#${mdMatch[2]}` : "";
        href = `#/help/${slug}${hash}`;
        return h("a", { key, href }, node.text);
      }
      // If external link, open in system browser with rel="noopener noreferrer"
      if (/^https?:\/\//i.test(href)) {
        return h("a", { key, href, target: "_blank", rel: "noopener noreferrer" }, node.text);
      }
      // Internal or hash
      return h("a", { key, href }, node.text);
    }
  }
}

export function renderMarkdown(nodes: MarkdownNode[]): View {
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
          return h("p", { key: idx }, node.children.map((c, i) => renderInline(c, i)));
        case "codeblock":
          return h("pre", { key: idx }, h("code", { class: node.lang ? `language-${node.lang}` : undefined }, node.code));
        case "ul":
          return h("ul", { key: idx }, node.items.map((item, i) => h("li", { key: i }, item.map((c, ci) => renderInline(c, ci)))));
        case "ol":
          return h("ol", { key: idx }, node.items.map((item, i) => h("li", { key: i }, item.map((c, ci) => renderInline(c, ci)))));
        case "table":
          return h(
            "div",
            { key: idx, class: "table-wrap" },
            h(
              "table",
              {},
              h("thead", {}, h("tr", {}, node.headers.map((hdr, hi) => h("th", { key: hi }, hdr.map((c, ci) => renderInline(c, ci)))))),
              h(
                "tbody",
                {},
                node.rows.map((row, ri) =>
                  h("tr", { key: ri }, row.map((cell, ci) => h("td", { key: ci }, cell.map((c, cii) => renderInline(c, cii))))),
                ),
              ),
            ),
          );
      }
    }),
  );
}
