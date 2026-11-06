// The reserved namespace has real consumers; privacy metadata must follow their supported fields.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { validateProfile } from "../../core/src/auth/profile.ts";
import { configTextSecretEntries, defaults, redactConfig, secretReferenceOf, validate } from "../src/index.ts";

const endpoints = [
  "base_url", "authorizeUrl", "tokenUrl", "deviceUrl", "authorization_endpoint", "token_endpoint",
  "device_authorization_endpoint", "revocation_endpoint",
] as const;

test("runtime provider profiles conceal literal headers and URL parts while retaining reference names", () => {
  const header = randomUUID(), reference = randomUUID(), query = randomUUID();
  const profile = validateProfile({
    id: "fixture", display_name: "Fixture", kind: "api_key", capabilities: ["chat"],
    auth_header_scheme: "Authorization: Bearer {token}", policy_status: "allowed",
    policy_source: "fixture", policy_checked: "2026-11-01", secret_ref: reference,
    extra_headers: { "X-Ordinary-Name": header },
    ...Object.fromEntries(endpoints.map(key => [key, `https://provider.example/v1?token=${query}`])),
  });
  const cfg = defaults();
  cfg.providers.fixture = { wireFormat: "chat_completions", profile, apiKeyRef: reference,
    entries: [{ id: "pooled", secretRef: reference }] };
  assert.ok(validate(cfg).ok, "privacy metadata must not tighten the reserved namespace");
  const projected = redactConfig(cfg) as typeof cfg;
  const serialized = JSON.stringify(projected.providers);
  for (const value of [header, query]) assert.ok(!serialized.includes(value), "provider value leaked");
  assert.ok(serialized.includes(reference), "a valid provisioning reference name was hidden");
  assert.ok(serialized.includes("https://provider.example/v1?token="));
  assert.ok(serialized.includes("Authorization: Bearer {token}"));
  const values = configTextSecretEntries(cfg).map(entry => entry.value);
  for (const value of [header, query]) assert.ok(values.includes(value));
  assert.ok(!values.includes(reference));
  assert.ok(!values.includes("provider.example"), "public endpoint hosts must never become registered secrets");
  assert.equal(secretReferenceOf("providers.fixture.profile.secret_ref", reference), true);
  assert.equal(secretReferenceOf("providers.fixture.apiKeyRef", reference), true);
  assert.equal(secretReferenceOf("providers.fixture.entries.0.secretRef", reference), true);
});

test("runtime MCP and media declarations protect configured credentials before their consumers start", () => {
  const header = randomUUID(), env = randomUUID(), argument = randomUUID(), reference = randomUUID();
  const user = randomUUID(), password = randomUUID(), query = randomUUID();
  const endpoint = `https://${user}:${password}@media.example/generate?token=${query}`;
  const cfg = defaults();
  cfg.providers.media = { adapters: [{ id: "openai", secretRef: reference, baseUrl: endpoint, model: "public" }] };
  cfg.providers.mcp = { servers: [
    { name: "remote", authSecret: reference, transport: {
      type: "http", url: `https://mcp.example/rpc?token=${query}`, headers: { "X-Ordinary-Name": header },
    } },
    { name: "local", transport: { type: "stdio", command: "fixture", args: ["--api-key", argument], env: { API_TOKEN: env } } },
  ] };
  assert.ok(validate(cfg).ok);
  const serialized = JSON.stringify(redactConfig(cfg));
  for (const value of [header, env, argument, user, password, query])
    assert.ok(!serialized.includes(value), "runtime provider value leaked");
  for (const value of ["media.example/generate", "mcp.example/rpc", "public", "fixture"])
    assert.ok(serialized.includes(value), "public provider metadata must remain visible");
  assert.ok(serialized.includes(reference));
  const values = configTextSecretEntries(cfg).map(entry => entry.value);
  for (const value of [header, env, argument, password, query]) assert.ok(values.includes(value));
  assert.ok(!values.includes(user), "userinfo usernames are public text metadata");
  assert.ok(!values.includes(reference));
  assert.equal(secretReferenceOf("providers.media.adapters.0.secretRef", reference), true);
  assert.equal(secretReferenceOf("providers.mcp.servers.0.authSecret", reference), true);
});
