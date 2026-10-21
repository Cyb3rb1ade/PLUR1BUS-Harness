import { buildRemoteHandlers } from "../src/remote-config-routes.ts";
import { buildRemotePairingHandlers } from "../src/remote-pairing-routes.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "../src/clock.ts";
import { createAuditEmitter } from "../src/audit.ts";
import { ApiError } from "../src/errors.ts";
import { LoginChallenges } from "../src/challenge.ts";
import { RateLimiter } from "../src/rate-limit.ts";
import { memoryAuditSink } from "../src/rbac-bridge.ts";
import {
  API_PREFIX, API_VERSION, buildHandlers, COMPONENT_SCHEMAS, COOKIE_NAME, COOKIE_NAME_TLS, CSRF_HEADER, ROUTES, sessionCookie,
  type HandlerDeps, type HandlerInput, type HandlerOutput,
} from "../src/routes.ts";
import { OWNER, ownerTokenVerifier, SessionStore, type Principal } from "../src/session.ts";

const TOKEN = "0123456789abcdef".repeat(4);
const USER: Principal = { kind: "user", id: "u1", role: "member" };
const RBAC = { userId: "u1", role: "member", kind: "person" } as const;
const OWNER_RBAC = { userId: "owner", role: "owner", kind: "person" } as const;

type Any = any;
interface Rig { d: HandlerDeps; h: Record<string, (i: HandlerInput) => Promise<HandlerOutput> | HandlerOutput>; clock: FakeClock; sessions: SessionStore; events: Array<{ action: string; target: string; detail: Any }>; logs: string[] }

function rig(over: Partial<HandlerDeps> = {}): Rig {
  const clock = new FakeClock(); const sessions = new SessionStore(clock); const logs: string[] = []; const sink = memoryAuditSink();
  const audit = createAuditEmitter({ sink, clock, log: { error: (m) => logs.push(`error:${m}`) } });
  const d: HandlerDeps = {
    core: { call: (async () => ({})) as Any }, sessions, verifyOwner: ownerTokenVerifier(TOKEN), clock, tls: false, principal: OWNER, healthTimeoutMs: 50,
    log: { info: (m) => logs.push(`info:${m}`), warn: (m) => logs.push(`warn:${m}`) }, audit, ...over,
  };
  const events: Rig["events"] = [];
  const emit = audit.emit;
  d.audit = { emit: (a, actor, target, detail) => { events.push({ action: a, target, detail: { actor, ...detail } }); emit(a, actor, target, detail); } };
  return { d, h: { ...buildHandlers(d), ...buildRemoteHandlers({ core: d.core, now: () => clock.now() }), ...buildRemotePairingHandlers(undefined) } as Rig["h"], clock, sessions, events, logs };
}

function inp(over: Partial<HandlerInput> = {}): HandlerInput {
  return { principal: USER, session: undefined, sessionId: undefined, body: undefined, rbac: RBAC, presentedSessionId: undefined, ip: "127.0.0.1", via: undefined, token: undefined, ...over };
}

async function fails(p: Promise<unknown> | (() => unknown), status: number, reason?: string): Promise<ApiError> {
  let err: unknown;
  try { await (typeof p === "function" ? p() : p); } catch (e) { err = e; }
  assert.ok(err instanceof ApiError, `expected an ApiError, got ${String(err)}`);
  assert.equal(err.status, status);
  if (reason !== undefined) assert.equal(err.reason, reason);
  return err;
}

