import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordApiError, MemoryGatewayStateStore, FileGatewayStateStore, MESSAGES, type GatewayStateStore } from "../src/index.ts";
import { makeEnv, started, type Env } from "./helpers/env.ts";
import { drive } from "./helpers/fake-clock.ts";
import { BOT_ID, DM_CHANNEL, DM_USER, GROUP_USER, GUILD_CHANNEL, OTHER_USER, TOKEN, snowflake } from "./helpers/fake-discord.ts";

const NOT_ALLOWED_CHANNEL = "888000000000000001";
const DM_CHANNEL_OTHER = "999000000000000001";
let seq = 0;
const id = () => snowflake(++seq + 5000);

function base(over: Record<string, unknown>) {
  return {
    id: id(),
    type: 0,
    content: "",
    timestamp: new Date(1_700_000_000_000).toISOString(),
    mentions: [],
    attachments: [],
    ...over,
  };
}
const dm = (content: string, over: Record<string, unknown> = {}) =>
  base({ channel_id: DM_CHANNEL, author: { id: DM_USER }, content, ...over });
const guild = (content: string, author = GROUP_USER, over: Record<string, unknown> = {}) =>
  base({ guild_id: "444000000000000001", channel_id: GUILD_CHANNEL, author: { id: author }, content, ...over });
const mention = (content: string, author = GROUP_USER) =>
  guild(`<@${BOT_ID}> ${content}`, author, { mentions: [{ id: BOT_ID }] });

async function emit(e: Env, t: string, d: unknown): Promise<void> {
  await e.gateway.whenReady();
  e.gateway.dispatch(t, d);
  await e.current!.idle();
}
async function finish(e: Env, ch: { stop(): Promise<void> }): Promise<void> {
  await ch.stop();
  await e.close();
}

// ---- lifecycle ---------------------------------------------------------------------------------------------

test("lifecycle: concurrent starts share one start; start/stop are idempotent; health follows the connection", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await Promise.all([ch.start(e.host), ch.start(e.host)]);
  await ch.start(e.host);
  assert.equal(e.rest.callsOf("GET", "/api/v10/users/@me").length, 1);
  await e.gateway.whenReady();
  assert.deepEqual(await ch.health(), { ok: true, detail: "connected" });
  await ch.stop();
  await ch.stop();
  assert.equal((await ch.health()).ok, false);
  assert.ok(e.gateway.sockets[0]!.closed, "stop closes the gateway socket");
  await e.close();
});

test("lifecycle: restart works and resumes the stored session (RESUME, not IDENTIFY)", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  await ch.stop();
  assert.equal(e.gateway.sockets[0]!.closed?.code, 4000, "stop uses a resumable close code");
  assert.equal(e.gateway.sockets[0]!.sent[0]!.op, 2);
  const saved = await e.deps.stateStore!.load();
  assert.equal(saved?.sessionId, "session-1");
  await ch.start(e.host);
  for (let i = 0; i < 50 && (e.gateway.sockets[1]?.sent.length ?? 0) === 0; i++) await e.clock.flush();
  assert.equal(e.gateway.sockets[1]!.sent[0]!.op, 6, "restart resumes");
  assert.equal((e.gateway.sockets[1]!.sent[0]!.d as { session_id: string }).session_id, "session-1");
  assert.equal((await ch.health()).ok, true);
  await finish(e, ch);
});

test("lifecycle: a missing secret rejects start without leaking anything", async () => {
  const e = await makeEnv();
  const ch = e.channel({}, { secrets: { reveal: async () => null } });
  await assert.rejects(ch.start(e.host), (err: unknown) => err instanceof DiscordApiError && err.kind === "protocol");
  assert.equal(e.rest.calls.length, 0);
  assert.ok(!JSON.stringify(e.logs).includes(TOKEN));
  await e.close();
});

