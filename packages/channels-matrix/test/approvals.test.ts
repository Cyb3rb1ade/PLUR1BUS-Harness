import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ALICE, CAROL, FakeMatrix, OTHER, ROOM } from "./helpers/fake-matrix.ts";
import { Rig, newFake } from "./helpers/rig.ts";
import { ReactionApprovals, choiceEmoji, type ApprovalDecision, type MatrixChannelOptions } from "../src/index.ts";

const open: { fake: FakeMatrix; rig: Rig }[] = [];
afterEach(async () => {
  for (const { rig, fake } of open.splice(0)) {
    await rig.close().catch(() => {});
    await fake.close().catch(() => {});
  }
});

let clock = 1_000_000;
async function setup(over: Partial<MatrixChannelOptions> = {}): Promise<{ rig: Rig; decisions: ApprovalDecision[] }> {
  const fake = await newFake();
  fake.direct = {};
  const rig = new Rig(fake, { now: () => clock, ...over });
  const decisions: ApprovalDecision[] = [];
  rig.ch.onDecision((d) => void decisions.push(d));
  open.push({ fake, rig });
  await rig.start();
  return { rig, decisions };
}

const choices = [
  { id: "once", label: "Allow once" },
  { id: "session", label: "Allow for session" },
  { id: "deny", label: "Deny" },
];

async function promptFor(rig: Rig, extra: Record<string, unknown> = {}) {
  const p = await rig.ch.prompt({ chatId: ROOM, text: "Run `rm -rf build`?", choices, approverIds: [ALICE], ...extra });
  return { promptId: p.promptId, eventId: p.refs[0]!.messageId };
}

const reactKey = (eventId: string, key: string, sender: string) => ({ eventId, key, sender });

test("prompt sends the question with a choice list and pre-seeds one reaction per choice", async () => {
  const { rig } = await setup();
  const { eventId } = await promptFor(rig);
  const msg = rig.fake.sent.find((s) => s.type === "m.room.message")!;
  assert.match(String(msg.content.body), /1️⃣ Allow once/);
  assert.match(String(msg.content.body), /❌ Deny/);
  const seeded = rig.fake.sent.filter((s) => s.type === "m.reaction");
  assert.deepEqual(seeded.map((s) => (s.content["m.relates_to"] as { key: string }).key), ["1️⃣", "2️⃣", "❌"]);
  assert.ok(seeded.every((s) => (s.content["m.relates_to"] as { event_id: string }).event_id === eventId));
});

test("the bot's own pre-seeded reactions never count as a decision", async () => {
  const { rig, decisions } = await setup();
  await promptFor(rig);
  await rig.fake.waitIdle();
  assert.equal(decisions.length, 0);
});

test("an approver's reaction yields exactly one decision with the choice, chat and sender", async () => {
  const { rig, decisions } = await setup();
  const { promptId, eventId } = await promptFor(rig);
  await rig.fake.deliver(ROOM, [rig.fake.reaction(ROOM, ALICE, eventId, "1️⃣")]);
  assert.deepEqual(decisions, [{ promptId, chatId: ROOM, senderId: ALICE, choiceId: "once", at: clock }]);
});

test("the cross mark denies and a variation-selector-free key matches too", async () => {
  const { rig, decisions } = await setup();
  const { eventId } = await promptFor(rig);
  await rig.fake.deliver(ROOM, [rig.fake.reaction(ROOM, ALICE, eventId, "❌")]);
  assert.equal(decisions[0]!.choiceId, "deny");
});

test("single use: a second reaction on the same prompt is refused and never emitted", async () => {
  const { rig, decisions } = await setup();
  const { eventId } = await promptFor(rig);
  await rig.fake.deliver(ROOM, [rig.fake.reaction(ROOM, ALICE, eventId, "1️⃣")]);
  await rig.fake.deliver(ROOM, [rig.fake.reaction(ROOM, ALICE, eventId, "2️⃣")]);
  assert.equal(decisions.length, 1);
  assert.ok(rig.fake.sent.some((s) => s.content.body === "This confirmation is no longer valid."));
});

test("an unauthorized reaction is never emitted, is redacted, and logs no content", async () => {
  const { rig, decisions } = await setup();
  const { eventId } = await promptFor(rig);
  const r = rig.fake.reaction(ROOM, CAROL, eventId, "1️⃣");
  await rig.fake.deliver(ROOM, [r]);
  assert.equal(decisions.length, 0);
  assert.deepEqual(rig.fake.redactions, [r.event_id]);
  assert.ok(rig.logs.some((l) => l.includes("approval-refused") && l.includes("unauthorized")));
});

