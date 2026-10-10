// End to end: the real Slack adapter behind the switchboard host, against the channel's own in-process fake Slack
// (Web API over loopback HTTP + an in-process Socket Mode hub). No network, no sleeps, no wall-clock asserts.
import { test, afterEach } from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OutputStore } from "../../../media/src/index.ts";
import {
  BOT_USER, FAKE_APP_TOKEN, FAKE_BOT_TOKEN, FakeSlack, blockAction, message, quietSleep, slash,
} from "../../../channels-slack/test/helpers/fake-slack.ts";
import { TEST_MESSAGE } from "../../src/rpc/channel-surface.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import type { ApprovalView } from "../../src/approvals/service.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { assert } from "./e2e-assert.ts";
import { startE2e, type E2e } from "./e2e-rig.ts";
import { OWNER } from "./switchboard-rig.ts";

const USER = "UHUMAN01";
const DM = "DHUMAN01"; // what the fake's conversations.open returns for USER
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const OUTPUT_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

let fake: FakeSlack | undefined;
let e2e: E2e | undefined;
afterEach(async () => {
  await e2e?.switchboard.stop();
  e2e?.close();
  await fake?.close();
  fake = undefined; e2e = undefined;
});

async function up(o: { config?: Record<string, unknown>; adapterDeps?: Record<string, unknown> } = {}): Promise<{ e2e: E2e; fake: FakeSlack }> {
  const f = (fake = new FakeSlack());
  await f.listen();
  const rig = (e2e = await startE2e({
    id: "slack",
    adapterDeps: { baseUrl: f.baseUrl, webSocket: f.webSocket, sleep: quietSleep, random: () => 0.5, ...o.adapterDeps },
    secrets: { "channels.slack.bot-token": FAKE_BOT_TOKEN, "channels.slack.app-token": FAKE_APP_TOKEN },
    config: { dmAllowlist: [USER], ...o.config },
  }));
  await rig.until(() => rig.switchboard.view.status("slack")?.state === "running" && f.sockets.some((s) => !s.closed), "slack running with an open socket");
  return { e2e: rig, fake: f };
}

const posts = (f: FakeSlack) => f.callsOf("chat.postMessage");
const dmFrom = (user: string, text: string, ts: string) => message({ channel: DM, user, text, ts, eventId: `Ev-${ts}` });

function approvalFor(humanId: string, sessionId: string): ApprovalView {
  return {
    id: "req-1", status: "pending", capability: "net.submit", tool: "demo.net", risk: "medium", principal: humanId,
    subject: { kind: "agent", id: "main" }, actionHash: "h", turnId: "t", taskId: "task", sessionId, createdAt: 0, expiresAt: 600_000, delegable: false,
    summary: "send a mail to a@example.org",
  } as ApprovalView;
}

test("a linked person's DM is answered through the real adapter; an unlinked sender gets the pairing notice only", async () => {
  const { e2e: rig, fake: f } = await up({ config: { dmAllowlist: [USER, "USTRANGER"] } });
  const { humanId } = rig.link("slack", BOT_USER, USER);
  f.push(dmFrom(USER, "what is 2+2?", "1700000100.000200"));
  await rig.until(() => posts(f).length === 1, "the reply");
  assert.equal(posts(f)[0]!.body.channel, DM);
  assert.equal(posts(f)[0]!.body.text, "echo:what is 2+2?");
  assert.equal(posts(f)[0]!.body.thread_ts, "1700000100.000200", "the router replies to the message (replyTo), which Slack shows as a thread");
  const sessions = rig.store.listSessions({ owner: deriveUserPrincipal(humanId), kind: "channel" }).sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.chatKey, `slack:${DM}`);

  // a threaded message is answered in its thread
  f.push(message({ channel: DM, user: USER, text: "in thread", ts: "1700000200.000200", threadTs: "1700000200.000200", eventId: "Ev-thread" }));
  await rig.until(() => posts(f).length === 2, "the thread reply");
  assert.equal(posts(f)[1]!.body.channel, DM);
  assert.equal(posts(f)[1]!.body.thread_ts, "1700000200.000200");
  assert.equal(posts(f)[1]!.body.text, "echo:in thread");

  // a stranger allowed to DM the bot but not linked: notice, no turn
  const before = rig.provider.requests.length;
  const stranger = "USTRANGER";
  const n = posts(f).length;
  f.push(message({ channel: "DSTRANGER", user: stranger, text: "let me in", ts: "1700000300.000200", eventId: "Ev-stranger" }));
  await rig.until(() => posts(f).length === n + 1, "the pairing notice");
  assert.equal(posts(f)[n]!.body.channel, "DSTRANGER");
  assert.match(String(posts(f)[n]!.body.text), /not paired/i);
  assert.equal(rig.provider.requests.length, before, "no turn ran for the stranger");
});

