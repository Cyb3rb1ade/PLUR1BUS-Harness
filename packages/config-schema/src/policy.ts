// Browser-safe structural policy shared by config projections and generated settings metadata.
import { maskUrlCredentials } from "./url-credentials.ts";
import type { SecretReferencePolicy } from "./secret-reference.ts";
export { maskUrlCredentials } from "./url-credentials.ts";
export { looksLikePastedKey, matchesReference } from "./secret-reference.ts";
export { supportsConfigDisclosurePolicy } from "./disclosure-policy.ts";
export type { SecretReferencePolicy } from "./secret-reference.ts";

export interface ConfigSchemaNode {
  readonly [key: string]: unknown;
  $defs?: Readonly<Record<string, unknown>>;
  type?: string | readonly string[];
  properties?: Readonly<Record<string, ConfigSchemaNode>>;
  additionalProperties?: boolean | ConfigSchemaNode;
  items?: boolean | ConfigSchemaNode;
  "x-value-schema"?: ConfigSchemaNode;
  "x-sensitive"?: boolean;
  "x-url-credentials"?: boolean;
  "x-secret-reference"?: boolean | { $ref: string };
  "x-secret-reference-kind"?: string;
  "x-secret-reference-policy"?: SecretReferencePolicy;
  "x-unknown-members"?: "sensitive" | "public";
  "x-text-credentials"?: "parts";
}

export interface ConfigPolicy {
  node: ConfigSchemaNode;
  root: ConfigSchemaNode;
  known: boolean;
  sensitive: boolean;
  declaredSensitive: boolean;
  urlCredentials: boolean;
  unknownMembers: "sensitive" | "public";
  textCredentials?: "parts";
}

function mergePolicy(base: ConfigSchemaNode, node: ConfigSchemaNode, depth = 0): ConfigSchemaNode {
  if (depth > 128) return { "x-sensitive": true };
  const properties: Record<string, ConfigSchemaNode> = Object.assign(Object.create(null), base.properties);
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    const previous = properties[name];
    properties[name] = previous ? mergePolicy(previous, child, depth + 1) : child;
  }
  const merged: ConfigSchemaNode = { ...base, ...node,
    ...(base.properties || node.properties ? { properties } : {}),
  };
  for (const key of ["items", "additionalProperties", "x-value-schema"] as const) {
    const left = base[key], right = node[key];
    if (left && right && typeof left === "object" && typeof right === "object")
      merged[key] = mergePolicy(left, right, depth + 1);
  }
  for (const key of ["x-sensitive", "x-url-credentials"] as const)
    if (base[key] === true) merged[key] = true;
  if (base["x-unknown-members"] === "sensitive" || node["x-unknown-members"] === "sensitive")
    merged["x-unknown-members"] = "sensitive";
  if (base["x-secret-reference"] !== undefined && node["x-secret-reference"] !== undefined &&
    JSON.stringify(base["x-secret-reference"]) !== JSON.stringify(node["x-secret-reference"])) {
    merged["x-sensitive"] = true;
    merged["x-secret-reference"] = false;
  }
  return merged;
}
export const valueSchema = (node: ConfigSchemaNode): ConfigSchemaNode => node["x-value-schema"]
  ? mergePolicy(node, node["x-value-schema"]) : node;
export const schemaObject = (value: unknown): ConfigSchemaNode =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? valueSchema(value as ConfigSchemaNode) : {};
export const propertySchema = (node: ConfigSchemaNode, key: string): ConfigSchemaNode | undefined =>
  node.properties && Object.hasOwn(node.properties, key) ? node.properties[key] : undefined;
export const homogeneousMap = (node: ConfigSchemaNode): boolean =>
  node.type === "object" && Object.keys(node.properties ?? {}).length === 0;
export const itemSchema = (node: ConfigSchemaNode): ConfigSchemaNode =>
  schemaObject(node.items ?? (homogeneousMap(node) ? node.additionalProperties : undefined));
export const memberSchema = (node: ConfigSchemaNode, name: string): ConfigSchemaNode =>
  schemaObject(propertySchema(node, name) ??
    (node.type === "array" && /^(?:\d+|\*)$/.test(name) ? node.items : node.additionalProperties));

function modeled(node: ConfigSchemaNode): boolean {
  return ["type", "enum", "const", "x-sensitive",
    "x-url-credentials", "x-secret-reference"].some(key => Object.hasOwn(node, key)) ||
    node["x-unknown-members"] === "public";
}

