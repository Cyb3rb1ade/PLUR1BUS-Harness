import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ALICE, BOT, CAROL, DM, FakeMatrix, OTHER, ROOM, textMessage } from "./helpers/fake-matrix.ts";
import { Rig, newFake } from "./helpers/rig.ts";
import type { MatrixConfig } from "../src/index.ts";
import type { MatrixChannelOptions } from "../src/index.ts";

const open: { fake: FakeMatrix; rig: Rig }[] = [];
afterEach(async () => {
  for (const { rig, fake } of open.splice(0)) {
    await rig.close().catch(() => {});
    await fake.close().catch(() => {});
  }
});

async function setup(over: Partial<MatrixChannelOptions> = {}, fakeSetup?: (f: FakeMatrix) => void): Promise<Rig> {
  const fake = await newFake();
  fake.addRoom(DM, { members: 2 });
  fake.direct = { [ALICE]: [DM] };
  fakeSetup?.(fake);
  const rig = new Rig(fake, over);
  rig.onMessage();
  open.push({ fake, rig });
  await rig.start();
  return rig;
}

const mention = { "m.mentions": { user_ids: [BOT] } };

// ----------------------------------------------------------------- policies (table-driven)

type Case = [name: string, room: string, sender: string, content: Record<string, unknown>, over: Partial<MatrixConfig>, delivered: boolean];
const policyCases: Case[] = [
  ["group, mention policy, unaddressed is dropped", ROOM, CAROL, textMessage("hello all"), {}, false],
  ["group, mention policy, m.mentions names the bot", ROOM, CAROL, textMessage(`${BOT} ping`, mention), {}, true],
  ["group, legacy event (no m.mentions) mentioning the bot by mxid", ROOM, CAROL, textMessage(`hey ${BOT} you there`), {}, true],
  ["group, legacy mention must match at a word boundary", ROOM, CAROL, textMessage("hey bot2:hs.test"), {}, false],
  ["group, m.mentions without the bot is not a mention even if the body names it", ROOM, CAROL, textMessage(`${BOT}`, { "m.mentions": { user_ids: [CAROL] } }), {}, false],
  ["group, always policy delivers unaddressed messages", ROOM, CAROL, textMessage("hello all"), { replyPolicy: "always" }, true],
  ["group, allowlist policy hears listed members unaddressed", ROOM, CAROL, textMessage("hi"), { replyPolicy: "allowlist", userAllowlist: [CAROL] }, true],
  ["group, allowlist policy drops unlisted unaddressed messages", ROOM, ALICE, textMessage("hi"), { replyPolicy: "allowlist", userAllowlist: [CAROL] }, false],
  ["group, userAllowlist gates even addressed messages", ROOM, CAROL, textMessage(`${BOT} hi`, mention), { replyPolicy: "always", userAllowlist: [ALICE] }, false],
  ["group in a room that is not allowlisted is dropped", OTHER, CAROL, textMessage(`${BOT} hi`, mention), {}, false],
  ["DM from a dmAllowlist sender is delivered", DM, ALICE, textMessage("hi there"), {}, true],
  ["DM from a sender not on dmAllowlist is dropped", DM, CAROL, textMessage("hi there"), {}, false],
  ["empty text is dropped", ROOM, CAROL, textMessage(""), { replyPolicy: "always" }, false],
  ["unsupported msgtype is dropped", ROOM, CAROL, { msgtype: "m.location", body: "geo" }, { replyPolicy: "always" }, false],
  ["notice from another user is delivered as text", ROOM, CAROL, { msgtype: "m.notice", body: `${BOT} notice` }, { replyPolicy: "always" }, true],
  ["emote is delivered", ROOM, CAROL, { msgtype: "m.emote", body: "waves" }, { replyPolicy: "always" }, true],
];

for (const [name, room, sender, content, over, delivered] of policyCases) {
  test(`inbound policy: ${name}`, async () => {
    const rig = await setup(over);
    await rig.fake.deliver(room, [rig.fake.message(room, sender, content)]);
    assert.equal(rig.rich.length, delivered ? 1 : 0, `delivered=${delivered}`);
    assert.equal(rig.received.length, delivered ? 1 : 0, "framework path mirrors the decision");
  });
}

test("own events and own notices are ignored (loop prevention)", async () => {
  const rig = await setup({ replyPolicy: "always" });
  await rig.fake.deliver(ROOM, [rig.fake.message(ROOM, BOT, textMessage("echo")), rig.fake.message(ROOM, BOT, { msgtype: "m.notice", body: "status" })]);
  assert.equal(rig.rich.length, 0);
});

