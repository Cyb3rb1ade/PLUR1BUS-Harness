// A small JSON Schema checker for the OpenAPI document of the API, in the test tree only (no dependency: the schemas in
// routes.ts use a handful of keywords). A keyword it does not know is an error, never silently ignored, so a schema that
// grows past this checker cannot go unvalidated.
type Schema = Record<string, unknown>;
export interface Doc { components: { schemas: Record<string, Schema> } }

const ANNOTATIONS = new Set(["description", "title", "default", "examples", "$comment"]);
const KEYWORDS = new Set(["$ref", "type", "enum", "const", "oneOf", "required", "properties", "additionalProperties", "items", "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "minItems", "maxItems"]);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const kindOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

export function validate(schema: Schema, value: unknown, doc: Doc, at = "$"): string[] {
  for (const k of Object.keys(schema)) if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k) && !k.startsWith("x-")) throw new Error(`the test validator does not know the schema keyword "${k}" at ${at}`);
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace("#/components/schemas/", ""); const target = doc.components.schemas[name];
    if (!target) return [`${at}: unresolved ${schema.$ref}`];
    return validate(target, value, doc, at);
  }
  const errs: string[] = [];
  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as Schema[]).filter((s) => validate(s, value, doc, at).length === 0).length;
    if (passing !== 1) errs.push(`${at}: matches ${passing} of the ${(schema.oneOf as unknown[]).length} oneOf branches, exactly one is required`);
    return errs;
  }
  if ("const" in schema && value !== schema.const) errs.push(`${at}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (schema.type !== undefined) {
    const k = kindOf(value); const want = Array.isArray(schema.type) ? schema.type : [schema.type];
    const okType = want.some(type => type === "number" ? k === "integer" || k === "number" : k === type);
    if (!okType) { errs.push(`${at}: expected ${want}, got ${k}`); return errs; }
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: does not match ${schema.pattern}`);
    if (schema.format === "date-time" && (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) errs.push(`${at}: ${JSON.stringify(value)} is not a date-time`);
    else if (schema.format !== undefined && schema.format !== "date-time") throw new Error(`the test validator does not know the format "${String(schema.format)}"`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errs.push(`${at}: below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errs.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items as Schema, v, doc, `${at}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>; const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const r of (schema.required ?? []) as string[]) if (!(r in o)) errs.push(`${at}: missing required property "${r}"`);
    for (const [k, v] of Object.entries(o)) {
      if (k in props) errs.push(...validate(props[k]!, v, doc, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected property "${k}"`);
    }
  }
  return errs;
}
