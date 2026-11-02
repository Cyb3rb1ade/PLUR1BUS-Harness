// The host resolves a stored session and linked human for ingress; transport metadata cannot choose its authority.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChannelAttachmentIngressInput, SwitchboardOptions } from "../../src/channels/switchboard.ts";
import { FAILED_TEXT } from "../../src/channels/router.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { makeRig } from "./switchboard-rig.ts";

const attachments = [{ kind: "image" as const, mimeType: "image/png", data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) }];
async function running(switchboard: Partial<SwitchboardOptions> = {}) {
  const r = makeRig({ switchboard });
  r.secrets.put("channels.discord.token", "unit-test-token-0123456789");
  r.config.set("discord", { enabled: true });
  await r.switchboard.start();
  await r.clock.advance(0);
  return r;
}

test("attachment ingress receives the stored session agent and linked human, ignoring claimed ownership", async () => {
  const accepted: ChannelAttachmentIngressInput[] = [];
  const r = await running({ ingestAttachments: async (input) => { accepted.push(input); } });
  try {
    const { humanId } = r.link("discord", "bot-1", "sender-1");
    const forged = { text: "", attachments, humanId: "owner", agentId: "foreign", origin: { humanId: "owner" }, path: "/etc/passwd", messageId: "upload-1" };
    await r.adapter().inbound(forged);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.humanId, humanId);
    assert.equal(accepted[0]!.session.agentId, "main");
    assert.equal(accepted[0]!.session.owner, deriveUserPrincipal(humanId));
    assert.equal(accepted[0]!.session.chatKey, "discord:chat-1");
    assert.equal(r.provider.requests.length, 0);
    assert.equal(r.adapter().sent.length, 1);
    assert.notEqual(r.adapter().sent[0]!.text, FAILED_TEXT);
    await r.adapter().inbound(forged);
    assert.equal(accepted.length, 1);
  } finally { r.close(); }
});

test("upload rejection prevents a text turn and receipt while the host handles the failure", async () => {
  const r = await running({ ingestAttachments: async () => { throw new Error("agent.use denied"); } });
  try {
    r.link("discord", "bot-1", "sender-1");
    await r.adapter().host!.receive({ channel: "discord", chatId: "chat-1", chatKind: "direct", senderId: "sender-1", text: "caption", attachments });
    assert.equal(r.provider.requests.length, 0);
    assert.deepEqual(r.adapter().sent.map((m) => m.text), [FAILED_TEXT]);
  } finally { r.close(); }
});

test("wrong-channel, unlinked and disabled uploads never reach the ingestion service", async () => {
  const accepted: ChannelAttachmentIngressInput[] = [];
  const r = await running({ personActive: () => false, ingestAttachments: async (input) => { accepted.push(input); } });
  try {
    r.link("discord", "bot-1", "sender-1");
    await r.adapter().host!.receive({ channel: "telegram", chatId: "chat-1", chatKind: "direct", senderId: "sender-1", text: "", attachments });
    await r.adapter().host!.receive({ channel: "discord", chatId: "chat-1", chatKind: "direct", senderId: "sender-1", text: "", attachments });
    await r.adapter().host!.receive({ channel: "discord", chatId: "chat-1", chatKind: "direct", senderId: "stranger", text: "", attachments });
    assert.equal(accepted.length, 0);
    assert.equal(r.provider.requests.length, 0);
  } finally { r.close(); }
});

test("upload revalidation reads the current session memory mode after asynchronous work", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  let initial: ChannelAttachmentIngressInput["session"] | undefined;
  let fresh: ChannelAttachmentIngressInput["session"] | undefined;
  const r = await running({ ingestAttachments: async (input) => {
    initial = input.session;
    entered();
    await paused;
    fresh = await input.revalidate();
  } });
  let pending: Promise<void> | undefined;
  try {
    r.link("discord", "bot-1", "sender-1");
    pending = r.adapter().host!.receive({ channel: "discord", chatId: "chat-1", chatKind: "direct", senderId: "sender-1", text: "", attachments });
    await started;
    const session = r.store.activeForChat("discord:chat-1")!;
    r.store.updateSession(session.id, { memoryMode: "incognito" });
    release();
    await pending;
    assert.equal(initial?.memoryMode, "remember");
    assert.equal(fresh?.memoryMode, "incognito");
    assert.equal(fresh?.id, session.id);
    assert.notEqual(fresh, initial, "revalidation returns a new store read, not the captured record");
    assert.equal(r.provider.requests.length, 0);
    assert.notEqual(r.adapter().sent.at(-1)?.text, FAILED_TEXT);
  } finally { release(); await pending; r.close(); }
});

for (const changed of ["archive", "unlink", "disable"] as const) {
  test(`upload revalidation fails closed when the session or identity changes during I/O: ${changed}`, async () => {
    let active = true;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let failure = "";
    let published = false;
    const r = await running({ personActive: () => active, ingestAttachments: async (input) => {
      entered();
      await paused;
      try { await input.revalidate(); }
      catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
      published = true;
    } });
    let pending: Promise<void> | undefined;
    try {
      const { humanId } = r.link("discord", "bot-1", "sender-1");
      pending = r.adapter().host!.receive({ channel: "discord", chatId: "chat-1", chatKind: "direct", senderId: "sender-1", text: "", attachments });
      await started;
      if (changed === "archive") r.store.archiveSession(r.store.activeForChat("discord:chat-1")!.id);
      if (changed === "disable") active = false;
      if (changed === "unlink") {
        const link = r.identity.list({}).humans.find((human) => human.id === humanId)!.identities[0]!;
        r.identity.unlink({ linkId: link.id }, { user: humanId, host: "test", kind: "person", role: "member" });
      }
      release();
      await pending;
      const reason = changed === "archive" ? /not an active channel session/ : changed === "unlink" ? /no longer linked/ : /disabled/;
      assert.match(failure, reason);
      assert.equal(published, false);
      assert.equal(r.provider.requests.length, 0);
      assert.deepEqual(r.adapter().sent.map((message) => message.text), ["You cannot upload files to this session."]);
    } finally { release(); await pending; r.close(); }
  });
}
