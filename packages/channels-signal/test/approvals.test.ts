import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalBook, APPROVAL_MAX_TTL_MS } from "../src/index.ts";
import { DM, GROUP, STRANGER, push, rig } from "./helpers/setup.ts";
import { textEnvelope } from "./helpers/fake-daemon.ts";

const CHOICES = [
  { id: "once", label: "once" },
  { id: "session", label: "session" },
  { id: "always", label: "always" },
  { id: "deny", label: "deny" },
];

async function askInGroup(r: Awaited<ReturnType<typeof rig>>, ttlMs?: number) {
  const { promptId } = await r.ch.prompt({
    chatId: GROUP,
    text: "run tool?",
    choices: CHOICES,
    approverIds: [DM],
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  });
  const text = String(r.daemon.sent().at(-1)!.message);
  const token = /Reply "([2-9A-HJ-NP-Z]{4}) </.exec(text)![1]!;
  return { promptId, token };
}

test("approvals: token + code from an approver in the same chat decides once and is not delivered as a message", async () => {
  const r = await rig();
  const decisions: unknown[] = [];
  r.ch.onDecision((d) => void decisions.push(d));
  try {
    const { promptId, token } = await askInGroup(r);
    await push(r, textEnvelope({ number: DM, message: `${token} 2`, groupId: GROUP }));
    assert.equal(decisions.length, 1);
    assert.deepEqual(decisions[0], { promptId, chatId: GROUP, senderId: DM, choiceId: "session", at: decisions[0] && (decisions[0] as { at: number }).at });
    assert.equal(r.received.length, 0);
    assert.equal(r.daemon.sent().at(-1)!.message, "Recorded.");
  } finally {
    await r.close();
  }
});

test("approvals: the deny code 0 maps to the deny choice", async () => {
  const r = await rig();
  const decisions: Array<{ choiceId: string }> = [];
  r.ch.onDecision((d) => void decisions.push(d));
  try {
    const { token } = await askInGroup(r);
    await push(r, textEnvelope({ number: DM, message: `${token} 0`, groupId: GROUP }));
    assert.equal(decisions[0]!.choiceId, "deny");
  } finally {
    await r.close();
  }
});

test("approvals: replay of the same activation is refused and never decided twice", async () => {
  const r = await rig();
  const decisions: unknown[] = [];
  r.ch.onDecision((d) => void decisions.push(d));
  try {
    const { token } = await askInGroup(r);
    await push(r, textEnvelope({ number: DM, message: `${token} 1`, groupId: GROUP, ts: 1 }));
    await push(r, textEnvelope({ number: DM, message: `${token} 3`, groupId: GROUP, ts: 2 }));
    assert.equal(decisions.length, 1);
    assert.equal(r.daemon.sent().at(-1)!.message, "This approval code is not valid for you or has expired.");
  } finally {
    await r.close();
  }
});

test("approvals: a non-approver is refused and cannot consume the prompt; the approver still can", async () => {
  const r = await rig({ userAllowlist: [DM, STRANGER] });
  const decisions: Array<{ senderId: string }> = [];
  r.ch.onDecision((d) => void decisions.push(d));
  try {
    const { token } = await askInGroup(r);
    await push(r, textEnvelope({ number: STRANGER, message: `${token} 1`, groupId: GROUP, ts: 10 }));
    assert.equal(decisions.length, 0);
    assert.equal(r.daemon.sent().at(-1)!.message, "This approval code is not valid for you or has expired.");
    await push(r, textEnvelope({ number: DM, message: `${token} 1`, groupId: GROUP, ts: 11 }));
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.senderId, DM);
  } finally {
    await r.close();
  }
});

test("approvals: an expired activation is refused and never emitted", async () => {
  const r = await rig();
  const decisions: unknown[] = [];
  r.ch.onDecision((d) => void decisions.push(d));
  try {
    const { token } = await askInGroup(r, 60_000);
    r.now.t += 60_001;
    await push(r, textEnvelope({ number: DM, message: `${token} 1`, groupId: GROUP }));
    assert.equal(decisions.length, 0);
    assert.equal(r.daemon.sent().at(-1)!.message, "This approval code is not valid for you or has expired.");
  } finally {
    await r.close();
  }
});

