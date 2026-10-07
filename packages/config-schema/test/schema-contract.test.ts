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
        visit(child, `${path}/${keyword}/${key}`);
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

function ajvForSchema(): InstanceType<typeof Ajv2020> {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv;
}

it("documents every field and schema-backed map value", () => {
  function checkFields(node: Record<string, any>, path: string): void {
    for (const [key, field] of Object.entries<Record<string, any>>(node.properties ?? {})) {
      const fieldPath = `${path}.${key}`;
      assert.ok(typeof field.description === "string" && field.description.trim(), `${fieldPath} needs a description`);
      checkFields(field, fieldPath);
    }

    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      const pathForValue = `${path}.*`;
      assert.ok(
        typeof node.additionalProperties.description === "string" && node.additionalProperties.description.trim(),
        `${pathForValue} needs a description`,
      );
      checkFields(node.additionalProperties, pathForValue);
    }
  }

  checkFields(CONFIG_SCHEMA, "config");
});

it("keeps every declared default valid against its field schema", () => {
  const ajv = ajvForSchema();
  for (const { node, path } of schemaNodes(CONFIG_SCHEMA)) {
    if (!Object.hasOwn(node, "default")) continue;
    const validateDefault = ajv.compile(node);
    assert.ok(validateDefault(node.default), `${path}/default is invalid: ${ajv.errorsText(validateDefault.errors)}`);
  }
});

it("has no unresolved references or duplicate enum values", () => {
  const ajv = ajvForSchema();
  assert.doesNotThrow(() => ajv.compile(CONFIG_SCHEMA), "schema references must resolve");

  for (const { node, path } of schemaNodes(CONFIG_SCHEMA)) {
    if (node.enum) {
      const values = node.enum.map((value: unknown) => JSON.stringify(value));
      assert.equal(new Set(values).size, values.length, `${path}/enum contains duplicates`);
    }
  }
});
