import assert from "node:assert/strict";
import { test } from "node:test";
import { SignalRpcError, UnsupportedError, splitMessage } from "../src/index.ts";
import { DM, GROUP, STRANGER, push, rig } from "./helpers/setup.ts";
import { textEnvelope } from "./helpers/fake-daemon.ts";

const decodeStyled = (text: string, styles: string[]) =>
  styles.map((s) => {
    const [a, l, st] = s.split(":");
    return [st, text.slice(Number(a), Number(a) + Number(l))];
  });

test("outbound: framework send converts markdown to plain text plus textStyle ranges (DM recipient)", async () => {
  const r = await rig();
  try {
    await r.ch.send({ chatId: DM, text: "**Hi** `x` 😀 *there*" });
    const [p] = r.daemon.sent();
    assert.equal(p!.message, "Hi x 😀 there");
    assert.deepEqual(p!.recipient, [DM]);
    assert.equal(p!.groupId, undefined);
    assert.deepEqual(decodeStyled(p!.message, p!.textStyle), [
      ["BOLD", "Hi"],
      ["MONOSPACE", "x"],
      ["ITALIC", "there"],
    ]);
  } finally {
    await r.close();
  }
});

test("outbound: group send targets groupId and returns a message reference", async () => {
  const r = await rig();
  try {
    const refs = await r.ch.sendTurn({ chatId: GROUP, text: "hello" });
    assert.equal(r.daemon.sent()[0]!.groupId[0], GROUP);
    assert.equal(r.daemon.sent()[0]!.recipient, undefined);
    assert.deepEqual(refs, [{ chatId: GROUP, messageId: refs[0]!.messageId }]);
    assert.match(refs[0]!.messageId, /^\d+$/);
  } finally {
    await r.close();
  }
});

test("outbound: literal text is not converted when markdown is false", async () => {
  const r = await rig();
  try {
    await r.ch.sendTurn({ chatId: DM, text: "**not bold**", markdown: false });
    assert.equal(r.daemon.sent()[0]!.message, "**not bold**");
    assert.equal(r.daemon.sent()[0]!.textStyle, undefined);
  } finally {
    await r.close();
  }
});

test("outbound: long text is split into <= 2000 UTF-16 unit chunks with rebased styles", async () => {
  const r = await rig();
  try {
    const text = ("**bold line** 😀 plain text\n\n").repeat(200);
    await r.ch.send({ chatId: DM, text });
    const sent = r.daemon.sent();
    assert.ok(sent.length > 1);
    for (const p of sent) assert.ok(String(p.message).length <= 2000);
    const bolds = sent.flatMap((p) => decodeStyled(p.message, p.textStyle ?? []).filter(([s]) => s === "BOLD"));
    assert.ok(bolds.length >= 200);
    for (const [, t] of bolds) assert.equal(t, "bold line");
    assert.equal(splitMessage(text, 2000).length, sent.length);
  } finally {
    await r.close();
  }
});

test("outbound: quote-reply targets the inbound message timestamp and author", async () => {
  const r = await rig();
  try {
    await push(r, textEnvelope({ message: "question", ts: 1_700_000_000_123 }));
    await r.ch.sendTurn({ chatId: DM, text: "answer", replyTo: "1700000000123" });
    const p = r.daemon.sent()[0]!;
    assert.equal(p.quoteTimestamp, 1_700_000_000_123);
    assert.equal(p.quoteAuthor, DM);
  } finally {
    await r.close();
  }
});

test("outbound: replyTo for a message the channel never saw is sent without a quote", async () => {
  const r = await rig();
  try {
    await r.ch.sendTurn({ chatId: DM, text: "answer", replyTo: "42" });
    assert.equal(r.daemon.sent()[0]!.quoteTimestamp, undefined);
  } finally {
    await r.close();
  }
});

test("outbound: buttons are unsupported and throw the typed error without sending", async () => {
  const r = await rig();
  try {
    await assert.rejects(r.ch.sendTurn({ chatId: DM, text: "x", buttons: [[{ text: "ok", data: "1" }]] }), (e: unknown) => {
      assert.ok(e instanceof UnsupportedError);
      assert.equal((e as UnsupportedError).code, "unsupported");
      return true;
    });
    assert.equal(r.daemon.callsOf("send").length, 0);
  } finally {
    await r.close();
  }
});

test("outbound: targets outside the allowlists are refused before any RPC", async () => {
  const r = await rig();
  try {
    await assert.rejects(r.ch.send({ chatId: STRANGER, text: "x" }), /allowlist/);
    await assert.rejects(r.ch.send({ chatId: "b3RoZXI=", text: "x" }), /allowlist/);
    await assert.rejects(r.ch.send({ chatId: "not a target\n", text: "x" }), /invalid/);
    assert.equal(r.daemon.callsOf("send").length, 0);
  } finally {
    await r.close();
  }
});