test("lifecycle: a malformed token is refused before any request, without echoing it", async () => {
  const e = await makeEnv();
  const bad = "not-a-real-token-but-secret-looking-value";
  const ch = e.channel({}, { secrets: { reveal: async () => bad } });
  await assert.rejects(ch.start(e.host), (err: Error) => !err.message.includes(bad));
  assert.equal(e.rest.calls.length, 0);
  await e.close();
});

test("lifecycle: a secret reader failure rejects start with a fixed message", async () => {
  const e = await makeEnv();
  const ch = e.channel({}, { secrets: { reveal: async () => { throw new Error(`boom ${TOKEN}`); } } });
  await assert.rejects(ch.start(e.host), (err: Error) => err.message === "discord secret read failed");
  assert.ok(!JSON.stringify(e.logs).includes(TOKEN));
  await e.close();
});

test("lifecycle: an invalid token (401) rejects start, is not retried, and never shows the token", async () => {
  const e = await makeEnv();
  e.rest.fail("GET /api/v10/users/@me", { status: 401, body: { message: `401 ${TOKEN}`, code: 0 } });
  const ch = e.channel();
  await assert.rejects(ch.start(e.host), (err: unknown) => err instanceof DiscordApiError && err.kind === "unauthorized");
  assert.equal(e.rest.callsOf("GET").length, 1);
  assert.equal(e.gateway.sockets.length, 0);
  assert.equal((await ch.health()).ok, false);
  await e.close();
});

test("lifecycle: fatal close 4004 calls host.fail once and never retries", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  e.gateway.latest.remoteClose(4004);
  await drive(e.clock, new Promise((r) => setTimeout(r, 0)));
  await e.clock.advance(120_000);
  assert.equal(e.failures.length, 1);
  assert.equal(e.gateway.sockets.length, 1);
  assert.equal((await ch.health()).ok, false);
  assert.ok(!JSON.stringify([e.failures, e.logs]).includes(TOKEN));
  await finish(e, ch);
});

test("lifecycle: retryable close reconnects with backoff and health reports reconnecting", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  e.gateway.latest.remoteClose(1006);
  await e.clock.flush();
  assert.equal((await ch.health()).detail, "reconnecting");
  await e.clock.advance(5000);
  await e.gateway.whenReady();
  assert.equal(e.gateway.sockets.length, 2);
  assert.equal((await ch.health()).ok, true);
  assert.equal(e.failures.length, 0);
  await finish(e, ch);
});

test("lifecycle: a corrupt persisted gateway state fails closed (start rejects, no socket)", async () => {
  const bad: GatewayStateStore = {
    load: async () => {
      throw new Error("discord gateway state is invalid");
    },
    save: async () => {},
    clear: async () => {},
  };
  const e = await makeEnv();
  const ch = e.channel({}, { stateStore: bad });
  await assert.rejects(ch.start(e.host));
  assert.equal(e.gateway.sockets.length, 0);
  await e.close();
});

