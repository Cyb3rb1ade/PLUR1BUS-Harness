/** N2/1: a loaded skill is in the model's context exactly once, the context view counts it, and compaction keeps the C4 rule. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Compactor, defaultCompaction } from "../../src/session/compaction.ts";
import { defaultPrune, ToolPruner } from "../../src/session/pruning.ts";
import { SessionStore } from "../../src/session/store.ts";
import { TurnRunner } from "../../src/session/turn-loop.ts";
import type { TurnMemory } from "../../src/session/memory-port.ts";
import { LiveCapabilityIndex } from "../../src/toolcall/live-index.ts";
import { restoreSessionSkills } from "../../src/composition/session-skills.ts";
import { skillHistoryMessages } from "../../src/composition/skill-history.ts";
import { scriptedAdapter, TURN_PRINCIPAL, turnFixture, turnRequest, useTempDirs } from "./helpers.ts";

const dirs = useTempDirs("n2-skill-session-");
const MARKER = "SKILL-BODY-MARKER";
// About 2 KiB (roughly 500 tokens): above a small window's per-message cap, far below a normal window.
const BODY = `Report workflow.\n${"Keep every section short and sourced. ".repeat(50)}${MARKER}`;
const CALLER = { channel: "cli" as const, accountId: "account", userId: "user" };
const memory: TurnMemory = {
  async recall() { return { text: "", degraded: null }; }, async capture() {}, async checkpoint() {},
};

function rig(window: number) {
  const home = dirs.make();
  mkdirSync(join(home, "state"));
  mkdirSync(join(home, "skills", "reports"), { recursive: true });
  writeFileSync(join(home, "skills", "reports", "SKILL.md"), `---\nname: reports\ndescription: Create reports\n---\n${BODY}`);
  writeFileSync(join(home, "skills", "index.json"), JSON.stringify({ version: 1, skills: [{ id: "reports", enabled: true }] }));
  const live = new LiveCapabilityIndex(home);
  const store = new SessionStore({ path: ":memory:" });
  const compactor = new Compactor(store, defaultCompaction(window), { pruner: new ToolPruner(store, defaultPrune()) });
  const wire = scriptedAdapter([{ text: "Done." }]);
  const f = turnFixture(wire.adapter, {
    capabilities: live, skillsForAgent: () => ({ pinned: ["reports"] }), principal: () => TURN_PRINCIPAL,
    restoreSkills: request => restoreSessionSkills(store, request),
  }, home);
  const runner = new TurnRunner({ store, compactor, memory, provider: () => f.provider });
  const session = store.createSession({ kind: "direct", agentId: "a1", owner: TURN_PRINCIPAL });
  dirs.onCleanup(() => { store.close(); live.close(); f.close(); });
  const occurrences = (value: unknown) => (JSON.stringify(value).match(new RegExp(MARKER, "g")) ?? []).length;
  /** One real turn; resolves with the wire request of its last model call and the context view the next turn would start from. */
  async function turn(text: string) {
    const handle = runner.submit({ session, caller: CALLER, text });
    const outcome = await handle.done;
    assert.equal(outcome.state, "completed", outcome.error);
    await runner.idle();
    const request = wire.requests.at(-1)!;
    const view = compactor.view(session.id);
    return { request, view, viewCopies: occurrences(view.messages.map(m => m.text)), copies: occurrences(request.messages) };
  }
  return { turn, store, compactor, session, wire, occurrences };
}

for (const window of [8192, 2000]) {
  it(`a skill loaded in turn 1 reaches the model once in every later request and the view counts it (window ${window})`, async () => {
    const r = rig(window);
    const first = await r.turn("Create a report");
    assert.equal(first.copies, 1, "the preload of the current turn");
    for (const text of ["Continue the report", "Add a summary"]) {
      const next = await r.turn(text);
      assert.equal(next.copies, 1, `request for "${text}" carries the body once`);
      assert.equal(next.viewCopies, 1, "the context view holds the copy the model gets");
      assert.ok(next.view.tokens >= r.compactor.count(r.session.id, BODY),
        "the counted view tokens cover the whole skill body");
    }
    // One real load, never a second one for the continuation turns.
    const loads = r.store.toolEvents(r.session.id).filter(e => e.type === "tool.call" && e.data.name === "skill.load");
    assert.equal(loads.length, 1);
  });
}

it("sends the loaded skill as a call and result pair, not as user text", async () => {
  const r = rig(8192);
  await r.turn("Create a report");
  const { request } = await r.turn("Continue the report");
  const holders = request.messages.filter(m => JSON.stringify(m).includes(MARKER));
  assert.equal(holders.length, 1);
  assert.equal(holders[0]!.role, "tool");
  const index = request.messages.indexOf(holders[0]!);
  const call = request.messages[index - 1]!;
  assert.equal(call.role, "assistant");
  assert.equal(call.toolCalls?.[0]?.name, "skill_load");
  assert.equal(call.toolCalls?.[0]?.id, holders[0]!.toolCallId);
});

