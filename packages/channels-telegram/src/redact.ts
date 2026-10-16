// Defence in depth: the token is only ever interpolated into one URL inside api.ts, and every error is built from fixed
// text. This scrubber is the second line: it removes the exact token and anything shaped like a bot token or a bot URL.

const TOKEN_SHAPE = /\b\d{5,}:[A-Za-z0-9_-]{20,}/g;
const BOT_URL = /\/bot[^/\s"']+\//g;

/** Everything that must never be echoed: each credential, the part of a bot token after the bot id, and the
 *  percent-encoded forms (upper and lower case hex) of all of them. Longest first so a whole token wins over its parts. */
export function secretForms(secrets: string | readonly (string | undefined)[] | undefined): string[] {
  const list = typeof secrets === "string" ? [secrets] : (secrets ?? []);
  const forms = new Set<string>();
  for (const secret of list) {
    if (!secret) continue;
    const bases = [secret];
    const colon = secret.indexOf(":");
    if (colon > 0 && colon < secret.length - 1) bases.push(secret.slice(colon + 1));
    for (const b of bases) {
      forms.add(b);
      const enc = encodeURIComponent(b);
      if (enc !== b) {
        forms.add(enc);
        forms.add(enc.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
      }
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

export function redactString(s: string, secrets?: string | readonly (string | undefined)[]): string {
  let out = s;
  for (const form of secretForms(secrets)) out = out.split(form).join("[redacted]");
  return out.replace(BOT_URL, "/bot[redacted]/").replace(TOKEN_SHAPE, "[redacted]");
}

export function redactAttrs(
  attrs: Readonly<Record<string, string | number | boolean>>,
  secrets?: string | readonly (string | undefined)[],
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) out[k] = typeof v === "string" ? redactString(v, secrets) : v;
  return out;
}
