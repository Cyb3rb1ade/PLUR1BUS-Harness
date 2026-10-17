// identity pairing (IdentityPort / PairingResult in channels/types.ts; docs/identity.md "Pairing and link lifecycle"):
// a code is single use, expires, is bound to its channel, and a claim only parks until the owner confirms.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createIdentityService, DEFAULT_CODE_TTL_MS, IdentityError, type AuditEvent, type ChannelIdentity } from "../../src/identity/service.ts";
import { ADMIN, MIN, OWNER, refuses, useIdentity } from "./helpers.ts";

const fixture = useIdentity();
const TG: ChannelIdentity = { channel: "telegram", accountId: "bot-a", userId: "1001" };
const HOUR = 60 * MIN;

describe("identity pairing: starting", () => {
  it("issues an 8-symbol code from the unambiguous alphabet, valid for 10 minutes by default", () => {
    const f = fixture(); const h = f.human();
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    assert.match(p.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/); assert.equal(p.channel, "telegram"); assert.equal(p.expiresAt, f.now() + DEFAULT_CODE_TTL_MS); assert.equal(DEFAULT_CODE_TTL_MS, 10 * MIN);
    assert.match(p.pairingId, /^[0-9a-f-]{36}$/);
  });

  it("each code is different, and a person may hold at most three live codes per channel (a fourth is refused as 'limit')", () => {
    const f = fixture(); const h = f.human();
    const codes = [1, 2, 3].map(() => f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER).code);
    assert.equal(new Set(codes).size, 3);
    refuses(() => f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER), "limit");
    assert.ok(f.svc.startPairing({ humanId: h.id, channel: "discord" }, OWNER), "another channel has its own allowance");
  });

  it("an expired code no longer counts against the allowance", () => {
    const f = fixture(); const h = f.human();
    for (let i = 0; i < 3; i++) f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    f.advance(HOUR);
    assert.ok(f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER));
  });

  it("a code that was claimed and confirmed no longer counts against the allowance", () => {
    const f = fixture(); const h = f.human();
    const first = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER); f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    f.svc.confirm({ pairingId: f.svc.claim({ code: first.code, identity: TG }).pairingId, approve: true }, OWNER);
    assert.ok(f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER));
  });

  it("a shorter lifetime may be requested (1 to 60 minutes); anything else is invalid-params on ttlMs", () => {
    const f = fixture(); const h = f.human();
    assert.equal(f.svc.startPairing({ humanId: h.id, channel: "telegram", ttlMs: 10 * MIN }, OWNER).expiresAt, f.now() + 10 * MIN);
    assert.equal(f.svc.startPairing({ humanId: h.id, channel: "discord", ttlMs: MIN }, OWNER).expiresAt, f.now() + MIN);
    for (const bad of [59_999, 0, -1, HOUR + 1, 1.5 * MIN + 0.5, Number.NaN, Number.POSITIVE_INFINITY]) refuses(() => f.svc.startPairing({ humanId: h.id, channel: "slack", ttlMs: bad }, OWNER), "invalid-params", "ttlMs", String(bad));
    assert.equal(f.svc.startPairing({ humanId: h.id, channel: "slack", ttlMs: HOUR }, OWNER).expiresAt, f.now() + HOUR);
  });

  it("a person that does not exist and a channel that is not a channel kind are refused; nothing is issued", () => {
    const f = fixture(); const h = f.human();
    refuses(() => f.svc.startPairing({ humanId: "00000000-0000-7000-8000-000000000000", channel: "telegram" }, OWNER), "not-found");
    for (const ch of ["", "Telegram", "tele gram", "1x"]) refuses(() => f.svc.startPairing({ humanId: h.id, channel: ch }, OWNER), "invalid-params", "channel", ch);
    assert.deepEqual(f.svc.list({}).pairings, []);
  });

  it("the service's own lifetime is configurable only down: zero, negative, NaN or over one hour is refused at construction", () => {
    const f = fixture();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, HOUR + 1]) {
      assert.throws(() => createIdentityService({ dbPath: f.file, clock: () => f.now(), audit: () => {}, codeTtlMs: bad }), (e: unknown) => e instanceof IdentityError && e.code === "invalid-params" && e.field === "codeTtlMs", String(bad));
    }
    const short = createIdentityService({ dbPath: f.file, clock: () => f.now(), audit: () => {}, codeTtlMs: 5 * MIN });
    try {
      const h = short.createHuman({ displayName: "x" }, OWNER);
      assert.equal(short.startPairing({ humanId: h.id, channel: "telegram" }, OWNER).expiresAt, f.now() + 5 * MIN);
      refuses(() => short.startPairing({ humanId: h.id, channel: "telegram", ttlMs: 6 * MIN }, OWNER), "invalid-params", "ttlMs");
    } finally { short.close(); }
  });
});

