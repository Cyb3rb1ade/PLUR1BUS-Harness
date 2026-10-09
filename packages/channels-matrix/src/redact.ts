// Defence in depth: the access token only ever travels in an Authorization header inside api.ts and every error is built
// from fixed text. This scrubber is the second line: it removes the exact token and anything shaped like a credential.

const BEARER = /\bBearer\s+[^\s"']+/gi;
const QUERY_TOKEN = /([?&]access_token=)[^&\s"']+/gi;
const TOKEN_SHAPE = /\b(?:syt|mat|mct|mar|mcr)_[A-Za-z0-9_-]{8,}/g;

export function redactString(s: string, token?: string): string {
  let out = s;
  if (token) out = out.split(token).join("[redacted]");
  return out.replace(BEARER, "Bearer [redacted]").replace(QUERY_TOKEN, "$1[redacted]").replace(TOKEN_SHAPE, "[redacted]");
}

export function redactAttrs(
  attrs: Readonly<Record<string, string | number | boolean>>,
  token?: string,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) out[k] = typeof v === "string" ? redactString(v, token) : v;
  return out;
}
