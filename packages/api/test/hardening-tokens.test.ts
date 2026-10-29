// Step 3 of the server hardening sweep: personal API tokens, the owner token, and the RBAC classification of every route.
// Already pinned elsewhere (not repeated): revocation, expiry and demotion at the HTTP level (tokens-api.test.ts), the
// token shape, hash-only storage and the live-token cap at the service level (tokens.test.ts), file mode and symlink
// checks of the owner token (owner-token.test.ts), the owner token as a Bearer value (auth.test.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FakeClock } from "../src/clock.ts";
import { MemoryTokenStore } from "../src/memory-stores.ts";
import type { TokenRecord } from "../src/ports.ts";
import { authorize, POLICY, policyFor, type RbacPrincipal } from "../src/rbac-bridge.ts";
import { ROUTES, type RouteSpec } from "../src/routes.ts";
import { DEFAULT_TTL_MS, MAX_TOKENS_PER_USER, TokenService } from "../src/tokens.ts";
import { ROLES } from "../../core/src/rbac/types.ts";
import { addUser, csrfToken, jsonHeaders, login, loginAs, OWNER_TOKEN, raw, start, write, type Harness } from "./helpers.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const wide = { upload: { capacity: 100_000, refillPerSec: 10_000 }, auth: { capacity: 100_000, refillPerSec: 10_000 }, read: { capacity: 100_000, refillPerSec: 10_000 }, write: { capacity: 100_000, refillPerSec: 10_000 }, totp: { capacity: 100_000, refillPerSec: 10_000 }, stream: { capacity: 100_000, refillPerSec: 10_000 } };
/** `plb_<12 hex>_<43 base64url>`: the secret starts at a fixed offset (base64url may itself contain "_"). */
const secretOf = (token: string): string => token.slice(17);
const rank = (role: string) => ROLES.length - ROLES.indexOf(role as (typeof ROLES)[number]); // owner 5 … viewer 1

// ---- RBAC classification of every route ----------------------------------------------------------------------------

/** The lowest role the policy table lets through for a route's action (a role-level answer: ownership and object rights come on top). */
const MIN_ROLE: Record<string, string> = {
  "imports.sources": "admin",
  "extensions.upload": "admin", "extensions.inspect": "admin", "imports.snapshot.upload": "admin",
  "channel.history.list": "viewer", "channel.history.get": "viewer", "channel.handoff.create": "member", "channel.handoff.redeem": "member",
  "passkeys.list": "viewer", "passkeys.options": "member", "passkeys.register": "member", "passkeys.change": "member",
  "chats.list": "viewer", "chats.create": "member", "chats.create-agent": "member", "chats.get": "viewer", "chats.update": "member",
  "chats.messages": "viewer", "chats.submit": "member", "chats.events": "viewer", "chats.cancel": "member", "chats.archive": "member",
  "chats.restore": "member", "chats.fork": "member", "chats.export": "viewer", "chats.delete": "member", "chats.model-get": "viewer", "chats.model-set": "member", "ws.ticket": "admin", "ws.reserved": "admin",
  "remote.get": "admin", "remote.set": "admin", "remote.confirm": "admin", "remote.certificate": "admin",
  "remote.pairing.status": "admin", "remote.pairing.offer": "admin", "remote.trust.get": "viewer", "remote.trust.challenge": "member", "remote.trust.ack": "member", "remote.trust.rotate": "admin",
  "health": "operator", "agents.list": "viewer", "tokens.list": "viewer", "tokens.create": "member", "tokens.revoke": "member",
  "totp.status": "viewer", "totp.setup": "member", "totp.confirm": "member", "totp.disable": "member",
  "breakglass.request": "admin", "breakglass.list": "admin", "breakglass.revoke": "admin", "notices.list": "viewer",
};
// Native approval start/poll/cancel perform their own exact enrolled-device bearer check; ordinary PAT auth is never substituted.
const PUBLIC = ["desktop.meta", "desktop.pair", "desktop.redeem", "desktop.ticket", "desktop.step-up.start", "desktop.step-up.poll", "desktop.step-up.cancel", "invitation.redeem", "session.create", "session.totp", "account.bootstrap", "passkeys.login.options", "passkeys.login", "remote.pair-proof", "remote.device.pair", "oauth.metadata", "oauth.protected_resource", "oauth.authorize.get", "oauth.authorize.post", "oauth.token", "oauth.revoke", "a2a.card.root", "a2a.card.root.alias", "a2a.card.agent", "a2a.card.agent.alias"];
const SELF_SERVICE = ["csrf.issue", "desktop.step-up.approval", "desktop.step-up.decision", "session.delete", "sessions.revoke-all", "whoami", "oauth.grants.list", "oauth.grants.revoke"];

