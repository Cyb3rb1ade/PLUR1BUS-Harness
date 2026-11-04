// Public endpoint material and ordinary process arguments must not become global text secrets.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { configTextSecretEntries, configurationWarnings, redactConfig } from "../src/index.ts";
import { credentialName, maskUrlCredentials, trimUrlControls } from "../src/url-credentials.ts";
import { createRedactor } from "../../core/src/logs/redact.ts";
import { containsConfigCredentials, supportsConfigDisclosurePolicy } from "../src/policy.ts";

test("userinfo password and credential query/fragment values protect tool output without hiding regions and paths", () => {
  const password = randomBytes(32).toString("hex"), token = randomBytes(32).toString("hex");
  const endpoint = `https://public-user:${password}@provider.example/public/path?token=${token}&region=us-east-1&api-version=2024-02-01#auth=${token}`;
  const value = { voice: { providers: { elevenlabs: { baseUrl: endpoint } } }, auth: { openai: { federated: {
    args: ["--file", `/home/example/${"public-project/".repeat(12)}config.json`, "--api-key", token],
    environment: { REGION: "us-east-1", API_TOKEN: token },
  } } } };
  const values = configTextSecretEntries(value).map(entry => entry.value);
  const result = createRedactor({ secrets: values, pii: false }).text(
    `tool result region=us-east-1 api-version=2024-02-01 ${value.auth.openai.federated.args[1]} password=${password} token=${token}`,
  );
  for (const publicText of ["us-east-1", "2024-02-01", value.auth.openai.federated.args[1]!]) assert.ok(result.includes(publicText));
  for (const secret of [password, token]) assert.ok(!result.includes(secret));
  for (const publicText of [endpoint, "public-user", "provider.example", "/public/path", "us-east-1", "2024-02-01"])
    assert.ok(!values.includes(publicText), "public endpoint material entered the text registry");
  assert.equal((redactConfig(value) as typeof value).voice.providers.elevenlabs.baseUrl,
    "https://••••@provider.example/public/path?token=••••&region=••••&api-version=••••#auth=••••");
});

test("fragments use the projection policy and URI-safe replacement remains valid", () => {
  const uri = maskUrlCredentials("https://user:password@provider.example/path?token=value#secret=fragment", "REDACTED");
  assert.equal(uri, "https://REDACTED@provider.example/path?token=REDACTED#secret=REDACTED");
  assert.equal(new URL(uri).hostname, "provider.example");
  assert.equal(maskUrlCredentials("https://provider.example/path#opaque"), "https://provider.example/path#••••");
  assert.equal(credentialName("monkey"), false);
  assert.equal(credentialName("design"), false);
  assert.equal(credentialName("accessToken"), true);
});

test("credential parameter boundaries include short key/auth/signature values without classifying ordinary names", () => {
  const schema = { properties: { endpoint: { type: "string", "x-url-credentials": true } } };
  const values = configTextSecretEntries({ endpoint:
    "https://host.example/path?key=access-value&auth=auth-value&sig=signature-value&monkey=public-value&design=public-design#code=callback-code",
  }, schema).map(entry => entry.value);
  for (const credential of ["access-value", "auth-value", "signature-value", "callback-code"]) assert.ok(values.includes(credential));
  for (const ordinary of ["public-value", "public-design"]) assert.ok(!values.includes(ordinary));
});

test("short invalid reference syntax warns without echoing the literal", () => {
  const value = "short key!";
  const config = { engine: { schicht15: { apiKeyRef: value } } };
  assert.deepEqual((redactConfig(config) as typeof config).engine.schicht15.apiKeyRef, "••••");
  const warnings = configurationWarnings(config);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.message, /reference syntax/);
  assert.ok(!JSON.stringify(warnings).includes(value));
});

test("C0 trimming handles adversarial internal whitespace with a linear character budget", () => {
  const size = 100_000;
  let reads = 0;
  const measured = {
    length: size + 2,
    charCodeAt(index: number): number { reads++; return index === size / 2 ? 0x78 : 0x20; },
    slice(start: number, end: number): string { assert.equal(start, size / 2); assert.equal(end, size / 2 + 1); return "x"; },
  } as unknown as string;
  assert.equal(trimUrlControls(measured), "x");
  assert.ok(reads <= size + 4, "trim revisited characters instead of moving its boundaries");
  const internal = `x${" ".repeat(size)}x`;
  assert.equal(trimUrlControls(internal), internal);
  assert.equal(trimUrlControls("\0\t x \r\n"), "x");
});

test("typed recursive public schemas terminate editor credential lookup and retain finite values", () => {
  const schema = { type: "object", $defs: { tree: { type: "object", additionalProperties: false,
    properties: { label: { type: "string" }, child: { $ref: "#/$defs/tree" } },
  } }, properties: { tree: { $ref: "#/$defs/tree" } } };
  assert.equal(supportsConfigDisclosurePolicy(schema), true);
  assert.equal(containsConfigCredentials(schema, ["tree"]), false);
  const value = { tree: { label: "public-model", child: { label: "public-model" } } };
  assert.deepEqual(redactConfig(value, { schema }), value);
});
