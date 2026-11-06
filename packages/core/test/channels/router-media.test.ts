// Attachment ingress keeps the channel identity/FIFO gates and only submits actual text after private publication.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelRouter, FAILED_TEXT, type RouterDeps } from "../../src/channels/router.ts";
import type { InboundMessage, OutboundMessage } from "../../src/channels/types.ts";
import { FakeClock, FakeIdentity, FakeSessions, silentLog, flush } from "./helpers.ts";
import { RpcError } from "../../src/rpc/errors.ts";

const image = () => ({ kind: "photo" as const, mimeType: "image/png", data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) });
function rig(extra: Partial<RouterDeps> = {}) {
  const identity = new FakeIdentity();
  const sessions = new FakeSessions();
  const sent: OutboundMessage[] = [];
  const accepted: { message: InboundMessage; sessionId: string; humanId: string }[] = [];
  const router = new ChannelRouter({ identity, sessions, clock: new FakeClock(), log: silentLog, ingestAttachments: async (input) => { accepted.push(input); }, ...extra });
  const msg = (extra: Partial<InboundMessage> = {}): InboundMessage => ({ channel: "telegram", chatId: "42", chatKind: "direct", senderId: "alice", text: "", attachments: [image()], ...extra });
  identity.link("telegram", "alice", "human-1");
  return { identity, sessions, sent, accepted, router, msg, send: async (m: OutboundMessage) => { sent.push(m); } };
}

test("an attachment-only message is privately accepted once without an empty session turn", async () => {
  const r = rig();
  const m = r.msg({ messageId: "media-1" });
  await r.router.handle(m, r.send);
  await r.router.handle(m, r.send);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0]!.humanId, "human-1");
  assert.equal(r.accepted[0]!.sessionId, r.sessions.all[0]!.id);
  assert.equal(r.accepted[0]!.message, m);
  assert.equal(r.sessions.submits.length, 0);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0]!.replyTo, "media-1");
  assert.notEqual(r.sent[0]!.text, FAILED_TEXT);
});

test("text plus media waits for private publication, preserves the original text and chat FIFO", async () => {
  let publish!: () => void;
  const stored = new Promise<void>((resolve) => { publish = resolve; });
  const r = rig({ ingestAttachments: async () => stored });
  const first = r.router.handle(r.msg({ text: "  describe this  " }), r.send);
  const second = r.router.handle(r.msg({ text: "next", attachments: [] }), r.send);
  await flush();
  assert.equal(r.sessions.submits.length, 0);
  publish();
  await Promise.all([first, second]);
  assert.deepEqual(r.sessions.submits.map((s) => s.text), ["  describe this  ", "next"]);
});

test("missing or rejecting upload service fails closed before text is submitted", async () => {
  for (const ingestAttachments of [undefined, async () => { throw new Error("agent.use denied"); }]) {
    const r = rig();
    const router = new ChannelRouter({ identity: r.identity, sessions: r.sessions, clock: new FakeClock(), log: silentLog, ...(ingestAttachments ? { ingestAttachments } : {}) });
    await router.handle(r.msg({ text: "do not submit without its attachment" }), r.send);
    assert.equal(r.sessions.submits.length, 0);
    assert.deepEqual(r.sent.map((m) => m.text), [ingestAttachments ? FAILED_TEXT : "File uploads are not available right now."]);
  }
});

test("unlinked and disabled uploaders never reach private publication", async () => {
  for (const state of ["unlinked", "disabled"]) {
    const r = rig();
    r.identity.resolve = async () => state === "unlinked" ? { linked: false } : { linked: true, userId: "human-1", disabled: true };
    await r.router.handle(r.msg(), r.send);
    assert.equal(r.accepted.length, 0);
    assert.equal(r.sessions.all.length, 0);
    assert.equal(r.sessions.submits.length, 0);
  }
});

