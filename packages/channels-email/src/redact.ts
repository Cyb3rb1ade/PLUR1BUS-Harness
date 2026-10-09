// Defence in depth: passwords only ever travel inside imap.ts/smtp.ts and every error there is built from fixed text.
// This scrubber is the second line: it removes exact secret values and anything shaped like a credential exchange.

const AUTH_LINE = /\b(AUTH(?:ENTICATE)?\s+(?:PLAIN|LOGIN)|LOGIN)\s+\S+(\s+\S+)?/gi;
const BASE64_BLOB = /\b[A-Za-z0-9+/]{40,}={0,2}/g;

export function redactString(s: string, secrets: readonly string[] = []): string {
  let out = s;
  for (const secret of secrets) if (secret.length >= 3) out = out.split(secret).join("[redacted]");
  return out.replace(AUTH_LINE, "$1 [redacted]").replace(BASE64_BLOB, "[redacted]");
}

export function redactAttrs(
  attrs: Readonly<Record<string, string | number | boolean>>,
  secrets: readonly string[] = [],
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) out[k] = typeof v === "string" ? redactString(v, secrets) : v;
  return out;
}
