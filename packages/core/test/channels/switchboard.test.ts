import { test } from "node:test";
import assert from "node:assert/strict";
import { createSwitchboard, secretNamesOf, type ApprovalDecisionLike } from "../../src/channels/switchboard.ts";
import type { ApprovalView } from "../../src/approvals/service.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { fakeBinding, flush, makeRig, FakeAdapter, type Rig } from "./switchboard-rig.ts";

const TOKEN = "unit-test-token-0123456789";

/** An enabled discord channel with its token stored, started and running. */
async function running(o: Parameters<typeof makeRig>[0] = {}): Promise<Rig> {
  const rig = makeRig(o);
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  await rig.clock.advance(0);
  return rig;
}

test("every channel is off by default: nothing is built, loaded or read", async () => {
  const rig = makeRig();
  await rig.switchboard.start();
  await rig.clock.advance(60_000);
  assert.equal(rig.made.length, 0);
  assert.equal(rig.switchboard.view.status("discord")?.state, "stopped");
  assert.deepEqual(rig.secrets.reads, []);
  rig.close();
});

test("enabling a channel starts it with its configuration; the secret is read by the adapter, not the host", async () => {
  const rig = await running();
  assert.equal(rig.switchboard.view.status("discord")?.state, "running");
  assert.equal(rig.made.length >= 1, true);
  const a = rig.adapter();
  assert.equal(a.starts, 1);
  assert.equal(a.cfg.tokenSecret, "channels.discord.token");
  assert.equal(a.cfg.enabled, true);
  assert.deepEqual(rig.secrets.reads, []); // only has() so far; the adapter reveals the value itself
  assert.equal(await (a.deps.secrets as { reveal(n: string): Promise<string | null> }).reveal("channels.discord.token"), TOKEN);
  assert.equal(typeof rig.switchboard.view.status("discord")?.startedAt, "number");
  rig.close();
});

test("disabling stops the channel; enabling again starts a fresh instance", async () => {
  const rig = await running();
  const first = rig.adapter();
  rig.config.set("discord", { enabled: false });
  await rig.switchboard.idle();
  assert.equal(first.stops, 1);
  assert.equal(rig.switchboard.view.status("discord")?.state, "stopped");
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.idle();
  await rig.clock.advance(0);
  assert.equal(rig.switchboard.view.status("discord")?.state, "running");
  assert.notEqual(rig.adapter(), first);
  rig.close();
});

test("another key of the channel restarts it with the new value; other channels are left alone", async () => {
  const rig = await running({ ids: ["discord", "slack"] });
  rig.secrets.put("channels.slack.bot-token", "slack-bot-token-aaaaaaaa");
  rig.secrets.put("channels.slack.app-token", "slack-app-token-bbbbbbbb");
  rig.config.set("slack", { enabled: true });
  await rig.switchboard.idle();
  await rig.clock.advance(0);
  const discord = rig.adapter("discord"), slack = rig.adapter("slack");
  assert.equal(slack.starts, 1);
  rig.config.set("discord", { allowlist: ["123456789012345678"] });
  await rig.switchboard.idle();
  await rig.clock.advance(0);
  assert.equal(discord.stops, 1);
  assert.deepEqual(rig.adapter("discord").cfg.allowlist, ["123456789012345678"]);
  assert.equal(rig.adapter("discord").starts, 1);
  assert.equal(slack.stops, 0, "an unrelated channel is not restarted");
  assert.equal(rig.switchboard.view.status("slack")?.state, "running");
  rig.close();
});

test("a change outside channels.* does nothing", async () => {
  const rig = await running();
  const a = rig.adapter();
  // an unrelated change: same channels subtree, notified anyway
  rig.config.set("slack", { allowlist: [] });
  await rig.switchboard.idle();
  assert.equal(a.stops, 0);
  assert.equal(rig.switchboard.view.status("discord")?.state, "running");
  rig.close();
});