function minRoleOf(action: string): string | undefined {
  const spec = policyFor(action); if (!spec) return undefined;
  return [...ROLES].reverse().find((r) => (spec.grants[r] ?? []).length > 0);
}

test("every route has a classification: public (login only), self-service, or an RBAC action with a defined minimum role; the unclassified are listed", () => {
  const problems: string[] = [];
  for (const r of ROUTES as readonly RouteSpec[]) {
    const az = (r as { authz?: RouteSpec["authz"] }).authz;
    if (az === undefined) { problems.push(`${r.id}: no authz`); continue; }
    if (az === "public") { if (!PUBLIC.includes(r.id) || r.auth !== "none") problems.push(`${r.id}: public but not a login step`); continue; }
    if (az === "delegated") {
      if (r.transport === "protocol") {
        if (r.auth !== "any") problems.push(`${r.id}: protocol delegated route must specify any auth`);
      } else if (!["web.rpc", "web.events"].includes(r.id) || r.auth !== "session") {
        problems.push(`${r.id}: invalid delegated route`);
      }
      continue;
    }
    if (az === "authenticated") { if (!SELF_SERVICE.includes(r.id)) problems.push(`${r.id}: authenticated without being session self-service`); continue; }
    if (!policyFor(az.action)) { problems.push(`${r.id}: action ${az.action} is not in the policy table`); continue; }
    const min = minRoleOf(az.action);
    if (min === undefined) problems.push(`${r.id}: ${az.action} is allowed to no role`);
    else if (MIN_ROLE[r.id] !== min) problems.push(`${r.id}: minimum role is ${min}, this test expects ${MIN_ROLE[r.id] ?? "(no entry)"}`);
  }
  for (const id of [...PUBLIC, ...SELF_SERVICE, ...Object.keys(MIN_ROLE)]) if (!ROUTES.some((r) => r.id === id)) problems.push(`${id}: listed here but no such route`);
  assert.deepEqual(problems, [], `routes without a (matching) classification:\n${problems.join("\n")}`);
});

test("a route that is public or only needs a live session can never be an action a human-only or secret-handling role table guards", () => {
  for (const r of ROUTES) {
    if (r.authz === "delegated") {
      if (r.transport === "protocol") {
        assert.equal(r.auth, "any");
      } else {
        assert.equal(r.auth, "session");
        assert.ok(["web.rpc", "web.events"].includes(r.id));
      }
      continue;
    }
    if (r.authz === "public" || r.authz === "authenticated") continue;
    const spec = policyFor(r.authz.action)!;
    if (["extensions.upload", "extensions.inspect", "imports.snapshot.upload"].includes(r.id)) {
      assert.equal(spec.humanOnly, true); assert.equal(r.auth, "any"); // only enrolled person-bound device tokens; PATs remain agents
    } else assert.equal(spec.humanOnly === true && r.auth === "any", false, `${r.id}: a human-only action must not be reachable with a personal token`);
  }
  assert.ok(POLICY.length > 50, "the policy table is the one imported from core, not a stub");
});

test("the minimum role is enforced over HTTP: for every route and every role, 403 exactly below the minimum, never above", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const sessions: Record<string, string> = { owner: (await login(h)).cookie };
    for (const role of ROLES.filter((r) => r !== "owner")) { await addUser(h, { id: `u-${role}`, username: role, role }); sessions[role] = (await loginAs(h, role)).cookie; }
    const bodyFor = (id: string): unknown => ({ "tokens.create": { name: "t", scopes: ["doctor.read"] }, "tokens.revoke": { id: "0".repeat(12) }, "totp.confirm": { code: "000000" }, "totp.disable": { code: "000000" }, "breakglass.request": { targetUserId: "nobody", reason: "redact-probe-alpha reason" }, "breakglass.revoke": { grantId: "none" } } as Record<string, unknown>)[id];
    const wrong: string[] = [];
    for (const spec of ROUTES) {
      if (typeof spec.authz !== "object") continue;
      for (const role of ROLES) {
        const cookie = sessions[role]!; const allowed = rank(role) >= rank(MIN_ROLE[spec.id]!);
        const r = spec.method === "GET" ? await raw(h, { path: spec.path.replace("{agentId}", "main").replace("{sessionId}", "contract-chat"), headers: { cookie } }) : await write(h, cookie, { method: spec.method, path: spec.path.replace("{agentId}", "main").replace("{sessionId}", "contract-chat"), ...(bodyFor(spec.id) !== undefined ? { body: bodyFor(spec.id) } : {}) });
        if (r.status === 401) wrong.push(`${spec.id} as ${role}: 401 for a live session`);
        else if (allowed && r.status === 403 && r.json?.reason === "role-denied") wrong.push(`${spec.id} as ${role}: refused although the minimum is ${MIN_ROLE[spec.id]}`);
        else if (!allowed && r.status !== 403) wrong.push(`${spec.id} as ${role}: ${r.status} below the minimum ${MIN_ROLE[spec.id]}`);
      }
    }
    assert.deepEqual(wrong, [], wrong.join("\n"));
  } finally { await h.close(); }
});

