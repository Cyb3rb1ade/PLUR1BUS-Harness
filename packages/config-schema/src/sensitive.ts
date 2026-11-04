// Schema-owned disclosure: structural policy is browser-safe; reference validation stays at the Node edge.
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import schemaJson from "../schema/config.schema.json" with { type: "json" };
import { credentialName, urlParts } from "./url-credentials.ts";
import { looksLikePastedKey, referenceSafety } from "./secret-reference.ts";
import {
  configPolicyAt, redactWithPolicy, referenceSchema, valuePolicy, visitConfigPolicy,
  type ConfigSchemaNode,
} from "./policy.ts";
export type { ConfigSchemaNode } from "./policy.ts";

export interface ConfigSecretEntry { key: string; value: string }
export interface ConfigWarning { key: string; message: string }
const SCHEMA = schemaJson as unknown as ConfigSchemaNode;
const WARNING_LIMIT = 50;
const REFERENCE_POLICY = SCHEMA["x-secret-reference-policy"]!;
// A reference-name length bound is not evidence that a long command argument or query value is a token.
const TEXT_POLICY = { ...REFERENCE_POLICY, maxNameLength: Number.POSITIVE_INFINITY };
const TEXT_TOKEN_PREFIX = new RegExp(`^(?:${REFERENCE_POLICY.tokenPrefixPattern})`, "i");
const ENDPOINT_PREFIX = /^(?:(?:https?|wss?|ftp):|[a-z][a-z0-9+.-]*:[\\/]+|[\\/]{2})/i;
const partsOf = (key: string | readonly string[]): readonly string[] => typeof key === "string"
  ? key.replace(/\[\d*\]/g, ".*").split(".").filter(Boolean) : key;
const hasReference = (node: ConfigSchemaNode): boolean =>
  node["x-secret-reference"] !== undefined && node["x-secret-reference"] !== false;

export const sensitiveOf = (key: string | readonly string[], schema: ConfigSchemaNode = SCHEMA): boolean => {
  const policy = configPolicyAt(schema, partsOf(key));
  return valuePolicy(policy.node, policy).sensitive;
};
export const urlCredentialsOf = (key: string | readonly string[], schema: ConfigSchemaNode = SCHEMA): boolean => {
  const policy = configPolicyAt(schema, partsOf(key));
  return valuePolicy(policy.node, policy).urlCredentials;
};

// Cache validators by immutable schema identity and definition, never by configured values.
const REFERENCE_VALIDATORS = new WeakMap<ConfigSchemaNode, Map<string, ValidateFunction>>();
function referenceMatches(node: ConfigSchemaNode, value: unknown, schema: ConfigSchemaNode): boolean {
  const definition = referenceSchema(node, schema);
  if (!definition) return false;
  const metadata = node["x-secret-reference"];
  const ref = typeof metadata === "object" ? metadata.$ref : undefined;
  const cacheKey = ref ?? JSON.stringify(node);
  let validators = REFERENCE_VALIDATORS.get(schema);
  if (!validators) { validators = new Map(); REFERENCE_VALIDATORS.set(schema, validators); }
  let validator = validators.get(cacheKey);
  if (!validator) {
    try {
      validator = new Ajv2020({ strict: false }).compile(ref
        ? { $ref: ref, $defs: schema.$defs } : { ...node, $defs: schema.$defs });
    } catch { throw new Error("Invalid config secret-reference metadata"); }
    validators.set(cacheKey, validator);
  }
  return validator(value) && referenceSafety(value, definition, REFERENCE_POLICY);
}

/** Reference classification never retrieves a target; structured paths preserve dotted member names. */
export function secretReferenceOf(
  key: string | readonly string[], value: unknown, schema: ConfigSchemaNode = SCHEMA,
): boolean { return referenceMatches(configPolicyAt(schema, partsOf(key)).node, value, schema); }

export interface ConfigRedactionOptions {
  schema?: ConfigSchemaNode;
  key?: string;
  path?: readonly string[];
}
/** Unknown strings are private; projection never changes the live configuration. */
export function redactConfig(value: unknown, options: ConfigRedactionOptions = {}): unknown {
  const schema = options.schema ?? SCHEMA;
  return redactWithPolicy(value, schema, options.path ?? partsOf(options.key ?? ""),
    (node, at) => referenceMatches(node, at, schema));
}