test("approvals: a token from another chat does not work here", async () => {
  const r = await rig();
  const decisions: unknown[] = [];
  r.ch.onDecision((d) => void decisions.push(d));
  try {
    const { token } = await askInGroup(r);
    await push(r, textEnvelope({ number: DM, message: `${token} 1` })); // DM with the approver, different chat
    assert.equal(decisions.length, 0);
  } finally {
    await r.close();
  }
});

test("approvals: a wrong code digit is refused; surrounding whitespace and token case are tolerated", async () => {
  const r = await rig();
  const decisions: Array<{ choiceId: string }> = [];
  r.ch.onDecision((d) => void decisions.push(d));
  try {
    const { token } = await askInGroup(r);
    await push(r, textEnvelope({ number: DM, message: `${token} 7`, groupId: GROUP, ts: 1 }));
    assert.equal(decisions.length, 0);
    await push(r, textEnvelope({ number: DM, message: `  ${token.toLowerCase()}   3 `, groupId: GROUP, ts: 2 }));
    assert.equal(decisions[0]!.choiceId, "always");
  } finally {
    await r.close();
  }
});

test("approvals: without a live prompt, ordinary text that looks like a code is just a message", async () => {
  const r = await rig();
  try {
    await push(r, textEnvelope({ number: DM, message: "ABCD 1" }));
    assert.equal(r.received.length, 1);
  } finally {
    await r.close();
  }
});

test("approvals: repeated wrong guesses by a non-approver kill the prompt", async () => {
  const r = await rig({ userAllowlist: [DM, STRANGER] });
  const decisions: unknown[] = [];
  r.ch.onDecision((d) => void decisions.push(d));
  try {
    const { token } = await askInGroup(r);
    for (let i = 0; i < 25; i++) await push(r, textEnvelope({ number: STRANGER, message: `${token} 1`, groupId: GROUP, ts: 100 + i }));
    await push(r, textEnvelope({ number: DM, message: `${token} 1`, groupId: GROUP, ts: 999 }));
    assert.equal(decisions.length, 0);
  } finally {
    await r.close();
  }
});

test("approvals: a prompt sent to a chat outside the allowlist is refused before anything is stored", async () => {
  const r = await rig();
  try {
    await assert.rejects(
      r.ch.prompt({ chatId: STRANGER, text: "x", choices: CHOICES, approverIds: [STRANGER] }),
      /allowlist/,
    );
  } finally {
    await r.close();
  }
});

test("approvals: a prompt with no approvers or bad choices is rejected", async () => {
  const r = await rig();
  try {
    await assert.rejects(r.ch.prompt({ chatId: DM, text: "x", choices: CHOICES, approverIds: [] }), RangeError);
    await assert.rejects(r.ch.prompt({ chatId: DM, text: "x", choices: [], approverIds: [DM] }), RangeError);
    await assert.rejects(
      r.ch.prompt({ chatId: DM, text: "x", choices: CHOICES, approverIds: [DM], ttlMs: APPROVAL_MAX_TTL_MS + 1 }),
      RangeError,
    );
  } finally {
    await r.close();
  }
});

const bookCases: Array<[string, number, RegExp | null]> = [
  ["default TTL accepted", 0, null],
  ["zero TTL refused", -1, /TTL/],
  ["24 h accepted", APPROVAL_MAX_TTL_MS, null],
  ["over 24 h refused", APPROVAL_MAX_TTL_MS + 1, /TTL/],
  ["non-integer refused", 1.5, /TTL/],
];
for (const [name, ttl, err] of bookCases)
  test(`approval book TTL: ${name}`, () => {
    const book = new ApprovalBook(() => 0);
    const input = { chatId: "c", choices: [{ id: "once", label: "once" }], approverIds: ["a"], ...(ttl > 0 ? { ttlMs: ttl } : ttl < 0 ? { ttlMs: 0 } : {}) };
    if (err) assert.throws(() => book.create(input), err);
    else assert.doesNotThrow(() => book.create(input));
  });

test("approval book: tokens are random per prompt and codes map 1..n with deny as 0", () => {
  const book = new ApprovalBook(() => 0);
  const a = book.create({ chatId: "c", choices: CHOICES, approverIds: ["a"] });
  const b = book.create({ chatId: "c", choices: CHOICES, approverIds: ["a"] });
  assert.notEqual(a.token, b.token);
  assert.deepEqual(a.codes.map((c) => c.code), ["1", "2", "3", "0"]);
});
