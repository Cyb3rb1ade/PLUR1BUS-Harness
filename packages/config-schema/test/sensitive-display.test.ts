// Public projections preserve JSON structure and use only declared configuration policy.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import * as publicConfig from "../src/index.ts";
import { configSecretEntries } from "../src/sensitive.ts";
const config = { ...publicConfig, configSecretEntries };

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
      `https://${MASK}@relay.example.test/first?ordinary=${MASK}&ordinary=${MASK}#${MASK}`,
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

test("a malformed scalar in an opaque secret slot is concealed without changing its JSON type", () => {
  const secret = Number.parseInt(randomUUID().slice(0, 8), 16) + 100_000_000;
  const value = { engine: { embedding: { apiKey: secret } } };
  const projected = config.redactConfig(value) as typeof value;
  assert.equal(projected.engine.embedding.apiKey, 0);
  assert.equal(typeof projected.engine.embedding.apiKey, "number");
  assert.ok(config.configSecretEntries(value).some((entry) => entry.value === String(secret)));
  assert.equal(value.engine.embedding.apiKey, secret);
  const schema = { properties: { ordinary: { type: "string", "x-sensitive": true }, enabled: { type: "boolean" } } };
  assert.deepEqual(config.redactConfig({ ordinary: true, enabled: true }, { schema }), { ordinary: false, enabled: true });
});

test("malformed homogeneous collections retain their shape and declared item or map secrecy", () => {
  const secrets = [randomUUID(), randomUUID(), randomUUID()];
  const schema = {
    properties: {
      batch: { type: "array", items: { properties: {
        ordinary: { type: "string", "x-sensitive": true }, enabled: { type: "boolean" },
      } } },
      secrets: { type: "array", items: { type: "string", "x-sensitive": true } },
      headers: { type: "object", additionalProperties: { type: "string", "x-sensitive": true } },
    },
  };
  const value = { batch: { 0: { ordinary: secrets[0], enabled: true } }, secrets: { 0: secrets[1] }, headers: [secrets[2]] };
  assert.deepEqual(config.redactConfig(value, { schema }), {
    batch: { 0: { ordinary: MASK, enabled: true } }, secrets: { 0: MASK }, headers: [MASK],
  });
  for (const secret of secrets) assert.ok(config.configSecretEntries(value, schema).some((entry) => entry.value === secret));
});

test("diagnostic projection protects legacy OTLP headers without accepting the retired configuration", () => {
  const secret = randomUUID();
  const value = { logs: { otlp: { headers: { ordinary: secret }, endpoint: `https://relay.example.test/trace?ordinary=${secret}` } } };
  assert.equal(config.sensitiveOf("logs.otlp.headers.ordinary"), true);
  assert.deepEqual(config.redactConfig(value), {
    logs: { otlp: { headers: { ordinary: MASK }, endpoint: `https://relay.example.test/trace?ordinary=${MASK}` } },
  });
  assert.ok(config.configSecretEntries(value).some((entry) => entry.value === secret));
  assert.equal(config.validate(value).ok, false, "display metadata must not reintroduce retired settings");
});
