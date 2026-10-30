const MAX_SCHEMA_NODES = 4096;
const MAX_SCHEMA_DEPTH = 32;
const HEADER_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

interface HeaderAnnotation {
  name: string;
  path: string[];
  type: string;
}

/**
 * Encodes an MCP header value using RFC 2047-style base64 framing when non-ASCII or leading/trailing whitespace is present.
 */
export function encodeMcpHeaderValue(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) &&
    value.trim() === value &&
    !(value.startsWith("=?base64?") && value.endsWith("?="))
    ? value
    : `=?base64?${Buffer.from(value).toString("base64")}?=`;
}

/**
 * Decodes an MCP header value, unpacking RFC 2047-style base64 framing if present.
 */
export function decodeMcpHeaderValue(raw: string): string {
  const m = /^=\?base64\?([A-Za-z0-9+/=]+)\?=$/.exec(raw.trim());
  if (!m) return raw;
  try {
    return Buffer.from(m[1]!, "base64").toString("utf8");
  } catch {
    return raw;
  }
}

/**
 * Builds an extractor that computes expected `Mcp-Param-*` headers for a tool inputSchema.
 */
export function buildToolHeaderExtractor(
  schema: Record<string, unknown>,
): (args: Record<string, unknown>) => Record<string, string> {
  const annotations: HeaderAnnotation[] = [];
  const names = new Set<string>();
  let nodes = 0;

  function walk(value: unknown, path: string[], reachable: boolean, depth: number): void {
    if (++nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) {
      throw new Error("MCP schema complexity limit");
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, path, false, depth + 1);
      return;
    }
    const obj = value as Record<string, unknown>;
    if ("x-mcp-header" in obj) {
      const name = obj["x-mcp-header"];
      const type = obj.type;
      if (
        !reachable ||
        !path.length ||
        typeof name !== "string" ||
        !HEADER_TOKEN_RE.test(name) ||
        typeof type !== "string" ||
        !["integer", "boolean", "string"].includes(type) ||
        names.has(name.toLowerCase())
      ) {
        throw new Error("MCP invalid tool header annotation");
      }
      names.add(name.toLowerCase());
      annotations.push({ name, path, type });
    }
    for (const [key, item] of Object.entries(obj)) {
      if (key === "properties" && item && typeof item === "object" && !Array.isArray(item)) {
        for (const [prop, sub] of Object.entries(item)) {
          walk(sub, [...path, prop], reachable, depth + 1);
        }
      } else if (typeof item === "object") {
        walk(item, path, false, depth + 1);
      }
    }
  }

  walk(schema, [], true, 0);

  return (args: Record<string, unknown>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const ann of annotations) {
      let cur: unknown = args;
      for (const part of ann.path) {
        cur =
          cur !== null && typeof cur === "object" && Object.hasOwn(cur, part)
            ? (cur as Record<string, unknown>)[part]
            : undefined;
      }
      if (cur === undefined || cur === null) continue;
      if (
        ann.type === "integer"
          ? typeof cur !== "number" || !Number.isSafeInteger(cur)
          : typeof cur !== ann.type
      ) {
        throw new Error("MCP tool header parameter type invalid");
      }
      out[`mcp-param-${ann.name.toLowerCase()}`] = encodeMcpHeaderValue(String(cur));
    }
    return out;
  };
}
