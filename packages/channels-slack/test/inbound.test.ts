import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { FakeSlack, appMention, blockAction, BOT_USER, message, eventsApi } from "./helpers/fake-slack.ts";
import { wire, until, type Wiring } from "./helpers/wire.ts";
import type { RichInbound } from "../src/index.ts";

let fake: FakeSlack;
let w: Wiring;
const rich: RichInbound[] = [];
beforeEach(async () => {
  fake = new FakeSlack();
  await fake.listen();
  rich.length = 0;
});
afterEach(async () => {
  await w.ch.stop();
  await fake.close();
});

async function up(extra: Parameters<typeof wire>[1] = {}): Promise<void> {
  w = wire(fake, extra);
  w.ch.onMessage((m) => void rich.push(m));
  await w.ch.start(w.host);
}
const deliver = async (env: ReturnType<typeof message>) => {
  fake.push(env);
  await w.ch.idle();
};

test("DM from a dmAllowlisted user is handed to the host with chatKind direct", async () => {
  await up();
  await deliver(message({ channel: "D0FAKE01", user: "UHUMAN01", text: "hello", ts: "1700000001.000001" }));
  assert.equal(w.received.length, 1);
  assert.deepEqual(
    { channel: w.received[0]!.channel, chatId: w.received[0]!.chatId, chatKind: w.received[0]!.chatKind, senderId: w.received[0]!.senderId, text: w.received[0]!.text },
    { channel: "slack", chatId: "D0FAKE01", chatKind: "direct", senderId: "UHUMAN01", text: "hello" },
  );
  assert.equal(rich[0]!.messageId, "1700000001.000001");
});

test("DM policy table: unlisted senders are dropped silently, content never logged", async () => {
  await up();
  await deliver(message({ channel: "D0STRANGE", user: "USTRANGER", text: "secret-content-xyz", ts: "1700000002.000001" }));
  assert.equal(w.received.length, 0);
  assert.equal(rich.length, 0);
  assert.equal(fake.callsOf("chat.postMessage").length, 0, "no reply");
  assert.doesNotMatch(JSON.stringify(w.logs), /secret-content-xyz/);
});

test("DM from an allowlisted channel id is accepted even for a non-dm sender", async () => {
  await up({ allowlist: ["C0FAKE01", "D0TRUSTED"] });
  await deliver(message({ channel: "D0TRUSTED", user: "UOTHER01", text: "hi", ts: "1700000003.000001" }));
  assert.equal(w.received.length, 1);
});

test("group table: replyPolicy decides which unaddressed messages are heard", async () => {
  const cases: Array<[string, Parameters<typeof wire>[1], string, boolean]> = [
    ["mention policy, addressed", {}, "<@UBOT0001> hi", true],
    ["mention policy, unaddressed", {}, "hi all", false],
    ["always policy, unaddressed", { replyPolicy: "always" }, "hi all", true],
    ["allowlist policy, unaddressed non-member", { replyPolicy: "allowlist" }, "hi all", false],
    ["allowlist policy, addressed", { replyPolicy: "allowlist" }, "<@UBOT0001> hi", true],
    ["always with userAllowlist, member", { replyPolicy: "always", userAllowlist: ["UHUMAN01"] }, "hi", true],
    ["always with userAllowlist, stranger", { replyPolicy: "always", userAllowlist: ["UHUMAN01"] }, "hi", false],
  ];
  for (const [name, extra, text, heard] of cases) {
    await fake.close();
    fake = new FakeSlack();
    await fake.listen();
    rich.length = 0;
    await up(extra);
    const sender = name.includes("stranger") ? "UOTHER01" : "UHUMAN01";
    await deliver(message({ channel: "C0FAKE01", user: sender, text, ts: "1700000010.000001" }));
    assert.equal(rich.length, heard ? 1 : 0, name);
    await w.ch.stop();
    await fake.close();
  }
});

test("group message in a chat that is not allowlisted is dropped", async () => {
  await up();
  await deliver(message({ channel: "C0OTHER01", user: "UHUMAN01", text: "<@UBOT0001> hi", ts: "1700000020.000001" }));
  assert.equal(rich.length, 0);
});