test("lifecycle: file state store round-trips and rejects a corrupt file (fail closed)", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "discord-state-"));
  try {
    const store = new FileGatewayStateStore(dir);
    assert.equal(await store.load(), undefined);
    await store.save({ sessionId: "abc_1", seq: 9, resumeGatewayUrl: "wss://resume.discord.gg", botId: BOT_ID });
    assert.equal((await store.load())?.seq, 9);
    await writeFile(join(dir, "discord-gateway.json"), '{"sessionId":"x","resumeGatewayUrl":"https://evil.example"}');
    await assert.rejects(store.load(), (err: Error) => !err.message.includes("evil"));
    await writeFile(join(dir, "discord-gateway.json"), "{nope");
    await assert.rejects(store.load());
    await assert.rejects(store.save({ sessionId: "x", seq: -1, resumeGatewayUrl: "wss://resume.discord.gg", botId: BOT_ID }));
    await new FileGatewayStateStore(dir).clear();
    assert.equal(await new FileGatewayStateStore(dir).load(), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lifecycle: commands are bulk-overwritten on start; /link only with a pairing port", async () => {
  const pairing = { claim: () => ({ pairingId: "p", state: "awaiting-confirmation" as const, confirmBy: 1 }) } as never;
  const e = await makeEnv();
  const withPairing = e.channel({}, { pairing });
  await started(e, withPairing);
  await withPairing.stop();
  await withPairing.start(e.host);
  type Cmd = { name: string; contexts?: number[]; options?: { type: number; name: string; required?: boolean; description: string; description_localizations?: { de: string } }[] };
  const [first, second] = e.rest.commandSets as Cmd[][];
  assert.deepEqual(first?.map((c) => c.name), ["link", "status"]);
  assert.deepEqual(first, second, "idempotent: identical bulk overwrite");
  assert.deepEqual(first![0]!.contexts, [1], "link is DM-only");
  const code = first![0]!.options![0]!;
  assert.deepEqual([code.type, code.name, code.required], [3, "code", true]);
  assert.deepEqual(code.description_localizations, { de: MESSAGES.de.cmdLinkCode });
  await finish(e, withPairing);

  const e2 = await makeEnv();
  const plain = e2.channel();
  await started(e2, plain);
  assert.deepEqual((e2.rest.commandSets[0] as Array<{ name: string }>).map((c) => c.name), ["status"]);
  await finish(e2, plain);
});

test("lifecycle: a crashing handler does not stop the inbound loop", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  ch.onMessage(async (m) => {
    if (m.text === "boom") throw new Error("handler exploded");
  });
  await emit(e, "MESSAGE_CREATE", dm("boom"));
  await emit(e, "MESSAGE_CREATE", dm("after"));
  assert.deepEqual(e.received.map((m) => (m as { text: string }).text), ["boom", "after"]);
  assert.ok(e.logs.some((l) => l.event === "channel.discord.handler-failed"));
  await finish(e, ch);
});

// ---- inbound -----------------------------------------------------------------------------------------------

type Row = { name: string; msg: () => unknown; received: boolean; addressed?: boolean; text?: string; chatKind?: string; threadId?: string };
const inboundRows: Row[] = [
  { name: "DM from a dmAllowlist sender", msg: () => dm("hi"), received: true, addressed: true, chatKind: "direct", text: "hi" },
  { name: "DM from a stranger", msg: () => dm("hi", { author: { id: OTHER_USER } }), received: false },
  { name: "DM in a channel that is not listed, from a listed-guild human", msg: () => dm("x", { channel_id: NOT_ALLOWED_CHANNEL, author: { id: GROUP_USER } }), received: false },
  { name: "group mention <@id>", msg: () => mention("hello"), received: true, addressed: true, chatKind: "group", text: "hello" },
  { name: "group mention nickname form <@!id>", msg: () => guild(`<@!${BOT_ID}> nick`, GROUP_USER, { mentions: [{ id: BOT_ID }] }), received: true, addressed: true, text: "nick" },
  { name: "group unmentioned under the mention policy", msg: () => guild("chatter"), received: false },
  { name: "group reply to a bot message counts as addressing", msg: () => guild("and?", GROUP_USER, { referenced_message: { author: { id: BOT_ID } }, message_reference: { message_id: "1" } }), received: true, addressed: true, text: "and?" },
  { name: "group mention in an unlisted channel", msg: () => base({ guild_id: "444000000000000001", channel_id: NOT_ALLOWED_CHANNEL, author: { id: GROUP_USER }, content: `<@${BOT_ID}> x`, mentions: [{ id: BOT_ID }] }), received: false },
  { name: "message from a bot account", msg: () => base({ guild_id: "444000000000000001", channel_id: GUILD_CHANNEL, author: { id: "777777777777777777", bot: true }, content: `<@${BOT_ID}> bot`, mentions: [{ id: BOT_ID }] }), received: false },
  { name: "own message (loop prevention)", msg: () => mention("self", BOT_ID), received: false },
  { name: "system message (type 7)", msg: () => ({ ...(mention("sys") as object), type: 7 }), received: false },
  { name: "empty text without attachments", msg: () => mention(""), received: false },
];

