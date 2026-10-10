// The real Discord adapter behind the switchboard host, against the channel's own in-process fake Discord (REST + gateway).
// No network, no sleeps: the adapter's clock is the channel's virtual one, waiting is `e2e.until` (event-loop turns).
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert } from "./e2e-assert.ts";
import { startE2e, type E2e } from "./e2e-rig.ts";
import { OWNER, type ApprovalView } from "./switchboard-rig.ts";
import { TEST_MESSAGE } from "../../src/rpc/channel-surface.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { OutputStore } from "../../../media/src/index.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { FakeClock as VirtualClock } from "../../../channels-discord/test/helpers/fake-clock.ts";
import {
  BOT_ID, DM_CHANNEL, DM_USER, GUILD_CHANNEL, OTHER_USER, TOKEN, FakeDiscordRest, FakeGateway, cdnAwareFetch, snowflake,
} from "../../../channels-discord/test/helpers/fake-discord.ts";

let seq = 0;
const nextId = () => snowflake(++seq + 20_000);

interface Env2 { e2e: E2e; rest: FakeDiscordRest; gateway: FakeGateway; close(): Promise<void> }

async function start(o: { config?: Record<string, unknown>; deps?: Record<string, unknown> } = {}): Promise<Env2> {
  const rest = new FakeDiscordRest();
  await rest.listen();
  const gateway = new FakeGateway();
  const clock = new VirtualClock();
  const e2e = await startE2e({
    id: "discord",
    secrets: { "channels.discord.token": TOKEN },
    config: { tokenSecret: "channels.discord.token", allowlist: [GUILD_CHANNEL], dmAllowlist: [DM_USER, OTHER_USER], ...(o.config ?? {}) },
    adapterDeps: {
      baseUrl: `${rest.baseUrl}/api/v10`, gatewayUrl: "wss://gateway.test.invalid", cdnHosts: ["cdn.discordapp.com"],
      fetch: cdnAwareFetch(rest), webSocket: gateway.factory, sleep: clock.sleep, random: () => 0.5, ...(o.deps ?? {}),
    },
  });
  await gateway.whenReady();
  await e2e.until(() => e2e.switchboard.view.status("discord")?.state === "running", "the discord channel runs");
  return { e2e, rest, gateway, close: async () => { await e2e.switchboard.stop(); e2e.identity.close(); e2e.store.close?.(); await rest.close(); } };
}

const dm = (content: string, over: Record<string, unknown> = {}) => ({
  id: nextId(), type: 0, content, timestamp: new Date(1_700_000_000_000).toISOString(), mentions: [], attachments: [],
  channel_id: DM_CHANNEL, author: { id: DM_USER }, ...over,
});
const toDm = (r: FakeDiscordRest, chat = DM_CHANNEL) => r.messages.filter((m) => m.channelId === chat);
const press = (g: FakeGateway, customId: string, user: string) =>
  g.dispatch("INTERACTION_CREATE", {
    id: nextId(), token: "interactiontoken0123456789abcdef", type: 3, channel_id: DM_CHANNEL, user: { id: user },
    data: { custom_id: customId, component_type: 2 },
  });
const channelSession = (e2e: E2e, humanId: string) => e2e.store.listSessions({ owner: deriveUserPrincipal(humanId), kind: "channel" }).sessions[0]!;
const approvalFor = (humanId: string, sessionId: string): ApprovalView => ({
  id: "req-1", status: "pending", capability: "net.submit", tool: "demo.net", risk: "medium", principal: humanId,
  subject: { kind: "agent", id: "main" }, actionHash: "h", turnId: "t", taskId: "task", sessionId, createdAt: 0, expiresAt: 600_000, delegable: false,
  summary: "send a mail to a@example.org",
} as ApprovalView);

test("a linked person's DM runs a turn and the echo reply reaches the DM channel", async () => {
  const t = await start();
  try {
    t.e2e.link("discord", BOT_ID, DM_USER);
    t.gateway.dispatch("MESSAGE_CREATE", dm("hello"));
    await t.e2e.until(() => toDm(t.rest).some((m) => m.content.includes("echo:hello")), "the echo reply");
    const post = t.rest.callsOf("POST", `/api/v10/channels/${DM_CHANNEL}/messages`);
    assert.ok(post.length >= 1);
    assert.equal(t.e2e.provider.requests.length, 1);
  } finally { await t.close(); }
});

test("an unlinked sender gets the pairing notice only; no turn runs", async () => {
  const t = await start();
  try {
    t.gateway.dispatch("MESSAGE_CREATE", dm("hello"));
    await t.e2e.until(() => toDm(t.rest).length === 1, "the pairing notice");
    assert.match(toDm(t.rest)[0]!.content, /not paired/i);
    assert.equal(t.e2e.provider.requests.length, 0);
  } finally { await t.close(); }
});

