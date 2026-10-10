// The real Matrix adapter behind the switchboard host, talking to the channel's own in-process fake homeserver (loopback HTTP).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startE2e, type E2e } from "./e2e-rig.ts";
import { OWNER, flush } from "./switchboard-rig.ts";
import { TEST_MESSAGE } from "../../src/rpc/channel-surface.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import type { ApprovalView } from "../../src/approvals/service.ts";
import { ALICE, BOT, CAROL, DM, FAKE_TOKEN, FakeMatrix, ROOM, textMessage } from "../../../channels-matrix/test/helpers/fake-matrix.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const DAVE = "@dave:hs.test"; // may DM the bot, never linked
const DM_DAVE = "!dm-dave:hs.test";

async function matrix(o: { direct?: boolean; dmAllowlist?: string[]; outputs?: unknown } = {}): Promise<{ e2e: E2e; fake: FakeMatrix; close(): Promise<void> }> {
  const fake = new FakeMatrix();
  await fake.listen();
  fake.addRoom(ROOM, { members: 3 });
  if (o.direct !== false) {
    fake.addRoom(DM, { members: 2 });
    fake.addRoom(DM_DAVE, { members: 2 });
    fake.direct = { [ALICE]: [DM], [DAVE]: [DM_DAVE] };
  }
  const e2e = await startE2e({
    id: "matrix",
    // The adapter talks to the fake over loopback HTTP; its sleeps and rate limits are virtual.
    adapterDeps: { sleep: async () => {}, random: () => 0.5, ...(o.outputs ? { outputs: o.outputs } : {}) },
    secrets: { "channels.matrix.access-token": FAKE_TOKEN },
    config: { homeserverUrl: fake.baseUrl, userId: BOT, allowlist: [ROOM], dmAllowlist: o.dmAllowlist ?? [ALICE, DAVE] },
  });
  await e2e.until(() => e2e.switchboard.view.status("matrix")?.state === "running", "matrix running");
  await fake.waitIdle();
  return { e2e, fake, async close() { e2e.close(); await e2e.switchboard.stop(); await fake.close(); } };
}

const say = (fake: FakeMatrix, room: string, sender: string, text: string) => fake.deliver(room, [fake.message(room, sender, textMessage(text))]);
const bodies = (fake: FakeMatrix, room: string) => fake.sent.filter((s) => s.roomId === room && s.type === "m.room.message").map((s) => String(s.content.body));

test("a linked person's DM runs a turn and the reply lands in that room; an unlinked sender only gets the pairing notice", async () => {
  const { e2e, fake, close } = await matrix();
  try {
    e2e.link("matrix", BOT, ALICE);
    await say(fake, DM, ALICE, "hello bot");
    await e2e.until(() => bodies(fake, DM).length > 0, "reply sent");
    assert.match(bodies(fake, DM)[0]!, /echo:hello bot/);
    assert.equal(e2e.provider.requests.length, 1);

    await say(fake, DM_DAVE, DAVE, "let me in");
    await e2e.until(() => bodies(fake, DM_DAVE).length > 0, "notice sent");
    assert.doesNotMatch(bodies(fake, DM_DAVE)[0]!, /echo:/);
    assert.equal(e2e.provider.requests.length, 1, "no turn for the unlinked sender");
    assert.equal(bodies(fake, DM).length, 1, "nothing leaked to the other room");
  } finally { await close(); }
});

async function pendingApproval() {
  const s = await matrix();
  const { humanId } = s.e2e.link("matrix", BOT, ALICE);
  await say(s.fake, DM, ALICE, "do it");
  await s.e2e.until(() => bodies(s.fake, DM).length > 0, "reply sent");
  const session = s.e2e.store.listSessions({ owner: deriveUserPrincipal(humanId), kind: "channel" }).sessions[0]!;
  const view = { id: "req-1", status: "pending", capability: "net.submit", tool: "demo.net", risk: "medium", principal: humanId, subject: { kind: "agent", id: "main" }, actionHash: "h", turnId: "t", taskId: "task", sessionId: session.id, createdAt: 0, expiresAt: 600_000, delegable: false, summary: "send a mail to a@example.org" } as ApprovalView;
  s.e2e.switchboard.approvalEvents.emit("approval.requested", { approval: view, nonce: "nonce-1", foregroundUntil: 1 });
  await s.e2e.until(() => s.fake.sent.filter((x) => x.type === "m.reaction").length >= 2, "prompt and reactions sent");
  const prompt = s.fake.sent.find((x) => x.type === "m.room.message" && /demo\.net/.test(String(x.content.body)))!;
  const emojis = s.fake.sent.filter((x) => x.type === "m.reaction").map((x) => (x.content["m.relates_to"] as { key: string }).key);
  return { ...s, humanId, prompt, emojis };
}

test("an approval prompt appears in the room; the approver's reaction decides, another user's decides nothing", async () => {
  const { e2e, fake, humanId, prompt, emojis, close } = await pendingApproval();
  try {
    assert.equal(prompt.roomId, DM);
    assert.equal(String(prompt.content.body).includes("nonce-1"), false);
    assert.equal(emojis.length, 2);
    const [approve] = emojis as [string];

    await fake.deliver(DM, [fake.reaction(DM, CAROL, prompt.eventId, approve)]);
    await flush(10);
    assert.equal(e2e.approvals.decisions.length, 0, "a bystander's reaction decides nothing");
    assert.equal(fake.redactions.length, 1, "and is redacted");

    await fake.deliver(DM, [fake.reaction(DM, ALICE, prompt.eventId, approve)]);
    await e2e.until(() => e2e.approvals.decisions.length === 1, "decision");
    assert.deepEqual(e2e.approvals.decisions, [{ requestId: "req-1", nonce: "nonce-1", decision: "approve", person: humanId, surface: 2 }]);
    await fake.deliver(DM, [fake.reaction(DM, ALICE, prompt.eventId, emojis[1]!)]); // replay: single use
    await flush(10);
    assert.equal(e2e.approvals.decisions.length, 1);
  } finally { await close(); }
});

