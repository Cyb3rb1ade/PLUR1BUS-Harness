import { encodeMcpHeader } from "./modern-http.ts";

interface Annotation { name: string; path: string[]; type: string }
/** Reject malformed annotations anywhere, including unreachable schema branches. No remote $ref fetching. */
export function toolHeaderExtractor(schema: Record<string, unknown>): (args: Record<string, unknown>) => Record<string, string> {
  const annotations: Annotation[] = []; const names = new Set<string>(); let nodes = 0;
  function walk(value: unknown, path: string[], reachable: boolean, depth: number): void {
    if (++nodes > 4096 || depth > 32) throw new Error("MCP schema complexity limit");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const v of value) walk(v, path, false, depth + 1); return; }
    const object = value as Record<string, unknown>;
    if ("x-mcp-header" in object) {
      const name = object["x-mcp-header"]; const type = object.type;
      if (!reachable || !path.length || typeof name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
          typeof type !== "string" || !["integer", "boolean", "string"].includes(type) || names.has(name.toLowerCase())) throw new Error("MCP invalid tool header annotation");
      names.add(name.toLowerCase()); annotations.push({ name, path, type });
    }
    for (const [key, item] of Object.entries(object)) {
      if (key === "properties" && item && typeof item === "object" && !Array.isArray(item)) {
        for (const [property, subschema] of Object.entries(item)) walk(subschema, [...path, property], reachable, depth + 1);
      } else if (typeof item === "object") walk(item, path, false, depth + 1);
    }
  }
  walk(schema, [], true, 0);
  return args => {
    const out: Record<string, string> = {};
    for (const annotation of annotations) {
      let value: unknown = args;
      for (const part of annotation.path) value = value !== null && typeof value === "object" && Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
      if (value === undefined || value === null) continue;
      if (annotation.type === "integer" ? typeof value !== "number" || !Number.isSafeInteger(value) : typeof value !== annotation.type) throw new Error("MCP tool header parameter type invalid");
      out[`Mcp-Param-${annotation.name}`] = encodeMcpHeader(String(value));
    }
    return out;
  };
}
