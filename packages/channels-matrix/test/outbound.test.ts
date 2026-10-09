import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ALICE, DM, FakeMatrix, ROOM } from "./helpers/fake-matrix.ts";
import { Rig, newFake } from "./helpers/rig.ts";
import type { MatrixChannelOptions } from "../src/index.ts";

const open: { fake: FakeMatrix; rig: Rig }[] = [];
afterEach(async () => {
  for (const { rig, fake } of open.splice(0)) {
    await rig.close().catch(() => {});
    await fake.close().catch(() => {});
  }
});

async function setup(over: Partial<MatrixChannelOptions> = {}): Promise<Rig> {
  const fake = await newFake();
  fake.addRoom(DM, { members: 2 });
  fake.direct = { [ALICE]: [DM] };
  const rig = new Rig(fake, over);
  open.push({ fake, rig });
  await rig.start();
  return rig;
}

const last = (r: Rig) => r.fake.sent.at(-1)!;

// ----------------------------------------------------------------- markdown -> Matrix (table-driven)

const mdCases: [name: string, md: string, expectHtml: RegExp | undefined, expectBody: string][] = [
  ["bold/italic", "**big** and *small*", /<strong>big<\/strong> and <em>small<\/em>/, "big and small"],
  ["inline code", "use `npm test`", /<code>npm test<\/code>/, "use npm test"],
  ["code block", "```js\nconsole.log(1)\n```", /<pre><code class="language-js">console\.log\(1\)<\/code><\/pre>/, "console.log(1)"],
  ["link", "[docs](https://example.org/x)", /<a href="https:\/\/example\.org\/x">docs<\/a>/, "docs (https://example.org/x)"],
  ["list", "- one\n- two", /<ul><li>one<\/li><li>two<\/li><\/ul>/, "- one\n- two"],
  ["script injection stays text", "**x** <script>alert(1)</script>", /&lt;script&gt;/, "x <script>alert(1)</script>"],
  ["javascript link is not a link", "[x](javascript:alert(1))", undefined, "x"],
  ["attribute injection is escaped", "**\"><img src=x onerror=1>**", /&quot;&gt;&lt;img/, "\"><img src=x onerror=1>"],
];
for (const [name, md, html, body] of mdCases) {
  test(`outbound markdown: ${name}`, async () => {
    const rig = await setup();
    await rig.ch.send({ chatId: ROOM, text: md });
    const c = last(rig).content;
    assert.equal(c.body, body);
    if (html) assert.match(String(c.formatted_body), html);
    else assert.equal(c.formatted_body, undefined);
    if (html) assert.equal(c.format, "org.matrix.custom.html");
    assert.deepEqual(c["m.mentions"], {}, "no implicit mentions");
  });
}

test("@room in model text cannot ping the room", async () => {
  const rig = await setup();
  await rig.ch.send({ chatId: ROOM, text: "@room attention" });
  assert.ok(!String(last(rig).content.body).includes("@room"));
});

test("notice flag sends m.notice", async () => {
  const rig = await setup();
  await rig.ch.sendTurn({ chatId: ROOM, text: "status", notice: true });
  assert.equal(last(rig).content.msgtype, "m.notice");
});

// ----------------------------------------------------------------- replies, threads, edits, typing

test("replyTo sets m.in_reply_to", async () => {
  const rig = await setup();
  await rig.ch.sendTurn({ chatId: ROOM, text: "answer", replyTo: "$q1" });
  assert.deepEqual(last(rig).content["m.relates_to"], { "m.in_reply_to": { event_id: "$q1" } });
});

test("thread chatId sends m.thread with is_falling_back when no reply target is given", async () => {
  const rig = await setup();
  await rig.ch.sendTurn({ chatId: `${ROOM}:$root1`, text: "in thread" });
  assert.deepEqual(last(rig).content["m.relates_to"], {
    rel_type: "m.thread",
    event_id: "$root1",
    is_falling_back: true,
    "m.in_reply_to": { event_id: "$root1" },
  });
});

test("thread plus explicit reply: is_falling_back is false and the reply target is kept", async () => {
  const rig = await setup();
  await rig.ch.sendTurn({ chatId: `${ROOM}:$root1`, text: "in thread", replyTo: "$m9" });
  assert.deepEqual(last(rig).content["m.relates_to"], {
    rel_type: "m.thread",
    event_id: "$root1",
    is_falling_back: false,
    "m.in_reply_to": { event_id: "$m9" },
  });
});