// ---- tokens --------------------------------------------------------------------------------------------------------

test("code evidence: a presented token is compared as a SHA-256 digest with timingSafeEqual, and an unknown id costs the same comparison against a dummy", () => {
  const src = readFileSync(path.join(here, "../src/tokens.ts"), "utf8");
  assert.match(src, /import \{[^}]*timingSafeEqual[^}]*\} from "node:crypto"/);
  assert.match(src, /timingSafeEqual\(sha256\(p\.secret\), want\)/, "the secret is hashed, then compared in constant time");
  assert.match(src, /const want = rec \? Buffer\.from\(rec\.hash, "hex"\) : this\.#dummy/, "an unknown id is compared against a dummy digest");
  assert.ok(!/(rec\.hash|\.secret|presented)\s*[!=]==/.test(src), "no plain equality on the stored hash or the presented secret");
  assert.ok(src.indexOf("timingSafeEqual(") < src.indexOf('reason: "revoked"'), "revocation and expiry are judged only after the secret matched");
});

test("a token is dead on the very millisecond it expires, and alive one millisecond before", async () => {
  const clock = new FakeClock(); const svc = new TokenService({ store: new MemoryTokenStore(), clock });
  const { token } = await svc.create("u1", { name: "edge", scopes: ["doctor.read"], ttlMs: 3_600_000 });
  clock.advance(3_600_000 - 1); assert.equal((await svc.authenticate(token)).ok, true);
  clock.advance(1); const r = await svc.authenticate(token); assert.deepEqual([r.ok, r.ok === false && r.reason], [false, "expired"]);
});

test("a store that fails to record lastUsedAt never fails the request that was authenticated", async () => {
  const clock = new FakeClock(); const store = new MemoryTokenStore();
  const svc = new TokenService({ store, clock }); const { token } = await svc.create("u1", { name: "t", scopes: ["doctor.read"] });
  store.update = async () => { throw new Error("disk full"); };
  assert.equal((await svc.authenticate(token)).ok, true);
});

test("the live-token cap holds under concurrency: 60 simultaneous creations leave at most the documented maximum", async () => {
  const clock = new FakeClock(); const svc = new TokenService({ store: new MemoryTokenStore(), clock });
  const results = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => svc.create("u1", { name: `t${i}`, scopes: ["doctor.read"] })));
  const made = results.filter((r) => r.status === "fulfilled").length;
  assert.ok(made <= MAX_TOKENS_PER_USER, `${made} tokens were made for one user, the cap is ${MAX_TOKENS_PER_USER}`);
  assert.equal((await svc.list("u1")).length, made);
  const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  for (const r of refused) assert.equal((r.reason as { reason?: string }).reason, "token-limit");
});

test("over HTTP: parallel token creation from several sessions of one user cannot pass the cap either", async () => {
  const h = await start({ rateClasses: wide });
  try {
    await addUser(h, { id: "u-alice", username: "alice", role: "member" });
    const cookies = await Promise.all([1, 2, 3, 4].map(async () => (await loginAs(h, "alice")).cookie));
    const jobs: Array<Promise<{ status: number }>> = [];
    for (const cookie of cookies) {
      const csrfs: string[] = []; for (let i = 0; i < 15; i++) csrfs.push(await csrfToken(h, cookie));
      for (const [i, t] of csrfs.entries()) jobs.push(raw(h, { method: "POST", path: "/api/v1/tokens", headers: { cookie, "x-csrf-token": t, ...jsonHeaders() }, body: JSON.stringify({ name: `t${i}`, scopes: ["agent.list"] }) }));
    }
    const out = await Promise.all(jobs);
    const made = out.filter((r) => r.status === 201).length;
    assert.ok(made <= MAX_TOKENS_PER_USER, `${made} created over HTTP (60 attempts)`);
    assert.ok(out.every((r) => r.status === 201 || r.status === 409), JSON.stringify(out.map((r) => r.status)));
  } finally { await h.close(); }
});

