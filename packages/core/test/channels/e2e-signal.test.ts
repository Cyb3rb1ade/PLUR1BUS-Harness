// The real Signal adapter behind the switchboard host, talking to the channel's own in-process fake signal-cli JSON-RPC daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startE2e, type E2e } from "./e2e-rig.ts";
import { flush, OWNER } from "./switchboard-rig.ts";
import { TEST_MESSAGE } from "../../src/rpc/channel-surface.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import type { ApprovalView } from "../../src/approvals/service.ts";
import { FakeDaemon, textEnvelope } from "../../../channels-signal/test/helpers/fake-daemon.ts";
import { ACCOUNT, DM, DM_UUID, STRANGER } from "../../../channels-signal/test/helpers/setup.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const never = () => new Promise<void>(() => {});
let ts = 1_700_000_001_000;

async function signal(o: { dmAllowlist?: string[]; outputs?: unknown } = {}): Promise<{ e2e: E2e; daemon: FakeDaemon; close(): Promise<void> }> {
  const daemon = new FakeDaemon();
  await daemon.listen();
  const e2e = await startE2e({
    id: "signal",
    // The adapter connects to the fake daemon over loopback TCP (its real transport); timers are virtual.
    adapterDeps: { sleep: async () => {}, timeout: never, random: () => 0.5, ...(o.outputs ? { outputs: o.outputs } : {}) },
    config: { account: ACCOUNT, endpoint: { host: "127.0.0.1", port: daemon.port }, dmAllowlist: o.dmAllowlist ?? [DM] },
  });
  await e2e.until(() => e2e.switchboard.view.status("signal")?.state === "running", "signal running");
  return { e2e, daemon, async close() { e2e.close(); await e2e.switchboard.stop(); await daemon.close(); } };
}

const say = (daemon: FakeDaemon, text: string, number = DM) => daemon.push(textEnvelope({ number, uuid: DM_UUID, message: text, ts: ++ts }));

test("a linked person's DM runs a turn and the reply goes back to their number; an unlinked sender only gets the pairing notice", async () => {
  const { e2e, daemon, close } = await signal({ dmAllowlist: [DM, STRANGER] });
  try {
    e2e.link("signal", ACCOUNT, DM);
    say(daemon, "hello bot");
    await e2e.until(() => daemon.sent().length > 0, "reply sent");
    assert.deepEqual(daemon.sent()[0]!.recipient, [DM]);
    assert.equal(daemon.sent()[0]!.account, ACCOUNT);
    assert.match(daemon.sent()[0]!.message, /echo:hello bot/);
    assert.equal(e2e.provider.requests.length, 1);

    say(daemon, "let me in", STRANGER);
    await e2e.until(() => daemon.sent().length === 2, "notice sent");
    assert.deepEqual(daemon.sent()[1]!.recipient, [STRANGER]);
    assert.doesNotMatch(daemon.sent()[1]!.message, /echo:/);
    assert.equal(e2e.provider.requests.length, 1, "no turn for the unlinked sender");
  } finally { await close(); }
});

async function pendingApproval() {
  const s = await signal({ dmAllowlist: [DM, STRANGER] });
  const { humanId } = s.e2e.link("signal", ACCOUNT, DM);
  say(s.daemon, "do it");
  await s.e2e.until(() => s.daemon.sent().length > 0, "reply sent");
  const session = s.e2e.store.listSessions({ owner: deriveUserPrincipal(humanId), kind: "channel" }).sessions[0]!;
  const view = { id: "req-1", status: "pending", capability: "net.submit", tool: "demo.net", risk: "medium", principal: humanId, subject: { kind: "agent", id: "main" }, actionHash: "h", turnId: "t", taskId: "task", sessionId: session.id, createdAt: 0, expiresAt: 600_000, delegable: false, summary: "send a mail to a@example.org" } as ApprovalView;
  s.e2e.switchboard.approvalEvents.emit("approval.requested", { approval: view, nonce: "nonce-1", foregroundUntil: 1 });
  await s.e2e.until(() => s.daemon.sent().length > 1, "prompt sent");
  const prompt = s.daemon.sent().at(-1)!.message as string;
  const token = /\b([2-9A-HJ-NP-Z]{4})\b/.exec(prompt.split("\n").at(-1)!)?.[1] ?? /reply[^\n]*?([2-9A-HJ-NP-Z]{4})/i.exec(prompt)?.[1];
  return { ...s, humanId, prompt, token: token! };
}