test("invalid replyTo is refused before sending", async () => {
  const rig = await setup();
  const before = rig.fake.sent.length;
  await assert.rejects(rig.ch.sendTurn({ chatId: ROOM, text: "x", replyTo: "not-an-event" }), RangeError);
  assert.equal(rig.fake.sent.length, before);
});

test("edit sends an m.replace event with new content and a fallback body", async () => {
  const rig = await setup();
  await rig.ch.send({ chatId: ROOM, text: "draft" });
  const id = last(rig).content && rig.fake.sent.at(-1)!.eventId;
  await rig.ch.edit({ chatId: ROOM, messageId: id }, "final **text**");
  const e = last(rig).content;
  assert.equal(e["m.relates_to"] && (e["m.relates_to"] as Record<string, unknown>).rel_type, "m.replace");
  assert.equal(e.body, "* final text");
  assert.equal((e["m.new_content"] as Record<string, unknown>).body, "final text");
});

test("edit text that does not fit one event is refused", async () => {
  const rig = await setup();
  await assert.rejects(rig.ch.edit({ chatId: ROOM, messageId: "$x1" }, "a".repeat(20_000)), RangeError);
});

test("typing sends a typing state for the bot", async () => {
  const rig = await setup();
  await rig.ch.typing(ROOM);
  assert.deepEqual(rig.fake.typing.at(-1), { roomId: ROOM, typing: true });
});

// ----------------------------------------------------------------- splitting

test("long replies are split into events each under 16000 bytes, with balanced code fences", async () => {
  const rig = await setup();
  const code = Array.from({ length: 2000 }, (_, i) => `const v${i} = ${i};`).join("\n");
  const text = `Here:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nDone.`;
  const refs = await rig.ch.sendTurn({ chatId: ROOM, text });
  assert.ok(refs.length >= 2);
  const events = rig.fake.sent.filter((s) => s.type === "m.room.message");
  for (const e of events) {
    assert.ok(new TextEncoder().encode(String(e.content.body)).length <= 16_000);
    const fences = String(e.content.body).split("\n").filter((l) => l.startsWith("```")).length;
    assert.equal(fences % 2, 0, "each event has balanced fences");
  }
  assert.ok(String(events.at(-1)!.content.body).endsWith("Done."));
});

// ----------------------------------------------------------------- targeting

test("sending to a non-allowlisted room, a malformed id, or before start is refused", async () => {
  const rig = await setup();
  await assert.rejects(rig.ch.send({ chatId: "!nope:hs.test", text: "x" }), /allowlist/);
  await assert.rejects(rig.ch.send({ chatId: "not a room", text: "x" }), /invalid matrix conversation id/);
  await rig.ch.stop();
  await assert.rejects(rig.ch.send({ chatId: ROOM, text: "x" }), /not started/);
});

test("DM rooms are reachable only through a dmAllowlist peer's m.direct entry", async () => {
  const rig = await setup();
  await rig.ch.send({ chatId: DM, text: "hi alice" });
  assert.equal(last(rig).roomId, DM);
});

// ----------------------------------------------------------------- attachments

