// Browser-safe reference classification. Policy constants come from the configuration schema, never field-name guesses.
export interface SecretReferencePolicy {
  storeNamePattern: string;
  envNamePattern: string;
  tokenPrefixPattern: string;
  maxNameLength: number;
  entropyMinLength: number;
  entropyMinBits: number;
  hexMinLength: number;
  hexMinEntropyBits: number;
}
type Schema = Readonly<Record<string, unknown>>;
const object = (value: unknown): Schema =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Schema : {};
const pattern = (value: string, expression: string, flags = ""): boolean => {
  try { return new RegExp(expression, flags).test(value); } catch { return false; }
};
const namePattern = (value: string, expression: string): boolean => {
  try {
    const match = new RegExp(expression).exec(value);
    return match?.index === 0 && match[0].length === value.length;
  } catch { return false; }
};

function entropy(value: string): number {
  const counts = new Map<string, number>();
  const chars = [...value];
  for (const char of chars) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / chars.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

function tokenLike(value: string, policy: SecretReferencePolicy, path = false): boolean {
  if (pattern(value, policy.tokenPrefixPattern, "i")) return true;
  // Declared source paths are not store names; their normal length and punctuation must survive a backup roundtrip.
  if (path && /^(?:[/\\]|\.{1,2}[/\\]|~[/\\]|[A-Za-z]:[/\\])/.test(value)) return false;
  const size = [...value].length;
  if (size > policy.maxNameLength) return true;
  if (size >= policy.hexMinLength && /^[A-Fa-f0-9]+$/.test(value) && entropy(value) >= policy.hexMinEntropyBits)
    return true;
  return size >= policy.entropyMinLength && entropy(value) >= policy.entropyMinBits;
}

/** Detect a pasted credential without echoing it. Full reference matching separately establishes the declared form. */
export function looksLikePastedKey(value: unknown, policy: SecretReferencePolicy): boolean {
  if (typeof value === "string") return tokenLike(value, policy);
  const ref = object(value);
  const sourcePath = ref.source === "file" || ref.source === "exec";
  return (typeof ref.provider === "string" && tokenLike(ref.provider, policy)) ||
    (typeof ref.id === "string" && tokenLike(ref.id, policy, sourcePath));
}

/** Apply source-specific name safety after a validator has matched the reference subschema. Targets are never read. */
export function referenceSafety(value: unknown, referenceSchema: unknown, policy: SecretReferencePolicy): boolean {
  const kind = object(referenceSchema)["x-secret-reference-kind"] ?? "store-name";
  if (!["store-name", "env-name", "env-template", "file-path", "engine-input"].includes(String(kind))) return false;
  const name = (text: string, env = false): boolean =>
    namePattern(text, env ? policy.envNamePattern : policy.storeNamePattern) && !tokenLike(text, policy);
  if (typeof value === "string") {
    if (kind === "file-path") return value.length > 0 && !tokenLike(value, policy, true);
    if (kind === "env-name") return name(value, true);
    if (kind === "env-template" || kind === "engine-input") {
      const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
      return !!match && name(match[1]!, true);
    }
    return name(value);
  }
  if (kind !== "engine-input") return false;
  const ref = object(value);
  if (typeof ref.source !== "string" || typeof ref.provider !== "string" || typeof ref.id !== "string") return false;
  if (!name(ref.provider)) return false;
  if (ref.source === "store") return name(ref.id);
  if (ref.source === "env") return name(ref.id, true);
  return (ref.source === "file" || ref.source === "exec") && ref.id.length > 0 && !tokenLike(ref.id, policy, true);
}

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "default", "examples",
  "x-secret-reference", "x-secret-reference-kind", "x-sensitive", "x-restart", "x-tier"]);
const VALIDATION = new Set(["type", "enum", "const", "anyOf", "oneOf", "allOf", "properties", "required",
  "additionalProperties", "minLength", "maxLength", "pattern"]);

function schemaMatches(value: unknown, schema: unknown, depth = 0): boolean {
  if (depth > 64 || !schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const node = object(schema);
  if (Object.keys(node).some(key => !key.startsWith("x-") && !ANNOTATIONS.has(key) && !VALIDATION.has(key))) return false;
  const next = (child: unknown): boolean => schemaMatches(value, child, depth + 1);
  if (Array.isArray(node.anyOf) && !node.anyOf.some(next)) return false;
  if (Array.isArray(node.oneOf) && node.oneOf.filter(next).length !== 1) return false;
  if (Array.isArray(node.allOf) && !node.allOf.every(next)) return false;
  if (Array.isArray(node.enum) && !node.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return false;
  if (Object.hasOwn(node, "const") && JSON.stringify(node.const) !== JSON.stringify(value)) return false;
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const types = Array.isArray(node.type) ? node.type : node.type === undefined ? [] : [node.type];
  if (types.length && !types.includes(type)) return false;
  if (typeof value === "string") {
    const size = [...value].length;
    if (typeof node.minLength === "number" && size < node.minLength) return false;
    if (typeof node.maxLength === "number" && size > node.maxLength) return false;
    if (typeof node.pattern === "string" && !pattern(value, node.pattern)) return false;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const current = object(value), props = object(node.properties);
    if (Array.isArray(node.required) && node.required.some(key => typeof key !== "string" || !Object.hasOwn(current, key)))
      return false;
    for (const [key, child] of Object.entries(current)) {
      if (Object.hasOwn(props, key)) { if (!schemaMatches(child, props[key], depth + 1)) return false; }
      else if (node.additionalProperties === false) return false;
      else if (node.additionalProperties && typeof node.additionalProperties === "object" &&
        !schemaMatches(child, node.additionalProperties, depth + 1)) return false;
    }
  }
  return true;
}

/** The supported generated browser subset fails closed; server validators retain full JSON Schema validation. */
export function matchesReference(value: unknown, referenceSchema: unknown, policy: SecretReferencePolicy): boolean {
  return schemaMatches(value, referenceSchema) && referenceSafety(value, referenceSchema, policy);
}
