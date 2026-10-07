import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import {
  TelegramChannel,
  MemoryOffsetStore,
  escapeText,
  CallbackSigner,
  TokenBucket,
  type InboundMessage,
} from "../src/index.ts";
import { FakeTelegram, textUpdate } from "./helpers/fake-telegram.ts";
import type { Channel, ChannelHost } from "../../core/src/channels/types.ts";

const fake = new FakeTelegram();
before(() => fake.listen());
after(() => fake.close());
beforeEach(() => {
  fake.calls.length = 0;
  fake.queue.length = 0;
  fake.files.clear();
  for (const k of Object.keys(fake.failures)) delete fake.failures[k];
});
const host: ChannelHost = {
  receive: async () => {},
  fail: () => {},
  log: { info() {}, warn() {}, error() {} },
};
const secret = "test_webhook_secret";
function make(extra: Partial<ConstructorParameters<typeof TelegramChannel>[0]> = {}) {
  return new TelegramChannel({
    tokenSecret: "test",
    secrets: { reveal: async () => fake.token },
    allowlist: [42, -42],
    offsetStore: new MemoryOffsetStore(),
    baseUrl: fake.baseUrl,
    sleep: async () => {},
    mode: "webhook",
    webhook: { url: "https://example.test/telegram", secret },
    ...extra,
  });
}
function update(id: number, fields: Record<string, unknown> = {}) {
  const u = textUpdate(id, -42, "@testbot hello");
  return {
    ...u,
    message: {
      ...u.message,
      chat: { id: -42, type: "supergroup", is_forum: true },
      from: { id: 42 },
      ...fields,
    },
  };
}
async function deliver(ch: TelegramChannel, u: unknown, s = secret) {
  return ch.handleWebhook(
    new Request("https://example.test/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": s },
      body: JSON.stringify(u),
    }),
  );
}

test("framework contract, topic routing and sender identity survive an outbound reply", async () => {
  const got: InboundMessage[] = [];
  const ch = make({ botUsername: "testbot" });
  const framework: Channel = ch;
  await framework.start({
    ...host,
    receive: async (m) => {
      got.push(m as InboundMessage);
      await framework.send({
        chatId: m.chatId,
        text: "reply",
        ...(m.messageId !== undefined ? { replyTo: m.messageId } : {}),
      });
    },
  });
  try {
    assert.equal((await deliver(ch, update(1, { message_thread_id: 7 }))).status, 200);
    assert.equal(got[0]!.chatId, "-42:7");
    assert.equal(got[0]!.senderId, "42");
    assert.equal(got[0]!.chatKind, "group");
    assert.equal(fake.callsOf("sendMessage")[0]!.body.message_thread_id, 7);
    assert.deepEqual(fake.callsOf("sendMessage")[0]!.body.reply_parameters, {
      message_id: 10,
    });
    assert.deepEqual(await framework.health(), { ok: true });
  } finally {
    await ch.stop();
  }
});

test("group mention/reply/command policy, user allowlist and bot self suppression", async () => {
  const got: InboundMessage[] = [];
  const ch = make({ botUsername: "testbot", botId: 99, userAllowlist: [42] });
  ch.onMessage((m) => void got.push(m));
  await ch.start();
  try {
    await deliver(ch, update(1, { text: "noise" }));
    await deliver(ch, update(2, { text: "@testbotx wrong" }));
    await deliver(ch, update(3, { from: { id: 9 }, text: "@testbot denied" }));
    await deliver(ch, update(4, { from: { id: 99, is_bot: true } }));
    await deliver(ch, update(5, { text: "reply", reply_to_message: { from: { id: 99 } } }));
    await deliver(ch, update(6, { text: "/new@testbot" }));
    await deliver(ch, update(7, { text: "/new@otherbot" }));
    assert.deepEqual(
      got.map((m) => m.text),
      ["reply", "/new"],
    );
  } finally {
    await ch.stop();
  }
});

test("webhook rejects secrets/malformed bodies, deduplicates and polling removes webhook", async () => {
  const got: InboundMessage[] = [];
  const ch = make();
  ch.onMessage((m) => void got.push(m));
  await ch.start();
  try {
    assert.equal(fake.callsOf("setWebhook")[0]!.body.secret_token, secret);
    assert.equal(fake.callsOf("getUpdates").length, 0);
    assert.equal((await deliver(ch, textUpdate(1, 42, "hi"), "wrong")).status, 403);
    await Promise.all([deliver(ch, textUpdate(1, 42, "hi")), deliver(ch, textUpdate(1, 42, "hi"))]);
    assert.equal(got.length, 1);
    assert.equal((await deliver(ch, { nope: true })).status, 400);
  } finally {
    await ch.stop();
  }
  const poll = make({ mode: "polling" });
  await poll.start();
  await poll.stop();
  assert.equal(fake.callsOf("deleteWebhook").length, 1);
});

