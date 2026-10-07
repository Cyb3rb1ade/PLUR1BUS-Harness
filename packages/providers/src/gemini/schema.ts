import { isDeepStrictEqual } from "node:util";
import { ProviderError } from "../errors.ts";
import type { JsonObject, JsonValue } from "../types.ts";

/**
 * Tool JSON Schema -> the schema sent to Gemini as `functionDeclarations[].parametersJsonSchema`.
 *
 * Gemini answers a JSON-Schema feature it does not support with an opaque HTTP 400. This module therefore (a) reduces
 * a schema only where the reduction cannot change which arguments are valid, and (b) refuses everything else
 * before any I/O, with an `invalid_request` error naming the tool and the schema path. It cannot be verified against
 * the live API from here, so every rule is conservative: when in doubt, refuse. The caller's schema is never mutated
 * and kept keys keep the caller's order (same schema, same bytes: the request prefix stays cache-stable).
 */

export const MAX_SCHEMA_DEPTH = 32;
export const MAX_SCHEMA_NODES = 5000;

const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

// RULING: pure annotations. They never change which instances are valid, so dropping them is safe (and `default` /
// `examples` would only be echoed back to us, never enforced, by Gemini).
const DROP = new Set(["$schema", "$id", "$comment", "examples", "default", "deprecated", "readOnly", "writeOnly", "contentMediaType", "contentEncoding"]);
const DEFS = new Set(["$defs", "definitions"]);
const STRING_KEYWORDS = new Set(["description", "title", "format", "pattern"]);
const NUMBER_KEYWORDS = new Set(["minimum", "maximum"]);
const COUNT_KEYWORDS = new Set(["minItems", "maxItems", "minLength", "maxLength"]);
// RULING: keywords that constrain validity in a way Gemini cannot express. Dropping them would let the model produce
// arguments the caller's schema forbids and, worse, silently; so they are refused, never dropped.
const REFUSED = new Set([
  "patternProperties", "if", "then", "else", "not", "dependentSchemas", "dependentRequired", "dependencies",
  "unevaluatedProperties", "unevaluatedItems", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "propertyNames", "contains",
]);
const REF_SIBLINGS_OK = new Set(["description", "title", ...DROP, ...DEFS]);
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const LOCAL_REF = /^#\/(\$defs|definitions)\/([^/]+)$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Own-property write that is safe for a key like `__proto__` (a plain assignment would change the prototype). */
function put(o: JsonObject, k: string, v: JsonValue): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function sub(path: string, key: string): string {
  return IDENT.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

class Converter {
  nodes = 0;
  readonly #active: string[] = [];
  readonly root: Record<string, unknown>;
  readonly where: string;
  constructor(root: Record<string, unknown>, where: string) {
    this.root = root;
    this.where = where;
  }

  fail(path: string, msg: string): ProviderError {
    return new ProviderError("invalid_request", `${this.where}: ${path} ${msg}`);
  }

  /** Deep copy of a JSON value (enum members); anything that is not plain JSON is refused. */
  copy(v: unknown, path: string, depth = 0): JsonValue {
    if (depth > MAX_SCHEMA_DEPTH * 2) throw this.fail(path, "is nested too deeply");
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw this.fail(path, "must be a finite number");
      return v;
    }
    if (Array.isArray(v)) return v.map((x, i) => this.copy(x, `${path}[${i}]`, depth + 1));
    if (isObj(v)) {
      const o: JsonObject = {};
      for (const k of Object.keys(v)) put(o, k, this.copy(v[k], sub(path, k), depth + 1));
      return o;
    }
    throw this.fail(path, "is not a JSON value");
  }

  convert(node: unknown, path: string, depth: number): JsonObject {
    if (!isObj(node)) throw this.fail(path, "must be a JSON Schema object");
    if (depth > MAX_SCHEMA_DEPTH) throw this.fail(path, `exceeds the maximum schema depth of ${MAX_SCHEMA_DEPTH}`);
    if (++this.nodes > MAX_SCHEMA_NODES) throw this.fail(path, `exceeds the maximum of ${MAX_SCHEMA_NODES} schema nodes (after inlining references)`);
    if ("$ref" in node) return this.ref(node, path, depth);

    if ("anyOf" in node && "oneOf" in node) throw this.fail(path, "has both anyOf and oneOf, which cannot be reduced to one anyOf");
    if ("const" in node && "enum" in node) throw this.fail(path, "has both const and enum, which is not supported by Gemini");
    const out: JsonObject = {};
    for (const k of Object.keys(node)) {
      const v = node[k];
      const at = sub(path, k);
      if (DROP.has(k) || DEFS.has(k)) continue; // $defs/definitions: only needed while inlining refs; unreferenced ones are never sent
      if (REFUSED.has(k)) throw this.fail(at, "is not supported by Gemini");
      if (STRING_KEYWORDS.has(k)) {
        if (typeof v !== "string") throw this.fail(at, "must be a string");
        put(out, k, v);
        continue;
      }
      if (NUMBER_KEYWORDS.has(k)) {
        if (typeof v !== "number" || !Number.isFinite(v)) throw this.fail(at, "must be a finite number");
        put(out, k, v);
        continue;
      }
      if (COUNT_KEYWORDS.has(k)) {
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw this.fail(at, "must be a non-negative integer");
        put(out, k, v);
        continue;
      }
      switch (k) {
        case "type":
          put(out, k, this.type(v, at));
          break;
        case "properties": {
          if (!isObj(v)) throw this.fail(at, "must be an object of schemas");
          const props: JsonObject = {};
          for (const name of Object.keys(v)) put(props, name, this.convert(v[name], sub(at, name), depth + 1));
          put(out, k, props);
          break;
        }
        case "required":
          if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw this.fail(at, "must be an array of strings");
          put(out, k, [...(v as string[])]);
          break;
        case "items":
          // RULING: only the single-schema form. Tuple form (an array) and boolean schemas are not understood by Gemini.
          put(out, k, this.convert(v, at, depth + 1));
          break;
        case "enum":
          if (!Array.isArray(v) || v.length === 0) throw this.fail(at, "must be a non-empty array");
          put(out, k, v.map((x, i) => this.copy(x, `${at}[${i}]`)));
          break;
        case "const":
          // RULING: `const: v` is exactly `enum: [v]` in JSON Schema; the enum form is the one Gemini documents.
          put(out, "enum", [this.copy(v, at)]);
          break;
        case "anyOf":
        case "oneOf":
          // RULING: oneOf -> anyOf is an APPROXIMATION: oneOf demands exactly one matching branch, anyOf at least one,
          // and Gemini has no exclusivity. It is accepted because it only ever WIDENS what the model may send (never
          // rejects an argument set the caller allows) and the tool executor validates the arguments against the
          // real schema anyway; refusing would make every oneOf-typed tool (common for discriminated unions) unusable.
          if (!Array.isArray(v) || v.length === 0) throw this.fail(at, "must be a non-empty array of schemas");
          put(out, "anyOf", v.map((b, i) => this.convert(b, `${at}[${i}]`, depth + 1)));
          break;
        case "additionalProperties":
          put(out, k, typeof v === "boolean" ? v : this.convert(v, at, depth + 1));
          break;
        case "allOf":
          break; // merged below, once the sibling keywords are in place
        default:
          throw this.fail(at, "is not a keyword this adapter knows; it is refused instead of being forwarded to Gemini");
      }
    }
    if ("allOf" in node) this.allOf(node["allOf"], out, path, depth);
    return out;
  }

  type(v: unknown, at: string): JsonValue {
    if (typeof v === "string") {
      if (!TYPES.has(v)) throw this.fail(at, `has unknown type "${v}"`);
      return v;
    }
    // RULING: a type ARRAY is kept as is (valid JSON Schema, which is what `parametersJsonSchema` takes; `nullable: true`
    // is OpenAPI vocabulary and not JSON Schema, so rewriting to it would risk exactly the 400 this module prevents)
    // but ONLY for the optional-value shape [T, "null"] / ["null", T]. Wider unions are refused: they have to be
    // written as anyOf, whose support is documented.
    if (Array.isArray(v) && v.length === 2 && v.every((t) => typeof t === "string" && TYPES.has(t)) && v.includes("null") && v[0] !== v[1]) return [...(v as string[])];
    throw this.fail(at, "must be a type name or a [type, \"null\"] pair; use anyOf for other unions");
  }

  ref(node: Record<string, unknown>, path: string, depth: number): JsonObject {
    for (const k of Object.keys(node)) {
      if (k !== "$ref" && !REF_SIBLINGS_OK.has(k)) throw this.fail(path, `has ${k} next to $ref, which is not supported by Gemini`);
    }
    const ref = node["$ref"];
    if (typeof ref !== "string") throw this.fail(sub(path, "$ref"), "must be a string");
    // RULING: only `#/$defs/<name>` and `#/definitions/<name>` are inlined. A remote reference would need a fetch (I/O
    // before the request, on the schema author's say-so); other local pointers (`#/properties/x`, `#`) are refused
    // rather than guessed at.
    const m = LOCAL_REF.exec(ref);
    if (!m) throw this.fail(sub(path, "$ref"), `"${ref.slice(0, 80)}" is not supported by Gemini (only #/$defs/<name> and #/definitions/<name> are inlined)`);
    let name: string;
    try { name = decodeURIComponent(m[2]!).replace(/~1/g, "/").replace(/~0/g, "~"); } catch { throw this.fail(sub(path, "$ref"), `"${ref.slice(0, 80)}" is malformed`); }
    const table = this.root[m[1]!];
    if (!isObj(table) || !Object.hasOwn(table, name)) throw this.fail(sub(path, "$ref"), `"${ref.slice(0, 80)}" does not resolve`);
    // RULING: a recursive schema cannot be inlined into a finite one, and truncating it at some depth would change
    // what is valid; refused instead.
    if (this.#active.includes(ref)) throw this.fail(sub(path, "$ref"), `"${ref.slice(0, 80)}" is recursive, which Gemini cannot express`);
    this.#active.push(ref);
    let target: JsonObject;
    try { target = this.convert(table[name], path, depth); } finally { this.#active.pop(); }
    // Siblings that are annotations: description/title next to $ref describe the use site and win over the target's.
    for (const k of ["title", "description"]) {
      const v = node[k];
      if (v === undefined) continue;
      if (typeof v !== "string") throw this.fail(sub(path, k), "must be a string");
      put(target, k, v);
    }
    return target;
  }

  /**
   * RULING: allOf is merged only when every branch is a plain object schema (type object or untyped; only properties,
   * required, description, title). Then "satisfies all branches" equals "one object with the union of the properties
   * and required lists", provided no property is defined twice differently (refused: intersecting two definitions
   * is not a merge). Branches with additionalProperties, anyOf, enum, ... are refused: merging them would change meaning.
   */
  allOf(v: unknown, out: JsonObject, path: string, depth: number): void {
    const at = sub(path, "allOf");
    if (!Array.isArray(v) || v.length === 0) throw this.fail(at, "must be a non-empty array of schemas");
    const t = out["type"];
    if (t !== undefined && t !== "object") throw this.fail(at, "can only be merged into an object schema");
    let props = out["properties"] as JsonObject | undefined;
    let required = out["required"] as string[] | undefined;
    v.forEach((raw, i) => {
      const bp = `${at}[${i}]`;
      const b = this.convert(raw, bp, depth + 1);
      for (const k of Object.keys(b)) {
        if (!["type", "properties", "required", "description", "title"].includes(k)) throw this.fail(bp, `is not a plain object schema (has ${k}); allOf is not supported by Gemini unless every branch is`);
      }
      if (b["type"] !== undefined && b["type"] !== "object") throw this.fail(bp, "is not an object schema; allOf is not supported by Gemini unless every branch is");
      for (const [name, def] of Object.entries((b["properties"] as JsonObject | undefined) ?? {})) {
        props ??= {};
        if (Object.hasOwn(props, name) && !isDeepStrictEqual(props[name], def)) throw this.fail(sub(sub(bp, "properties"), name), `conflicts with another definition of "${name}" in the same allOf`);
        put(props, name, def);
      }
      for (const r of (b["required"] as string[] | undefined) ?? []) {
        required ??= [];
        if (!required.includes(r)) required.push(r);
      }
      for (const k of ["title", "description"]) if (typeof b[k] === "string" && out[k] === undefined) put(out, k, b[k]!);
    });
    put(out, "type", "object");
    if (props !== undefined) put(out, "properties", props);
    if (required !== undefined) put(out, "required", required);
  }
}

/**
 * Converts one tool's `parameters` schema; `where` names the tool in errors (`tools[0] "search"`). Throws
 * `ProviderError("invalid_request", "<where>: parameters.<path> ... is not supported by Gemini")` for anything it
 * cannot send safely. Pure: the input is not modified.
 */
export function convertToolSchema(schema: JsonObject, where: string): JsonObject {
  if (!isObj(schema)) throw new ProviderError("invalid_request", `${where}: parameters must be a JSON Schema object`);
  return new Converter(schema, where).convert(schema, "parameters", 1);
}
