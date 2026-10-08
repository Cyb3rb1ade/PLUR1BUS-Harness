import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCOUNT, BOT_UUID, DM, DM_UUID, GROUP, STRANGER, push, rig } from "./helpers/setup.ts";
import { textEnvelope } from "./helpers/fake-daemon.ts";

const botMention = (start = 0, length = 1) => ({ name: "bot", number: ACCOUNT, uuid: BOT_UUID, start, length });

test("inbound: DM from an allowlisted sender reaches onMessage and the framework with sender identity", async () => {
  const r = await rig();
  const rich: unknown[] = [];
  r.ch.onMessage((m) => void rich.push(m));
  try {
    await push(r, textEnvelope({ message: "hallo", ts: 42 }));
    assert.equal(r.received.length, 1);
    assert.deepEqual(
      { ch: r.received[0]!.channel, chatId: r.received[0]!.chatId, kind: r.received[0]!.chatKind, sender: r.received[0]!.senderId, text: r.received[0]!.text, mid: r.received[0]!.messageId },
      { ch: "signal", chatId: DM, kind: "direct", sender: DM, text: "hallo", mid: "42" },
    );
    assert.equal(rich.length, 1);
  } finally {
    await r.close();
  }
});

test("inbound: DM from a stranger is dropped silently and logged without content", async () => {
  const r = await rig();
  try {
    await push(r, textEnvelope({ number: STRANGER, message: "secret words" }));
    assert.equal(r.received.length, 0);
    assert.equal(r.daemon.callsOf("send").length, 0, "no reply to strangers");
    assert.ok(!JSON.stringify(r.logs).includes("secret words"));
    assert.ok(!JSON.stringify(r.logs).includes(STRANGER));
  } finally {
    await r.close();
  }
});

test("inbound: a DM from a uuid-only sender uses the uuid as sender id (allowlist accepts uuid)", async () => {
  const r = await rig({ dmAllowlist: [DM_UUID] });
  try {
    await push(r, { source: DM_UUID, sourceUuid: DM_UUID, timestamp: 9, dataMessage: { timestamp: 9, message: "hi" } });
    assert.equal(r.received[0]?.senderId, DM_UUID);
    assert.equal(r.received[0]?.chatId, DM_UUID);
  } finally {
    await r.close();
  }
});

interface GroupCase {
  name: string;
  policy?: "mention" | "always" | "allowlist";
  users?: string[];
  env: Record<string, unknown>;
  heard: boolean;
  addressed?: boolean;
  text?: string;
}
const groupCases: GroupCase[] = [
  { name: "mention policy, bot mentioned", env: textEnvelope({ message: "￼ do it", groupId: GROUP, mentions: [botMention()] }), heard: true, addressed: true, text: "do it" },
  { name: "mention policy, unmentioned", env: textEnvelope({ message: "do it", groupId: GROUP }), heard: false },
  { name: "mention policy, another person mentioned", env: textEnvelope({ message: "￼ ping", groupId: GROUP, mentions: [{ name: "Ann", number: "+4915100000003", start: 0, length: 1 }] }), heard: false },
  { name: "always policy, unmentioned", policy: "always", env: textEnvelope({ message: "do it", groupId: GROUP }), heard: true, addressed: false, text: "do it" },
  { name: "allowlist policy, member unmentioned", policy: "allowlist", users: [DM], env: textEnvelope({ message: "do it", groupId: GROUP }), heard: true, addressed: false, text: "do it" },
  { name: "allowlist policy, non-member unmentioned", policy: "allowlist", users: [DM], env: textEnvelope({ number: STRANGER, message: "do it", groupId: GROUP }), heard: false },
  { name: "allowlist policy, non-member mentioned", policy: "allowlist", users: [DM], env: textEnvelope({ number: STRANGER, message: "￼ do it", groupId: GROUP, mentions: [botMention()] }), heard: true, addressed: true, text: "do it" },
  { name: "userAllowlist strict under mention policy", users: [DM], env: textEnvelope({ number: STRANGER, message: "￼ do it", groupId: GROUP, mentions: [botMention()] }), heard: false },
];
for (const c of groupCases)
  test(`inbound groups: ${c.name}`, async () => {
    const r = await rig({ replyPolicy: c.policy ?? "mention", ...(c.users ? { userAllowlist: c.users } : {}) });
    try {
      await push(r, c.env);
      assert.equal(r.received.length, c.heard ? 1 : 0);
      if (c.heard) {
        assert.equal(r.received[0]!.chatKind, "group");
        assert.equal(r.received[0]!.chatId, GROUP);
        if (c.text !== undefined) assert.equal(r.received[0]!.text, c.text);
        assert.equal(r.received[0]!.addressed, c.addressed);
      }
    } finally {
      await r.close();
    }
  });