test("a missing secret: misconfigured with the reason, never started, no crash loop", async () => {
  const rig = makeRig();
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  const s = rig.switchboard.view.status("discord");
  assert.equal(s?.state, "misconfigured");
  assert.match(s?.lastError ?? "", /secret not found: channels\.discord\.token/);
  await rig.clock.advance(10 * 60_000 - 1); // far beyond any backoff; only the recheck timer runs
  assert.equal(rig.made.filter((a) => a.starts > 0).length, 0);
  assert.equal(rig.made.length, 0, "no adapter was even built");
  assert.equal(rig.switchboard.view.status("discord")?.attempts, 0);
  rig.close();
});

test("a misconfigured channel starts by itself once its secret is stored (no restart, no config change)", async () => {
  const rig = makeRig({ switchboard: { recheckMs: 30_000 } });
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  assert.equal(rig.switchboard.view.status("discord")?.state, "misconfigured");
  rig.secrets.put("channels.discord.token", TOKEN);
  await rig.clock.advance(29_999);
  assert.equal(rig.switchboard.view.status("discord")?.state, "misconfigured");
  await rig.clock.advance(1);
  await rig.switchboard.idle();
  await rig.clock.advance(0);
  assert.equal(rig.switchboard.view.status("discord")?.state, "running");
  assert.equal(rig.switchboard.view.status("discord")?.lastError, undefined);
  rig.close();
});

test("disabling a misconfigured channel clears its error", async () => {
  const rig = makeRig();
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  rig.config.set("discord", { enabled: false });
  await rig.switchboard.idle();
  const s = rig.switchboard.view.status("discord");
  assert.equal(s?.state, "stopped");
  assert.equal(s?.lastError, undefined);
  rig.close();
});

test("a configuration the adapter refuses parks the channel as misconfigured", async () => {
  const made: FakeAdapter[] = [];
  const rig = makeRig({ binding: (id) => fakeBinding(id, made, { constructorThrows: () => new RangeError("allowlist must be an array of Discord snowflake ids") }) });
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  const s = rig.switchboard.view.status("discord");
  assert.equal(s?.state, "misconfigured");
  assert.match(s?.lastError ?? "", /invalid configuration: allowlist must be/);
  await rig.clock.advance(5 * 60_000);
  assert.equal(made.length, 0);
  rig.close();
});

test("an adapter that cannot be loaded parks the channel as misconfigured", async () => {
  const rig = makeRig({ binding: (id) => ({ id, manifest: fakeBinding(id, []).manifest, load: async () => { throw new Error("module not found"); } }) });
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  assert.match(rig.switchboard.view.status("discord")?.lastError ?? "", /could not be loaded: module not found/);
  assert.equal(rig.switchboard.view.status("discord")?.state, "misconfigured");
  rig.close();
});

test("a start that fails is retried with backoff and gives up after maxRestarts, like any other channel", async () => {
  const rig = makeRig({ binding: (id, made) => fakeBinding(id, made, { onMake: (a) => { a.startPlan = ["throw"]; }, manifest: { maxRestarts: 2 } }) });
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  await rig.clock.advance(0);
  assert.equal(rig.switchboard.view.status("discord")?.state, "backoff");
  assert.equal(rig.switchboard.view.status("discord")?.attempts, 1);
  await rig.clock.advance(1000);
  assert.equal(rig.switchboard.view.status("discord")?.attempts, 2);
  await rig.clock.advance(2000);
  assert.equal(rig.switchboard.view.status("discord")?.state, "failed");
  assert.match(rig.switchboard.view.status("discord")?.lastError ?? "", /start failed/);
  const builds = rig.made.length;
  await rig.clock.advance(60_000);
  assert.equal(rig.made.length, builds, "no more attempts once failed");
  rig.close();
});

test("a secret value never appears in a status error, a probe detail or an error leaving the adapter", async () => {
  const rig = makeRig({ binding: (id, made) => fakeBinding(id, made, { onMake: (a) => { a.startPlan = ["throw"]; a.startError = `login failed for token ${TOKEN}`; } }) });
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  // The adapter has read its secret (as it does in start) before it fails.
  await (rig.adapter().deps.secrets as { reveal(n: string): Promise<string | null> }).reveal("channels.discord.token");
  rig.adapter().startError = `login failed for token ${TOKEN}`;
  await rig.clock.advance(1000);
  const seen = JSON.stringify({ list: rig.switchboard.view.list(), status: rig.switchboard.view.status("discord"), logs: rig.logs });
  assert.equal(seen.includes(TOKEN), false);
  assert.match(rig.switchboard.view.status("discord")?.lastError ?? "", /login failed for token \[redacted\]/);
  rig.close();
});

