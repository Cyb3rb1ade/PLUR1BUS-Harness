// identity authorization (authorization.ts), the owner-only RPC wrapper and error mapping (rpc.ts), and the audit
// writer (audit.ts). Expectations come from the RBAC policy table (users.manage: owner and admin; my.write: everyone
// but viewer), docs/identity.md ("agents denied", "Self/Admin authorization") and the RPC schema descriptions.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { RpcError } from "../../src/rpc/errors.ts";
import { buildIdentityMethods, IDENTITY_METHODS, mapIdentityError } from "../../src/identity/rpc.ts";
import { rbacAuthorizePort, requireAuthorization, type AuthorizePort, type IdentityAction } from "../../src/identity/authorization.ts";
import { createAuditWriter } from "../../src/identity/audit.ts";
import { IdentityError, type Actor, type AuditEvent, type ChannelIdentity, type IdentityErrorCode } from "../../src/identity/service.ts";
import { ROLES, type Role } from "../../src/rbac/types.ts";
import { MIN, OWNER, gap, refuses, useIdentity } from "./helpers.ts";
import { createHash } from "node:crypto";

const fixture = useIdentity();
const ACTIONS: IdentityAction[] = ["create", "link", "unlink", "pair", "confirm", "backfill"];
const TG: ChannelIdentity = { channel: "telegram", accountId: "bot-a", userId: "1001" };
const person = (user: string, role?: Role, extra: Partial<Actor> = {}): Actor => ({ user, host: "h", kind: "person", ...(role ? { role } : {}), ...extra });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("identity authorization: the default RBAC port", () => {
  it("owner and admin may do every action on anybody", () => {
    for (const role of ["owner", "admin"] as const) for (const a of ACTIONS) assert.equal(rbacAuthorizePort.authorize(person("someone", role), a, "target-human"), true, `${role} ${a}`);
  });

  it("operator and member may act on themselves only, and never create people or backfill", () => {
    for (const role of ["operator", "member"] as const) {
      for (const a of ["link", "unlink", "pair", "confirm"] as const) {
        assert.equal(rbacAuthorizePort.authorize(person("me", role), a, "me"), true, `${role} ${a} self`);
        assert.equal(rbacAuthorizePort.authorize(person("me", role), a, "you"), false, `${role} ${a} other`);
      }
      for (const a of ["create", "backfill"] as const) { assert.equal(rbacAuthorizePort.authorize(person("me", role), a, "me"), false, `${role} ${a}`); assert.equal(rbacAuthorizePort.authorize(person("me", role), a, ""), false); }
    }
  });

  it("a viewer may do nothing, not even to themselves", () => {
    for (const a of ACTIONS) assert.equal(rbacAuthorizePort.authorize(person("me", "viewer"), a, "me"), false, a);
  });

  it("an agent may do nothing whatever its role says; neither may a principal without a kind or without a role", () => {
    for (const role of ROLES) for (const a of ACTIONS) {
      assert.equal(rbacAuthorizePort.authorize({ user: "me", host: "h", kind: "agent", role }, a, "me"), false, `agent ${role} ${a}`);
      assert.equal(rbacAuthorizePort.authorize({ user: "me", host: "h", role }, a, "me"), false, `kindless ${role} ${a}`);
    }
    for (const a of ACTIONS) assert.equal(rbacAuthorizePort.authorize(person("me"), a, "me"), false, `roleless ${a}`);
  });

  it("an unknown role string is a denial for everything", () => {
    for (const a of ACTIONS) assert.equal(rbacAuthorizePort.authorize(person("me", "root" as never), a, "me"), false, a);
  });

  it("an empty user id is never 'own': a member with user '' gets nothing for human ''", () => {
    for (const a of ["link", "unlink", "pair", "confirm"] as const) assert.equal(rbacAuthorizePort.authorize(person("", "member"), a, ""), false, a);
  });

  it("own means an exact match of ids: case and padding differences are somebody else", () => {
    assert.equal(rbacAuthorizePort.authorize(person("Me", "member"), "link", "me"), false);
    assert.equal(rbacAuthorizePort.authorize(person("me ", "member"), "link", "me"), false);
    assert.equal(rbacAuthorizePort.authorize(person("me", "member"), "link", "me\u0000"), false);
  });

  it("API token scopes only narrow: users.manage needs the scope, a member's own writes need my.write", () => {
    assert.equal(rbacAuthorizePort.authorize(person("o", "owner", { tokenScopes: ["my.read"] }), "link", "x"), false);
    assert.equal(rbacAuthorizePort.authorize(person("o", "owner", { tokenScopes: ["users.manage"] }), "link", "x"), true);
    assert.equal(rbacAuthorizePort.authorize(person("o", "owner", { tokenScopes: ["users.*"] }), "create", "x"), true);
    assert.equal(rbacAuthorizePort.authorize(person("o", "owner", { tokenScopes: [] }), "link", "x"), false, "an empty scope list grants nothing");
    assert.equal(rbacAuthorizePort.authorize(person("m", "member", { tokenScopes: ["my.write"] }), "pair", "m"), true);
    assert.equal(rbacAuthorizePort.authorize(person("m", "member", { tokenScopes: ["my.read"] }), "pair", "m"), false);
    assert.equal(rbacAuthorizePort.authorize(person("m", "member", { tokenScopes: ["users.manage"] }), "pair", "x"), false, "a scope never adds a right the role lacks");
  });
});