test("outbound image: uploaded, then sent as m.image with mimetype and size", async () => {
  const rig = await setup();
  const data = Buffer.from("89504e470d0a1a0a", "hex");
  await rig.ch.sendTurn({ chatId: ROOM, text: "", attachments: [{ kind: "photo", data, mimeType: "image/png", filename: "a.png" }] });
  assert.equal(rig.fake.uploads.length, 1);
  assert.equal(rig.fake.uploads[0]!.mime, "image/png");
  const c = last(rig).content;
  assert.equal(c.msgtype, "m.image");
  assert.deepEqual(c.info, { mimetype: "image/png", size: data.length });
  assert.match(String(c.url), /^mxc:\/\/hs\.test\//);
});

test("outbound attachments with a disallowed MIME are refused before any upload", async () => {
  const rig = await setup();
  await assert.rejects(
    rig.ch.sendTurn({ chatId: ROOM, text: "", attachments: [{ kind: "document", data: Buffer.from("<x>"), mimeType: "text/html" }] }),
    /MIME/,
  );
  assert.equal(rig.fake.uploads.length, 0);
});

test("outbound attachments over maxMediaBytes are refused", async () => {
  const rig = await setup({ maxMediaBytes: 10 });
  await assert.rejects(
    rig.ch.sendTurn({ chatId: ROOM, text: "", attachments: [{ kind: "document", data: Buffer.alloc(100), mimeType: "text/plain" }] }),
    /size limit/,
  );
  assert.equal(rig.fake.uploads.length, 0);
});

test("sendOutput refuses when the output store does not authorize the destination", async () => {
  const rig = await setup({ outputs: { store: { get: async () => null, root: "/nonexistent" }, authorize: async () => false } as never });
  await assert.rejects(rig.ch.sendOutput(ROOM, "00000000-0000-0000-0000-000000000000"), /denied/);
});

// ----------------------------------------------------------------- rate limits and retries

test("429 with retry_after_ms is retried after the clamped server interval", async () => {
  const rig = await setup();
  rig.fake.failNext("PUT", "/_matrix/client/v3/rooms/", 429, { errcode: "M_LIMIT_EXCEEDED", error: "slow", retry_after_ms: 2500 });
  await rig.ch.send({ chatId: ROOM, text: "eventually" });
  assert.ok(rig.sleeps.includes(2500));
  assert.equal(rig.fake.sent.filter((s) => s.type === "m.room.message").length, 1);
});

test("a huge or zero retry_after is clamped to [1 s, 5 min]", async () => {
  const rig = await setup();
  rig.fake.failNext("PUT", "/_matrix/client/v3/rooms/", 429, { errcode: "M_LIMIT_EXCEEDED", error: "a", retry_after_ms: 0 });
  rig.fake.failNext("PUT", "/_matrix/client/v3/rooms/", 429, { errcode: "M_LIMIT_EXCEEDED", error: "b", retry_after_ms: 99_999_999 });
  await rig.ch.send({ chatId: ROOM, text: "clamped" });
  assert.ok(rig.sleeps.includes(1000));
  assert.ok(rig.sleeps.includes(300_000));
});

test("5xx is retried with the same transaction id, so the homeserver sends exactly one event", async () => {
  const rig = await setup();
  rig.fake.failNext("PUT", "/_matrix/client/v3/rooms/", 503, { errcode: "M_UNKNOWN", error: "busy" });
  await rig.ch.send({ chatId: ROOM, text: "once" });
  const sendCalls = rig.fake.calls.filter((c) => c.method === "PUT" && c.path.includes("/send/"));
  assert.equal(sendCalls.length, 2);
  assert.equal(new Set(sendCalls.map((c) => c.path)).size, 1, "identical transaction path on retry");
  assert.equal(rig.fake.sent.length, 1);
});

test("a network failure is retried", async () => {
  let fails = 1;
  const realFetch = globalThis.fetch;
  const rig = await setup({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (fails > 0 && String(input).includes("/send/")) {
        fails--;
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      }
      return realFetch(input, init);
    }) as typeof fetch,
  });
  await rig.ch.send({ chatId: ROOM, text: "after reset" });
  assert.equal(rig.fake.sent.length, 1);
});

test("a 400 is not retried", async () => {
  const rig = await setup();
  rig.fake.failNext("PUT", "/_matrix/client/v3/rooms/", 400, { errcode: "M_BAD_JSON", error: "bad" });
  await assert.rejects(rig.ch.send({ chatId: ROOM, text: "x" }), (e: { kind?: string }) => e.kind === "bad-request");
  assert.equal(rig.fake.calls.filter((c) => c.path.includes("/send/")).length, 1);
});

test("a 403 is not retried and the room is marked inactive for this run", async () => {
  const rig = await setup();
  rig.fake.failNext("PUT", "/_matrix/client/v3/rooms/", 403, { errcode: "M_FORBIDDEN", error: "no" });
  await assert.rejects(rig.ch.send({ chatId: ROOM, text: "x" }), (e: { kind?: string }) => e.kind === "forbidden");
  await assert.rejects(rig.ch.send({ chatId: ROOM, text: "y" }), /inactive/);
});

test("the channel fails closed if a reply fails: no partial pretend-success", async () => {
  const rig = await setup();
  rig.fake.failNext("PUT", "/_matrix/client/v3/rooms/", 400, { errcode: "M_BAD_JSON", error: "bad" });
  await assert.rejects(rig.ch.sendTurn({ chatId: ROOM, text: "a\n\nb" }));
});
