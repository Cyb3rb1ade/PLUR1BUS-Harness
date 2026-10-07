import assert from "node:assert/strict";
import test from "node:test";
import { FakeClock } from "../src/clock.ts";
import { ApiError } from "../src/errors.ts";
import { MemoryTokenStore } from "../src/memory-stores.ts";
import { MAX_TOKENS_PER_USER, parseToken, TokenService, validateScopes } from "../src/tokens.ts";

const DAY = 86_400_000;
// A base64url secret may itself contain "_", so the parts are cut by position, never by split("_").
const idOf = (t: string) => t.slice(4, 16);
const secretOf = (t: string) => t.slice(17);
const setup = () => { const clock = new FakeClock(); const store = new MemoryTokenStore(); return { clock, store, svc: new TokenService({ store, clock }) }; };
const mk = (svc: TokenService, o: { name?: string; scopes?: string[]; ttlMs?: number } = {}) => svc.create("u1", { name: o.name ?? "ci", scopes: o.scopes ?? ["agent.read"], ...(o.ttlMs !== undefined ? { ttlMs: o.ttlMs } : {}) });

test("a token is plb_<12 hex>_<43 base64url>; the secret is shown once and only its SHA-256 is stored", async () => {
  const { svc, store } = setup();
  const { token, record } = await mk(svc);
  assert.match(token, /^plb_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  const secret = secretOf(token);
  assert.ok(!store.dump().includes(secret), "the secret is not in the store");
  assert.ok(!JSON.stringify(record).includes(secret) && !("hash" in record), "the public view carries no hash and no secret");
  assert.equal(record.id, idOf(token)); assert.equal(record.prefix, `plb_${record.id}`);
  assert.deepEqual(parseToken(token), { id: record.id, secret });
  const again = await mk(svc); assert.notEqual(again.token, token);
});

test("authenticate accepts the token and refuses malformed, unknown, wrong-secret, revoked and expired ones with a reason", async () => {
  const { svc, clock } = setup();
  const { token, record } = await mk(svc, { ttlMs: 2 * DAY });
  const ok = await svc.authenticate(token); assert.equal(ok.ok, true); if (ok.ok) assert.equal(ok.record.userId, "u1");
  const id = idOf(token); const secret = secretOf(token);
  const cases: Array<[unknown, string]> = [[undefined, "malformed"], [5, "malformed"], ["", "malformed"], [`plb_${id}_${secret}x`, "malformed"], [`plb_${id}`, "malformed"], [`plb_000000000000_${secret}`, "unknown"], [`plb_${id}_${"A".repeat(43)}`, "unknown"], [`Bearer ${token}`, "malformed"]];
  for (const [t, reason] of cases) { const r = await svc.authenticate(t); assert.deepEqual([r.ok, r.ok ? "" : r.reason], [false, reason], String(t).slice(0, 24)); }
  clock.advance(2 * DAY + 1);
  assert.deepEqual(await svc.authenticate(token), { ok: false, reason: "expired", id: record.id });
  const fresh = await mk(svc); assert.equal(await svc.revoke("u1", fresh.record.id), true);
  assert.deepEqual(await svc.authenticate(fresh.token), { ok: false, reason: "revoked", id: fresh.record.id });
});

test("a wrong secret under a real id is 'unknown' — the same answer as an id that does not exist", async () => {
  const { svc } = setup();
  const { token } = await mk(svc); const id = idOf(token);
  const r = await svc.authenticate(`plb_${id}_${"B".repeat(43)}`);
  assert.equal(r.ok, false); assert.equal(r.ok ? "" : r.reason, "unknown");
});

test("scopes: exact RBAC actions or prefix.*, known, deduplicated, bounded; anything else is a 400 with reason `scope`", async () => {
  assert.deepEqual(validateScopes(["agent.read", "agent.read", "memory.*"]), ["agent.read", "memory.*"]);
  for (const bad of [[], ["*"], ["root"], ["agent.nope"], ["nope.*"], ["agent.read", 5], "agent.read", undefined, ["AGENT.READ"], [".*"], Array.from({ length: 21 }, () => "agent.read").map((s, i) => `${s}${i}`)]) {
    assert.throws(() => validateScopes(bad), (e: unknown) => e instanceof ApiError && e.status === 400 && e.reason === "scope", JSON.stringify(bad)?.slice(0, 40));
  }
});

test("name and lifetime are bounded: default 90 days, at most 365, at least 1 hour; at most MAX tokens per user", async () => {
  const { svc, clock } = setup();
  const a = await mk(svc); assert.equal(a.record.expiresAt - clock.now(), 90 * DAY);
  assert.equal((await mk(svc, { ttlMs: 365 * DAY })).record.expiresAt - clock.now(), 365 * DAY);
  for (const ttlMs of [0, 1000, 366 * DAY, -1, 1.5, Number.NaN]) await assert.rejects(mk(svc, { ttlMs }), (e: unknown) => e instanceof ApiError && e.reason === "ttl", String(ttlMs));
  for (const name of ["", " ", "x".repeat(65)]) await assert.rejects(mk(svc, { name }), (e: unknown) => e instanceof ApiError && e.reason === "name");
  for (let i = 2; i < MAX_TOKENS_PER_USER; i++) await mk(svc);
  await assert.rejects(mk(svc), (e: unknown) => e instanceof ApiError && e.status === 409 && e.reason === "token-limit");
  assert.equal((await svc.create("u2", { name: "other", scopes: ["agent.read"] })).record.name, "other", "the limit is per user");
});

test("revoke works for the owner of the token only; list shows only the caller's tokens, newest first, without secrets", async () => {
  const { svc, clock } = setup();
  const a = await mk(svc, { name: "first" }); clock.advance(1000); const b = await mk(svc, { name: "second" });
  assert.equal(await svc.revoke("u2", a.record.id), false, "not someone else's");
  assert.equal(await svc.revoke("u1", "000000000000"), false);
  assert.deepEqual((await svc.list("u1")).map((t) => t.name), ["second", "first"]);
  assert.deepEqual(await svc.list("u2"), []);
  await svc.revoke("u1", a.record.id);
  const listed = await svc.list("u1"); assert.equal(listed.find((t) => t.name === "first")!.revokedAt, clock.now());
  assert.equal(await svc.revoke("u1", a.record.id), false, "revoking twice does nothing");
  assert.ok(!JSON.stringify(listed).includes(secretOf(b.token)));
});

test("lastUsedAt is recorded on use, at most once a minute", async () => {
  const { svc, clock, store } = setup();
  const { token, record } = await mk(svc);
  assert.equal((await svc.list("u1"))[0]!.lastUsedAt, undefined);
  await svc.authenticate(token);
  const t1 = (await store.get(record.id))!.lastUsedAt; assert.equal(t1, clock.now());
  clock.advance(10_000); await svc.authenticate(token);
  assert.equal((await store.get(record.id))!.lastUsedAt, t1, "not written again within a minute");
  clock.advance(60_000); await svc.authenticate(token);
  assert.equal((await store.get(record.id))!.lastUsedAt, clock.now());
});