test("incoming photo/document/voice/audio/video become bounded attachments with captions", async () => {
  const got: InboundMessage[] = [];
  const ch = make({ groupPolicy: "all" });
  ch.onMessage((m) => void got.push(m));
  await ch.start();
  try {
    for (const [i, kind] of ["photo", "document", "voice", "audio", "video"].entries()) {
      const mime =
        kind === "photo"
          ? "image/jpeg"
          : kind === "document"
            ? "application/pdf"
            : kind === "video"
              ? "video/mp4"
              : "audio/ogg";
      fake.files.set(kind, {
        path: `files/${kind}`,
        mime,
        data: Buffer.from("fixture"),
      });
      const media = { file_id: kind, file_size: 7, mime_type: mime };
      await deliver(
        ch,
        update(i + 1, {
          text: undefined,
          caption: "caption",
          [kind]: kind === "photo" ? [media] : media,
        }),
      );
    }
    assert.equal(got.length, 5);
    assert.ok(got.every((m) => m.text === "caption" && m.attachments?.[0]?.data.length === 7));
    assert.equal(fake.callsOf("getFile").length, 5);
  } finally {
    await ch.stop();
  }
});

test("media size, MIME and unsafe file paths fail closed without leaking token", async () => {
  const got: InboundMessage[] = [];
  const logs: string[] = [];
  const ch = make({
    maxMediaBytes: 8,
    logger: { log: (l, e, a) => void logs.push(JSON.stringify([l, e, a])) },
  });
  ch.onMessage((m) => void got.push(m));
  await ch.start();
  try {
    fake.files.set("big", {
      path: "files/big",
      mime: "application/pdf",
      data: Buffer.alloc(9),
    });
    fake.files.set("unsafe", {
      path: `https://evil.test/${fake.token}`,
      mime: "application/pdf",
      data: Buffer.from("x"),
    });
    fake.files.set("mime", {
      path: "files/mime",
      mime: "text/html",
      data: Buffer.from("x"),
    });
    for (const [i, id] of ["big", "unsafe", "mime"].entries())
      await deliver(ch, {
        ...textUpdate(i + 1, 42, "caption"),
        message: {
          ...textUpdate(i + 1, 42, "caption").message,
          document: { file_id: id, mime_type: "application/pdf" },
        },
      });
    assert.equal(got.length, 0);
    assert.ok(!logs.join("").includes(fake.token));
  } finally {
    await ch.stop();
  }
});

test("outbound multipart photo/document/voice, safe escaping and parse fallback", async () => {
  const ch = make();
  await ch.start();
  try {
    await ch.sendTurn({
      chatId: "42",
      text: "_*[]()~`>#+-=|{}.!\\<>&",
      parseMode: "MarkdownV2",
      attachments: [
        { kind: "photo", mimeType: "image/jpeg", data: Buffer.from("jpg") },
        {
          kind: "document",
          mimeType: "application/pdf",
          data: Buffer.from("pdf"),
        },
        { kind: "voice", mimeType: "audio/ogg", data: Buffer.from("ogg") },
      ],
    });
    for (const method of ["sendPhoto", "sendDocument", "sendVoice"]) assert.equal(fake.callsOf(method).length, 1);
    assert.equal(fake.callsOf("sendMessage")[0]!.body.text, escapeText("_*[]()~`>#+-=|{}.!\\<>&", "MarkdownV2"));
    fake.failNext("sendMessage", 400, {
      ok: false,
      error_code: 400,
      description: "Bad Request: can't parse entities",
    });
    await ch.sendTurn({ chatId: "42", text: "<hello>", parseMode: "HTML" });
    const last = fake.callsOf("sendMessage").at(-1)!;
    assert.equal(last.body.text, "<hello>");
    assert.equal(last.body.parse_mode, undefined);
  } finally {
    await ch.stop();
  }
});

