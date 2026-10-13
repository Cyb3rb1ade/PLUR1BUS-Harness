// identity: linking and unlinking channel identities with people (ADR-007 Q4, docs/identity.md): the owner's manual link,
// double links, an identity that already belongs to somebody else (refused, never taken over), unlink and relink, resolve.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { v1PrincipalOf, type ChannelIdentity } from "../../src/identity/service.ts";
import { ADMIN, MIN, OWNER, refuses, useIdentity } from "./helpers.ts";

const fixture = useIdentity();
const TG: ChannelIdentity = { channel: "telegram", accountId: "bot-a", userId: "1001" };
const DC: ChannelIdentity = { channel: "discord", accountId: "guild-a", userId: "1001" };

describe("identity link", () => {
  it("an owner link is immediate: proof owner_manual, linked by the actor, active, v1 principal derived from the triple", () => {
    const f = fixture(); const h = f.human();
    const l = f.svc.link({ humanId: h.id, identity: { ...TG, displayName: "Alex" } }, OWNER);
    assert.equal(l.humanId, h.id); assert.equal(l.proofMethod, "owner_manual"); assert.equal(l.linkedBy, OWNER.user); assert.equal(l.linkedAt, f.now());
    assert.equal(l.revokedAt, null); assert.equal(l.revokedBy, null); assert.equal(l.displayName, "Alex");
    assert.equal(l.v1Principal, v1PrincipalOf(TG)); assert.match(l.v1Principal, /^user:v1:[0-9a-f]{64}$/);
    assert.deepEqual(f.svc.resolve(TG), { humanId: h.id, linkId: l.id });
  });

  it("a link needs no display name, and a display name is never part of the identity", () => {
    const f = fixture(); const h = f.human();
    const l = f.svc.link({ humanId: h.id, identity: TG }, OWNER);
    assert.equal("displayName" in l, false);
    assert.deepEqual(f.svc.resolve({ ...TG, displayName: "Somebody Else" }), { humanId: h.id, linkId: l.id });
  });

  it("many identities may belong to one person (N:1), across channels and accounts", () => {
    const f = fixture(); const h = f.human();
    const ids = [TG, DC, { ...TG, accountId: "bot-b" }, { ...TG, userId: "1002" }];
    for (const i of ids) f.svc.link({ humanId: h.id, identity: i }, OWNER);
    assert.equal(f.svc.list({}).humans[0]!.identities.length, 4);
    assert.equal(new Set(f.svc.linkedV1Principals(h.id)).size, 4);
  });

  it("linking the same identity to the same person twice is a conflict, and leaves exactly one active link", () => {
    const f = fixture(); const h = f.human();
    const first = f.svc.link({ humanId: h.id, identity: TG }, OWNER);
    refuses(() => f.svc.link({ humanId: h.id, identity: TG }, OWNER), "conflict");
    const links = f.svc.list({ includeRevoked: true }).humans[0]!.identities;
    assert.deepEqual(links.map((l) => l.id), [first.id]);
  });

  it("an identity that already belongs to another person is refused; nothing is taken over and the owner keeps resolving", () => {
    const f = fixture(); const a = f.human("A"); const b = f.human("B");
    const mine = f.svc.link({ humanId: a.id, identity: TG }, OWNER);
    refuses(() => f.svc.link({ humanId: b.id, identity: TG }, OWNER), "conflict");
    refuses(() => f.svc.link({ humanId: b.id, identity: { ...TG, displayName: "A" } }, ADMIN), "conflict");
    assert.deepEqual(f.svc.resolve(TG), { humanId: a.id, linkId: mine.id });
    const all = f.svc.list({ includeRevoked: true }).humans;
    assert.equal(all.find((h) => h.id === a.id)!.identities.length, 1); assert.equal(all.find((h) => h.id === b.id)!.identities.length, 0);
    assert.deepEqual(f.svc.getLink(mine.id), mine, "the original link record is untouched");
  });

  it("the refusal says what to do (unlink first) and names no other person", () => {
    const f = fixture(); const a = f.human("Alice Example"); const b = f.human("B");
    f.svc.link({ humanId: a.id, identity: TG }, OWNER);
    assert.throws(() => f.svc.link({ humanId: b.id, identity: TG }, OWNER), (e: Error) => /unlink it first/.test(e.message) && !/Alice/.test(e.message) && !e.message.includes(a.id));
  });

  it("an unknown person is not-found; nothing is linked", () => {
    const f = fixture();
    refuses(() => f.svc.link({ humanId: "00000000-0000-7000-8000-000000000000", identity: TG }, OWNER), "not-found");
    assert.equal(f.svc.resolve(TG), null);
  });

  it("an invalid person id is invalid-params on humanId", () => {
    const f = fixture();
    for (const bad of ["", "x".repeat(65), "a\nb"]) refuses(() => f.svc.link({ humanId: bad, identity: TG }, OWNER), "invalid-params", "humanId", JSON.stringify(bad));
  });

  const badIdentities: [string, unknown, string][] = [
    ["missing identity", undefined, "channel"],
    ["channel with capitals", { ...TG, channel: "Telegram" }, "channel"],
    ["channel starting with a digit", { ...TG, channel: "9chat" }, "channel"],
    ["channel with a space", { ...TG, channel: "tele gram" }, "channel"],
    ["channel of 33 characters", { ...TG, channel: "a".repeat(33) }, "channel"],
    ["empty channel", { ...TG, channel: "" }, "channel"],
    ["empty account", { ...TG, accountId: "" }, "accountId"],
    ["missing account", { channel: "telegram", userId: "1" }, "accountId"],
    ["numeric account", { ...TG, accountId: 5 }, "accountId"],
    ["empty user", { ...TG, userId: "" }, "userId"],
    ["missing user", { channel: "telegram", accountId: "a" }, "userId"],
    ["user of 129 characters", { ...TG, userId: "u".repeat(129) }, "userId"],
    ["user with a newline", { ...TG, userId: "u\n1" }, "userId"],
    ["user with a NUL", { ...TG, userId: "u\u00001" }, "userId"],
    ["user with DEL", { ...TG, userId: "u\u007f1" }, "userId"],
    ["account with a tab", { ...TG, accountId: "a\tb" }, "accountId"],
    ["display name over 128 characters", { ...TG, displayName: "n".repeat(129) }, "displayName"],
    ["empty display name", { ...TG, displayName: "" }, "displayName"],
  ];
  for (const [name, identity, field] of badIdentities) {
    it(`an incomplete or malformed triple is rejected: ${name}`, () => {
      const f = fixture(); const h = f.human();
      refuses(() => f.svc.link({ humanId: h.id, identity: identity as ChannelIdentity }, OWNER), "invalid-params", field);
      assert.deepEqual(f.svc.list({ includeRevoked: true }).humans[0]!.identities, []);
    });
  }

  it("the 128-character limit is inclusive on the userId", () => {
    const f = fixture(); const h = f.human();
    assert.ok(f.svc.link({ humanId: h.id, identity: { ...TG, userId: "u".repeat(128) } }, OWNER));
  });
});

