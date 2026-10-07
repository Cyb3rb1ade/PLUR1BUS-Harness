import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { FileOffsetStore, MemoryOffsetStore, TelegramChannel, type ChannelLogger, type InboundMessage } from "../src/index.ts";
import { FakeTelegram, textUpdate } from "./helpers/fake-telegram.ts";

const fake = new FakeTelegram();
before(() => fake.listen());
after(() => fake.close());
beforeEach(() => {
  fake.calls.length = 0;
  fake.queue.length = 0;
  for (const k of Object.keys(fake.failures)) delete fake.failures[k];
});

const lines: string[] = [];
const logger: ChannelLogger = { log: (level, event, attrs) => void lines.push(JSON.stringify({ level, event, attrs })) };
const secrets = (v: string | null = fake.token) => ({ reveal: async () => v });
const noSleep = () => Promise.resolve();

function until(cond: () => boolean, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (cond() ? resolve() : Date.now() - t0 > 5000 ? reject(new Error(`timeout: ${what}`)) : setImmediate(tick));
    tick();
  });
}

function make(over: Partial<ConstructorParameters<typeof TelegramChannel>[0]> = {}) {
  return new TelegramChannel({
    tokenSecret: "telegram/bot",
    secrets: secrets(),
    allowlist: [42],
    offsetStore: new MemoryOffsetStore(),
    logger,
    baseUrl: fake.baseUrl,
    sleep: noSleep,
    pollTimeoutSec: 1,
    ...over,
  });
}

test("polling delivers allowed text, advances and persists the offset, resumes after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tg-offset-"));
  try {
    const got: InboundMessage[] = [];
    const ch = make({ offsetStore: new FileOffsetStore(dir) });
    ch.onMessage((m) => void got.push(m));
    await ch.start();
    fake.push(textUpdate(7, 42, "hello"));
    await until(() => got.length === 1, "first message");
    assert.equal(got[0]!.text, "hello");
    assert.equal(got[0]!.chatId, "42");
    assert.equal(got[0]!.channel, "telegram");
    await until(() => fake.callsOf("getUpdates").some((c) => c.body.offset === 8), "offset 8 requested");
    await ch.stop();
    assert.deepEqual(JSON.parse(await readFile(join(dir, "telegram-offset.json"), "utf8")), { offset: 8 });

    // A second instance resumes at 8 and does not see update 7 again.
    fake.calls.length = 0;
    const again: InboundMessage[] = [];
    const ch2 = make({ offsetStore: new FileOffsetStore(dir) });
    ch2.onMessage((m) => void again.push(m));
    await ch2.start();
    fake.push(textUpdate(8, 42, "second"));
    await until(() => again.length === 1, "resumed message");
    assert.equal(again[0]!.text, "second");
    assert.equal(fake.callsOf("getUpdates")[0]!.body.offset, 8);
    await ch2.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-allowlisted chats are rejected silently; empty allowlist allows nothing; offset still advances", async () => {
  const got: InboundMessage[] = [];
  const ch = make({ allowlist: [] });
  ch.onMessage((m) => void got.push(m));
  await ch.start();
  fake.push(textUpdate(1, 42, "let me in"));
  await until(() => fake.callsOf("getUpdates").some((c) => c.body.offset === 2), "offset past rejected update");
  await ch.stop();
  assert.equal(got.length, 0);
  assert.equal(fake.callsOf("sendMessage").length, 0, "no reply to an unlisted chat");
  assert.ok(lines.some((l) => l.includes("channel.telegram.rejected")));
  assert.ok(!lines.some((l) => l.includes("let me in")), "message text is never logged");
  await assert.rejects(ch.send("42", "x"), /not started|allowlist/);
});

test("non-text updates are ignored", async () => {
  const got: InboundMessage[] = [];
  const ch = make();
  ch.onMessage((m) => void got.push(m));
  await ch.start();
  fake.push({ update_id: 3, message: { message_id: 1, date: 1, chat: { id: 42, type: "private" }, photo: [] } });
  fake.push(textUpdate(4, 42, "after"));
  await until(() => got.length === 1, "text after photo");
  assert.equal(got[0]!.text, "after");
  await ch.stop();
});

