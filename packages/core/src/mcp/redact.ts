// ADR-014 §7: exact-value redaction of declared secrets from stderr, errors, results and log fields. A backstop,
// not a licence to log a server's output; D111's writer-side redaction applies on top.
export const REDACTED = "[REDACTED]";

/** Variable and header names whose values are treated as secret. */
const SENSITIVE_NAME = /token|secret|key|passw|credential|auth|cookie|bearer|session/i;
export const isSensitiveName = (name: string): boolean => SENSITIVE_NAME.test(name);

// RULING: values shorter than this are not redacted (a 1-3 character "secret" would shred every log line).
const MIN_SECRET_LENGTH = 4;

export interface Redactor {
  add(value: string, force?: boolean): void;
  redact(text: string): string;
  /** True when `redact(text)` would change `text`. */
  contains(text: string): boolean;
  readonly size: number;
}

export function createRedactor(initial: Iterable<string> = []): Redactor {
  const values = new Set<string>();
  let ordered: string[] = [];
  const add = (v: string, force = false): void => {
    if (typeof v !== "string" || v.length < (force ? 1 : MIN_SECRET_LENGTH)) return;
    for (const form of new Set([v, encodeURIComponent(v)])) {
      if (form.length >= (force ? 1 : MIN_SECRET_LENGTH)) values.add(form);
    }
    ordered = [...values].sort((a, b) => b.length - a.length); // longest first: a secret containing another is removed whole
  };
  for (const v of initial) add(v);
  return {
    add,
    redact(text) {
      let out = text;
      for (const v of ordered) if (out.includes(v)) out = out.split(v).join(REDACTED);
      return out;
    },
    contains(text) { return ordered.some((v) => text.includes(v)); },
    get size() { return values.size; },
  };
}
