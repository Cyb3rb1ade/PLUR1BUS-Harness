// Defence in depth: the token is only ever interpolated into one URL inside api.ts, and every error is built from fixed
// text. This scrubber is the second line: it removes the exact token and anything shaped like a bot token or a bot URL.

const TOKEN_SHAPE = /\b\d{5,}:[A-Za-z0-9_-]{20,}/g;
const BOT_URL = /\/bot[^/\s"']+\//g;

export function redactString(s: string, token?: string): string {
  let out = s;
  if (token) out = out.split(token).join("[redacted]");
  return out.replace(BOT_URL, "/bot[redacted]/").replace(TOKEN_SHAPE, "[redacted]");
}

export function redactAttrs(
  attrs: Readonly<Record<string, string | number | boolean>>,
  token?: string,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) out[k] = typeof v === "string" ? redactString(v, token) : v;
  return out;
}
