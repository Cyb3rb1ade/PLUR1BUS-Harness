import { it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { login } from "../../src/auth/login.ts";
import { createOAuthHttp, parseTokenResponse, HttpRefresher } from "../../src/auth/http.ts";
import { validateProfile, loadProfiles } from "../../src/auth/profile.ts";
import { RefreshOwner } from "../../src/auth/refresh.ts";
import { InMemorySecretStore, decodeRecord, encodeRecord } from "../../src/auth/secret-store.ts";
import { mockOAuth } from "./mock-oauth.ts";
import { FakeClock, MARK } from "./helpers.ts";
const env = { env: {}, platform: "darwin" as const, stdoutIsTTY: true };
const secrets = [...Object.values(MARK), "CANARY-CODE", "CANARY-DEVICE", "CANARY-USER", "CANARY-CLIENT-SECRET", "CANARY-ASSERTION"];
const safe = (value: unknown) => { const text = inspect(value, { depth: 10 }) + JSON.stringify(value); for (const secret of secrets) assert.ok(!text.includes(secret), `redaction of ${secret}`); };
it("profile validation is closed across flow fields and every prohibited kind", async t => {
  const m = await mockOAuth(); t.after(() => m.close()); const p = m.profile();
  for (const over of [{ scopes: "read" }, { scopes: ["a b"] }, { redirect: { type: "public" } }, { redirect: { type: "loopback", port: 65536 } }, { redirect: { type: "loopback", token: MARK.key } }, { refresh: { mode: "rotating", token: MARK.key } }, { tokenUrl: `https://${MARK.key}@example.test/token` }, { client_id: 12 }, { audience: [] }, { token_endpoint: "https://different.test/token" }, { policy_source: undefined }, { policy_checked: undefined }, { [MARK.access]: MARK.refresh }]) {
    assert.throws(() => validateProfile({ ...p, ...over }), e => { safe(e); return true; });
  }
  for (const kind of ["api_key", "oauth_pkce", "device_code", "adc", "external_cli"]) assert.throws(() => loadProfiles([{ ...p, kind, policy_status: "prohibited" }]));
});
it("token parser refuses malformed responses, no reflected secrets or unsafe headers", () => {
  for (const data of [{ access_token: MARK.access }, { access_token: `${MARK.access}\r\n`, token_type: "Bearer" }, { access_token: MARK.access, token_type: "Bearer", expires_in: -1 }, { access_token: MARK.access, token_type: "Bearer", expires_in: Infinity }]) assert.throws(() => parseTokenResponse(data), e => { safe(e); return true; });
  safe(parseTokenResponse({ access_token: MARK.access, refresh_token: MARK.refresh, token_type: "Bearer", expires_in: 3600 }));
});
it("all login errors and log fields discard foreign UI, callback, endpoint, storage errors", async t => {
  const m = await mockOAuth(); t.after(() => m.close());
  for (const mode of ["ui", "callback", "denied", "token", "store"]) {
    const logs: unknown[] = [], store = new InMemorySecretStore(); if (mode === "store") store.failSets = 1;
    if (mode === "token") m.fail({ status: 400, error: "invalid_grant" }); else m.fail();
    await assert.rejects(login({ profile: m.profile(), store, clock: new FakeClock(), http: createOAuthHttp({ egress: m.egress }), env, pasteCallback: true, log: (e, f) => logs.push([e, f]),
      onAuthorization: async () => { if (mode === "ui") throw new Error(secrets.join(" ")); },
      readCallback: async info => {
        if (mode === "callback") return `${MARK.access}://bad/${MARK.key}`;
        const callback = new URL(await m.callback(info.authorizationUrl));
        if (mode === "denied") { callback.searchParams.delete("code"); callback.searchParams.set("error", MARK.refresh); callback.searchParams.set("error_description", MARK.access); }
        return callback.href;
      },
    }), e => { safe(e); return true; }); safe(logs);
    assert.equal(await store.get("auth/test"), undefined);
  }
});
it("wrong paste origin/path, duplicate state/code and callback error never exchange", async t => {
  const m = await mockOAuth(); t.after(() => m.close());
  for (const variant of ["origin", "path", "state", "code", "fragment", "error"]) {
    await assert.rejects(login({ profile: m.profile(), store: new InMemorySecretStore(), clock: new FakeClock(), http: createOAuthHttp({ egress: m.egress }), env, pasteCallback: true,
      readCallback: async info => { const cb = new URL(await m.callback(info.authorizationUrl));
        if (variant === "origin") cb.hostname = "localhost";
        if (variant === "path") cb.pathname = "/wrong";
        if (variant === "state") cb.searchParams.append("state", MARK.key);
        if (variant === "code") cb.searchParams.append("code", MARK.key);
        if (variant === "fragment") cb.hash = MARK.key;
        if (variant === "error") cb.searchParams.set("error", "access_denied");
        return cb.href;
      },
    }), e => { safe(e); return true; });
  }
  assert.equal(m.requests.filter(r => r.path === "/token").length, 0);
});
it("device expiry uses fake clock, cancellation aborts pending UI, browser failure closes socket", async t => {
  const m = await mockOAuth(); t.after(() => m.close()); const clock = new FakeClock();
  m.polls.push(...Array.from({ length: 150 }, () => "authorization_pending"));
  await assert.rejects(login({ profile: m.profile({ deviceUrl: `${m.base}/device` }), store: new InMemorySecretStore(), clock, http: createOAuthHttp({ egress: m.egress }), env: { ...env, env: { SSH_CONNECTION: "yes" } }, sleep: async ms => clock.advance(ms) }), (e: any) => e.code === "login_timeout");
  const controller = new AbortController(); let callback = "";
  await assert.rejects(login({ profile: m.profile(), store: new InMemorySecretStore(), clock, http: createOAuthHttp({ egress: m.egress }), env, signal: controller.signal, openBrowser: async url => { callback = new URL(url).searchParams.get("redirect_uri")!; controller.abort(MARK.key); } }), e => { safe(e); return true; });
  await assert.rejects(fetch(callback));
});
it("OAuth record and refresh snapshots are redacted; secret encoding still persists the full rotation", async t => {
  const m = await mockOAuth(); t.after(() => m.close()); const clock = new FakeClock(), store = new InMemorySecretStore();
  const raw = encodeRecord({ v: 1, accessToken: MARK.access, refreshToken: MARK.refresh, expiresAt: clock.now() + 100, generation: 0 });
  safe(decodeRecord(raw, "test")); await store.set("auth/test", raw);
  const owner = new RefreshOwner({ store, clock, refresher: new HttpRefresher(createOAuthHttp({ egress: m.egress })) }); t.after(() => owner.close());
  const result = await owner.fresh(m.profile(), "auth/test", "a"); safe(result); safe(owner);
  assert.ok((await store.get("auth/test"))!.includes(MARK.refresh));
});

it("a UI port throwing a foreign AuthError cannot smuggle a code or message into logs", async t => {
  const m = await mockOAuth(); t.after(() => m.close()); const { AuthError } = await import("../../src/auth/errors.ts"); const logs: unknown[] = [];
  await assert.rejects(login({ profile: m.profile(), store: new InMemorySecretStore(), clock: new FakeClock(), http: createOAuthHttp({ egress: m.egress }), env, log: (e, fields) => logs.push([e, fields]), openBrowser: async () => { throw new AuthError(MARK.access as any, MARK.refresh); } }), e => { safe(e); return true; }); safe(logs);
});

it("refresh-owner storage-read failures never copy token-bearing messages", async t => {
  const m = await mockOAuth(); t.after(() => m.close());
  const owner = new RefreshOwner({ store: { get: async () => { throw new Error(MARK.refresh); }, set: async () => {}, delete: async () => {} }, clock: new FakeClock(), refresher: new HttpRefresher(createOAuthHttp({ egress: m.egress })) });
  await assert.rejects(owner.fresh(m.profile(), "test/ref", "a"), e => { safe(e); return true; }); owner.close();
});
