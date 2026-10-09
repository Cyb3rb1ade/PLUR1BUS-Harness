/** Minimal CommonMark-like converter to a safe HTML subset: p, br, strong, em, code, pre, ul, ol, li, blockquote, a.
 *  Everything is escaped first; links only for http(s) and mailto; no images, no raw HTML, no headings (rendered as strong). */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+?)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, "$1<em>$2</em>");
}

/** Inline content. Code spans and links are held in slots so that emphasis and escaping cannot touch them. */
export function inlineHtml(src: string): string {
  const slots: string[] = [];
  const hold = (html: string): string => {
    slots.push(html);
    return `\u0000${slots.length - 1}\u0000`;
  };
  let t = src.replace(/`([^`\n]+)`/g, (_m, code: string) => hold(`<code>${escapeHtml(code)}</code>`));
  t = t.replace(/\[([^\]\n]{1,300})\]\(([^()\s"<>]{1,2000})\)/g, (m, label: string, url: string) => {
    if (!/^(https?:\/\/|mailto:)/i.test(url)) return m;
    return hold(`<a href="${escapeHtml(url)}">${emphasis(escapeHtml(label))}</a>`);
  });
  t = emphasis(escapeHtml(t));
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)]!);
}

function paragraph(lines: string[]): string {
  return `<p>${lines.map((l) => inlineHtml(l)).join("<br>\n")}</p>`;
}

function blocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const fence = /^\s*```/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence (or end of input)
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      out.push(`<p><strong>${inlineHtml(h[1]!.trim())}</strong></p>`);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) inner.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${blocks(inner)}</blockquote>`);
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d{1,9}[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const ordered = !ul;
      const items: string[] = [];
      const re = ordered ? /^\s*\d{1,9}[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      while (i < lines.length) {
        const m = re.exec(lines[i]!);
        if (!m) break;
        items.push(`<li>${inlineHtml(m[1]!)}</li>`);
        i++;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]!) &&
      !/^\s*(```|#{1,6}\s|>|[-*+]\s|\d{1,9}[.)]\s)/.test(lines[i]!)
    )
      para.push(lines[i++]!);
    if (para.length === 0) para.push(lines[i++]!);
    out.push(paragraph(para));
  }
  return out.join("\n");
}

export function markdownToHtml(md: string): string {
  return blocks(md.replace(/\r\n?/g, "\n").split("\n"));
}
