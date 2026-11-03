// Independent review guards: reference-shaped keys and the reviewed privacy inventory cannot silently drift.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_SCHEMA } from "../src/index.ts";
import { configNodes } from "./helpers/sensitive-schema.ts";
import snapshot from "./fixtures/marked-policy-keys.json" with { type: "json" };

const REFERENCE_EXCEPTIONS: Readonly<Record<string, string>> = {
  "channels.telegram.webhook.secret": "Literal per-webhook authentication token, regenerated on ordinary restore.",
};
test("every reference-shaped field declares reference metadata or a justified literal exception", () => {
  const rows = configNodes(CONFIG_SCHEMA);
  const candidates = rows.filter(({ key }) => /(?:ref|secret(?:name|ref)?|(?:key|token|password)env)$/i.test(key));
  const missing = candidates.filter(({ key, node }) => !Object.hasOwn(node, "x-secret-reference") &&
    !Object.hasOwn(REFERENCE_EXCEPTIONS, key)).map(({ key }) => key);
  assert.deepEqual(missing, []);
  for (const [key, reason] of Object.entries(REFERENCE_EXCEPTIONS)) {
    assert.ok(reason.length > 25);
    assert.ok(candidates.some(row => row.key === key), `stale reference exception ${key}`);
  }
  const engineInputs = rows.filter(({ key, node }) => key.startsWith("engine.") &&
    Array.isArray(node.type) && node.type.includes("object") && node.properties?.source && node.properties.id);
  assert.ok(engineInputs.length >= 4, "Engine reference unions remain covered");
  for (const { key, node } of engineInputs) assert.ok(Object.hasOwn(node, "x-secret-reference"), key);
});
test("reviewed sensitive and URL classifications match the frozen inventory", () => {
  const rows = configNodes(CONFIG_SCHEMA);
  assert.deepEqual({
    sensitive: rows.filter(row => row.node["x-sensitive"] === true).map(row => row.key).sort(),
    urlCredentials: rows.filter(row => row.node["x-url-credentials"] === true).map(row => row.key).sort(),
  }, snapshot);
});
