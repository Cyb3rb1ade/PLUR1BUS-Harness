// identity SECURITY: can a channel identity be attributed to somebody else's person by a trick? Every trick is its own
// test. The rule under test (docs/identity.md): an identity is the exact triple (channel kind, accountId, external user id);
// no trimming, case folding or Unicode normalization; display names never establish ownership.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { v1PrincipalOf, type ChannelIdentity } from "../../src/identity/service.ts";
import { OWNER, refuses, useIdentity, type Fixture } from "./helpers.ts";

const fixture = useIdentity();
const BASE: ChannelIdentity = { channel: "telegram", accountId: "bot-a", userId: "Ab1001" };

/** Person A owns `victim`. The attacker presents `trick`: it must resolve to nobody (or only to its own, separate owner), never to A. */
function victimAndTrick(victim: ChannelIdentity = BASE) {
  const f = fixture(); const a = f.human("Victim"); const b = f.human("Attacker");
  const linkA = f.svc.link({ humanId: a.id, identity: victim }, OWNER);
  return { f, a, b, linkA };
}
function assertNoTakeover(ctx: ReturnType<typeof victimAndTrick>, victim: ChannelIdentity, trick: ChannelIdentity) {
  const { f, a, b, linkA } = ctx;
  assert.equal(f.svc.resolve(trick), null, "the lookalike is not recognised as the victim");
  assert.deepEqual(f.svc.resolve(victim), { humanId: a.id, linkId: linkA.id }, "the victim still resolves to the victim");
  // the lookalike is a different identity: it can be linked on its own, and doing so changes nothing for the victim
  const own = f.svc.link({ humanId: b.id, identity: trick }, OWNER);
  assert.deepEqual(f.svc.resolve(trick), { humanId: b.id, linkId: own.id });
  assert.deepEqual(f.svc.resolve(victim), { humanId: a.id, linkId: linkA.id });
  assert.notEqual(v1PrincipalOf(trick), v1PrincipalOf(victim), "and it has its own v1 principal, so recall never mixes the two");
  assert.deepEqual(f.svc.linkedV1Principals(a.id), [v1PrincipalOf(victim)]);
}