test("callbacks are signed, chat/user bound, expired/replayed rejected and always acknowledged", async () => {
  let now = 1000;
  const got: InboundMessage[] = [];
  const ch = make({ now: () => now });
  ch.onMessage((m) => void got.push(m));
  await ch.start();
  try {
    await ch.sendTurn({
      chatId: "42",
      text: "confirm?",
      buttons: [[{ text: "Yes", data: "approve", senderId: "42", ttlMs: 100 }]],
    });
    const markup = fake.callsOf("sendMessage")[0]!.body.reply_markup as {
      inline_keyboard: { callback_data: string }[][];
    };
    const data = markup.inline_keyboard[0]![0]!.callback_data;
    assert.ok(Buffer.byteLength(data) <= 64);
    const cb = (id: number, sender = 42, d = data) => ({
      update_id: id,
      callback_query: {
        id: String(id),
        from: { id: sender },
        data: d,
        message: textUpdate(1, 42, "").message,
      },
    });
    await deliver(ch, cb(1, 9));
    await deliver(ch, cb(2));
    await deliver(ch, cb(3));
    assert.equal(got.length, 1);
    assert.equal(got[0]!.callback?.data, "approve");
    now = 2000;
    await deliver(ch, cb(4));
    await deliver(ch, cb(5, 42, "forged"));
    assert.equal(fake.callsOf("answerCallbackQuery").length, 5);
    assert.match(String(fake.callsOf("answerCallbackQuery").at(-1)!.body.text), /expired|invalid/i);
  } finally {
    await ch.stop();
  }
});

test("commands register de/en by scope; start payload forwarded, /web uses port only in DMs", async () => {
  const got: InboundMessage[] = [];
  const requests: string[] = [];
  const ch = make({
    webLinkProvider: {
      createLink: async (m) => {
        requests.push(m.chatId);
        return "https://web.test/continue?token=single-use";
      },
    },
  });
  ch.onMessage((m) => void got.push(m));
  await ch.start();
  try {
    assert.equal(fake.callsOf("setMyCommands").length, 4);
    await deliver(ch, textUpdate(1, 42, "/start invite_123"));
    assert.equal(got[0]!.command?.argument, "invite_123");
    await deliver(ch, textUpdate(2, 42, "/web"));
    assert.deepEqual(requests, ["42"]);
    assert.match(String(fake.callsOf("sendMessage").at(-1)!.body.text), /https:\/\/web.test/);
    await deliver(ch, update(3, { text: "/web" }));
    assert.equal(requests.length, 1);
  } finally {
    await ch.stop();
  }
  const unconfigured = make();
  await unconfigured.start();
  try {
    await deliver(unconfigured, textUpdate(1, 42, "/web"));
    assert.match(String(fake.callsOf("sendMessage").at(-1)!.body.text), /nicht konfiguriert/);
  } finally {
    await unconfigured.stop();
  }
});

test("403 inactivates only the target chat, 400 is typed, migration moves allowlist", async () => {
  const ch = make();
  await ch.start();
  try {
    fake.failNext("sendMessage", 403, {
      ok: false,
      error_code: 403,
      description: "Forbidden",
    });
    await assert.rejects(ch.send("42", "x"), { kind: "forbidden" });
    await assert.rejects(ch.send("42", "x"), /inactive/);
    await ch.send("-42", "ok");
    fake.failNext("sendMessage", 400, {
      ok: false,
      error_code: 400,
      description: "Bad Request",
    });
    await assert.rejects(ch.send("-42", "x"), { kind: "bad-request" });
    await deliver(ch, update(1, { migrate_to_chat_id: -10042 }));
    await ch.send("-42", "moved");
    assert.equal(fake.callsOf("sendMessage").at(-1)!.body.chat_id, "-10042");
  } finally {
    await ch.stop();
  }
});

test("token bucket refills with fake time; callback signer rejects tampering and Unicode overflow", async () => {
  let now = 0;
  const waits: number[] = [];
  const bucket = new TokenBucket(
    1,
    1000,
    () => now,
    async (ms) => {
      waits.push(ms);
      now += ms;
    },
  );
  await bucket.take(new AbortController().signal);
  await bucket.take(new AbortController().signal);
  assert.deepEqual(waits, [1000]);
  const signer = new CallbackSigner("test-key", () => now);
  const data = signer.issue({
    chatId: "42",
    senderId: "42",
    data: "yes",
    ttlMs: 10,
  });
  assert.ok(Buffer.byteLength(data) <= 64);
  assert.equal(signer.consume(data, "42", "9"), undefined);
  assert.equal(signer.consume(data, "42", "42")?.data, "yes");
  assert.equal(signer.consume(data, "42", "42"), undefined);
  assert.throws(() => signer.issue({ chatId: "42", data: "😀".repeat(1000), ttlMs: 10 }), /data/);
});

