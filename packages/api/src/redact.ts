export const REDACTED = "[redacted]";
const SECRET_KEY = /token|cookie|authorization|secret|password|passwd|csrf|session|credential|api[-_]?key/i;

/** Defence in depth for the logger: whatever a call site passes, a field whose *name* says it holds a credential is
 *  replaced, recursively. The call sites already log only ids, routes and statuses; this is the net under them. */
export function redactFields(v: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (Array.isArray(v)) return v.map((x) => redactFields(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? REDACTED : redactFields(x, depth + 1);
    return out;
  }
  return v;
}
