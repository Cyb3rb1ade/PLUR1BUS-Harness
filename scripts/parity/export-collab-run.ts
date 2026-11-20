// Record delegate start, progress, return and shutdown against the actual collaboration service.
import { pathToFileURL } from "node:url";
import { createCollab } from "../../packages/core/src/collab/service.ts";
import { DEFAULT_COLLAB_LIMITS } from "../../packages/core/src/collab/limits.ts";
import { targetRunner } from "../../packages/core/src/collab/target.ts";
import type { Handoff } from "../../packages/core/src/collab/handoff.ts";
import { SessionStore } from "../../packages/core/src/session/store.ts";
import { exporterMain } from "./lib.mjs";

const lead = { userId: "lead", kind: "person", role: "owner" } as const;
const start = 1_791_374_400_000;
const text = "Fixture output from the worker";
const result = { text, inputTokens: 2, outputTokens: 3 };

async function record(name: string) {
  let now = start;
  const timers = new Set<{ at: number; fire(): void }>();
  const advance = (offset: number) => {
    now = start + offset;
    for (const entry of timers) if (entry.at <= now && timers.delete(entry)) entry.fire();
  };
  const config = structuredClone(DEFAULT_COLLAB_LIMITS);
  config.taskClasses["code-small"] = { rounds: 3, wallTimeMs: 40, stallTimeMs: 10 };
  const events = [];
  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<typeof result>();
  const counters = new Map<string, number>();
  let run: Parameters<ReturnType<typeof targetRunner>["run"]>[0] | undefined;
  const calls: string[] = [];
  const kind = name === "remote review" ? "a2a" : "local";
  let sessionIds = 0;
  const sessions = name === "transcript" ? new SessionStore({ path: ":memory:", clock: () => now,
    newId: prefix => prefix + "_" + ++sessionIds }) : undefined;
  const service = createCollab({
    path: ":memory:", clock: () => now, limits: () => config,
    ...(sessions ? { sessions: () => sessions } : {}),
    newId(prefix) { const n = (counters.get(prefix) ?? 0) + 1; counters.set(prefix, n); return prefix + "_" + n; },
    timers: { set(fire, ms) { const entry = { at: now + ms, fire }; timers.add(entry); return () => timers.delete(entry); } },
    runner: targetRunner([{
      kind, accepts: () => true,
      async ack() {
        calls.push("ack");
        return { schema: "plur1bus.ack/1", inReplyTo: name === "wrong ack" ? "other" : "handoff",
          objective: "Verify report", status: "ok", blockingQuestions: [] };
      },
      async run(input) { calls.push("run"); run = input; started.resolve(); return reply.promise; },
    }]),
    emit: { emit(e) { if (e.type.startsWith("delegate.") || e.type === "chain.abandoned") events.push(e); } },
  });
  const p = service.createProject(lead, { name: "Fixture", settings: { returnTokens: name === "cap" ? 1 : 100 } });
  for (const id of ["sender", "receiver"]) service.addAgent(lead, p.id, id);
  const deadline = name === "deadline" ? 8 : 50;
  const contract: Handoff = {
    schema: "plur1bus.handoff/1", id: "handoff", kind: "delegate",
    from: { agent: "sender", session: "sender-session" }, to: { agent: "receiver" },
    task: { id: "sender-task", project: p.id }, objective: "Verify report", doneWhen: ["Evidence recorded"],
    constraints: { scope: { paths: [], tools: ["file.read"] }, must: [], mustNot: [] },
    authority: { mayDecide: [], mustAsk: [], approvalsHeld: [] },
    budget: { tokens: 150, toolCalls: 3, deadline: new Date(start + deadline).toISOString(), modelTier: "standard" },
    returnContract: { format: "plur1bus.return/1", maxTokens: 2000, outputSchema: { type: "string" }, citationsRequired: false },
  };
  const bare = name.startsWith("shutdown ");
  try {
    const handoff = name === "wrong target" ? { ...contract, to: { agent: "other" } } : contract;
    const handle = service.delegate({
      principal: lead, projectId: p.id, fromAgent: "sender", toAgent: "receiver",
      task: "Verify report", acceptanceCriteria: "Evidence recorded",
      ...(bare ? {} : { handoff: { contract: handoff, context: {
        person: lead.userId, taskId: "sender-task", sessionId: "sender-session", fromAgent: "sender", projectId: p.id,
        ...(name === "remote review" ? { purpose: "independent-review" as const } : {}),
        approvals: { get: () => undefined }, grants: { get: () => undefined }, audit() {}, now: () => now,
      } } }),
    });
    const initial = handle.task.status;
    let finish: unknown = null;
    let transcript: unknown = null;
    const active: boolean[] = [];
    if (name === "wrong ack" || name === "remote review" || name === "wrong target") {
      // The service records any receiver refusal as a failed delegate.
    } else {
      await started.promise;
      const live = () => active.push(!run!.signal.aborted);
      if (name === "progress") {
        advance(9); run!.onProgress?.(result); live();
        advance(18); run!.onProgress?.(result); live();
      }
      if (name === "deadline" || name === "stall") {
        run!.onProgress?.(result);
        const end = name === "deadline" ? deadline : 10;
        advance(end - 1); live();
        advance(end); live();
      } else if (name === "shutdown abandons") {
        await service.shutdown(0);
      } else if (name === "shutdown cooperative") {
        run!.signal.addEventListener("abort", () => reply.reject(new Error("cancelled")), { once: true });
        // Keep the fixture process alive while the TypeScript service awaits its unref'ed drain timer.
        const keepAlive = setTimeout(() => {}, 1_000);
        try { await service.shutdown(100); } finally { clearTimeout(keepAlive); }
      } else {
        reply.resolve(result);
      }
    }
    if (!bare) {
      const task = await handle.done;
      const trace = service.getTrace(lead, task.traceId);
      const span = trace.spans.find(s => s.spanId === task.spanId)!;
      finish = { task: task.status, span: span.status, error: task.error, result: task.result,
        truncated: task.truncated, targetKind: task.targetKind ?? null,
        inputTokens: span.inputTokens, outputTokens: span.outputTokens };
      if (sessions) {
        const replay = service.replay(lead, task.traceId, task.spanId);
        transcript = { messages: replay.messages.map(m => [m.role, m.text]),
          events: replay.events.map(e => [e.type, "handoff" in e.data, e.data.entry?.kind ?? null, e.data.status ?? null]) };
      }
    }
    return { name, start, deadline, handoff: bare ? null : JSON.stringify(handoff), initial, active, calls, finish, transcript,
      events: events.map(e => ({ type: e.type, status: e.data.status ?? null, inflight: e.data.inflight ?? null })) };
  } finally { service.close(); sessions?.close(); }
}

export async function buildCollabRunVectors() {
  const run = [];
  for (const name of ["done", "cap", "transcript", "progress", "deadline", "stall", "wrong ack", "wrong target", "remote review", "shutdown abandons", "shutdown cooperative"]) {
    run.push(await record(name));
  }
  return { run };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "collab", build: buildCollabRunVectors });
}