describe("identity authorization: requireAuthorization and an injected policy", () => {
  const yes: AuthorizePort = { authorize: () => true };
  const no: AuthorizePort = { authorize: () => false };

  it("denied is an IdentityError 'denied' with a fixed message", () => {
    assert.throws(() => requireAuthorization(no, OWNER, "link", "x"), (e: unknown) => e instanceof IdentityError && e.code === "denied" && e.message === "identity action denied");
    requireAuthorization(yes, OWNER, "link", "x");
  });

  it("the port is asked with the actor, the action and the target person", () => {
    const seen: unknown[][] = [];
    requireAuthorization({ authorize: (...a) => { seen.push(a); return true; } }, OWNER, "unlink", "human-9");
    assert.deepEqual(seen, [[OWNER, "unlink", "human-9"]]);
  });

  it("even a port that says yes to everything never authorizes an agent or a kindless caller", () => {
    for (const a of [{ user: "a", host: "h", kind: "agent", role: "owner" }, { user: "a", host: "h", role: "owner" }] as Actor[]) {
      assert.throws(() => requireAuthorization(yes, a, "link", "x"), (e: unknown) => e instanceof IdentityError && e.code === "denied");
    }
  });

  it("a port that narrows beats the role: with a deny-all port even the owner is refused and nothing changes", () => {
    const f = fixture({ authorize: no });
    refuses(() => f.svc.createHuman({ displayName: "x" }, OWNER), "denied");
    assert.deepEqual(f.svc.list({}).humans, []);
  });

  it("a port that extends reaches only people: a permissive port lets a viewer link, but an agent still cannot", () => {
    const f = fixture({ authorize: yes });
    const h = f.svc.createHuman({ displayName: "x" }, person("viewer-1", "viewer"));
    assert.ok(f.svc.link({ humanId: h.id, identity: TG }, person("viewer-1", "viewer")));
    refuses(() => f.svc.createHuman({ displayName: "y" }, { user: "bot", host: "h", kind: "agent", role: "owner" }), "denied");
  });

  it("the check runs before any work: a denied actor learns nothing about whether the person exists", () => {
    const f = fixture();
    const stranger = person("m", "member");
    refuses(() => f.svc.startPairing({ humanId: "00000000-0000-7000-8000-000000000000", channel: "telegram" }, stranger), "denied");
    refuses(() => f.svc.link({ humanId: "00000000-0000-7000-8000-000000000000", identity: TG }, stranger), "denied");
  });

  it("through the service with the default port: members manage only themselves, the owner everybody, agents nobody", () => {
    const f = fixture(); const a = f.human("A"); const b = f.human("B");
    refuses(() => f.svc.link({ humanId: b.id, identity: TG }, a.self), "denied");
    refuses(() => f.svc.startPairing({ humanId: b.id, channel: "telegram" }, a.self), "denied");
    refuses(() => f.svc.createHuman({ displayName: "C" }, a.self), "denied");
    assert.ok(f.svc.link({ humanId: a.id, identity: TG }, a.self));
    const linkId = f.svc.resolve(TG)!.linkId;
    refuses(() => f.svc.unlink({ linkId }, b.self), "denied");
    refuses(() => f.svc.unlink({ linkId }, { ...a.self, kind: "agent" }), "denied");
    assert.ok(f.svc.resolve(TG), "the failed attempts left the link in place");
    f.svc.unlink({ linkId }, a.self);
    assert.equal(f.svc.resolve(TG), null);
  });
});

