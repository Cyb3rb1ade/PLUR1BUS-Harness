// A small, dependency-free Markdown renderer for document content. It is deliberately conservative:
// - every character of the source is HTML-escaped BEFORE any inline decoration is applied, so agent content is always
//   data, never markup (a `<script>` in the source becomes the literal text `&lt;script&gt;`, never an element);
// - the only URLs it emits are `http:`/`https:` (rendered with `rel="noopener noreferrer"`) and in-page `#fragment`
//   anchors — never `javascript:`, `data:` with active content, or `file:`; and it emits no `src`, `style` or event
//   attributes. This is the first line of defence for "no script from the content, no external resource loading"
//   (D100 §2 rendering); `sanitizeHtml` is the second, applied to the assembled document.

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const SAFE_URL = /^https?:\/\//i;

function safeHref(url: string): string | null {
  const u = url.trim();
  if (SAFE_URL.test(u)) return u;
  if (/^#[A-Za-z][A-Za-z0-9:_-]*$/.test(u)) return u;
  return null;
}

/** Inline: `code`, **strong**, *emphasis*, [text](http…), [text](#frag). Runs on already-escaped text. */
function inline(escaped: string): string {
  let out = escaped;
  // Links first (their label may contain emphasis).
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const href = safeHref(url);
    if (href === null) return label;
    return `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${label}</a>`;
  });
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, s: string) => `<strong>${s}</strong>`);
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, (_m, pre: string, s: string) => `${pre}<em>${s}</em>`);
  return out;
}

/** Render a Markdown document to safe HTML fragments (no outer wrapper). */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  let code: string[] = [];
  let inCode = false;

  const flushPara = (): void => {
    if (para.length === 0) return;
    html.push(`<p>${inline(escapeHtml(para.join(" ")))}</p>`);
    para = [];
  };
  const closeList = (): void => {
    if (list) html.push(`</${list}>`);
    list = null;
  };

  for (const raw of lines) {
    if (inCode) {
      if (/^\s*```/.test(raw)) {
        html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        code.push(raw);
      }
      continue;
    }
    if (/^\s*```/.test(raw)) {
      flushPara();
      closeList();
      inCode = true;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      flushPara();
      closeList();
      const level = h[1]!.length;
      html.push(`<h${level}>${inline(escapeHtml(h[2]!.trim()))}</h${level}>`);
      continue;
    }
    const hr = /^\s*(?:---+|\*\*\*+)\s*$/.exec(raw);
    if (hr) {
      flushPara();
      closeList();
      html.push("<hr>");
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (ul) {
      flushPara();
      if (list !== "ul") {
        closeList();
        html.push("<ul>");
        list = "ul";
      }
      html.push(`<li>${inline(escapeHtml(ul[1]!.trim()))}</li>`);
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
    if (ol) {
      flushPara();
      if (list !== "ol") {
        closeList();
        html.push("<ol>");
        list = "ol";
      }
      html.push(`<li>${inline(escapeHtml(ol[1]!.trim()))}</li>`);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      flushPara();
      closeList();
      html.push(`<blockquote>${inline(escapeHtml(quote[1]!.trim()))}</blockquote>`);
      continue;
    }
    if (raw.trim() === "") {
      flushPara();
      closeList();
      continue;
    }
    para.push(raw.trim());
  }
  flushPara();
  closeList();
  if (inCode) {
    html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  }
  return html.join("\n");
}