it("keeps the C4 rule after a compaction: a compacted skill pair is not resurrected from history", async () => {
  const r = rig(1000);
  const first = await r.turn("Create a report");
  assert.equal(first.copies, 1);
  // Every message is capped at 10 % of the window in the view, so it takes several turns to outgrow the hard limit.
  let last = first;
  for (let i = 0; i < 12 && r.store.listSummaries(r.session.id, "applied").length === 0; i++) {
    last = await r.turn(`Turn ${i}: ${"background detail ".repeat(40)}`);
  }
  const summaries = r.store.listSummaries(r.session.id, "applied");
  assert.ok(summaries.length > 0, "the window was small enough to swap a summary in");
  const loaded = r.store.toolEvents(r.session.id).find(e => e.type === "tool.call" && e.data.name === "skill.load")!;
  const firstMessage = r.store.listMessages(r.session.id)[0]!;
  assert.ok(firstMessage.seq <= Math.max(...summaries.map(s => s.toSeq)), "the turn that loaded the skill is summarised");
  assert.ok(last.request.messages.every(m => !JSON.stringify(m).includes(`"${loaded.data.id as string}"`)),
    "the covered load call is not replayed");
  assert.equal(last.copies, 0, "no body from the covered turn comes back");
  assert.equal(last.viewCopies, 0);
});

it("emits a whole carried pair once, and leaves a clipped carrier as the view's own text", () => {
  const load = { id: "load", turnId: "one", name: "reports", text: `{"isError":false,"value":{"text":"${MARKER}"}}` };
  const base = turnRequest({ messages: [
    { role: "user", text: "Create a report", turnId: "one" },
    { role: "tool", text: JSON.stringify({ call: { id: "load" }, result: { output: load.text } }), turnId: "one",
      toolCall: { id: "load", name: "skill.load", whole: true } },
    { role: "assistant", text: "Done", turnId: "one" },
    { role: "user", text: "Continue", turnId: "two" },
  ] });
  const whole = skillHistoryMessages(base, [load]);
  assert.deepEqual(whole.map(m => m.role), ["user", "assistant", "tool", "assistant", "user"]);
  assert.equal(JSON.stringify(whole).split(MARKER).length - 1, 1);
  assert.equal(whole[2]!.content, load.text);
  const clipped = { ...base, messages: base.messages.map(m => m.toolCall ? { ...m, text: "[clipped]", toolCall: { ...m.toolCall, whole: false } } : m) };
  const kept = skillHistoryMessages(clipped, [load]);
  assert.deepEqual(kept.map(m => m.role), ["user", "user", "assistant", "user"]);
  assert.equal(JSON.stringify(kept).includes(MARKER), false, "nothing is added next to a clipped carrier");
});

it("keeps a loaded skill pair whole in the view and out of the pruner's reach", async () => {
  const store = new SessionStore({ path: ":memory:" });
  dirs.onCleanup(() => store.close());
  const session = store.createSession({ kind: "direct", agentId: "a1", owner: TURN_PRINCIPAL });
  const output = JSON.stringify({ isError: false, value: { name: "reports", text: `${"x".repeat(3000)}${MARKER}`, files: ["SKILL.md"] } });
  const first = store.beginTurn(session.id, "Create a report", 4).turn;
  store.appendEvent(first.id, "tool.call", { id: "load", name: "skill.load", args: { name: "reports" } });
  store.appendEvent(first.id, "tool.result", { id: "load", output });
  store.appendEvent(first.id, "tool.call", { id: "read", name: "file.read", args: { path: "a.txt" } });
  store.appendEvent(first.id, "tool.result", { id: "read", output: "data ".repeat(400) });
  store.completeTurn(first.id, { text: "Done", tokens: 2 });
  for (let i = 0; i < 4; i++) store.completeTurn(store.beginTurn(session.id, `Later ${i}`, 2).turn.id, { text: "ok", tokens: 1 });
  const pruner = new ToolPruner(store, { ...defaultPrune(), keepLastTurns: 1 });
  assert.equal(await pruner.run(session.id), 1, "only the file read is hidden");
  const view = new Compactor(store, defaultCompaction(1000), { pruner }).view(session.id);
  const skill = view.messages.find(m => m.toolCall?.name === "skill.load")!;
  assert.deepEqual(skill.toolCall, { id: "load", name: "skill.load", whole: true });
  assert.ok(skill.text.includes(MARKER), "the 100 token cap of this window does not cut the skill");
  const read = view.messages.find(m => m.toolCall?.name === "file.read")!;
  assert.equal(read.toolCall?.whole, false);
  assert.match(read.text, /tool output hidden/);
});
