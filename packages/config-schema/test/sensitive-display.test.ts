// Public projections preserve JSON structure and use only declared configuration policy.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import * as config from "../src/index.ts";

const MASK = "••••";

test("public configuration projection hides an ordinary marked name without guessing from unmarked names", () => {
  assert.equal(typeof config.redactConfig, "function");
  const secret = randomUUID();
  const schema = {
    properties: {
      ordinary: { type: "string", "x-sensitive": true },
      password: { type: "string" },
      maxTokens: { type: "integer" },
    },
  };
  const value = { ordinary: secret, password: "public-label", maxTokens: 4096, newerField: { enabled: true } };
  const before = structuredClone(value);
  assert.deepEqual(config.redactConfig(value, { schema }), { ...value, ordinary: MASK });
  assert.deepEqual(value, before, "public projection must never alter the running configuration");
});

test("public projection preserves sensitive reference objects, maps and arrays while masking their string leaves", () => {
  const secret = randomUUID();
  const schema = {
    properties: {
      reference: {
        type: "object",
        "x-sensitive": true,
        properties: { source: { type: "string" }, id: { type: "string" } },
      },
      headers: { type: "object", additionalProperties: { type: "string", "x-sensitive": true } },
      rows: {
        type: "array",
        items: { properties: { ordinary: { type: "string", "x-sensitive": true }, enabled: { type: "boolean" } } },
      },
    },
  };
  const value = {
    reference: { source: "env", id: secret },
    headers: Object.fromEntries([
      ["constructor", secret],
      ["__proto__", secret],
    ]),
    rows: [{ ordinary: secret, enabled: true }],
  };
  assert.deepEqual(config.redactConfig(value, { schema }), {
    reference: { source: MASK, id: MASK },
    headers: Object.fromEntries([
      ["constructor", MASK],
      ["__proto__", MASK],
    ]),
    rows: [{ ordinary: MASK, enabled: true }],
  });
});

test("subtree projection retains policy inherited from a marked parent", () => {
  const secret = randomUUID();
  const schema = {
    properties: {
      reference: {
        type: "object",
        "x-sensitive": true,
        properties: { id: { type: "string" } },
      },
    },
  };
  assert.equal(config.redactConfig(secret, { schema, key: "reference.id" }), MASK);
  assert.deepEqual(config.redactConfig({ id: secret }, { schema, key: "reference" }), { id: MASK });
});

test("endpoint projection masks only userinfo and every query value, including array members", () => {
  const secret = randomUUID();
  const schema = {
    properties: {
      endpoints: { type: "array", items: { type: "string", "x-url-credentials": true } },
    },
  };
  const value = {
    endpoints: [
      `https://${secret}:${secret}@relay.example.test/first?ordinary=${secret}&ordinary=${secret}#public`,
      `wss://relay.example.test/second?another=${secret}`,
      "https://relay.example.test/default",
    ],
  };
  assert.deepEqual(config.redactConfig(value, { schema }), {
    endpoints: [
      `https://${MASK}@relay.example.test/first?ordinary=${MASK}&ordinary=${MASK}#public`,
      `wss://relay.example.test/second?another=${MASK}`,
      "https://relay.example.test/default",
    ],
  });
});

test("the default public projection applies known opaque Engine metadata without hiding public controls", () => {
  const secret = randomUUID();
  const value = {
    engine: { embedding: { apiKey: secret, baseUrl: `https://relay.example.test/embed?ordinary=${secret}` } },
    modelProfiles: { primary: { params: { maxTokens: 4096 } } },
    unknown: { newer: true },
  };
  assert.deepEqual(config.redactConfig(value), {
    engine: { embedding: { apiKey: MASK, baseUrl: `https://relay.example.test/embed?ordinary=${MASK}` } },
    modelProfiles: { primary: { params: { maxTokens: 4096 } } },
    unknown: { newer: true },
  });
});