describe("identity rpc: mapIdentityError", () => {
  const cases: Array<[IdentityErrorCode, { field?: string; retryAfterMs?: number }, string, string | undefined, string | undefined]> = [
    ["invalid-params", { field: "userId" }, "E_INVALID_PARAMS", undefined, "userId"],
    ["invalid-params", {}, "E_INVALID_PARAMS", undefined, undefined],
    ["not-found", {}, "E_NOT_FOUND", undefined, undefined],
    ["conflict", {}, "E_CONFLICT", undefined, undefined],
    ["limit", {}, "E_CONFLICT", "limit", undefined],
    ["invalid-code", {}, "E_DENIED", "invalid-code", undefined],
    ["expired", {}, "E_DENIED", "expired", undefined],
    ["rate-limited", { retryAfterMs: 4321 }, "E_DENIED", "rate-limited", "retryAfterMs=4321"],
    ["rate-limited", {}, "E_DENIED", "rate-limited", "retryAfterMs=0"],
    ["denied", {}, "E_DENIED", "identity-denied", undefined],
    ["storage", {}, "E_STORAGE", "identity-store", undefined],
  ];
  for (const [code, o, rpc, reason, detail] of cases) {
    it(`${code}${o.field ? ` (field ${o.field})` : ""}${o.retryAfterMs !== undefined ? " (with retry time)" : ""} becomes ${rpc}`, () => {
      assert.throws(() => mapIdentityError(new IdentityError(code, `msg-${code}`, o)), (e: unknown) => {
        assert.ok(e instanceof RpcError); assert.equal(e.error, rpc); assert.equal(e.message, `msg-${code}`); assert.equal(e.reason, reason); assert.equal(e.detail, detail); return true;
      });
    });
  }

  it("every service error code has a mapping (the closed vocabulary is covered)", () => {
    const all: IdentityErrorCode[] = ["invalid-params", "not-found", "invalid-code", "expired", "rate-limited", "conflict", "limit", "storage", "denied"];
    for (const c of all) assert.throws(() => mapIdentityError(new IdentityError(c, "m")), RpcError, c);
  });

  it("anything that is not an IdentityError passes through untouched (a bug stays visible as a bug)", () => {
    const boom = new TypeError("boom");
    assert.throws(() => mapIdentityError(boom), (e: unknown) => e === boom);
    const rpc = new RpcError("E_INTERNAL", "x");
    assert.throws(() => mapIdentityError(rpc), (e: unknown) => e === rpc);
    assert.throws(() => mapIdentityError("text"), (e: unknown) => e === "text");
    assert.throws(() => mapIdentityError(null), (e: unknown) => e === null);
  });
});

