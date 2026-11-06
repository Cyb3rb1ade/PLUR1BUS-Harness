import assert from "node:assert/strict";
import { test } from "node:test";
import { runCodingSmoke } from "../../src/toolcall/coding-bench-smoke.ts";
import type { CodingLiveOptions, runCodingLive } from "../../src/toolcall/coding-bench-live.ts";
import type { CodingMetrics, CodingSubjectInput, CodingSubjectResult, singleCodingArm } from "../../src/toolcall/coding-bench-subject.ts";

const metrics: CodingMetrics = {
  rounds: 1, toolCalls: 1, toolErrors: 0, input: 5, output: 2, cacheRead: 0,
  cacheCreated: 0, totalInput: 5, cacheShare: 0, syntaxRefusals: null,
  offloads: null, steers: null, rewinds: null,
};
function options(): CodingLiveOptions {
  return {
    home: "unused", models: [{ provider: "anthropic", model: "fixture", baseUrl: "https://example.test/v1", wireFormat: "anthropic_messages" }],
    revision: "a".repeat(40), toolsBinary: "unused", limitsHelper: "unused", signal: new AbortController().signal,
  };
}
const input = { taskId: "easy-example", seed: 11 } as CodingSubjectInput;
function factory(outcome: CodingSubjectResult["outcome"] = "completed", values = metrics): typeof singleCodingArm {
  return () => ({ id: "single", async run() { return { outcome, metrics: values }; } });
}
const simulate: typeof runCodingLive = async (_root, settings) => {
  const arm = settings.arms![0]!.create({} as Parameters<typeof singleCodingArm>[0]);
  await arm.run(input);
  settings.onCase!({ checked: 1, resolved: 1 });
  settings.signal.throwIfAborted();
  assert.fail("a second case must never begin");
};

test("smoke stops after one case, awaits cleanup and retains numeric evidence", async () => {
  let cleaned = false;
  const capture: typeof runCodingLive = async (...args) => {
    try { return await simulate(...args); } finally { cleaned = true; }
  };
  const result = await runCodingSmoke("unused", options(), capture, factory());
  assert.equal(cleaned, true);
  assert.equal(result.ready, true);
  assert.equal(result.checked, 1);
  assert.equal(result.schema, "plur1bus.coding-smoke/1");
  assert.deepEqual(result.metrics, { rounds: 1, toolCalls: 1, toolErrors: 0, input: 5, output: 2, cacheRead: 0, cacheCreated: 0, totalInput: 5 });
});

test("smoke forwards bounded stage diagnostics through the actual runner options", async () => {
  const phases: string[] = [];
  const capture: typeof runCodingLive = async (...args) => {
    args[1].onPhase?.("runtimes");
    return simulate(...args);
  };
  await runCodingSmoke("unused", { ...options(), onPhase: phase => phases.push(phase) }, capture, factory());
  assert.deepEqual(phases, ["runtimes"]);
});

test("provider failure and unavailable usage cannot pass smoke readiness", async () => {
  for (const outcome of ["provider-error", "budget", "aborted"] as const) {
    assert.equal((await runCodingSmoke("unused", options(), simulate, factory(outcome))).ready, false);
  }
  assert.equal((await runCodingSmoke("unused", options(), simulate, factory("completed", { ...metrics, input: null }))).ready, false);
});

test("failed cleanup remains a failure after the one-case stop", async () => {
  const capture: typeof runCodingLive = async (...args) => {
    try { return await simulate(...args); } finally { throw new Error("cleanup failed"); }
  };
  await assert.rejects(runCodingSmoke("unused", options(), capture, factory()), /cleanup failed/);
});

test("a second subject call is refused before another model turn", async () => {
  let calls = 0;
  const capture: typeof runCodingLive = async (_root, settings) => {
    const arm = settings.arms![0]!.create({} as Parameters<typeof singleCodingArm>[0]);
    await arm.run(input);
    await arm.run(input);
    assert.fail("second model task admitted");
  };
  await assert.rejects(runCodingSmoke("unused", options(), capture, () => ({ id: "single", async run() {
    calls++; return { outcome: "completed", metrics };
  } })), /one model task/);
  assert.equal(calls, 1);
});

test("external cancellation cannot become a successful smoke at the stop boundary", async () => {
  const stop = new AbortController();
  const capture: typeof runCodingLive = async (...args) => {
    try { return await simulate(...args); } finally { stop.abort(new Error("external stop")); }
  };
  await assert.rejects(runCodingSmoke("unused", { ...options(), signal: stop.signal }, capture, factory()), /external stop/);
});

test("smoke refuses a model matrix before executing any case", async () => {
  const settings = options();
  settings.models = [...settings.models, ...settings.models];
  await assert.rejects(runCodingSmoke("unused", settings, simulate, factory()));
});


test("invalid numeric evidence is refused", async () => {
  for (const values of [{ ...metrics, rounds: -1 }, { ...metrics, input: Number.NaN }]) {
    await assert.rejects(runCodingSmoke("unused", options(), simulate, factory("completed", values)));
  }
});

test("cancellation during the subject still awaits cleanup and refuses a report", async () => {
  const stop = new AbortController();
  let cleaned = false;
  const capture: typeof runCodingLive = async (...args) => {
    try { return await simulate(...args); } finally { cleaned = true; }
  };
  const arm: typeof singleCodingArm = () => ({ id: "single", async run() {
    stop.abort(new Error("subject cancelled"));
    stop.signal.throwIfAborted();
    return { outcome: "completed", metrics };
  } });
  await assert.rejects(runCodingSmoke("unused", { ...options(), signal: stop.signal }, capture, arm), /subject cancelled/);
  assert.equal(cleaned, true);
});