test("inbound: the policy table (DM/group, mention, reply, allowlists, loop prevention)", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  for (const row of inboundRows) {
    e.received.length = 0;
    await emit(e, "MESSAGE_CREATE", row.msg());
    assert.equal(e.received.length, row.received ? 1 : 0, row.name);
    if (row.received) {
      const m = e.received[0] as { addressed: boolean; text: string; chatKind: string; threadId?: string; channel: string; accountId: string; senderId: string };
      assert.equal(m.channel, "discord", row.name);
      assert.equal(m.accountId, BOT_ID, `${row.name}: accountId is the bot user id`);
      assert.equal(m.senderId.length > 0, true);
      if (row.addressed !== undefined) assert.equal(m.addressed, row.addressed, row.name);
      if (row.text !== undefined) assert.equal(m.text, row.text, row.name);
      if (row.chatKind !== undefined) assert.equal(m.chatKind, row.chatKind, row.name);
      if (row.threadId !== undefined) assert.equal(m.threadId, row.threadId, row.name);
    }
  }
  await finish(e, ch);
});

const THREAD = "666000000000000001";
test("threads: a thread of a listed parent is a chat with threadId; an unlisted parent is refused", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  await emit(e, "THREAD_CREATE", { id: THREAD, parent_id: GUILD_CHANNEL, type: 11, guild_id: "444000000000000001" });
  await emit(e, "MESSAGE_CREATE", base({ guild_id: "444000000000000001", channel_id: THREAD, author: { id: GROUP_USER }, content: `<@${BOT_ID}> in thread`, mentions: [{ id: BOT_ID }] }));
  assert.equal(e.received.length, 1);
  const m = e.received[0] as { chatId: string; threadId?: string; text: string };
  assert.equal(m.chatId, THREAD, "the thread is the conversation");
  assert.equal(m.threadId, THREAD);
  assert.equal(m.text, "in thread");
  await ch.sendTurn({ chatId: THREAD, text: "reply in thread" });
  assert.equal(e.rest.messages.at(-1)!.channelId, THREAD);
  await emit(e, "THREAD_CREATE", { id: "667000000000000001", parent_id: NOT_ALLOWED_CHANNEL, type: 11 });
  await emit(e, "MESSAGE_CREATE", base({ guild_id: "444000000000000001", channel_id: "667000000000000001", author: { id: GROUP_USER }, content: `<@${BOT_ID}> nope`, mentions: [{ id: BOT_ID }] }));
  assert.equal(e.received.length, 1, "unlisted parent refused");
  await assert.rejects(ch.send({ chatId: "667000000000000001", text: "x" }), /allowlist/);
  await finish(e, ch);
});

test("threads: a thread archived in a guild snapshot (GUILD_CREATE) is known without a live event", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  await emit(e, "GUILD_CREATE", { id: "444000000000000001", threads: [{ id: THREAD, parent_id: GUILD_CHANNEL }] });
  await emit(e, "MESSAGE_CREATE", base({ guild_id: "444000000000000001", channel_id: THREAD, author: { id: GROUP_USER }, content: `<@${BOT_ID}> snap`, mentions: [{ id: BOT_ID }] }));
  assert.equal(e.received.length, 1);
  await finish(e, ch);
});

test("inbound: replyPolicy always hears unmentioned group messages from listed chats", async () => {
  const e = await makeEnv({ replyPolicy: "always" });
  const ch = e.channel();
  await started(e, ch);
  await emit(e, "MESSAGE_CREATE", guild("plain chatter"));
  assert.equal(e.received.length, 1);
  assert.equal((e.received[0] as { addressed: boolean }).addressed, false);
  await finish(e, ch);
});

