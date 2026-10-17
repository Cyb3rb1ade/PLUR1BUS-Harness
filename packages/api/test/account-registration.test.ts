import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { bootstrapHash } from "../src/bootstrap.ts";
import { AccountStore } from "../src/account-store.ts";
import { fakeCore, start, raw, jsonHeaders, login, write, OWNER_TOKEN } from "./helpers.ts";

test("failed consumption cleans pending credentials; collision is disclosed only after a valid invitation", async t => {
  const accounts = new AccountStore({ path: ":memory:", resolve: async userId => ({ userId, kind: "person", role: "member", disabled: false, version: 1 }) });
  const core = fakeCore(), code = randomBytes(32).toString("base64url"), password = randomBytes(24).toString("base64url"); let failConsume = true;
  Object.assign(core, { serviceCall: async (method: string, p: { token?: string }) => { if (p.token !== code || method === "user.invite.redeem" && failConsume) throw new Error("invalid invitation"); return { userId: "invited", role: "member" }; } });
  const h = await start({ accounts, core, rateClasses: { auth: { capacity: 100, refillPerSec: 100 }, read: { capacity: 100, refillPerSec: 100 }, write: { capacity: 100, refillPerSec: 100 } } }); t.after(async () => { await h.close(); accounts.close(); });
  const redeem = (inputCode: string, username = "alice") => raw(h, { method: "POST", path: "/api/v1/invitations/redeem", headers: jsonHeaders(), body: JSON.stringify({ code: inputCode, username, password }) });
  assert.equal((await redeem(code)).json.error, "E_INVITE_INVALID"); assert.equal(await accounts.findById("invited"), undefined);
  failConsume = false; assert.equal((await redeem(code)).status, 201);
  const invalid = await redeem(randomBytes(32).toString("base64url")); assert.equal(invalid.json.error, "E_INVITE_INVALID");
  assert.equal((await redeem(code)).status, 409);
  const leak = JSON.stringify(h.audit.events) + h.logs.join("\n"); assert.equal(leak.includes(password), false); assert.equal(leak.includes(code), false);
});
test("bootstrap account requires one-time local proof and can be linked only once", async t => {
  const accounts = new AccountStore({ path: ":memory:", resolve: async userId => ({ userId, kind: "person", role: "owner", disabled: false, version: 1 }) }); const h = await start({ accounts }); t.after(async () => { await h.close(); accounts.close(); });
  const { cookie } = await login(h); const password = randomBytes(24).toString("base64url"); const proof = randomBytes(32).toString("base64url"); accounts.initializeBootstrap(bootstrapHash(proof)); const body = { username: "christian", password, proof };
  assert.equal((await raw(h, { method: "POST", path: "/api/v1/accounts/bootstrap", headers: { ...jsonHeaders(), cookie }, body: JSON.stringify({ ...body, proof: OWNER_TOKEN }) })).status, 403);
  assert.equal((await write(h, cookie, { path: "/api/v1/accounts/bootstrap", body: { ...body, proof: randomBytes(32).toString("hex") } })).status, 403);
  assert.equal((await write(h, cookie, { path: "/api/v1/accounts/bootstrap", body })).status, 201);
  assert.equal((await write(h, cookie, { path: "/api/v1/accounts/bootstrap", body })).status, 404);
  assert.equal((await accounts.findById("local-owner"))?.username, "christian");
});
test("registration uses Origin/Fetch-Site checks and both global and IP authentication limits", async t => {
  const h = await start(); t.after(() => h.close()); const code = randomBytes(32).toString("base64url"), password = randomBytes(24).toString("base64url");
  const send = (headers: Record<string, string> = {}) => raw(h, { method: "POST", path: "/api/v1/invitations/redeem", headers: { ...jsonHeaders(), ...headers }, body: JSON.stringify({ code, username: "alice", password }) });
  assert.equal((await send({ origin: "https://foreign.invalid" })).status, 403); assert.equal((await send({ "sec-fetch-site": "cross-site" })).status, 403);
  for (let i = 0; i < 5; i++) assert.equal((await send()).status, 503);
  const limited = await send(); assert.equal(limited.status, 429); assert.equal(limited.json.reason, "rate-limited");
});

test("activation failure after consumption is audited and leaves no active or pending credentials", async t => {
  const accounts = new AccountStore({ path: ":memory:", resolve: async userId => ({ userId, kind: "person", role: "member", disabled: false, version: 1 }) }); const core = fakeCore();
  Object.assign(core, { serviceCall: async () => ({ userId: "invited", role: "member" }) });
  const { ApiError } = await import("../src/errors.ts"); accounts.activate = async () => { throw new ApiError(503, "E_STORAGE", "account storage unavailable"); };
  const h = await start({ accounts, core }); t.after(async () => { await h.close(); accounts.close(); }); const password = randomBytes(24).toString("base64url"), code = randomBytes(32).toString("base64url");
  const r = await raw(h, { method: "POST", path: "/api/v1/invitations/redeem", headers: jsonHeaders(), body: JSON.stringify({ code, username: "alice", password }) }); assert.equal(r.status, 503);
  assert.equal(await accounts.findById("invited"), undefined); await accounts.createPending("invited", "alice", "not-a-credential");
  assert.ok(h.audit.events.some(e => e.action === "invitation.account.failed")); assert.equal(JSON.stringify(h.audit.events).includes(code), false);
});