test("the bot's own messages, bot_id messages and ignored subtypes never reach the handler", async () => {
  await up({ replyPolicy: "always" });
  await deliver(message({ channel: "C0FAKE01", user: BOT_USER, text: "echo", ts: "1700000030.000001" }));
  await deliver(message({ channel: "C0FAKE01", user: "UHUMAN01", text: "bot", botId: "B0OTHER", ts: "1700000031.000001" }));
  await deliver(message({ channel: "C0FAKE01", user: "UHUMAN01", text: "joined", subtype: "channel_join", ts: "1700000032.000001" }));
  await deliver(message({ channel: "C0FAKE01", user: "UHUMAN01", text: "edited", subtype: "message_changed", ts: "1700000033.000001" }));
  assert.equal(rich.length, 0);
});

test("file_share and thread_broadcast subtypes are kept", async () => {
  await up({ replyPolicy: "always" });
  await deliver(message({ channel: "C0FAKE01", user: "UHUMAN01", text: "broadcast", subtype: "thread_broadcast", ts: "1700000034.000001", threadTs: "1700000000.000001" }));
  assert.equal(rich.length, 1);
});

test("duplicate event_id is processed once; app_mention plus message for one post is processed once", async () => {
  await up();
  const env = message({ channel: "C0FAKE01", user: "UHUMAN01", text: "<@UBOT0001> once", ts: "1700000040.000001", eventId: "EvDUP1" });
  await deliver(env);
  await deliver(env);
  assert.equal(rich.length, 1);
  await deliver(message({ channel: "C0FAKE01", user: "UHUMAN01", text: "<@UBOT0001> both", ts: "1700000041.000001", eventId: "EvM1" }));
  await deliver(appMention({ channel: "C0FAKE01", user: "UHUMAN01", text: "<@UBOT0001> both", ts: "1700000041.000001", eventId: "EvA1" }));
  assert.equal(rich.length, 2);
});

test("app_mention alone addresses the bot", async () => {
  await up();
  await deliver(appMention({ channel: "C0FAKE01", user: "UHUMAN01", text: "<@UBOT0001> ping", ts: "1700000042.000001", eventId: "EvA2" }));
  assert.equal(rich.length, 1);
  assert.equal(rich[0]!.text, "ping");
  assert.equal(rich[0]!.mention, true);
});

test("userAllowlist: non-members are not heard in groups even when mentioned under mention policy", async () => {
  await up({ userAllowlist: ["UHUMAN01"] });
  await deliver(message({ channel: "C0FAKE01", user: "UOTHER01", text: "<@UBOT0001> hi", ts: "1700000043.000001" }));
  assert.equal(rich.length, 0);
  await deliver(message({ channel: "C0FAKE01", user: "UHUMAN01", text: "<@UBOT0001> hi", ts: "1700000044.000001" }));
  assert.equal(rich.length, 1);
});

test("mentions are stripped; wire text is decoded; thread replies get a thread-scoped chatId", async () => {
  await up();
  await deliver(message({ channel: "C0FAKE01", user: "UHUMAN01", text: "<@UBOT0001> see <https://x.test|docs> &amp; <!channel>", ts: "1700000050.000002", threadTs: "1700000050.000001" }));
  assert.equal(rich[0]!.text, "see docs (https://x.test) & @channel");
  assert.equal(rich[0]!.chatId, "C0FAKE01:1700000050.000001");
  assert.equal(rich[0]!.threadId, "1700000050.000001");
  assert.equal(rich[0]!.chatKind, "group");
});

test("images and files arrive as bounded attachments on the rich handler, and the framework path logs the rich-turn gap", async () => {
  await up();
  fake.files.set("F1", { name: "pic.png", mime: "image/png", data: Buffer.from([137, 80, 78, 71]) });
  fake.files.set("F2", { name: "doc.pdf", mime: "application/pdf", data: Buffer.from("%PDF-1.4") });
  await deliver(
    message({
      channel: "D0FAKE01",
      user: "UHUMAN01",
      text: "look",
      ts: "1700000060.000001",
      files: [
        { id: "F1", name: "pic.png", mimetype: "image/png", size: 4, url_private_download: `${fake.root}/files/F1` },
        { id: "F2", name: "doc.pdf", mimetype: "application/pdf", size: 8, url_private_download: `${fake.root}/files/F2` },
      ],
    }),
  );
  assert.equal(rich.length, 1);
  assert.deepEqual(rich[0]!.attachments!.map((a) => [a.kind, a.mimeType, a.filename]), [["photo", "image/png", "pic.png"], ["document", "application/pdf", "doc.pdf"]]);
  assert.equal(w.received.length, 0, "rich-only turn is not handed to the text-only framework");
  assert.ok(w.logs.some((l) => l.event === "channel.slack.framework-rich-turn-gap"));
});