test("network retries use deterministic jitter; failing callback consumers still get acknowledged", async () => {
  let fail = false;
  const waits: number[] = [];
  const logs: string[] = [];
  const ch = make({
    random: () => 0.5,
    sleep: async (ms) => void waits.push(ms),
    logger: { log: (l, e, a) => void logs.push(JSON.stringify([l, e, a])) },
    fetch: async (url, init) => {
      if (fail) {
        fail = false;
        throw new Error(`request ${fake.token}`);
      }
      return fetch(url, init);
    },
  });
  await ch.start();
  try {
    fail = true;
    await ch.send("42", "retry");
    assert.equal(waits[0], 1000);
    ch.onMessage(() => {
      throw new Error(fake.token);
    });
    await ch.prompt("42", "Confirm", [[{ text: "Yes", data: "yes" }]]);
    const markup = fake.callsOf("sendMessage").at(-1)!.body.reply_markup as {
      inline_keyboard: { callback_data: string }[][];
    };
    await deliver(ch, {
      update_id: 1,
      callback_query: {
        id: "1",
        from: { id: 42 },
        data: markup.inline_keyboard[0]![0]!.callback_data,
        message: textUpdate(1, 42, "").message,
      },
    });
    assert.equal(fake.callsOf("answerCallbackQuery").length, 1);
    assert.ok(!logs.join("").includes(fake.token));
  } finally {
    await ch.stop();
  }
});

test("webhook body limits and HTTP method are enforced; stop disables sends and health", async () => {
  const ch = make({
    webhook: { url: "https://example.test", secret, maxBodyBytes: 100 },
  });
  await ch.start();
  assert.equal((await deliver(ch, textUpdate(1, 42, "x".repeat(200)))).status, 413);
  assert.equal(
    (
      await ch.handleWebhook(
        new Request("https://example.test", {
          headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
        }),
      )
    ).status,
    405,
  );
  await ch.stop();
  assert.deepEqual(await ch.health(), { ok: false });
  await assert.rejects(ch.send("42", "after"), /not started/);
  assert.equal((await deliver(ch, textUpdate(2, 42, "x"))).status, 503);
});

test("UTF-16 entities and long code blocks remain valid in independently formatted chunks", async () => {
  const ch = make();
  await ch.start();
  try {
    const text = "😀".repeat(3000);
    await ch.sendTurn({
      chatId: "42",
      text,
      entities: [{ type: "pre", offset: 0, length: text.length, language: "ts" }],
    });
    const sent = fake.callsOf("sendMessage");
    assert.equal(sent.length, 2);
    assert.equal(sent.map((c) => c.body.text).join(""), text);
    for (const c of sent) {
      const entities = c.body.entities as {
        type: string;
        offset: number;
        length: number;
      }[];
      assert.deepEqual(
        entities.map((e) => [e.type, e.offset, e.length]),
        [["pre", 0, String(c.body.text).length]],
      );
    }
  } finally {
    await ch.stop();
  }
});

