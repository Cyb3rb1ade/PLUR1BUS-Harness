// Second line of defence for the "no script, no external resources" rendering rule (D100 §2). `markdownToHtml` already
// escapes the agent's content, and the templates are trusted, authored HTML; this pass runs over the ASSEMBLED document
// and removes anything a template mistake or a future content path could have introduced:
//   - `<script>`, `<iframe>`, `<object>`, `<embed>`, `<link rel="stylesheet">` elements and their contents;
//   - `on*=` event-handler attributes and `style=` (style is template-owned, never content-owned);
//   - `src`/`href`/`poster`/`background` attributes that point at a network, `javascript:` or `file:` URL.
// It is a whitelist-by-stripping pass: it never invents markup, only removes dangerous parts.

const BLOCK_ELEMENTS = /<\s*(script|iframe|object|embed|link|meta|base)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>|<\s*(script|iframe|object|embed|link|meta|base)[^>]*\/?\s*>/gi;
const EVENT_ATTR = /\son[a-z]+\s*=\s*("(?:[^"]*)"|'(?:[^']*)'|[^\s>]+)/gi;
const STYLE_ATTR = /\sstyle\s*=\s*("(?:[^"]*)"|'(?:[^']*)'|[^\s>]+)/gi;
const UNSAFE_URL_ATTR = /\s(src|href|poster|background|xlink:href)\s*=\s*("(?:[^"]*)"|'(?:[^']*)'|[^\s>]+)/gi;

/** Whether an attribute value (already unquoted) is an off-document resource that rendering must never load. */
function unsafeUrl(raw: string): boolean {
  const v = raw.trim().replace(/^["']|["']$/g, "");
  if (/^\s*(javascript|data|file|vbscript):/i.test(v)) return true;
  if (/^\s*(https?:\/\/|\/\/|blob:|about:)/i.test(v)) return true;
  return false;
}

/** Strip scripts and off-document resources from an assembled HTML string. Returns the sanitised string. */
export function sanitizeHtml(html: string): string {
  let out = html.replace(BLOCK_ELEMENTS, "");
  out = out.replace(EVENT_ATTR, "");
  out = out.replace(STYLE_ATTR, "");
  out = out.replace(UNSAFE_URL_ATTR, (m, _attr: string, value: string) => (unsafeUrl(value) ? "" : m));
  return out;
}
