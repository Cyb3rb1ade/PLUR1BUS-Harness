// Turn-local collection vectors recorded with the real TurnDelegations and scripted child completions.
import { pathToFileURL } from "node:url";
import { TurnDelegations, type ChildOutput } from "../../packages/core/src/collab/delegations.ts";
import { CollabError } from "../../packages/core/src/collab/errors.ts";
import { exporterMain } from "./lib.mjs";

type Operation =
  | { op: "start"; id: string; project: string; card: boolean }
  | { op: "complete"; id: string; error?: boolean }
  | { op: "collect" | "projects"; ids: string[]; claim?: string }
  | { op: "settle"; claim: string; accepted: boolean }
  | { op: "cancel-unbound" | "aborted"; id: string }
  | { op: "finish"; cancel: boolean }
  | { op: "closed" };

function report(id: string): ChildOutput {
  return {
    result: {
      schema: "plur1bus.return/1", id: "rt_" + id, inReplyTo: "ho_" + id, status: "partial",
      summary: "fixture", doneWhen: [], changes: [], artifacts: [], concerns: [], blockedBy: null,
      needs: [], assumptionsChecked: [], learned: [], suggestedNext: [], usage: { tokens: 0, toolCalls: 0, durationMs: 0 },
    },
  };
}

async function scenario(name: string, ops: Operation[]) {
  const turn = new TurnDelegations();
  const children = new Map<string, {
    abort: AbortController; resolve(v: ChildOutput): void; reject(e: Error): void; done: Promise<ChildOutput>;
  }>();
  const claims = new Map<string, (accepted: boolean) => void>();
  let closed = false;
  turn.onClosed(() => { closed = true; });

  async function run(step: Operation): Promise<unknown> {
    switch (step.op) {
      case "start": {
        const abort = new AbortController();
        const { promise, resolve, reject } = Promise.withResolvers<ChildOutput>();
        const done = turn.start(step.id, step.project, step.card, abort, () => promise, { fromAgent: "sender" });
        void done.catch(() => {});
        children.set(step.id, { abort, resolve, reject, done });
        return null;
      }
      case "complete": {
        const child = children.get(step.id)!;
        if (step.error) child.reject(new CollabError("guardrail", "[private]", { guardrail: "timeout" }));
        else child.resolve(report(step.id));
        await child.done.catch(() => {});
        return null;
      }
      case "collect": {
        return turn.wait(step.ids, 0, new AbortController().signal,
          step.claim === undefined ? undefined : settled => claims.set(step.claim!, settled));
      }
      case "projects": return turn.projects(step.ids);
      case "settle": claims.get(step.claim)!(step.accepted); return null;
      case "cancel-unbound": turn.cancelUnbound(step.id); return null;
      case "aborted": return children.get(step.id)!.abort.signal.aborted;
      case "finish": return turn.finish(step.cancel);
      case "closed": return closed;
    }
  }

  const results = [];
  for (const step of ops) {
    try { results.push({ ok: await run(step) }); }
    catch (e) {
      if (!(e instanceof CollabError)) throw e;
      results.push({ err: { code: e.code, message: e.message } });
    }
  }
  return { name, ops, results };
}

export async function buildCollabDelegationVectors() {
  return { delegations: await scenario("turn binding, delivery and cancellation", [
    { op: "start", id: "read", project: "primary", card: false },
    { op: "start", id: "write", project: "primary", card: true },
    { op: "start", id: "review", project: "secondary", card: false },
    { op: "collect", ids: ["foreign"] },
    { op: "projects", ids: ["read", "write", "review", "read"] },
    { op: "collect", ids: ["review", "read", "review"] },
    { op: "cancel-unbound", id: "read" },
    { op: "aborted", id: "read" },
    { op: "aborted", id: "write" },
    { op: "aborted", id: "review" },
    { op: "complete", id: "review", error: true },
    { op: "complete", id: "read" },
    { op: "collect", ids: ["review", "read", "review", "write"], claim: "first" },
    { op: "collect", ids: ["review", "read", "write"] },
    { op: "settle", claim: "first", accepted: false },
    { op: "collect", ids: ["read", "review"], claim: "second" },
    { op: "settle", claim: "first", accepted: true },
    { op: "settle", claim: "second", accepted: true },
    { op: "collect", ids: ["read", "review"] },
    { op: "complete", id: "write" },
    { op: "closed" },
    { op: "finish", cancel: true },
    { op: "aborted", id: "write" },
    { op: "closed" },
    { op: "start", id: "later", project: "primary", card: false },
  ]) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "collab", build: buildCollabDelegationVectors });
}
