// Complete browser policy stays separate from editable settings and protects both palette inputs.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { SETTINGS, CONFIG_POLICY_SCHEMA, type SettingSpec } from "../src/palette/settings-index.ts";
import { buildIndex, settingValues } from "../src/palette/index-build.ts";
import { CONFIG_SCHEMA } from "../../config-schema/src/index.ts";
import { configPolicyAt, policySchema } from "@plur1bus/config-schema/policy";
import { configPolicyOf } from "../src/config-policy.ts";
import { collectChanges, initialDraft, type Field } from "../src/pages/settings/config/model.ts";

// Exercise a policy-backed catalog consumer without adding UI controls for opaque Engine fields.
function withPolicy(key: string): readonly SettingSpec[] {
  const policy = configPolicyOf(key);
  assert.ok(policy.known, `${key}: policy metadata is required`);
  return [...SETTINGS, { key, type: "string", tier: "advanced" }];
}

test("nonvalidating Engine policies do not create uneditable palette targets", () => {
  assert.equal(CONFIG_POLICY_SCHEMA.type, "object", "structural policy metadata is separate from settings");
  for (const key of ["engine.embedding.apiKey", "engine.embedding.baseUrl", "engine.reminders.webhookUrl"]) {
    assert.ok(
      configPolicyAt(CONFIG_POLICY_SCHEMA, key.split(".")).known,
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
    const field = configPolicyOf(key);
    assert.ok(field, `${key}: metadata must be generated`);
    assert.equal(Boolean(field.sensitive), sensitive, key);
    assert.equal(Boolean(field.urlCredentials), urlCredentials, key);
  }
  assert.deepEqual(CONFIG_POLICY_SCHEMA, policySchema(CONFIG_SCHEMA),
    "browser policy retains public structure, unknown-member policy and local reference definitions");
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

test("both palette inputs include safe reference names and reject pasted key values", () => {
  const key = "voice.providers.elevenlabs.apiKeyRef";
  const name = `voice.elevenlabs.${randomUUID().slice(0, 8)}`;
  const config = (value: string) => ({ voice: { providers: { elevenlabs: { apiKeyRef: value } } } });
  const values = settingValues(config(name));
  assert.equal(values[key], name);
  assert.equal(buildIndex({ lang: "en", values }).find((entry) => entry.key === key)?.value, name);
  assert.equal(buildIndex({ lang: "en", values: { [key]: name } }).find((entry) => entry.key === key)?.value, name);
  for (const literal of [
    `sk-${randomBytes(24).toString("base64url")}`,
    `ghp_${randomBytes(24).toString("base64url")}`,
    `xoxb-${randomBytes(24).toString("base64url")}`,
    randomBytes(64).toString("base64url"),
    randomBytes(24).toString("hex"),
    `long.${randomUUID()}.${"name".repeat(30)}`,
  ]) {
    assert.equal(settingValues(config(literal))[key], undefined);
    const index = buildIndex({ lang: "en", values: { [key]: literal } });
    assert.equal(index.find((entry) => entry.key === key)?.value, undefined);
    assert.ok(!JSON.stringify(index).includes(literal));
  }
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
  for (const value of [values[key], values["privacy.localEndpoints"], values["channels.buzz.relays"]]) {
    assert.ok(value);
    for (const text of typeof value === "string" ? [value] : value) {
      assert.ok(text.includes("relay.example.test/service"));
      assert.ok(!text.includes(secret));
    }
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
    const value = values[key];
    assert.equal(typeof value, "string");
    assert.ok(typeof value === "string" && !value.includes(secret.slice(0, 18)));
  }
  for (const endpoint of [
    "https://relay.example.test:443\\status@other.example/path",
    "file:///folder@relay.example.test/path",
    "mailto:public@relay.example.test",
  ]) {
    assert.equal(settingValues({ engine: { embedding: { baseUrl: endpoint } } }, settings)[key], endpoint);
  }
});

test("the complete palette load and build chain retains each public endpoint in a masked URL list", () => {
  const secret = randomUUID();
  const key = "privacy.localEndpoints";
  const endpoints = [
    `https://relay.example.test/first?ordinary=${secret}`,
    `https://other.example.test/second?another=${secret}`,
  ];
  const values = settingValues({ privacy: { localEndpoints: endpoints } });
  const entry = buildIndex({ lang: "en", values }).find((entry) => entry.key === key);
  assert.equal(entry?.value, "https://relay.example.test/first?ordinary=••••, https://other.example.test/second?another=••••");
  assert.ok(!JSON.stringify(values).includes(secret));
});

test("marked and endpoint drafts are absent until replaced, and explicit clears remain changes", () => {
  const secret = randomUUID();
  const fields: Field[] = [
    { key: "engine.embedding.apiKey", kind: "string", value: secret, def: undefined, restartClass: "core", readOnly: false },
    { key: "core.webHandoffBaseUrl", kind: "string", value: `https://relay.example.test/path?ordinary=${secret}`, def: "", restartClass: "live", readOnly: false },
    { key: "core.logLevel", kind: "enum", value: "info", def: "info", restartClass: "live", readOnly: false },
  ];
  const draft = initialDraft(fields);
  assert.deepEqual(draft, { "core.logLevel": "info" });
  assert.deepEqual(collectChanges(fields, { ...draft, "core.logLevel": "debug" }).changes.map(({ key }) => key), ["core.logLevel"]);
  const clear = collectChanges(fields, { ...draft, "engine.embedding.apiKey": "", "core.webHandoffBaseUrl": "" });
  assert.deepEqual(clear.errors, {});
  assert.deepEqual(clear.changes.map(({ key, value }) => ({ key, value })), [
    { key: "engine.embedding.apiKey", value: "" }, { key: "core.webHandoffBaseUrl", value: "" },
  ]);
});


test("collection drafts inherit item policy while unknown numeric and boolean values keep their types", () => {
  const field = (key: string, value: unknown): Field => ({
    key, value, kind: typeof value === "number" ? "int" : typeof value === "boolean" ? "bool" : "strings",
    def: undefined, restartClass: "live", readOnly: false,
  });
  const fields = [field("auth.openai.federated.args", ["public-package"]),
    field("core.futureTokenCount", 7), field("core.futureSecretEnabled", true),
    field("a2aServer.signingKey.kid", "https://host.example/public?q=private#private")];
  assert.deepEqual(initialDraft(fields), { "core.futureTokenCount": "7", "core.futureSecretEnabled": true });
});