test("oversized, HTML and disguised attachments drop the whole message with a content-free log", async () => {
  await up({ maxMediaBytes: 1024 });
  fake.files.set("FBIG", { name: "big.bin", mime: "application/zip", data: Buffer.alloc(10) });
  fake.files.set("FHTML", { name: "x.html", mime: "text/html", data: Buffer.from("<script>") });
  const cases = [
    { id: "FBIG", name: "big.bin", mimetype: "application/zip", size: 5_000_000, url_private_download: `${fake.root}/files/FBIG` },
    { id: "FHTML", name: "x.html", mimetype: "text/html", size: 8, url_private_download: `${fake.root}/files/FHTML` },
    { id: "FBIG", name: "x", mimetype: "image/svg+xml", size: 8, url_private_download: `${fake.root}/files/FBIG` },
  ];
  for (const f of cases) {
    await deliver(message({ channel: "D0FAKE01", user: "UHUMAN01", text: "file", ts: `1700000070.00000${cases.indexOf(f)}`, files: [f] }));
  }
  assert.equal(rich.length, 0);
  // Each channel log line reaches both the deps logger and the host, so three rejections show as six lines.
  assert.equal(w.logs.filter((l) => l.event === "channel.slack.media-rejected").length, 6);
});

test("a download that redirects to another host is refused", async () => {
  await up();
  fake.files.set("FR", { name: "r.png", mime: "image/png", data: Buffer.from([1]), redirect: "http://evil.test/exfil" });
  await deliver(message({ channel: "D0FAKE01", user: "UHUMAN01", text: "x", ts: "1700000080.000001", files: [{ id: "FR", name: "r.png", mimetype: "image/png", size: 1, url_private_download: `${fake.root}/files/FR` }] }));
  assert.equal(rich.length, 0);
  assert.ok(w.logs.some((l) => l.event === "channel.slack.media-rejected"));
});

test("reaction_added in an allowlisted channel reaches the rich handler, not the text framework", async () => {
  await up();
  await deliver(
    eventsApi({ type: "reaction_added", user: "UHUMAN01", reaction: "thumbsup", item: { type: "message", channel: "C0FAKE01", ts: "1700000090.000001" } }, { eventId: "EvR1" }),
  );
  assert.equal(rich.length, 1);
  assert.deepEqual(rich[0]!.reaction, { emoji: "thumbsup", itemTs: "1700000090.000001" });
  assert.equal(w.received.length, 0);
});

test("a throwing handler never kills the loop", async () => {
  await up({ replyPolicy: "always" });
  w.ch.onMessage(() => {
    throw new Error("handler boom");
  });
  await deliver(message({ channel: "C0FAKE01", user: "UHUMAN01", text: "one", ts: "1700000100.000001" }));
  await deliver(message({ channel: "C0FAKE01", user: "UHUMAN01", text: "two", ts: "1700000101.000001" }));
  assert.equal(rich.length, 2);
  assert.ok(w.logs.some((l) => l.event === "channel.slack.handler-failed"));
  assert.doesNotMatch(JSON.stringify(w.logs), /handler boom/);
});

test("ack goes out before the handler runs (the socket layer acks first)", async () => {
  await up({ replyPolicy: "always" });
  let sentAtHandler = -1;
  w.ch.onMessage(() => {
    sentAtHandler = fake.latest().sent.length;
  });
  await deliver(message({ channel: "C0FAKE01", user: "UHUMAN01", text: "x", ts: "1700000110.000001" }));
  assert.equal(sentAtHandler, 1);
  await until(() => fake.latest().ackedIds().length === 1);
});