test("inbound groups: a group that is not on the allowlist is dropped even when the bot is mentioned", async () => {
  const r = await rig();
  try {
    await push(r, textEnvelope({ message: "￼ hi", groupId: "b3RoZXJncm91cA==", mentions: [botMention()] }));
    assert.equal(r.received.length, 0);
  } finally {
    await r.close();
  }
});

const mentionCases: Array<[string, string, Array<[number, number, string]>, string]> = [
  ["bot mention at start", "￼ hallo", [[0, 1, "bot"]], "hallo"],
  ["bot mention after emoji (UTF-16 offsets)", "😀 ￼ hi", [[3, 1, "bot"]], "😀  hi"],
  ["bot mention in the middle", "a ￼ b", [[2, 1, "bot"]], "a  b"],
  ["two mentions, other first", "￼ x ￼ y", [[0, 1, "other"], [4, 1, "bot"]], "@other x  y"],
  ["mention name with control chars", "￼ z", [[0, 1, "ev\u0007il"]], "@evil z"],
];
for (const [name, message, marks, expected] of mentionCases)
  test(`inbound mentions: ${name}`, async () => {
    const r = await rig({ replyPolicy: "always" });
    try {
      const mentions = marks.map(([start, length, who]) =>
        who === "bot" ? botMention(start, length) : { name: who, number: "+4915100000003", start, length },
      );
      await push(r, textEnvelope({ message: message, groupId: GROUP, mentions }));
      assert.equal(r.received[0]?.text, expected);
    } finally {
      await r.close();
    }
  });

test("inbound: reply to a bot message counts as addressed and carries quote metadata", async () => {
  const r = await rig({ replyPolicy: "mention" });
  try {
    await push(r, textEnvelope({ message: "thanks", groupId: GROUP, quote: { id: 555, authorUuid: BOT_UUID, author: BOT_UUID } }));
    assert.equal(r.received.length, 1);
    assert.equal(r.received[0]!.addressed, true);
  } finally {
    await r.close();
  }
});

test("inbound: own and sync/receipt/typing envelopes are ignored (loop prevention)", async () => {
  const r = await rig();
  try {
    await push(r, textEnvelope({ number: ACCOUNT, message: "echo" }));
    await push(r, { source: DM, sourceNumber: DM, timestamp: 1, syncMessage: { sentMessage: { message: "x" } }, dataMessage: { timestamp: 1, message: "sync" } });
    await push(r, { source: DM, sourceNumber: DM, timestamp: 2, receiptMessage: { isDelivery: true } });
    await push(r, { source: DM, sourceNumber: DM, timestamp: 3, typingMessage: { action: "STARTED" } });
    assert.equal(r.received.length, 0);
  } finally {
    await r.close();
  }
});

test("inbound: duplicate source+timestamp is processed once (bounded dedupe cache)", async () => {
  const r = await rig();
  try {
    const env = textEnvelope({ message: "once", ts: 77 });
    await push(r, env);
    await push(r, env);
    await push(r, textEnvelope({ message: "twice", ts: 78 }));
    assert.deepEqual(r.received.map((m) => m.text), ["once", "twice"]);
  } finally {
    await r.close();
  }
});