test("send splits at 4096 and refuses chats off the allowlist", async () => {
  const ch = make();
  await ch.start();
  const ids = await ch.send("42", "y".repeat(9000));
  assert.equal(ids.length, 3);
  const sent = fake.callsOf("sendMessage").map((c) => c.body.text as string);
  assert.ok(sent.every((t) => t.length <= 4096));
  assert.equal(sent.join(""), "y".repeat(9000));
  await assert.rejects(ch.send("99", "nope"), /allowlist/);
  await ch.stop();
});

test("429 on send waits retry_after then retries", async () => {
  const slept: number[] = [];
  const ch = make({ sleep: async (ms) => void slept.push(ms) });
  await ch.start();
  fake.failNext("sendMessage", 429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 } });
  const ids = await ch.send("42", "hi");
  assert.equal(ids.length, 1);
  assert.deepEqual(slept, [7000]);
  assert.equal(fake.callsOf("sendMessage").length, 2);
  await ch.stop();
});

test("429 on send gives up after maxSendRetries", async () => {
  const ch = make({ maxSendRetries: 1 });
  await ch.start();
  for (let i = 0; i < 3; i++) fake.failNext("sendMessage", 429, { ok: false, parameters: { retry_after: 1 } });
  await assert.rejects(ch.send("42", "hi"), (e: Error) => (e as { kind?: string }).kind === "rate-limited");
  assert.equal(fake.callsOf("sendMessage").length, 2);
  await ch.stop();
});

test("429 on getUpdates backs off by retry_after and keeps polling", async () => {
  const slept: number[] = [];
  const got: InboundMessage[] = [];
  fake.failNext("getUpdates", 429, { ok: false, error_code: 429, parameters: { retry_after: 3 } });
  const ch = make({ sleep: async (ms) => void slept.push(ms) });
  ch.onMessage((m) => void got.push(m));
  await ch.start();
  fake.push(textUpdate(1, 42, "still works"));
  await until(() => got.length === 1, "message after 429");
  assert.deepEqual(slept, [3000]);
  await ch.stop();
});

test("a rejected token stops polling without retry and leaks nothing", async () => {
  const bad = "999999999:AAWrongTokenWrongTokenWrongToken_x";
  const out: string[] = [];
  const ch = make({ secrets: secrets(bad), logger: { log: (l, e, a) => void out.push(JSON.stringify([l, e, a])) } });
  await ch.start();
  await until(() => out.some((l) => l.includes("auth-failed")), "auth-failed");
  await ch.stop();
  assert.equal(fake.callsOf("getUpdates").length, 0, "bad token never reaches a method");
  assert.ok(!out.join("\n").includes(bad));
});

test("the token appears in no log line, error message or rejection", async () => {
  lines.length = 0;
  const ch = make();
  await ch.start();
  fake.failNext("sendMessage", 500, { ok: false, description: `boom at /bot${fake.token}/sendMessage with ${fake.token}` });
  const err: Error = await ch.send("42", "hi").then(() => new Error("no error"), (e: Error) => e);
  assert.ok(!`${err.message}${err.stack}`.includes(fake.token));
  assert.ok(!`${err.message}`.includes("/bot1234"));
  await ch.stop();
  assert.ok(lines.length > 0);
  assert.ok(!lines.join("\n").includes(fake.token));
  assert.ok(!lines.join("\n").includes("AAFakeToken"));

  // A dead server: the platform's own error text may name the URL; ours must not.
  const dead = make({ baseUrl: "http://127.0.0.1:1" });
  await dead.start();
  const e2: Error = await dead.send("42", "hi").then(() => new Error("no error"), (e: Error) => e);
  await dead.stop();
  assert.ok(!`${e2.message}${e2.stack}`.includes(fake.token));
});

test("invalid allowlist entries and a missing or malformed token fail closed", async () => {
  assert.throws(() => make({ allowlist: ["@someone"] }), /decimal chat ids/);
  await assert.rejects(make({ secrets: secrets(null) }).start(), /not set/);
  await assert.rejects(make({ secrets: secrets("not-a-token") }).start(), (e: Error) => !e.message.includes("not-a-token") && /format/.test(e.message));
});
