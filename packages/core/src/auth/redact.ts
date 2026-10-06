const REDACTED = "[redacted]";

/** Replace every known secret value, and anything shaped like a bearer credential, in a string headed for a log or an
 *  error. The engine's own messages never contain a token; this is the last line for text that crossed a port. */
export function scrub(text: string, secrets: Iterable<string> = []): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join(REDACTED);
  return out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`);
}

/** Log fields: strings are scrubbed, everything else passes. Callers pass ids and codes only. */
export function safeFields(fields: Record<string, string | number | boolean | null | undefined>, secrets: Iterable<string> = []) {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = typeof v === "string" ? scrub(v, secrets) : v;
  return out;
}
