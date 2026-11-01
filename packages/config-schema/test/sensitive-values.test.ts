// Runtime metadata lookup must mask only declared values and extracted endpoint credentials.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import * as config from "../src/index.ts";
import { createSecretRedaction } from "../../core/src/secrets/redaction.ts";
import { elevenlabsHost } from "../../voice-providers/src/constants.ts";

test("schema sensitivity follows map values and array items without guessing from names", () => {
  assert.equal(typeof config.sensitiveOf, "function");
  assert.equal(config.sensitiveOf("channels.discord.tokenSecret"), true);
  assert.equal(config.sensitiveOf("auth.openai.federated.environment.ARBITRARY"), true);
  assert.equal(config.sensitiveOf("auth.openai.federated.args.0"), true);
  assert.equal(config.sensitiveOf("auth.openai.federated.args"), true);
  assert.equal(config.sensitiveOf("modelProfiles.primary.params.maxTokens"), false);
  assert.equal(config.sensitiveOf("a2aServer.signingKey.kid"), false);
  const schema = { properties: { ordinary: { type: "string", "x-sensitive": true }, password: { type: "string" } } };
  assert.equal(config.sensitiveOf("ordinary", schema), true);
  assert.equal(config.sensitiveOf("password", schema), false);
});

test("endpoint metadata covers named providers, map entries and URL arrays", () => {
  assert.equal(typeof config.urlCredentialsOf, "function");
  assert.equal(config.urlCredentialsOf("voice.providers.elevenlabs.baseUrl"), true);
  assert.equal(config.urlCredentialsOf("sidecars.search.url"), true);
  assert.equal(config.urlCredentialsOf("privacy.localEndpoints.0"), true);
  assert.equal(config.urlCredentialsOf("channels.telegram.webhook.url"), true);
  assert.equal(config.urlCredentialsOf("channels.telegram.webhook.secret"), false);
  assert.equal(config.urlCredentialsOf("channels.buzz.relays"), true);
  assert.equal(config.urlCredentialsOf("channels.buzz.relays.0"), true);
});

test("prototype-shaped map keys cannot bypass schema-backed sensitivity", () => {
  const value = randomUUID();
  const schema = {
    properties: { enabled: { type: "boolean" } },
    additionalProperties: { type: "string", "x-sensitive": true },
  };
  const names = ["constructor", "toString", "__proto__"];
  const cfg = Object.fromEntries(names.map((name) => [name, value]));
  assert.deepEqual(
    config.configSecretEntries(cfg, schema),
    names.map((key) => ({ key, value })),
  );
  for (const name of names) assert.equal(config.sensitiveOf(name, schema), true, name);
});

test("endpoint registration extracts every encoded userinfo and repeated query value, never the endpoint", () => {
  assert.equal(typeof config.configSecretEntries, "function");
  const username = randomUUID();
  const password = `${randomBytes(24).toString("base64")} %`;
  const first = `${randomUUID()} +%&`;
  const second = randomUUID();
  const url = new URL("https://relay.example.test/service");
  url.username = username;
  url.password = password;
  url.searchParams.append("ordinary", first);
  url.searchParams.append("ordinary", second);
  const cfg = config.defaults();
  cfg.voice.providers.elevenlabs.baseUrl = url.href;
  const entries = config
    .configSecretEntries(cfg)
    .filter((entry) => entry.key.startsWith("voice.providers.elevenlabs.baseUrl"));
  const values = new Set(entries.map((entry) => entry.value));
  for (const value of [username, password, first, second])
    assert.ok(values.has(value), "a credential-bearing component is missing");
  for (const value of [url.href, url.hostname, url.pathname])
    assert.equal(values.has(value), false, "public endpoint material must not be registered");
  const redaction = createSecretRedaction();
  for (const entry of entries) redaction.register(entry.value, entry.key);
  const logged = redaction.redactor({ pii: false }).text(`endpoint=${url.href}`);
  assert.ok(logged.includes(url.hostname));
  assert.ok(logged.includes(url.pathname));
  assert.ok(!logged.includes(username));
  assert.ok(!logged.includes(second));
});

test("a webhook classified wholly sensitive registers its credential-bearing path and complete URL", () => {
  assert.equal(typeof config.configSecretEntries, "function");
  const url = `https://hooks.example.test/callback/${randomUUID()}`;
  const schema = { properties: { delivery: { type: "string", "x-sensitive": true } } };
  const entries = config.configSecretEntries({ delivery: url }, schema);
  assert.deepEqual(entries, [{ key: "delivery", value: url }]);
  const redaction = createSecretRedaction();
  for (const entry of entries) redaction.register(entry.value, entry.key);
  assert.ok(!redaction.redactor({ pii: false }).text(url).includes(url));
});