test("a token of a disabled or deleted account is refused at its next use with the same 401 as any other bad token", async () => {
  const h = await start({ rateClasses: wide });
  try {
    await addUser(h, { id: "u-alice", username: "alice", role: "operator" });
    const { cookie } = await loginAs(h, "alice");
    const mint = async (name: string) => (await write(h, cookie, { path: "/api/v1/tokens", body: { name, scopes: ["doctor.read"] } })).json.token as string;
    const dead = await mint("will-be-revoked"); const second = await mint("account-goes");
    await write(h, cookie, { path: "/api/v1/tokens/revoke", body: { id: dead.split("_")[1] } });
    const use = (t: string) => raw(h, { path: "/api/v1/health", headers: { authorization: `Bearer ${t}` } });
    assert.equal((await use(second)).status, 200);
    const bodies = new Set<string>();
    h.users.change("u-alice", { disabled: true });
    for (const t of [dead, second, `plb_${"0".repeat(12)}_${"A".repeat(43)}`, "plb_nope", "x"]) { const r = await use(t); assert.equal(r.status, 401, t.slice(0, 12)); bodies.add(r.text); }
    assert.equal(bodies.size, 1, "revoked, disabled-account, unknown and malformed tokens answer with the same bytes");
    h.users.change("u-alice", { disabled: false });
    assert.equal((await use(second)).status, 401, "enable requires fresh credentials; disabled tokens remain revoked");
  } finally { await h.close(); }
});

test("a token is never shown again after creation: no later list, whoami, audit entry, log line or store dump holds its secret", async () => {
  const h = await start({ rateClasses: wide });
  try {
    await addUser(h, { id: "u-alice", username: "alice", role: "operator" });
    const { cookie } = await loginAs(h, "alice");
    const made = await write(h, cookie, { path: "/api/v1/tokens", body: { name: "redact-probe-alpha", scopes: ["doctor.read", "agent.*"] } });
    const secret = secretOf(made.json.token as string); assert.equal(secret.length, 43);
    const seen = [(await raw(h, { path: "/api/v1/tokens", headers: { cookie } })).text, (await raw(h, { path: "/api/v1/whoami", headers: { authorization: `Bearer ${made.json.token}` } })).text,
      JSON.stringify(h.audit.events), h.logs.join("\n")];
    for (const s of seen) assert.ok(!s.includes(secret), "the secret leaked");
  } finally { await h.close(); }
});

// ---- the owner token and the agent context -------------------------------------------------------------------------

test("the owner token is a credential for the login body only: in no other place, on no route, does it open anything", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const t = OWNER_TOKEN; const bad: string[] = [];
    const placements: Array<[string, Record<string, string>, string]> = [
      ["Bearer", { authorization: `Bearer ${t}` }, ""], ["Token scheme", { authorization: `Token ${t}` }, ""], ["Basic", { authorization: `Basic ${Buffer.from(`owner:${t}`).toString("base64")}` }, ""],
      ["session cookie", { cookie: `plur1bus_session=${t}` }, ""], ["host cookie", { cookie: `__Host-plur1bus_session=${t}` }, ""], ["X-API-Key", { "x-api-key": t }, ""], ["X-Owner-Token", { "x-owner-token": t }, ""],
      ["query token", {}, `?token=${t}`], ["query owner_token", {}, `?owner_token=${t}&access_token=${t}`],
    ];
    for (const spec of ROUTES) {
      if (spec.id === "session.create" || spec.id.startsWith("oauth.")) continue;
      for (const [label, headers, query] of placements) {
        const r = await raw(h, { method: spec.method, path: spec.path + query, headers: { ...headers, ...(spec.requestBody ? jsonHeaders() : {}) }, ...(spec.requestBody ? { body: JSON.stringify({ token: t, challenge: t, code: t, id: t, name: t }) } : {}) });
        if(spec.id==="desktop.meta") {
          assert.equal(r.status,200);assert.deepEqual(Object.keys(r.json).sort(),["capabilities","pairingRequired","version"]);assert.equal(r.headers["set-cookie"],undefined);
        } else if (r.status < 400 || r.status >= 500) bad.push(`${spec.id} via ${label}: ${r.status}`);
        if (r.text.includes(t)) bad.push(`${spec.id} via ${label}: the answer echoes the token`);
      }
    }
    assert.deepEqual(bad, [], bad.join("\n"));
    assert.equal((await login(h)).res.status, 200, "and the one place it is meant for still works");
  } finally { await h.close(); }
});