test("edits of messages (m.replace) are not re-dispatched", async () => {
  const rig = await setup({ replyPolicy: "always" });
  await rig.fake.deliver(ROOM, [
    rig.fake.message(ROOM, CAROL, { msgtype: "m.text", body: "* fixed", "m.new_content": { msgtype: "m.text", body: "fixed" }, "m.relates_to": { rel_type: "m.replace", event_id: "$orig" } }),
  ]);
  assert.equal(rig.rich.length, 0);
});

test("duplicate event ids are delivered once", async () => {
  const rig = await setup({ replyPolicy: "always" });
  const ev = rig.fake.message(ROOM, CAROL, textMessage("once"), "$dupe1");
  await rig.fake.deliver(ROOM, [ev]);
  await rig.fake.deliver(ROOM, [ev]);
  assert.equal(rig.rich.length, 1);
});

test("a throwing handler does not stop later messages", async () => {
  const rig = await setup({ replyPolicy: "always" });
  rig.ch.onMessage(() => {
    throw new Error("boom");
  });
  await rig.fake.deliver(ROOM, [rig.fake.message(ROOM, CAROL, textMessage("one"))]);
  await rig.fake.deliver(ROOM, [rig.fake.message(ROOM, CAROL, textMessage("two"))]);
  assert.deepEqual(rig.rich.map((m) => m.text), ["one", "two"]);
  assert.ok(rig.logs.some((l) => l.includes("handler-failed")));
});

// ----------------------------------------------------------------- threads, replies, fallbacks

test("reply fallback quote is stripped from the body when the event carries mx-reply HTML", async () => {
  const rig = await setup({ replyPolicy: "always" });
  const content = {
    msgtype: "m.text",
    body: "> <@carol:hs.test> the old question\n\nthe new answer",
    format: "org.matrix.custom.html",
    formatted_body: '<mx-reply><blockquote>the old question</blockquote></mx-reply>the new answer',
    "m.relates_to": { "m.in_reply_to": { event_id: "$orig" } },
  };
  await rig.fake.deliver(ROOM, [rig.fake.message(ROOM, CAROL, content)]);
  assert.equal(rig.rich[0]!.text, "the new answer");
  assert.equal(rig.rich[0]!.replyToMessageId, "$orig");
});

test("a quote without mx-reply markup is left alone", async () => {
  const rig = await setup({ replyPolicy: "always" });
  await rig.fake.deliver(ROOM, [rig.fake.message(ROOM, CAROL, textMessage("> quoted on purpose\n\nreply"))]);
  assert.equal(rig.rich[0]!.text, "> quoted on purpose\n\nreply");
});

test("thread messages get the opaque chatId <room>:<root> and threadId", async () => {
  const rig = await setup();
  await rig.fake.deliver(ROOM, [
    rig.fake.message(ROOM, CAROL, { msgtype: "m.text", body: "hi", ...mention, "m.relates_to": { rel_type: "m.thread", event_id: "$root1", is_falling_back: true, "m.in_reply_to": { event_id: "$root1" } } }),
  ]);
  assert.equal(rig.rich[0]!.chatId, `${ROOM}:$root1`);
  assert.equal(rig.rich[0]!.threadId, "$root1");
  assert.equal(rig.rich[0]!.replyToMessageId, undefined, "a thread fallback is not a reply");
});

test("a reply to one of the bot's own messages counts as addressing it", async () => {
  const rig = await setup();
  await rig.ch.send({ chatId: ROOM, text: "first" });
  const own = rig.fake.sent[0]!.eventId;
  await rig.fake.deliver(ROOM, [rig.fake.message(ROOM, CAROL, { msgtype: "m.text", body: "more?", "m.relates_to": { "m.in_reply_to": { event_id: own } } })]);
  assert.equal(rig.rich.length, 1);
  assert.equal(rig.rich[0]!.addressed, true);
});

// ----------------------------------------------------------------- DM detection, invites, history

test("a 2-member room is not a DM without m.direct: member count never decides", async () => {
  const rig = await setup({ replyPolicy: "always" }, (f) => {
    f.direct = {};
    f.addRoom("!pair:hs.test", { members: 2 });
  });
  await rig.fake.deliver("!pair:hs.test", [rig.fake.message("!pair:hs.test", ALICE, textMessage("hi"))]);
  assert.equal(rig.rich.length, 0, "not allowlisted, not a DM: dropped");
});