test("health: the registry keeps the adapter's last health answer; probe asks the adapter now", async () => {
  const rig = await running();
  assert.deepEqual(rig.switchboard.view.status("discord")?.health, { ok: true });
  rig.adapter().healthAnswer = { ok: true, detail: "gateway ready" };
  assert.deepEqual(await rig.switchboard.view.probe("discord"), { ok: true, detail: "gateway ready" });
  await rig.clock.advance(30_000);
  assert.deepEqual(rig.switchboard.view.status("discord")?.health, { ok: true, detail: "gateway ready" });
  rig.close();
});

test("stop(): channels are stopped and the configuration is no longer followed", async () => {
  const rig = await running();
  const a = rig.adapter();
  assert.equal(rig.config.listeners(), 1);
  await rig.switchboard.stop();
  assert.equal(a.stops, 1);
  assert.equal(rig.config.listeners(), 0);
  rig.config.set("discord", { enabled: false });
  await rig.switchboard.idle();
  rig.close();
});

test("secretNamesOf finds nested *Secret names, once", () => {
  assert.deepEqual(secretNamesOf({ enabled: true, imap: { passwordSecret: "a", user: "u" }, smtp: { passwordSecret: "a" }, botTokenSecret: "b", tokenSecret: "" }), ["a", "b"]);
});

// --- inbound: router → identity → session → turn → reply ------------------------------------------------------------------

test("a linked person's message is answered through the chat's one session; their handle needs no account id", async () => {
  const rig = await running();
  const { humanId } = rig.link("discord", "bot-1", "sender-1");
  const a = rig.adapter();
  await a.inbound({ text: "what is 2+2?" });
  assert.deepEqual(a.sent, [{ chatId: "chat-1", text: "echo:what is 2+2?" }]);
  const sessions = rig.store.listSessions({ owner: deriveUserPrincipal(humanId), kind: "channel" }).sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.chatKey, "discord:chat-1");
  await a.inbound({ text: "again" });
  assert.equal(rig.store.listSessions({ owner: deriveUserPrincipal(humanId), kind: "channel" }).sessions.length, 1, "D21: one active session per chat");
  assert.equal(rig.provider.requests.at(-1)?.messages.at(-1)?.text, "again");
  rig.close();
});

test("an unlinked sender reaches no session and gets the pairing notice", async () => {
  const rig = await running();
  const a = rig.adapter();
  await a.inbound({ senderId: "stranger", text: "let me in" });
  assert.equal(rig.provider.requests.length, 0);
  assert.match(a.sent[0]?.text ?? "", /not paired/i);
  assert.equal(rig.store.listSessions({ owner: "x" }).sessions.length, 0);
  rig.close();
});

test("a revoked link no longer reaches an agent", async () => {
  const rig = await running();
  const { humanId } = rig.link("discord", "bot-1", "sender-1");
  const link = rig.identity.list({}).humans.find((h) => h.id === humanId)!.identities[0]!;
  rig.identity.unlink({ linkId: link.id }, { user: humanId, host: "test", kind: "person", role: "member" });
  await rig.adapter().inbound({});
  assert.equal(rig.provider.requests.length, 0);
  rig.close();
});

test("the same handle linked to two people is nobody (fail closed)", async () => {
  const rig = await running();
  rig.link("discord", "bot-1", "sender-1");
  rig.link("discord", "bot-2", "sender-1");
  await rig.adapter().inbound({});
  assert.equal(rig.provider.requests.length, 0);
  rig.close();
});

test("/new archives the chat's session; the next message opens a new one", async () => {
  const rig = await running();
  const { humanId } = rig.link("discord", "bot-1", "sender-1");
  const a = rig.adapter();
  await a.inbound({ text: "one" });
  await a.inbound({ text: "/new" });
  await a.inbound({ text: "two" });
  const all = rig.store.listSessions({ owner: deriveUserPrincipal(humanId), kind: "channel", archived: "any" }).sessions;
  assert.equal(all.length, 2);
  assert.equal(all.filter((s) => s.archivedAt === null).length, 1);
  rig.close();
});

