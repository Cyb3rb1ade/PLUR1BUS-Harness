const MAX_HTML = 1024 * 1024;

const NAMED: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", euro: "€", pound: "£", yen: "¥", bull: "•", middot: "·", laquo: "«",
  raquo: "»", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", eacute: "é", egrave: "è",
  agrave: "à", aacute: "á", ccedil: "ç", ntilde: "ñ", times: "×", deg: "°", trade: "™", sect: "§", para: "¶",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 1 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "";
      return String.fromCodePoint(cp);
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
}

const BLOCK = "address|article|aside|blockquote|body|dd|details|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|main|nav|ol|p|pre|section|table|tbody|thead|tfoot|tr|ul|center";

/** Small, dependency-free HTML to text. Not a renderer: scripts, styles and comments vanish, blocks become line breaks,
 *  links become "text (url)" (http, https, mailto only), entities are decoded. Linear-time regexes only. */
export function htmlToText(input: string): string {
  let s = input.length > MAX_HTML ? input.slice(0, MAX_HTML) : input;
  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  s = s.replace(/<(script|style|head|title|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const url = decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
    const label = decodeEntities(inner.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (!/^(https?:|mailto:)/i.test(url)) return label;
    const bare = url.replace(/^mailto:/i, "");
    if (!label || label === url || label === bare) return bare === url || /^mailto:/i.test(url) ? bare : url;
    return `${label} (${url})`;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, "gi"), "\n");
  s = s.replace(/<\/(?:td|th)\s*>/gi, "\t");
  s = s.replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}
