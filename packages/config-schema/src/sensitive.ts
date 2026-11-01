// Schema-owned policy lookup and credential extraction; metadata never changes configuration validation.
import schemaJson from "../schema/config.schema.json" with { type: "json" };

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
interface StringField extends Annotations {
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

function pathAnnotations(key: string, schema: ConfigSchemaNode): Annotations {
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
  // A string-list widget must not display sensitive items just because the collection itself is unmarked.
  const item = schemaObject(node.items);
  return annotations(item, flags);
}

/** Resolve whole-value sensitivity through property, map and array-item annotations. */
export const sensitiveOf = (key: string, schema: ConfigSchemaNode = SCHEMA): boolean =>
  pathAnnotations(key, schema).sensitive;
/** Resolve endpoint-component policy without treating the host or path as a secret. */
export const urlCredentialsOf = (key: string, schema: ConfigSchemaNode = SCHEMA): boolean =>
  pathAnnotations(key, schema).urlCredentials;

/** Walk actual values with their property/map/item schemas; unknown members gain no name-based classification. */
function stringFields(value: unknown, schema: ConfigSchemaNode, consume: (field: StringField) => void): void {
  function visit(
    at: unknown,
    node: ConfigSchemaNode,
    key: string,
    inherited: Annotations,
    parent: ConfigSchemaNode,
  ): void {
    node = valueSchema(node);
    const flags = annotations(node, inherited);
    if (typeof at === "string") {
      consume({ key, value: at, parent, ...flags });
      return;
    }
    if (Array.isArray(at)) {
      for (const [index, child] of at.entries())
        visit(child, schemaObject(node.items), key ? `${key}.${index}` : String(index), flags, node);
    } else if (at && typeof at === "object") {
      for (const [name, child] of Object.entries(at))
        visit(
          child,
          propertySchema(node, name) ?? schemaObject(node.additionalProperties),
          key ? `${key}.${name}` : name,
          flags,
          node,
        );
    }
  }
  visit(value, schema, "", { sensitive: false, urlCredentials: false }, {});
}

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    // URL userinfo can retain a literal percent sign beside valid escapes. Decode the valid parts too.
    return new URLSearchParams(`value=${text.replaceAll("&", "%26").replaceAll("+", "%2B")}`).get("value") ?? text;
  }
};

/** Locate userinfo after WHATWG input normalization, including invalid hosts and ports. */
function userInfoRange(value: string): { start: number; end: number } | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  const special = !scheme || /^(?:https?|ftp|wss?)$/i.test(scheme[1] ?? "");
  if (!scheme && !/^[\\/]{2}/.test(value)) return;
  let start = scheme?.[0].length ?? 0;
  if (special) {
    while (/[\\/]/.test(value.charAt(start)) && start < value.length) start++;
  } else if (value.slice(start, start + 2) === "//") start += 2;
  else return;
  const rest = value.slice(start);
  const authority =
    (special || scheme?.[1]?.toLowerCase() === "file" ? /^[^/\\?#]*/ : /^[^/?#]*/).exec(rest)?.[0] ?? "";
  const separator = authority.lastIndexOf("@");
  return separator < 0 ? undefined : { start, end: start + separator };
}

/** Map a normalized offset back without dropping controls that belong to the literal credential. */
function literalOffset(value: string, normalizedOffset: number): number {
  let index = 0;
  for (let offset = 0; offset < normalizedOffset && index < value.length; index++) {
    if (!/[\t\n\r]/.test(value.charAt(index))) offset++;
  }
  return index;
}

/** Extract credentials without treating any host or path as a secret, even for a malformed endpoint. */
function urlParts(value: string): { values: string[]; userInfo: boolean } {
  const values = new Set<string>();
  const add = (text: string, query = false): void => {
    if (text !== "") values.add(text);
    const plain = decode(query ? text.replaceAll("+", " ") : text);
    if (plain !== "") values.add(plain);
  };
  let userInfo = false;
  const addUserInfo = (text: string): void => {
    userInfo = true;
    const colon = text.indexOf(":");
    add(text);
    add(colon < 0 ? text : text.slice(0, colon));
    if (colon >= 0) add(text.slice(colon + 1));
  };
  const literal = value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  const normalized = literal.replace(/[\t\n\r]/g, "");
  const range = userInfoRange(normalized);
  if (range) {
    const start = literalOffset(literal, range.start);
    let end = literalOffset(literal, range.end);
    while (/[\t\n\r]/.test(literal.charAt(end)) && end < literal.length) end++;
    addUserInfo(literal.slice(start, end));
    addUserInfo(normalized.slice(range.start, range.end));
  }
  try {
    const relative = /^[\\/]{2}/.test(normalized);
    const parsed = new URL(relative ? `https:${normalized}` : normalized);
    if (parsed.username || parsed.password)
      addUserInfo(`${parsed.username}${parsed.password ? `:${parsed.password}` : ""}`);
  } catch {
    // Literal extraction above also covers incomplete endpoints; validation is unchanged.
  }
  for (const text of new Set([value, normalized])) {
    const fragment = text.indexOf("#");
    const query = text.indexOf("?");
    if (query >= 0 && (fragment < 0 || query < fragment)) {
      for (const parameter of text.slice(query + 1, fragment < 0 ? undefined : fragment).split("&")) {
        const equal = parameter.indexOf("=");
        if (equal >= 0) add(parameter.slice(equal + 1), true);
      }
    }
  }
  return { values: [...values], userInfo };
}

/** Registry slots for declared sensitive strings; endpoint slots contain only extracted credential parts. */
export function configSecretEntries(value: unknown, schema: ConfigSchemaNode = SCHEMA): ConfigSecretEntry[] {
  const entries: ConfigSecretEntry[] = [];
  stringFields(value, schema, (field) => {
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
  stringFields(value, schema, (field) => {
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