test("inbound: replyPolicy allowlist and userAllowlist decide who is heard", async () => {
  const e = await makeEnv({ replyPolicy: "allowlist", userAllowlist: [GROUP_USER] });
  const ch = e.channel();
  await started(e, ch);
  await emit(e, "MESSAGE_CREATE", guild("from a listed user"));
  await emit(e, "MESSAGE_CREATE", guild("from someone else", OTHER_USER));
  await emit(e, "MESSAGE_CREATE", mention("mentioned but not listed", OTHER_USER));
  assert.deepEqual(e.received.map((m) => (m as { text: string }).text), ["from a listed user"]);
  await finish(e, ch);
});

test("inbound: userAllowlist excludes unlisted speakers even when they mention the bot", async () => {
  const e = await makeEnv({ replyPolicy: "always", userAllowlist: [GROUP_USER] });
  const ch = e.channel();
  await started(e, ch);
  await emit(e, "MESSAGE_CREATE", mention("hey", OTHER_USER));
  assert.equal(e.received.length, 0);
  await finish(e, ch);
});

test("inbound: a DM channel listed on the allowlist admits any sender there", async () => {
  const e = await makeEnv({ allowlist: [GUILD_CHANNEL, DM_CHANNEL_OTHER] });
  const ch = e.channel();
  await started(e, ch);
  await emit(e, "MESSAGE_CREATE", dm("listed channel", { channel_id: DM_CHANNEL_OTHER, author: { id: OTHER_USER } }));
  assert.equal(e.received.length, 1);
  await finish(e, ch);
});

test("inbound: duplicate MESSAGE_CREATE ids are processed once", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  const m = dm("once");
  await emit(e, "MESSAGE_CREATE", m);
  await emit(e, "MESSAGE_CREATE", m);
  assert.equal(e.received.length, 1);
  await finish(e, ch);
});

test("inbound: the host gets text-only turns; rich turns go through onMessage and log the gap", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  const rich: unknown[] = [];
  ch.onMessage((m) => void rich.push(m));
  e.rest.cdn.set("/attachments/1/2/pic.png", { mime: "image/png", data: Buffer.from("PNGDATA") });
  await emit(e, "MESSAGE_CREATE", dm("look", { attachments: [{ id: "1", filename: "pic.png", size: 7, url: "https://cdn.discordapp.com/attachments/1/2/pic.png", content_type: "image/png" }] }));
  assert.equal(rich.length, 1);
  const att = (rich[0] as { attachments: { kind: string; data: Uint8Array; mimeType: string }[] }).attachments[0]!;
  assert.equal(att.kind, "image");
  assert.equal(att.mimeType, "image/png");
  assert.equal(Buffer.from(att.data).toString(), "PNGDATA");
  assert.equal(e.received.length, 0, "framework path does not carry attachments");
  assert.ok(e.logs.some((l) => l.event === "channel.discord.framework-rich-turn-gap"));
  await finish(e, ch);
});

const mediaRows: Array<[string, Record<string, unknown>, () => void]> = [
  ["oversize by declared size", { size: 10_000_000, url: "https://cdn.discordapp.com/attachments/1/2/a.png", content_type: "image/png" }, () => {}],
  ["disallowed MIME (text/html)", { size: 7, url: "https://cdn.discordapp.com/attachments/1/2/a.html", content_type: "text/html" }, () => {}],
  ["disallowed MIME (svg)", { size: 7, url: "https://cdn.discordapp.com/attachments/1/2/a.svg", content_type: "image/svg+xml" }, () => {}],
  ["non-CDN host", { size: 7, url: "https://evil.example/a.png", content_type: "image/png" }, () => {}],
  ["downloaded MIME mismatch", { size: 7, url: "https://cdn.discordapp.com/attachments/1/2/mismatch.png", content_type: "image/png" }, (): void => undefined],
];
for (const [name, att, setup] of mediaRows)
  test(`inbound media rejected: ${name}`, async () => {
    const e = await makeEnv({ maxMediaBytes: 1_000_000 });
    const ch = e.channel();
    await started(e, ch);
    e.rest.cdn.set("/attachments/1/2/mismatch.png", { mime: "text/html", data: Buffer.from("<b>x</b>") });
    setup();
    const rich: unknown[] = [];
    ch.onMessage((m) => void rich.push(m));
    await emit(e, "MESSAGE_CREATE", dm("x", { attachments: [{ id: "1", filename: "a", ...att }] }));
    assert.equal(rich.length, 0);
    assert.ok(e.logs.some((l) => l.event === "channel.discord.media-rejected"));
    await finish(e, ch);
  });

