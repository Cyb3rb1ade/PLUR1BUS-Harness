import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createIdentityService, IdentityError, type Actor } from "../../src/identity/service.ts";
import { deriveUserPrincipal, isUserPrincipal } from "../../src/identity/principals.ts";
import { createRecallScopeProvider } from "../../src/identity/recall.ts";
import { openStore } from "../../src/identity/store.ts";
import { createBackfill, type MetadataRebindPort } from "../../src/identity/backfill.ts";

const admin: Actor = { user: "synthetic-admin", host: "test", kind: "person", role: "admin" };
const identity = { channel: "telegram", accountId: "synthetic-bot", userId: "synthetic-channel-user" };
function fixture() {
  let now = 1_800_000_000_000;
  const file = join(tempDir("identity-v2-"), "identity.sqlite");
  const events: unknown[] = [];
  const open = () => createIdentityService({ dbPath: file, clock: () => now, audit: e => events.push(e) });
  const s = open();
  const h = s.createHuman({ displayName: "Synthetic" }, admin);
  return { s, h, file, events, open, advance: (ms: number) => { now += ms; } };
}
it("opaque ids hash exact bytes: stable, distinct case, NFC and whitespace variants", () => {
  const ids = ["A", "a", " a", "a ", "é", "e\u0301"];
  for (let n = 0; n < 100; n++) ids.push(`synthetic-${n}`);
  assert.equal(new Set(ids.map(deriveUserPrincipal)).size, ids.length);
  for (const id of ids) {
    const expected = `user:v2:${createHash("sha256").update(id).digest("hex")}`;
    assert.equal(deriveUserPrincipal(id), expected);
    assert.equal(deriveUserPrincipal(id), deriveUserPrincipal(id));
    assert.ok(isUserPrincipal(expected));
  }
  assert.ok(isUserPrincipal(`user:v1:${"a".repeat(64)}`));
  for (const bad of ["", "user:v3:" + "a".repeat(64), "user:v2:abc", "user:v2:" + "A".repeat(64)]) assert.equal(isUserPrincipal(bad), false);
});
it("pairing → confirmation → union recall → archive unlink; no vector writes", () => {
  const { s, h, events } = fixture();
  try {
    const self: Actor = { user: h.id, host: "test", kind: "person", role: "member" };
    const p = s.startPairing({ humanId: h.id, channel: identity.channel }, self);
    s.claim({ code: p.code, identity });
    assert.deepEqual(s.resolvePrincipals(deriveUserPrincipal(h.id)), [deriveUserPrincipal(h.id)]);
    const done = s.confirm({ pairingId: p.pairingId, approve: true }, self);
    const scopes = createRecallScopeProvider(s);
    let writes = 0;
    const rows = [deriveUserPrincipal(h.id), done.link!.v1Principal];
    const fakeEngine = {
      recall: (principals: readonly string[]) => rows.filter(p => principals.includes(p)),
      write: () => { writes++; },
    };
    const fakeRecall = fakeEngine.recall;
    assert.deepEqual(fakeRecall(scopes.resolvePrincipals(rows[0]!)), rows);
    assert.equal(scopes.capturePrincipal(rows[0]!), rows[0]);
    assert.equal(writes, 0);
    s.unlink({ linkId: done.link!.id }, self);
    assert.deepEqual(fakeRecall(scopes.resolvePrincipals(rows[0]!)), [rows[0]]);
    assert.equal(s.list({ includeRevoked: true }).humans[0]!.identities.length, 1);
    const serialized = JSON.stringify(events);
    for (const secret of [p.code, h.id, identity.accountId, identity.userId, self.user]) assert.equal(serialized.includes(secret), false);
    for (const action of ["link.requested", "link.approved", "link.removed"]) assert.ok(serialized.includes(action));
  } finally { s.close(); }
});
it("each role: self writes or admin; agents and unrelated users always denied", () => {
  const { s, h } = fixture();
  try {
    for (const role of ["owner", "admin", "operator", "member", "viewer"] as const) {
      const actor: Actor = { user: h.id, host: "test", role, kind: "person" };
      const operation = () => s.startPairing({ humanId: h.id, channel: role }, actor);
      if (role === "viewer") assert.throws(operation, IdentityError); else operation();
      assert.throws(() => s.link({ humanId: h.id, identity }, { ...actor, kind: "agent" }), IdentityError);
      if (role !== "owner" && role !== "admin") assert.throws(() => s.link({ humanId: h.id, identity }, { ...actor, user: "other" }), IdentityError);
    }
    assert.throws(() => s.link({ humanId: h.id, identity }, { user: h.id, host: "test" }), IdentityError);
    const p = s.startPairing({ humanId: h.id, channel: identity.channel }, admin);
    s.claim({ code: p.code, identity });
    assert.throws(() => s.confirm({ pairingId: p.pairingId, approve: true }, { user: "other", host: "test", role: "member", kind: "person" }), IdentityError);
    const l = s.confirm({ pairingId: p.pairingId, approve: true }, admin).link!;
    assert.throws(() => s.unlink({ linkId: l.id }, { ...admin, kind: "agent" }), IdentityError);
  } finally { s.close(); }
});
it("pending and claimed pairings never survive reopen or enter durable SQLite", () => {
  const { s, h, file, open } = fixture();
  const p = s.startPairing({ humanId: h.id, channel: identity.channel }, admin);
  s.claim({ code: p.code, identity }); s.close();
  const db = new DatabaseSync(file);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'pairings'").get(), undefined);
  db.close();
  const reopened = open();
  try { assert.deepEqual(reopened.list({}).pairings, []); } finally { reopened.close(); }
});
it("one-hour TTL boundary, pending cap includes claimed, user issuance limit across channels", () => {
  const { s, h, advance } = fixture();
  try {
    const p = s.startPairing({ humanId: h.id, channel: identity.channel }, admin);
    s.claim({ code: p.code, identity });
    s.startPairing({ humanId: h.id, channel: identity.channel }, admin);
    s.startPairing({ humanId: h.id, channel: identity.channel }, admin);
    assert.throws(() => s.startPairing({ humanId: h.id, channel: identity.channel }, admin), IdentityError);
    advance(3_600_000);
    assert.throws(() => s.confirm({ pairingId: p.pairingId, approve: true }, admin), IdentityError);
    for (let n = 0; n < 10; n++) s.startPairing({ humanId: h.id, channel: `c${n}` }, admin);
    assert.throws(() => s.startPairing({ humanId: h.id, channel: "last" }, admin), IdentityError);
  } finally { s.close(); }
});
it("metadata rebind preview, idempotent apply and receipt-based reversal; no share/embed", async () => {
  const { s, h } = fixture();
  try {
    const l = s.link({ humanId: h.id, identity }, admin);
    let owner = l.v1Principal; let writes = 0;
    const receipts = new Map<string, { count: number; receipt: string }>();
    const engine: MetadataRebindPort = {
      async rebind(p) {
        if (p.dryRun) return { count: owner === p.from ? 1 : 0 };
        if (receipts.has(p.operationId)) return receipts.get(p.operationId)!;
        const count = owner === p.from ? 1 : 0;
        if (count) { owner = p.to; writes++; }
        const result = { count, receipt: p.operationId }; receipts.set(p.operationId, result); return result;
      },
      async reverse(p) { assert.ok(receipts.has(p.receipt)); if (!p.dryRun) { owner = l.v1Principal; writes++; } return { count: 1 }; },
    };
    const backfill = createBackfill({ service: s, engine, clock: () => 1_800_000_000_000 });
    assert.equal((await backfill.run({ linkId: l.id, dryRun: true }, admin)).count, 1);
    assert.equal(writes, 0);
    const report = await backfill.run({ linkId: l.id, dryRun: false }, admin);
    await backfill.run({ linkId: l.id, dryRun: false }, admin);
    assert.equal(writes, 1); assert.equal(owner, deriveUserPrincipal(h.id));
    assert.ok(report.receipt);
    await backfill.reverse({ linkId: l.id, dryRun: false }, admin);
    assert.equal(owner, l.v1Principal); assert.equal(writes, 2);
    assert.throws(() => s.authorizeAction("backfill", h.id, { ...admin, role: "member", user: h.id }), IdentityError);
  } finally { s.close(); }
});
it("source/global locks emit only hashed handles; decline emits link.declined", () => {
  const { s, h, events, advance } = fixture();
  try {
    for (let n = 0; n < 5; n++) assert.throws(() => s.claim({ code: "invalid", identity }), IdentityError);
    assert.throws(() => s.claim({ code: "invalid", identity }), IdentityError);
    assert.ok(JSON.stringify(events).includes("pairing.failed"));
    assert.ok(JSON.stringify(events).includes("pairing.locked"));
    assert.equal(JSON.stringify(events).includes(identity.userId), false);
    advance(15 * 60_000);
    const p = s.startPairing({ humanId: h.id, channel: identity.channel }, admin);
    s.claim({ code: p.code, identity });
    s.confirm({ pairingId: p.pairingId, approve: false }, admin);
    assert.ok(JSON.stringify(events).includes("link.declined"));
  } finally { s.close(); }
});
it("rebind retries after engine success/store interruption with the same durable operation id", async () => {
  const f = fixture();
  const l = f.s.link({ humanId: f.h.id, identity }, admin);
  const operations = new Map<string, { count: number; receipt: string }>();
  let writes = 0; let disconnected = false;
  const engine: MetadataRebindPort = {
    async rebind(p) {
      if (!operations.has(p.operationId)) { writes++; operations.set(p.operationId, { count: 1, receipt: p.operationId }); }
      if (!disconnected) { disconnected = true; throw new Error("synthetic lost response after commit"); }
      return operations.get(p.operationId)!;
    },
    async reverse() { return { count: 1 }; },
  };
  const first = createBackfill({ service: f.s, engine, clock: () => 1 });
  await assert.rejects(first.run({ linkId: l.id, dryRun: false }, admin));
  f.s.close();
  const s = f.open();
  try {
    const resumed = createBackfill({ service: s, engine, clock: () => 2 });
    const r = await resumed.run({ linkId: l.id, dryRun: false }, admin);
    assert.equal(writes, 1); assert.equal(r.count, 1); assert.equal(operations.size, 1);
  } finally { s.close(); }
});
it("store port migration v1 → v2 preserves approved/revoked links, removes pending proofs", () => {
  const { s, h, file, open } = fixture();
  const l = s.link({ humanId: h.id, identity }, admin);
  s.unlink({ linkId: l.id }, admin); s.close();
  // Construct a v1-shaped synthetic database while retaining the link records.
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE backfills; CREATE TABLE pairings(id TEXT, code_hash TEXT); INSERT INTO pairings VALUES ('synthetic-pending','hash'); PRAGMA user_version = 1");
  db.close();
  const migrated = open();
  try {
    assert.equal(migrated.list({ includeRevoked: true }).humans[0]!.identities[0]!.revokedAt !== null, true);
    assert.deepEqual(migrated.list({}).pairings, []);
  } finally { migrated.close(); }
});
it("an injected authorize port cannot permit an agent; custom store port is used", () => {
  const file = join(tempDir("identity-port-"), "identity.sqlite");
  let calls = 0;
  // The real SQLite implementation is still behind an injected opening port.
  const s = createIdentityService({ dbPath: file, clock: () => 1_800_000_000_000,
    audit: () => {}, authorize: { authorize: () => true },
    store: { open(file) { calls++; return openStore(file); } } });
  try {
    assert.equal(calls, 1);
    assert.throws(() => s.createHuman({ displayName: "Synthetic" }, { ...admin, kind: "agent" }), IdentityError);
  } finally { s.close(); }
});
it("global issuance lock cannot be bypassed by new users", () => {
  const { s, events } = fixture();
  try {
    for (let u = 0; u < 10; u++) {
      const h = s.createHuman({ displayName: `Synthetic ${u}` }, admin);
      for (let c = 0; c < 10; c++) s.startPairing({ humanId: h.id, channel: `c${c}` }, admin);
    }
    const newcomer = s.createHuman({ displayName: "Synthetic newcomer" }, admin);
    assert.throws(() => s.startPairing({ humanId: newcomer.id, channel: "new" }, admin), e => e instanceof IdentityError && e.code === "rate-limited");
    assert.ok(JSON.stringify(events).includes("pairing.locked"));
  } finally { s.close(); }
});
it("user claim rate limit spans channels; unknown or corrupt principals fail closed", () => {
  const { s, h } = fixture();
  try {
    for (let n = 0; n < 6; n++) {
      const channel = `c${n}`;
      const p = s.startPairing({ humanId: h.id, channel }, admin);
      const claim = () => s.claim({ code: p.code, identity: { ...identity, channel } });
      if (n < 5) claim(); else assert.throws(claim, e => e instanceof IdentityError && e.code === "rate-limited");
    }
    assert.throws(() => s.resolvePrincipals(deriveUserPrincipal("unknown-user")), IdentityError);
    assert.throws(() => s.resolvePrincipals("user:v2:bad"), IdentityError);
    assert.throws(() => s.resolvePrincipals(`user:v1:${"a".repeat(64)}`), IdentityError);
  } finally { s.close(); }
});
