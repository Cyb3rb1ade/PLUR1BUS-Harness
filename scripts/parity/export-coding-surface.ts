// Exercise the frozen TypeScript coding completion and review entry points with port doubles.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCollab } from "../../packages/core/src/collab/service.ts";
import { codingCompletionTool, codingMethods, reviewHooks } from "../../packages/core/src/collab/coding-surface.ts";
import { guardMethods } from "../../packages/core/src/rbac/guard.ts";
import { RpcError } from "../../packages/core/src/rpc/errors.ts";
import { exporterMain } from "./lib.mjs";

const owner = { kind: "person", role: "owner", userId: "owner" } as const;
const outside = { kind: "person", role: "member", userId: "outside" } as const;
const actor = { kind: "person", id: owner.userId } as const;

async function record(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "p4k-coding-surface-"));
  const root = realpathSync.native(dir);
  mkdirSync(join(root, "other"));
  const ids = new Map<string, number>();
  const collab = createCollab({ path: ":memory:", clock: () => 1, newId(prefix) {
    const count = (ids.get(prefix) ?? 0) + 1; ids.set(prefix, count); return prefix + "_" + count;
  } });
  try {
    const p = collab.createProject(owner, { name: "Coding" });
    for (const id of ["writer", "reviewer", "a2a:peer"]) collab.addAgent(owner, p.id, id);
    const start = collab.boardStore.columns(p.id)[0]!;
    const card = collab.boardStore.createCard(p.id, { title: "Fixture", description: "Self-reported green", columnId: start.id }, actor);
    collab.boardStore.assign(p.id, card.id, { kind: "agent", id: "writer" }, true, actor);
    const calls: string[] = [];
    let bound = root;
    const output = { ok: name !== "failed check", treeHash: "fixture-tree", changedLines: 5, checks: [], docGaps: [],
      ...(name === "failed check" ? { reason: "verifiers-failed" } : {}) };
    const o = {
      collab,
      worktrees: { root: () => name === "missing worktree" ? null : bound },
      gate: {
        async verify(input: { override?: { note: string; person: string } }) {
          calls.push(input.override ? "override" : "verify");
          if (name === "assignment revoked") collab.boardStore.assign(p.id, card.id, { kind: "agent", id: "writer" }, false, actor);
          if (name === "worktree rebound") bound = join(root, "other");
          return output;
        },
        snapshot(path: string) { calls.push("snapshot"); return { root: path, head: "fixture", treeHash: name === "changed snapshot" ? "changed" : "fixture-tree", changedLines: 5, files: [] }; },
        recordReview(_task: string, _snapshot: unknown, reviewer: string, caller: string) { calls.push("review:" + reviewer + ":" + caller); },
      },
    } as unknown as Parameters<typeof codingMethods>[0];
    const args = { projectId: p.id, cardId: card.id };
    const signal = new AbortController().signal;
    let result;
    try {
      if (name === "human override" || name === "foreign person") {
        const methods = guardMethods(codingMethods(o), { resolve: () => name === "foreign person" ? outside : owner, audit: { append() {} }, now: () => 1 });
        await methods["task.complete"]!({ ...args, ...(name === "human override" ? { overrideNote: "Human decision" } : {}) },
          { requestId: "call", connectionId: "fixture", signal });
      } else if (name.startsWith("review ")) {
        const hooks = reviewHooks(o);
        const ticket = hooks.start(p.id, card.id, "writer");
        hooks.finish(ticket, name === "review remote" ? "a2a:peer" : "reviewer", {
          status: name === "review partial" ? "partial" : "done", output: { verdict: "pass" },
        } as Parameters<typeof hooks.finish>[2]);
      } else {
        const tool = codingCompletionTool(o, { projectId: p.id } as never, () => owner);
        await tool.execute({ ...args, ...(name === "agent override" ? { overrideNote: "Agent decision" } : {}) },
          { agentId: name === "unassigned agent" ? "reviewer" : "writer", principal: name === "wrong caller" ? "outside" : owner.userId,
            surface: 1, signal } as never);
      }
      result = { ok: true };
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      result = { error: error.error, message: error.message };
    }
    const finished = collab.boardStore.getCard(p.id, card.id).columnId !== start.id;
    return { name, result, calls, finished };
  } finally { collab.close(); rmSync(dir, { recursive: true, force: true }); }
}

export async function buildCodingSurfaceVectors() {
  const surface = [];
  for (const name of ["complete", "wrong caller", "foreign person", "unassigned agent", "missing worktree", "failed check",
    "assignment revoked", "worktree rebound", "changed snapshot", "human override", "agent override",
    "review pass", "review partial", "review remote"]) surface.push(await record(name));
  return { surface };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "coding", build: buildCodingSurfaceVectors });
}
