import { pathToFileURL } from "node:url";
import { createKnowledgeUpdateJob, armKnowledgeUpdate } from "../../packages/core/src/knowledge/job.ts";
import { exporterMain } from "./lib.mjs";

async function jobCase(name: string) {
  const controller = new AbortController();
  let registered = ["a", "b", "c"];
  let now = 10_000;
  const calls: unknown[] = [];
  const context = { signal: controller.signal, trigger: "manual" as const };
  let reentrant: unknown = null;
  const job = createKnowledgeUpdateJob({
    now: () => now,
    lastRunAt: name === "restart" ? 9_000 : undefined,
    agents: () => registered,
    engine: {
      capabilities: name === "capability" ? { knowledgePromotion: "true" } : { knowledgePromotion: true },
      jobs: {
        list: () => [{ name: name === "job name" ? "knowledge.update" : "knowledge-update" }],
        async run(jobName, agentId, options) {
          calls.push([jobName, agentId, options.trigger]);
          if (name === "throw" && agentId === "a") throw new Error("unavailable");
          if (name === "invalid" && agentId === "b") return { outcome: "complete" };
          if (name === "removed" && agentId === "a") registered = ["a", "c"];
          if (name === "abort" && agentId === "a") controller.abort();
          if (name === "singleton" && agentId === "a") reentrant = await job.run({}, context);
          if (name === "mixed" && agentId === "b") return { outcome: "incomplete", reason: "budget" };
          return { outcome: agentId === "c" ? "skipped" : "completed", runId: agentId + "-run" };
        },
      },
    },
  });
  const initial = job.nextRunAt();
  let outcome: unknown;
  try {
    const arg: unknown = name === "target" ? { agentId: "b" } : name === "unknown" ? { agentId: "absent" }
      : name === "extra" ? { scope: "b" } : name === "array" ? [] : null;
    const validated = job.validateArgs(arg);
    now += 200;
    if (name === "pre-abort") controller.abort();
    outcome = await job.run(validated, context);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    outcome = { error: error.message };
  }
  return { name, initial, next: job.nextRunAt(), outcome, calls, reentrant };
}

async function retryCase() {
  const controller = new AbortController();
  let now = 100;
  let next = 120;
  let fire = async () => {};
  const delays: number[] = [];
  let cancelled = 0;
  armKnowledgeUpdate(
    { list: () => [{ name: "knowledge.update", nextRunAt: next }], run: async () => {
      next = now + 5;
      throw new Error("registry unavailable");
    } },
    { now: () => now, setTimer(fn, delay) {
      delays.push(delay);
      fire = async () => { await fn(); };
      return { cancel: () => { cancelled++; } };
    } },
    controller.signal,
    { warn: () => {} },
  );
  now += 20;
  await fire();
  controller.abort();
  return { delays, cancelled };
}

export async function buildKnowledgeJobVectors() {
  return { job: {
    cases: await Promise.all(["restart", "capability", "job name", "target", "unknown", "extra", "array", "throw",
      "invalid", "removed", "abort", "pre-abort", "singleton", "mixed"].map(jobCase)),
    retry: await retryCase(),
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "knowledge", build: buildKnowledgeJobVectors });
}