test("an approval is shown as buttons to the approver; only the approver's press decides", async () => {
  const { e2e: rig, fake: f } = await up();
  const { humanId } = rig.link("slack", BOT_USER, USER);
  f.push(dmFrom(USER, "do it", "1700000100.000200"));
  await rig.until(() => posts(f).length === 1, "the reply");
  const session = rig.store.listSessions({ owner: deriveUserPrincipal(humanId), kind: "channel" }).sessions[0]!;
  rig.switchboard.approvalEvents.emit("approval.requested", { approval: approvalFor(humanId, session.id), nonce: "nonce-1", foregroundUntil: 1 });
  await rig.until(() => posts(f).length === 2, "the approval prompt");
  const prompt = posts(f)[1]!.body;
  assert.equal(prompt.channel, DM);
  assert.match(String(prompt.text), /demo\.net/);
  assert.equal(JSON.stringify(prompt).includes("nonce-1"), false, "the nonce never reaches Slack");
  const blocks = prompt.blocks as { type: string; elements?: { text: { text: string }; action_id: string }[] }[];
  const buttons = blocks.find((b) => b.type === "actions")!.elements!;
  assert.deepEqual(buttons.map((b) => b.text.text), ["Approve", "Deny"]);
  const approve = buttons[0]!.action_id;

  // another user pressing the button decides nothing
  const stray = blockAction({ user: "UOTHER001", channel: DM, messageTs: "1700000500.000100", actionId: approve });
  f.push(stray);
  await rig.until(() => f.latest().ackedIds().includes(String(stray.envelope_id)), "the press was acknowledged");
  await rig.switchboard.idle();
  await rig.clock.advance(0);
  assert.equal(rig.approvals.decisions.length, 0);

  // the approver's press is relayed to the approval service with the person and the surface (a private chat: T2)
  f.push(blockAction({ user: USER, channel: DM, messageTs: "1700000500.000100", actionId: approve }));
  await rig.until(() => rig.approvals.decisions.length === 1, "the decision");
  assert.deepEqual(rig.approvals.decisions[0], { requestId: "req-1", nonce: "nonce-1", decision: "approve", person: humanId, surface: 2 });
  // the buttons are settled in place
  await rig.until(() => f.callsOf("chat.update").length === 1, "the settled message");
  assert.equal("blocks" in f.callsOf("chat.update")[0]!.body, false);
});

test("channel.test --send-owner reaches the IM channel conversations.open returned, not the raw user id", async () => {
  const { e2e: rig, fake: f } = await up();
  const { humanId } = rig.link("slack", BOT_USER, USER);
  const out = await rig.call("channel.test", { id: "slack", sendOwner: true }, humanId);
  assert.equal(out.sent, true);
  assert.deepEqual(f.callsOf("conversations.open").map((c) => c.body), [{ users: USER }]);
  assert.equal(posts(f).length, 1);
  assert.equal(posts(f)[0]!.body.channel, DM);
  assert.notEqual(posts(f)[0]!.body.channel, USER);
  assert.equal(posts(f)[0]!.body.text, TEST_MESSAGE);
});

test("channel.test --send-owner for a user who may not DM the bot sends nothing", async () => {
  const { e2e: rig, fake: f } = await up({ config: { dmAllowlist: [] } });
  const { humanId } = rig.link("slack", BOT_USER, USER);
  await assert.rejects(rig.call("channel.test", { id: "slack", sendOwner: true }, humanId), /could not be sent/);
  assert.equal(f.callsOf("conversations.open").length, 0);
  assert.equal(posts(f).length, 0);
});

test("/plur1bus link <code> through the socket creates a pending claim", async () => {
  const { e2e: rig, fake: f } = await up();
  const human = rig.identity.createHuman({ displayName: "Pat" }, OWNER);
  const p = rig.identity.startPairing({ humanId: human.id, channel: "slack" }, { user: human.id, host: "test", kind: "person", role: "member" });
  f.push(slash({ user: "UNEWUSER1", channel: "DNEWUSER1", text: `link ${p.code}` }));
  await rig.until(() => f.callsOf("chat.postEphemeral").length === 1, "the ephemeral answer");
  const pairings = rig.identity.list({}).pairings as unknown as { id: string; state: string; humanId?: string; channel?: string }[];
  const mine = pairings.filter((x) => x.id === p.pairingId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.state, "claimed");
  assert.equal(JSON.stringify(f.callsOf("chat.postEphemeral")[0]!.body).includes(p.code), false, "the code is never echoed");
  assert.equal(rig.identity.list({}).humans.find((h) => h.id === human.id)!.identities.length, 0, "not linked until the owner confirms");
});

test("an image a tool produced follows the text reply into the same conversation", async () => {
  const root = tempDir("slack-out-");
  mkdirSync(join(root, OUTPUT_ID), { recursive: true });
  writeFileSync(join(root, OUTPUT_ID, "0.png"), PNG);
  const file = { path: "0.png", bytes: PNG.length, sha256: createHash("sha256").update(PNG).digest("hex"), format: "png" };
  writeFileSync(join(root, OUTPUT_ID, "manifest.json"), JSON.stringify({ schema: "media.output/1", id: OUTPUT_ID, files: [file] }));
  const store = new OutputStore(root);
  // The rig gives the host no `outputs` port, so the adapter's own seam stands in for the host's (spread last, it wins).
  const { e2e: rig, fake: f } = await up({ adapterDeps: { outputs: { store, authorize: async () => true } } });
  rig.link("slack", BOT_USER, USER);
  rig.provider.script = () => [
    { type: "tool.call", id: "c1", name: "media.generate", args: {} },
    { type: "tool.result", id: "c1", output: JSON.stringify({ id: OUTPUT_ID, files: [file] }) },
    { type: "delta", text: "here is your image" },
  ];
  f.push(dmFrom(USER, "draw", "1700000100.000200"));
  await rig.until(() => f.callsOf("files.completeUploadExternal").length === 1, "the image upload");
  assert.equal(posts(f).length, 1);
  assert.equal(posts(f)[0]!.body.text, "here is your image");
  assert.equal(f.callsOf("files.getUploadURLExternal")[0]!.body.filename, "0.png");
  const complete = f.callsOf("files.completeUploadExternal")[0]!.body;
  assert.equal(complete.channel_id, DM);
  assert.deepEqual([...f.uploads.values()].map((b) => b.equals(PNG)), [true]);
  assert.equal(f.calls.findIndex((c) => c.method === "chat.postMessage") < f.calls.findIndex((c) => c.method === "files.completeUploadExternal"), true, "text first, image after");
});