test("userinfo remains sensitive in normalized, protocol-relative and malformed endpoint spellings", () => {
  const username = randomUUID();
  const password = randomUUID();
  const schema = { properties: { endpoint: { type: "string", "x-url-credentials": true } } };
  for (const value of [
    `https:${username}:${password}@relay.example.test/service`,
    `//${username}:${password}@relay.example.test/service`,
    `  //${username}:${password}@relay.example.test/service  `,
    `\u0000 \t//${username}:${password}@relay.example.test/service\r\n`,
    `https://${username}:${password}@`,
  ]) {
    const entries = config.configSecretEntries({ endpoint: value }, schema);
    assert.ok(
      entries.some((entry) => entry.value === username),
      "userinfo username was not extracted",
    );
    assert.ok(
      entries.some((entry) => entry.value === password),
      "userinfo password was not extracted",
    );
    assert.equal(config.configurationWarnings({ endpoint: value }, schema).length, 1);
  }
});

test("endpoint registration covers both literal and URL-normalized userinfo with embedded controls", () => {
  const username = randomUUID();
  const password = randomUUID();
  const rawUser = `${username.slice(0, 18)}\t${username.slice(18)}`;
  const rawPass = `${password.slice(0, 18)}\n${password.slice(18)}`;
  const query = randomUUID();
  const rawQuery = `${query.slice(0, 18)}\r${query.slice(18)}`;
  const schema = { properties: { endpoint: { type: "string", "x-url-credentials": true } } };
  for (const prefix of ["https://", "https:", "https:/", "h\tttps://", "//", "  //", "\\\\"]) {
    const endpoint = `${prefix}${rawUser}:${rawPass}@relay.example.test/path?ordinary=${rawQuery}`;
    const values = new Set(config.configSecretEntries({ endpoint }, schema).map((entry) => entry.value));
    for (const value of [rawUser, rawPass, username, password, rawQuery, query]) assert.ok(values.has(value));
    const redaction = createSecretRedaction();
    for (const value of values) redaction.register(value);
    const logged = redaction.redactor({ pii: false }).text(`Endpoint: ${endpoint}`);
    assert.ok(!logged.includes(username.slice(0, 18)));
    assert.ok(!logged.includes(password.slice(0, 18)));
    assert.ok(!logged.includes(query.slice(0, 18)));
    assert.ok(logged.includes("relay.example.test/path"));
  }
});

test("the standard provider endpoint never causes its hostname to disappear from logs", () => {
  assert.equal(typeof config.configSecretEntries, "function");
  const cfg = config.defaults();
  const endpoint = `https://${elevenlabsHost("default")}`;
  cfg.voice.providers.elevenlabs.baseUrl = endpoint;
  const redaction = createSecretRedaction();
  for (const entry of config.configSecretEntries(cfg)) redaction.register(entry.value, entry.key);
  const line = `Connecting to ${endpoint}/v1/voices`;
  assert.equal(redaction.redactor({ pii: false }).text(line), line);
});

test("backslash path separators do not turn public hosts and paths into URL userinfo", () => {
  const schema = { properties: { endpoint: { type: "string", "x-url-credentials": true } } };
  for (const endpoint of [
    "https://relay.example.test:443\\status@other.example/path",
    "//relay.example.test:443\\status@other.example/path",
    "https://relay.example.test:invalid\\status@other.example/path",
    "file:///folder@relay.example.test/path",
    "mailto:public@relay.example.test",
  ]) {
    assert.deepEqual(
      config.configSecretEntries({ endpoint }, schema),
      [],
      "public authority/path registered as a secret",
    );
    assert.deepEqual(config.configurationWarnings({ endpoint }, schema), []);
  }
});

test("validation warns about URL userinfo without leaking values, rejecting it or altering the URL", () => {
  const username = randomUUID();
  const password = randomUUID();
  const value = `https://${username}:${password}@relay.example.test/service?ordinary=${randomUUID()}`;
  const cfg = config.defaults();
  cfg.voice.providers.elevenlabs.baseUrl = value;
  const result = config.validate(cfg);
  assert.ok(result.ok);
  assert.ok(result.warnings?.length, "userinfo must produce a warning");
  assert.equal(result.config.voice.providers.elevenlabs.baseUrl, value);
  assert.equal(result.warnings[0]?.key, "voice.providers.elevenlabs.baseUrl");
  assert.ok(result.warnings[0]?.message.includes("voice.providers.elevenlabs.apiKeyRef"));
  const warning = JSON.stringify(result.warnings);
  assert.ok(!warning.includes(username));
  assert.ok(!warning.includes(password));
  assert.ok(!warning.includes(value));
});

test("warning-free validation keeps its previous result shape and URL query values alone add no warning", () => {
  const cfg = config.defaults();
  cfg.voice.providers.elevenlabs.baseUrl = `https://relay.example.test/service?ordinary=${randomUUID()}`;
  const result = config.validate(cfg);
  assert.ok(result.ok);
  assert.deepEqual(Object.keys(result).sort(), ["config", "ok"]);
});

test("userinfo warnings are bounded for a configuration with many endpoint map entries", () => {
  assert.equal(typeof config.configurationWarnings, "function");
  const sidecars = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      `source${index}`,
      { url: `https://${randomUUID()}@relay.example.test/` },
    ]),
  );
  const warnings = config.configurationWarnings({ sidecars });
  assert.equal(warnings.length, 50);
  assert.ok(warnings.every((warning) => warning.key.startsWith("sidecars.source")));
});