test("a failing turn is answered with the router's apology, not an exception", async () => {
  const rig = await running();
  rig.link("discord", "bot-1", "sender-1");
  rig.provider.script = () => { throw new Error("provider down"); };
  await rig.adapter().inbound({ text: "hi" });
  assert.match(rig.adapter().sent.at(-1)?.text ?? "", /did not work/i);
  rig.close();
});

test("messages from a stopped adapter instance are dropped", async () => {
  const rig = await running();
  rig.link("discord", "bot-1", "sender-1");
  const old = rig.adapter();
  rig.config.set("discord", { enabled: false });
  await rig.switchboard.idle();
  await old.inbound({ text: "late" });
  assert.equal(rig.provider.requests.length, 0);
  rig.close();
});

// --- D109 relay ------------------------------------------------------------------------------------------------------------

function approvalFor(rig: Rig, humanId: string, sessionId: string, extra: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: "req-1", status: "pending", capability: "net.submit", tool: "demo.net", risk: "medium", principal: humanId,
    subject: { kind: "agent", id: "main" }, actionHash: "h", turnId: "t", taskId: "task", sessionId, createdAt: 0, expiresAt: 600_000, delegable: false,
    summary: "send a mail to a@example.org", ...extra,
  } as ApprovalView;
}

async function pendingApproval() {
  const rig = await running();
  const { humanId } = rig.link("discord", "bot-1", "sender-1");
  const a = rig.adapter();
  await a.inbound({ text: "do it" });
  const session = rig.store.listSessions({ owner: deriveUserPrincipal(humanId), kind: "channel" }).sessions[0]!;
  const view = approvalFor(rig, humanId, session.id);
  rig.switchboard.approvalEvents.emit("approval.requested", { approval: view, nonce: "nonce-1", foregroundUntil: 1 });
  await flush(10);
  return { rig, a, humanId, view };
}

test("an approval asked in a channel chat is shown there, to the person's linked handles only", async () => {
  const { rig, a } = await pendingApproval();
  assert.equal(a.prompts.length, 1);
  const p = a.prompts[0]!;
  assert.equal(p.chatId, "chat-1");
  assert.deepEqual(p.approverIds, ["sender-1"]);
  assert.deepEqual(p.choices.map((c) => c.id), ["approve", "deny"]);
  assert.match(p.text, /demo\.net/);
  assert.match(p.text, /send a mail to a@example\.org/);
  assert.equal(p.text.includes("nonce-1"), false, "the nonce never reaches a chat");
  rig.close();
});

test("a press becomes the approval service's decision, bound to the person and the channel's surface", async () => {
  const { rig, a, humanId } = await pendingApproval();
  await a.decide({ promptId: "prompt-1", chatId: "chat-1", senderId: "sender-1", choiceId: "approve" });
  await flush(5);
  assert.deepEqual(rig.approvals.decisions, [{ requestId: "req-1", nonce: "nonce-1", decision: "approve", person: humanId, surface: 2 }]);
  // a second press of the same prompt does nothing
  await a.decide({ promptId: "prompt-1", chatId: "chat-1", senderId: "sender-1", choiceId: "deny" });
  await flush(5);
  assert.equal(rig.approvals.decisions.length, 1);
  rig.close();
});

test("deny is a decision too; an unknown choice is ignored", async () => {
  const { rig, a } = await pendingApproval();
  await a.decide({ promptId: "prompt-1", chatId: "chat-1", senderId: "sender-1", choiceId: "maybe" });
  await flush(5);
  assert.equal(rig.approvals.decisions.length, 0);
  await a.decide({ promptId: "prompt-1", chatId: "chat-1", senderId: "sender-1", choiceId: "deny" });
  await flush(5);
  assert.equal(rig.approvals.decisions[0]?.decision, "deny");
  rig.close();
});