/** Local value references retain structure; cycles and unavailable targets grant no public exemption. */
function resolvedSchema(node: ConfigSchemaNode, root: ConfigSchemaNode, seen = new Set<string>()): ConfigSchemaNode {
  node = valueSchema(node);
  const reference = node.$ref;
  if (typeof reference !== "string" || !reference.startsWith("#/") || seen.has(reference)) return node;
  let target: unknown = root;
  for (const raw of reference.slice(2).split("/")) {
    if (/~[^01]|~$/.test(raw)) return node;
    const name = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!target || typeof target !== "object" || !Object.hasOwn(target, name)) return node;
    target = (target as Record<string, unknown>)[name];
  }
  if (!target || typeof target !== "object" || Array.isArray(target)) return node;
  seen.add(reference);
  const base = resolvedSchema(target as ConfigSchemaNode, root, seen);
  // JSON Schema siblings cannot cancel a privacy requirement inherited from the target.
  return mergePolicy(base, node);
}

export function policyForNode(node: ConfigSchemaNode, inherited?: ConfigPolicy): ConfigPolicy {
  const root = inherited?.root ?? node;
  node = resolvedSchema(node, root);
  const declaredSensitive = inherited?.declaredSensitive === true || node["x-sensitive"] === true;
  const known = modeled(node);
  const unknownMembers = node["x-unknown-members"] ?? inherited?.unknownMembers ?? "sensitive";
  const textCredentials = node["x-text-credentials"] ?? inherited?.textCredentials;
  return {
    node, root, known, declaredSensitive, unknownMembers,
    sensitive: declaredSensitive || (!known && unknownMembers === "sensitive"),
    urlCredentials: inherited?.urlCredentials === true || node["x-url-credentials"] === true,
    ...(textCredentials ? { textCredentials } : {}),
  };
}

/** Structured segments distinguish one member named vendor.with.dots from three nested members. */
export function configPolicyAt(schema: ConfigSchemaNode, path: readonly string[]): ConfigPolicy {
  let policy = policyForNode(schema);
  for (const part of path) {
    const reference = policy.node["x-secret-reference"];
    const inherited = reference !== undefined && reference !== false ? { ...policy, declaredSensitive: true } : policy;
    policy = policyForNode(memberSchema(policy.node, part), inherited);
  }
  return policy;
}

/** Resolve only local reference metadata. It never opens the target secret or retrieves another schema. */
export function referenceSchema(node: ConfigSchemaNode, schema: ConfigSchemaNode): ConfigSchemaNode | undefined {
  const reference = node["x-secret-reference"];
  if (reference === undefined || reference === false) return;
  if (reference === true) return node;
  const invalid = (): never => { throw new Error("Invalid secret-reference metadata"); };
  if (!reference || typeof reference !== "object" || Object.keys(reference).length !== 1 ||
    typeof reference.$ref !== "string" || !reference.$ref.startsWith("#/$defs/")) return invalid();
  let target: unknown = schema;
  for (const raw of reference.$ref.slice(2).split("/")) {
    if (/~[^01]|~$/.test(raw)) return invalid();
    const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!target || typeof target !== "object" || !Object.hasOwn(target, part)) return invalid();
    target = (target as Record<string, unknown>)[part];
  }
  if (!target || typeof target !== "object" || Array.isArray(target)) return invalid();
  return target as ConfigSchemaNode;
}

/** Collection widgets inherit the policy of their values without turning unknown numbers into secrets. */
export function valuePolicy(node: ConfigSchemaNode, inherited?: ConfigPolicy): ConfigPolicy {
  const policy = policyForNode(node, inherited);
  if (policy.node.type !== "array" && !homogeneousMap(policy.node)) return policy;
  const child = policyForNode(itemSchema(policy.node), policy);
  return {
    ...policy, sensitive: policy.sensitive || child.sensitive,
    declaredSensitive: policy.declaredSensitive || child.declaredSensitive,
    urlCredentials: policy.urlCredentials || child.urlCredentials,
    ...(child.textCredentials ? { textCredentials: child.textCredentials } : {}),
  };
}

export type ReferenceMatch = (node: ConfigSchemaNode, value: unknown, path: readonly string[]) => boolean;

export type PolicyVisitor = (
  value: unknown, policy: ConfigPolicy, path: readonly string[], parent?: ConfigSchemaNode,
) => boolean | void;

/** Visit original values with the same structured lookup used by projections; false skips a subtree. */
export function visitConfigPolicy(
  value: unknown, schema: ConfigSchemaNode, path: readonly string[], visit: PolicyVisitor,
): void {
  function walk(at: unknown, policy: ConfigPolicy, parts: readonly string[], parent?: ConfigSchemaNode): void {
    if (visit(at, policy, parts, parent) === false) return;
    const reference = policy.node["x-secret-reference"];
    const inherited = reference !== undefined && reference !== false ? { ...policy, declaredSensitive: true } : policy;
    if (Array.isArray(at)) {
      for (const [index, child] of at.entries())
        walk(child, policyForNode(itemSchema(policy.node), inherited), [...parts, String(index)], policy.node);
    } else if (at && typeof at === "object") {
      for (const [name, child] of Object.entries(at))
        walk(child, policyForNode(memberSchema(policy.node, name), inherited), [...parts, name], policy.node);
    }
  }
  walk(value, configPolicyAt(schema, path), path);
}

