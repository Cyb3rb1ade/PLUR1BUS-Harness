// Immutable variants for one current secret set. Configured values and old generations never accumulate in a cache.
import { REDACTION } from "@plur1bus/log-schema";

const MIN_LENGTH = (REDACTION.rules.find((rule: { id: string }) => rule.id === "secret") as { minLength: number }).minLength;

function variants(value: string): string[] {
  const bytes = Buffer.from(value);
  // UTF-8 output replaces unmatched surrogates. Protect that representation without rejecting the original stored string.
  const utf8 = value.toWellFormed();
  const base64 = bytes.toString("base64"), url = bytes.toString("base64url"), hex = bytes.toString("hex");
  const json = JSON.stringify(value).slice(1, -1);
  return [value, utf8, base64, base64.replace(/=+$/, ""), url, url + "=".repeat((4 - url.length % 4) % 4),
    hex, hex.toUpperCase(), encodeURIComponent(utf8), json, json.replaceAll("/", "\\/")];
}

/** Exact registered values and canonical encodings, longest first; equivalent mixed JSON escapes are recognized separately. */
export function secretFormsIn(values: Iterable<string>): string[] {
  const forms = new Set<string>();
  for (const value of new Set(values)) {
    if (typeof value !== "string" || value.length < MIN_LENGTH) continue;
    for (const form of variants(value)) forms.add(form);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/** One generation, compared by membership rather than mutable iterable identity or ordering. */
export class SecretFormsCache {
  #values = new Set<string>();
  #forms: readonly string[] = Object.freeze([]);

  forms(values: Iterable<string>): readonly string[] {
    const next = new Set([...values].filter(value => typeof value === "string" && value.length >= MIN_LENGTH));
    if (next.size === this.#values.size && [...next].every(value => this.#values.has(value))) return this.#forms;
    const forms = Object.freeze(secretFormsIn(next)); // Publish neither membership nor variants if derivation fails.
    this.#values = next;
    this.#forms = forms;
    return forms;
  }
}