test("outbound: attachments are sent as data URIs with sanitized filenames; bad MIME and size refused", async () => {
  const r = await rig({ maxMediaBytes: 1024 });
  try {
    const data = new Uint8Array([1, 2, 3, 4]);
    await r.ch.sendTurn({
      chatId: DM,
      text: "",
      attachments: [{ kind: "document", data, mimeType: "application/pdf", filename: "my report (v2).pdf" }],
    });
    const p = r.daemon.sent().at(-1)!;
    assert.equal(p.attachments[0], "data:application/pdf;filename=my_report__v2_.pdf;base64,AQIDBA==");
    await assert.rejects(
      r.ch.sendTurn({ chatId: DM, text: "", attachments: [{ kind: "document", data, mimeType: "text/html" }] }),
      /MIME/,
    );
    await assert.rejects(
      r.ch.sendTurn({ chatId: DM, text: "", attachments: [{ kind: "document", data: new Uint8Array(2000), mimeType: "application/pdf" }] }),
      /size/,
    );
  } finally {
    await r.close();
  }
});

test("outbound: edit uses editTimestamp, keeps styles, and refuses multi-message edits", async () => {
  const r = await rig();
  try {
    const [ref] = await r.ch.sendTurn({ chatId: DM, text: "draft" });
    await r.ch.edit(ref!, "**final**");
    const p = r.daemon.sent().at(-1)!;
    assert.equal(p.editTimestamp, Number(ref!.messageId));
    assert.equal(p.message, "final");
    await assert.rejects(r.ch.edit(ref!, "x".repeat(2001)), RangeError);
    await assert.rejects(r.ch.edit({ chatId: DM, messageId: "nope" }, "x"), RangeError);
  } finally {
    await r.close();
  }
});

test("outbound: typing sends sendTyping; a failure is swallowed", async () => {
  const r = await rig();
  try {
    await r.ch.typing(DM);
    assert.equal(r.daemon.callsOf("sendTyping")[0]!.params.recipient[0], DM);
    r.daemon.failNext("sendTyping", { code: -1, message: "nope" });
    await r.ch.typing(DM);
  } finally {
    await r.close();
  }
});

test("outbound rate limit: a daemon rate limit waits the clamped retry hint and retries once", async () => {
  const r = await rig();
  try {
    r.daemon.failNext("send", { code: -1, message: "RATE_LIMIT", data: { retryAfterSeconds: 2 } });
    await r.ch.sendTurn({ chatId: DM, text: "again" });
    assert.ok(r.sleeps.includes(2000));
    assert.equal(r.daemon.callsOf("send").length, 2);
  } finally {
    await r.close();
  }
});

test("outbound rate limit: retries are bounded by maxSendRetries", async () => {
  const r = await rig({ maxSendRetries: 1 });
  try {
    for (let i = 0; i < 3; i++) r.daemon.failNext("send", { code: -1, message: "rate limit", data: { retryAfterSeconds: 1 } });
    await assert.rejects(r.ch.sendTurn({ chatId: DM, text: "x" }), (e: unknown) => e instanceof SignalRpcError && e.kind === "rate-limited");
    assert.equal(r.daemon.callsOf("send").length, 2);
  } finally {
    await r.close();
  }
});

test("outbound: UntrustedIdentity is a typed error with no retry", async () => {
  const r = await rig();
  try {
    r.daemon.failNext("send", { code: -1, message: "UntrustedIdentityException: key changed" });
    await assert.rejects(r.ch.sendTurn({ chatId: DM, text: "x" }), (e: unknown) => e instanceof SignalRpcError && e.kind === "untrusted-identity");
    assert.equal(r.daemon.callsOf("send").length, 1);
  } finally {
    await r.close();
  }
});

test("outbound: a send before start rejects", async () => {
  const r = await rig({}, false);
  try {
    await assert.rejects(r.ch.send({ chatId: DM, text: "x" }), /not started/);
  } finally {
    await r.close();
  }
});

test("outbound: sendOutput authorizes before reading and refuses denied outputs", async () => {
  let getCalled = 0;
  const r = await rig({
    outputs: {
      store: { root: "/nonexistent", get: async () => (getCalled++, undefined) } as never,
      authorize: async () => false,
    },
  });
  try {
    await assert.rejects(r.ch.sendOutput(DM, "00000000-0000-4000-8000-000000000000"), /denied/);
    assert.equal(getCalled, 0);
    await assert.rejects(r.ch.sendOutput(DM, "../../etc/passwd"), /denied/);
  } finally {
    await r.close();
  }
});

test("outbound prompt: lists reply codes and a token; the prompt text is plain (no markdown)", async () => {
  const r = await rig();
  try {
    const { promptId, refs } = await r.ch.prompt({
      chatId: DM,
      text: "Allow **rm -rf**?",
      choices: [
        { id: "once", label: "once" },
        { id: "session", label: "session" },
        { id: "deny", label: "deny" },
      ],
      approverIds: [DM],
    });
    assert.ok(promptId.length > 10);
    assert.equal(refs.length, 1);
    const text = String(r.daemon.sent().at(-1)!.message);
    assert.match(text, /Allow \*\*rm -rf\*\*\?/);
    assert.match(text, /1 = once/);
    assert.match(text, /2 = session/);
    assert.match(text, /0 = deny/);
    assert.match(text, /Reply "[2-9A-HJ-NP-Z]{4} <number>"/);
  } finally {
    await r.close();
  }
});

test("outbound: channel-level health reflects the daemon version check", async () => {
  const r = await rig();
  try {
    assert.deepEqual(await r.ch.health(), { ok: true });
    await r.ch.stop();
    assert.equal((await r.ch.health()).ok, false);
  } finally {
    await r.close();
  }
});
