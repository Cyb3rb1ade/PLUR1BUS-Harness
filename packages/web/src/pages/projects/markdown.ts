// Safe Markdown renderer for Preact: generates VNodes directly with h(),
// never uses innerHTML, strips or escapes all HTML tags, enforces safe link protocols.
import { h, type ComponentChildren } from "preact";
import type { View } from "../../view.ts";

/** Where a link may point: http(s), mailto and in-page anchors. Everything else (javascript:, data:, vbscript:, ...) is never an href. */
export function isSafeUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  return (
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("#")
  );
}

/** Parses inline markdown: code, bold, italic, links, plain text. */
export function renderInline(text: string): ComponentChildren[] {
  const result: ComponentChildren[] = [];
  let remaining = text;

  // Regex to match inline tokens:
  // 1: code `...`
  // 2: bold **...**
  // 3: italic *...*
  // 4: link [label](url)
  const tokenRegex = /(`([^`]+)`)|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]*)\)/;

  while (remaining.length > 0) {
    const match = tokenRegex.exec(remaining);
    if (!match) {
      result.push(remaining);
      break;
    }

    const index = match.index;
    if (index > 0) {
      result.push(remaining.slice(0, index));
    }

    if (match[1] !== undefined) {
      // Inline code
      result.push(h("code", { class: "inline-code" }, match[2]));
    } else if (match[3] !== undefined) {
      // Bold
      result.push(h("strong", {}, renderInline(match[3])));
    } else if (match[4] !== undefined) {
      // Italic
      result.push(h("em", {}, renderInline(match[4])));
    } else if (match[5] !== undefined && match[6] !== undefined) {
      // Link
      const label = match[5];
      const url = match[6];
      if (isSafeUrl(url)) {
        result.push(
          h(
            "a",
            {
              href: url,
              target: "_blank",
              rel: "noopener noreferrer",
              class: "markdown-link",
            },
            label,
          ),
        );
      } else {
        result.push(label);
      }
    }

    remaining = remaining.slice(index + match[0].length);
  }

  return result;
}

/** Renders markdown content into safe VNode tree. */
export function SafeMarkdown({
  content,
  fallback = "",
}: {
  content?: string | null;
  fallback?: string;
}): View {
  if (!content || !content.trim()) {
    return h("p", { class: "markdown-empty" }, fallback);
  }

  const rawBlocks = content.split(/\n\s*\n/);
  const elements: View[] = [];

  for (let i = 0; i < rawBlocks.length; i++) {
    const block = rawBlocks[i]!.trim();
    if (!block) continue;

    // Fenced code block
    if (block.startsWith("```")) {
      const firstLineEnd = block.indexOf("\n");
      let codeText = "";
      if (firstLineEnd !== -1) {
        const lastLineStart = block.lastIndexOf("```");
        codeText = block.slice(
          firstLineEnd + 1,
          lastLineStart > firstLineEnd ? lastLineStart : undefined,
        );
      } else {
        codeText = block.slice(3).replace(/```$/, "");
      }
      elements.push(
        h(
          "pre",
          { key: `block-${i}`, class: "markdown-pre" },
          h("code", {}, codeText.trim()),
        ),
      );
      continue;
    }

    // Headings
    if (block.startsWith("### ")) {
      elements.push(
        h("h4", { key: `block-${i}` }, renderInline(block.slice(4))),
      );
      continue;
    }
    if (block.startsWith("## ")) {
      elements.push(
        h("h3", { key: `block-${i}` }, renderInline(block.slice(3))),
      );
      continue;
    }
    if (block.startsWith("# ")) {
      elements.push(
        h("h2", { key: `block-${i}` }, renderInline(block.slice(2))),
      );
      continue;
    }

    // Blockquote
    if (block.startsWith("> ")) {
      const quoteText = block
        .split("\n")
        .map((l) => l.replace(/^>\s?/, ""))
        .join("\n");
      elements.push(
        h(
          "blockquote",
          { key: `block-${i}` },
          renderInline(quoteText),
        ),
      );
      continue;
    }

    // Unordered List
    if (/^[-*]\s/.test(block)) {
      const items = block
        .split("\n")
        .filter((l) => /^[-*]\s/.test(l.trim()))
        .map((l) => l.trim().replace(/^[-*]\s+/, ""));
      elements.push(
        h(
          "ul",
          { key: `block-${i}` },
          items.map((item, j) => h("li", { key: `li-${j}` }, renderInline(item))),
        ),
      );
      continue;
    }

    // Ordered List
    if (/^\d+\.\s/.test(block)) {
      const items = block
        .split("\n")
        .filter((l) => /^\d+\.\s/.test(l.trim()))
        .map((l) => l.trim().replace(/^\d+\.\s+/, ""));
      elements.push(
        h(
          "ol",
          { key: `block-${i}` },
          items.map((item, j) => h("li", { key: `li-${j}` }, renderInline(item))),
        ),
      );
      continue;
    }

    // Paragraph
    const lines = block.split("\n");
    const inlineChildren: ComponentChildren[] = [];
    for (let l = 0; l < lines.length; l++) {
      if (l > 0) inlineChildren.push(h("br", {}));
      inlineChildren.push(...renderInline(lines[l]!));
    }
    elements.push(h("p", { key: `block-${i}` }, inlineChildren));
  }

  return h("div", { class: "markdown-body" }, elements);
}
