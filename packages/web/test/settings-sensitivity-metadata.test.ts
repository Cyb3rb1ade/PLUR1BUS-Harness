// Complete browser policy stays separate from editable settings and protects both palette inputs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { SETTINGS, CONFIG_POLICY, type SettingSpec } from "../src/palette/settings-index.ts";
import { buildIndex, settingValues } from "../src/palette/index-build.ts";
import { CONFIG_SCHEMA, sensitiveOf, urlCredentialsOf } from "../../config-schema/src/index.ts";
import { configNodes } from "../../config-schema/test/helpers/sensitive-schema.ts";

// Exercise a policy-backed catalog consumer without adding UI controls for opaque Engine fields.
function withPolicy(key: string): readonly SettingSpec[] {
  const policy = CONFIG_POLICY.find((field) => field.key === key);
  assert.ok(policy, `${key}: policy metadata is required`);
  return [...SETTINGS, { ...policy, type: "string", tier: "advanced" }];
}

test("nonvalidating Engine policies do not create uneditable palette targets", () => {
  assert.ok(Array.isArray(CONFIG_POLICY), "complete policy metadata must be generated separately from settings");
  for (const key of ["engine.embedding.apiKey", "engine.embedding.baseUrl", "engine.reminders.webhookUrl"]) {
    assert.ok(
      CONFIG_POLICY.some((field) => field.key === key),
      `${key}: policy metadata is required`,
    );
    assert.ok(!SETTINGS.some((field) => field.key === key), `${key}: metadata is not an editable setting definition`);
  }
});

test("generated settings metadata retains sensitivity and URL policies without importing the Node schema package", () => {
  for (const [key, sensitive, urlCredentials] of [
    ["channels.discord.tokenSecret", true, false],
    ["auth.openai.federated.environment", true, false],
    ["auth.openai.federated.args", true, false],
    ["voice.providers.elevenlabs.baseUrl", false, true],
    ["privacy.localEndpoints", false, true],
    ["channels.buzz.relays", false, true],
    ["voice.providers.polly.credentials.profile", false, false],
    ["engine.embedding.apiKey.id", true, false],
    ["engine.embedding.apiKey", true, false],
    ["engine.schicht15.headers", true, false],
    ["engine.reminders.webhookUrl", true, false],
    ["engine.reranker.baseUrl", false, true],
  ] as const) {
    const field = SETTINGS.find((field) => field.key === key) ?? CONFIG_POLICY.find((field) => field.key === key);
    assert.ok(field, `${key}: metadata must be generated`);
    assert.equal(Boolean(field.sensitive), sensitive, key);
    assert.equal(Boolean(field.urlCredentials), urlCredentials, key);
  }
  const expected = configNodes(CONFIG_SCHEMA)
    .map(({ key }) => ({ key, sensitive: sensitiveOf(key), urlCredentials: urlCredentialsOf(key) }))
    .filter((field) => field.sensitive || field.urlCredentials)
    .map(({ key, sensitive, urlCredentials }) => ({
      key,
      ...(sensitive ? { sensitive: true } : {}),
      ...(urlCredentials ? { urlCredentials: true } : {}),
    }));
  assert.deepEqual(
    CONFIG_POLICY,
    expected,
    "browser policy must retain every schema-backed annotation, including opaque Engine members",
  );
});

test("generated sensitive policies cannot expose values through either palette input", () => {
  const secret = `https://hooks.example.test/callback/${randomUUID()}`;
  const key = "engine.reminders.webhookUrl";
  const settings = withPolicy(key);
  assert.equal(settingValues({ engine: { reminders: { webhookUrl: secret } } }, settings)[key], undefined);
  const entry = buildIndex({ lang: "en", values: { [key]: secret }, settings }).find((entry) => entry.key === key);
  assert.ok(entry);
  assert.equal(entry.value, undefined);
});

test("endpoint metadata masks all query values in both palette inputs, including URL arrays", () => {
  const secret = randomUUID();
  const endpoint = `https://relay.example.test/service?ordinary=${secret}&ordinary=${secret}`;
  const key = "engine.embedding.baseUrl";
  const settings = withPolicy(key);
  const values = settingValues(
    {
      engine: { embedding: { baseUrl: endpoint } },
      privacy: { localEndpoints: [endpoint] },
      channels: { buzz: { relays: [endpoint.replace("https:", "wss:")] } },
    },
    settings,
  );
  for (const text of [values[key], values["privacy.localEndpoints"], values["channels.buzz.relays"]]) {
    assert.ok(text);
    assert.ok(text.includes("relay.example.test/service"));
    assert.ok(!text.includes(secret));
  }
  const entry = buildIndex({ lang: "en", values: { [key]: endpoint }, settings }).find((entry) => entry.key === key);
  assert.ok(entry);
  assert.ok(entry.value);
  assert.ok(entry.value.includes("relay.example.test/service"));
  assert.ok(!entry.value.includes(secret));
});

test("endpoint metadata handles normalized userinfo and never mistakes backslash paths for credentials", () => {
  const secret = randomUUID();
  const key = "engine.embedding.baseUrl";
  const settings = withPolicy(key);
  for (const endpoint of [
    `https:${secret}@relay.example.test/service`,
    `//${secret}@relay.example.test/service`,
    `  //${secret}@relay.example.test/service  `,
    `\u0000 \t//${secret}@relay.example.test/service\r\n`,
    `h\tttps://${secret.slice(0, 18)}\t${secret.slice(18)}@relay.example.test/service`,
    `https://${secret}@`,
  ]) {
    const values = settingValues({ engine: { embedding: { baseUrl: endpoint } } }, settings);
    assert.ok(values[key]);
    assert.ok(!values[key].includes(secret.slice(0, 18)));
  }
  for (const endpoint of [
    "https://relay.example.test:443\\status@other.example/path",
    "file:///folder@relay.example.test/path",
    "mailto:public@relay.example.test",
  ]) {
    assert.equal(settingValues({ engine: { embedding: { baseUrl: endpoint } } }, settings)[key], endpoint);
  }
});