test("an agent context never holds an owner's rights: a token (agent principal) of the owner is refused every human-only and every owner-only action", () => {
  const person: RbacPrincipal = { userId: "owner", role: "owner", kind: "person" };
  const system = { kind: "system" } as const; const refusedAsAgent: string[] = []; const allowedAsPerson: string[] = [];
  for (const spec of POLICY) {
    if (spec.resource !== "system") continue;
    const asAgent: RbacPrincipal = { ...person, kind: "agent", tokenScopes: [spec.action] };
    const agent = authorize(asAgent, spec.action, system);
    if (spec.humanOnly) { assert.equal(agent.effect, "deny", `${spec.action} (human-only) was allowed to the owner's token`); refusedAsAgent.push(spec.action); }
    if (authorize(person, spec.action, system).effect === "allow") allowedAsPerson.push(spec.action);
  }
  assert.ok(refusedAsAgent.length >= 10, `only ${refusedAsAgent.length} human-only system actions were exercised`);
  assert.ok(allowedAsPerson.includes("secrets.reveal") && allowedAsPerson.includes("auth.credentials.read"), "the same actions are open to the owner as a person");
  // A prefix scope does not stretch to a human-only action either, and a token without a scope for the action is refused by the scope check first.
  assert.equal(authorize({ ...person, kind: "agent", tokenScopes: ["auth.*"] }, "auth.credentials.read", system).effect, "deny");
  assert.equal(authorize({ ...person, kind: "agent", tokenScopes: ["doctor.read"] }, "secrets.reveal", system).effect, "deny");
});

test("over HTTP an owner-minted token is the owner's role but an agent principal: it reads health, and cannot reach any route that needs a session", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const { cookie } = await login(h);
    const made = await write(h, cookie, { path: "/api/v1/tokens", body: { name: "agent-use", scopes: ["doctor.read", "my.read", "my.write", "breakglass.request"] } });
    const auth = { authorization: `Bearer ${made.json.token}` };
    assert.equal((await raw(h, { path: "/api/v1/health", headers: auth })).status, 200);
    // `whoami` needs no action (it is session handling, "authenticated"), so scopes do not narrow it: a token may ask who it is.
    const who = await raw(h, { path: "/api/v1/whoami", headers: auth });
    assert.equal(who.status, 200); assert.equal(who.json.via, "token"); assert.equal(who.json.principal.role, "owner"); assert.ok(!who.text.includes(secretOf(made.json.token)));
    assert.equal((await raw(h, { path: "/api/v1/agents", headers: auth })).status, 403, "agent.list is not among this token's scopes");
    for (const spec of ROUTES.filter((r) => r.auth === "session")) {
      const r = await raw(h, { method: spec.method, path: spec.path.replace("{agentId}", "main").replace("{sessionId}", "contract-chat"), headers: { ...auth, ...(spec.requestBody ? jsonHeaders() : {}) }, ...(spec.requestBody ? { body: "{}" } : {}) });
      assert.equal(r.status, 401, `${spec.id}: a token is not a session`);
    }
  } finally { await h.close(); }
});

// A TokenRecord is what a store holds: the secret never, only the digest.
test("the record a store holds has no field that could carry the secret", async () => {
  const store = new MemoryTokenStore(); const svc = new TokenService({ store, clock: new FakeClock() });
  const { token, record } = await svc.create("u1", { name: "t", scopes: ["doctor.read"], ttlMs: DEFAULT_TTL_MS });
  const stored = (await store.get(record.id)) as TokenRecord;
  assert.deepEqual(Object.keys(stored).sort(), ["createdAt", "expiresAt", "hash", "id", "name", "scopes", "userId"]);
  assert.ok(!store.dump().includes(secretOf(token)));
});
