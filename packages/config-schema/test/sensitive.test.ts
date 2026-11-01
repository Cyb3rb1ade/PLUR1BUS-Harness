// Coverage guards pin the declared policy independently of runtime credential-name guesses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_SCHEMA } from "../src/index.ts";
import {
  configNodes,
  legacySecretKey,
  PUBLIC_EXCEPTIONS,
  URL_EXCEPTIONS,
  urlField,
  type SchemaNode,
} from "./helpers/sensitive-schema.ts";

test("every legacy secret-key candidate is sensitive or explicitly justified as public", () => {
  const nodes = configNodes(CONFIG_SCHEMA);
  const missing = nodes
    .filter(({ key, sensitive }) => legacySecretKey(key) && !sensitive && !Object.hasOwn(PUBLIC_EXCEPTIONS, key))
    .map(({ key }) => key);
  assert.deepEqual(missing, [], "annotate secret-bearing fields or justify the exact public exception");
  for (const [key, reason] of Object.entries(PUBLIC_EXCEPTIONS)) {
    assert.ok(reason.trim().length > 15, `${key}: exception needs a reason`);
    assert.ok(
      nodes.some((node) => node.key === key && legacySecretKey(key) && !node.sensitive),
      `${key}: stale public exception`,
    );
  }
});

function secretShape(node: SchemaNode): boolean {
  if (Array.isArray(node.type))
    return node.type.length > 0 && node.type.every((type: string) => secretShape({ ...node, type }));
  if (node.type === "string" || node.enum?.every((value: unknown) => typeof value === "string")) return true;
  if (node.type !== "object" || node.additionalProperties === true) return false;
  const children = Object.values<SchemaNode>(node.properties ?? {});
  if (node.additionalProperties && typeof node.additionalProperties === "object")
    children.push(node.additionalProperties);
  return children.length > 0 && children.every(secretShape);
}

test("sensitivity annotations are boolean and mark only strings or objects of strings", () => {
  const nodes = configNodes(CONFIG_SCHEMA);
  const marked = nodes.filter(({ node }) => Object.hasOwn(node, "x-sensitive"));
  assert.ok(marked.length > 1, "the schema must cover more than the original Telegram header");
  for (const { key, node } of marked) {
    assert.equal(typeof node["x-sensitive"], "boolean", key);
    if (node["x-sensitive"]) assert.ok(secretShape(node), `${key}: numeric, boolean and mixed objects are not secrets`);
  }
  for (const field of nodes.filter(({ node }) => Object.hasOwn(node, "x-url-credentials"))) {
    assert.equal(typeof field.node["x-url-credentials"], "boolean", field.key);
    if (field.node["x-url-credentials"])
      assert.ok(urlField(field), `${field.key}: URL credentials require a URL field`);
  }
});

test("every URL field has exactly one documented credential classification", () => {
  const urls = configNodes(CONFIG_SCHEMA).filter(urlField);
  assert.ok(urls.length >= 20, "inspect every endpoint, including privacy acknowledgments and map/array fields");
  for (const field of urls) {
    const { key, node, sensitive, urlCredentials } = field;
    assert.equal(
      Number(sensitive) + Number(urlCredentials) + Number(Object.hasOwn(URL_EXCEPTIONS, key)),
      1,
      `${key}: exactly one URL classification is required`,
    );
    if (Object.hasOwn(node, "x-url-credentials")) assert.equal(typeof node["x-url-credentials"], "boolean", key);
  }
  for (const [key, reason] of Object.entries(URL_EXCEPTIONS)) {
    assert.ok(reason.trim().length > 15);
    assert.ok(
      urls.some((field) => field.key === key && !field.sensitive && !field.urlCredentials),
      `${key}: stale URL exception`,
    );
  }
});

test("the URL inventory includes relay arrays and their members even without URL in the description", () => {
  const nodes = configNodes(CONFIG_SCHEMA);
  for (const key of ["channels.buzz.relays", "channels.buzz.relays[]"]) {
    const field = nodes.find((node) => node.key === key);
    assert.ok(field);
    assert.ok(urlField(field), `${key}: relay URLs must be inventoried`);
    assert.equal(field.urlCredentials, true);
    assert.equal(field.sensitive, false);
  }
});