describe("identity unlink and relink", () => {
  it("unlink revokes at once, keeps the record for the audit trail, and the handle resolves to nobody", () => {
    const f = fixture(); const h = f.human(); const l = f.svc.link({ humanId: h.id, identity: TG }, OWNER);
    f.advance(5 * MIN);
    const u = f.svc.unlink({ linkId: l.id }, ADMIN);
    assert.equal(u.revokedAt, f.now()); assert.equal(u.revokedBy, ADMIN.user); assert.equal(u.id, l.id);
    assert.equal(f.svc.resolve(TG), null);
    assert.deepEqual(f.svc.list({}).humans[0]!.identities, [], "hidden by default");
    assert.deepEqual(f.svc.list({ includeRevoked: true }).humans[0]!.identities.map((x) => x.id), [l.id], "but never deleted");
    assert.deepEqual(f.svc.linkedV1Principals(h.id), []);
  });

  it("unlinking twice and unlinking an unknown or malformed id are refused", () => {
    const f = fixture(); const h = f.human(); const l = f.svc.link({ humanId: h.id, identity: TG }, OWNER);
    f.svc.unlink({ linkId: l.id }, OWNER);
    refuses(() => f.svc.unlink({ linkId: l.id }, OWNER), "conflict");
    refuses(() => f.svc.unlink({ linkId: "00000000-0000-7000-8000-000000000000" }, OWNER), "not-found");
    refuses(() => f.svc.unlink({ linkId: "" }, OWNER), "invalid-params", "linkId");
    refuses(() => f.svc.unlink({ linkId: "x".repeat(65) }, OWNER), "invalid-params", "linkId");
    assert.equal(f.svc.getLink(l.id).revokedBy, OWNER.user, "the first revocation stands");
  });

  it("after an explicit unlink the identity can belong to another person; the old record stays revoked and the old owner no longer resolves", () => {
    const f = fixture(); const a = f.human("A"); const b = f.human("B");
    const first = f.svc.link({ humanId: a.id, identity: TG }, OWNER);
    f.svc.unlink({ linkId: first.id }, OWNER);
    const second = f.svc.link({ humanId: b.id, identity: TG }, OWNER);
    assert.deepEqual(f.svc.resolve(TG), { humanId: b.id, linkId: second.id });
    assert.notEqual(second.id, first.id);
    assert.equal(f.svc.getLink(first.id).revokedAt !== null, true); assert.equal(f.svc.getLink(first.id).humanId, a.id);
    assert.deepEqual(f.svc.linkedV1Principals(a.id), []);
    assert.deepEqual(f.svc.linkedV1Principals(b.id), [second.v1Principal]);
  });

  it("relinking to the same person creates a new link record (history is kept) with the same v1 principal", () => {
    const f = fixture(); const h = f.human();
    const first = f.svc.link({ humanId: h.id, identity: TG }, OWNER); f.svc.unlink({ linkId: first.id }, OWNER);
    f.advance(1000);
    const again = f.svc.link({ humanId: h.id, identity: TG }, OWNER);
    assert.notEqual(again.id, first.id); assert.equal(again.v1Principal, first.v1Principal);
    assert.equal(f.svc.list({ includeRevoked: true }).humans[0]!.identities.length, 2);
    assert.deepEqual(f.svc.resolve(TG), { humanId: h.id, linkId: again.id });
  });

  it("unlinking one identity leaves the person's other identities in place", () => {
    const f = fixture(); const h = f.human();
    const a = f.svc.link({ humanId: h.id, identity: TG }, OWNER); f.svc.link({ humanId: h.id, identity: DC }, OWNER);
    f.svc.unlink({ linkId: a.id }, OWNER);
    assert.equal(f.svc.resolve(TG), null); assert.equal(f.svc.resolve(DC)!.humanId, h.id);
  });

  it("a person may unlink their own identity, and may not unlink somebody else's", () => {
    const f = fixture(); const a = f.human("A"); const b = f.human("B");
    const la = f.svc.link({ humanId: a.id, identity: TG }, OWNER); const lb = f.svc.link({ humanId: b.id, identity: DC }, OWNER);
    refuses(() => f.svc.unlink({ linkId: lb.id }, a.self), "denied");
    assert.equal(f.svc.getLink(lb.id).revokedAt, null);
    f.svc.unlink({ linkId: la.id }, a.self);
    assert.equal(f.svc.resolve(TG), null);
  });

  it("an identity linked and unlinked survives a restart as revoked", () => {
    const f = fixture(); const h = f.human(); const l = f.svc.link({ humanId: h.id, identity: TG }, OWNER); f.svc.unlink({ linkId: l.id }, OWNER);
    const again = f.reopen();
    assert.equal(again.resolve(TG), null); assert.equal(again.getLink(l.id).revokedBy, OWNER.user);
  });
});