test("inbound: an attachment size limit below the hard cap is honoured", async () => {
  const e = await makeEnv({ maxMediaBytes: 4 });
  const ch = e.channel();
  await started(e, ch);
  e.rest.cdn.set("/attachments/1/2/b.png", { mime: "image/png", data: Buffer.from("12345") });
  const rich: unknown[] = [];
  ch.onMessage((m) => void rich.push(m));
  await emit(e, "MESSAGE_CREATE", dm("x", { attachments: [{ id: "1", filename: "b.png", size: 5, url: "https://cdn.discordapp.com/attachments/1/2/b.png", content_type: "image/png" }] }));
  assert.equal(rich.length, 0);
  await finish(e, ch);
});

test("config: out-of-range limits and unknown keys are refused at construction", async () => {
  const e = await makeEnv();
  assert.throws(() => e.channel({ maxMediaBytes: 26 * 1024 * 1024 }), RangeError);
  assert.throws(() => e.channel({ allowlist: ["not-an-id"] }), RangeError);
  assert.throws(() => e.channel({ replyPolicy: "shout" as never }), RangeError);
  assert.throws(() => e.channel({ intents: ["MADE_UP"] as never }), RangeError);
  assert.throws(() => e.channel({ intents: ["GUILDS", 1 << 30 as never] as never }), RangeError);
  assert.throws(() => e.channel({ tokenSecret: "bad name!" }), RangeError);
  assert.throws(() => e.channel({ extraKey: 1 } as never), RangeError);
  await e.close();
});

test("logs: no token, no message content and no secret-shaped string in any log line", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  await emit(e, "MESSAGE_CREATE", dm("SECRET-CONTENT-123"));
  await emit(e, "MESSAGE_CREATE", guild("ignored SECRET-CONTENT-456"));
  await ch.sendTurn({ chatId: DM_CHANNEL, text: "reply" }).catch(() => {});
  await ch.stop();
  const blob = JSON.stringify(e.logs);
  assert.ok(!blob.includes(TOKEN));
  assert.ok(!blob.includes("testonly-invented"));
  assert.ok(!blob.includes("SECRET-CONTENT"));
  await e.close();
});

// ---- outbound ----------------------------------------------------------------------------------------------

test("outbound: every message carries allowed_mentions parse [] and neutralised mentions", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  await ch.send({ chatId: GUILD_CHANNEL, text: "ping <@123456789012345678> <@&555555555555555555> @everyone @here" });
  const posted = e.rest.callsOf("POST", "/api/v10/channels/").filter((c) => c.path.endsWith("/messages"));
  assert.equal(posted.length, 1);
  const body = posted[0]!.json as { content: string; allowed_mentions: unknown };
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.ok(!/<@\d/.test(body.content) && !/@everyone|@here/.test(body.content.replace(/​/g, "")) || body.content.includes("​"));
  assert.ok(body.content.includes("​"));
  assert.equal(posted[0]!.auth, `Bot ${TOKEN}`);
  await finish(e, ch);
});

