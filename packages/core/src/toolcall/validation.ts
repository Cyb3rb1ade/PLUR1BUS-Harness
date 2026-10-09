import { isDeepStrictEqual } from 'node:util';
import { lookupQuirks } from './quirks.ts';
import type { ValidationIssue, RepairRequest, ToolCallInvalid } from '../tools/repair.ts';
import type { ToolErrorCode } from '../tools/dispatcher.ts';
export type { ValidationIssue };
export type Schema = Record<string, unknown>;
export interface RepairRecord { kind: 'unwrap-json-string' | 'trailing-comma' | 'numeric-string'; path: string }
export type ModelRepairPort = (request: RepairRequest) => Promise<unknown>;
export type PreparedCall = { repairs: RepairRecord[]; repairRounds: 0 | 1 } &
  ({ ok: true; arguments: unknown } | { ok: false; error: ToolCallInvalid['error'] });
const SUPPORTED = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'anyOf', 'oneOf', 'allOf', 'minProperties', 'maxProperties', 'description', 'title', '$schema', '$id', '$comment', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly']);
export const object = (v: unknown): v is Schema => v !== null && typeof v === 'object' && !Array.isArray(v);
export const pointer = (p: string, key: string): string => `${p}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
const typeOf = (v: unknown): string => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const matches = (t: unknown, v: unknown): boolean => t === 'integer' ? typeof v === 'number' && Number.isSafeInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === typeOf(v);
/** Validate schema vocabulary before accepting arguments: unknown constraints must never silently pass. */
export function assertSchema(s: unknown, depth = 0): asserts s is Schema {
  if (!object(s) || depth > 32) throw Error('invalid or overly deep tool schema');
  for (const [k, v] of Object.entries(s)) {
    if (!SUPPORTED.has(k)) throw Error(`unsupported schema keyword: ${k}`);
    if (k === 'properties') { if (!object(v)) throw Error('invalid properties'); for (const sub of Object.values(v)) assertSchema(sub, depth + 1); }
    if (k === 'items' || (k === 'additionalProperties' && object(v))) assertSchema(v, depth + 1);
    if (['anyOf', 'oneOf', 'allOf'].includes(k)) { if (!Array.isArray(v) || !v.length) throw Error(`invalid ${k}`); for (const sub of v) assertSchema(sub, depth + 1); }
    if (k === 'pattern') { if (typeof v !== 'string') throw Error('invalid pattern'); new RegExp(v, 'u'); }
    if (k === 'type') { const types = Array.isArray(v) ? v : [v]; if (!types.length || types.some(t => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(t as string))) throw Error('invalid type'); }
    if (k === 'required' && (!Array.isArray(v) || v.some(x => typeof x !== 'string'))) throw Error('invalid required');
    if (k === 'enum' && (!Array.isArray(v) || !v.length)) throw Error('invalid enum');
    if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'].includes(k) && (typeof v !== 'number' || !Number.isFinite(v))) throw Error(`invalid ${k}`);
    if (['uniqueItems', 'deprecated', 'readOnly', 'writeOnly'].includes(k) && typeof v !== 'boolean') throw Error(`invalid ${k}`);
    if (k === 'additionalProperties' && typeof v !== 'boolean' && !object(v)) throw Error('invalid additionalProperties');
  }
}
function check(s: Schema, v: unknown, path: string, out: ValidationIssue[], depth: number): void {
  const issue = (expected: string, message = `expected ${expected}`) => { const shown = JSON.stringify(v); out.push({ path, expected, got: (shown ?? typeOf(v)).slice(0, 80), message }); };
  if (depth > 64) { issue('bounded JSON value'); return; }
  if (s.type !== undefined && !(Array.isArray(s.type) ? s.type : [s.type]).some(t => matches(t, v))) { issue(String(s.type)); return; }
  if (Array.isArray(s.enum) && !s.enum.some(e => isDeepStrictEqual(e, v))) issue(`one of ${JSON.stringify(s.enum)}`);
  if (Object.hasOwn(s, 'const') && !isDeepStrictEqual(s.const, v)) issue(JSON.stringify(s.const));
  for (const k of ['anyOf', 'oneOf', 'allOf'] as const) if (Array.isArray(s[k])) {
    const good = s[k].filter(sub => { const errors: ValidationIssue[] = []; check(sub as Schema, v, path, errors, depth + 1); return errors.length === 0; }).length;
    if ((k === 'anyOf' && good === 0) || (k === 'oneOf' && good !== 1) || (k === 'allOf' && good !== s[k].length)) issue(k);
  }
  if (object(v)) {
    const props = object(s.properties) ? s.properties : {};
    for (const key of (s.required ?? []) as string[]) if (!Object.hasOwn(v, key)) out.push({ path: pointer(path, key), expected: 'required value', got: 'missing', message: 'required property missing' });
    for (const [key, val] of Object.entries(v)) {
      if (Object.hasOwn(props, key)) check(props[key] as Schema, val, pointer(path, key), out, depth + 1);
      else if (s.additionalProperties === false) out.push({ path: pointer(path, key), expected: 'no additional property', got: typeOf(val), message: 'unknown property' });
      else if (object(s.additionalProperties)) check(s.additionalProperties, val, pointer(path, key), out, depth + 1);
    }
    if (typeof s.minProperties === 'number' && Object.keys(v).length < s.minProperties) issue(`at least ${s.minProperties} properties`);
    if (typeof s.maxProperties === 'number' && Object.keys(v).length > s.maxProperties) issue(`at most ${s.maxProperties} properties`);
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems) issue(`at least ${s.minItems} items`);
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) issue(`at most ${s.maxItems} items`);
    if (s.uniqueItems === true && v.some((x, i) => v.slice(0, i).some(y => isDeepStrictEqual(x, y)))) issue('unique items');
    if (object(s.items)) v.forEach((x, i) => check(s.items as Schema, x, pointer(path, String(i)), out, depth + 1));
  }
  if (typeof v === 'string') {
    const n = [...v].length;
    if (typeof s.minLength === 'number' && n < s.minLength) issue(`at least ${s.minLength} characters`);
    if (typeof s.maxLength === 'number' && n > s.maxLength) issue(`at most ${s.maxLength} characters`);
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(v)) issue(`pattern ${s.pattern}`);
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) issue('finite number');
    if (typeof s.minimum === 'number' && v < s.minimum) issue(`>= ${s.minimum}`);
    if (typeof s.maximum === 'number' && v > s.maximum) issue(`<= ${s.maximum}`);
    if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) issue(`> ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) issue(`< ${s.exclusiveMaximum}`);
    if (typeof s.multipleOf === 'number' && (s.multipleOf <= 0 || Math.abs(v / s.multipleOf - Math.round(v / s.multipleOf)) > 1e-10)) issue(`multiple of ${s.multipleOf}`);
  }
}
export function validateArguments(schema: Schema, value: unknown): ValidationIssue[] {
  assertSchema(schema); const issues: ValidationIssue[] = [];
  let nodes = 0; const active = new Set<object>();
  const json = (v: unknown, depth: number): boolean => {
    if (++nodes > 20000 || depth > 64) return false;
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v !== 'object' || active.has(v)) return false;
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return false;
    active.add(v); const valid = Object.values(v).every(x => json(x, depth + 1)); active.delete(v); return valid;
  };
  if (!json(value, 0)) return [{ path: '', expected: 'bounded finite acyclic JSON', got: typeOf(value), message: 'invalid JSON arguments' }];
  check(schema, value, '', issues, 0); return issues;
}
/** Scan JSON tokens, so a comma inside a quoted string is never changed. */
function trailingCommas(text: string): string {
  let quoted = false, escaped = false, out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) { out += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    if (c === ',' && /^[\s]*[}\]]/.test(text.slice(i + 1))) continue;
    out += c;
  }
  return out;
}
function normalize(s: Schema, v: unknown, path: string, log: RepairRecord[], allowed: readonly string[], depth = 0): unknown {
  if (depth > 64) return v;
  if (allowed.includes('numeric-string') && (s.type === 'integer' || s.type === 'number') && typeof v === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v)) {
    const n = Number(v); if (matches(s.type, n)) { log.push({ kind: 'numeric-string', path }); return n; }
  }
  if (object(v) && object(s.properties)) return Object.fromEntries(Object.entries(v).map(([key, val]) => [key, object((s.properties as Schema)[key]) ? normalize((s.properties as Schema)[key] as Schema, val, pointer(path, key), log, allowed, depth + 1) : val]));
  if (Array.isArray(v) && object(s.items)) return v.map((val, i) => normalize(s.items as Schema, val, pointer(path, String(i)), log, allowed, depth + 1));
  return v;
}
function decode(raw: unknown, s: Schema, log: RepairRecord[], allowed: readonly string[]): { value: unknown; issues: ValidationIssue[] } {
  let value = raw;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw) > 256 * 1024) return { value: undefined, issues: [{ path: '', expected: 'arguments <= 256 KiB', got: 'oversized', message: 'arguments too large' }] };
    let text = raw;
    for (let round = 0; round < 2; round++) {
      const fixed = allowed.includes('trailing-comma') ? trailingCommas(text) : text; if (fixed !== text) log.push({ kind: 'trailing-comma', path: '' });
      try { value = JSON.parse(fixed); } catch { return { value: raw, issues: [{ path: '', expected: 'valid JSON', got: 'invalid JSON', message: 'JSON parse failed' }] }; }
      if (!allowed.includes('unwrap-json-string') || typeof value !== 'string' || s.type === 'string' || round === 1) break;
      log.push({ kind: 'unwrap-json-string', path: '' }); text = value;
    }
  }
  const safety = validateArguments({}, value); if (safety.length) return { value, issues: safety };
  value = normalize(s, value, '', log, allowed); return { value, issues: validateArguments(s, value) };
}
export async function prepareCall(name: string, schema: Schema, raw: unknown, repair?: ModelRepairPort, modelFamily = 'unknown'): Promise<PreparedCall> {
  assertSchema(schema); const repairs: RepairRecord[] = []; const quirks = lookupQuirks(modelFamily); const allowed = quirks.malformedArguments; let decoded = decode(raw, schema, repairs, allowed); let repairRounds: 0 | 1 = 0;
  if (decoded.issues.length && repair) {
    repairRounds = 1;
    const message = `Correct arguments for ${name}. Return JSON only. Known ${modelFamily} slips: ${allowed.join(', ')}.\n${decoded.issues.map(i => `${i.path || '(arguments)'}: expected ${i.expected}; got ${i.got}`).join('\n')}`;
    try { decoded = decode(await repair({ tool: name, args: decoded.value, issues: decoded.issues, message }), schema, repairs, allowed); } catch { /* failed repair retains the initial structured issues */ }
  }
  if (!decoded.issues.length) return { ok: true, arguments: decoded.value, repairs, repairRounds };
  const code: ToolErrorCode = 'tool-call-invalid';
  return { ok: false, repairs, repairRounds, error: { code, message: `Invalid arguments for ${name}`, hint: 'Use the input schema to correct the listed fields.', issues: decoded.issues } };
}