describe("identity pairing: claiming", () => {
  function started(over: { ttlMs?: number } = {}) {
    const f = fixture(); const h = f.human();
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram", ...over }, OWNER);
    return { f, h, p };
  }

  it("a claim consumes the code at once and answers awaiting-confirmation with a confirm-by time; it links nothing", () => {
    const { f, p } = started();
    f.advance(2 * MIN);
    const c = f.svc.claim({ code: p.code, identity: TG });
    assert.deepEqual(c, { pairingId: p.pairingId, state: "awaiting-confirmation", confirmBy: f.now() + DEFAULT_CODE_TTL_MS });
    assert.equal(f.svc.resolve(TG), null);
    refuses(() => f.svc.claim({ code: p.code, identity: { ...TG, userId: "other" } }), "invalid-code", undefined, "single use");
  });

  it("what a person types is forgiven: lower case, spaces and hyphens", () => {
    for (const mangle of [(c: string) => c.toLowerCase(), (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`, (c: string) => `  ${c.slice(0, 2)} ${c.slice(2, 6)}\t${c.slice(6)}\n`, (c: string) => c.toLowerCase().replace(/(.{4})/, "$1 - ")]) {
      const { f, p } = started();
      assert.equal(f.svc.claim({ code: mangle(p.code), identity: TG }).state, "awaiting-confirmation", mangle(p.code));
    }
  });

  it("anything else stays and simply does not match: other separators, extra characters, a missing character", () => {
    const { f, p } = started();
    for (const bad of [`${p.code.slice(0, 4)}_${p.code.slice(4)}`, `${p.code.slice(0, 4)}.${p.code.slice(4)}`, p.code + "A", p.code.slice(0, 7), "", "        ", p.code.replace(/./, "?")])
      refuses(() => f.svc.claim({ code: bad, identity: { ...TG, userId: `p-${bad.length}-${bad.charCodeAt(0) || 0}` } }), "invalid-code", undefined, JSON.stringify(bad));
    assert.equal(f.svc.claim({ code: p.code, identity: TG }).state, "awaiting-confirmation");
  });

  it("a code that is not a string, or absurdly long, is an ordinary invalid-code, not a crash", () => {
    const { f } = started();
    for (const [i, bad] of [123, null, undefined, {}, [], "x".repeat(129), "A".repeat(100_000)].entries())
      refuses(() => f.svc.claim({ code: bad as never, identity: { ...TG, userId: `c${i}` } }), "invalid-code", undefined, String(i));
  });

  it("an invalid identity in the claim is invalid-params and is not counted as a failed guess", () => {
    const { f, p } = started();
    for (let i = 0; i < 8; i++) refuses(() => f.svc.claim({ code: p.code, identity: { channel: "telegram", accountId: "", userId: "1" } }), "invalid-params", "accountId");
    assert.equal(f.svc.claim({ code: p.code, identity: TG }).state, "awaiting-confirmation");
  });

  it("an expired code is refused with the same error as a wrong one; the boundary is the expiry instant", () => {
    const { f, p } = started({ ttlMs: 10 * MIN });
    f.advance(10 * MIN - 1);
    const early = fixture(); const eh = early.human(); const ep = early.svc.startPairing({ humanId: eh.id, channel: "telegram", ttlMs: 10 * MIN }, OWNER);
    early.advance(10 * MIN - 1);
    assert.equal(early.svc.claim({ code: ep.code, identity: TG }).state, "awaiting-confirmation", "one millisecond before the expiry");
    f.advance(1);
    const msgs = new Set<string>();
    try { f.svc.claim({ code: p.code, identity: TG }); } catch (e) { msgs.add((e as Error).message); assert.equal((e as IdentityError).code, "invalid-code"); }
    try { f.svc.claim({ code: "AAAAAAAA", identity: { ...TG, userId: "x" } }); } catch (e) { msgs.add((e as Error).message); }
    assert.equal(msgs.size, 1, "expired and wrong are indistinguishable to the claimant");
  });

  it("a code issued for one person cannot be used to pair into another person's account: the link goes to the code's person", () => {
    const f = fixture(); const a = f.human("A"); const b = f.human("B");
    const pa = f.svc.startPairing({ humanId: a.id, channel: "telegram" }, OWNER); f.svc.startPairing({ humanId: b.id, channel: "telegram" }, OWNER);
    const link = f.svc.confirm({ pairingId: f.svc.claim({ code: pa.code, identity: TG }).pairingId, approve: true }, OWNER).link!;
    assert.equal(link.humanId, a.id);
  });

  it("pending proofs are not durable: after a restart the code is gone", () => {
    const { f, p } = started();
    const again = f.reopen();
    refuses(() => again.claim({ code: p.code, identity: TG }), "invalid-code");
    assert.deepEqual(again.list({ includeResolvedPairings: true }).pairings, []);
  });
});

describe("identity pairing: confirming", () => {
  function claimed(over: { ttlMs?: number } = {}) {
    const f = fixture(); const h = f.human();
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram", ...over }, OWNER);
    const c = f.svc.claim({ code: p.code, identity: { ...TG, displayName: "Alex" } });
    return { f, h, p, c };
  }

  it("approving links the claimed handle with proof pairing_code, linked by the confirmer", () => {
    const { f, h, c } = claimed();
    const r = f.svc.confirm({ pairingId: c.pairingId, approve: true }, ADMIN);
    assert.equal(r.state, "confirmed"); assert.equal(r.link!.humanId, h.id); assert.equal(r.link!.proofMethod, "pairing_code"); assert.equal(r.link!.linkedBy, ADMIN.user); assert.equal(r.link!.displayName, "Alex");
    assert.deepEqual(f.svc.resolve(TG), { humanId: h.id, linkId: r.link!.id });
  });

  it("declining links nothing, the code stays spent, and the claimant is still unknown", () => {
    const { f, p, c } = claimed();
    const r = f.svc.confirm({ pairingId: c.pairingId, approve: false }, OWNER);
    assert.deepEqual(r, { pairingId: c.pairingId, state: "declined" });
    assert.equal(f.svc.resolve(TG), null);
    refuses(() => f.svc.claim({ code: p.code, identity: TG }), "invalid-code");
  });

  it("only an explicit approve:true approves; anything else declines (fail closed)", () => {
    for (const approve of ["true", 1, "yes", null, undefined, {}]) {
      const { f, c } = claimed();
      assert.equal(f.svc.confirm({ pairingId: c.pairingId, approve: approve as never }, OWNER).state, "declined", String(approve));
      assert.equal(f.svc.resolve(TG), null);
    }
  });

  it("a confirmation happens once: a second one, and a confirmation before any claim, are conflicts", () => {
    const { f, c } = claimed();
    f.svc.confirm({ pairingId: c.pairingId, approve: true }, OWNER);
    refuses(() => f.svc.confirm({ pairingId: c.pairingId, approve: true }, OWNER), "conflict");
    refuses(() => f.svc.confirm({ pairingId: c.pairingId, approve: false }, OWNER), "conflict");
    const h = f.human(); const fresh = f.svc.startPairing({ humanId: h.id, channel: "discord" }, OWNER);
    refuses(() => f.svc.confirm({ pairingId: fresh.pairingId, approve: true }, OWNER), "conflict");
  });

  it("an unknown or malformed pairing id is refused", () => {
    const { f } = claimed();
    refuses(() => f.svc.confirm({ pairingId: "00000000-0000-7000-8000-000000000000", approve: true }, OWNER), "not-found");
    refuses(() => f.svc.confirm({ pairingId: "", approve: true }, OWNER), "invalid-params", "pairingId");
    refuses(() => f.svc.confirm(undefined as never, OWNER), "invalid-params", "pairingId");
  });

  it("the confirmation has its own lifetime after the claim (as long as a full-length code lives, 10 minutes by default): fine one millisecond before, expired at the boundary", () => {
    const a = claimed(); a.f.advance(4 * MIN);
    // a claim made now would have its own 10 minutes; this one was claimed at +0, so its boundary is +10 min
    a.f.advance(6 * MIN - 1);
    assert.equal(a.f.svc.confirm({ pairingId: a.c.pairingId, approve: true }, OWNER).state, "confirmed");
    const b = claimed(); b.f.advance(DEFAULT_CODE_TTL_MS);
    refuses(() => b.f.svc.confirm({ pairingId: b.c.pairingId, approve: true }, OWNER), "expired");
    assert.equal(b.f.svc.resolve(TG), null);
    assert.equal(b.f.svc.list({ includeResolvedPairings: true }).pairings.find((x) => x.id === b.c.pairingId)!.state, "expired");
  });

  it("a claim near the end of a full-length code still gets a full lifetime to be confirmed", () => {
    const f = fixture(); const h = f.human();
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    f.advance(9 * MIN);
    const c = f.svc.claim({ code: p.code, identity: TG });
    assert.equal(c.confirmBy, f.now() + DEFAULT_CODE_TTL_MS);
    f.advance(DEFAULT_CODE_TTL_MS - 1);
    assert.equal(f.svc.confirm({ pairingId: c.pairingId, approve: true }, OWNER).state, "confirmed");
  });

  it("a code with a shorter lifetime cannot be confirmed after that lifetime, even if the claim came late", () => {
    const { f, c, p } = claimed({ ttlMs: 10 * MIN });
    assert.equal(c.confirmBy, p.expiresAt);
    f.advance(10 * MIN);
    refuses(() => f.svc.confirm({ pairingId: c.pairingId, approve: true }, OWNER), "expired");
  });

  it("a person may confirm their own pairing; another member may not", () => {
    const f = fixture(); const a = f.human("A"); const b = f.human("B");
    const p = f.svc.startPairing({ humanId: a.id, channel: "telegram" }, a.self);
    const c = f.svc.claim({ code: p.code, identity: TG });
    refuses(() => f.svc.confirm({ pairingId: c.pairingId, approve: true }, b.self), "denied");
    assert.equal(f.svc.resolve(TG), null);
    assert.equal(f.svc.confirm({ pairingId: c.pairingId, approve: true }, a.self).state, "confirmed");
  });

  it("an agent can never confirm, whatever role it carries", () => {
    const { f, c } = claimed();
    refuses(() => f.svc.confirm({ pairingId: c.pairingId, approve: true }, { user: "agent-1", host: "h", kind: "agent", role: "owner" }), "denied");
    refuses(() => f.svc.confirm({ pairingId: c.pairingId, approve: true }, { user: "x", host: "h", role: "owner" }), "denied", undefined, "no proof of a person");
    assert.equal(f.svc.resolve(TG), null);
  });
});

describe("identity pairing: revoking an invitation", () => {
  it("revokes an unclaimed code: it can no longer be claimed, and it no longer counts against the allowance", () => {
    const f = fixture(); const h = f.human();
    const ps = [1, 2, 3].map(() => f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER));
    f.svc.revokePairing(ps[0]!.pairingId, OWNER);
    refuses(() => f.svc.claim({ code: ps[0]!.code, identity: TG }), "invalid-code");
    assert.ok(f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER));
  });

  it("revokes a claimed proof before confirmation: confirm is then a conflict and nothing is linked", () => {
    const f = fixture(); const h = f.human();
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    const c = f.svc.claim({ code: p.code, identity: TG });
    f.svc.revokePairing(p.pairingId, OWNER);
    refuses(() => f.svc.confirm({ pairingId: c.pairingId, approve: true }, OWNER), "conflict");
    assert.equal(f.svc.resolve(TG), null);
  });

  it("a confirmed pairing cannot be revoked as an invitation (unlink the link instead)", () => {
    const f = fixture(); const h = f.human();
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    f.svc.confirm({ pairingId: f.svc.claim({ code: p.code, identity: TG }).pairingId, approve: true }, OWNER);
    refuses(() => f.svc.revokePairing(p.pairingId, OWNER), "conflict");
    assert.ok(f.svc.resolve(TG));
  });

  it("unknown pairing: not-found; somebody else's pairing: denied", () => {
    const f = fixture(); const a = f.human("A"); const b = f.human("B");
    const p = f.svc.startPairing({ humanId: a.id, channel: "telegram" }, OWNER);
    refuses(() => f.svc.revokePairing("00000000-0000-7000-8000-000000000000", OWNER), "not-found");
    refuses(() => f.svc.revokePairing(p.pairingId, b.self), "denied");
    f.svc.revokePairing(p.pairingId, a.self);
  });
});

describe("identity pairing: what the list shows", () => {
  it("shows live proofs only by default and never a code, a salt or a hash", () => {
    const f = fixture(); const h = f.human();
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    const l = f.svc.list({});
    assert.equal(l.pairings.length, 1); assert.equal(l.pairings[0]!.state, "pending");
    const text = JSON.stringify(l);
    assert.equal(text.includes(p.code), false); assert.equal(/salt|code_hash|codeHash/i.test(text), false);
  });

  it("an expired proof is hidden by default and shown as expired when resolved proofs are requested", () => {
    const f = fixture(); const h = f.human();
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    f.advance(HOUR);
    assert.deepEqual(f.svc.list({}).pairings, []);
    const all = f.svc.list({ includeResolvedPairings: true }).pairings;
    assert.deepEqual(all.map((x) => [x.id, x.state]), [[p.pairingId, "expired"]]);
  });

  it("a claimed proof lists the claimant's handle and its confirm-by time", () => {
    const f = fixture(); const h = f.human();
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    const c = f.svc.claim({ code: p.code, identity: { ...TG, displayName: "Alex" } });
    const [x] = f.svc.list({}).pairings;
    assert.equal(x!.state, "claimed"); assert.equal(x!.confirmBy, c.confirmBy); assert.deepEqual(x!.claimedBy, { channel: "telegram", accountId: TG.accountId, userId: TG.userId, displayName: "Alex" });
  });
});

describe("identity pairing: audit and a failing sink", () => {
  const names = (events: AuditEvent[]) => events.map((e) => e.action);

  it("the flow emits the semantic events alongside the detailed ones: link.requested, link.approved, link.declined, link.removed, pairing.failed, pairing.locked", () => {
    const f = fixture(); const h = f.human();
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    refuses(() => f.svc.claim({ code: "AAAAAAAA", identity: TG }), "invalid-code");
    const c = f.svc.claim({ code: p.code, identity: TG });
    const done = f.svc.confirm({ pairingId: c.pairingId, approve: true }, OWNER);
    f.svc.unlink({ linkId: done.link!.id }, OWNER);
    const p2 = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    f.svc.confirm({ pairingId: f.svc.claim({ code: p2.code, identity: TG }).pairingId, approve: false }, OWNER);
    for (const n of ["link.requested", "pairing.failed", "link.approved", "link.removed", "link.declined", "identity.pair.start", "identity.pair.claim", "identity.pair.confirm", "identity.unlink"]) assert.ok(names(f.events).includes(n), n);
    for (let i = 0; i < 6; i++) { try { f.svc.claim({ code: "BBBBBBBB", identity: { ...TG, userId: "brute" } }); } catch { /* counted */ } }
    assert.ok(names(f.events).includes("pairing.locked"));
  });

  it("no audit event carries a pairing code, a raw handle or a person id in the clear", () => {
    const f = fixture(); const h = f.human("Secretive Name");
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    const id = { channel: "telegram", accountId: "acct-visible-test", userId: "user-visible-test" };
    const c = f.svc.claim({ code: p.code, identity: id });
    f.svc.confirm({ pairingId: c.pairingId, approve: true }, OWNER);
    const text = JSON.stringify(f.events);
    for (const secret of [p.code, "acct-visible-test", "user-visible-test", h.id, p.pairingId, OWNER.user, "Secretive Name"]) assert.equal(text.includes(secret), false, secret);
    assert.ok(text.includes('"channel":"telegram"'), "the channel kind stays readable");
  });

  it("an audit sink that throws never decides an outcome", () => {
    const f = fixture({ audit: () => { throw new Error("sink down"); } }); const h = f.human();
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    const c = f.svc.claim({ code: p.code, identity: TG });
    const done = f.svc.confirm({ pairingId: c.pairingId, approve: true }, OWNER);
    assert.equal(done.state, "confirmed"); assert.ok(f.svc.resolve(TG));
    f.svc.unlink({ linkId: done.link!.id }, OWNER);
    assert.equal(f.svc.resolve(TG), null);
  });
});
