export const REDACTED = "[redacted]";
const SECRET_KEY = /token|cookie|authorization|secret|password|passwd|csrf|session|credential|api[-_]?key|otp|backup|challenge|bearer|passphrase/i;
/** A field named `code` or `...Code` holds a one-time code (second factor, backup, pairing) unless its value is plainly an
 *  error identifier such as `HPE_HEADER_OVERFLOW`, which the logs do carry. */
const CODE_KEY = /(?:^|[-_.])code$|[a-z]Code$/;
const ERROR_ID = /^[A-Z][A-Z0-9_]{2,63}$/;
const isSecretField = (key: string, value: unknown): boolean => SECRET_KEY.test(key) || (CODE_KEY.test(key) && typeof value === "string" && !ERROR_ID.test(value));

/** Defence in depth for the logger: whatever a call site passes, a field whose *name* says it holds a credential is
 *  replaced, recursively. The call sites already log only ids, routes and statuses; this is the net under them. */
export function redactFields(v: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (Array.isArray(v)) return v.map((x) => redactFields(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = isSecretField(k, x) ? REDACTED : redactFields(x, depth + 1);
    return out;
  }
  return v;
}
