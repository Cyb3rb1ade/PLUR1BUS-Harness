// The IdentityPort the channel layer sees (channels/types.ts: IdentityPort / PairingResult), as the switchboard builds it
// over the identity service: unknown senders are `{ linked: false }` and reach nothing, a bare code in a message is not a
// claim, and no spelling trick makes a sender somebody else. Driven through the existing switchboard rig (read only).
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NOT_PAIRED_TEXT } from "../../src/channels/router.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { makeRig, type Rig } from "../channels/switchboard-rig.ts";
import { OWNER, gap } from "./helpers.ts";

const TOKEN = "redact-probe-alpha";
const rigs: Rig[] = [];
afterEach(() => { for (const r of rigs.splice(0)) r.close(); });

async function running(o: Parameters<typeof makeRig>[0] = {}): Promise<Rig> {
  const rig = makeRig(o); rigs.push(rig);
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  await rig.clock.advance(0);
  return rig;
}
const sessionsOf = (rig: Rig, humanId: string) => rig.store.listSessions({ owner: deriveUserPrincipal(humanId), kind: "channel" }).sessions.length;

describe("identity port: unknown senders", () => {
  it("an unknown sender is not linked: no session, no turn, and the fixed pairing notice", async () => {
    const rig = await running(); const a = rig.adapter();
    await a.inbound({ senderId: "nobody" });
    assert.equal(rig.provider.requests.length, 0);
    assert.deepEqual(a.sent.map((m) => m.text), [NOT_PAIRED_TEXT]);
  });

  it("the notice says nothing about people, links or codes that exist", async () => {
    const rig = await running(); rig.link("discord", "bot-1", "sender-1", "Some Real Name"); const a = rig.adapter();
    await a.inbound({ senderId: "someone-else" });
    const text = a.sent.map((m) => m.text).join("\n");
    assert.equal(text.includes("Some Real Name") || text.includes("sender-1") || text.includes("bot-1"), false);
  });

  it("a bare pairing code in a direct message is not a claim: the sender stays unknown and the code stays pending (characterization: Ist-Verhalten, nicht spezifiziert; the switchboard's claimPairing always answers ok:false and says pairing happens in the adapters)", async () => {
    const rig = await running(); const a = rig.adapter();
    const h = rig.identity.createHuman({ displayName: "Pat" }, OWNER);
    const p = rig.identity.startPairing({ humanId: h.id, channel: "discord" }, OWNER);
    for (const text of [p.code, p.code.toLowerCase(), ` ${p.code} `]) await a.inbound({ senderId: "stranger", text });
    assert.equal(rig.provider.requests.length, 0);
    assert.ok(a.sent.every((m) => m.text === NOT_PAIRED_TEXT), "only the pairing notice, never a 'claimed' reply");
    const [waiting] = rig.identity.list({}).pairings;
    assert.equal(waiting!.state, "pending");
    assert.equal(rig.identity.resolve({ channel: "discord", accountId: "bot-1", userId: "stranger" }), null);
    assert.equal(rig.identity.claim({ code: p.code, identity: { channel: "discord", accountId: "bot-1", userId: "stranger" } }).state, "awaiting-confirmation", "the code was not burnt by the message");
  });

  it("a code posted in a group chat gets silence and links nothing", async () => {
    const rig = await running(); const a = rig.adapter();
    const h = rig.identity.createHuman({ displayName: "Pat" }, OWNER);
    const p = rig.identity.startPairing({ humanId: h.id, channel: "discord" }, OWNER);
    await a.inbound({ senderId: "stranger", chatKind: "group", text: p.code });
    assert.deepEqual(a.sent, []); assert.equal(rig.provider.requests.length, 0);
    assert.equal(rig.identity.list({}).pairings[0]!.state, "pending");
  });

  it("the full road: unknown, then claimed (still unknown), then confirmed (known); declined stays unknown", async () => {
    const rig = await running(); const a = rig.adapter();
    const h = rig.identity.createHuman({ displayName: "Pat" }, OWNER);
    const who = { channel: "discord", accountId: "bot-1", userId: "newbie" };
    const p = rig.identity.startPairing({ humanId: h.id, channel: "discord" }, OWNER);
    await a.inbound({ senderId: "newbie" }); assert.equal(rig.provider.requests.length, 0, "unknown");
    const c = rig.identity.claim({ code: p.code, identity: who });
    await a.inbound({ senderId: "newbie" }); assert.equal(rig.provider.requests.length, 0, "claimed is not linked");
    rig.identity.confirm({ pairingId: c.pairingId, approve: true }, OWNER);
    await a.inbound({ senderId: "newbie" }); assert.equal(rig.provider.requests.length, 1, "linked");
    assert.equal(sessionsOf(rig, h.id), 1);

    const p2 = rig.identity.startPairing({ humanId: h.id, channel: "discord" }, OWNER);
    const c2 = rig.identity.claim({ code: p2.code, identity: { ...who, userId: "declined-one" } });
    rig.identity.confirm({ pairingId: c2.pairingId, approve: false }, OWNER);
    await a.inbound({ senderId: "declined-one" }); assert.equal(rig.provider.requests.length, 1);
  });
});

