// The public pinned Engine schema is a completeness oracle for nonvalidating Harness metadata.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  configSecretEntries,
  configurationWarnings,
  defaults,
  sensitiveOf,
  urlCredentialsOf,
  validate,
} from "../src/index.ts";
import { configNodes, legacySecretKey, urlField } from "./helpers/sensitive-schema.ts";

// The pinned engine schema is a completeness oracle; runtime policy remains in the Harness schema.
const engineSchema = createRequire(new URL("../../core/package.json", import.meta.url))(
  "@cyb3rb1ade/plur1bus-memory/engine/config/engine-config.schema.json",
);
const PUBLIC_ENGINE_FIELDS: Readonly<Record<string, string>> = {
  "embedding.local.maxTokens": "Numeric input-token cap, not credential material.",
  "embedding.routes":
    "Mixed route array; annotate credential leaves under provider, keeping identities and selectors public.",
  "embedding.routes[].identity.tokenCap": "Numeric embedding-space input-token cap.",
  "neo.corpusDefaultWorkspaceKey": "Public workspace identity, not an authentication key.",
  "neo.workspaces[].workspaceKey": "Public workspace identity, not an authentication key.",
  "neo.workspaces[].legacyKeys": "Array of former public workspace identifiers.",
  "neo.workspaces[].legacyKeys[]": "Former public workspace identifier.",
  "recall.adaptiveBudget.tokenBudgetPct": "Numeric recall budget percentage.",
  "recall.semanticCompression.tokenBudget": "Numeric recall token budget.",
  "emotion.t3.encodingMaxTokens": "Numeric encoding-token limit.",
};

test("supported engine pass-through credentials and URLs have Harness-owned policy", () => {
  const candidates = configNodes(engineSchema).filter(
    (field) => legacySecretKey(field.key) || urlField(field) || field.node["x-sensitive"] === true,
  );
  const missing: string[] = [];
  for (const field of candidates) {
    const key = `engine.${field.key}`;
    if (Object.hasOwn(PUBLIC_ENGINE_FIELDS, field.key)) {
      assert.equal(sensitiveOf(key), false, key);
    } else if (urlField(field)) {
      assert.equal(Number(sensitiveOf(key)) + Number(urlCredentialsOf(key)), 1, key);
    } else if (!sensitiveOf(key)) missing.push(key);
  }
  assert.deepEqual(missing, []);
  for (const [key, reason] of Object.entries(PUBLIC_ENGINE_FIELDS)) {
    assert.ok(reason.length > 15);
    assert.ok(
      candidates.some((field) => field.key === key),
      `${key}: stale exception`,
    );
  }
  for (const name of ["apiKey", "apiKeyRef", "apiKeyEnv", "fallback.apiKey"]) {
    assert.equal(sensitiveOf(`engine.embedding.routes[].provider.${name}`), true, name);
  }
  for (const name of ["baseUrl", "fallback.baseUrl"]) {
    assert.equal(urlCredentialsOf(`engine.embedding.routes[].provider.${name}`), true, name);
  }
  assert.equal(sensitiveOf("engine.reminders.webhookUrl"), true);
  assert.equal(urlCredentialsOf("engine.reminders.webhookUrl"), false);
});

test("engine reference objects, header maps and routed providers contribute only their credential values", () => {
  const secret = randomUUID();
  const ref = { source: "store", provider: "fixture", id: randomUUID() };
  const endpoint = `https://relay.example.test/service?ordinary=${secret}`;
  const webhookUrl = `https://hooks.example.test/callback/${randomUUID()}`;
  const engine = {
    embedding: {
      apiKey: ref,
      routes: [
        {
          identity: { model: "public-model" },
          provider: { apiKeyRef: secret, baseUrl: endpoint, fallback: { apiKey: secret, baseUrl: endpoint } },
        },
      ],
    },
    schicht15: { headers: { arbitrary: secret }, apiKeyRef: secret, baseUrl: endpoint },
    reminders: { webhookUrl },
  };
  const entries = configSecretEntries({ engine });
  assert.ok(entries.some((entry) => entry.key === "engine.embedding.apiKey.id" && entry.value === ref.id));
  for (const key of [
    "engine.embedding.routes.0.provider.apiKeyRef",
    "engine.embedding.routes.0.provider.fallback.apiKey",
    "engine.schicht15.headers.arbitrary",
    "engine.schicht15.apiKeyRef",
  ]) {
    assert.ok(
      entries.some((entry) => entry.key === key && entry.value === secret),
      key,
    );
  }
  assert.ok(entries.some((entry) => entry.key === "engine.reminders.webhookUrl" && entry.value === webhookUrl));
  assert.ok(
    entries.some(
      (entry) => entry.key.startsWith("engine.embedding.routes.0.provider.baseUrl#url:") && entry.value === secret,
    ),
  );
  assert.ok(
    !entries.some(
      (entry) => entry.value === endpoint || entry.value === "public-model" || entry.value === "relay.example.test",
    ),
  );
});

test("engine sensitivity metadata preserves the existing opaque pass-through validation", () => {
  const cfg = defaults();
  cfg.engine = {
    implementation: "node",
    embedding: { apiKeyRef: 42, baseUrl: false },
    merging: { headers: { arbitrary: 42 } },
    schicht15: { maxPromotionsPerRun: 0, unknown: true },
    unknownFutureKey: { arbitrary: true },
  };
  const result = validate(cfg);
  assert.ok(result.ok);
  assert.deepEqual(result.config.engine, cfg.engine);
  assert.deepEqual(configurationWarnings(cfg), []);
  assert.deepEqual(
    configSecretEntries(cfg).filter((entry) => entry.key.startsWith("engine.")),
    [],
  );
});