test("inbound: a throwing handler never kills the receive loop", async () => {
  const r = await rig();
  r.ch.onMessage(() => {
    throw new Error("handler exploded");
  });
  try {
    await push(r, textEnvelope({ message: "a", ts: 1 }));
    await push(r, textEnvelope({ message: "b", ts: 2 }));
    assert.equal(r.received.length, 2);
    assert.ok(r.logs.some((l) => l.event === "channel.signal.handler-failed"));
    assert.ok(!JSON.stringify(r.logs).includes("exploded"));
  } finally {
    await r.close();
  }
});

test("inbound: a malformed envelope does not stop later messages", async () => {
  const r = await rig();
  try {
    await push(r, { nonsense: true });
    await push(r, { source: DM, timestamp: "x", dataMessage: { message: "bad ts" } });
    await push(r, { source: DM, dataMessage: { timestamp: 3, mentions: [{ start: 99, length: 5 }], message: "fine" } });
    assert.deepEqual(r.received.map((m) => m.text), ["fine"]);
  } finally {
    await r.close();
  }
});

test("inbound: reactions are rich-only (not sent to the text framework)", async () => {
  const r = await rig();
  const rich: Array<Record<string, unknown>> = [];
  r.ch.onMessage((m) => void rich.push(m as unknown as Record<string, unknown>));
  try {
    await push(r, textEnvelope({ message: undefined, reaction: { emoji: "👍", targetAuthorUuid: BOT_UUID, targetSentTimestamp: 100, isRemove: false } }));
    assert.equal(r.received.length, 0);
    assert.equal(rich.length, 1);
    assert.deepEqual(rich[0]!.reaction, { emoji: "👍", targetMessageId: "100", targetAuthorId: BOT_UUID, remove: false });
  } finally {
    await r.close();
  }
});

test("inbound: view-once is refused with a notice and never delivered", async () => {
  const r = await rig();
  try {
    await push(r, textEnvelope({ message: "peek", viewOnce: true }));
    assert.equal(r.received.length, 0);
    assert.equal(r.daemon.sent().at(-1)?.message, "View-once messages are not supported by this bot. Please send a normal message.");
  } finally {
    await r.close();
  }
});

test("inbound: disappearing messages are delivered with their timer", async () => {
  const r = await rig();
  try {
    await push(r, textEnvelope({ message: "tmp", expiresInSeconds: 3600 }));
    assert.equal(r.received[0]?.expiresInSeconds, 3600);
  } finally {
    await r.close();
  }
});

const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
const attachmentCases: Array<[string, Record<string, unknown>, string | undefined, "ok" | "refused", string?]> = [
  ["image within limits", { id: "att1", contentType: "image/png", size: 8, filename: "a b.png" }, PNG, "ok"],
  ["declared size over the limit", { id: "att1", contentType: "image/png", size: 11 * 1024 * 1024 }, PNG, "refused"],
  ["disallowed MIME (executable)", { id: "att1", contentType: "application/x-msdownload", size: 8 }, PNG, "refused"],
  ["html is not an allowed document", { id: "att1", contentType: "text/html", size: 8 }, PNG, "refused"],
  ["bytes larger than declared size", { id: "att1", contentType: "image/png", size: 2 }, PNG, "refused"],
  ["daemon returns nothing", { id: "att1", contentType: "image/png", size: 8 }, undefined, "refused"],
  ["invalid attachment id", { id: "../../etc", contentType: "image/png", size: 8 }, PNG, "refused"],
  ["empty payload", { id: "att1", contentType: "image/png", size: 8 }, "", "refused"],
];
for (const [name, att, b64, expected] of attachmentCases)
  test(`inbound attachments: ${name}`, async () => {
    const r = await rig({ maxMediaBytes: 10 * 1024 * 1024 });
    if (b64 !== undefined) r.daemon.attachments.set("att1", b64);
    try {
      await push(r, textEnvelope({ message: "see", attachments: [att], groupId: undefined }));
      if (expected === "ok") {
        assert.equal(r.logs.some((l) => l.event === "channel.signal.media-rejected"), false);
      } else {
        assert.equal(r.received.length, 0);
        assert.ok(r.daemon.sent().some((p) => String(p.message).startsWith("This attachment could not be accepted")));
      }
    } finally {
      await r.close();
    }
  });