test("outbound: conversion keeps formatting and fences intact, table-driven", async () => {
  const cases: Array<[string, string]> = [
    ["**bold** and _it_", "**bold** and _it_"],
    ["```ts\nconst a = 1;\n```", "```ts\nconst a = 1;\n```"],
    ["[link](https://example.test)", "[link](https://example.test)"],
    ["- one\n- two", "- one\n- two"],
  ];
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  for (const [input, expected] of cases) await ch.send({ chatId: GUILD_CHANNEL, text: input });
  assert.deepEqual(e.rest.messages.map((m) => m.content), cases.map((c) => c[1]));
  await finish(e, ch);
});

test("outbound: long text splits into messages of at most 2000 characters; only the first replies", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  const text = Array.from({ length: 300 }, (_, i) => `paragraph ${i} ${"lorem ipsum ".repeat(4)}`).join("\n\n");
  const refs = await ch.sendTurn({ chatId: GUILD_CHANNEL, text, replyTo: "123456789" });
  assert.ok(refs.length > 1);
  for (const m of e.rest.messages) assert.ok(m.content.length <= 2000);
  assert.equal(e.rest.messages[0]!.reference, "123456789");
  assert.equal(e.rest.messages.slice(1).every((m) => m.reference === undefined), true);
  await finish(e, ch);
});

test("outbound: a fence open at a cut is closed and reopened with its language", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  const code = Array.from({ length: 200 }, (_, i) => `const value${i} = ${i} * 2; // padding padding`).join("\n");
  await ch.send({ chatId: GUILD_CHANNEL, text: `intro\n\`\`\`ts\n${code}\n\`\`\`\nafter` });
  assert.ok(e.rest.messages.length > 1);
  for (const m of e.rest.messages) {
    assert.ok(m.content.length <= 2000);
    assert.equal(m.content.split("\n").filter((l) => l.startsWith("```")).length % 2, 0, "fences balanced per message");
  }
  assert.ok(e.rest.messages[1]!.content.startsWith("```ts\n"));
  await finish(e, ch);
});

test("outbound: invalid targets and unstarted use are refused", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await assert.rejects(ch.send({ chatId: GUILD_CHANNEL, text: "x" }), /not started/);
  await assert.rejects(ch.typing(GUILD_CHANNEL), /not started/);
  await started(e, ch);
  await assert.rejects(ch.send({ chatId: NOT_ALLOWED_CHANNEL, text: "x" }), /allowlist/);
  await assert.rejects(ch.send({ chatId: "not-a-snowflake", text: "x" }), /invalid/);
  await assert.rejects(ch.sendTurn({ chatId: GUILD_CHANNEL, text: "x", replyTo: "../../x" }), /invalid reply/);
  await assert.rejects(ch.sendTurn({ chatId: GUILD_CHANNEL, text: "x", threadId: DM_CHANNEL }), /threadId/);
  assert.equal(e.rest.messages.length, 0);
  await finish(e, ch);
});

test("outbound: DM replies are allowed only after a listed DM sender opened the conversation", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  await assert.rejects(ch.send({ chatId: DM_CHANNEL, text: "early" }), /allowlist/);
  await emit(e, "MESSAGE_CREATE", dm("hello"));
  await ch.send({ chatId: DM_CHANNEL, text: "late ok" });
  assert.equal(e.rest.messages.at(-1)!.content, "late ok");
  await finish(e, ch);
});

test("outbound: typing and edit (streaming) use the REST routes and keep allowed_mentions", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  await ch.typing(GUILD_CHANNEL);
  assert.equal(e.rest.callsOf("POST", "/api/v10/channels/").filter((c) => c.path.endsWith("/typing")).length, 1);
  const [ref] = await ch.sendTurn({ chatId: GUILD_CHANNEL, text: "partial" });
  await ch.edit(ref!, "partial text, now longer <@999999999999999999>");
  const edit = e.rest.edits.at(-1)!;
  assert.equal(edit.messageId, ref!.messageId);
  assert.ok(edit.content.includes("​"));
  const sentEdit = e.rest.calls.filter((c) => c.method === "PATCH").at(-1)!.json as { allowed_mentions: unknown };
  assert.deepEqual(sentEdit.allowed_mentions, { parse: [] });
  await assert.rejects(ch.edit(ref!, "x".repeat(2001)), RangeError);
  await assert.rejects(ch.edit(ref!, "   "), RangeError);
  await finish(e, ch);
});

