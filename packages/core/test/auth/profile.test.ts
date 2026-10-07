import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadProfiles, validateProfile, parseHeaderScheme } from "../../src/auth/profile.ts";
import { AuthError } from "../../src/auth/errors.ts";
import { InMemorySecretStore, decodeRecord, encodeRecord } from "../../src/auth/secret-store.ts";

const base = { id: "example:key", display_name: "Example", kind: "api_key", capabilities: ["chat"], auth_header_scheme: "Authorization: Bearer {token}", policy_status: "allowed", policy_source: "https://example.test/terms", policy_checked: "2026-09-22", secret_ref: "ex/key" };
const oauth = { ...base, id: "example:oauth", kind: "oauth_pkce", authorization_endpoint: "https://example.test/auth", token_endpoint: "https://example.test/token", refresh: { mode: "rotating" } };
const device = { ...base, id: "example:dev", kind: "device_code", device_authorization_endpoint: "https://example.test/device", token_endpoint: "https://example.test/token" };

describe("auth profiles", () => {
  it("accepts a profile of every kind", () => {
    const m = loadProfiles([base, oauth, device, { ...base, id: "example:adc", kind: "adc" }, { ...base, id: "example:cli", kind: "external_cli" }]);
    assert.equal(m.size, 5);
  });
  it("never loads a prohibited profile (M2 acceptance 7)", () => {
    assert.throws(() => validateProfile({ ...base, policy_status: "prohibited" }), (e: any) => e instanceof AuthError && e.code === "invalid_profile" && /prohibited/.test(e.message));
    assert.throws(() => loadProfiles([base, { ...oauth, policy_status: "prohibited" }]));
  });
  it("refuses unknown fields, so a secret cannot ride along", () => {
    assert.throws(() => validateProfile({ ...base, api_key: "CANARY-X" }), (e: any) => e.code === "invalid_profile" && !e.message.includes("CANARY-X"));
    assert.throws(() => validateProfile({ ...base, wire_profile: "siwc" }));
  });
  it("refuses incomplete flows and unsafe values", () => {
    assert.throws(() => validateProfile({ ...oauth, token_endpoint: undefined }));
    assert.throws(() => validateProfile({ ...device, device_authorization_endpoint: undefined }));
    assert.throws(() => validateProfile({ ...base, base_url: "http://example.test/v1" }));
    assert.throws(() => validateProfile({ ...base, base_url: "https://u:p@example.test/v1" }));
    assert.doesNotThrow(() => validateProfile({ ...base, base_url: "http://127.0.0.1:11434/v1" }));
    assert.throws(() => validateProfile({ ...base, auth_header_scheme: "Authorization: Bearer x" }));
    assert.throws(() => validateProfile({ ...base, auth_header_scheme: "X: {token}\r\nEvil: 1" }));
    assert.throws(() => validateProfile({ ...base, policy_checked: "yesterday" }));
    assert.throws(() => loadProfiles([base, base]));
  });
  it("parses header schemes", () => {
    assert.deepEqual(parseHeaderScheme("x", "x-api-key: {token}"), { name: "x-api-key", template: "{token}" });
  });
});

describe("secret store + records", () => {
  it("round-trips a record and refuses a malformed one without echoing it", async () => {
    const s = new InMemorySecretStore();
    await s.set("r", encodeRecord({ v: 1, accessToken: "CANARY-A", generation: 0 }));
    assert.equal(decodeRecord((await s.get("r"))!, "p").accessToken, "CANARY-A");
    assert.throws(() => decodeRecord("{\"v\":1,\"accessToken\":\"CANARY-B\"}", "p"), (e: any) => e.code === "invalid_secret_record" && !e.message.includes("CANARY-B"));
    assert.throws(() => decodeRecord("not json CANARY-C", "p"), (e: any) => !e.message.includes("CANARY-C"));
  });
});

it("new flow aliases and arbitrary audience identifiers validate without coercing values", () => {
  const p = validateProfile({ ...oauth, authorizeUrl: oauth.authorization_endpoint, tokenUrl: oauth.token_endpoint, audience: "test-audience", scopes: ["read", "offline_access"], pkce: "S256", redirect: { type: "loopback" } });
  assert.equal(p.audience, "test-audience");
  assert.throws(() => validateProfile({ ...oauth, token_endpoint: { toString: () => "https://example.test/token" } }));
  assert.throws(() => validateProfile({ ...oauth, policy_checked: "2026-02-30" }));
});
