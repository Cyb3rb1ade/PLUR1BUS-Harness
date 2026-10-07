import { it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { inspect } from "node:util";
import { GoogleAdc } from "../../src/auth/adc.ts";
import { createOAuthHttp, HttpRefresher } from "../../src/auth/http.ts";
import { createAuthSecretStore } from "../../src/auth/secret-store.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { mockOAuth } from "./mock-oauth.ts";
import { FakeClock, MARK } from "./helpers.ts";

it("ADC authorized_user from explicit env, concurrent refresh and expiry", async t => {
  const m = await mockOAuth(); t.after(() => m.close()); const clock = new FakeClock(), paths: string[] = [];
  const adc = new GoogleAdc({ http: createOAuthHttp({ egress: m.egress }), clock, env: () => ({ GOOGLE_APPLICATION_CREDENTIALS: "/virtual/credentials.json" }), homedir: () => "/virtual/home", platform: "linux",
    readFile: async path => { paths.push(path); return JSON.stringify({ type: "authorized_user", client_id: "test-adc-client", client_secret: "CANARY-CLIENT-SECRET", refresh_token: MARK.refresh }); },
  });
  const profile = m.profile({ kind: "adc" });
  const tokens = await Promise.all([adc.token(profile), adc.token(profile)]);
  assert.equal(tokens[0].accessToken, tokens[1].accessToken); assert.deepEqual(paths, ["/virtual/credentials.json"]);
  assert.equal(m.requests[0]!.form.get("client_secret"), "CANARY-CLIENT-SECRET");
  clock.advance(3_500_000); await adc.token(profile); assert.equal(m.requests.length, 2);
  assert.ok(!inspect(adc).includes(MARK.refresh)); assert.ok(!JSON.stringify(adc).includes("CANARY-CLIENT-SECRET"));
});

for (const platform of ["linux", "win32"] as const) it(`ADC gcloud path and service-account RS256 assertion (${platform})`, async t => {
  const m = await mockOAuth(); t.after(() => m.close()); const clock = new FakeClock();
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }); let path = "";
  m.checkAssertion(assertion => {
    const [header, claims, signature] = assertion.split(".");
    assert.equal(JSON.parse(Buffer.from(header!, "base64url").toString()).alg, "RS256");
    const c = JSON.parse(Buffer.from(claims!, "base64url").toString());
    assert.equal(c.iss, "test@example.test"); assert.equal(c.aud, `${m.base}/token`); assert.equal(c.scope, "test.read"); assert.equal(c.exp - c.iat, 3600);
    assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), keys.publicKey, Buffer.from(signature!, "base64url")), true);
  });
  const adc = new GoogleAdc({ http: createOAuthHttp({ egress: m.egress }), clock, env: () => ({ APPDATA: "C:\\Virtual" }), homedir: () => "/virtual/home", platform,
    readFile: async p => { path = p; return JSON.stringify({ type: "service_account", client_email: "test@example.test", private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: `${m.base}/token` }); },
  });
  await adc.token(m.profile({ kind: "adc" }));
  assert.match(path, platform === "win32" ? /gcloud\\application_default_credentials.json$/ : /\.config\/gcloud\/application_default_credentials.json$/);
  clock.advance(3_500_000); await adc.token(m.profile({ kind: "adc" })); assert.equal(m.requests.length, 2);
});

it("ADC never reflects credential paths, content, signing or network errors", async t => {
  const m = await mockOAuth(); t.after(() => m.close());
  for (const readFile of [async () => { throw new Error(MARK.key); }, async () => MARK.refresh, async () => JSON.stringify({ type: "service_account", private_key: MARK.key, client_email: MARK.access })]) {
    const adc = new GoogleAdc({ http: createOAuthHttp({ egress: m.egress }), clock: new FakeClock(), env: () => ({ GOOGLE_APPLICATION_CREDENTIALS: MARK.access }), homedir: () => MARK.key, platform: "linux", readFile });
    await assert.rejects(adc.token(m.profile({ kind: "adc" })), (e: any) => e.code === "adc_unavailable" && !Object.values(MARK).some(s => inspect(e).includes(s)));
  }
});