test("channel.test --send-owner delivers the fixed test text to the person's existing direct room, not to a room named like the mxid", async () => {
  const { e2e, fake, close } = await matrix();
  try {
    const { humanId } = e2e.link("matrix", BOT, ALICE);
    const out = await e2e.call("channel.test", { id: "matrix", sendOwner: true }, humanId);
    assert.equal(out.sent, true);
    const sent = fake.sent.at(-1)!;
    assert.equal(sent.roomId, DM);
    assert.equal(sent.content.body, TEST_MESSAGE);
    assert.equal(fake.created.length, 0, "no room was created");
  } finally { await close(); }
});

test("channel.test --send-owner without a direct room creates a private one, invites the person and sends there", async () => {
  const { e2e, fake, close } = await matrix({ direct: false });
  try {
    const { humanId } = e2e.link("matrix", BOT, ALICE);
    const out = await e2e.call("channel.test", { id: "matrix", sendOwner: true }, humanId);
    assert.equal(out.sent, true);
    assert.equal(fake.created.length, 1);
    assert.deepEqual(fake.created[0]!.body.invite, [ALICE]);
    assert.equal(fake.created[0]!.body.is_direct, true);
    const sent = fake.sent.at(-1)!;
    assert.equal(sent.roomId, fake.created[0]!.roomId);
    assert.notEqual(sent.roomId, ALICE);
    assert.equal(sent.content.body, TEST_MESSAGE);
    await e2e.call("channel.test", { id: "matrix", sendOwner: true }, humanId);
    assert.equal(fake.created.length, 1, "the room is reused");
  } finally { await close(); }
});

test("channel.test --send-owner refuses a linked person who may not DM the bot", async () => {
  const { e2e, fake, close } = await matrix({ dmAllowlist: [ALICE] });
  try {
    const { humanId } = e2e.link("matrix", BOT, CAROL, "Carol");
    await assert.rejects(e2e.call("channel.test", { id: "matrix", sendOwner: true }, humanId));
    assert.equal(fake.created.length, 0);
    assert.equal(fake.sent.length, 0);
  } finally { await close(); }
});

test("/link <code> in a DM creates a pending claim in the identity service", async () => {
  const { e2e, fake, close } = await matrix();
  try {
    const human = e2e.identity.createHuman({ displayName: "Pat" }, OWNER);
    const self = { user: human.id, host: "test", kind: "person", role: "member" } as const;
    const p = e2e.identity.startPairing({ humanId: human.id, channel: "matrix" }, self);
    await say(fake, DM, ALICE, `/link ${p.code}`);
    await e2e.until(() => bodies(fake, DM).length > 0, "link answered");
    const pairings = (e2e.identity.list({}) as { pairings: { state: string; channel: string }[] }).pairings;
    assert.equal(pairings.filter((x) => x.channel === "matrix" && x.state === "claimed").length, 1);
    assert.equal(e2e.provider.requests.length, 0, "a command is not a turn");
  } finally { await close(); }
});

test("an image a tool produced in the turn follows the text reply as an image event", async () => {
  const { OutputStore } = await import("../../../media/src/store.ts");
  const root = tempDir("matrix-media-");
  const id = "0b3c9a52-6d1e-4f7a-9c1e-3a5d7f9b1c2d";
  const bytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, "0.png"), bytes);
  const manifest = { schema: "media.output/1", id, createdAt: 0, prompt: "p", parameters: {}, referenceHashes: [], metadata: { seed: null, costUsd: null, origin: "test" }, partial: false, files: [{ path: "0.png", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, format: "png" }] };
  writeFileSync(join(root, id, "manifest.json"), JSON.stringify(manifest));
  const store = new OutputStore(root);
  // The host's own `outputs` is not wired in the rig, so the real store comes in through the adapter seam.
  const { e2e, fake, close } = await matrix({ outputs: { store, authorize: async (outputId: string) => outputId === id } });
  try {
    e2e.link("matrix", BOT, ALICE);
    e2e.provider.script = () => [
      { type: "tool.call", id: "t1", name: "image.generate", args: {} },
      { type: "tool.result", id: "t1", output: JSON.stringify({ id, files: [{ path: "0.png" }] }) },
      { type: "delta", text: "here you go" },
    ];
    await say(fake, DM, ALICE, "draw");
    await e2e.until(() => fake.sent.filter((s) => s.roomId === DM).length >= 2, "text and image sent");
    const [text, image] = fake.sent.filter((s) => s.roomId === DM);
    assert.match(String(text!.content.body), /here you go/);
    assert.equal(image!.content.msgtype, "m.image");
    assert.equal((image!.content.info as { mimetype: string }).mimetype, "image/png");
    assert.equal(fake.uploads.length, 1);
    assert.equal(fake.uploads[0]!.size, bytes.length);
  } finally { await close(); }
});