describe("identity rpc: the owner-only handlers", () => {
  const CLI = { channel: "cli", accountId: "box", userId: "owner-1" };
  function rig(over: { isStopping?: () => boolean } = {}) {
    const f = fixture(); const methods = buildIdentityMethods({ service: f.svc, ...over });
    const call = (name: string, params: Record<string, unknown>) => methods[name]!(params, {} as never);
    return { f, methods, call };
  }
  const denied = async (p: Promise<unknown>, want: { error: string; reason?: string }) => assert.rejects(p, (e: unknown) => e instanceof RpcError && e.error === want.error && e.reason === want.reason);

  it("exposes exactly the documented methods", () => {
    const { methods } = rig();
    assert.deepEqual(Object.keys(methods).sort(), [...IDENTITY_METHODS].sort());
  });

  it("a caller that is not the cli is refused on every method, whatever the claimed channel or user", async () => {
    const { call } = rig();
    for (const name of IDENTITY_METHODS) for (const caller of [{ channel: "telegram", accountId: "bot", userId: "owner-1" }, { channel: "CLI", accountId: "box", userId: "owner-1" }, { channel: "cli ", accountId: "box", userId: "owner-1" }, undefined, null, {}, "cli"] as const) {
      await denied(call(name, { caller, humanId: "x" }), { error: "E_DENIED", reason: "owner-only" });
    }
  });

  it("the refusal happens before the service is touched: no person is created by a refused caller", async () => {
    const { f, call } = rig();
    await denied(call("identity.human.create", { caller: { channel: "discord", accountId: "g", userId: "u" }, displayName: "Eve" }), { error: "E_DENIED", reason: "owner-only" });
    assert.deepEqual(f.svc.list({}).humans, []);
  });

  it("a stopping core answers E_CORE_UNAVAILABLE first, even before the caller is checked (characterization: Ist-Verhalten, nicht spezifiziert)", async () => {
    const { call } = rig({ isStopping: () => true });
    await denied(call("identity.list", { caller: CLI }), { error: "E_CORE_UNAVAILABLE", reason: "core-stopping" });
    await denied(call("identity.list", { caller: { channel: "telegram", accountId: "a", userId: "u" } }), { error: "E_CORE_UNAVAILABLE", reason: "core-stopping" });
  });

  it("the cli caller acts as an owner person: create, link, pair, confirm, unlink work end to end", async () => {
    const { f, call } = rig();
    const h = await call("identity.human.create", { caller: CLI, displayName: "Alex" }) as { id: string };
    const link = await call("identity.link", { caller: CLI, humanId: h.id, identity: TG }) as { id: string; proofMethod: string; linkedBy: string };
    assert.equal(link.proofMethod, "owner_manual"); assert.equal(link.linkedBy, CLI.userId);
    const p = await call("identity.pair.start", { caller: CLI, humanId: h.id, channel: "discord" }) as { code: string; pairingId: string };
    const c = await call("identity.pair.claim", { caller: CLI, code: p.code, identity: { channel: "discord", accountId: "g", userId: "7" } }) as { pairingId: string };
    const done = await call("identity.pair.confirm", { caller: CLI, pairingId: c.pairingId, approve: true }) as { state: string };
    assert.equal(done.state, "confirmed");
    await call("identity.unlink", { caller: CLI, linkId: link.id });
    assert.equal(f.svc.resolve(TG), null); assert.ok(f.svc.resolve({ channel: "discord", accountId: "g", userId: "7" }));
  });

  it("the actor handed to the service is the caller: host is the account, the user id is the caller's (hashed in the audit trail)", async () => {
    const { f, call } = rig();
    await call("identity.human.create", { caller: CLI, displayName: "Alex" });
    const ev = f.events.find((e) => e.action === "identity.human.create")!;
    assert.deepEqual(ev.actor, { user: sha(CLI.userId), host: sha(CLI.accountId) });
  });

  it("service refusals arrive as the closed RPC codes", async () => {
    const { f, call } = rig(); const h = f.human();
    await denied(call("identity.link", { caller: CLI, humanId: "00000000-0000-7000-8000-000000000000", identity: TG }), { error: "E_NOT_FOUND" });
    await call("identity.link", { caller: CLI, humanId: h.id, identity: TG });
    await denied(call("identity.link", { caller: CLI, humanId: h.id, identity: TG }), { error: "E_CONFLICT" });
    await denied(call("identity.pair.claim", { caller: CLI, code: "AAAAAAAA", identity: { ...TG, userId: "stranger" } }), { error: "E_DENIED", reason: "invalid-code" });
    await denied(call("identity.pair.confirm", { caller: CLI, pairingId: "nope", approve: true }), { error: "E_NOT_FOUND" });
  });

  it("a locked claimant sees E_DENIED rate-limited with the retry time in detail", async () => {
    const { call } = rig();
    for (let i = 0; i < 5; i++) await call("identity.pair.claim", { caller: CLI, code: "AAAAAAAA", identity: TG }).catch(() => undefined);
    await assert.rejects(call("identity.pair.claim", { caller: CLI, code: "AAAAAAAA", identity: TG }), (e: unknown) => e instanceof RpcError && e.error === "E_DENIED" && e.reason === "rate-limited" && e.detail === `retryAfterMs=${15 * MIN}`);
  });

  it("malformed parameters are E_INVALID_PARAMS with the field, never a crash", async () => {
    const { f, call } = rig(); const h = f.human();
    const bad: Array<[string, Record<string, unknown>]> = [
      ["identity.human.create", { caller: CLI }], ["identity.human.create", { caller: CLI, displayName: 5 }],
      ["identity.link", { caller: CLI, humanId: h.id }], ["identity.link", { caller: CLI, humanId: h.id, identity: "telegram" }], ["identity.link", { caller: CLI, humanId: h.id, identity: null }],
      ["identity.pair.start", { caller: CLI, humanId: h.id, channel: "Telegram" }], ["identity.pair.claim", { caller: CLI, code: "AAAAAAAA" }], ["identity.pair.claim", { caller: CLI, code: "AAAAAAAA", identity: [] }],
    ];
    for (const [name, p] of bad) await assert.rejects(call(name, p), (e: unknown) => e instanceof RpcError && e.error === "E_INVALID_PARAMS", `${name} ${JSON.stringify(p)}`);
  });

  it("identity.pair.confirm with a missing or non-boolean approve declines instead of approving", async () => {
    const { f, call } = rig(); const h = f.human();
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    const c = f.svc.claim({ code: p.code, identity: TG });
    const r = await call("identity.pair.confirm", { caller: CLI, pairingId: c.pairingId, approve: "true" }) as { state: string };
    assert.equal(r.state, "declined"); assert.equal(f.svc.resolve(TG), null);
  });

  it("identity.list never includes a pairing code, and hides revoked links unless asked", async () => {
    const { f, call } = rig(); const h = f.human();
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    const { linkId } = f.pairAndLink(h.id, { ...TG, userId: "9" });
    f.svc.unlink({ linkId }, OWNER);
    f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    const plain = await call("identity.list", { caller: CLI }) as { humans: Array<{ identities: unknown[] }>; pairings: unknown[] };
    assert.equal(plain.humans.find((x) => (x as { id?: string }).id === h.id)!.identities.length, 0);
    const withRevoked = await call("identity.list", { caller: CLI, includeRevoked: true }) as typeof plain;
    assert.equal(withRevoked.humans.find((x) => (x as { id?: string }).id === h.id)!.identities.length, 1);
    assert.equal(JSON.stringify(plain).includes(p.code), false);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: identity.pair.start ignores a ttlMs parameter (the schema has none), so the lifetime is the service default", async () => {
    const { f, call } = rig(); const h = f.human();
    const p = await call("identity.pair.start", { caller: CLI, humanId: h.id, channel: "telegram", ttlMs: 60_000 }) as { expiresAt: number };
    assert.equal(p.expiresAt, f.now() + 60 * MIN);
  });

  it(gap("identity.pair.start (RPC)", "a code valid for 10 minutes (rpc.schema.json: 'valid 10 minutes'; docs/identity.md says one hour and its status table calls main's 10 minutes outdated)", "expiresAt is now + 60 minutes: the schema text and docs/identity.md contradict each other, the code follows the document"), { todo: gap("identity.pair.start (RPC)", "a code valid for 10 minutes (rpc.schema.json: 'valid 10 minutes'; docs/identity.md says one hour and its status table calls main's 10 minutes outdated)", "expiresAt is now + 60 minutes: the schema text and docs/identity.md contradict each other, the code follows the document") }, async () => {
    const { f, call } = rig(); const h = f.human();
    const p = await call("identity.pair.start", { caller: CLI, humanId: h.id, channel: "telegram" }) as { expiresAt: number };
    assert.equal(p.expiresAt, f.now() + 10 * MIN);
  });
});

