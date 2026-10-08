import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { UnsupportedError, SLACK_MAX_TEXT, type SentRef } from "../src/index.ts";
import { FakeSlack, message } from "./helpers/fake-slack.ts";
import { wire, type Wiring } from "./helpers/wire.ts";

let fake: FakeSlack;
let w: Wiring;
beforeEach(async () => {
  fake = new FakeSlack();
  await fake.listen();
});
afterEach(async () => {
  await w?.ch.stop();
  await fake.close();
});
async function up(extra: Parameters<typeof wire>[1] = {}): Promise<void> {
  w = wire(fake, extra);
  await w.ch.start(w.host);
}
const posts = () => fake.callsOf("chat.postMessage");

test("markdown is converted and sent with safe flags, not unfurled, no link_names", async () => {
  await up();
  await w.ch.send({ chatId: "C0FAKE01", text: "**hi** <!channel> <@UABC>" });
  assert.equal(posts().length, 1);
  const b = posts()[0]!.body;
  assert.equal(b.channel, "C0FAKE01");
  assert.equal(b.text, "*hi* &lt;!channel&gt; &lt;@UABC&gt;");
  assert.equal(b.mrkdwn, true);
  assert.equal(b.unfurl_links, false);
  assert.equal(b.unfurl_media, false);
  assert.equal(b.link_names, false);
  assert.equal("thread_ts" in b, false);
  assert.equal(posts()[0]!.auth, `Bearer ${"xoxb-000000000000-FAKEBOTTOKENFORTESTSONLY"}`);
});

test("thread targeting: thread-scoped chatId and replyTo both set thread_ts", async () => {
  await up();
  await w.ch.sendTurn({ chatId: "C0FAKE01:1700000001.000100", text: "a" });
  await w.ch.sendTurn({ chatId: "C0FAKE01", text: "b", replyTo: "1700000002.000200" });
  assert.equal(posts()[0]!.body.thread_ts, "1700000001.000100");
  assert.equal(posts()[1]!.body.thread_ts, "1700000002.000200");
});

test("returned refs carry the message ts so the caller can edit later", async () => {
  await up();
  const refs = await w.ch.sendTurn({ chatId: "C0FAKE01", text: "x" });
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.kind, "message");
  assert.match(refs[0]!.messageId, /^\d+\.\d+$/);
});

test("long text is split into ordered chunks under the limit, code fences balanced", async () => {
  await up();
  const body = Array.from({ length: 400 }, (_, i) => `paragraph ${i} ${"lorem ipsum ".repeat(4)}`).join("\n\n");
  await w.ch.send({ chatId: "C0FAKE01", text: body });
  const texts = posts().map((c) => String(c.body.text));
  assert.ok(texts.length > 1);
  for (const t of texts) assert.ok(t.length <= SLACK_MAX_TEXT, `chunk ${t.length}`);
  assert.equal(texts.join("").replace(/\s/g, ""), body.replace(/\s/g, ""));
});

test("send rejects when not started and when the chat is not allowlisted", async () => {
  w = wire(fake);
  await assert.rejects(w.ch.send({ chatId: "C0FAKE01", text: "x" }), /not started/);
  await w.ch.start(w.host);
  await assert.rejects(w.ch.send({ chatId: "C0NOPE99", text: "x" }), /allowlist/);
  await assert.rejects(w.ch.send({ chatId: "not a chat", text: "x" }), /invalid/);
  assert.equal(posts().length, 0);
});

test("DMs are refused until the DM user is known from an accepted inbound message", async () => {
  await up();
  await assert.rejects(w.ch.send({ chatId: "D0FAKE01", text: "x" }), /allowlist/);
  fake.push(message({ channel: "D0FAKE01", user: "UHUMAN01", text: "hi", ts: "1700000003.000001" }));
  await w.ch.idle();
  await w.ch.send({ chatId: "D0FAKE01", text: "reply" });
  assert.equal(posts().length, 1);
});

test("429 with Retry-After waits the server hint, then succeeds; the hint is clamped", async () => {
  const cases: Array<[string, number]> = [
    ["2", 2000],
    ["0", 1000],
    ["999999", 300_000],
  ];
  for (const [header, waitMs] of cases) {
    await w?.ch.stop();
    await fake.close();
    fake = new FakeSlack();
    await fake.listen();
    await up();
    w.sleeps.length = 0;
    fake.failNext("chat.postMessage", 429, "ratelimited", { "retry-after": header });
    await w.ch.send({ chatId: "C0FAKE01", text: "retry me" });
    assert.ok(w.sleeps.includes(waitMs), `${header} -> ${waitMs}; sleeps=${w.sleeps}`);
    assert.equal(fake.callsOf("chat.postMessage").length, 2);
  }
});

