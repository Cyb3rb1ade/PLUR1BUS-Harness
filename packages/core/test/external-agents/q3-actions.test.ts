/** D109 action binding and deterministic cancellation regressions, using the real approval service. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AcpActions, type AcpAction } from "../../src/external-agents/actions.ts";
import { rig, lastNonce, tick } from "../approvals/service-helpers.ts";

const action: AcpAction = { callId: "tool-1", capability: "shell.exec", tool: "terminal/create",
  args: { command: "/usr/bin/true", args: [], cwd: "/worktree" }, targets: ["/worktree"] };

test("allow_once binds exact ToolCall-ID and action hash and is consumed by its first match", async () => {
  const r = await rig();
  const abort = new AbortController();
  const actions = new AcpActions({ signal: abort.signal, agentId: "coder", person: "christian",
    sessionId: "session", turnId: "turn", approvals: async () => r.service });
  const answer = (decision: "approve" | "deny") => {
    const event = lastNonce(r);
    assert.equal(r.service.decide({ requestId: event.id, nonce: event.nonce, person: "christian", surface: 3, decision }).ok, true);
  };
  try {
    const pending = actions.permission(action, [{ kind: "allow_always", optionId: "always" }, { kind: "allow_once", optionId: "once" }]);
    await tick();
    answer("approve");
    assert.deepEqual(await pending, { outcome: { outcome: "selected", optionId: "once" } });
    for (const wrong of [{ ...action, callId: "tool-2" }, { ...action, args: { ...action.args, args: ["changed"] } }]) {
      await assert.rejects(actions.authorize(wrong), /not-approved/);
    }
    await actions.authorize(action);
    const repeated = assert.rejects(actions.authorize(action), /not-approved/);
    await tick();
    answer("deny");
    await repeated;
  } finally { abort.abort(); r.service.dispose(); r.stores.db.close(); }
});

test("abort while policy preparation is pending never reaches an approval or action", async () => {
  const abort = new AbortController();
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const actions = new AcpActions({ signal: abort.signal, agentId: "coder", person: "person", sessionId: "s", turnId: "t",
    approvals: async () => { await wait; return null; } });
  const pending = assert.rejects(actions.authorize(action));
  abort.abort();
  release();
  await pending;
});

test("D109 deny refuses and headless ask cancels without a person", async () => {
  const options = { signal: new AbortController().signal, agentId: "coder", person: null, sessionId: "s", turnId: "t", approvals: async () => null };
  await assert.rejects(new AcpActions(options).authorize(action), /not-approved/);
  await assert.rejects(new AcpActions({ ...options, context: { toolsDeny: ["shell.exec"] } }).authorize(action), /policy-denied/);
  await new AcpActions(options).authorize({ ...action, capability: "fs.write", tool: "fs/write_text_file" });
});

test("abort after a person's reply prevents approval consumption", async () => {
  const r = await rig();
  const abort = new AbortController();
  const actions = new AcpActions({ signal: abort.signal, agentId: "coder", person: "christian",
    sessionId: "session", turnId: "turn", approvals: async () => r.service });
  try {
    const pending = assert.rejects(actions.authorize(action));
    await tick();
    const event = lastNonce(r);
    r.service.decide({ requestId: event.id, nonce: event.nonce, person: "christian", surface: 3, decision: "approve" });
    abort.abort();
    await pending;
    assert.equal(r.service.get(event.id)?.usedAt, undefined);
  } finally { r.service.dispose(); r.stores.db.close(); }
});