describe("identity resolve", () => {
  it("an unknown sender resolves to nobody (null); the channel layer reports that as { linked: false }", () => {
    const f = fixture(); f.human();
    assert.equal(f.svc.resolve(TG), null);
  });

  it("only an exact active link resolves: a person with other links does not make a stranger known", () => {
    const f = fixture(); const h = f.human(); f.svc.link({ humanId: h.id, identity: TG }, OWNER);
    for (const other of [{ ...TG, userId: "1002" }, { ...TG, accountId: "bot-b" }, { ...TG, channel: "discord" }]) assert.equal(f.svc.resolve(other), null, JSON.stringify(other));
  });

  it("a display name alone never links: two people with the same display name stay separate and unlinked senders stay unknown", () => {
    const f = fixture(); const a = f.human("Alex"); f.human("Alex");
    f.svc.link({ humanId: a.id, identity: { ...TG, displayName: "Alex" } }, OWNER);
    assert.equal(f.svc.resolve({ ...DC, displayName: "Alex" }), null);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: an incomplete triple makes resolve throw a TypeError (not an IdentityError); it never answers with a person", () => {
    const f = fixture(); const h = f.human(); f.svc.link({ humanId: h.id, identity: TG }, OWNER);
    for (const bad of [{ channel: "telegram", userId: "1001" }, { accountId: "bot-a", userId: "1001" }, null, undefined]) {
      assert.throws(() => f.svc.resolve(bad as never), (e: unknown) => e instanceof TypeError, JSON.stringify(bad));
    }
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: a non-string userId is simply not found (no throw)", () => {
    const f = fixture(); const h = f.human(); f.svc.link({ humanId: h.id, identity: TG }, OWNER);
    assert.equal(f.svc.resolve({ ...TG, userId: 1001 as never }), null);
  });
});