describe("identity audit: the line writer", () => {
  function writer() {
    const f = fixture(); const file = path.join(f.dir, "logs", "audit.log"); let t = 1_700_000_000_000; const secured: string[] = [];
    const w = createAuditWriter({ file, securePath: (p) => { secured.push(p); }, clock: () => t });
    return { f, file, w, secured, tick: (n: number) => { t += n; } };
  }
  const read = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

  it("writes one JSON line per event in the audit.rs shape { at, actor, action, target, detail }", () => {
    const { file, w, tick } = writer();
    const ev: AuditEvent = { action: "identity.link", target: "t1", detail: { a: 1 }, actor: { user: "u", host: "h" } };
    w(ev); tick(5); w({ ...ev, target: "t2" });
    assert.deepEqual(read(file), [
      { at: 1_700_000_000_000, actor: { user: "u", host: "h" }, action: "identity.link", target: "t1", detail: { a: 1 } },
      { at: 1_700_000_000_005, actor: { user: "u", host: "h" }, action: "identity.link", target: "t2", detail: { a: 1 } },
    ]);
    assert.equal(readFileSync(file, "utf8").endsWith("\n"), true);
  });

  it("an event without an actor is attributed to the core itself", () => {
    const { file, w } = writer();
    w({ action: "identity.pair.claim", target: "t", detail: {} });
    assert.deepEqual(read(file)[0]!.actor, { user: "core", host: "core" });
  });

  it("creates the directory and the file privately, and secures the path exactly once", () => {
    const { file, w, secured } = writer();
    w({ action: "a", target: "t", detail: {} }); w({ action: "b", target: "t", detail: {} });
    assert.deepEqual(secured, [file]);
    if (process.platform !== "win32") { assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700); }
  });

  it("appends to what is already there and never rewrites earlier lines", () => {
    const { file, w } = writer();
    w({ action: "first", target: "t", detail: {} });
    const second = createAuditWriter({ file, securePath: () => {}, clock: () => 9 });
    second({ action: "second", target: "t", detail: {} });
    assert.deepEqual(read(file).map((l) => l.action), ["first", "second"]);
  });

  it("is lazy: nothing is created until the first event", () => {
    const { file } = writer();
    assert.equal(existsSync(file), false);
  });

  it("an unwritable location makes the writer throw (the service is what contains that, see below)", () => {
    const f = fixture(); const blocker = path.join(f.dir, "blocker"); mkdirSync(blocker); // the log file's own path is a directory
    assert.throws(() => createAuditWriter({ file: blocker, securePath: () => {}, clock: () => 1 })({ action: "x", target: "t", detail: {} }));
  });

  it("through the service: the trail holds hashed identifiers and semantic events, never a code, a handle or a person id", () => {
    const f = fixture(); const file = path.join(f.dir, "logs", "audit.log");
    const svc = f.reopen({ audit: createAuditWriter({ file, securePath: () => {}, clock: () => f.now() }) });
    const h = svc.createHuman({ displayName: "Display Marker Zed" }, OWNER);
    const p = svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    const id = { channel: "telegram", accountId: "acct-marker-trail", userId: "user-marker-trail" };
    try { svc.claim({ code: "AAAAAAAA", identity: id }); } catch { /* a counted failure */ }
    const c = svc.claim({ code: p.code, identity: id });
    svc.confirm({ pairingId: c.pairingId, approve: true }, OWNER);
    const text = readFileSync(file, "utf8");
    for (const secret of [p.code, "acct-marker-trail", "user-marker-trail", h.id, p.pairingId, "Display Marker Zed", OWNER.user, "AAAAAAAA"]) assert.equal(text.includes(secret), false, secret);
    const actions = read(file).map((l) => l.action);
    for (const a of ["identity.human.create", "identity.pair.start", "identity.pair.claim", "identity.pair.confirm", "link.approved"]) assert.ok(actions.includes(a as string), a);
  });

  it("a writer that cannot write does not break the operation it was asked to record", () => {
    const f = fixture(); const dirAsFile = path.join(f.dir, "dir-as-file"); mkdirSync(dirAsFile);
    const svc = f.reopen({ audit: createAuditWriter({ file: dirAsFile, securePath: () => {}, clock: () => f.now() }) });
    const h = svc.createHuman({ displayName: "x" }, OWNER);
    assert.ok(svc.link({ humanId: h.id, identity: TG }, OWNER));
    assert.ok(svc.resolve(TG));
  });
});