test("an unlisted member of an allowlisted 2-person room is a group sender, never a DM", async () => {
  const rig = await setup({}, (f) => {
    f.direct = {};
    f.addRoom(ROOM, { members: 2 });
  });
  await rig.fake.deliver(ROOM, [rig.fake.message(ROOM, CAROL, textMessage("me too"))]);
  assert.equal(rig.rich.length, 0, "mention policy: unaddressed group message dropped");
  await rig.fake.deliver(ROOM, [rig.fake.message(ROOM, CAROL, textMessage(`${BOT} hi`, mention))]);
  assert.equal(rig.rich.length, 1);
  assert.equal(rig.rich[0]!.chatKind, "group");
});

test("m.direct tying an allowlisted room to a non-allowlisted peer does not make it a DM for that peer", async () => {
  const rig = await setup({}, (f) => {
    f.direct = { [ALICE]: [DM], [CAROL]: [ROOM] };
  });
  await rig.fake.deliver(ROOM, [rig.fake.message(ROOM, CAROL, textMessage("dm?"))]);
  assert.equal(rig.rich.length, 0, "not a DM (peer not allowlisted); unaddressed group message dropped");
});

test("the room allowlist alone does not admit DMs: a non-DM room with a stranger is group-only", async () => {
  const rig = await setup({ replyPolicy: "always" }, (f) => {
    f.direct = {};
  });
  await rig.fake.deliver(ROOM, [rig.fake.message(ROOM, CAROL, textMessage("hello"))]);
  assert.equal(rig.rich[0]?.chatKind, "group");
});

test("a listed DM sender is accepted when m.direct marks the room", async () => {
  const rig = await setup({});
  await rig.fake.deliver(DM, [rig.fake.message(DM, ALICE, textMessage("hi"))]);
  assert.equal(rig.rich[0]?.chatKind, "direct");
});

test("initial sync discards history: old messages are never replayed", async () => {
  const rig = await setup({}, (f) => f.addHistory(ROOM, CAROL, textMessage(`${BOT} old`, mention)));
  assert.equal(rig.rich.length, 0);
  assert.equal(rig.received.length, 0);
});

test("invite from an allowlisted inviter to a non-allowlisted room is accepted (dmAllowlist inviter)", async () => {
  const rig = await setup({ dmAllowlist: [ALICE] });
  await rig.fake.deliverInvite(OTHER, ALICE);
  assert.ok(rig.fake.joins.includes(OTHER));
  assert.ok(!rig.fake.leaves.includes(OTHER));
});

test("invite from a stranger to a non-allowlisted room is declined by leaving", async () => {
  const rig = await setup();
  await rig.fake.deliverInvite(OTHER, CAROL);
  assert.ok(rig.fake.leaves.includes(OTHER));
  assert.ok(!rig.fake.joins.includes(OTHER));
});

test("invite to an allowlisted room is accepted whoever invites", async () => {
  const rig = await setup({}, (f) => f.rooms.delete(ROOM));
  await rig.fake.deliverInvite(ROOM, CAROL);
  assert.ok(rig.fake.joins.includes(ROOM));
});

test("autoJoin never leaves invites pending: no join, no leave", async () => {
  const rig = await setup({ autoJoin: "never" });
  await rig.fake.deliverInvite(ROOM, ALICE);
  assert.equal(rig.fake.joins.length, 0);
  assert.equal(rig.fake.leaves.length, 0);
  assert.ok(rig.logs.some((l) => l.includes("invite-pending")));
});

test("an accepted direct invite makes the room a DM for inbound routing", async () => {
  const rig = await setup({}, (f) => {
    f.direct = {};
  });
  await rig.fake.deliverInvite(OTHER, ALICE, true);
  await rig.fake.deliver(OTHER, [rig.fake.message(OTHER, ALICE, textMessage("hello"))]);
  assert.equal(rig.rich.at(-1)?.chatKind, "direct");
});

// ----------------------------------------------------------------- encryption refusal