describe("identity list", () => {
  it("lists people by creation time and their active identities by link time", () => {
    const f = fixture(); const a = f.human("A"); f.advance(10); const b = f.human("B"); f.advance(10);
    f.svc.link({ humanId: b.id, identity: TG }, OWNER); f.advance(10); f.svc.link({ humanId: b.id, identity: DC }, OWNER);
    const l = f.svc.list({});
    assert.deepEqual(l.humans.map((h) => h.id), [a.id, b.id]);
    assert.deepEqual(l.humans[1]!.identities.map((i) => i.channel), ["telegram", "discord"]);
    assert.deepEqual(l.humans[0]!.identities, []);
  });

  it("an empty store lists nothing, with or without options", () => {
    const f = fixture();
    assert.deepEqual(f.svc.list({}), { humans: [], pairings: [] });
    assert.deepEqual(f.svc.list(undefined as never), { humans: [], pairings: [] });
  });
});

describe("identity createHuman", () => {
  it("creates a person with an opaque UUIDv7 id and the given name, audited", () => {
    const f = fixture();
    const h = f.svc.createHuman({ displayName: "Alex" }, OWNER);
    assert.match(h.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(h.displayName, "Alex"); assert.equal(h.createdAt, f.now());
    assert.ok(f.events.some((e) => e.action === "identity.human.create"));
  });
  it("two people with the same name get different ids; a name is not an identifier", () => {
    const f = fixture();
    assert.notEqual(f.svc.createHuman({ displayName: "Alex" }, OWNER).id, f.svc.createHuman({ displayName: "Alex" }, OWNER).id);
  });
  it("an empty, overlong or control-character name is refused", () => {
    const f = fixture();
    for (const name of ["", "n".repeat(129), "a\nb"]) refuses(() => f.svc.createHuman({ displayName: name }, OWNER), "invalid-params", "displayName", JSON.stringify(name));
    assert.deepEqual(f.svc.list({}).humans, []);
  });
});
