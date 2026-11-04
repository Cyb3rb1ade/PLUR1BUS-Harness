// Browser configuration disclosure consumes the shared structural policy; targets of secret references are never read.
import {
  configPolicyAt, containsConfigCredentials, looksLikePastedKey, maskUrlCredentials, matchesReference,
  redactWithPolicy, referenceSchema, valuePolicy, visitConfigPolicy,
  type ConfigPolicy as SharedConfigPolicy, type ConfigSchemaNode,
} from "@plur1bus/config-schema/policy";
import { CONFIG_POLICY_SCHEMA } from "./palette/settings-index.ts";

/** Structured segments preserve literal dotted members; strings retain the Settings dotted-key convention. */
export type ConfigPath = string | readonly string[];
/** Shared classification plus the resolved, local reference form used by browser controls. */
export interface ConfigPolicy extends SharedConfigPolicy {
  referenceSchema?: ConfigSchemaNode;
}
/** A value-free hint distinguishes malformed references from token-looking pasted values. */
export type ConfigReferenceWarning = "pastedKey" | "invalidReference";

const pathParts = (key: ConfigPath): readonly string[] => typeof key === "string"
  ? key.replace(/\[\d*\]/g, ".*").split(".").filter(Boolean) : key;
const CREDENTIAL_LEAF = /key|token|secret|passw|pwd|passphrase|credential|authori[sz]ation|bearer|cookie|private|signature|jwt|hmac|^auth$/i;
const URL_START = /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i;

function referenceForm(node: ConfigSchemaNode, schema: ConfigSchemaNode): ConfigSchemaNode | undefined {
  try { return referenceSchema(node, schema); }
  catch { return undefined; }
}

function referenceMatches(value: unknown, node: ConfigSchemaNode, schema: ConfigSchemaNode): boolean {
  const form = referenceForm(node, schema);
  const names = CONFIG_POLICY_SCHEMA["x-secret-reference-policy"];
  return form !== undefined && names !== undefined && matchesReference(value, form, names);
}

function credentialLeaf(policy: SharedConfigPolicy, parts: readonly string[], parent?: ConfigSchemaNode): boolean {
  if (policy.node["x-sensitive"] === false || policy.unknownMembers === "public" ||
    policy.node["x-secret-reference"]) return false;
  // Typed public dictionaries describe their values. A dictionary member's spelling cannot override that declaration.
  if (parent?.additionalProperties && typeof parent.additionalProperties === "object" &&
    !Object.hasOwn(parent.properties ?? {}, parts.at(-1) ?? "")) return false;
  const types = Array.isArray(policy.node.type) ? policy.node.type : [policy.node.type];
  return (policy.node.type === undefined || types.includes("string")) && CREDENTIAL_LEAF.test(parts.at(-1) ?? "");
}

/** Resolve widgets through the same structured policy as projections, including map values and array items. */
export function configPolicyOf(key: ConfigPath, schema: ConfigSchemaNode = CONFIG_POLICY_SCHEMA): ConfigPolicy {
  const parts = pathParts(key);
  const policy = configPolicyAt(schema, parts);
  const widget = valuePolicy(policy.node, policy);
  const parent = parts.length ? configPolicyAt(schema, parts.slice(0, -1)).node : undefined;
  const form = referenceForm(policy.node, schema);
  return {
    ...widget, sensitive: widget.sensitive || credentialLeaf(policy, parts, parent),
    ...(form ? { referenceSchema: form } : {}),
  };
}

/** Only a complete value at its declared node can establish a readable reference. */
export function isConfigReference(value: unknown, key: ConfigPath, schema: ConfigSchemaNode = CONFIG_POLICY_SCHEMA): boolean {
  return referenceMatches(value, configPolicyAt(schema, pathParts(key)).node, schema);
}

/** Find invalid references in opaque parent views without including the rejected value in a warning. */
export function configReferenceWarning(
  value: unknown, key: ConfigPath = "", schema: ConfigSchemaNode = CONFIG_POLICY_SCHEMA,
): ConfigReferenceWarning | undefined {
  let warning: ConfigReferenceWarning | undefined;
  const names = CONFIG_POLICY_SCHEMA["x-secret-reference-policy"];
  visitConfigPolicy(value, schema, pathParts(key), (at, { node }) => {
    if (!node["x-secret-reference"]) return;
    if (at === undefined || at === null || at === "" || referenceMatches(at, node, schema)) return false;
    warning = names && looksLikePastedKey(at, names) ? "pastedKey" : warning ?? "invalidReference";
    return false;
  });
  return warning;
}

/** Token-looking invalid references retain the existing pasted-key hint. */
export function configHasPastedKey(value: unknown, key: ConfigPath = ""): boolean {
  return configReferenceWarning(value, key) === "pastedKey";
}

/** Parent editors also require replacement when an open or classified descendant may contain private strings. */
export function configContainsCredentials(key: ConfigPath): boolean {
  return configPolicyOf(key).sensitive || containsConfigCredentials(CONFIG_POLICY_SCHEMA, pathParts(key));
}

/** URL syntax is a backstop for public strings, preserving the shared host/path projection. */
export function maskConfigUrl(value: string, classified = false): string {
  const normalized = value.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "");
  return classified || URL_START.test(normalized) ? maskUrlCredentials(value) : value;
}

/** Project current and diff cells with shared policy, then apply browser credential-name and URL backstops. */
export function redactConfigView(
  value: unknown, key: ConfigPath = "", schema: ConfigSchemaNode = CONFIG_POLICY_SCHEMA,
): unknown {
  const prefix = pathParts(key);
  const prefixParent = prefix.length ? configPolicyAt(schema, prefix.slice(0, -1)).node : undefined;
  let projected = redactWithPolicy(value, schema, prefix, (node, at) => referenceMatches(at, node, schema));
  visitConfigPolicy(projected, schema, prefix, (at, policy, parts, parent) => {
    if (policy.unknownMembers === "public" || referenceMatches(at, policy.node, schema)) return false;
    if (typeof at !== "string") return;
    const masked = credentialLeaf(policy, parts, parent ?? prefixParent) ? (at ? "••••" : "") : maskConfigUrl(at);
    if (masked === at) return;
    if (parts.length === prefix.length) projected = masked;
    else {
      let container = projected as Record<string, unknown>;
      for (const part of parts.slice(prefix.length, -1)) container = container[part] as Record<string, unknown>;
      container[parts.at(-1)!] = masked;
    }
  });
  return projected;
}

/** Keep untouched private values out of editable drafts, including URLs caught only by the content backstop. */
export function configNeedsReplacement(value: unknown, key: ConfigPath): boolean {
  const policy = configPolicyOf(key);
  if (!policy.declaredSensitive && !policy.referenceSchema && !policy.urlCredentials &&
    (typeof value === "number" || typeof value === "boolean")) return false;
  if (configContainsCredentials(key)) return true;
  return JSON.stringify(redactConfigView(value, key)) !== JSON.stringify(value);
}
