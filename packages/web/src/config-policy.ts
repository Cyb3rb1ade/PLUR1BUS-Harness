// Browser configuration disclosure policy from generated schema metadata. No Node or validator dependencies.
import { CONFIG_POLICY, REFERENCE_POLICY } from "./palette/settings-index.ts";
import { maskUrlCredentials } from "../../config-schema/src/url-credentials.ts";
import { looksLikePastedKey, matchesReference } from "../../config-schema/src/secret-reference.ts";

export interface ConfigPolicy {
  sensitive: boolean;
  urlCredentials: boolean;
  referenceSchema?: unknown;
}

const pathParts = (key: string): string[] => key.replace(/\[\d*\]/g, ".*").split(".").filter(Boolean);
const DECLARATIONS = CONFIG_POLICY.map((row) => ({ ...row, parts: pathParts(row.key) }));
const matches = (pattern: readonly string[], parts: readonly string[]): boolean =>
  pattern.length <= parts.length && pattern.every((part, index) => part === "*" || parts[index] === "*" || part === parts[index]);

/** Resolve property, map and array policies; a marked container also protects every descendant. */
export function configPolicyOf(key: string): ConfigPolicy {
  return policyForParts(pathParts(key));
}

function policyForParts(parts: readonly string[]): ConfigPolicy {
  const policy: ConfigPolicy = { sensitive: false, urlCredentials: false };
  for (const row of DECLARATIONS) {
    if (!matches(row.parts, parts)) continue;
    policy.sensitive ||= row.sensitive === true ||
      (row.referenceSchema !== undefined && row.parts.length < parts.length && row.urlCredentials !== true);
    policy.urlCredentials ||= row.urlCredentials === true;
    if (row.parts.length === parts.length && row.referenceSchema !== undefined) policy.referenceSchema = row.referenceSchema;
  }
  return policy;
}

/** Only a complete value at its declared reference node can establish a readable reference name. */
export function isConfigReference(value: unknown, key: string): boolean {
  return matchesReference(value, configPolicyOf(key).referenceSchema, REFERENCE_POLICY);
}

/** A value-free hint for token-looking candidates at declared reference fields, including opaque parent views. */
export function configHasPastedKey(value: unknown, key = ""): boolean {
  return pastedKeyAt(value, pathParts(key));
}

function pastedKeyAt(value: unknown, parts: readonly string[]): boolean {
  const { referenceSchema } = policyForParts(parts);
  if (referenceSchema !== undefined)
    return !matchesReference(value, referenceSchema, REFERENCE_POLICY) && looksLikePastedKey(value, REFERENCE_POLICY);
  if (Array.isArray(value)) return value.some((child, index) => pastedKeyAt(child, [...parts, String(index)]));
  return !!value && typeof value === "object" && Object.entries(value)
    .some(([name, child]) => pastedKeyAt(child, [...parts, name]));
}

/** A parent editor must also replace explicitly when any nested field can contain a hidden value. */
export function configContainsCredentials(key: string): boolean {
  const parts = pathParts(key);
  return DECLARATIONS.some(row => (row.sensitive === true || row.urlCredentials === true || row.referenceSchema !== undefined) &&
    (matches(row.parts, parts) || matches(parts, row.parts)));
}

/** Mask configuration for JSON/current/diff cells with its full root prefix and original JSON structure. */
export function redactConfigView(value: unknown, key = ""): unknown {
  return project(value, pathParts(key));
}

function project(value: unknown, parts: readonly string[]): unknown {
  const policy = policyForParts(parts);
  if (matchesReference(value, policy.referenceSchema, REFERENCE_POLICY)) return value;
  const literal = policy.sensitive || (policy.referenceSchema !== undefined && !policy.urlCredentials);
  if (typeof value === "string") {
    if (literal) return value ? "••••" : "";
    return policy.urlCredentials ? maskUrlCredentials(value) : value;
  }
  if (literal && typeof value === "number") return 0;
  if (literal && typeof value === "boolean") return false;
  if (Array.isArray(value)) return value.map((child, index) => project(child, [...parts, String(index)]));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .map(([name, child]) => [name, project(child, [...parts, name])]));
  }
  return value;
}
