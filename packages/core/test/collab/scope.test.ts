import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CollabError } from "../../src/collab/errors.ts";
import { currentAgentScope, requireAgentScope, runWithAgentScope, scopeFor } from "../../src/collab/scope.ts";
import { isCode, open, owner, projectWithAgents } from "./helpers.ts";

describe("AgentScope", () => {
  it("fail-closes when no scope is established", () => {
    assert.equal(currentAgentScope(), undefined);
    assert.throws(() => requireAgentScope(), isCode("no-scope"));
  });

  it("runWithAgentScope is isolated per async context", async () => {
    const a = scopeFor("lead", "p1");
    const b = scopeFor("worker", "p1");
    const seen: string[] = [];
    await Promise.all([
      runWithAgentScope(a, async () => { await Promise.resolve(); seen.push(currentAgentScope()!.agentId); }),
      runWithAgentScope(b, async () => { await Promise.resolve(); seen.push(currentAgentScope()!.agentId); }),
    ]);
    assert.deepEqual(seen.sort(), ["lead", "worker"]);
    assert.equal(currentAgentScope(), undefined);
  });

  it("consult refuses when the scope port never installs a current scope", async () => {
    const h = open({
      scope: {
        run: async (_s, fn) => fn(),
        current: () => undefined,
      },
    });
    const p = await projectWithAgents(h);
    await assert.rejects(
      h.collab.consult({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker", question: "q", context: "" }),
      (e: unknown) => e instanceof CollabError && e.code === "no-scope",
    );
  });
});
