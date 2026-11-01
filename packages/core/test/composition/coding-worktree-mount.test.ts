import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { alsAgentScopePort, scopeFor } from "../../src/collab/scope.ts";
import type { AgentRunInput } from "../../src/collab/runner.ts";
import { composedAgentRunner } from "../../src/composition/collaboration.ts";
import { tempDir } from "../helpers/temp-dir.ts";

test("a local read-only review never asks the worktree port for a writable grant", async () => {
  const home = tempDir("coding-review-mount-"), worktree = join(home, "review");
  mkdirSync(worktree);
  const handoff: NonNullable<AgentRunInput["handoff"]> = {
    contract: { schema: "plur1bus.handoff/1", id: "ho_review", kind: "consult", from: { agent: "author", session: "session" }, to: { agent: "reviewer" },
      task: { id: "task", project: "project", card: "card" }, objective: "Review only", doneWhen: ["reviewed"],
      constraints: { must: [], mustNot: ["write"], scope: { paths: ["**"], tools: ["file.read"] } },
      authority: { mayDecide: [], mustAsk: [], approvalsHeld: [] }, budget: { tokens: 2000, toolCalls: 5, deadline: "2099-01-01T00:00:00Z", modelTier: "standard" },
      returnContract: { format: "plur1bus.return/1", maxTokens: 2000, outputSchema: { type: "string" }, citationsRequired: false } },
    context: { person: "owner", taskId: "task", sessionId: "session", fromAgent: "author", projectId: "project", readOnlyWorktree: worktree,
      approvals: { get() { return undefined; } } as never, grants: { get() { return undefined; } } as never, now: Date.now, audit() {} },
  };
  let requests = 0;
  const scope = alsAgentScopePort();
  const runner = composedAgentRunner({ id: "fixture", async *stream(req) {
    requests++;
    assert.equal(req.readOnlyWorktree, worktree);
    assert.equal(req.codingWorktreeMount, undefined);
    assert.deepEqual(req.toolView, ["file.read", "file.list", "file.stat"]);
    yield { type: "delta", text: "Reviewed" };
  } }, scope, home, [], undefined, { root: () => worktree, mount() { assert.fail("read-only review must not acquire a writable grant"); } });
  await scope.run(scopeFor("reviewer", "project"), () => runner.run({ agentId: "reviewer", principal: { kind: "person", userId: "owner", role: "owner" },
    question: "Review", context: "", handoff, signal: new AbortController().signal }));
  assert.equal(requests, 1);
});