test("encrypted room at startup is recorded silently; the first encrypted event gets one notice", async () => {
  const rig = await setup({}, (f) => f.addRoom(ROOM, { encrypted: true }));
  assert.equal(rig.fake.sent.length, 0, "no notice during the initial sync");
  await rig.fake.deliver(ROOM, [rig.fake.message(ROOM, CAROL, { msgtype: "m.text", body: "x" })]); // unencrypted-looking body in an encrypted room
  await rig.fake.deliver(ROOM, [{ type: "m.room.encrypted", sender: CAROL, event_id: "$enc1", content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "AAA" } }]);
  await rig.fake.deliver(ROOM, [{ type: "m.room.encrypted", sender: CAROL, event_id: "$enc2", content: { ciphertext: "BBB" } }]);
  const notices = rig.fake.sent.filter((s) => s.content.msgtype === "m.notice");
  assert.equal(notices.length, 1, "exactly one notice per room");
  assert.equal(notices[0]!.content.body, "This room is end-to-end encrypted; this bot cannot read it yet. Please use an unencrypted room.");
  assert.equal(rig.rich.length, 0);
});

test("an encryption state event mid-run triggers one notice and no dispatch", async () => {
  const rig = await setup({ replyPolicy: "always" });
  rig.fake.rooms.get(ROOM)!.encrypted = true;
  await rig.fake.deliver(ROOM, [rig.fake.message(ROOM, CAROL, textMessage("secret?"))]);
  assert.equal(rig.fake.sent.filter((s) => s.content.msgtype === "m.notice").length, 1);
  assert.equal(rig.rich.length, 0);
});

test("encrypted rooms that are not allowlisted get no notice at all", async () => {
  const rig = await setup({}, (f) => f.addRoom(OTHER, { encrypted: true }));
  await rig.fake.deliver(OTHER, [{ type: "m.room.encrypted", sender: CAROL, event_id: "$enc9", content: { ciphertext: "C" } }]);
  assert.equal(rig.fake.sent.length, 0);
});

// ----------------------------------------------------------------- /link

const claimed: { code: string; identity: unknown }[] = [];
function pairing(mode: "ok" | "throw") {
  return {
    claim: (p: { code: string; identity: unknown }) => {
      claimed.push(p);
      if (mode === "throw") throw new Error("no such code");
      return { pairingId: "p1", state: "awaiting-confirmation", confirmBy: 0 };
    },
  } as never;
}

for (const cmd of ["/link", "!link"]) {
  test(`${cmd} CODE in a DM claims the pairing with the Matrix sender and never forwards the code`, async () => {
    claimed.length = 0;
    const rig = await setup({ pairing: pairing("ok") });
    await rig.fake.deliver(DM, [rig.fake.message(DM, ALICE, textMessage(`${cmd} ABCD-1234`))]);
    assert.equal(claimed.length, 1);
    assert.deepEqual(claimed[0], { code: "ABCD-1234", identity: { channel: "matrix", accountId: BOT, userId: ALICE } });
    assert.equal(rig.rich.length, 0, "the command is not dispatched to the host");
    const reply = rig.fake.sent.at(-1)!;
    assert.equal(reply.content.body, "Pairing claimed. Confirm this link in My identities.");
    assert.ok(!rig.allLogText().includes("ABCD-1234"), "the code never reaches a log line");
  });
}

test("/link with an invalid code gets the same uniform failure reply", async () => {
  claimed.length = 0;
  const rig = await setup({ pairing: pairing("throw") });
  await rig.fake.deliver(DM, [rig.fake.message(DM, ALICE, textMessage("/link NOPE"))]);
  assert.equal(rig.fake.sent.at(-1)!.content.body, "Pairing failed. Request a new code in My identities.");
  assert.ok(!rig.allLogText().includes("NOPE"));
});

test("/link without a pairing port gets the uniform failure reply", async () => {
  const rig = await setup();
  await rig.fake.deliver(DM, [rig.fake.message(DM, ALICE, textMessage("/link X"))]);
  assert.equal(rig.fake.sent.at(-1)!.content.body, "Pairing failed. Request a new code in My identities.");
});

test("/link in a group is neither answered nor forwarded", async () => {
  claimed.length = 0;
  const rig = await setup({ pairing: pairing("ok"), replyPolicy: "always" });
  await rig.fake.deliver(ROOM, [rig.fake.message(ROOM, ALICE, textMessage("/link SECRETCODE"))]);
  assert.equal(claimed.length, 0);
  assert.equal(rig.fake.sent.length, 0);
  assert.equal(rig.rich.length, 0);
});

// ----------------------------------------------------------------- inbound media

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

