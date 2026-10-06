import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCredentialsProvider } from "../../src/auth/credentials.ts";
import { RefreshRejected, type Refresher } from "../../src/auth/refresh.ts";
import { InMemorySecretStore, encodeRecord } from "../../src/auth/secret-store.ts";
import { validateProfile } from "../../src/auth/profile.ts";
import { FakeClock, MARK } from "./helpers.ts";

const common = { display_name: "Example", capabilities: ["chat"], policy_status: "allowed", policy_source: "https://e.test", policy_checked: "2026-09-22" };
const keyProfile = validateProfile({ ...common, id: "e:key", kind: "api_key", auth_header_scheme: "x-api-key: {token}" });
const oauthProfile = validateProfile({ ...common, id: "e:oauth", kind: "oauth_pkce", auth_header_scheme: "Authorization: Bearer {token}", authorization_endpoint: "https://e.test/a", token_endpoint: "https://e.test/t", refresh: { mode: "rotating" } });
const noRefresher: Refresher = { async refresh() { throw new Error("unexpected refresh"); } };

describe("credentials provider", () => {
  it("api key: returns the profile's header scheme, no expiry", async () => {
    const store = new InMemorySecretStore(); await store.set("k/1", MARK.key);
    const p = createCredentialsProvider({ profiles: [{ profile: keyProfile, entries: [{ id: "a", secretRef: "k/1" }] }], store, clock: new FakeClock(), refresher: noRefresher });
    const l = await p.getAuthorization({ profileId: "e:key" });
    assert.deepEqual(l.header, { name: "x-api-key", value: MARK.key });
    assert.equal(l.expiresAt, null);
    assert.deepEqual(l.headers({ "anthropic-version": "1" }), { "anthropic-version": "1", "x-api-key": MARK.key });
  });

  it("ten concurrent leases for an expiring OAuth credential run one refresh (M2 acceptance 2)", async () => {
    const clock = new FakeClock(), store = new InMemorySecretStore(); let calls = 0;
    await store.set("o/1", encodeRecord({ v: 1, accessToken: MARK.access, refreshToken: MARK.refresh, expiresAt: clock.now() + 1000, generation: 0 }));
    const refresher: Refresher = { async refresh() { calls++; await new Promise((r) => setImmediate(r)); return { accessToken: "CANARY-NEW", refreshToken: "CANARY-NEW-R", expiresInSeconds: 3600 }; } };
    const p = createCredentialsProvider({ profiles: [{ profile: oauthProfile, entries: [{ id: "a", secretRef: "o/1" }] }], store, clock, refresher });
    const leases = await Promise.all(Array.from({ length: 10 }, () => p.getAuthorization({ profileId: "e:oauth" })));
    assert.equal(calls, 1);
    assert.ok(leases.every((l) => l.header.value === "Bearer CANARY-NEW" && l.expiresAt === clock.now() + 3_600_000));
  });

  it("a 401 on a believed-valid token refreshes once; a 401 on the fresh token cools the credential", async () => {
    const clock = new FakeClock(), store = new InMemorySecretStore(); let calls = 0;
    await store.set("o/1", encodeRecord({ v: 1, accessToken: MARK.access, refreshToken: MARK.refresh, expiresAt: clock.now() + 3_600_000, generation: 0 }));
    await store.set("o/2", encodeRecord({ v: 1, accessToken: "CANARY-B", refreshToken: "CANARY-BR", expiresAt: clock.now() + 3_600_000, generation: 0 }));
    const refresher: Refresher = { async refresh() { calls++; return { accessToken: `CANARY-N${calls}`, refreshToken: `CANARY-NR${calls}`, expiresInSeconds: 3600 }; } };
    const p = createCredentialsProvider({ profiles: [{ profile: oauthProfile, entries: [{ id: "a", secretRef: "o/1" }, { id: "b", secretRef: "o/2" }] }], store, clock, refresher });
    const l1 = await p.getAuthorization({ profileId: "e:oauth" });
    assert.equal(l1.credentialId, "a");
    await p.reportResult(l1, { ok: false, status: 401 });
    const l2 = await p.getAuthorization({ profileId: "e:oauth" });
    assert.equal(l2.credentialId, "a"); assert.equal(l2.refreshed, true); assert.equal(calls, 1);
    await p.reportResult(l2, { ok: false, status: 401 });
    const l3 = await p.getAuthorization({ profileId: "e:oauth" });
    assert.equal(l3.credentialId, "b"); // a is cooling now
  });

  it("429 failover across the pool and recovery after cooldown", async () => {
    const clock = new FakeClock(), store = new InMemorySecretStore();
    await store.set("k/1", "CANARY-K1"); await store.set("k/2", "CANARY-K2");
    const p = createCredentialsProvider({ profiles: [{ profile: keyProfile, entries: [{ id: "a", secretRef: "k/1" }, { id: "b", secretRef: "k/2" }] }], store, clock, refresher: noRefresher });
    const l1 = await p.getAuthorization({ profileId: "e:key" });
    await p.reportResult(l1, { ok: false, status: 429 });
    assert.equal((await p.getAuthorization({ profileId: "e:key" })).credentialId, "b");
    clock.advance(60_000);
    assert.equal((await p.getAuthorization({ profileId: "e:key" })).credentialId, "a");
    // the cron runner asks the same pool object
    assert.equal(p.pool("e:key")!.status().length, 2);
  });

  it("an expired refresh token on a pooled credential fails over; alone it is a re-auth error", async () => {
    const clock = new FakeClock(), store = new InMemorySecretStore();
    const dead = encodeRecord({ v: 1, accessToken: "CANARY-D", refreshToken: "CANARY-DR", expiresAt: clock.now() - 1, generation: 0 });
    await store.set("o/1", dead);
    await store.set("o/2", encodeRecord({ v: 1, accessToken: "CANARY-OK", refreshToken: "CANARY-OKR", expiresAt: clock.now() + 3_600_000, generation: 0 }));
    const refresher: Refresher = { async refresh() { throw new RefreshRejected("invalid_grant"); } };
    const pair = createCredentialsProvider({ profiles: [{ profile: oauthProfile, entries: [{ id: "a", secretRef: "o/1" }, { id: "b", secretRef: "o/2" }] }], store, clock, refresher });
    assert.equal((await pair.getAuthorization({ profileId: "e:oauth" })).credentialId, "b");
    const solo = createCredentialsProvider({ profiles: [{ profile: oauthProfile, entries: [{ id: "a", secretRef: "o/1" }] }], store, clock, refresher });
    await assert.rejects(solo.getAuthorization({ profileId: "e:oauth" }), (e: any) => e.code === "reauth_required" && e.action === "plur1bus login e:oauth");
  });

  it("delegated, adc, unknown and missing credentials are typed errors", async () => {
    const cli = validateProfile({ ...common, id: "e:cli", kind: "external_cli", auth_header_scheme: "Authorization: Bearer {token}" });
    const adc = validateProfile({ ...common, id: "e:adc", kind: "adc", auth_header_scheme: "Authorization: Bearer {token}" });
    const mk = (adcSrc?: any) => createCredentialsProvider({ profiles: [{ profile: cli, entries: [] }, { profile: adc, entries: [] }, { profile: keyProfile, entries: [{ id: "a", secretRef: "gone" }] }], store: new InMemorySecretStore(), clock: new FakeClock(), refresher: noRefresher, ...(adcSrc ? { adc: adcSrc } : {}) });
    await assert.rejects(mk().getAuthorization({ profileId: "e:cli" }), (e: any) => e.code === "delegated_login");
    await assert.rejects(mk().getAuthorization({ profileId: "e:adc" }), (e: any) => e.code === "adc_unavailable");
    const l = await mk({ token: async () => ({ accessToken: "CANARY-ADC", expiresAt: 5 }) }).getAuthorization({ profileId: "e:adc" });
    assert.equal(l.header.value, "Bearer CANARY-ADC"); assert.equal(l.expiresAt, 5);
    await assert.rejects(mk().getAuthorization({ profileId: "nope" }), (e: any) => e.code === "unknown_profile");
    await assert.rejects(mk().getAuthorization({ profileId: "e:key" }), (e: any) => e.code === "no_credential");
  });
});
