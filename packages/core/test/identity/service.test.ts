import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createIdentityService, IdentityError, type IdentityService, type Actor } from "../../src/identity/service.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const OWNER: Actor = { user: "owner", host: "box" };
const TG = { channel: "telegram", accountId: "bot1", userId: "4242", displayName: "Alex" };
const DC = { channel: "discord", accountId: "guild1", userId: "9001", displayName: "Alex" };

describe("identity service", () => {
  let dir: string; let now: number; let svc: IdentityService; let audit: Array<{ action: string; target: string; detail: unknown }>;
  const open = () => createIdentityService({ dbPath: join(dir, "identity.sqlite"), clock: () => now, audit: (e) => audit.push(e) });
  beforeEach(() => { dir = tempDir("p1b-identity-"); now = 1_800_000_000_000; audit = []; svc = open(); });
  afterEach(() => { svc.close(); });

  const refusal = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof IdentityError && e.code === code, `expected ${code}`);

  it("pairing happy path: start, claim, owner confirm, link", () => {
    const h = svc.createHuman({ displayName: "Alex" }, OWNER);
    const p = svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    assert.match(p.code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(p.expiresAt, now + 10 * 60_000);
    const c = svc.claim({ code: p.code, identity: TG });
    assert.equal(c.state, "awaiting-confirmation");
    assert.equal(svc.resolve(TG), null, "a claim alone links nothing");
    const done = svc.confirm({ pairingId: p.pairingId, approve: true }, OWNER);
    assert.equal(done.state, "confirmed");
    assert.equal(done.link?.humanId, h.id);
    assert.equal(done.link?.proofMethod, "pairing_code");
    assert.deepEqual(svc.resolve(TG), { humanId: h.id, linkId: done.link!.id });
    assert.equal(svc.linkedV1Principals(h.id).length, 1);
    assert.match(svc.linkedV1Principals(h.id)[0]!, /^user:v1:[a-f0-9]{64}$/);
    assert.deepEqual(audit.map((a) => a.action), ["identity.human.create", "identity.pair.start", "identity.pair.claim", "identity.pair.confirm"]);
  });

  it("an owner can decline a claim: nothing is linked", () => {
    const h = svc.createHuman({ displayName: "Alex" }, OWNER);
    const p = svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    svc.claim({ code: p.code, identity: TG });
    const r = svc.confirm({ pairingId: p.pairingId, approve: false }, OWNER);
    assert.equal(r.state, "declined");
    assert.equal(svc.resolve(TG), null);
  });

  it("expired code is refused", () => {
    const h = svc.createHuman({ displayName: "Alex" }, OWNER);
    const p = svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    now += 10 * 60_000 + 1;
    refusal(() => svc.claim({ code: p.code, identity: TG }), "invalid-code");
    assert.equal(svc.resolve(TG), null);
  });

  it("reused code is refused (single use, consumed at claim)", () => {
    const h = svc.createHuman({ displayName: "Alex" }, OWNER);
    const p = svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    svc.claim({ code: p.code, identity: TG });
    refusal(() => svc.claim({ code: p.code, identity: { ...TG, userId: "999" } }), "invalid-code");
    const done = svc.confirm({ pairingId: p.pairingId, approve: true }, OWNER);
    assert.equal(done.state, "confirmed");
    refusal(() => svc.claim({ code: p.code, identity: TG }), "invalid-code");
    refusal(() => svc.confirm({ pairingId: p.pairingId, approve: true }, OWNER), "conflict");
  });

  it("wrong code and wrong channel are refused with one uniform error", () => {
    const h = svc.createHuman({ displayName: "Alex" }, OWNER);
    const p = svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    const wrong = p.code[0] === "A" ? "B" + p.code.slice(1) : "A" + p.code.slice(1);
    let e1: IdentityError | undefined; let e2: IdentityError | undefined;
    try { svc.claim({ code: wrong, identity: TG }); } catch (e) { e1 = e as IdentityError; }
    try { svc.claim({ code: p.code, identity: DC }); } catch (e) { e2 = e as IdentityError; }
    assert.equal(e1?.code, "invalid-code");
    assert.equal(e2?.code, "invalid-code", "a code for telegram does not work from discord");
    assert.equal(e1?.message, e2?.message);
    assert.equal(svc.resolve(TG), null);
    assert.equal(svc.claim({ code: p.code, identity: TG }).state, "awaiting-confirmation", "the right code still works afterwards");
  });

  it("brute force: five failures lock the source, even for the right code; the lock lapses", () => {
    const h = svc.createHuman({ displayName: "Alex" }, OWNER);
    const p = svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    for (let i = 0; i < 5; i++) refusal(() => svc.claim({ code: "ZZZZZZZZ", identity: TG }), "invalid-code");
    try { svc.claim({ code: p.code, identity: TG }); assert.fail("must be locked"); }
    catch (e) { assert.ok(e instanceof IdentityError); assert.equal(e.code, "rate-limited"); assert.ok(e.retryAfterMs! > 0 && e.retryAfterMs! <= 15 * 60_000); }
    assert.ok(audit.some((a) => a.action === "identity.pair.rate-limited"));
    now += 15 * 60_000 + 1; // the lock lapses (the first code has expired by then, so mint another)
    const p2 = svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    assert.equal(svc.claim({ code: p2.code, identity: TG }).state, "awaiting-confirmation");
  });

  it("brute force: rotating the claimant does not help, the global limit holds", () => {
    const h = svc.createHuman({ displayName: "Alex" }, OWNER);
    const p = svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    for (let i = 0; i < 20; i++) refusal(() => svc.claim({ code: "ZZZZZZZZ", identity: { ...TG, userId: `u${i}` } }), "invalid-code");
    refusal(() => svc.claim({ code: p.code, identity: { ...TG, userId: "fresh" } }), "rate-limited");
  });

  it("the limiter survives a restart (state is in the database, not in memory)", () => {
    const h = svc.createHuman({ displayName: "Alex" }, OWNER);
    const p = svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    for (let i = 0; i < 5; i++) refusal(() => svc.claim({ code: "ZZZZZZZZ", identity: TG }), "invalid-code");
    svc.close(); svc = open();
    refusal(() => svc.claim({ code: p.code, identity: TG }), "rate-limited");
  });

  it("unlink revokes immediately and keeps the record", () => {
    const h = svc.createHuman({ displayName: "Alex" }, OWNER);
    const l = svc.link({ humanId: h.id, identity: TG }, OWNER);
    assert.equal(l.proofMethod, "owner_manual");
    assert.ok(svc.resolve(TG));
    const r = svc.unlink({ linkId: l.id }, OWNER);
    assert.equal(r.revokedAt, now);
    assert.equal(svc.resolve(TG), null);
    assert.deepEqual(svc.linkedV1Principals(h.id), []);
    assert.equal(svc.list({}).humans[0]!.identities.length, 0);
    assert.equal(svc.list({ includeRevoked: true }).humans[0]!.identities.length, 1);
    refusal(() => svc.unlink({ linkId: l.id }, OWNER), "conflict");
    assert.ok(audit.some((a) => a.action === "identity.unlink"));
  });

  it("a claim the owner does not confirm in time lapses", () => {
    const h = svc.createHuman({ displayName: "Alex" }, OWNER);
    const p = svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    svc.claim({ code: p.code, identity: TG });
    now += 10 * 60_000 + 1;
    refusal(() => svc.confirm({ pairingId: p.pairingId, approve: true }, OWNER), "expired");
    assert.equal(svc.resolve(TG), null);
  });

  it("no heuristic link: an identical display name links nothing", () => {
    const a = svc.createHuman({ displayName: "Alex" }, OWNER);
    svc.createHuman({ displayName: "Alex" }, OWNER);
    svc.link({ humanId: a.id, identity: TG }, OWNER);
    assert.equal(svc.resolve(DC), null, "same display name on another channel is a stranger");
    assert.equal(svc.resolve({ ...TG, userId: "other", displayName: "Alex" }), null);
    const p = svc.startPairing({ humanId: a.id, channel: "discord" }, OWNER);
    svc.claim({ code: p.code, identity: DC });
    assert.equal(svc.resolve(DC), null, "even a claimed code links nothing until the owner confirms");
  });

  it("identity exclusivity (N:1): many identities per human, one human per identity", () => {
    const a = svc.createHuman({ displayName: "A" }, OWNER);
    const b = svc.createHuman({ displayName: "B" }, OWNER);
    svc.link({ humanId: a.id, identity: TG }, OWNER);
    svc.link({ humanId: a.id, identity: DC }, OWNER);
    assert.equal(svc.linkedV1Principals(a.id).length, 2);
    refusal(() => svc.link({ humanId: b.id, identity: TG }, OWNER), "conflict");
    refusal(() => svc.link({ humanId: a.id, identity: TG }, OWNER), "conflict");
    // a claim for an identity that is already linked is refused at claim and at confirm
    const p = svc.startPairing({ humanId: b.id, channel: "telegram" }, OWNER);
    refusal(() => svc.claim({ code: p.code, identity: TG }), "conflict");
    // after unlink the identity is free again
    svc.unlink({ linkId: svc.resolve(TG)!.linkId }, OWNER);
    svc.link({ humanId: b.id, identity: TG }, OWNER);
    assert.equal(svc.resolve(TG)!.humanId, b.id);
  });

  it("confirm re-checks exclusivity: an identity linked meanwhile is a conflict", () => {
    const a = svc.createHuman({ displayName: "A" }, OWNER);
    const b = svc.createHuman({ displayName: "B" }, OWNER);
    const p = svc.startPairing({ humanId: a.id, channel: "telegram" }, OWNER);
    svc.claim({ code: p.code, identity: TG });
    svc.link({ humanId: b.id, identity: TG }, OWNER);
    refusal(() => svc.confirm({ pairingId: p.pairingId, approve: true }, OWNER), "conflict");
    assert.equal(svc.resolve(TG)!.humanId, b.id);
  });

  it("at most 3 pending pairings per human and channel", () => {
    const h = svc.createHuman({ displayName: "A" }, OWNER);
    for (let i = 0; i < 3; i++) svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    refusal(() => svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER), "limit");
    svc.startPairing({ humanId: h.id, channel: "discord" }, OWNER);
    now += 10 * 60_000 + 1;
    svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER); // expired ones do not count
  });

  it("validates input and unknown ids", () => {
    refusal(() => svc.createHuman({ displayName: "" }, OWNER), "invalid-params");
    refusal(() => svc.startPairing({ humanId: "nope", channel: "telegram" }, OWNER), "not-found");
    const h = svc.createHuman({ displayName: "A" }, OWNER);
    refusal(() => svc.startPairing({ humanId: h.id, channel: "Tele gram" }, OWNER), "invalid-params");
    refusal(() => svc.link({ humanId: h.id, identity: { ...TG, userId: "a\u0000b" } }, OWNER), "invalid-params");
    refusal(() => svc.claim({ code: "short", identity: TG }), "invalid-code");
    refusal(() => svc.unlink({ linkId: "nope" }, OWNER), "not-found");
    refusal(() => svc.confirm({ pairingId: "nope", approve: true }, OWNER), "not-found");
  });

  it("codes are never persisted or audited: the database holds a salted hash only", () => {
    const h = svc.createHuman({ displayName: "Alex" }, OWNER);
    const p = svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    svc.claim({ code: p.code, identity: TG });
    svc.confirm({ pairingId: p.pairingId, approve: true }, OWNER);
    for (let i = 0; i < 6; i++) { try { svc.claim({ code: "WRONGCODE", identity: DC }); } catch { /* expected */ } }
    assert.equal(JSON.stringify(audit).includes(p.code), false);
    assert.equal(JSON.stringify(audit).includes("WRONGCODE"), false);
    assert.equal(JSON.stringify(svc.list({ includeRevoked: true })).includes(p.code), false);
    svc.close();
    for (const f of readdirSync(dir)) assert.equal(readFileSync(join(dir, f)).includes(p.code), false, `${f} must not contain the code`);
    svc = open();
  });

  it("migrations: a fresh file is version 1, reopening is idempotent, a newer file is refused", () => {
    const file = join(dir, "identity.sqlite");
    assert.ok(existsSync(file));
    svc.createHuman({ displayName: "A" }, OWNER);
    svc.close(); svc = open();
    assert.equal(svc.list({}).humans.length, 1);
    svc.close();
    const raw = new DatabaseSync(file);
    assert.equal((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
    raw.exec("PRAGMA user_version = 99"); raw.close();
    assert.throws(() => open(), (e: unknown) => e instanceof IdentityError && e.code === "storage");
    svc = createIdentityService({ dbPath: join(dir, "other.sqlite"), clock: () => now, audit: () => {} });
  });
});