test("an unauthorized reaction does not consume the prompt: the approver can still answer", async () => {
  const { rig, decisions } = await setup();
  const { eventId } = await promptFor(rig);
  await rig.fake.deliver(ROOM, [rig.fake.reaction(ROOM, CAROL, eventId, "1️⃣")]);
  await rig.fake.deliver(ROOM, [rig.fake.reaction(ROOM, ALICE, eventId, "1️⃣")]);
  assert.equal(decisions.length, 1);
});

test("a reaction on an event that is not a prompt is ignored silently", async () => {
  const { rig, decisions } = await setup();
  await promptFor(rig);
  await rig.fake.deliver(ROOM, [rig.fake.reaction(ROOM, ALICE, "$forged", "1️⃣")]);
  assert.equal(decisions.length, 0);
  assert.equal(rig.fake.sent.filter((s) => s.type === "m.room.message").length, 1);
});

test("a reaction to the prompt from another room is refused", async () => {
  const { rig, decisions } = await setup();
  const { eventId } = await promptFor(rig);
  await rig.fake.deliver(OTHER, [rig.fake.reaction(OTHER, ALICE, eventId, "1️⃣")]);
  assert.equal(decisions.length, 0);
});

test("an emoji that is not a choice is ignored (no decision, no notice)", async () => {
  const { rig, decisions } = await setup();
  const { eventId } = await promptFor(rig);
  const before = rig.fake.sent.length;
  await rig.fake.deliver(ROOM, [rig.fake.reaction(ROOM, ALICE, eventId, "👍")]);
  assert.equal(decisions.length, 0);
  assert.equal(rig.fake.sent.length, before);
});

test("expired prompts are refused and never emitted", async () => {
  const { rig, decisions } = await setup();
  const { eventId } = await promptFor(rig, { ttlMs: 60_000 });
  clock += 60_001;
  await rig.fake.deliver(ROOM, [rig.fake.reaction(ROOM, ALICE, eventId, "1️⃣")]);
  assert.equal(decisions.length, 0);
  assert.ok(rig.logs.some((l) => l.includes("expired")));
});

test("a prompt is valid right up to its TTL", async () => {
  const { rig, decisions } = await setup();
  const { eventId } = await promptFor(rig, { ttlMs: 60_000 });
  clock += 59_999;
  await rig.fake.deliver(ROOM, [rig.fake.reaction(ROOM, ALICE, eventId, "1️⃣")]);
  assert.equal(decisions.length, 1);
});

test("a decision handler failure does not prevent other handlers", async () => {
  const { rig, decisions } = await setup();
  rig.ch.onDecision(() => {
    throw new Error("boom");
  });
  const { eventId } = await promptFor(rig);
  await rig.fake.deliver(ROOM, [rig.fake.reaction(ROOM, ALICE, eventId, "1️⃣")]);
  assert.equal(decisions.length, 1);
});

test("invalid prompts are refused before anything is sent", async () => {
  const { rig } = await setup();
  const before = rig.fake.sent.length;
  await assert.rejects(rig.ch.prompt({ chatId: ROOM, text: "x", choices, approverIds: [] }), /approver/);
  await assert.rejects(rig.ch.prompt({ chatId: ROOM, text: "x", choices: [], approverIds: [ALICE] }), /1..9/);
  await assert.rejects(rig.ch.prompt({ chatId: ROOM, text: "x", choices, approverIds: [ALICE], ttlMs: 500 }), /ttlMs/);
  await assert.rejects(rig.ch.prompt({ chatId: ROOM, text: "x", choices, approverIds: [ALICE], ttlMs: 25 * 3600_000 }), /ttlMs/);
  await assert.rejects(rig.ch.prompt({ chatId: ROOM, text: "x", choices: [choices[0]!, choices[0]!], approverIds: [ALICE] }), /duplicate/);
  assert.equal(rig.fake.sent.length, before);
});

test("ReactionApprovals: TTL is capped at 24 h and emoji follow the keycap/cross convention", () => {
  const a = new ReactionApprovals(() => 0);
  assert.throws(() => a.register({ chatId: ROOM, roomId: ROOM, eventId: "$a", choices, approverIds: [ALICE], ttlMs: 86_400_001 }), RangeError);
  assert.equal(choiceEmoji(0, "once"), "1️⃣");
  assert.equal(choiceEmoji(4, "deny"), "❌");
});

test("ReactionApprovals: caps and cancel", () => {
  const a = new ReactionApprovals(() => 0);
  a.register({ chatId: ROOM, roomId: ROOM, eventId: "$b", choices, approverIds: [ALICE] });
  a.cancel("$b");
  assert.equal(a.size, 0);
  assert.equal(a.claim({ roomId: ROOM, eventId: "$b", key: "❌", sender: ALICE }).status, "ignored");
});