test("an approval prompt with reply codes reaches the chat; the approver's code decides, nobody else's and no wrong code does", async () => {
  const { e2e, daemon, humanId, prompt, token, close } = await pendingApproval();
  try {
    assert.match(prompt, /demo\.net/);
    assert.match(prompt, /1 = /);
    assert.equal(prompt.includes("nonce-1"), false);
    assert.ok(token, `a token in: ${prompt}`);
    const before = daemon.sent().length;

    say(daemon, `${token} 1`, STRANGER); // allowed to DM, but not an approver (answers with a notice and the refusal)
    say(daemon, "ZZZZ 1"); // wrong token
    say(daemon, `${token} 7`); // no such code
    await e2e.until(() => daemon.sent().length >= before + 3, "refusals answered");
    await flush(10);
    assert.equal(e2e.approvals.decisions.length, 0);

    say(daemon, `${token} 1`);
    await e2e.until(() => e2e.approvals.decisions.length === 1, "decision");
    assert.deepEqual(e2e.approvals.decisions, [{ requestId: "req-1", nonce: "nonce-1", decision: "approve", person: humanId, surface: 2 }]);
    say(daemon, `${token} 0`); // replay: single use
    await flush(20);
    assert.equal(e2e.approvals.decisions.length, 1);
  } finally { await close(); }
});

test("channel.test --send-owner delivers the fixed test text to the person's number", async () => {
  const { e2e, daemon, close } = await signal();
  try {
    const { humanId } = e2e.link("signal", ACCOUNT, DM);
    const out = await e2e.call("channel.test", { id: "signal", sendOwner: true }, humanId);
    assert.equal(out.sent, true);
    const sent = daemon.sent().at(-1)!;
    assert.deepEqual(sent.recipient, [DM]);
    assert.equal(sent.message, TEST_MESSAGE);
  } finally { await close(); }
});

test("channel.test --send-owner to a linked uuid works when the uuid is allowed, and refuses a number that may not be messaged", async () => {
  const { e2e, daemon, close } = await signal({ dmAllowlist: [DM_UUID] });
  try {
    const a = e2e.link("signal", ACCOUNT, DM_UUID, "Uu");
    assert.equal((await e2e.call("channel.test", { id: "signal", sendOwner: true }, a.humanId)).sent, true);
    assert.deepEqual(daemon.sent().at(-1)!.recipient, [DM_UUID]);
    const b = e2e.link("signal", ACCOUNT, STRANGER, "Nope");
    await assert.rejects(e2e.call("channel.test", { id: "signal", sendOwner: true }, b.humanId));
  } finally { await close(); }
});

test("/link <code> in a DM creates a pending claim in the identity service", async () => {
  const { e2e, daemon, close } = await signal();
  try {
    const human = e2e.identity.createHuman({ displayName: "Pat" }, OWNER);
    const self = { user: human.id, host: "test", kind: "person", role: "member" } as const;
    const p = e2e.identity.startPairing({ humanId: human.id, channel: "signal" }, self);
    say(daemon, `/link ${p.code}`);
    await e2e.until(() => daemon.sent().length > 0, "link answered");
    assert.deepEqual(daemon.sent()[0]!.recipient, [DM]);
    const claimed = e2e.identity.list({}).pairings.filter((x) => x.channel === "signal" && x.state === "claimed");
    assert.equal(claimed.length, 1);
    assert.deepEqual(claimed[0]!.claimedBy, { channel: "signal", accountId: ACCOUNT, userId: DM });
    assert.equal(e2e.provider.requests.length, 0, "a command is not a turn");
  } finally { await close(); }
});

test("an image a tool produced in the turn follows the text reply as an attachment", async () => {
  const { OutputStore } = await import("../../../media/src/store.ts");
  const root = tempDir("signal-media-");
  const id = "0b3c9a52-6d1e-4f7a-9c1e-3a5d7f9b1c2d";
  const bytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, "0.png"), bytes);
  const manifest = { schema: "media.output/1", id, createdAt: 0, prompt: "p", parameters: {}, referenceHashes: [], metadata: { seed: null, costUsd: null, origin: "test" }, partial: false, files: [{ path: "0.png", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, format: "png" }] };
  writeFileSync(join(root, id, "manifest.json"), JSON.stringify(manifest));
  const store = new OutputStore(root);
  // The host's own `outputs` is not wired in the rig, so the real store comes in through the adapter seam.
  const { e2e, daemon, close } = await signal({ outputs: { store, authorize: async (outputId: string) => outputId === id } });
  try {
    e2e.link("signal", ACCOUNT, DM);
    e2e.provider.script = () => [
      { type: "tool.call", id: "t1", name: "image.generate", args: {} },
      { type: "tool.result", id: "t1", output: JSON.stringify({ id, files: [{ path: "0.png" }] }) },
      { type: "delta", text: "here you go" },
    ];
    say(daemon, "draw");
    await e2e.until(() => daemon.sent().length >= 2, "text and attachment sent");
    assert.match(daemon.sent()[0]!.message, /here you go/);
    const att = daemon.sent()[1]!;
    assert.deepEqual(att.recipient, [DM]);
    assert.equal(att.attachments.length, 1);
    assert.ok((att.attachments[0] as string).startsWith("data:image/png;filename=0.png;base64,"));
  } finally { await close(); }
});