test("global and per-group reservations serialize concurrent sends across topics", async () => {
  let now = 0;
  const waits: number[] = [];
  const ch = make({
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  await ch.start();
  try {
    await Promise.all([ch.send("-42:1", "one"), ch.send("-42:2", "two"), ch.send("-42:3", "three")]);
    assert.deepEqual(waits, [3000, 3000]);
  } finally {
    await ch.stop();
  }
  now = 0;
  waits.length = 0;
  const bucket = new TokenBucket(
    30,
    1000 / 30,
    () => now,
    async (ms) => {
      waits.push(ms);
      now += ms;
    },
  );
  await Promise.all(Array.from({ length: 31 }, () => bucket.take(new AbortController().signal)));
  assert.equal(waits.length, 1);
  assert.equal(waits[0], 34);
});

test("group migration is durable with FileOffsetStore across channel instances", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { FileOffsetStore } = await import("../src/index.ts");
  const dir = await mkdtemp(join(tmpdir(), "tg-migrate-"));
  try {
    const ch = make({ offsetStore: new FileOffsetStore(dir) });
    await ch.start();
    await deliver(ch, update(1, { migrate_to_chat_id: -10042 }));
    await ch.stop();
    const next = make({ offsetStore: new FileOffsetStore(dir) });
    await next.start();
    try {
      await next.send("-42:7", "resumed");
      assert.equal(fake.callsOf("sendMessage").at(-1)!.body.chat_id, "-10042");
      assert.equal(fake.callsOf("sendMessage").at(-1)!.body.message_thread_id, 7);
    } finally {
      await next.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent start is idempotent; restart clears inactive chats and outstanding callbacks", async () => {
  const ch = make();
  await Promise.all([ch.start(), ch.start()]);
  try {
    assert.equal(fake.callsOf("getMe").length, 1);
    await ch.prompt("42", "Confirm", [[{ text: "Yes", data: "yes" }]]);
    const markup = fake.callsOf("sendMessage").at(-1)!.body.reply_markup as {
      inline_keyboard: { callback_data: string }[][];
    };
    const data = markup.inline_keyboard[0]![0]!.callback_data;
    fake.failNext("sendMessage", 403, { ok: false, error_code: 403 });
    await assert.rejects(ch.send("42", "blocked"));
    await ch.stop();
    await ch.start();
    await ch.send("42", "unblocked");
    const got: InboundMessage[] = [];
    ch.onMessage((m) => void got.push(m));
    await deliver(ch, {
      update_id: 1,
      callback_query: { id: "1", from: { id: 42 }, data, message: textUpdate(1, 42, "").message },
    });
    assert.equal(got.length, 0);
  } finally {
    await ch.stop();
  }
});

test("stop during asynchronous secret reading cannot resurrect a channel", async () => {
  let resolveSecret: ((s: string) => void) | undefined;
  const ch = make({
    secrets: {
      reveal: () =>
        new Promise<string>((r) => {
          resolveSecret = r;
        }),
    },
  });
  const started = ch.start().catch(() => {});
  const stopped = ch.stop();
  resolveSecret!(fake.token);
  await Promise.all([started, stopped]);
  assert.deepEqual(await ch.health(), { ok: false });
  assert.equal(fake.callsOf("setWebhook").length, 0);
});

test("real framework router resolves the Telegram sender and isolates sessions per forum topic", async () => {
  const { ChannelRouter } = await import("../../core/src/channels/router.ts");
  const { systemClock } = await import("../../core/src/channels/clock.ts");
  const sessions = new Map<string, string>();
  const senders: string[] = [];
  const submitted: { userId: string; text: string }[] = [];
  const router = new ChannelRouter({
    identity: {
      resolve: async (sender) => {
        senders.push(sender.senderId);
        return { linked: true, userId: "linked-person" };
      },
      claimPairing: async () => ({ ok: false }),
    },
    sessions: {
      findActive: async (chat) => sessions.get(chat.chatId) ?? null,
      create: async (chat, owner) => {
        assert.equal(owner.userId, "linked-person");
        const id = `session-${sessions.size}`;
        sessions.set(chat.chatId, id);
        return id;
      },
      archive: async () => {},
      submit: async (_id, input) => {
        submitted.push(input);
        return { text: "answer" };
      },
    },
    clock: systemClock,
    log: host.log,
  });
  const ch = make({ botUsername: "testbot" });
  await ch.start({ ...host, receive: (msg) => router.handle(msg, (out) => ch.send(out)) });
  try {
    await deliver(ch, update(1, { message_thread_id: 7 }));
    await deliver(ch, update(2, { message_thread_id: 8 }));
    assert.deepEqual([...sessions.keys()], ["-42:7", "-42:8"]);
    assert.deepEqual(senders, ["42", "42"]);
    assert.ok(submitted.every((input) => input.userId === "linked-person"));
    assert.deepEqual(
      fake.callsOf("sendMessage").map((c) => c.body.message_thread_id),
      [7, 8],
    );
  } finally {
    await ch.stop();
  }
});

test("media getFile rate limits and download network errors retry without losing the turn", async () => {
  let failDownload = true;
  const waits: number[] = [];
  const got: InboundMessage[] = [];
  const ch = make({
    sleep: async (ms) => void waits.push(ms),
    random: () => 0.5,
    fetch: async (url, init) => {
      if (String(url).includes("/file/") && failDownload) {
        failDownload = false;
        throw new Error(fake.token);
      }
      return fetch(url, init);
    },
  });
  ch.onMessage((m) => void got.push(m));
  await ch.start();
  try {
    fake.files.set("retry", { path: "files/retry", mime: "application/octet-stream", data: Buffer.from("media") });
    fake.failNext("getFile", 429, { ok: false, error_code: 429, parameters: { retry_after: 2 } });
    await deliver(ch, { update_id: 1, message: { ...textUpdate(1, 42, "").message, photo: [{ file_id: "retry" }] } });
    assert.equal(got.length, 1);
    assert.equal(got[0]!.attachments![0]!.mimeType, "image/jpeg");
    assert.ok(waits.includes(2000));
    assert.equal(fake.callsOf("getFile").length, 2);
    assert.equal(failDownload, false);
  } finally {
    await ch.stop();
  }
});