describe("routes: constants and table", () => {
  it("exports the documented constants", () => {
    assert.equal(API_VERSION, "1.0.0");
    assert.equal(API_PREFIX, "/api/v1");
    assert.equal(COOKIE_NAME, "plur1bus_session");
    assert.equal(COOKIE_NAME_TLS, "__Host-plur1bus_session");
    assert.equal(CSRF_HEADER, "x-csrf-token");
  });

  it("sessionCookie sets the flags, Secure and the __Host- prefix only over TLS", () => {
    assert.equal(sessionCookie(false, "abc", 60), "plur1bus_session=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=60");
    assert.equal(sessionCookie(true, "abc", 0), "__Host-plur1bus_session=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure");
    assert.equal(sessionCookie(false, "", 0), "plur1bus_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  });

  it("every route has a unique id and a unique method+path under the API prefix", () => {
    assert.equal(new Set(ROUTES.map((r) => r.id)).size, ROUTES.length);
    assert.equal(new Set(ROUTES.map((r) => `${r.method} ${r.path}`)).size, ROUTES.length);
    for (const r of ROUTES) assert.ok(r.path.startsWith(`${API_PREFIX}/`) || (r.id === "web.rpc" && r.path === "/rpc") || (r.id === "web.events" && r.path === "/events") || (r.id === "ws.reserved" && r.path === "/ws"), r.id);
  });

  it("every route has a handler and every handler a route", () => {
    const { h } = rig();
    assert.deepEqual(Object.keys(h).sort(), ROUTES.map((r) => r.id).sort());
  });

  for (const r of ROUTES) {
    it(`route ${r.id}: auth, authz, csrf and body declarations are coherent`, () => {
      assert.ok(["GET", "POST", "PATCH", "DELETE"].includes(r.method));
      if (r.auth === "none") { assert.equal(r.authz, "public"); assert.equal(r.csrf, false); } else assert.notEqual(r.authz, "public");
      if (r.method !== "GET" && r.auth !== "none") assert.equal(r.csrf, true);
      if (r.method === "GET") assert.equal(r.requestBody, undefined);
      if (r.requestBody) assert.ok(["POST", "PATCH", "DELETE"].includes(r.method), `${r.id} body belongs to a write method`);
      assert.ok(r.successStatus >= 200 && r.successStatus < 300 || r.id === "ws.reserved" && r.successStatus === 426);
      assert.ok(r.success.description.length > 0);
      if (typeof r.authz === "object") assert.ok(r.authz.action.includes(".") || ["chat:read", "chat:write", "chat:delete"].includes(r.authz.action));
      if (r.auth === "any" && !r.id.startsWith("chats.")) assert.equal(r.method, "GET");
      if (r.id.startsWith("chats.")) { assert.equal(r.auth, "any"); assert.equal(r.csrf, r.method !== "GET"); }
    });
  }

  it("the Health component schema is the 200 schema of the health route", () => {
    assert.equal(COMPONENT_SCHEMAS.Health, ROUTES.find((r) => r.id === "health")!.success.schema);
    for (const name of ["Error", "Principal", "SessionChallenge", "BreakGlassGrant", "Notice", "Token", "Activity"]) assert.ok(COMPONENT_SCHEMAS[name], name);
  });
});

describe("routes: session.create", () => {
  const bad: Array<[string, unknown]> = [
    ["undefined", undefined], ["null", null], ["array", []], ["string", "x"], ["empty object", {}], ["token not a string", { token: 1 }],
    ["username only", { username: "a" }], ["password not a string", { username: "a", password: 5 }], ["extra key with token", { token: TOKEN, x: 1 }],
    ["three keys", { username: "a", password: "b", token: "c" }],
  ];
  for (const [label, body] of bad) it(`rejects a malformed body (${label}) with 400 body`, async () => {
    await fails(rig().h["session.create"]!(inp({ body })) as Promise<unknown>, 400, "body");
  });

  it("logs the owner in with the owner token, sets the cookie and ends a presented cookie", async () => {
    const r = rig(); const old = r.sessions.create(OWNER);
    const out = await r.h["session.create"]!(inp({ body: { token: TOKEN }, presentedSessionId: old.id, principal: undefined }));
    assert.equal((out.body as Any).schema, "session.create/1");
    assert.deepEqual((out.body as Any).principal, OWNER);
    assert.match(out.headers!["Set-Cookie"]!, /^plur1bus_session=[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
    assert.equal(r.sessions.get(old.id), undefined, "the presented cookie is dead");
    assert.equal(r.events.at(-1)!.action, "auth.login.success");
    assert.equal(r.events.at(-1)!.detail.via, "owner-token");
  });

  it("uses the TLS cookie name and Secure flag when tls is on", async () => {
    const r = rig({ tls: true });
    const out = await r.h["session.create"]!(inp({ body: { token: TOKEN } }));
    assert.match(out.headers!["Set-Cookie"]!, /^__Host-plur1bus_session=.*; Secure$/);
  });

  it("refuses a wrong owner token with 401 invalid-token and audits it", async () => {
    const r = rig();
    await fails(r.h["session.create"]!(inp({ body: { token: "x".repeat(64) } })) as Promise<unknown>, 401, "invalid-token");
    assert.equal(r.events.at(-1)!.action, "auth.login.failure");
    assert.ok(r.logs.includes("warn:login refused"));
  });

  it("refuses a password login when no directory is configured", async () => {
    const r = rig();
    await fails(r.h["session.create"]!(inp({ body: { username: "a", password: "b" } })) as Promise<unknown>, 401, "invalid-credentials");
    assert.equal(r.events.at(-1)!.detail.reason, "invalid-credentials");
    assert.match(r.events.at(-1)!.target, /^name:[0-9a-f]{16}$/);
  });

  const lockCases: Array<[string, Any, number, string, string | undefined]> = [
    ["locked with retry", { ok: false, locked: true, retryAfterSec: 7 }, 429, "locked", "7"],
    ["locked without retry", { ok: false, locked: true }, 429, "locked", "1"],
    ["wrong password", { ok: false, locked: false }, 401, "invalid-credentials", undefined],
  ];
  for (const [label, result, status, reason, retry] of lockCases) it(`password failure: ${label}`, async () => {
    const r = rig({ login: { check: async () => result } as Any });
    const e = await fails(r.h["session.create"]!(inp({ body: { username: "a", password: "b" } })) as Promise<unknown>, status, reason);
    assert.equal(e.headers["Retry-After"], retry);
    assert.equal(r.events.at(-1)!.detail.reason, reason === "locked" ? "locked" : "invalid-credentials");
  });

  it("a right password without a second factor opens a session bound to the user version", async () => {
    const user = { id: "u1", role: "member", version: 4 };
    const r = rig({ login: { check: async () => ({ ok: true, user }) } as Any, totp: { isEnabled: async () => false } as Any, challenges: new LoginChallenges(new FakeClock()) });
    const out = await r.h["session.create"]!(inp({ body: { username: "a", password: "b" } }));
    assert.deepEqual((out.body as Any).principal, { kind: "user", id: "u1", role: "member" });
    assert.equal(r.events.at(-1)!.detail.via, "password");
  });

  it("a right password with a second factor answers with a challenge and no cookie", async () => {
    const user = { id: "u1", role: "member", version: 4 };
    const challenges = new LoginChallenges(new FakeClock());
    const r = rig({ login: { check: async () => ({ ok: true, user }) } as Any, totp: { isEnabled: async () => true } as Any, challenges });
    const out = await r.h["session.create"]!(inp({ body: { username: "a", password: "b" } }));
    assert.equal((out.body as Any).schema, "session.challenge/1");
    assert.equal((out.body as Any).mfa, "totp");
    assert.equal(out.headers, undefined);
    assert.deepEqual(challenges.get((out.body as Any).challenge), { userId: "u1", version: 4 });
    assert.equal(r.sessions.size, 0);
  });

  it("without totp or challenge services a right password simply logs in", async () => {
    const user = { id: "u1", role: "member", version: 1 };
    const noChallenges = rig({ login: { check: async () => ({ ok: true, user }) } as Any, totp: { isEnabled: async () => true } as Any });
    assert.equal(((await noChallenges.h["session.create"]!(inp({ body: { username: "a", password: "b" } }))).body as Any).schema, "session.create/1");
    const noTotp = rig({ login: { check: async () => ({ ok: true, user }) } as Any, challenges: new LoginChallenges(new FakeClock()) });
    assert.equal(((await noTotp.h["session.create"]!(inp({ body: { username: "a", password: "b" } }))).body as Any).schema, "session.create/1");
  });
});

describe("routes: session.totp", () => {
  function totpRig(over: Partial<HandlerDeps> = {}, verify: Any = { ok: true, method: "totp" }, user: Any = { id: "u1", role: "member", version: 2 }) {
    const clock = new FakeClock(); const challenges = new LoginChallenges(clock);
    const r = rig({
      clock, challenges, limiter: new RateLimiter(clock), users: { findById: async () => user } as Any,
      totp: { verify: async () => verify, status: async () => ({ enabled: true, backupCodesRemaining: 3 }) } as Any, ...over,
    });
    return { r, challenges: (over.challenges ?? challenges) as LoginChallenges };
  }
  const badBodies: Array<[string, unknown]> = [
    ["null", null], ["array", []], ["one key", { challenge: "c" }], ["code too long", { challenge: "c", code: "1".repeat(33) }],
    ["challenge not a string", { challenge: 1, code: "1" }], ["code not a string", { challenge: "c", code: 1 }], ["three keys", { challenge: "c", code: "1", x: 1 }],
  ];
  for (const [label, body] of badBodies) it(`rejects a malformed body (${label})`, async () => {
    await fails(totpRig().r.h["session.totp"]!(inp({ body })) as Promise<unknown>, 400, "body");
  });

  it("refuses an unknown challenge and a missing service alike with 401 invalid-code", async () => {
    const { r, challenges } = totpRig();
    await fails(r.h["session.totp"]!(inp({ body: { challenge: "nope", code: "123456" } })) as Promise<unknown>, 401, "invalid-code");
    const c = challenges.create("u1", 2);
    for (const missing of ["totp", "users", "limiter"] as const) {
      const bare = totpRig({ [missing]: undefined, challenges }).r;
      await fails(bare.h["session.totp"]!(inp({ body: { challenge: c.id, code: "123456" } })) as Promise<unknown>, 401, "invalid-code");
    }
    await fails(rig().h["session.totp"]!(inp({ body: { challenge: c.id, code: "1" } })) as Promise<unknown>, 401, "invalid-code");
  });

  it("is rate limited per user and audits it", async () => {
    const { r, challenges } = totpRig({}, { ok: false });
    const c = challenges.create("u1", 2);
    for (let n = 0; n < 5; n++) await fails(r.h["session.totp"]!(inp({ body: { challenge: c.id, code: "000000" } })) as Promise<unknown>, 401).catch(() => {});
    const c2 = challenges.create("u1", 2);
    const e = await fails(r.h["session.totp"]!(inp({ body: { challenge: c2.id, code: "000000" } })) as Promise<unknown>, 429, "rate-limited");
    assert.ok(Number(e.headers["Retry-After"]) >= 1);
    assert.equal(r.events.at(-1)!.action, "auth.rate-limited");
  });

  const stale: Array<[string, Any]> = [["unknown user", null], ["disabled user", { id: "u1", role: "member", version: 2, disabled: true }], ["changed version", { id: "u1", role: "member", version: 3 }]];
  for (const [label, user] of stale) it(`ends the challenge for a ${label}`, async () => {
    const { r, challenges } = totpRig({}, undefined, user);
    const c = challenges.create("u1", 2);
    await fails(r.h["session.totp"]!(inp({ body: { challenge: c.id, code: "123456" } })) as Promise<unknown>, 401, "invalid-code");
    assert.equal(challenges.get(c.id), undefined, "consumed");
  });

  it("a wrong code counts against the challenge and is audited", async () => {
    const { r, challenges } = totpRig({}, { ok: false });
    const c = challenges.create("u1", 2);
    await fails(r.h["session.totp"]!(inp({ body: { challenge: c.id, code: "000000" } })) as Promise<unknown>, 401, "invalid-code");
    assert.ok(challenges.get(c.id), "still alive after one failure");
    assert.equal(r.events.at(-1)!.action, "auth.totp.failure");
    assert.equal(r.events.at(-1)!.detail.stage, "login");
  });

  it("a right TOTP code opens a stepped-up session and spends the challenge", async () => {
    const { r, challenges } = totpRig();
    const c = challenges.create("u1", 2); const old = r.sessions.create(USER);
    const out = await r.h["session.totp"]!(inp({ body: { challenge: c.id, code: "123456" }, presentedSessionId: old.id }));
    assert.equal((out.body as Any).schema, "session.create/1");
    assert.equal(challenges.get(c.id), undefined);
    assert.equal(r.sessions.get(old.id), undefined);
    assert.match(out.headers!["Set-Cookie"]!, /Max-Age=43200$/);
    assert.equal(r.events.at(-1)!.detail.via, "password+totp");
  });

  it("a backup code is audited with the remaining count", async () => {
    const { r, challenges } = totpRig({}, { ok: true, method: "backup" });
    const c = challenges.create("u1", 2);
    await r.h["session.totp"]!(inp({ body: { challenge: c.id, code: "abcd-efgh" } }));
    const actions = r.events.map((e) => e.action);
    assert.deepEqual(actions.slice(-2), ["auth.login.success", "auth.totp.backup-used"]);
    assert.equal(r.events.at(-2)!.detail.via, "password+backup");
    assert.equal(r.events.at(-1)!.detail.remaining, 3);
  });
});

describe("routes: totp.status / setup / confirm / disable", () => {
  const totpStub = (o: Any = {}): Any => ({ status: async () => ({ enabled: true, backupCodesRemaining: 9 }), begin: async () => ({ secret: "S", otpauthUri: "otpauth://x" }), confirm: async () => ({ ok: true, backupCodes: ["a", "b"] }), disable: async () => true, ...o });

  it("status: 401 without principal or service, zeros for the owner, the real status for a user", async () => {
    await fails(rig({ totp: totpStub() }).h["totp.status"]!(inp({ principal: undefined })) as Promise<unknown>, 401);
    await fails(rig().h["totp.status"]!(inp()) as Promise<unknown>, 401);
    const r = rig({ totp: totpStub() });
    assert.deepEqual((await r.h["totp.status"]!(inp({ principal: OWNER }))).body, { schema: "totp.status/1", enabled: false, backupCodesRemaining: 0 });
    assert.deepEqual((await r.h["totp.status"]!(inp())).body, { schema: "totp.status/1", enabled: true, backupCodesRemaining: 9 });
  });

  it("setup: 401 without prerequisites, 409 no-account for the owner, session-expired for a gone user, else the secret", async () => {
    const users = { findById: async (id: string) => (id === "u1" ? { id: "u1", username: "alice" } : undefined) } as Any;
    await fails(rig({ totp: totpStub(), users }).h["totp.setup"]!(inp({ principal: undefined })) as Promise<unknown>, 401);
    await fails(rig({ users }).h["totp.setup"]!(inp()) as Promise<unknown>, 401);
    await fails(rig({ totp: totpStub() }).h["totp.setup"]!(inp()) as Promise<unknown>, 401);
    const r = rig({ totp: totpStub(), users });
    await fails(r.h["totp.setup"]!(inp({ principal: OWNER })) as Promise<unknown>, 409, "no-account");
    await fails(r.h["totp.setup"]!(inp({ principal: { ...USER, id: "ghost" } })) as Promise<unknown>, 401, "session-expired");
    assert.deepEqual((await r.h["totp.setup"]!(inp())).body, { schema: "totp.setup/1", secret: "S", otpauthUri: "otpauth://x" });
  });

  const badCodes: Array<[string, unknown]> = [["null", null], ["array", []], ["two keys", { code: "1", x: 1 }], ["no code", { x: "1" }], ["number", { code: 1 }], ["too long", { code: "1".repeat(33) }]];
  for (const name of ["totp.confirm", "totp.disable"]) {
    it(`${name}: 401 without principal or service`, async () => {
      await fails(rig({ totp: totpStub() }).h[name]!(inp({ principal: undefined, body: { code: "1" } })) as Promise<unknown>, 401);
      await fails(rig().h[name]!(inp({ body: { code: "1" } })) as Promise<unknown>, 401);
    });
    for (const [label, body] of badCodes) it(`${name}: rejects a malformed body (${label})`, async () => {
      await fails(rig({ totp: totpStub() }).h[name]!(inp({ body })) as Promise<unknown>, 400, "body");
    });
    it(`${name}: 409 no-account for the owner token login`, async () => {
      await fails(rig({ totp: totpStub() }).h[name]!(inp({ principal: OWNER, body: { code: "123456" } })) as Promise<unknown>, 409, "no-account");
    });
    it(`${name}: accepts a code of exactly 32 characters`, async () => {
      const out = await rig({ totp: totpStub() }).h[name]!(inp({ body: { code: "1".repeat(32) } }));
      assert.equal(out.status, undefined);
    });
  }

  it("confirm: a right code returns the backup codes and audits; a wrong one is 403 and audited", async () => {
    const r = rig({ totp: totpStub() });
    assert.deepEqual((await r.h["totp.confirm"]!(inp({ body: { code: "123456" } }))).body, { schema: "totp.confirm/1", enabled: true, backupCodes: ["a", "b"] });
    assert.equal(r.events.at(-1)!.action, "auth.totp.enabled");
    const w = rig({ totp: totpStub({ confirm: async () => ({ ok: false }) }) });
    await fails(w.h["totp.confirm"]!(inp({ body: { code: "000000" } })) as Promise<unknown>, 403, "invalid-code");
    assert.equal(w.events.at(-1)!.detail.stage, "confirm");
  });

  it("disable: a right code turns it off and audits; a wrong one is 403 and audited", async () => {
    const r = rig({ totp: totpStub() });
    assert.deepEqual((await r.h["totp.disable"]!(inp({ body: { code: "123456" } }))).body, { schema: "totp.disable/1", enabled: false });
    assert.equal(r.events.at(-1)!.action, "auth.totp.disabled");
    const w = rig({ totp: totpStub({ disable: async () => false }) });
    await fails(w.h["totp.disable"]!(inp({ body: { code: "000000" } })) as Promise<unknown>, 403, "invalid-code");
    assert.equal(w.events.at(-1)!.detail.stage, "disable");
  });
});

describe("routes: break-glass and notices", () => {
  // The routes hold no registry: they check the shape of a request and forward it to the core (`d.core.call`, as the caller).
  const grant = { id: "g1", holderUserId: "u1", targetUserId: "u2", reason: "needed for support", issuedAt: 1_700_000_000_000, expiresAt: 1_700_000_900_000 };
  type Call = { method: string; params: Any };
  const coreOf = (answer: (method: string, params: Any) => unknown = () => ({})) => { const calls: Call[] = []; return { calls, core: { call: (async (method: string, params: Any) => { calls.push({ method, params }); return answer(method, params); }) as Any } }; };
  const rpcError = (error: string, reason?: string) => Object.assign(new Error("core text with /secret/path"), { error, ...(reason ? { reason } : {}) });
  const req = (body: unknown) => inp({ body });

  it("request: 401 without rbac, and nothing is forwarded", async () => {
    const c = coreOf();
    await fails(rig({ core: c.core }).h["breakglass.request"]!(inp({ rbac: undefined })) as Promise<unknown>, 401);
    assert.equal(c.calls.length, 0);
  });

  const badRequests: Array<[string, unknown, string]> = [
    ["null body", null, "body"], ["array body", [], "body"], ["unknown key", { targetUserId: "u2", reason: "x", extra: 1 }, "body"],
    ["no target", { reason: "long enough reason" }, "target"], ["empty target", { targetUserId: "", reason: "long enough reason" }, "target"],
    ["target not a string", { targetUserId: 4, reason: "long enough reason" }, "target"], ["target with a control character", { targetUserId: "u\n2", reason: "long enough reason" }, "target"],
    ["target too long", { targetUserId: "u".repeat(129), reason: "long enough reason" }, "target"],
    ["no reason", { targetUserId: "u2" }, "reason"], ["reason not a string", { targetUserId: "u2", reason: 4 }, "reason"], ["blank reason", { targetUserId: "u2", reason: "   " }, "reason"],
    ["reason far too long", { targetUserId: "u2", reason: "x".repeat(10_001) }, "reason"],
    ["ttl not a number", { targetUserId: "u2", reason: "long enough reason", ttlMinutes: "5" }, "ttl"],
    ["ttl fractional", { targetUserId: "u2", reason: "long enough reason", ttlMinutes: 1.5 }, "ttl"],
    ["ttl zero", { targetUserId: "u2", reason: "long enough reason", ttlMinutes: 0 }, "ttl"],
    ["ttl 61", { targetUserId: "u2", reason: "long enough reason", ttlMinutes: 61 }, "ttl"],
  ];
  for (const [label, body, reason] of badRequests) it(`request: rejects ${label} before the core is asked`, async () => {
    const c = coreOf();
    await fails(rig({ core: c.core }).h["breakglass.request"]!(req(body)) as Promise<unknown>, 400, reason);
    assert.equal(c.calls.length, 0);
  });

  it("request: forwards the window as windowMinutes when given and omits it otherwise; the installation owner is local-owner in the core", async () => {
    const c = coreOf(() => grant); const r = rig({ core: c.core });
    const out = await r.h["breakglass.request"]!(req({ targetUserId: "u2", reason: "long enough reason", ttlMinutes: 60 }));
    await r.h["breakglass.request"]!(req({ targetUserId: "u2", reason: "long enough reason" }));
    await r.h["breakglass.request"]!(req({ targetUserId: "owner", reason: "long enough reason" }));
    assert.deepEqual(c.calls.map((x) => x.method), ["breakglass.request", "breakglass.request", "breakglass.request"]);
    assert.deepEqual(c.calls[0]!.params, { targetUserId: "u2", reason: "long enough reason", windowMinutes: 60 });
    assert.deepEqual(c.calls[1]!.params, { targetUserId: "u2", reason: "long enough reason" });
    assert.equal(c.calls[2]!.params.targetUserId, "local-owner");
    assert.equal(out.status, 201);
    assert.deepEqual((out.body as Any).grant, { id: "g1", targetUserId: "u2", reason: "needed for support", issuedAt: "2023-11-14T22:13:20.000Z", expiresAt: "2023-11-14T22:28:20.000Z" });
  });

  it("the reason goes to the core as written: its length rules are the core's configuration", async () => {
    const c = coreOf(() => grant);
    await rig({ core: c.core }).h["breakglass.request"]!(req({ targetUserId: "u2", reason: "short" }));
    assert.equal(c.calls[0]!.params.reason, "short");
  });

  const refusals: Array<[string, string, string | undefined, number, string, string]> = [
    ["E_DENIED not-permitted", "E_DENIED", "not-permitted", 403, "E_DENIED", "role-denied"], ["E_DENIED without a reason", "E_DENIED", undefined, 403, "E_DENIED", "role-denied"],
    ["E_INVALID_PARAMS invalid-target", "E_INVALID_PARAMS", "invalid-target", 400, "E_INVALID_PARAMS", "target"], ["E_INVALID_PARAMS self-target", "E_INVALID_PARAMS", "self-target", 400, "E_INVALID_PARAMS", "self-target"],
    ["E_INVALID_PARAMS reason-required", "E_INVALID_PARAMS", "reason-required", 400, "E_INVALID_PARAMS", "reason"], ["E_INVALID_PARAMS ttl-invalid", "E_INVALID_PARAMS", "ttl-invalid", 400, "E_INVALID_PARAMS", "ttl"],
    ["E_INVALID_PARAMS anything else", "E_INVALID_PARAMS", undefined, 400, "E_INVALID_PARAMS", "request"],
    ["E_STORAGE audit-failed", "E_STORAGE", "audit-failed", 503, "E_NOT_AVAILABLE", "audit-unavailable"],
    ["E_NOT_AVAILABLE notification-failed", "E_NOT_AVAILABLE", "notification-failed", 503, "E_NOT_AVAILABLE", "notice-unavailable"],
  ];
  for (const [label, code, coreReason, status, error, reason] of refusals) it(`maps the core's ${label} to ${status}/${reason} for request and revoke, without its text`, async () => {
    const boom = () => { throw rpcError(code, coreReason); };
    const r = rig({ core: coreOf(boom).core });
    const e1 = await fails(r.h["breakglass.request"]!(req({ targetUserId: "u2", reason: "long enough reason" })) as Promise<unknown>, status, reason);
    assert.equal(e1.error, error);
    assert.ok(!e1.message.includes("/secret"));
    const e2 = await fails(r.h["breakglass.revoke"]!(req({ grantId: "g1" })) as Promise<unknown>, status, reason);
    assert.ok(!e2.message.includes("/secret"));
  });

  it("maps the core's E_NOT_FOUND by route: an unknown user on request, an unknown grant on revoke", async () => {
    const r = rig({ core: coreOf(() => { throw rpcError("E_NOT_FOUND"); }).core });
    await fails(r.h["breakglass.request"]!(req({ targetUserId: "ghost", reason: "long enough reason" })) as Promise<unknown>, 404, "target");
    await fails(r.h["breakglass.revoke"]!(req({ grantId: "g1" })) as Promise<unknown>, 404, "grant");
  });

  it("any other core failure is the API's usual core error, never a grant", async () => {
    const down = rig({ core: coreOf(() => { throw new Error("socket closed"); }).core });
    await fails(down.h["breakglass.request"]!(req({ targetUserId: "u2", reason: "long enough reason" })) as Promise<unknown>, 503, "core-unreachable");
    const hurt = rig({ core: coreOf(() => { throw rpcError("E_STORAGE"); }).core });
    await fails(hurt.h["breakglass.request"]!(req({ targetUserId: "u2", reason: "long enough reason" })) as Promise<unknown>, 502, "core-error");
  });

  it("a grant the core describes malformed is not shown", async () => {
    for (const bad of [null, {}, { ...grant, id: 5 }, { ...grant, issuedAt: "yesterday" }, { ...grant, expiresAt: 1.5 }]) {
      await fails(rig({ core: coreOf(() => bad).core }).h["breakglass.request"]!(req({ targetUserId: "u2", reason: "long enough reason" })) as Promise<unknown>, 502, "core-error");
    }
  });

  it("list: 401 without rbac, else the core's grants of the caller with ISO times (the owner shown as `owner`)", async () => {
    await fails(rig({ core: coreOf().core }).h["breakglass.list"]!(inp({ rbac: undefined })) as Promise<unknown>, 401);
    const c = coreOf(() => ({ grants: [grant, { ...grant, id: "g2", targetUserId: "local-owner" }] })); const r = rig({ core: c.core });
    const out = await r.h["breakglass.list"]!(inp()) as HandlerOutput;
    assert.deepEqual(c.calls, [{ method: "breakglass.list", params: {} }]);
    assert.equal((out.body as Any).schema, "breakglass.list/1");
    assert.deepEqual((out.body as Any).grants.map((g: Any) => [g.id, g.targetUserId, g.issuedAt]), [["g1", "u2", "2023-11-14T22:13:20.000Z"], ["g2", "owner", "2023-11-14T22:13:20.000Z"]]);
    assert.ok(!("holderUserId" in (out.body as Any).grants[0]));
    await fails(rig({ core: coreOf(() => ({ grants: "none" })).core }).h["breakglass.list"]!(inp()) as Promise<unknown>, 502, "core-error");
    await fails(rig({ core: coreOf(() => { throw rpcError("E_DENIED"); }).core }).h["breakglass.list"]!(inp()) as Promise<unknown>, 403, "role-denied");
  });

  const badRevoke: Array<[string, unknown]> = [["null", null], ["array", []], ["no id", {}], ["empty id", { grantId: "" }], ["number id", { grantId: 3 }], ["extra key", { grantId: "g", x: 1 }], ["id too long", { grantId: "g".repeat(129) }], ["id with a control character", { grantId: "g\n1" }]];
  for (const [label, body] of badRevoke) it(`revoke: rejects ${label} before the core is asked`, async () => {
    const c = coreOf();
    await fails(rig({ core: c.core }).h["breakglass.revoke"]!(inp({ body })) as Promise<unknown>, 400, "body");
    assert.equal(c.calls.length, 0);
  });

  it("revoke: 401 without rbac, else forwards the grant id and answers revoked", async () => {
    await fails(rig({ core: coreOf().core }).h["breakglass.revoke"]!(inp({ rbac: undefined, body: { grantId: "g" } })) as Promise<unknown>, 401);
    const c = coreOf(() => ({ id: "g1", revoked: true })); const r = rig({ core: c.core });
    assert.deepEqual((await r.h["breakglass.revoke"]!(inp({ body: { grantId: "g1" } }))).body, { schema: "breakglass.revoke/1", revoked: true });
    assert.deepEqual(c.calls, [{ method: "breakglass.revoke", params: { grantId: "g1" } }]);
  });

  it("notices.list: 401 without rbac, else the core's notices as they came (newest first), with ISO expiry and no invented issue time", async () => {
    await fails(rig({ core: coreOf().core }).h["notices.list"]!(inp({ rbac: undefined })) as Promise<unknown>, 401);
    const notice = (grantId: string, holderUserId = "h") => ({ kind: "granted", userId: "u1", grantId, holderUserId, reason: "r", expiresAt: 1_700_000_900_000 });
    const c = coreOf(() => ({ notices: [notice("g2"), notice("g1", "local-owner")] })); const r = rig({ core: c.core });
    const out = await r.h["notices.list"]!(inp()) as HandlerOutput;
    assert.deepEqual(c.calls, [{ method: "breakglass.notices", params: {} }]);
    const list = (out.body as Any).notices;
    assert.deepEqual(list.map((n: Any) => n.grantId), ["g2", "g1"]);
    assert.deepEqual(list[0], { kind: "break-glass.granted", grantId: "g2", holderUserId: "h", reason: "r", expiresAt: "2023-11-14T22:28:20.000Z" });
    assert.equal(list[1].holderUserId, "owner");
    assert.deepEqual((await rig({ core: coreOf(() => ({ notices: [] })).core }).h["notices.list"]!(inp())).body, { schema: "notices.list/1", notices: [] });
    await fails(rig({ core: coreOf(() => ({ notices: [{ grantId: 1 }] })).core }).h["notices.list"]!(inp()) as Promise<unknown>, 502, "core-error");
  });
});

describe("routes: session and csrf handlers", () => {
  it("session.delete ends the session, clears the cookie, audits; works without a principal", () => {
    const r = rig(); const s = r.sessions.create(USER);
    const out = r.h["session.delete"]!(inp({ sessionId: s.id })) as HandlerOutput;
    assert.equal(r.sessions.get(s.id), undefined);
    assert.equal(out.headers!["Set-Cookie"], "plur1bus_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    assert.deepEqual(out.body, { schema: "session.delete/1", ok: true });
    assert.equal(r.events.at(-1)!.action, "auth.logout");
    assert.equal(r.events.at(-1)!.target, "user:u1");
    const anon = rig(); anon.h["session.delete"]!(inp({ principal: undefined }));
    assert.equal(anon.events.at(-1)!.target, "user:-");
    assert.equal(anon.events.at(-1)!.detail.actor, "anonymous");
  });

  it("clears the TLS cookie name over TLS", () => {
    const out = rig({ tls: true }).h["session.delete"]!(inp()) as HandlerOutput;
    assert.match(out.headers!["Set-Cookie"]!, /^__Host-plur1bus_session=; .*Max-Age=0; Secure$/);
  });

  it("sessions.revoke-all counts the sessions it ended and needs a principal", () => {
    const r = rig(); r.sessions.create(USER); r.sessions.create(USER); r.sessions.create(OWNER);
    const out = r.h["sessions.revoke-all"]!(inp()) as HandlerOutput;
    assert.deepEqual(out.body, { schema: "sessions.revoke-all/1", revoked: 2 });
    assert.equal(r.sessions.size, 1);
    assert.equal(r.events.at(-1)!.action, "auth.logout-all");
    assert.throws(() => r.h["sessions.revoke-all"]!(inp({ principal: undefined })), (e: Any) => e.status === 401);
  });

  it("csrf.issue returns a token for a live session and 401 session-expired otherwise", () => {
    const r = rig(); const s = r.sessions.create(USER);
    const out = r.h["csrf.issue"]!(inp({ sessionId: s.id })) as HandlerOutput;
    assert.equal((out.body as Any).schema, "csrf/1");
    assert.equal(r.sessions.consumeCsrf(s.id, (out.body as Any).token), true);
    assert.throws(() => r.h["csrf.issue"]!(inp()), (e: Any) => e.status === 401 && e.reason === "session-expired");
    assert.throws(() => r.h["csrf.issue"]!(inp({ sessionId: "unknown" })), (e: Any) => e.status === 401 && e.reason === "session-expired");
  });
});

describe("routes: health", () => {
  const status = (o: Any = {}) => ({ rpc: "1.5.0", contract: "7.18.4", uptimeMs: 10, engine: { ready: true, degraded: null }, ...o });
  const health = (core: Any, ms = 50) => rig({ core, healthTimeoutMs: ms }).h.health!(inp());

  it("ok when the engine is ready and not degraded", async () => {
    const out = await health({ call: async () => status() });
    assert.equal(out.status, undefined);
    assert.deepEqual(out.body, { schema: "health/1", status: "ok", api: { version: "1.0.0" }, core: { reachable: true, rpc: "1.5.0", contract: "7.18.4", uptimeMs: 10, engineReady: true, degraded: false } });
  });

  const degradedCases: Array<[string, Any]> = [
    ["engine not ready", status({ engine: { ready: false, degraded: null } })],
    ["degradation reported", status({ engine: { ready: true, degraded: { reason: "x" } } })],
  ];
  for (const [label, s] of degradedCases) it(`degraded: ${label}`, async () => {
    assert.equal(((await health({ call: async () => s })).body as Any).status, "degraded");
  });

  it("an undefined degraded field counts as not degraded", async () => {
    const out = await health({ call: async () => status({ engine: { ready: true } }) });
    assert.equal((out.body as Any).status, "ok");
    assert.equal((out.body as Any).core.degraded, false);
  });

  it("503 down when the core throws or answers without an engine", async () => {
    for (const core of [{ call: async () => { throw new Error("gone"); } }, { call: async () => ({}) }]) {
      const out = await health(core);
      assert.equal(out.status, 503);
      assert.deepEqual(out.body, { schema: "health/1", status: "down", api: { version: "1.0.0" }, core: { reachable: false } });
    }
  });

  it("503 down when the core does not answer within the deadline (fake timers)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const p = Promise.resolve(health({ call: () => new Promise(() => {}) }, 2000));
    t.mock.timers.tick(2000);
    assert.equal((await p).status, 503);
  });
});

describe("routes: whoami", () => {
  const session = { createdAt: 1_700_000_000_000, absoluteExpiresAt: 1_700_000_100_000, idleExpiresAt: 1_700_000_050_000 } as Any;

  it("401 without a principal", () => {
    assert.throws(() => rig().h.whoami!(inp({ principal: undefined })), (e: Any) => e.status === 401);
  });

  it("a token caller sees the token, never a session", () => {
    const out = rig().h.whoami!(inp({ via: "token", token: { id: "abc", prefix: "plb_abc", scopes: ["agent.*"], expiresAt: 1_700_000_000_000 } })) as HandlerOutput;
    assert.deepEqual(out.body, { schema: "whoami/1", principal: USER, via: "token", token: { id: "abc", prefix: "plb_abc", scopes: ["agent.*"], expiresAt: "2023-11-14T22:13:20.000Z" } });
  });

  it("a session caller sees ISO session times", () => {
    const out = rig().h.whoami!(inp({ via: "session", session })) as HandlerOutput;
    assert.deepEqual((out.body as Any).session, { createdAt: "2023-11-14T22:13:20.000Z", expiresAt: "2023-11-14T22:15:00.000Z", idleExpiresAt: "2023-11-14T22:14:10.000Z" });
    assert.equal((out.body as Any).via, "session");
  });

  it("401 when neither a session nor token info is present (token via without token details falls through)", () => {
    assert.throws(() => rig().h.whoami!(inp({ via: "token" })), (e: Any) => e.status === 401);
    assert.throws(() => rig().h.whoami!(inp({ via: "session" })), (e: Any) => e.status === 401);
  });
});

describe("routes: tokens", () => {
  const pub = { id: "a1b2c3d4e5f6", prefix: "plb_a1b2c3d4e5f6", name: "ci", scopes: ["agent.*"], createdAt: 1_700_000_000_000, expiresAt: 1_700_086_400_000 };
  const svc = (o: Any = {}): Any => ({ list: async () => [pub, { ...pub, id: "b", lastUsedAt: 1_700_000_001_000, revokedAt: 1_700_000_002_000 }], create: async () => ({ token: "plb_x_y", record: pub }), revoke: async () => true, ...o });

  it("list: 401 without principal or service; ISO times, optional fields only when set", async () => {
    await fails(rig({ tokens: svc() }).h["tokens.list"]!(inp({ principal: undefined })) as Promise<unknown>, 401);
    await fails(rig().h["tokens.list"]!(inp()) as Promise<unknown>, 401);
    const list = ((await rig({ tokens: svc() }).h["tokens.list"]!(inp())).body as Any).tokens;
    assert.equal(list[0].createdAt, "2023-11-14T22:13:20.000Z");
    assert.ok(!("lastUsedAt" in list[0]) && !("revokedAt" in list[0]));
    assert.equal(list[1].lastUsedAt, "2023-11-14T22:13:21.000Z");
    assert.equal(list[1].revokedAt, "2023-11-14T22:13:22.000Z");
  });

  const badCreate: Array<[string, unknown, string]> = [
    ["null", null, "body"], ["array", [], "body"], ["no scopes", { name: "x" }, "body"], ["no name", { scopes: ["a.b"] }, "body"],
    ["unknown key", { name: "x", scopes: ["a.b"], extra: 1 }, "body"],
    ["ttl string", { name: "x", scopes: ["a.b"], ttlDays: "3" }, "ttl"], ["ttl fractional", { name: "x", scopes: ["a.b"], ttlDays: 1.5 }, "ttl"],
    ["ttl 0", { name: "x", scopes: ["a.b"], ttlDays: 0 }, "ttl"], ["ttl 366", { name: "x", scopes: ["a.b"], ttlDays: 366 }, "ttl"],
  ];
  for (const [label, body, reason] of badCreate) it(`create: rejects ${label}`, async () => {
    await fails(rig({ tokens: svc() }).h["tokens.create"]!(inp({ body })) as Promise<unknown>, 400, reason);
  });

  it("create: 401 without principal or service", async () => {
    await fails(rig({ tokens: svc() }).h["tokens.create"]!(inp({ principal: undefined, body: {} })) as Promise<unknown>, 401);
    await fails(rig().h["tokens.create"]!(inp({ body: {} })) as Promise<unknown>, 401);
  });

  it("create: forwards ttl in ms (1 and 365 days) or none, answers 201 and audits without the secret", async () => {
    const seen: Any[] = [];
    const r = rig({ tokens: svc({ create: async (_u: string, o: Any) => { seen.push(o); return { token: "plb_x_y", record: pub }; } }) });
    const out = await r.h["tokens.create"]!(inp({ body: { name: "ci", scopes: ["agent.*"], ttlDays: 1 } }));
    await r.h["tokens.create"]!(inp({ body: { name: "ci", scopes: ["agent.*"], ttlDays: 365 } }));
    await r.h["tokens.create"]!(inp({ body: { name: "ci", scopes: ["agent.*"] } }));
    assert.equal(seen[0].ttlMs, 86_400_000);
    assert.equal(seen[1].ttlMs, 365 * 86_400_000);
    assert.ok(!("ttlMs" in seen[2]));
    assert.equal(out.status, 201);
    assert.equal((out.body as Any).token, "plb_x_y");
    assert.equal(r.events[0]!.action, "auth.token.created");
    assert.ok(!JSON.stringify(r.events).includes("plb_x_y"));
  });

  it("create: a service error (e.g. invalid scopes) is passed on", async () => {
    const r = rig({ tokens: svc({ create: async () => { throw new ApiError(400, "E_INVALID_PARAMS", "bad scopes", { reason: "scopes" }); } }) });
    await fails(r.h["tokens.create"]!(inp({ body: { name: "x", scopes: [] } })) as Promise<unknown>, 400, "scopes");
  });

  const badRevoke: Array<[string, unknown]> = [
    ["null", null], ["array", []], ["number id", { id: 5 }], ["extra key", { id: "a1b2c3d4e5f6", x: 1 }], ["too short", { id: "a1b2c3" }],
    ["uppercase", { id: "A1B2C3D4E5F6" }], ["too long", { id: "a1b2c3d4e5f6a" }], ["non-hex", { id: "g1b2c3d4e5f6" }],
  ];
  for (const [label, body] of badRevoke) it(`revoke: rejects ${label}`, async () => {
    await fails(rig({ tokens: svc() }).h["tokens.revoke"]!(inp({ body })) as Promise<unknown>, 400, "body");
  });

  it("revoke: 401 without prerequisites, 404 for an unknown token, else revoked and audited", async () => {
    await fails(rig({ tokens: svc() }).h["tokens.revoke"]!(inp({ principal: undefined })) as Promise<unknown>, 401);
    await fails(rig().h["tokens.revoke"]!(inp()) as Promise<unknown>, 401);
    await fails(rig({ tokens: svc({ revoke: async () => false }) }).h["tokens.revoke"]!(inp({ body: { id: "a1b2c3d4e5f6" } })) as Promise<unknown>, 404, "token");
    const r = rig({ tokens: svc() });
    assert.deepEqual((await r.h["tokens.revoke"]!(inp({ body: { id: "a1b2c3d4e5f6" } }))).body, { schema: "tokens.revoke/1", revoked: true });
    assert.equal(r.events.at(-1)!.action, "auth.token.revoked");
    assert.equal(r.events.at(-1)!.target, "token:a1b2c3d4e5f6");
  });
});

describe("routes: agents.list", () => {
  const owner = (agents: unknown, extra: Any = {}) => rig({ core: { call: async () => ({ agents, ...extra }) } as Any }).h["agents.list"]!(inp({ rbac: OWNER_RBAC as Any }));

  it("passes the core result through with a schema id, keeping extra fields", async () => {
    const list = [{ agentId: "main", open: true }];
    const out = await owner(list, { cursor: "c1" });
    assert.deepEqual(out.body, { schema: "agents.list/1", cursor: "c1", agents: list });
  });

  it("a result that is not a list is shown to nobody", async () => {
    assert.deepEqual(((await owner("nope")).body as Any).agents, []);
    assert.deepEqual(((await owner(undefined)).body as Any).agents, []);
  });

  it("filters by agent.read: a viewer without rights sees none, an agent right shows exactly that agent", async () => {
    const core = { call: async () => ({ agents: [{ agentId: "a" }, { agentId: "b" }] }) } as Any;
    const none = await rig({ core }).h["agents.list"]!(inp({ rbac: { userId: "v", role: "viewer", kind: "person" } as Any }));
    assert.deepEqual((none.body as Any).agents, []);
    const some = await rig({ core }).h["agents.list"]!(inp({ rbac: { userId: "m", role: "member", kind: "person", agentRights: { a: "use" } } as Any }));
    assert.deepEqual((some.body as Any).agents, [{ agentId: "a" }]);
  });

  it("elements without a string agentId are decided on an empty id (never crash)", async () => {
    const out = await owner([null, 5, "x", {}, { agentId: 7 }, { agentId: "ok" }]);
    assert.ok(Array.isArray((out.body as Any).agents));
    assert.ok(((out.body as Any).agents as unknown[]).some((a) => (a as Any)?.agentId === "ok"));
  });

  it("maps core errors to API errors: coded errors by code, others to 503", async () => {
    const run = (e: unknown) => rig({ core: { call: async () => { throw e; } } as Any }).h["agents.list"]!(inp({ rbac: OWNER_RBAC as Any })) as Promise<unknown>;
    await fails(run({ error: "E_AGENT_UNKNOWN" }), 404);
    await fails(run({ error: "E_INTERNAL" }), 502, "core-error");
    await fails(run(new Error("socket hang up")), 503, "core-unreachable");
    const same = new ApiError(418 as Any, "E_DENIED", "teapot");
    assert.equal(await run(same).catch((e) => e), same);
  });
});