describe("identity port: no sender becomes somebody else", () => {
  it("case matters: a handle linked as 'Sender-A' is nobody when it arrives as 'sender-a' or 'SENDER-A'", async () => {
    const rig = await running(); rig.link("discord", "bot-1", "Sender-A"); const a = rig.adapter();
    for (const s of ["sender-a", "SENDER-A", "sender-A"]) await a.inbound({ senderId: s });
    assert.equal(rig.provider.requests.length, 0);
    await a.inbound({ senderId: "Sender-A" }); assert.equal(rig.provider.requests.length, 1);
  });

  it("leading zeros matter: '0123' is not '123'", async () => {
    const rig = await running(); rig.link("discord", "bot-1", "0123"); const a = rig.adapter();
    for (const s of ["123", "00123", "0123 ", "+0123"]) await a.inbound({ senderId: s });
    assert.equal(rig.provider.requests.length, 0);
    await a.inbound({ senderId: "0123" }); assert.equal(rig.provider.requests.length, 1);
  });

  it("Unicode forms matter: precomposed and decomposed spellings are different handles", async () => {
    const rig = await running(); rig.link("discord", "bot-1", "café"); const a = rig.adapter();
    await a.inbound({ senderId: "café" }); await a.inbound({ senderId: "cafÉ" });
    assert.equal(rig.provider.requests.length, 0);
    await a.inbound({ senderId: "café" }); assert.equal(rig.provider.requests.length, 1);
  });

  it("padding matters: a trailing space, a newline or a zero-width character does not reach the linked person", async () => {
    const rig = await running(); rig.link("discord", "bot-1", "sender-1"); const a = rig.adapter();
    for (const s of ["sender-1 ", " sender-1", "sender-1\n", "sender-1​", "sender‐1"]) await a.inbound({ senderId: s });
    assert.equal(rig.provider.requests.length, 0);
  });

  it("the same id on another channel is nobody: a telegram link does not answer on discord", async () => {
    const rig = await running(); rig.link("telegram", "bot-1", "sender-1"); const a = rig.adapter();
    await a.inbound({ senderId: "sender-1" });
    assert.equal(rig.provider.requests.length, 0);
  });

  it("the same id on another account is nobody when the adapter names its account", async () => {
    const rig = await running(); rig.link("discord", "bot-1", "sender-1"); const a = rig.adapter();
    await a.inbound({ senderId: "sender-1", accountId: "bot-2" }); await a.inbound({ senderId: "sender-1", accountId: "BOT-1" });
    assert.equal(rig.provider.requests.length, 0);
    await a.inbound({ senderId: "sender-1", accountId: "bot-1" }); assert.equal(rig.provider.requests.length, 1);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: an adapter that does not name its account is matched on the handle alone, whatever account the link was made under", async () => {
    const rig = await running(); const { humanId } = rig.link("discord", "some-other-bot", "sender-1"); const a = rig.adapter();
    await a.inbound({ senderId: "sender-1" });
    assert.equal(rig.provider.requests.length, 1); assert.equal(sessionsOf(rig, humanId), 1);
  });

  it("an account-less handle linked to one person under two accounts is still that one person", async () => {
    const rig = await running(); const a = rig.adapter();
    const h = rig.identity.createHuman({ displayName: "Pat" }, OWNER);
    for (const acct of ["bot-1", "bot-2"]) rig.identity.link({ humanId: h.id, identity: { channel: "discord", accountId: acct, userId: "sender-1" } }, OWNER);
    await a.inbound({ senderId: "sender-1" });
    assert.equal(sessionsOf(rig, h.id), 1);
  });

  it("an account-less handle claimed by two people under different accounts is nobody, and stays nobody until one link is gone", async () => {
    const rig = await running(); const a = rig.adapter();
    const one = rig.link("discord", "bot-1", "sender-1", "One"); const two = rig.link("discord", "bot-2", "sender-1", "Two");
    await a.inbound({ senderId: "sender-1" });
    assert.equal(rig.provider.requests.length, 0);
    const list = rig.identity.list({}).humans.find((h) => h.id === two.humanId)!;
    rig.identity.unlink({ linkId: list.identities[0]!.id }, OWNER);
    await a.inbound({ senderId: "sender-1" });
    assert.equal(sessionsOf(rig, one.humanId), 1); assert.equal(sessionsOf(rig, two.humanId), 0);
  });

  it("a revoked link is not counted when picking the person: its successor answers", async () => {
    const rig = await running(); const a = rig.adapter();
    const old = rig.link("discord", "bot-1", "sender-1", "Old");
    const oldLink = rig.identity.list({}).humans.find((h) => h.id === old.humanId)!.identities[0]!;
    rig.identity.unlink({ linkId: oldLink.id }, OWNER);
    const next = rig.link("discord", "bot-1", "sender-1", "New");
    await a.inbound({ senderId: "sender-1" });
    assert.equal(sessionsOf(rig, next.humanId), 1); assert.equal(sessionsOf(rig, old.humanId), 0);
  });

  it("a configured account is part of the identity and an adapter-supplied account cannot be swapped for the configured one by the sender (matrix)", async () => {
    const rig = makeRig({ ids: ["matrix"] }); rigs.push(rig);
    rig.secrets.put("channels.matrix.access-token", "redact-probe-beta");
    rig.config.set("matrix", { enabled: true, homeserverUrl: "https://matrix.example.org", userId: "@bot:example.org" });
    rig.link("matrix", "@bot:example.org", "@pat:example.org");
    await rig.switchboard.start(); await rig.clock.advance(0);
    const a = rig.adapter("matrix");
    await a.inbound({ senderId: "@pat:example.org", accountId: "@evil-bot:example.org" });
    assert.equal(rig.provider.requests.length, 0, "an explicit other account wins over the configured one and does not resolve");
    await a.inbound({ senderId: "@pat:example.org" });
    assert.equal(rig.provider.requests.length, 1);
    await a.inbound({ senderId: "@PAT:example.org" });
    assert.equal(rig.provider.requests.length, 1);
  });

  it("unlinking a handle stops the conversation at once: the next message from it reaches no agent", async () => {
    const rig = await running(); const a = rig.adapter();
    const first = rig.link("discord", "bot-1", "sender-1", "First");
    await a.inbound({ senderId: "sender-1" });
    assert.equal(rig.provider.requests.length, 1);
    const link = rig.identity.list({}).humans.find((h) => h.id === first.humanId)!.identities[0]!;
    rig.identity.unlink({ linkId: link.id }, OWNER);
    await a.inbound({ senderId: "sender-1" });
    assert.equal(rig.provider.requests.length, 1);
  });

  const relinkTitle = gap("switchboard session port (findActive/submit)",
    "after a handle is unlinked from A and linked to B, B's turn does not carry A's private conversation (sessions are owned by a person; the store 'never decides who may see a session' and callers must get not-found for someone else's)",
    "the chat's active session is found by chat key alone, so B's turn runs in A's session and the model prompt contains A's earlier message and reply");
  it(relinkTitle, { todo: relinkTitle }, async () => {
    const rig = await running(); const a = rig.adapter();
    const first = rig.link("discord", "bot-1", "sender-1", "First");
    await a.inbound({ senderId: "sender-1", text: "probe-private-alpha" });
    const link = rig.identity.list({}).humans.find((h) => h.id === first.humanId)!.identities[0]!;
    rig.identity.unlink({ linkId: link.id }, OWNER);
    const second = rig.link("discord", "bot-1", "sender-1", "Second");
    await a.inbound({ senderId: "sender-1", text: "second person speaking" });
    const seen = rig.provider.requests.at(-1)!.messages.map((m) => m.text).join("\n");
    assert.equal(seen.includes("probe-private-alpha"), false, "B's prompt must not contain A's message");
    assert.equal(sessionsOf(rig, second.humanId), 1, "B talks in a session B owns");
  });
});

describe("identity port: failing closed", () => {
  const broken = (): never => { throw new Error("identity store down"); };

  it("if the identity service throws while resolving, the sender is nobody: no turn, no reply, the failure is logged", async () => {
    for (const accountId of [undefined, "bot-1"]) {
      const rig = await running({ switchboard: { identity: () => ({ resolve: broken, list: broken }) as never } }); const a = rig.adapter();
      await a.inbound({ senderId: "sender-1", ...(accountId ? { accountId } : {}) });
      assert.equal(rig.provider.requests.length, 0, String(accountId)); assert.deepEqual(a.sent, [], String(accountId));
      assert.ok(rig.logs.some((l) => l.level === "error" && l.msg === "channel.identity.failed"), String(accountId));
    }
  });

  it("without an identity service everybody is unknown", async () => {
    const rig = await running({ switchboard: { identity: () => null } }); const a = rig.adapter();
    await a.inbound({ senderId: "sender-1" });
    assert.equal(rig.provider.requests.length, 0);
  });
});