test("inbound attachments: accepted bytes arrive on onMessage with MIME, kind and sanitized filename", async () => {
  const r = await rig();
  r.daemon.attachments.set("att1", PNG);
  const got: Array<{ kind: string; mimeType: string; filename?: string; size: number }> = [];
  r.ch.onMessage((m) => {
    for (const a of m.attachments ?? []) got.push({ kind: a.kind, mimeType: a.mimeType, ...(a.filename ? { filename: a.filename } : {}), size: a.data.byteLength });
  });
  try {
    await push(r, textEnvelope({ message: "pic", attachments: [{ id: "att1", contentType: "image/png", size: 8, filename: "my pic (1).png" }] }));
    assert.deepEqual(got, [{ kind: "photo", mimeType: "image/png", filename: "my_pic__1_.png", size: 8 }]);
    assert.ok(r.logs.some((l) => l.event === "channel.signal.framework-rich-turn-gap"));
  } finally {
    await r.close();
  }
});

test("inbound attachments: framework path logs the rich-turn gap for attachment turns", async () => {
  const r = await rig();
  r.daemon.attachments.set("att1", PNG);
  try {
    await push(r, textEnvelope({ message: "pic", attachments: [{ id: "att1", contentType: "image/png", size: 8 }] }));
    assert.ok(r.logs.some((l) => l.event === "channel.signal.framework-rich-turn-gap"));
  } finally {
    await r.close();
  }
});

test("inbound: expired daemon attachment response is bounded before decode", async () => {
  const r = await rig({ maxMediaBytes: 1024 });
  r.daemon.attachments.set("att1", "A".repeat(8000));
  try {
    await push(r, textEnvelope({ message: "x", attachments: [{ id: "att1", contentType: "image/png" }] }));
    assert.equal(r.received.length, 0);
    assert.ok(r.logs.some((l) => l.event === "channel.signal.media-rejected"));
  } finally {
    await r.close();
  }
});

const reaction = { emoji: "👍", targetAuthorUuid: BOT_UUID, targetSentTimestamp: 100, isRemove: false };

test("inbound reactions: a non-member reaction in an allowed group is dropped when userAllowlist is set", async () => {
  const r = await rig({ replyPolicy: "always", userAllowlist: [DM] });
  const rich: unknown[] = [];
  r.ch.onMessage((m) => void rich.push(m));
  try {
    await push(r, textEnvelope({ number: STRANGER, groupId: GROUP, reaction }));
    assert.equal(rich.length, 0);
    assert.ok(r.logs.some((l) => l.event === "channel.signal.dropped" && l.reason === "user-not-allowed"));
  } finally {
    await r.close();
  }
});

test("inbound reactions: a member reaction in an allowed group is emitted", async () => {
  const r = await rig({ replyPolicy: "always", userAllowlist: [DM] });
  const rich: unknown[] = [];
  r.ch.onMessage((m) => void rich.push(m));
  try {
    await push(r, textEnvelope({ number: DM, groupId: GROUP, reaction }));
    assert.equal(rich.length, 1);
  } finally {
    await r.close();
  }
});

test("inbound reactions: a DM reaction is unaffected by userAllowlist", async () => {
  const r = await rig({ userAllowlist: [DM] });
  const rich: unknown[] = [];
  r.ch.onMessage((m) => void rich.push(m));
  try {
    await push(r, textEnvelope({ number: DM, reaction }));
    assert.equal(rich.length, 1);
  } finally {
    await r.close();
  }
});