describe("identity SECURITY: lookalike handles do not become somebody else's person", () => {
  it("case of the user id: 'Ab1001' is not 'ab1001'", () => { const c = victimAndTrick(); assertNoTakeover(c, BASE, { ...BASE, userId: "ab1001" }); });
  it("case of the user id, upper case variant", () => { const c = victimAndTrick(); assertNoTakeover(c, BASE, { ...BASE, userId: "AB1001" }); });
  it("case of the account id", () => { const c = victimAndTrick(); assertNoTakeover(c, BASE, { ...BASE, accountId: "BOT-A" }); });
  it("case of the channel kind: 'Telegram' cannot even be stored (the kind is lower case), and it resolves to nobody", () => {
    const c = victimAndTrick();
    assert.equal(c.f.svc.resolve({ ...BASE, channel: "Telegram" }), null);
    refuses(() => c.f.svc.link({ humanId: c.b.id, identity: { ...BASE, channel: "Telegram" } }, OWNER), "invalid-params", "channel");
    refuses(() => c.f.svc.link({ humanId: c.b.id, identity: { ...BASE, channel: "TELEGRAM" } }, OWNER), "invalid-params", "channel");
  });
  it("Unicode normalization: NFD 'é' is not NFC 'é'", () => {
    const nfc = { ...BASE, userId: "café" }; const nfd = { ...BASE, userId: "café" };
    assert.notEqual(nfc.userId, nfd.userId);
    assertNoTakeover(victimAndTrick(nfc), nfc, nfd);
  });
  it("Unicode normalization the other way round: a victim stored as NFD is not reachable with NFC", () => {
    const nfc = { ...BASE, userId: "café" }; const nfd = { ...BASE, userId: "café" };
    assertNoTakeover(victimAndTrick(nfd), nfd, nfc);
  });
  it("compatibility forms (NFKC): fullwidth 'Ａ' is not 'A', and the ligature 'ﬁ' is not 'fi'", () => {
    assertNoTakeover(victimAndTrick({ ...BASE, userId: "A1001" }), { ...BASE, userId: "A1001" }, { ...BASE, userId: "Ａ１００１" });
    assertNoTakeover(victimAndTrick({ ...BASE, userId: "fish" }), { ...BASE, userId: "fish" }, { ...BASE, userId: "ﬁsh" });
  });
  it("homoglyphs: a Cyrillic 'а' (U+0430) is not a Latin 'a'", () => {
    assertNoTakeover(victimAndTrick({ ...BASE, userId: "alice" }), { ...BASE, userId: "alice" }, { ...BASE, userId: "аlice" });
  });
  it("leading and trailing whitespace is part of the id, never trimmed", () => {
    const c = victimAndTrick();
    assertNoTakeover(c, BASE, { ...BASE, userId: " Ab1001" });
    const d = victimAndTrick();
    assertNoTakeover(d, BASE, { ...BASE, userId: "Ab1001 " });
  });
  it("an ideographic or no-break space does not stand in for nothing", () => {
    assertNoTakeover(victimAndTrick(), BASE, { ...BASE, userId: "Ab1001 " });
    assertNoTakeover(victimAndTrick(), BASE, { ...BASE, userId: "　Ab1001" });
  });
  it("invisible characters (zero-width space, BOM, right-to-left override) make a different id, not the same one", () => {
    for (const hidden of ["​", "﻿", "‮", "‍"]) {
      assertNoTakeover(victimAndTrick(), BASE, { ...BASE, userId: `Ab${hidden}1001` });
      assertNoTakeover(victimAndTrick(), BASE, { ...BASE, userId: `${hidden}Ab1001` });
    }
  });
  it("control characters cannot be smuggled in to truncate or alias an id: they are refused", () => {
    const c = victimAndTrick();
    for (const ctl of ["\u0000", "\n", "\r", "\t", "\u001b", "\u007f"]) {
      refuses(() => c.f.svc.link({ humanId: c.b.id, identity: { ...BASE, userId: `Ab1001${ctl}tail` } }, OWNER), "invalid-params", "userId", JSON.stringify(ctl));
      refuses(() => c.f.svc.link({ humanId: c.b.id, identity: { ...BASE, accountId: `bot-a${ctl}` } }, OWNER), "invalid-params", "accountId", JSON.stringify(ctl));
    }
    assert.deepEqual(c.f.svc.list({}).humans.find((h) => h.id === c.b.id)!.identities, []);
  });
  it("leading zeros: '007' is not '7' is not '0007'", () => {
    for (const [victim, trick] of [["7", "007"], ["007", "7"], ["007", "0007"], ["0", "00"], ["1001", "01001"]] as const)
      assertNoTakeover(victimAndTrick({ ...BASE, userId: victim }), { ...BASE, userId: victim }, { ...BASE, userId: trick });
  });
  it("numeric spellings of one number are different ids: '7', '7.0', '+7', '7e0', '0x7', ' 7'", () => {
    const spellings = ["7.0", "+7", "7e0", "0x7", " 7", "７"];
    for (const t of spellings) assertNoTakeover(victimAndTrick({ ...BASE, userId: "7" }), { ...BASE, userId: "7" }, { ...BASE, userId: t });
  });
  it("the same sender id on another channel kind is another identity", () => {
    assertNoTakeover(victimAndTrick(), BASE, { ...BASE, channel: "discord" });
    assertNoTakeover(victimAndTrick(), BASE, { ...BASE, channel: "telegram2" });
    assertNoTakeover(victimAndTrick(), BASE, { ...BASE, channel: "telegram.dev" });
  });
  it("the same sender id in another account (another bot, guild, workspace) is another identity", () => {
    assertNoTakeover(victimAndTrick(), BASE, { ...BASE, accountId: "bot-b" });
    assertNoTakeover(victimAndTrick(), BASE, { ...BASE, accountId: "bot-a2" });
    assertNoTakeover(victimAndTrick(), BASE, { ...BASE, accountId: "bot-a " });
  });
  it("a longer id does not alias a shorter one by truncation: 129 characters are refused, not cut to 128", () => {
    const long = "u".repeat(128);
    const c = victimAndTrick({ ...BASE, userId: long });
    refuses(() => c.f.svc.link({ humanId: c.b.id, identity: { ...BASE, userId: long + "x" } }, OWNER), "invalid-params", "userId");
    assert.equal(c.f.svc.resolve({ ...BASE, userId: long + "x" }), null);
    assert.equal(c.f.svc.resolve({ ...BASE, userId: long })!.humanId, c.a.id);
  });
  it("SQL metacharacters and LIKE wildcards in an id are plain data: '%', '_' and a quote trick match nobody", () => {
    const c = victimAndTrick();
    for (const t of ["%", "_", "Ab%", "Ab100_", "' OR '1'='1", "\" OR \"\"=\"", "Ab1001'--", "x'; DROP TABLE identities;--", "*", ".*"]) {
      assert.equal(c.f.svc.resolve({ ...BASE, userId: t }), null, t);
      assert.equal(c.f.svc.resolve({ ...BASE, accountId: t }), null, t);
      assert.equal(c.f.svc.resolve({ ...BASE, channel: t }), null, t);
    }
    assert.equal(c.f.svc.list({}).humans.find((h) => h.id === c.a.id)!.identities.length, 1, "the table is intact");
  });
  it("object-internals names are plain data: '__proto__', 'constructor', 'toString' do not resolve to the victim", () => {
    const c = victimAndTrick();
    for (const t of ["__proto__", "constructor", "toString", "hasOwnProperty"]) assert.equal(c.f.svc.resolve({ ...BASE, userId: t }), null, t);
    assert.equal(({} as Record<string, unknown>).humanId, undefined);
  });
  it("delimiter tricks do not collide in the v1 principal: the triple is hashed as a JSON array, so moving a comma or a quote between fields changes it", () => {
    const triples: ChannelIdentity[] = [
      { channel: "slack", accountId: "T1", userId: "U1" },
      { channel: "slack", accountId: "T1,U1", userId: "x" },
      { channel: "slack", accountId: "T1\",\"U1", userId: "x" },
      { channel: "slack", accountId: "T1", userId: "U1\",\"x" },
      { channel: "slack", accountId: "T1:U1", userId: "x" },
      { channel: "slack", accountId: "T1/U1", userId: "x" },
      { channel: "slack", accountId: "T1", userId: "U1,x" },
      { channel: "slack", accountId: "T1U1", userId: "x" },
    ];
    const principals = triples.map(v1PrincipalOf);
    assert.equal(new Set(principals).size, principals.length);
    const f = fixture(); const h = f.human();
    for (const t of triples) f.svc.link({ humanId: h.id, identity: t }, OWNER);
    assert.equal(new Set(f.svc.linkedV1Principals(h.id)).size, triples.length);
  });
  it("the v1 principal is exactly sha256 of the JSON array of the triple (independent derivation)", () => {
    const t = { channel: "telegram", accountId: "bot-a", userId: "Ab1001" };
    const expected = `user:v1:${createHash("sha256").update('["telegram","bot-a","Ab1001"]', "utf8").digest("hex")}`;
    assert.equal(v1PrincipalOf(t), expected);
  });
  it("a display name equal to the victim's does not attach anything: only the triple counts", () => {
    const f = fixture(); const a = f.human("Alex Victim"); const b = f.human("Alex Victim");
    const la = f.svc.link({ humanId: a.id, identity: { ...BASE, displayName: "Alex Victim" } }, OWNER);
    const spoof = { ...BASE, userId: "other", displayName: "Alex Victim" };
    assert.equal(f.svc.resolve(spoof), null);
    f.svc.link({ humanId: b.id, identity: spoof }, OWNER);
    assert.deepEqual(f.svc.resolve(BASE), { humanId: a.id, linkId: la.id });
    assert.equal(f.svc.resolve(spoof)!.humanId, b.id);
  });
  it("a revoked link is no claim on the handle: after unlink, the lookalike and the original both resolve per the active links only", () => {
    const c = victimAndTrick();
    c.f.svc.unlink({ linkId: c.linkA.id }, OWNER);
    assert.equal(c.f.svc.resolve(BASE), null);
    assert.equal(c.f.svc.resolve({ ...BASE, userId: "ab1001" }), null);
    assert.deepEqual(c.f.svc.linkedV1Principals(c.a.id), []);
  });
  it("the same triple cannot be linked to two people even by racing links: the second is always refused (unique active index)", () => {
    const f = fixture(); const a = f.human("A"); const b = f.human("B");
    f.svc.link({ humanId: a.id, identity: BASE }, OWNER);
    for (let i = 0; i < 5; i++) refuses(() => f.svc.link({ humanId: b.id, identity: BASE }, OWNER), "conflict");
    const db = f.reopen();
    assert.equal(db.list({}).humans.flatMap((h) => h.identities).filter((l) => l.userId === BASE.userId).length, 1);
  });
});

