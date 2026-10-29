/** Real Core enrollment, ordinary factor login and native one-use proof transport. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { connect } from "@plur1bus/module-api";
import { createCore } from "../../core/src/core.ts";
import { flatTestInternals } from "../../core/test/helpers/flat-embedder.ts";
import { createCoreLink } from "../src/core-link.ts";
import { createApiServer } from "../src/server.ts";
import { AccountStore } from "../src/account-store.ts";
import { FakeClock } from "../src/clock.ts";
import { hashPassword } from "../src/password.ts";
import { TotpService, totpCodeAt } from "../src/totp.ts";
import { memoryAuditSink } from "../src/rbac-bridge.ts";
import { vector } from "./webauthn-vectors.ts";
import { registerCredential } from "../src/webauthn.ts";

async function fixture(t: import("node:test").TestContext, factor: "totp" | "passkey" = "totp") {
  const home = await mkdtemp(join(tmpdir(), "desktop-mfa-")), cfg = defaults(); cfg.agents.main = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false },
    dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  await writeFile(join(home, "config.json"), JSON.stringify(cfg));
  const core = createCore({ home, testInternals: flatTestInternals() });
  t.after(async () => { await core.stop({ budgetMs: 5000 }); await rm(home, { recursive: true, force: true }); });
  await core.start();
  const local = await connect({ address: core.address, token: core.token, expectedServerPid: process.pid });
  t.after(() => local.close());
  const link = createCoreLink(home); t.after(() => link.close());
  const accounts = new AccountStore({ path: ":memory:", resolve: async userId => {
    const result = await link.serviceCall!<{ person: import("../src/account-store.ts").CorePerson | null }>("admin.api.person.resolve", { userId });
    return result.person;
  } });
  t.after(() => accounts.close());
  const password = "fixture-desktop-mfa-password", clock = new FakeClock(Date.now());
  await accounts.createPending("local-owner", "alice", await hashPassword(password)); await accounts.activate("local-owner");
  let totpSecret = "";
  const passkey = vector(-7, "https://harness.example");
  if (factor === "totp") {
    const service = new TotpService({ store: accounts.totp, clock, issuer: "fixture" });
    const setup = await service.begin("local-owner", "alice"); totpSecret = setup.secret;
    assert.equal((await service.confirm("local-owner", totpCodeAt(totpSecret, clock.now()))).ok, true); clock.advance(30_000);
  } else accounts.putPasskey("local-owner", { ...registerCredential(passkey.registration, passkey.context), name: "Fixture passkey" });
  const audit = memoryAuditSink(), logs: string[] = [], log = (message: string, fields?: object) => logs.push(JSON.stringify({ message, fields }));
  const api = createApiServer({ core: link, home, clock, accounts, users: accounts, totp: accounts.totp,
    requireSecondFactor: "always", webauthnOrigin: "https://harness.example", ownerToken: randomBytes(32).toString("hex"),
    audit, logger: { info: log, warn: log, debug: log, error: log }, rateClasses: {
      auth: { capacity: 100, refillPerSec: 100 }, read: { capacity: 100, refillPerSec: 100 }, write: { capacity: 100, refillPerSec: 100 },
      totp: { capacity: 100, refillPerSec: 100 }, upload: { capacity: 100, refillPerSec: 100 },
    } });
  t.after(() => api.close()); const { url } = await api.listen();
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { response, body: await response.json() as Record<string, any> };
  };
  const grant = await local.call<any>("device.pair", { kind: "desktop", extensions: true, imports: true });
  const paired = await post("/api/v1/desktop/pair", { code: grant.code, kind: "desktop", name: "MFA fixture desktop",
    publicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64") });
  assert.equal(paired.response.status, 200, JSON.stringify(paired.body));
  const token = paired.body.token as string, bearer = { authorization: `Bearer ${token}` };
  const login = async () => {
    if (factor === "passkey") {
      const options = await post("/api/v1/session/passkey/options", { username: "alice" });
      passkey.context.challenge = options.body.challenge;
      const signed = await post("/api/v1/session/passkey", { ...passkey.assertion(), challenge: options.body.challenge });
      assert.equal(signed.response.status, 200, JSON.stringify(signed.body));
      return signed.response.headers.get("set-cookie")!.split(";")[0]!;
    }
    const passwordStep = await post("/api/v1/session", { username: "alice", password });
    assert.equal(passwordStep.body.schema, "session.challenge/1"); assert.equal(passwordStep.response.headers.get("set-cookie"), null);
    const signed = await post("/api/v1/session/totp", { challenge: passwordStep.body.challenge, code: totpCodeAt(totpSecret, clock.now()) });
    assert.equal(signed.response.status, 200, JSON.stringify(signed.body));
    return signed.response.headers.get("set-cookie")!.split(";")[0]!;
  };
  const csrf = async (cookie: string) => (await (await fetch(url + "/api/v1/csrf", { headers: { cookie } })).json() as { token: string }).token;
  const start = async (purpose = "extensions") => post("/api/v1/desktop/step-up/start", { purpose }, bearer);
  const poll = async (challengeId: string) => post("/api/v1/desktop/step-up/poll", { challengeId }, bearer);
  const approve = async (cookie: string, userCode: string) => post("/api/v1/desktop/step-up/decision", { userCode, decision: "approve" }, { cookie, "x-csrf-token": await csrf(cookie) });
  return { home, api, core, local, accounts, clock, token, bearer, url, post, login, csrf, start, poll, approve, logs, audit, paired, grant };
}

test("actual Core enrollment and password+TOTP approval authorize one-use native upload and ticket headers", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.post("/api/v1/desktop/redeem", { token: f.token, origin: f.url })).response.status, 403);
  const challenge = await f.start(); assert.equal(challenge.response.status, 200, JSON.stringify(challenge.body));
  const cookie = await f.login();
  assert.equal((await f.post("/api/v1/desktop/step-up/decision", { userCode: challenge.body.userCode, decision: "approve" }, { cookie })).response.status, 403, "CSRF remains mandatory");
  const approval = await f.approve(cookie, challenge.body.userCode); assert.equal(approval.response.status, 200, JSON.stringify(approval.body));
  assert.equal(JSON.stringify(approval.body).includes("proofToken"), false);
  const proof = await f.poll(challenge.body.challengeId); assert.equal(proof.body.state, "approved");
  const multipart = '--mfa-fixture\r\nContent-Disposition: form-data; name="file"; filename="package.p1x"\r\n\r\npackage-fixture\r\n--mfa-fixture--\r\n';
  const upload = async (operationProof?: string) => fetch(f.url + "/api/v1/extensions/upload", { method: "POST",
    headers: { ...f.bearer, "content-type": "multipart/form-data; boundary=mfa-fixture",
      ...operationProof ? { "x-plur1bus-desktop-step-up": operationProof } : {} }, body: multipart });
  assert.equal((await upload()).status, 403);
  assert.equal((await upload(proof.body.proofToken)).status, 200);
  assert.equal((await upload(proof.body.proofToken)).status, 403, "an upload proof cannot be replayed");
  const ticketProof = await f.poll(challenge.body.challengeId);
  const redeemed = await f.post("/api/v1/desktop/redeem", { token: f.token, origin: f.url }, { "x-plur1bus-desktop-step-up": ticketProof.body.proofToken });
  assert.equal(redeemed.response.status, 200, JSON.stringify(redeemed.body));
  assert.equal((await f.post("/api/v1/desktop/redeem", { token: f.token, origin: f.url }, { "x-plur1bus-desktop-step-up": proof.body.proofToken })).response.status, 403);
  const spent = await f.post("/api/v1/desktop/ticket", { ticket: redeemed.body.ticket, deviceId: f.paired.body.device.id }, { origin: f.url });
  assert.equal(spent.response.status, 200, JSON.stringify(spent.body));
  const nativeCookie = spent.response.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((await fetch(f.url + "/api/v1/whoami", { headers: { cookie: nativeCookie } })).status, 200);
  const nativeCsrf = await f.csrf(nativeCookie);
  assert.equal((await f.post("/api/v1/desktop/step-up/decision", { userCode: challenge.body.userCode, decision: "approve" }, { cookie: nativeCookie, "x-csrf-token": nativeCsrf })).response.status, 403);
  await f.local.call("device.revoke", { id: f.paired.body.device.id });
  assert.equal((await fetch(f.url + "/api/v1/whoami", { headers: { cookie: nativeCookie } })).status, 401);
  const observable = f.logs.join("\n") + JSON.stringify(f.audit.events) + await readFile(join(f.home, "logs", "audit.log"), "utf8");
  for (const secret of [f.token, f.grant.code, proof.body.proofToken, ticketProof.body.proofToken, redeemed.body.ticket, challenge.body.challengeId]) assert.equal(observable.includes(secret), false);
});

test("actual passkey login can approve only a fixed native session-purpose grant", { timeout: 60000 }, async t => {
  const f = await fixture(t, "passkey"), challenge = await f.start("session");
  assert.equal(challenge.response.status, 200, JSON.stringify(challenge.body));
  const cookie = await f.login();
  assert.equal((await f.approve(cookie, challenge.body.userCode)).response.status, 200);
  const proof = await f.poll(challenge.body.challengeId);
  assert.equal(proof.body.state, "approved");
  f.clock.advance(300_000);
  assert.equal((await f.poll(challenge.body.challengeId)).body.state, "expired");
  assert.equal((await f.post("/api/v1/desktop/redeem", { token: f.token, origin: f.url }, { "x-plur1bus-desktop-step-up": proof.body.proofToken })).response.status, 403);
});

test("native approval entrypoints refuse ordinary cookies and anonymous callers without a real device bearer", async t => {
  const { start } = await import("./helpers.ts");
  const h = await start(); t.after(() => h.close());
  for (const [path, body] of [
    ["start", { purpose: "session" }], ["poll", { challengeId: "A".repeat(43) }], ["cancel", { challengeId: "A".repeat(43) }],
  ] as const) {
    const response = await fetch(h.url + `/api/v1/desktop/step-up/${path}`, { method: "POST",
      headers: { "content-type": "application/json", cookie: "plur1bus_session=forged" }, body: JSON.stringify(body) });
    assert.equal(response.status, 401, path);
    assert.equal((await response.json() as { reason: string }).reason, "invalid-device-token");
  }
});