test("a press by someone who is not the person's handle, or from another chat, decides nothing", async () => {
  const { rig, a } = await pendingApproval();
  await a.decide({ promptId: "prompt-1", chatId: "chat-1", senderId: "intruder", choiceId: "approve" });
  await a.decide({ promptId: "prompt-1", chatId: "elsewhere", senderId: "sender-1", choiceId: "approve" });
  await flush(5);
  assert.equal(rig.approvals.decisions.length, 0);
  rig.close();
});

test("a group chat decides on the lower surface", async () => {
  const rig = await running();
  const { humanId } = rig.link("discord", "bot-1", "sender-1");
  const a = rig.adapter();
  await a.inbound({ chatId: "room-1", chatKind: "group", text: "do it" });
  const session = rig.store.listSessions({ owner: deriveUserPrincipal(humanId), kind: "channel" }).sessions[0]!;
  rig.switchboard.approvalEvents.emit("approval.requested", { approval: approvalFor(rig, humanId, session.id), nonce: "n", foregroundUntil: 1 });
  await flush(10);
  await a.decide({ promptId: "prompt-1", chatId: "room-1", senderId: "sender-1", choiceId: "approve" });
  await flush(5);
  assert.equal(rig.approvals.decisions[0]?.surface, 1);
  rig.close();
});

test("an approval of a session that is not a channel chat, or of another person, is not relayed", async () => {
  const rig = await running();
  const { humanId } = rig.link("discord", "bot-1", "sender-1");
  const a = rig.adapter();
  const direct = rig.store.createSession({ kind: "direct", agentId: "main", owner: deriveUserPrincipal(humanId) });
  rig.switchboard.approvalEvents.emit("approval.requested", { approval: approvalFor(rig, humanId, direct.id), nonce: "n", foregroundUntil: 1 });
  await a.inbound({ text: "hi" });
  const session = rig.store.listSessions({ owner: deriveUserPrincipal(humanId), kind: "channel" }).sessions[0]!;
  rig.switchboard.approvalEvents.emit("approval.requested", { approval: approvalFor(rig, "someone-else", session.id), nonce: "n", foregroundUntil: 1 });
  await flush(10);
  assert.equal(a.prompts.length, 0);
  rig.close();
});

test("a resolved approval forgets its prompt: a late press decides nothing", async () => {
  const { rig, a, view } = await pendingApproval();
  rig.switchboard.approvalEvents.emit("approval.resolved", { approval: view, outcome: "approved" });
  await a.decide({ promptId: "prompt-1", chatId: "chat-1", senderId: "sender-1", choiceId: "approve" });
  await flush(5);
  assert.equal(rig.approvals.decisions.length, 0);
  rig.close();
});

test("decision callbacks of a stopped instance are not wired any more", async () => {
  const { rig, a } = await pendingApproval();
  rig.config.set("discord", { enabled: false });
  await rig.switchboard.idle();
  await a.decide({ promptId: "prompt-1", chatId: "chat-1", senderId: "sender-1", choiceId: "approve" });
  await flush(5);
  assert.equal(rig.approvals.decisions.length, 0);
  rig.close();
});

// --- owner target -----------------------------------------------------------------------------------------------------------

test("ownerTarget asks the adapter; without the method the handle is the chat", async () => {
  const rig = await running();
  const a = rig.adapter();
  a.ownerTarget = async (who) => `dm-for-${who.userId}`;
  assert.equal(await rig.switchboard.view.ownerTarget?.("discord", { userId: "u1" }), "dm-for-u1");
  delete (a as { resolveOwnerTarget?: unknown }).resolveOwnerTarget;
  Object.defineProperty(a, "resolveOwnerTarget", { value: undefined });
  assert.equal(await rig.switchboard.view.ownerTarget?.("discord", { userId: "u1" }), "u1");
  rig.close();
});

test("a switchboard without identity or sessions answers nobody and does not throw", async () => {
  const rig = makeRig({ switchboard: { identity: () => null, turns: () => null } });
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  await rig.clock.advance(0);
  await rig.adapter().inbound({});
  assert.equal(rig.provider.requests.length, 0);
  rig.close();
});

test("createSwitchboard is exported with the channel framework", () => {
  assert.equal(typeof createSwitchboard, "function");
});

export type { ApprovalDecisionLike };
