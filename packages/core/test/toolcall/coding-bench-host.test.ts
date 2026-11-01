/** The host-eval seam uses its real dispatcher and closes the session on success, refusal and cancellation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ToolDispatcher } from "../../src/tools/dispatcher.ts";
import { hostCodingArm } from "../../src/toolcall/coding-bench-host.ts";
import type { CodingMetrics, CodingSubjectInput } from "../../src/toolcall/coding-bench-subject.ts";

const metrics = (): CodingMetrics => ({
  rounds: 1,
  toolCalls: 0,
  toolErrors: 0,
  input: null,
  output: null,
  cacheRead: null,
  cacheCreated: null,
  totalInput: null,
  cacheShare: null,
  syntaxRefusals: null,
  offloads: null,
  steers: null,
  rewinds: null,
});
function input(signal: AbortSignal): CodingSubjectInput {
  return {
    root: "/not-executed",
    worktree: "/not-executed",
    instruction: "Repair the public source.",
    taskId: "structural-host-test",
    seed: 11,
    budgets: { tokens: 1000, rounds: 3, wallMs: 1000 },
    signal,
  };
}

test("host subjects dispatch actual calls and retain unavailable usage rather than inventing zero", async () => {
  const registry = new ToolRegistry();
  const dispatcher = new ToolDispatcher({
    registry,
    approvals: {
      async request() {
        return { approved: false };
      },
    },
    grants: { get: () => undefined, list: () => [] },
    clock: { now: Date.now },
  });
  let closed = 0;
  const arm = hostCodingArm("host", async (request) => ({
    model: async () => [{ name: "unregistered.tool", args: {} }],
    metrics,
    harness: {
      registry,
      dispatcher,
      context: { agentId: "coding-bench", principal: "host-test", surface: 3, signal: request.signal },
      async close() {
        closed++;
      },
    },
  }));
  const result = await arm.run(input(new AbortController().signal));
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(result.metrics.toolErrors, 1);
  assert.equal(result.metrics.input, null);
  assert.equal(closed, 1);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(arm.run(input(abort.signal)));
  assert.equal(closed, 2);
});
