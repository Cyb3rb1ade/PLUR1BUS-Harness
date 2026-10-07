import { it } from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { CONFIG_SCHEMA } from "../src/index.ts";

function schemaNodes(root: Record<string, any>): { node: Record<string, any>; path: string }[] {
  const nodes: { node: Record<string, any>; path: string }[] = [];
  const seen = new Set<object>();

  function visit(node: unknown, path: string): void {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const schema = node as Record<string, any>;
    nodes.push({ node: schema, path });

    for (const keyword of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
      for (const [key, child] of Object.entries(schema[keyword] ?? {})) {
        visit(child, `${path}/${keyword}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
      }
    }
    for (const keyword of ["additionalProperties", "items", "contains", "propertyNames", "not", "if", "then", "else"]) {
      visit(schema[keyword], `${path}/${keyword}`);
    }
    for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      for (const [index, child] of (schema[keyword] ?? []).entries()) visit(child, `${path}/${keyword}/${index}`);
    }
  }

  visit(root, "#");
  return nodes;
}

function ajvForSchema(): any {
  const ajv = new ((Ajv2020 as any).default ?? Ajv2020)({ strict: false, allErrors: true });
  ((addFormats as any).default ?? addFormats)(ajv);
  return ajv;
}

it("documents every field and schema-backed map value", () => {
  function checkFields(node: Record<string, any>, path: string): void {
    for (const [key, field] of Object.entries<Record<string, any>>(node.properties ?? {})) {
      assert.ok(
        typeof field.description === "string" && field.description.trim(),
        `${path}/properties/${key} needs a description`,
      );
      checkFields(field, `${path}/properties/${key}`);
    }
    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      assert.ok(
        typeof node.additionalProperties.description === "string" && node.additionalProperties.description.trim(),
        `${path}/additionalProperties needs a description`,
      );
      checkFields(node.additionalProperties, `${path}/additionalProperties`);
    }
    if (node.items && typeof node.items === "object") checkFields(node.items, `${path}/items`);
    for (const [index, item] of (node.prefixItems ?? []).entries()) checkFields(item, `${path}/prefixItems/${index}`);
    for (const [pattern, field] of Object.entries<Record<string, any>>(node.patternProperties ?? {})) {
      assert.ok(typeof field.description === "string" && field.description.trim(), `${path}/patternProperties/${pattern} needs a description`);
      checkFields(field, `${path}/patternProperties/${pattern}`);
    }
  }

  checkFields(CONFIG_SCHEMA, "#");
});

it("keeps every declared default valid against its field schema", () => {
  const ajv = ajvForSchema();
  ajv.addSchema(CONFIG_SCHEMA);
  for (const { node, path } of schemaNodes(CONFIG_SCHEMA)) {
    if (!Object.hasOwn(node, "default")) continue;
    const validateDefault = ajv.compile({ $ref: `${CONFIG_SCHEMA.$id}${path}` });
    assert.ok(validateDefault(node.default), `${path}/default is invalid: ${ajv.errorsText(validateDefault.errors)}`);
  }
});

function enumKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(enumKey).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${enumKey((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

it("has no unresolved references or duplicate enum values", () => {
  const ajv = ajvForSchema();
  assert.doesNotThrow(() => ajv.compile(CONFIG_SCHEMA), "schema references must resolve");

  for (const { node, path } of schemaNodes(CONFIG_SCHEMA)) {
    if (node.enum) {
      const values = node.enum.map(enumKey);
      assert.equal(new Set(values).size, values.length, `${path}/enum contains duplicates`);
    }
  }
});
