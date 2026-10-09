import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { FakeSlack, blockAction, message } from "./helpers/fake-slack.ts";
import { wire, type Wiring } from "./helpers/wire.ts";
import type { ApprovalDecision } from "../src/index.ts";

let fake: FakeSlack;
let w: Wiring;
let now = 1_000_000;
const decisions: ApprovalDecision[] = [];
beforeEach(async () => {
  fake = new FakeSlack();
  await fake.listen();
  decisions.length = 0;
  now = 1_000_000;
});
afterEach(async () => {
  await w?.ch.stop();
  await fake.close();
});

async function up(extra: Parameters<typeof wire>[1] = {}): Promise<void> {
  w = wire(fake, { now: () => now, ...extra });
  w.ch.onDecision((d) => void decisions.push(d));
  await w.ch.start(w.host);
}
const choices = [
  { id: "once", label: "Allow once" },
  { id: "deny", label: "Deny" },
];
async function prompt(over: Partial<Parameters<typeof w.ch.prompt>[0]> = {}) {
  const r = await w.ch.prompt({ chatId: "C0FAKE01", text: "Run `rm -rf /tmp/x`?", choices, approverIds: ["UAPPROVER"], ...over });
  const post = fake.callsOf("chat.postMessage").at(-1)!;
  const actions = (post.body.blocks as Array<{ type: string; elements?: Array<{ action_id: string }> }>).find((b) => b.type === "actions")!;
  return { ...r, handles: actions.elements!.map((e) => e.action_id), channel: post.body.channel as string, ts: r.refs[0]!.messageId };
}
const press = async (user: string, handle: string, ts: string, channel = "C0FAKE01", threadTs?: string) => {
  fake.push(blockAction({ user, channel, messageTs: ts, actionId: handle, ...(threadTs !== undefined ? { threadTs } : {}) }));
  await w.ch.idle();
};
const ephemerals = () => fake.callsOf("chat.postEphemeral");

test("prompt posts section + action buttons; handles are opaque; approverIds are not shown", async () => {
  await up();
  const p = await prompt();
  assert.match(p.promptId, /^[A-Za-z0-9_-]+$/);
  assert.equal(p.handles.length, 2);
  const body = JSON.stringify(fake.callsOf("chat.postMessage").at(-1)!.body);
  assert.doesNotMatch(body, /UAPPROVER/);
  assert.doesNotMatch(body, /"action_id":"(once|deny)"/, "choice ids are not on the wire");
  assert.equal(p.refs[0]!.kind, "message");
});

test("the approver's press emits exactly one decision and replaces the buttons with the outcome", async () => {
  await up();
  const p = await prompt();
  await press("UAPPROVER", p.handles[0]!, p.ts);
  assert.equal(decisions.length, 1);
  assert.deepEqual({ ...decisions[0]!, at: 0 }, { promptId: p.promptId, chatId: "C0FAKE01", senderId: "UAPPROVER", choiceId: "once", at: 0 });
  const upd = fake.callsOf("chat.update").at(-1)!;
  assert.equal(upd.body.ts, p.ts);
  assert.equal("blocks" in upd.body, false, "buttons removed");
  assert.match(String(upd.body.text), /Decision:.*Allow once.*UAPPROVER/);
});

test("a non-approver gets an ephemeral refusal, no decision, and the handle stays usable", async () => {
  await up();
  const p = await prompt();
  await press("UEVIL001", p.handles[1]!, p.ts);
  assert.equal(decisions.length, 0);
  assert.equal(ephemerals().length, 1);
  assert.equal(fake.callsOf("chat.update").length, 0);
  await press("UAPPROVER", p.handles[1]!, p.ts);
  assert.equal(decisions.length, 1, "the rightful approver can still decide");
  assert.equal(decisions[0]!.choiceId, "deny");
});

test("replay: the same handle activates once; the second press is refused politely", async () => {
  await up();
  const p = await prompt();
  await press("UAPPROVER", p.handles[0]!, p.ts);
  await press("UAPPROVER", p.handles[0]!, p.ts);
  assert.equal(decisions.length, 1);
  assert.equal(ephemerals().length, 1);
});

test("forged and malformed handles are refused and never emitted", async () => {
  await up();
  const p = await prompt();
  const forged = p.handles[0]!.replace(/\.[^.]+$/, ".AAAAAAAAAAAAAAAAAAAAAA");
  for (const h of [forged, "not-a-handle", p.handles[0]!.slice(0, 10)]) await press("UAPPROVER", h, p.ts);
  assert.equal(decisions.length, 0);
  assert.equal(ephemerals().length, 3);
});

test("expired prompts are refused; nothing is emitted after the TTL", async () => {
  await up();
  const p = await prompt({ ttlMs: 60_000 });
  now += 60_001;
  await press("UAPPROVER", p.handles[0]!, p.ts);
  assert.equal(decisions.length, 0);
});

test("handles are chat-bound: a press from another conversation is refused", async () => {
  await up({ allowlist: ["C0FAKE01", "G0GROUP1"] });
  const p = await prompt();
  await press("UAPPROVER", p.handles[0]!, p.ts, "G0GROUP1");
  assert.equal(decisions.length, 0);
});

