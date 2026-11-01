// Schema-owned policy lookup and credential extraction; metadata never changes configuration validation.
import schemaJson from "../schema/config.schema.json" with { type: "json" };
import { maskUrlCredentials, urlParts } from "./url-credentials.ts";

/** Configuration-member metadata, independent of validation and of credential-looking names. */
export interface ConfigSchemaNode {
  type?: string | readonly string[];
  properties?: Readonly<Record<string, ConfigSchemaNode>>;
  additionalProperties?: boolean | ConfigSchemaNode;
  items?: boolean | ConfigSchemaNode;
  /** Nonvalidating metadata for supported members of an opaque pass-through object. */
  "x-value-schema"?: ConfigSchemaNode;
  "x-sensitive"?: boolean;
  "x-url-credentials"?: boolean;
}
/** One concrete string to register, with its schema path or extracted URL-component slot. */
export interface ConfigSecretEntry {
  key: string;
  value: string;
}
/** A bounded validation notice containing a key and guidance, never the configured value. */
export interface ConfigWarning {
  key: string;
  message: string;
}
interface Annotations {
  sensitive: boolean;
  urlCredentials: boolean;
}
interface ScalarField extends Annotations {
  key: string;
  value: string;
  parent: ConfigSchemaNode;
}
const SCHEMA = schemaJson as unknown as ConfigSchemaNode;
const WARNING_LIMIT = 50;
const valueSchema = (node: ConfigSchemaNode): ConfigSchemaNode =>
  node["x-value-schema"]
    ? { ...node, ...node["x-value-schema"], properties: { ...node.properties, ...node["x-value-schema"].properties } }
    : node;
const schemaObject = (value: boolean | ConfigSchemaNode | undefined): ConfigSchemaNode =>
  typeof value === "object" && value !== null ? valueSchema(value) : {};
const propertySchema = (node: ConfigSchemaNode, key: string): ConfigSchemaNode | undefined =>
  node.properties && Object.hasOwn(node.properties, key) ? node.properties[key] : undefined;
const annotations = (node: ConfigSchemaNode, inherited: Annotations): Annotations => ({
  sensitive: inherited.sensitive || node["x-sensitive"] === true,
  urlCredentials: inherited.urlCredentials || node["x-url-credentials"] === true,
});
const homogeneousMap = (node: ConfigSchemaNode): boolean =>
  node.type === "object" && Object.keys(node.properties ?? {}).length === 0;
const itemSchema = (node: ConfigSchemaNode): ConfigSchemaNode =>
  schemaObject(node.items ?? (homogeneousMap(node) ? node.additionalProperties : undefined));
const memberSchema = (node: ConfigSchemaNode, name: string): ConfigSchemaNode =>
  propertySchema(node, name) ??
  schemaObject(node.type === "array" && /^\d+$/.test(name) ? node.items : node.additionalProperties);
const valueAnnotations = (node: ConfigSchemaNode, inherited: Annotations): Annotations =>
  annotations(node.type === "array" || homogeneousMap(node) ? itemSchema(node) : {}, annotations(node, inherited));

function schemaPath(key: string, schema: ConfigSchemaNode): { node: ConfigSchemaNode; flags: Annotations } {
  let node = valueSchema(schema);
  let flags = annotations(node, { sensitive: false, urlCredentials: false });
  for (const part of key
    .replace(/\[\d*\]/g, ".*")
    .split(".")
    .filter(Boolean)) {
    node = valueSchema(
      propertySchema(node, part) ??
        (node.items && /^(?:\d+|\*)$/.test(part) ? schemaObject(node.items) : schemaObject(node.additionalProperties)),
    );
    flags = annotations(node, flags);
  }
  return { node, flags };
}

function pathAnnotations(key: string, schema: ConfigSchemaNode): Annotations {
  const { node, flags } = schemaPath(key, schema);
  // A string-list widget must not display sensitive items just because the collection itself is unmarked.
  return annotations(schemaObject(node.items), flags);
}

/** Resolve whole-value sensitivity through property, map and array-item annotations. */
export const sensitiveOf = (key: string, schema: ConfigSchemaNode = SCHEMA): boolean =>
  pathAnnotations(key, schema).sensitive;
