import type { ToolDefinition, JsonObject } from '../../../providers/src/types.ts';
import type { ToolDescription } from '../tools/registry.ts';
import { assertSchema, object, type Schema } from './validation.ts';
import { lookupQuirks, type ProviderFamily } from './quirks.ts';
export interface CompiledDialect { wire: Record<string, unknown>; reductions: { path: string; keyword: string }[] }
/** Names are checked when compiling a catalogue, before a provider can execute a call. */
export function compileDialect(tool: ToolDefinition, family: ProviderFamily, options: { strict?: boolean; modelFamily?: string } = {}): CompiledDialect {
  const quirks = lookupQuirks(options.modelFamily ?? family);
  if (tool.name.length > quirks.maxNameLength || !new RegExp(quirks.namePattern).test(tool.name)) throw Error(`invalid tool name for ${family}: ${tool.name}`);
  const strict = options.strict ?? quirks.strict;
  if (strict && (family === 'gemini' || family === 'anthropic' || !quirks.strict)) throw Error(`strict mode unsupported by ${family}`);
  const schema = tool.parameters ?? { type: 'object', properties: {}, additionalProperties: false };
  assertSchema(schema);
  if (schema.type !== 'object') throw Error('tool parameters must be an object schema');
  const reductions: CompiledDialect['reductions'] = [];
  const annotations = new Set(['$schema', '$id', '$comment', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly']);
  const geminiUnsupported = new Set(['allOf', 'oneOf', 'uniqueItems', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minProperties', 'maxProperties']);
  function convert(s: Schema, path: string): Schema {
    const out: Schema = {}; const notes: string[] = [];
    for (const [k, v] of Object.entries(s)) {
      if (annotations.has(k) || (family === 'gemini' && geminiUnsupported.has(k))) {
        reductions.push({ path, keyword: k }); if (!annotations.has(k)) notes.push(`${k}=${JSON.stringify(v)}`); continue;
      }
      if (k === 'properties' && object(v)) out[k] = Object.fromEntries(Object.entries(v).map(([key, sub]) => [key, convert(sub as Schema, `${path}/properties/${key}`)]));
      else if (['anyOf', 'oneOf', 'allOf'].includes(k) && Array.isArray(v)) out[k] = v.map((sub, i) => convert(sub as Schema, `${path}/${k}/${i}`));
      else if ((k === 'items' || k === 'additionalProperties') && object(v)) out[k] = convert(v, `${path}/${k}`);
      else out[k] = structuredClone(v);
    }
    if (family === 'gemini' && Object.hasOwn(out, 'const')) { out.enum = [out.const]; delete out.const; }
    if (strict && out.type === 'object') {
      if (s.additionalProperties !== false) throw Error(`strict objects must be closed at ${path}`);
      const props = object(out.properties) ? out.properties : {};
      const required = (s.required ?? []) as string[];
      for (const [key, sub] of Object.entries(props)) if (!required.includes(key)) {
        const child = sub as Schema;
        props[key] = { anyOf: [child, { type: 'null' }] };
        if (typeof child.type === 'string' && !child.anyOf && !child.enum && !Object.hasOwn(child, 'const')) props[key] = { ...child, type: [child.type, 'null'] };
      }
      out.properties = props; out.required = Object.keys(props); out.additionalProperties = false;
    }
    if (notes.length) out.description = [out.description, `Internal validation constraints: ${notes.join('; ')}`].filter(Boolean).join('\n');
    return out;
  }
  const converted = convert(schema, '');
  const description = tool.description ?? '';
  if (description.length > quirks.maxDescriptionLength) throw Error(`description exceeds ${quirks.maxDescriptionLength}`);
  let wire: Record<string, unknown>;
  if (family === 'openai-chat') wire = { type: 'function', function: { name: tool.name, description, parameters: converted, strict } };
  else if (family === 'openai-responses') wire = { type: 'function', name: tool.name, description, parameters: converted, strict };
  else if (family === 'anthropic') wire = { name: tool.name, description, input_schema: converted };
  else wire = { name: tool.name, description, parametersJsonSchema: converted };
  return { wire, reductions };
}
export function fromRegisteredTool(tool: ToolDescription): ToolDefinition { return { name: tool.name, description: tool.description, parameters: tool.inputSchema as JsonObject }; }
export function compileCatalogue(tools: readonly ToolDefinition[], family: ProviderFamily, modelFamily: string = family): CompiledDialect[] {
  if (tools.length > lookupQuirks(modelFamily).maxTools) throw Error('too many tools for model family');
  if (new Set(tools.map(t => t.name)).size !== tools.length) throw Error('duplicate tool names');
  return tools.map(t => compileDialect(t, family, { modelFamily }));
}
/** Restore only strict-mode null sentinels for originally optional properties. Required/nullable data is preserved. */
export function restoreStrictArguments(schema: Schema, value: unknown): unknown {
  if (object(value) && schema.type === 'object') {
    const props = object(schema.properties) ? schema.properties : {};
    const required = (schema.required ?? []) as string[];
    return Object.fromEntries(Object.entries(value).filter(([key, v]) => !(Object.hasOwn(props, key) && !required.includes(key) && v === null && !validateNullable(props[key] as Schema)))
      .map(([key, v]) => [key, object(props[key]) ? restoreStrictArguments(props[key], v) : v]));
  }
  if (Array.isArray(value) && object(schema.items)) return value.map(v => restoreStrictArguments(schema.items as Schema, v));
  return value;
}
function validateNullable(schema: Schema): boolean {
  return schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null')) ||
    (Array.isArray(schema.enum) && schema.enum.includes(null)) || (Object.hasOwn(schema, 'const') && schema.const === null) ||
    (Array.isArray(schema.anyOf) && schema.anyOf.some(s => object(s) && validateNullable(s)));
}
