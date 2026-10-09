// Defence in depth. Tokens only ever travel in an Authorization header (api.ts) and the Socket Mode URL only inside
// SlackApi/channel; every error is built from fixed text. This scrubber is the second line.

const BOT_OR_USER_TOKEN = /\bxox[a-z]-[A-Za-z0-9-]{4,}/g;
const APP_TOKEN = /\bxapp-[A-Za-z0-9-]{4,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SOCKET_URL = /wss?:\/\/[^\s"'<>]+/gi;
const UPLOAD_URL = /(https?:\/\/[^/\s"']+)\/upload\/v1\/[^\s"'<>]+/gi;
const TICKET = /([?&](?:ticket|token)=)[^&\s"'<>]+/gi;

export function redactString(s: string, ...secrets: (string | undefined)[]): string {
  let out = s;
  for (const secret of secrets) if (secret) out = out.split(secret).join("[redacted]");
  return out
    .replace(SOCKET_URL, "wss://[redacted]")
    .replace(UPLOAD_URL, "$1/upload/v1/[redacted]")
    .replace(TICKET, "$1[redacted]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(APP_TOKEN, "[redacted]")
    .replace(BOT_OR_USER_TOKEN, "[redacted]");
}

export function redactAttrs(
  attrs: Readonly<Record<string, string | number | boolean>>,
  ...secrets: (string | undefined)[]
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) out[k] = typeof v === "string" ? redactString(v, ...secrets) : v;
  return out;
}