/** Resolve endpoint-component policy without treating the host or path as a secret. */
export const urlCredentialsOf = (key: string, schema: ConfigSchemaNode = SCHEMA): boolean =>
  pathAnnotations(key, schema).urlCredentials;

/** A public projection may start at a selected subtree while retaining the root policy. */
export interface ConfigRedactionOptions {
  schema?: ConfigSchemaNode;
  key?: string;
}

/** Mask declared secrets without changing JSON types, unknown fields or the running configuration. */
export function redactConfig(value: unknown, options: ConfigRedactionOptions = {}): unknown {
  const start = schemaPath(options.key ?? "", options.schema ?? SCHEMA);
  function project(at: unknown, node: ConfigSchemaNode, inherited: Annotations): unknown {
    node = valueSchema(node);
    const flags = valueAnnotations(node, inherited);
    if (typeof at === "string") {
      if (flags.sensitive) return at === "" ? "" : "••••";
      return flags.urlCredentials ? maskUrlCredentials(at) : at;
    }
    // Opaque or invalid configuration can contain a malformed scalar in a declared secret slot.
    if (flags.sensitive && typeof at === "number") return 0;
    if (flags.sensitive && typeof at === "boolean") return false;
    if (Array.isArray(at)) return at.map((child) => project(child, itemSchema(node), flags));
    if (at && typeof at === "object") {
      return Object.fromEntries(
        Object.entries(at).map(([name, child]) => [
          name,
          project(child, memberSchema(node, name), flags),
        ]),
      );
    }
    return at;
  }
  return project(value, start.node, start.flags);
}

/** Walk actual values with their property/map/item schemas; unknown members gain no name-based classification. */
function scalarFields(value: unknown, schema: ConfigSchemaNode, consume: (field: ScalarField) => void): void {
  function visit(
    at: unknown,
    node: ConfigSchemaNode,
    key: string,
    inherited: Annotations,
    parent: ConfigSchemaNode,
  ): void {
    node = valueSchema(node);
    const flags = valueAnnotations(node, inherited);
    if (typeof at === "string") {
      consume({ key, value: at, parent, ...flags });
      return;
    }
    if (flags.sensitive && (typeof at === "number" || typeof at === "boolean")) {
      consume({ key, value: String(at), parent, ...flags });
      return;
    }
    if (Array.isArray(at)) {
      for (const [index, child] of at.entries())
        visit(child, itemSchema(node), key ? `${key}.${index}` : String(index), flags, node);
    } else if (at && typeof at === "object") {
      for (const [name, child] of Object.entries(at))
        visit(
          child,
          memberSchema(node, name),
          key ? `${key}.${name}` : name,
          flags,
          node,
        );
    }
  }
  visit(value, schema, "", { sensitive: false, urlCredentials: false }, {});
}

/** Registry slots for declared sensitive strings; endpoint slots contain only extracted credential parts. */
export function configSecretEntries(value: unknown, schema: ConfigSchemaNode = SCHEMA): ConfigSecretEntry[] {
  const entries: ConfigSecretEntry[] = [];
  scalarFields(value, schema, (field) => {
    if (field.sensitive) entries.push({ key: field.key, value: field.value });
    else if (field.urlCredentials) {
      for (const [index, part] of urlParts(field.value).values.entries())
        entries.push({ key: `${field.key}#url:${index}`, value: part });
    }
  });
  return entries;
}

/** Value-free, bounded warnings. Endpoints remain valid and retain their original representation. */
export function configurationWarnings(value: unknown, schema: ConfigSchemaNode = SCHEMA): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  scalarFields(value, schema, (field) => {
    if (warnings.length >= WARNING_LIMIT || !field.urlCredentials || !urlParts(field.value).userInfo) return;
    const sibling = Object.entries(field.parent.properties ?? {}).find(
      ([, node]) => node["x-sensitive"] === true && node.type === "string",
    )?.[0];
    const parentKey = field.key.split(".").slice(0, -1).join(".");
    const hint = sibling
      ? `${parentKey ? `${parentKey}.` : ""}${sibling}`
      : "the provider's secret-store reference field";
    warnings.push({ key: field.key, message: `URL userinfo is discouraged; use ${hint} instead.` });
  });
  return warnings;
}