test("threaded prompts are bound to the thread key and decided from that thread", async () => {
  await up();
  const r = await w.ch.prompt({ chatId: "C0FAKE01", text: "ok?", choices, approverIds: ["UAPPROVER"], threadId: "1700000050.000100" });
  const post = fake.callsOf("chat.postMessage").at(-1)!;
  assert.equal(post.body.thread_ts, "1700000050.000100");
  const handle = ((post.body.blocks as Array<{ type: string; elements?: Array<{ action_id: string }> }>).find((b) => b.type === "actions")!).elements![0]!.action_id;
  await press("UAPPROVER", handle, r.refs[0]!.messageId, "C0FAKE01", "1700000050.000100");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.chatId, "C0FAKE01:1700000050.000100");
});

test("a decision handler that throws does not block settling the message", async () => {
  await up();
  w.ch.onDecision(() => {
    throw new Error("decision boom");
  });
  const p = await prompt();
  await press("UAPPROVER", p.handles[0]!, p.ts);
  assert.equal(fake.callsOf("chat.update").length, 1);
});

test("prompt validation: approvers required, 1..5 valid choices, bounded TTL", async () => {
  await up();
  await assert.rejects(w.ch.prompt({ chatId: "C0FAKE01", text: "x", choices, approverIds: [] }), /approver/);
  await assert.rejects(w.ch.prompt({ chatId: "C0FAKE01", text: "x", choices: [], approverIds: ["UAPPROVER"] }), RangeError);
  await assert.rejects(w.ch.prompt({ chatId: "C0FAKE01", text: "x", choices: [{ id: "Bad Id", label: "x" }], approverIds: ["UAPPROVER"] }), RangeError);
  await assert.rejects(w.ch.prompt({ chatId: "C0FAKE01", text: "x", choices, approverIds: ["UAPPROVER"], ttlMs: 86_400_001 }), RangeError);
  await assert.rejects(w.ch.prompt({ chatId: "C0FAKE01", text: "x", choices, approverIds: ["UAPPROVER"], ttlMs: 0 }), RangeError);
  assert.equal(fake.callsOf("chat.postMessage").length, 0);
});

test("a prompt whose post fails leaves no live handle behind", async () => {
  await up();
  fake.failNext("chat.postMessage", 400, { ok: false, error: "invalid_blocks" });
  await assert.rejects(prompt());
  assert.equal(fake.callsOf("chat.postMessage").length, 1);
});

// Policy before activation (coordinator finding): refused presses must not consume the handle.
test("unlisted DM sender pressing a button is dropped before activation; the approver can still decide", async () => {
  await up();
  const p = await prompt({ chatId: "C0FAKE01" });
  fake.push(blockAction({ user: "UAPPROVER", channel: "D0STRANGE", messageTs: p.ts, actionId: p.handles[0]! }));
  await w.ch.idle();
  assert.equal(decisions.length, 0);
  assert.equal(ephemerals().length, 0, "dropped without a reply");
  await press("UAPPROVER", p.handles[0]!, p.ts);
  assert.equal(decisions.length, 1, "the handle was not consumed by the refused press");
});

test("unallowed channel press is dropped without activation", async () => {
  await up();
  const p = await prompt();
  await press("UAPPROVER", p.handles[0]!, p.ts, "C0OTHER01");
  assert.equal(decisions.length, 0);
  await press("UAPPROVER", p.handles[0]!, p.ts);
  assert.equal(decisions.length, 1);
});

test("userAllowlist: a user outside it gets the forbidden reply and the handle survives", async () => {
  await up({ userAllowlist: ["UAPPROVER"] });
  const p = await prompt();
  await press("UOUTSIDER", p.handles[0]!, p.ts);
  assert.equal(decisions.length, 0);
  assert.equal(ephemerals().length, 1);
  await press("UAPPROVER", p.handles[0]!, p.ts);
  assert.equal(decisions.length, 1);
});

test("allowed approver still activates once, even with policy checks on", async () => {
  await up({ userAllowlist: ["UAPPROVER"] });
  const p = await prompt();
  await press("UAPPROVER", p.handles[1]!, p.ts);
  await press("UAPPROVER", p.handles[1]!, p.ts);
  assert.equal(decisions.length, 1);
});

test("generic buttons activate as rich callbacks with sender restriction", async () => {
  await up();
  const seen: Array<{ data: string; callback?: unknown }> = [];
  w.ch.onMessage((m) => {
    if (m.callback) seen.push({ data: m.text, callback: m.callback });
  });
  await w.ch.sendTurn({ chatId: "C0FAKE01", text: "Continue?", buttons: [[{ text: "Go", data: "go", senderId: "UAPPROVER" }]] });
  const ts = fake.callsOf("chat.postMessage").at(-1)!.body;
  void ts;
  const handle = ((fake.callsOf("chat.postMessage").at(-1)!.body.blocks as Array<{ type: string; elements?: Array<{ action_id: string }> }>).find((b) => b.type === "actions")!).elements![0]!.action_id;
  const msgTs = "1700000777.000001";
  await press("UOTHER", handle, msgTs);
  assert.equal(seen.length, 0);
  await press("UAPPROVER", handle, msgTs);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.data, "go");
});

void message;