it("HTTP errors discard response bodies; invalid_grant vs transient; egress denies before request", async t => {
  const m = await mockOAuth(); t.after(() => m.close()); const http = createOAuthHttp({ egress: m.egress });
  for (const [status, error, reason] of [[400, "invalid_grant", "invalid_grant"], [503, "server_error", "transient"], [429, "temporarily_unavailable", "transient"]] as const) {
    m.fail({ status, error });
    await assert.rejects(new HttpRefresher(http).refresh({ profile: m.profile(), refreshToken: MARK.refresh }), (e: any) => e.reason === reason && !Object.values(MARK).some(s => inspect(e).includes(s)));
  }
  const before = m.requests.length;
  await assert.rejects(createOAuthHttp({ egress: { decide: async () => ({ allowed: false, reason: "host-not-allowed", message: MARK.key }) } }).post(`${m.base}/token`, { refresh_token: MARK.refresh }), (e: any) => !inspect(e).includes(MARK.key));
  assert.equal(m.requests.length, before);
});

it("auth adapter uses existing secrets API; new adapter reads the persisted value; no real keychain", async () => {
  const backend = createMemoryBackend(), audit: unknown[] = [], logs: unknown[] = [];
  const secrets = createSecretStore({ keyring: backend, file: createMemoryBackend({ available: false }), fileFallback: () => false, audit: { record: r => { audit.push(r); } }, logger: { debug: (...a) => { logs.push(a); }, info: (...a) => { logs.push(a); }, warn: (...a) => { logs.push(a); } } });
  const store = createAuthSecretStore(secrets);
  await store.set("test/token", MARK.access);
  assert.equal(await createAuthSecretStore(secrets).get("test/token"), MARK.access);
  assert.ok(!inspect([audit, logs, store]).includes(MARK.access));
  assert.equal(await store.get("missing"), undefined); await store.delete("test/token"); assert.equal(await store.get("test/token"), undefined);
});

it("ADC preserves a rotated authorized_user refresh token when later responses omit one", async t => {
  const m = await mockOAuth(); t.after(() => m.close()); const clock = new FakeClock(), http = createOAuthHttp({ egress: m.egress }); let exchanges = 0;
  const adc = new GoogleAdc({ http: { post: async (url, form) => { exchanges++; const data = await http.post(url, form); if (exchanges > 1) delete data.refresh_token; return data; } }, clock, env: () => ({ GOOGLE_APPLICATION_CREDENTIALS: "/virtual/adc" }), readFile: async () => JSON.stringify({ type: "authorized_user", client_id: "test-client", client_secret: "CANARY-CLIENT-SECRET", refresh_token: MARK.refresh }) });
  const p = m.profile({ kind: "adc" }); await adc.token(p); clock.advance(3_500_000); await adc.token(p);
  // Inspect the third request with a stub: the vendor fixture rotates every response, even when our transport hid it.
  clock.advance(3_500_000);
  await assert.rejects(adc.token(p));
  const forms = m.requests.filter(r => r.path === "/token").map(r => r.form);
  assert.equal(forms[2]!.get("refresh_token"), forms[1]!.get("refresh_token"));
});

it("ADC environment-port exceptions and returned token snapshots are redacted", async t => {
  const m = await mockOAuth(); t.after(() => m.close());
  const adc = new GoogleAdc({ http: createOAuthHttp({ egress: m.egress }), clock: new FakeClock(), env: () => { throw new Error(MARK.access); } });
  await assert.rejects(adc.token(m.profile({ kind: "adc" })), e => !inspect(e).includes(MARK.access));
  const valid = new GoogleAdc({ http: createOAuthHttp({ egress: m.egress }), clock: new FakeClock(), env: () => ({}), readFile: async () => JSON.stringify({ type: "authorized_user", client_id: "test-client", client_secret: "CANARY-CLIENT-SECRET", refresh_token: MARK.refresh }) });
  const token = await valid.token(m.profile({ kind: "adc" }));
  assert.ok(!inspect(token).includes(MARK.access)); assert.ok(!JSON.stringify(token).includes(MARK.access));
});

it("static Google authorized_user ADC renews after expiry and a new ADC instance", async t => {
  const m = await mockOAuth(); t.after(() => m.close()); m.staticRefresh(); const clock = new FakeClock();
  const options = { http: createOAuthHttp({ egress: m.egress }), clock, env: () => ({ GOOGLE_APPLICATION_CREDENTIALS: "/virtual/google-adc" }), readFile: async () => JSON.stringify({ type: "authorized_user", client_id: "test-client", client_secret: "CANARY-CLIENT-SECRET", refresh_token: MARK.refresh }) };
  const profile = m.profile({ kind: "adc" }), adc = new GoogleAdc(options);
  await adc.token(profile); clock.advance(3_700_000); await adc.token(profile); await new GoogleAdc(options).token(profile);
  assert.equal(m.requests.length, 3); assert.ok(m.requests.every(r => r.form.get("refresh_token") === MARK.refresh));
});