describe("identity SECURITY: pairing cannot attach somebody else's handle", () => {
  function pairing(f: Fixture, humanId: string, channel = "telegram") { return f.svc.startPairing({ humanId, channel }, OWNER); }

  it("a claimed handle that already belongs to another person is refused, and the code stays usable for its rightful claimant", () => {
    const f = fixture(); const a = f.human("A"); const b = f.human("B");
    f.svc.link({ humanId: a.id, identity: BASE }, OWNER);
    const p = pairing(f, b.id);
    for (let i = 0; i < 8; i++) refuses(() => f.svc.claim({ code: p.code, identity: BASE }), "conflict");
    assert.deepEqual(f.svc.resolve(BASE)!.humanId, a.id);
    const mine = { ...BASE, userId: "b-own" };
    const c = f.svc.claim({ code: p.code, identity: mine });
    assert.equal(f.svc.confirm({ pairingId: c.pairingId, approve: true }, OWNER).link!.humanId, b.id);
  });

  it("a claim does not link anything by itself: until the owner confirms, the handle is unknown", () => {
    const f = fixture(); const a = f.human("A");
    const p = pairing(f, a.id);
    f.svc.claim({ code: p.code, identity: BASE });
    assert.equal(f.svc.resolve(BASE), null);
  });

  it("confirm links exactly the triple that was claimed (channel from the pairing, account and user from the claim), not what the confirmer might expect", () => {
    const f = fixture(); const a = f.human("A");
    const p = pairing(f, a.id);
    const claimed: ChannelIdentity = { channel: "telegram", accountId: "bot-z", userId: "z-77", displayName: "Zed" };
    const c = f.svc.claim({ code: p.code, identity: claimed });
    const link = f.svc.confirm({ pairingId: c.pairingId, approve: true }, OWNER).link!;
    assert.deepEqual({ channel: link.channel, accountId: link.accountId, userId: link.userId, proof: link.proofMethod }, { channel: "telegram", accountId: "bot-z", userId: "z-77", proof: "pairing_code" });
    assert.equal(f.svc.resolve({ channel: "telegram", accountId: "bot-z", userId: "z-77" })!.humanId, a.id);
  });

  it("a claim cannot cross channels: a code issued for telegram does not work from discord, even with the same user id", () => {
    const f = fixture(); const a = f.human("A");
    const p = pairing(f, a.id, "telegram");
    refuses(() => f.svc.claim({ code: p.code, identity: { channel: "discord", accountId: "bot-a", userId: "Ab1001" } }), "invalid-code");
    assert.equal(f.svc.resolve({ channel: "discord", accountId: "bot-a", userId: "Ab1001" }), null);
  });

  it("an identity that gets linked to somebody else between claim and confirmation is not taken over by the confirmation", () => {
    const f = fixture(); const a = f.human("A"); const b = f.human("B");
    const p = pairing(f, a.id);
    const c = f.svc.claim({ code: p.code, identity: BASE });
    const theirs = f.svc.link({ humanId: b.id, identity: BASE }, OWNER);
    refuses(() => f.svc.confirm({ pairingId: c.pairingId, approve: true }, OWNER), "conflict");
    assert.deepEqual(f.svc.resolve(BASE), { humanId: b.id, linkId: theirs.id });
    assert.equal(f.svc.linkedV1Principals(a.id).length, 0);
  });

  it("a code typed with look-alike symbols does not match: 0, O, 1, I are not in the alphabet", () => {
    const f = fixture(); const a = f.human("A");
    const p = pairing(f, a.id);
    const swapped = p.code.replace(/[A-Z]/, (ch) => (ch === "O" ? "0" : ch === "I" ? "1" : ch));
    // a code never contains O/0/I/1, so substituting them can only make it a different (invalid) string
    for (const bad of ["O0O0O0O0", "I1I1I1I1", p.code.slice(0, 7) + "0", p.code.slice(0, 7) + "O", swapped + "x"])
      refuses(() => f.svc.claim({ code: bad, identity: { ...BASE, userId: `probe-${bad}` } }), "invalid-code");
    assert.equal(f.svc.claim({ code: p.code, identity: BASE }).state, "awaiting-confirmation");
  });
});