test("inbound image: bytes, MIME and filename reach onMessage; the framework path logs the rich-turn gap", async () => {
  const rig = await setup({}, (f) => f.media.set("abc1", { data: PNG, mime: "image/png" }));
  await rig.fake.deliver(ROOM, [
    rig.fake.message(ROOM, CAROL, { msgtype: "m.image", body: "cat.png", info: { mimetype: "image/png", size: PNG.length }, url: "mxc://hs.test/abc1", ...mention }),
  ]);
  const m = rig.rich[0]!;
  assert.equal(m.attachments?.[0]?.kind, "photo");
  assert.deepEqual(Buffer.from(m.attachments![0]!.data), PNG);
  assert.equal(m.attachments![0]!.mimeType, "image/png");
  assert.equal(m.attachments![0]!.filename, "cat.png");
  assert.equal(rig.received.length, 0);
  assert.ok(rig.logs.some((l) => l.includes("framework-rich-turn-gap")));
});

test("media download falls back to the v3 endpoint when the server lacks authenticated media", async () => {
  const rig = await setup({}, (f) => {
    f.media.set("abc2", { data: PNG, mime: "image/png" });
    f.authenticatedMedia = false;
  });
  await rig.fake.deliver(ROOM, [
    rig.fake.message(ROOM, CAROL, { msgtype: "m.image", body: "a.png", info: { mimetype: "image/png" }, url: "mxc://hs.test/abc2", ...mention }),
  ]);
  assert.equal(rig.rich.length, 1);
  assert.equal(rig.fake.callsTo("GET", "/_matrix/media/v3/download/").length, 1);
});

test("declared size over the limit is refused before any download", async () => {
  const rig = await setup({ maxMediaBytes: 1000 }, (f) => f.media.set("abc3", { data: PNG, mime: "image/png" }));
  await rig.fake.deliver(ROOM, [
    rig.fake.message(ROOM, CAROL, { msgtype: "m.image", body: "big.png", info: { mimetype: "image/png", size: 5000 }, url: "mxc://hs.test/abc3", ...mention }),
  ]);
  assert.equal(rig.rich.length, 0);
  assert.equal(rig.fake.callsTo("GET", "/_matrix/client/v1/media/").length, 0);
  assert.ok(rig.logs.some((l) => l.includes("media-rejected")));
});

test("a body larger than the limit is refused while streaming, whatever was declared", async () => {
  const rig = await setup({ maxMediaBytes: 16 }, (f) => f.media.set("abc4", { data: Buffer.alloc(200, 1), mime: "image/png" }));
  await rig.fake.deliver(ROOM, [
    rig.fake.message(ROOM, CAROL, { msgtype: "m.image", body: "lie.png", info: { mimetype: "image/png", size: 4 }, url: "mxc://hs.test/abc4", ...mention }),
  ]);
  assert.equal(rig.rich.length, 0);
});

test("MIME allowlist: HTML and SVG-like types are refused even as files", async () => {
  const rig = await setup({}, (f) => f.media.set("abc5", { data: Buffer.from("<html>"), mime: "text/html" }));
  await rig.fake.deliver(ROOM, [
    rig.fake.message(ROOM, CAROL, { msgtype: "m.file", body: "page.html", info: { mimetype: "text/html", size: 6 }, url: "mxc://hs.test/abc5", ...mention }),
  ]);
  assert.equal(rig.rich.length, 0);
});

test("unsafe mxc references and encrypted files are refused without a request", async () => {
  const rig = await setup();
  await rig.fake.deliver(ROOM, [
    rig.fake.message(ROOM, CAROL, { msgtype: "m.image", body: "x.png", info: { mimetype: "image/png" }, url: "https://evil.example/x.png", ...mention }),
    rig.fake.message(ROOM, CAROL, { msgtype: "m.image", body: "y.png", info: { mimetype: "image/png" }, file: { url: "mxc://hs.test/q" }, ...mention }),
  ]);
  assert.equal(rig.rich.length, 0);
  assert.equal(rig.fake.calls.filter((c) => c.path.includes("/media/")).length, 0);
});

test("a file with a caption delivers the caption as text", async () => {
  const rig = await setup({}, (f) => f.media.set("abc6", { data: Buffer.from("hello"), mime: "text/plain" }));
  await rig.fake.deliver(ROOM, [
    rig.fake.message(ROOM, CAROL, { msgtype: "m.file", body: "please read this", filename: "note.txt", info: { mimetype: "text/plain", size: 5 }, url: "mxc://hs.test/abc6", ...mention }),
  ]);
  assert.equal(rig.rich[0]!.text, "please read this");
  assert.equal(rig.rich[0]!.attachments?.[0]?.filename, "note.txt");
});