function textParts(value: unknown, named = false): string[] {
  const out = new Set<string>();
  const inspect = (text: string, credential = false, sourcePath = false): void => {
    // Hierarchical endpoints contribute selected parts; ordinary colon-bearing passwords remain literals.
    if (ENDPOINT_PREFIX.test(text)) {
      for (const part of urlParts(text, TEXT_POLICY).textValues) out.add(part);
      return;
    }
    const equal = text.indexOf("=");
    const left = equal < 0 ? "" : text.slice(0, equal);
    const right = equal < 0 ? "" : text.slice(equal + 1);
    if (!credential && equal >= 0 && (/^--?/.test(left) || credentialName(left) ||
      (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(left) && ENDPOINT_PREFIX.test(right)))) {
      const name = left.replace(/^-+/, "");
      inspect(right, credentialName(name), /(?:file|path|dir|directory|cwd|root)$/i.test(name));
      return;
    }
    const relativePath = /[\\/]/.test(text) && /(?:^|[\\/])[^\\/]*[._-][^\\/]*(?:[\\/]|$)/.test(text) &&
      !TEXT_TOKEN_PREFIX.test(text);
    const rootedPath = /^(?:[/\\]|\.{1,2}[/\\]|~[/\\]|[A-Za-z]:[/\\])/.test(text);
    const token = looksLikePastedKey(text, TEXT_POLICY);
    if ((sourcePath && (rootedPath || relativePath || !token)) ||
      (!credential && (rootedPath || relativePath)) || (!credential && /^--?[^=]+$/.test(text))) return;
    if ((credential && text) || token) out.add(text);
  };
  const visit = (at: unknown, credential = false, sourcePath = false): void => {
    if (typeof at === "string") { inspect(at, credential, sourcePath); return; }
    if (Array.isArray(at)) {
      let credentialArgument = false, pathArgument = false;
      for (const item of at) {
        const option = typeof item === "string" && /^--?[^=]+$/.test(item);
        visit(item, credential || (credentialArgument && !option), sourcePath || (pathArgument && !option));
        credentialArgument = option && credentialName(item.replace(/^-+/, ""));
        pathArgument = option && /(?:file|path|dir|directory|cwd|root)$/i.test(item);
      }
    } else if (at && typeof at === "object") {
      for (const [name, child] of Object.entries(at))
        visit(child, credential || credentialName(name), sourcePath || /(?:file|path|dir|directory|cwd|root)$/i.test(name));
    }
  };
  visit(value, named);
  return [...out];
}

/** Internal inventory includes references; text sinks must use configTextSecretEntries. */
export function configSecretEntries(value: unknown, schema: ConfigSchemaNode = SCHEMA): ConfigSecretEntry[] {
  return collectEntries(value, schema, false);
}
export function configTextSecretEntries(value: unknown, schema: ConfigSchemaNode = SCHEMA): ConfigSecretEntry[] {
  return collectEntries(value, schema, true);
}
function collectEntries(value: unknown, schema: ConfigSchemaNode, text: boolean): ConfigSecretEntry[] {
  const out: ConfigSecretEntry[] = [];
  visitConfigPolicy(value, schema, [], (at, policy, parts) => {
    const key = parts.join(".");
    if (text) {
      try { if (!policy.urlCredentials && referenceMatches(policy.node, at, schema)) return false; }
      catch { /* Invalid policy cannot make a configured literal public. */ }
      if (policy.textCredentials === "parts") {
        for (const [index, part] of textParts(at).entries()) out.push({ key: `${key}#part:${index}`, value: part });
        return false;
      }
    }
    const flags = valuePolicy(policy.node, policy);
    const referenceLiteral = hasReference(policy.node) && !policy.urlCredentials;
    if (typeof at === "string") {
      const types = Array.isArray(policy.node.type) ? policy.node.type
        : policy.node.type === undefined ? [] : [policy.node.type];
      const privateValue = flags.sensitive || referenceLiteral || (types.length > 0 && !types.includes("string"));
      if (text && privateValue && !flags.declaredSensitive && !referenceLiteral) {
        for (const [index, part] of textParts(at, credentialName(parts.at(-1) ?? "")).entries())
          out.push({ key: `${key}#part:${index}`, value: part });
      } else if (privateValue) {
        out.push({ key, value: at });
        if (text && ENDPOINT_PREFIX.test(at)) {
          for (const [index, part] of urlParts(at, TEXT_POLICY).textValues.entries())
            out.push({ key: `${key}#url:${index}`, value: part });
        }
      }
      else if (flags.urlCredentials) {
        const components = urlParts(at, TEXT_POLICY);
        for (const [index, part] of (text ? components.textValues : components.values).entries())
          out.push({ key: `${key}#url:${index}`, value: part });
      }
    } else if ((flags.declaredSensitive || referenceLiteral) && (typeof at === "number" || typeof at === "boolean"))
      out.push({ key, value: String(at) });
  });
  return out;
}

/** Bounded notices contain only paths and guidance, never configured values. */
export function configurationWarnings(value: unknown, schema: ConfigSchemaNode = SCHEMA): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  visitConfigPolicy(value, schema, [], (at, policy, parts, parent) => {
    if (warnings.length >= WARNING_LIMIT) return false;
    const key = parts.join(".");
    if (hasReference(policy.node) && at !== "" && at !== null && at !== undefined) {
      try {
        if (!referenceMatches(policy.node, at, schema)) warnings.push({ key,
          message: looksLikePastedKey(at, REFERENCE_POLICY)
            ? "Reference looks like a pasted key; use a secret-store reference name."
            : "Value does not match the declared reference syntax; use a secret-store reference name.",
        });
      } catch { /* Invalid metadata stays private and is rejected at manifest boundaries. */ }
    }
    if (warnings.length >= WARNING_LIMIT || typeof at !== "string" || !policy.urlCredentials || !urlParts(at).userInfo) return;
    const sibling = Object.entries(parent?.properties ?? {}).find(([, node]) =>
      node["x-sensitive"] === true && node.type === "string")?.[0];
    const hint = sibling ? [...parts.slice(0, -1), sibling].join(".") : "the provider's secret-store reference field";
    warnings.push({ key, message: `URL userinfo is discouraged; use ${hint} instead.` });
  });
  return warnings;
}
