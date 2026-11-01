// Capability boundary for schema-owned display metadata; unsupported reference scopes and conditional privacy fail closed.
type Node = Readonly<Record<string, unknown>>;
type Edge = "direct" | "conditional" | "definition";
const object = (value: unknown): Node =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Node : {};
const own = (node: Node, key: string): unknown => Object.hasOwn(node, key) ? node[key] : undefined;
const field = (node: Node, key: string): unknown => own(object(own(node, "x-value-schema")), key) ?? own(node, key);

function children(node: Node): { node: Node; edge: Edge }[] {
  const out: { node: Node; edge: Edge }[] = [];
  for (const [key, edge] of [
    ["properties", "direct"], ["patternProperties", "conditional"], ["dependentSchemas", "conditional"],
    ["dependencies", "conditional"], ["$defs", "definition"], ["definitions", "definition"],
  ] as const) {
    for (const child of Object.values(object(own(node, key)))) out.push({ node: object(child), edge });
  }
  for (const key of ["items", "additionalProperties", "x-value-schema"]) {
    const child = own(node, key);
    if (Array.isArray(child)) for (const item of child) out.push({ node: object(item), edge: "conditional" });
    else if (child !== undefined) out.push({ node: object(child), edge: "direct" });
  }
  for (const key of [
    "if", "then", "else", "not", "contains", "propertyNames", "unevaluatedProperties", "unevaluatedItems", "additionalItems",
  ]) {
    if (own(node, key) !== undefined) out.push({ node: object(own(node, key)), edge: "conditional" });
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const items = own(node, key);
    if (Array.isArray(items)) for (const child of items) out.push({ node: object(child), edge: "conditional" });
  }
  return out;
}

function nestedResource(node: Node, depth = 0): boolean {
  return depth > 128 || children(node).some(({ node }) =>
    own(node, "$id") !== undefined || nestedResource(node, depth + 1));
}

function localTarget(root: Node, reference: string): Node | undefined {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  let value: unknown = root;
  for (const raw of reference.slice(2).split("/")) {
    if (/~[^01]|~$/.test(raw)) return undefined;
    const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(part)) return undefined;
      value = value[Number(part)];
    } else value = own(object(value), part);
    if (value === undefined) return undefined;
  }
  return object(value);
}

/** Whether direct properties/maps/items can interpret every applicable privacy declaration without external retrieval.
 * This is a disclosure capability check, not configuration validation; unused definitions do not apply. */
export function supportsConfigDisclosurePolicy(schema: unknown): boolean {
  const root = object(schema);
  const references = new Set<string>();
  let remaining = 10_000;
  function visit(node: Node, edge: Edge, depth: number): boolean {
    if (--remaining < 0 || depth > 128) return false;
    const sensitive = field(node, "x-sensitive");
    const endpoint = field(node, "x-url-credentials");
    const referenceSlot = field(node, "x-secret-reference");
    if ((sensitive !== undefined && typeof sensitive !== "boolean") ||
        (endpoint !== undefined && typeof endpoint !== "boolean")) return false;
    if (sensitive === true && endpoint === true) return false;
    if (edge !== "direct" && (sensitive === true || endpoint === true ||
      (referenceSlot !== undefined && referenceSlot !== false))) return false;
    if (own(node, "$dynamicRef") !== undefined || own(node, "$recursiveRef") !== undefined) return false;
    const reference = own(node, "$ref");
    if (reference !== undefined) {
      if (typeof reference !== "string" || nestedResource(root)) return false;
      const target = localTarget(root, reference);
      if (!target) return false;
      if (!references.has(reference)) {
        references.add(reference);
        const supported = visit(target, "conditional", depth + 1);
        references.delete(reference);
        if (!supported) return false;
      }
    }
    return children(node).every((child) => child.edge === "definition" ||
      visit(child.node, child.edge === "direct" ? edge : "conditional", depth + 1));
  }
  return visit(root, "direct", 0);
}
