// Defence in depth: the token only ever travels in the Authorization header and the gateway identify frame, and every error is
// built from fixed text. This scrubber is the second line: exact token, anything shaped like a bot token, and URL path secrets
// (interaction and webhook tokens are credentials that live in URLs).

const TOKEN_SHAPE = /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g;
const INTERACTION_URL = /(\/interactions\/\d+\/)[^/\s"']+/g;
const WEBHOOK_URL = /(\/webhooks\/\d+\/)[^/\s"']+/g;
const BOT_AUTH = /\bBot\s+[^\s"']+/g;

export function redactString(s: string, token?: string): string {
  let out = s;
  if (token) out = out.split(token).join("[redacted]");
  return out
    .replace(INTERACTION_URL, "$1[redacted]")
    .replace(WEBHOOK_URL, "$1[redacted]")
    .replace(BOT_AUTH, "Bot [redacted]")
    .replace(TOKEN_SHAPE, "[redacted]");
}

export function redactAttrs(
  attrs: Readonly<Record<string, string | number | boolean>>,
  token?: string,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) out[k] = typeof v === "string" ? redactString(v, token) : v;
  return out;
}
