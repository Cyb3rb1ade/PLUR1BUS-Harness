import { it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { login } from "../../src/auth/login.ts";
import { createOAuthHttp, HttpRefresher } from "../../src/auth/http.ts";
import { RefreshOwner } from "../../src/auth/refresh.ts";
import { InMemorySecretStore, decodeRecord } from "../../src/auth/secret-store.ts";
import { mockOAuth } from "./mock-oauth.ts";
import { FakeClock, MARK } from "./helpers.ts";
const desktop = { platform: "darwin" as const, env: {}, stdoutIsTTY: true };
const ssh = { ...desktop, env: { SSH_CONNECTION: "test" } };

it("PKCE loopback is IPv4-only, random port, one callback; refresh rotates once and survives restart", async t => {
  const m = await mockOAuth(); t.after(() => m.close());
  const store = new InMemorySecretStore(), clock = new FakeClock(), profile = m.profile();
  const http = createOAuthHttp({ egress: m.egress });
  let redirect = ""; let callback = "";
  const result = await login({ profile, store, clock, http, env: desktop, openBrowser: async url => {
    redirect = new URL(url).searchParams.get("redirect_uri")!;
    assert.equal(new URL(redirect).hostname, "127.0.0.1"); assert.notEqual(new URL(redirect).port, "0");
    callback = await m.callback(url);
    const res = await fetch(callback); assert.equal(res.status, 200);
  } });
  assert.equal(result.method, "loopback_pkce");
  assert.ok(!JSON.stringify(result).includes(MARK.access));
  await assert.rejects(fetch(callback));
  const initial = decodeRecord((await store.get("auth/test"))!, profile.id);
  clock.advance(3_500_000);
  const refresher = new HttpRefresher(http);
  const owner = new RefreshOwner({ store, clock, refresher });
  const both = await Promise.all([owner.fresh(profile, "auth/test", "a"), owner.fresh(profile, "auth/test", "a")]);
  assert.equal(both[0].record.generation, 1); assert.equal(both[1].record.generation, 1);
  assert.equal(m.requests.filter(r => r.form.get("grant_type") === "refresh_token").length, 1);
  assert.notEqual(both[0].record.refreshToken, initial.refreshToken);
  clock.advance(3_500_000);
  await new RefreshOwner({ store, clock, refresher }).fresh(profile, "auth/test", "a");
  assert.equal(m.requests.filter(r => r.form.get("grant_type") === "refresh_token").length, 2);
});

for (const method of ["loopback_ssh", "paste_callback"] as const) it(`headless ${method} completes with state/PKCE`, async t => {
  const m = await mockOAuth(); t.after(() => m.close());
  let hint = "";
  const result = await login({ profile: m.profile(), store: new InMemorySecretStore(), clock: new FakeClock(), http: createOAuthHttp({ egress: m.egress }), env: ssh,
    pasteCallback: method === "paste_callback", openBrowser: async () => { throw new Error("must not open remotely"); },
    onAuthorization: async info => { hint = info.sshHint ?? ""; if (method === "loopback_ssh") await fetch(await m.callback(info.authorizationUrl)); },
    readCallback: async info => m.callback(info.authorizationUrl),
  });
  assert.equal(result.method, method);
  if (method === "loopback_ssh") assert.match(hint, /ssh -L (\d+):127\.0\.0\.1:\1/);
});

for (const paste of [false, true]) it(`state mismatch aborts without token exchange (${paste ? "paste" : "listener"})`, async t => {
  const m = await mockOAuth(); t.after(() => m.close());
  const store = new InMemorySecretStore();
  const wrong = async (url: string) => { const cb = new URL(await m.callback(url)); cb.searchParams.set("state", MARK.key); return cb.href; };
  await assert.rejects(login({ profile: m.profile(), store, clock: new FakeClock(), http: createOAuthHttp({ egress: m.egress }), env: desktop, pasteCallback: paste,
    openBrowser: async url => { const res = await fetch(await wrong(url)); assert.equal(res.status, 400); const body = await res.text(); assert.ok(!body.includes(MARK.key)); },
    readCallback: info => wrong(info.authorizationUrl),
  }), (e: any) => e.code === "state_mismatch" && !inspect(e).includes(MARK.key));
  assert.equal(await store.get("auth/test"), undefined);
  assert.equal(m.requests.filter(r => r.path === "/token").length, 0);
});

it("loopback timeout closes listener even when browser function hangs", async t => {
  const m = await mockOAuth(); t.after(() => m.close()); let callback = "";
  await assert.rejects(login({ profile: m.profile(), store: new InMemorySecretStore(), clock: new FakeClock(), http: createOAuthHttp({ egress: m.egress }), env: desktop, timeoutMs: 30,
    openBrowser: url => { callback = new URL(url).searchParams.get("redirect_uri")!; return new Promise(() => {}); },
  }), (e: any) => e.code === "login_timeout");
  await assert.rejects(fetch(callback));
});

it("device ladder polls pending, slow_down adds five seconds, then persists", async t => {
  const m = await mockOAuth(); t.after(() => m.close()); m.polls.push("authorization_pending", "slow_down", "authorization_pending");
  const clock = new FakeClock(), waits: number[] = [], store = new InMemorySecretStore();
  const result = await login({ profile: m.profile({ deviceUrl: `${m.base}/device` }), store, clock, http: createOAuthHttp({ egress: m.egress }), env: ssh,
    sleep: async ms => { waits.push(ms); clock.advance(ms); }, onDevice: async info => { assert.equal(info.userCode, "CANARY-USER"); assert.ok(info.verificationUri.startsWith(m.base)); assert.ok(!inspect(info).includes("CANARY-DEVICE")); assert.ok(!JSON.stringify(info).includes("CANARY-USER")); },
  });
  assert.equal(result.method, "device_code"); assert.deepEqual(waits, [1000, 1000, 6000, 6000]);
  assert.ok(await store.get("auth/test"));
});

for (const [error, code] of [["access_denied", "access_denied"], ["expired_token", "login_timeout"]]) it(`device ${error} is terminal and redacted`, async t => {
  const m = await mockOAuth(); t.after(() => m.close()); m.polls.push(error!); const clock = new FakeClock();
  await assert.rejects(login({ profile: m.profile({ deviceUrl: `${m.base}/device` }), store: new InMemorySecretStore(), clock, http: createOAuthHttp({ egress: m.egress }), env: ssh, sleep: async ms => clock.advance(ms) }), (e: any) => e.code === code && !inspect(e).includes(MARK.access));
  assert.equal(m.requests.filter(r => r.path === "/token").length, 1);
});

it("prohibited profiles cannot enter login even without catalogue loading", async () => {
  await assert.rejects(login({ profile: { policy_status: "prohibited" } as any } as any), (e: any) => e.code === "invalid_profile");
});

for (const flow of ["loopback_ssh", "paste_callback", "device_code"] as const) it(`${flow} rotates through audited secrets and a restarted credentials provider`, async t => {
  const m = await mockOAuth(); t.after(() => m.close());
  const { createSecretStore } = await import("../../src/secrets/store.ts");
  const { createMemoryBackend } = await import("../../src/secrets/memory-backend.ts");
  const { createAuthSecretStore } = await import("../../src/auth/secret-store.ts");
  const { createCredentialsProvider } = await import("../../src/auth/credentials.ts");
  const backend = createMemoryBackend(), audit: unknown[] = [], clock = new FakeClock();
  const service = () => createSecretStore({ keyring: backend, file: createMemoryBackend({ available: false }), fileFallback: () => false, audit: { record: r => { audit.push(r); } } });
  const store = createAuthSecretStore(service()), profile = m.profile(flow === "device_code" ? { deviceUrl: `${m.base}/device` } : {}), http = createOAuthHttp({ egress: m.egress });
  await login({ profile, store, clock, http, env: ssh, pasteCallback: flow === "paste_callback", sleep: async ms => clock.advance(ms),
    onAuthorization: async info => { if (flow === "loopback_ssh") await fetch(await m.callback(info.authorizationUrl)); }, readCallback: info => m.callback(info.authorizationUrl) });
  const provider = createCredentialsProvider({ profiles: [{ profile, entries: [] }], store, clock, refresher: new HttpRefresher(http) });
  t.after(() => provider.close()); clock.advance(3_500_000);
  const leases = await Promise.all([provider.getAuthorization({ profileId: profile.id }), provider.getAuthorization({ profileId: profile.id })]);
  assert.equal(leases[0].generation, 1); assert.equal(leases[1].generation, 1); provider.close();
  const restarted = createCredentialsProvider({ profiles: [{ profile, entries: [] }], store: createAuthSecretStore(service()), clock, refresher: new HttpRefresher(http) }); t.after(() => restarted.close());
  clock.advance(3_500_000); assert.equal((await restarted.getAuthorization({ profileId: profile.id })).generation, 2);
  assert.equal(m.requests.filter(r => r.form.get("grant_type") === "refresh_token").length, 2);
  assert.ok(!inspect(audit).includes(MARK.access)); assert.ok(!inspect(audit).includes(MARK.refresh));
});

it("a headless caller can explicitly select SSH loopback from a device profile's planned fallbacks", async t => {
  const m = await mockOAuth(); t.after(() => m.close()); const clock = new FakeClock();
  const result = await login({ profile: m.profile({ deviceUrl: `${m.base}/device` }), method: "loopback_ssh", store: new InMemorySecretStore(), clock, http: createOAuthHttp({ egress: m.egress }), env: ssh, sleep: async ms => clock.advance(ms),
    onAuthorization: async info => { assert.match(info.sshHint!, /127\.0\.0\.1/); await fetch(await m.callback(info.authorizationUrl)); },
  });
  assert.equal(result.method, "loopback_ssh"); assert.equal(m.requests.filter(r => r.path === "/device").length, 0);
});
it("method overrides cannot enable a graphical browser in a remote session", async t => {
  const m = await mockOAuth(); t.after(() => m.close()); let opened = false;
  await assert.rejects(login({ profile: m.profile(), method: "loopback_pkce", store: new InMemorySecretStore(), clock: new FakeClock(), http: createOAuthHttp({ egress: m.egress }), env: ssh, timeoutMs: 30, openBrowser: async () => { opened = true; } }), (e: any) => e.code === "login_failed"); assert.equal(opened, false);
});