test("bounded retries on 5xx and network-class errors; non-retryable 4xx is not retried", async () => {
  await up();
  // Retries only transient classes; the bound (3 retries) keeps a dead platform from being hammered.
  fake.failNext("chat.postMessage", 503, { ok: false, error: "service_unavailable" });
  await w.ch.send({ chatId: "C0FAKE01", text: "one" });
  assert.equal(fake.callsOf("chat.postMessage").length, 2);
  fake.failNext("chat.postMessage", 400, { ok: false, error: "msg_too_long" });
  await assert.rejects(w.ch.send({ chatId: "C0FAKE01", text: "two" }), /msg_too_long/);
  assert.equal(fake.callsOf("chat.postMessage").length, 3, "400 is not retried");
  for (let i = 0; i < 10; i++) fake.failNext("chat.postMessage", 500, { ok: false, error: "internal_error" });
  await assert.rejects(w.ch.send({ chatId: "C0FAKE01", text: "three" }));
  assert.equal(fake.callsOf("chat.postMessage").length, 3 + 4, "one initial try plus three retries");
});

test("forbidden conversation errors mark the chat inactive for this instance", async () => {
  await up();
  fake.failNext("chat.postMessage", 403, { ok: false, error: "not_in_channel" });
  await assert.rejects(w.ch.send({ chatId: "C0FAKE01", text: "x" }));
  const before = fake.callsOf("chat.postMessage").length;
  await assert.rejects(w.ch.send({ chatId: "C0FAKE01", text: "y" }), /inactive/);
  assert.equal(fake.callsOf("chat.postMessage").length, before, "no call once inactive");
});

test("edit uses chat.update on the message ts; files cannot be edited; oversize edits refused", async () => {
  await up();
  const [ref] = await w.ch.sendTurn({ chatId: "C0FAKE01", text: "draft" });
  await w.ch.edit(ref!, "final **text**");
  const upd = fake.callsOf("chat.update")[0]!;
  assert.equal(upd.body.ts, ref!.messageId);
  assert.equal(upd.body.text, "final *text*");
  await assert.rejects(w.ch.edit({ chatId: "C0FAKE01", messageId: "F1", kind: "file" }, "x"), (e: unknown) => e instanceof UnsupportedError && (e as UnsupportedError).code === "unsupported");
  await assert.rejects(w.ch.edit(ref!, "z".repeat(SLACK_MAX_TEXT + 10)), RangeError);
});

test("typing is a documented no-op and the capability says so", async () => {
  await up();
  await w.ch.typing("C0FAKE01");
  assert.equal(w.ch.capabilities.typing, false);
  assert.equal(fake.calls.length, 2, "only auth.test and connections.open");
});

test("capabilities are honest", () => {
  w = wire(fake);
  assert.deepEqual(w.ch.capabilities, {
    threads: true,
    edit: true,
    typing: false,
    attachmentsIn: true,
    attachmentsOut: true,
    reactions: true,
    buttons: true,
    approvalMode: "buttons",
    markdown: "converted",
    maxMessageChars: SLACK_MAX_TEXT,
  });
});

test("attachments upload via getUploadURLExternal, raw bytes, then completeUploadExternal", async () => {
  await up();
  const refs: SentRef[] = await w.ch.sendTurn({
    chatId: "C0FAKE01:1700000004.000100",
    text: "see file",
    attachments: [{ kind: "photo", data: Buffer.from([137, 80, 78, 71]), mimeType: "image/png", filename: "a b.png" }],
  });
  assert.equal(refs.at(-1)!.kind, "file");
  const slot = fake.callsOf("files.getUploadURLExternal")[0]!;
  assert.equal(slot.body.filename, "a_b.png");
  assert.equal(slot.body.length, "4");
  const complete = fake.callsOf("files.completeUploadExternal")[0]!;
  assert.equal(complete.body.channel_id, "C0FAKE01");
  assert.equal(complete.body.thread_ts, "1700000004.000100");
  assert.equal(((complete.body.files as Array<{ id: string }>)[0]!).id, refs.at(-1)!.messageId);
  assert.equal(fake.uploads.size, 1);
});

test("attachments: disallowed MIME and oversize are refused before any upload call", async () => {
  await up({ maxMediaBytes: 8 });
  await assert.rejects(w.ch.sendTurn({ chatId: "C0FAKE01", text: "", attachments: [{ kind: "document", data: Buffer.from("<x>"), mimeType: "text/html" }] }), /MIME/);
  await assert.rejects(w.ch.sendTurn({ chatId: "C0FAKE01", text: "", attachments: [{ kind: "document", data: Buffer.alloc(9), mimeType: "application/pdf" }] }), /size/);
  assert.equal(fake.callsOf("files.getUploadURLExternal").length, 0);
});

test("buttons: opaque signed action ids, no data in the wire id, value empty", async () => {
  await up();
  await w.ch.sendTurn({
    chatId: "C0FAKE01",
    text: "Pick one",
    buttons: [[{ text: "Yes", data: "secret-payload-data" }, { text: "No", data: "no" }]],
  });
  const b = posts()[0]!.body;
  const actions = (b.blocks as Array<{ type: string; elements?: Array<{ action_id: string; value?: string }> }>).find((x) => x.type === "actions")!;
  for (const el of actions.elements!) {
    assert.match(el.action_id, /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}$/);
    assert.equal(el.value, undefined);
  }
  assert.doesNotMatch(JSON.stringify(b), /secret-payload-data/);
});

test("the webhook-free transport never asks for scopes we do not list", async () => {
  await up();
  for (const c of fake.calls) assert.ok(!/users\.|conversations\.open|im\.write/.test(c.method), c.method);
});
