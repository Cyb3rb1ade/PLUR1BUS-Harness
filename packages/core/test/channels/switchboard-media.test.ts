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
