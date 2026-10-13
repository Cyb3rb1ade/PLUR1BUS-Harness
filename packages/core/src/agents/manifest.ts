// Canonical key ordering survives CLI/Python JSON reserialization. Array order and file text stay unchanged.
export function canonicalManifest(value: unknown): any {
  if (Array.isArray(value)) return value.map(canonicalManifest);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalManifest((value as Record<string, unknown>)[key])]));
  return value;
}