test("outbound: attachments are size- and MIME-checked; multipart upload carries the bytes", async () => {
  const e = await makeEnv({ maxMediaBytes: 100 });
  const ch = e.channel();
  await started(e, ch);
  await assert.rejects(ch.sendTurn({ chatId: GUILD_CHANNEL, text: "", attachments: [{ kind: "image", data: new Uint8Array(101), mimeType: "image/png" }] }), /size/);
  await assert.rejects(ch.sendTurn({ chatId: GUILD_CHANNEL, text: "", attachments: [{ kind: "file", data: new Uint8Array(4), mimeType: "text/html" }] }), /MIME/);
  await assert.rejects(ch.sendTurn({ chatId: GUILD_CHANNEL, text: "", attachments: [{ kind: "file", data: new Uint8Array(4), mimeType: "image/svg+xml" }] }), /MIME/);
  const refs = await ch.sendTurn({ chatId: GUILD_CHANNEL, text: "see", attachments: [{ kind: "image", data: new Uint8Array([1, 2, 3]), mimeType: "image/png", filename: "../evil name.png" }] });
  assert.equal(refs.length, 2);
  const upload = e.rest.calls.at(-1)!;
  assert.ok(upload.contentType?.startsWith("multipart/form-data"));
  assert.ok(upload.body.includes('filename="_evil_name.png"'), "filename sanitised");
  await finish(e, ch);
});

test("outbound: output store images are authorised before any read (sendOutput)", async () => {
  let authorised = 0;
  const e = await makeEnv({}, {
    outputs: {
      store: { root: "/nonexistent", get: async () => null },
      authorize: async () => {
        authorised++;
        return false;
      },
    } as never,
  });
  const ch = e.channel();
  await started(e, ch);
  await assert.rejects(ch.sendOutput(GUILD_CHANNEL, "11111111-2222-3333-4444-555555555555"), /denied/);
  assert.equal(authorised, 1);
  await assert.rejects(ch.sendOutput(GUILD_CHANNEL, "not-a-uuid"), /denied/);
  assert.equal(e.rest.messages.length, 0);
  await finish(e, ch);
});

test("rate limits: a 429 on send is retried after the clamped Retry-After", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  e.rest.fail("POST /api/v10/channels/", { status: 429, body: { retry_after: 0.2 } });
  const p = ch.send({ chatId: GUILD_CHANNEL, text: "eventually" });
  await drive(e.clock, p);
  await p;
  assert.ok(e.clock.slept.includes(1000), "0.2 s is raised to the 1 s floor");
  assert.equal(e.rest.messages.at(-1)!.content, "eventually");
  await finish(e, ch);
});

test("rate limits: a 403 on send is not retried and surfaces as forbidden", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  e.rest.fail("POST /api/v10/channels/", { status: 403, body: { message: "Missing Permissions", code: 50013 } });
  await assert.rejects(ch.send({ chatId: GUILD_CHANNEL, text: "nope" }), (err: unknown) => err instanceof DiscordApiError && err.kind === "forbidden");
  assert.equal(e.rest.callsOf("POST").filter((c) => c.path.endsWith("/messages")).length, 1);
  await finish(e, ch);
});

test("state: MemoryGatewayStateStore is a per-process store (copies on read)", async () => {
  const s = new MemoryGatewayStateStore();
  await s.save({ sessionId: "a", seq: 1, resumeGatewayUrl: "wss://resume.discord.gg", botId: BOT_ID });
  const v = await s.load();
  v!.seq = 99;
  assert.equal((await s.load())?.seq, 1);
  await s.clear();
  assert.equal(await s.load(), undefined);
});