test("an approval asked in the DM shows up with buttons; only the linked person's press decides", async () => {
  const t = await start();
  try {
    const { humanId } = t.e2e.link("discord", BOT_ID, DM_USER);
    t.gateway.dispatch("MESSAGE_CREATE", dm("do it"));
    await t.e2e.until(() => toDm(t.rest).some((m) => m.content.includes("echo:do it")), "the reply");
    const before = t.rest.messages.length;
    t.e2e.switchboard.approvalEvents.emit("approval.requested", { approval: approvalFor(humanId, channelSession(t.e2e, humanId).id), nonce: "nonce-1", foregroundUntil: 1 });
    await t.e2e.until(() => t.rest.messages.length > before, "the approval message");
    const msg = t.rest.messages.at(-1)!;
    assert.equal(msg.channelId, DM_CHANNEL);
    assert.match(msg.content, /demo\.net/);
    assert.ok(!msg.content.includes("nonce-1"));
    const buttons = (msg.components as { components: { custom_id: string; label: string }[] }[])[0]!.components;
    assert.equal(buttons.length, 2);

    // another user (also on the dmAllowlist) presses: refused, nothing decided
    press(t.gateway, buttons[0]!.custom_id, OTHER_USER);
    await t.e2e.until(() => t.rest.interactionResponses.length === 1, "the refusal");
    assert.equal(t.e2e.approvals.decisions.length, 0);

    press(t.gateway, buttons[0]!.custom_id, DM_USER);
    await t.e2e.until(() => t.e2e.approvals.decisions.length === 1, "the decision");
    assert.deepEqual(t.e2e.approvals.decisions, [{ requestId: "req-1", nonce: "nonce-1", decision: "approve", person: humanId, surface: 2 }]);
  } finally { await t.close(); }
});

test("channel.test --send-owner delivers into the DM channel Discord returned, not to the raw user id", async () => {
  const t = await start();
  try {
    const { humanId } = t.e2e.link("discord", BOT_ID, DM_USER);
    const out = await t.e2e.call("channel.test", { id: "discord", sendOwner: true }, humanId);
    assert.equal(out.sent, true);
    const dmId = t.rest.dms.get(DM_USER)!;
    assert.ok(dmId);
    assert.notEqual(dmId, DM_USER);
    assert.deepEqual(t.rest.messages.map((m) => [m.channelId, m.content]), [[dmId, TEST_MESSAGE]]);
  } finally { await t.close(); }
});

test("--send-owner for a linked user off the dmAllowlist fails and sends nothing", async () => {
  const t = await start({ config: { dmAllowlist: [OTHER_USER] } });
  try {
    const { humanId } = t.e2e.link("discord", BOT_ID, DM_USER);
    await assert.rejects(t.e2e.call("channel.test", { id: "discord", sendOwner: true }, humanId), /could not be sent/);
    assert.equal(t.rest.messages.length, 0);
    assert.equal(t.rest.dms.size, 0);
  } finally { await t.close(); }
});

test("/link <code> pairs through the hosted adapter", async () => {
  const t = await start();
  try {
    const human = t.e2e.identity.createHuman({ displayName: "Pat" }, OWNER);
    const { code } = t.e2e.identity.startPairing({ humanId: human.id, channel: "discord" }, { user: human.id, host: "test", kind: "person", role: "member" });
    t.gateway.dispatch("INTERACTION_CREATE", {
      id: nextId(), token: "interactiontoken0123456789abcdef", type: 2, channel_id: DM_CHANNEL, user: { id: DM_USER },
      data: { name: "link", type: 1, options: [{ name: "code", type: 3, value: code }] },
    });
    await t.e2e.until(() => t.rest.interactionResponses.length === 1, "the answer to /link");
    const claimed = t.e2e.identity.list({}).pairings.filter((p) => p.state === "claimed");
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.claimedBy?.accountId, BOT_ID);
    assert.equal(claimed[0]!.claimedBy?.userId, DM_USER);
    assert.ok(!JSON.stringify(t.rest.interactionResponses).includes(code), "the code is never echoed");
  } finally { await t.close(); }
});

test("an image a tool produced follows the text reply into the same DM as an attachment", async () => {
  const root = tempDir("e2e-discord-media-");
  const outId = "11111111-2222-3333-4444-555555555555";
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  mkdirSync(join(root, outId), { recursive: true });
  writeFileSync(join(root, outId, "0.png"), png);
  writeFileSync(join(root, outId, "manifest.json"), JSON.stringify({
    id: outId, files: [{ path: "0.png", bytes: png.length, sha256: createHash("sha256").update(png).digest("hex"), format: "png" }],
  }));
  const asked: string[] = [];
  // the seam wins over the host's value (see the report): it keeps the host's rule that only this turn's output may go to this chat
  const outputs = { store: new OutputStore(root), authorize: async (id: string, chat: string) => { asked.push(`${id}@${chat}`); return id === outId && chat === DM_CHANNEL; } };
  const t = await start({ deps: { outputs } });
  try {
    t.e2e.link("discord", BOT_ID, DM_USER);
    t.e2e.provider.script = () => [
      { type: "tool.result", id: "t1", output: JSON.stringify({ id: outId, files: [{ path: "0.png", format: "png" }] }) },
      { type: "delta", text: "here is your picture" },
    ];
    t.gateway.dispatch("MESSAGE_CREATE", dm("draw"));
    await t.e2e.until(() => t.rest.callsOf("POST", `/api/v10/channels/${DM_CHANNEL}/messages`).length === 2, "text reply and image");
    const posts = t.rest.callsOf("POST", `/api/v10/channels/${DM_CHANNEL}/messages`);
    assert.ok(posts[0]!.contentType?.startsWith("application/json") && posts[0]!.body.includes("here is your picture"));
    assert.ok(posts[1]!.contentType?.startsWith("multipart/"), "the image is an upload");
    assert.ok(posts[1]!.body.includes('filename="0.png"'));
    assert.deepEqual(asked, [`${outId}@${DM_CHANNEL}`]);
  } finally { await t.close(); }
});