test("a behavior-denied group upload never creates a session or stores bytes", async () => {
  const r = rig();
  await r.router.handle(r.msg({ chatKind: "group", addressed: false }), r.send);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.sessions.all.length, 0);
  assert.equal(r.sent.length, 0);
});

test("all previously mismatched media MIME types use the shared supported-media list", async () => {
  for (const mimeType of ["video/quicktime", "audio/aac", "audio/x-m4a", "audio/mp3", "video/ogg"]) {
    const r = rig();
    const kind = mimeType.startsWith("video/") ? "video" : "audio";
    await r.router.handle(r.msg({ attachments: [{ kind, mimeType, data: Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112]) }] }), r.send);
    assert.equal(r.accepted.length, 1, mimeType);
    assert.equal(r.accepted[0]!.message.attachments![0]!.mimeType, mimeType);
  }
});

test("unsupported attachments are named and skipped while original message text is submitted", async () => {
  const r = rig({ ingestAttachments: async input => {
    assert.ok(input.message.attachments?.every(a => a.mimeType !== "application/pdf"));
  } });
  await r.router.handle(r.msg({ text: "  keep this text  ", attachments: [{ kind: "document", mimeType: "application/pdf", data: Uint8Array.from([37, 80, 68, 70]) }] }), r.send);
  assert.deepEqual(r.sessions.submits.map(s => s.text), ["  keep this text  "]);
  assert.ok(r.sent.some(m => /application\/pdf/.test(m.text)));
  assert.equal(r.sent.some(m => m.text === FAILED_TEXT), false);
});

test("an unsupported-only message explains the attachment without an empty session turn", async () => {
  const r = rig();
  await r.router.handle(r.msg({ attachments: [{ kind: "document", mimeType: "application/pdf", data: Uint8Array.from([37, 80, 68, 70]) }] }), r.send);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.sessions.all.length, 0);
  assert.equal(r.sessions.submits.length, 0);
  assert.ok(r.sent.some(m => /application\/pdf/.test(m.text)));
});

test("known upload refusals have bounded English and German messages without internal details", async () => {
  for (const locale of ["en", "de"] as const) for (const reason of ["incognito", "media-quota", "media-too-large", "upload-forbidden"]) {
    const r = rig({ locale: () => locale, ingestAttachments: async () => { throw new RpcError("E_DENIED", "PRIVATE-INTERNAL-DETAIL", { reason }); } });
    await r.router.handle(r.msg(), r.send);
    assert.equal(r.sent.length, 1);
    assert.notEqual(r.sent[0]!.text, FAILED_TEXT);
    assert.doesNotMatch(r.sent[0]!.text, /PRIVATE-INTERNAL-DETAIL/);
    assert.match(r.sent[0]!.text, locale === "de" ? /Datei|Dateien|Speicher|Inkognito/ : /upload|file|storage|Incognito/i);
    assert.equal(r.sessions.submits.length, 0);
  }
});

test("invalid attachment counts, byte totals, declarations and MIME families stop before identity", async () => {
  const large = { ...image(), data: new Uint8Array(13 * 1024 * 1024) };
  const malformed = [
    [null], [image(), ...Array.from({ length: 10 }, image)], [large, large],
    [{ ...image(), data: new Uint8Array() }], [{ ...image(), data: "not-bytes" }],
    [{ ...image(), sizeBytes: 1 }], [{ ...image(), sizeBytes: -1 }],
    [{ ...image(), mimeType: "bad\nmime" }],
    [{ ...image(), filename: "x".repeat(1025) }], [{ ...image(), kind: "path" }],
  ];
  for (const attachments of malformed) {
    const r = rig();
    await r.router.handle(r.msg({ text: "valid text", attachments: attachments as NonNullable<InboundMessage["attachments"]> }), r.send);
    assert.equal(r.identity.resolves, 0, JSON.stringify(attachments.map((a) => a && typeof a === "object" ? { ...a, data: undefined } : a)));
    assert.equal(r.accepted.length, 0);
    assert.equal(r.sessions.submits.length, 0);
  }
});