/** Editors for open or credential-bearing containers must make replacement explicit. */
export function containsConfigCredentials(schema: ConfigSchemaNode, path: readonly string[]): boolean {
  const seen = new Set<string>();
  function contains(policy: ConfigPolicy, depth = 0): boolean {
    const { node } = policy;
    if (policy.sensitive || policy.urlCredentials || node["x-secret-reference"]) return true;
    if (depth > 128) return true;
    const reference = typeof node.$ref === "string" ? JSON.stringify(node) : undefined;
    if (reference && seen.has(reference)) return false;
    if (reference) seen.add(reference);
    try {
      if (node.type === "array") return contains(policyForNode(itemSchema(node), policy), depth + 1);
      if (node.type === "object" || node.properties) {
        if (Object.values(node.properties ?? {}).some(child => contains(policyForNode(child, policy), depth + 1))) return true;
        if (node.additionalProperties !== false)
          return contains(policyForNode(schemaObject(node.additionalProperties), policy), depth + 1);
      }
      return false;
    } finally {
      if (reference) seen.delete(reference);
    }
  }
  return contains(configPolicyAt(schema, path));
}

/** Projection alone never resolves a reference target or changes the source object. */
export function redactWithPolicy(
  value: unknown, schema: ConfigSchemaNode, path: readonly string[] = [], isReference?: ReferenceMatch,
): unknown {
  const start = configPolicyAt(schema, path);
  function project(at: unknown, policy: ConfigPolicy, parts: readonly string[]): unknown {
    const { node } = policy;
    let reference = false;
    try { reference = isReference?.(node, at, parts) === true; }
    catch { /* Invalid metadata never grants a public reference exemption. */ }
    if (reference && !policy.urlCredentials) {
      return at && typeof at === "object" ? { ...at } : at;
    }
    const referenceLiteral = !policy.urlCredentials && node["x-secret-reference"] !== undefined &&
      node["x-secret-reference"] !== false;
    const literal = policy.sensitive || referenceLiteral;
    if (typeof at === "string") {
      const types = Array.isArray(node.type) ? node.type : node.type === undefined ? [] : [node.type];
      const wrongShape = types.length > 0 && !types.includes("string");
      const collection = node.type === "array" || homogeneousMap(node)
        ? policyForNode(itemSchema(node), policy) : policy;
      if (literal || wrongShape || collection.declaredSensitive) return at ? "••••" : "";
      return policy.urlCredentials || collection.urlCredentials ? maskUrlCredentials(at) : at;
    }
    if (policy.declaredSensitive || referenceLiteral) {
      if (typeof at === "number") return 0;
      if (typeof at === "boolean") return false;
    }
    const inherited = referenceLiteral ? { ...policy, declaredSensitive: true } : policy;
    if (Array.isArray(at)) return at.map((child, index) =>
      project(child, policyForNode(itemSchema(node), inherited), [...parts, String(index)]));
    if (at && typeof at === "object") return Object.fromEntries(Object.entries(at).map(([name, child]) =>
      [name, project(child, policyForNode(memberSchema(node, name), inherited), [...parts, name])]));
    return at;
  }
  return project(value, start, path);
}

/** Serialize the same schema format, retaining public structure as well as privacy declarations. */
export function policySchema(schema: ConfigSchemaNode): ConfigSchemaNode {
  const node = valueSchema(schema);
  const out: Record<string, unknown> = {};
  for (const key of ["$ref", "type", "enum", "const", "required", "minLength", "maxLength", "pattern", "x-sensitive",
    "x-url-credentials", "x-secret-reference", "x-secret-reference-kind", "x-secret-reference-policy",
    "x-unknown-members", "x-text-credentials"]) {
    if (Object.hasOwn(node, key)) out[key] = node[key];
  }
  for (const key of ["properties", "$defs"] as const) {
    if (node[key] && typeof node[key] === "object") out[key] = Object.fromEntries(Object.entries(node[key]!)
      .map(([name, child]) => [name, policySchema(schemaObject(child))]));
  }
  for (const key of ["items", "additionalProperties"] as const) {
    const child = node[key];
    if (child !== undefined) out[key] = typeof child === "boolean" ? child : policySchema(child);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const children = node[key];
    if (Array.isArray(children)) out[key] = children.map(child => policySchema(schemaObject(child)));
  }
  return out as ConfigSchemaNode;
}
