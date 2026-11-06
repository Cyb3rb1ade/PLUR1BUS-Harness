/** Exercise the B1 task grant through its real provider/dispatcher, including a live assignment removal. */
import assert from "node:assert/strict";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { StreamingAdapter } from "../../../providers/src/index.ts";
import { createCollab } from "../../src/collab/service.ts";
import { provisionCodingCard } from "../../src/toolcall/coding-bench-provisioner.ts";
import { singleCodingArm } from "../../src/toolcall/coding-bench-subject.ts";
import { limitsHelper } from "../external-agents/fixture.ts";
import { realTempDir } from "../helpers/real-temp-dir.ts";

test("B1 executes in its assigned project and refuses the next call after the card assignment is removed", async () => {
  const home = await realTempDir("b1-assigned-card-");
  const signal = AbortSignal.timeout(60_000);
  const seed = new Map([["README.md", { text: "Public starting point.\n", mode: 0o600 }]]);
  try {
    if (process.platform === "win32") {
      await assert.rejects(provisionCodingCard(home, seed, signal), /unavailable/u);
      return;
    }
    const workspace = await provisionCodingCard(home, seed, signal);
    try {
      const { binding, worktree } = workspace;
      const markers = [join(worktree, "allowed"), join(worktree, "revoked")];
      let index = 0;
      const adapter: StreamingAdapter = {
        async *stream() {
          if (index === 1) {
            const board = createCollab({ home: workspace.home, path: join(workspace.home, "state", "collab.sqlite") });
            try {
              board.boardStore.assign(binding.projectId, binding.cardId, { kind: "agent", id: binding.agentId },
                false, { kind: "person", id: binding.principal });
            } finally { board.close(); }
          }
          const marker = markers[index++];
          const args = marker && { program: "/usr/bin/touch", args: [marker], cwd: worktree };
          yield { type: "done", result: {
            text: marker ? "" : "Finished.",
            toolCalls: args ? [{ id: String(index), name: "exec.run", argumentsRaw: JSON.stringify(args), arguments: args }] : [],
            finishReason: marker ? "tool_calls" : "stop", rawFinishReason: "stop", meta: {},
            usage: { inputTokens: 100, outputTokens: 10 },
          } };
        },
      };
      const arm = singleCodingArm({
        home: workspace.home, binding, limitsHelper, programs: ["/usr/bin/touch"], adapter, secrets: () => [],
        model: { provider: "fixture", model: "gpt-4.1", baseUrl: "http://127.0.0.1:1", wireFormat: "chat_completions", local: true },
      });
      const result = await arm.run({
        root: worktree, worktree, taskId: "easy-ts-tags", seed: 11, signal,
        instruction: "Exercise the assigned card.", budgets: { tokens: 10_000, rounds: 5, wallMs: 30_000 },
      });
      assert.equal(result.outcome, "completed");
      assert.equal(result.metrics.toolCalls, 2);
      assert.equal(result.metrics.toolErrors, 1);
      await access(markers[0]!);
      await assert.rejects(access(markers[1]!), { code: "ENOENT" });
    } finally { await workspace.close(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});
