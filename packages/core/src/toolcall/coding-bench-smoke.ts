/** One real case before a complete owner capture, using the existing runner's cleanup boundary. */
import assert from "node:assert/strict";
import { runCodingLive, type CodingLiveOptions } from "./coding-bench-live.ts";
import { singleCodingArm, type CodingSubjectResult } from "./coding-bench-subject.ts";

export async function runCodingSmoke(
  corpus: string,
  options: Omit<CodingLiveOptions, "arms" | "onCase">,
  capture: typeof runCodingLive = runCodingLive,
  makeArm: typeof singleCodingArm = singleCodingArm,
) {
  assert.equal(options.models.length, 1, "one model per smoke");
  options.signal.throwIfAborted();
  const stop = new AbortController();
  const finished = new Error("one-case smoke complete");
  let calls = 0;
  let observation: CodingSubjectResult | undefined;
  let identity: { taskId: string; seed: number } | undefined;
  let progress: { checked: number; resolved: number } | undefined;
  try {
    await capture(corpus, {
      ...options,
      signal: AbortSignal.any([options.signal, stop.signal]),
      arms: [{
        family: "single",
        params: {},
        create(settings) {
          const arm = makeArm(settings);
          return {
            id: arm.id,
            async run(input) {
              assert.equal(++calls, 1, "one model task per smoke");
              identity = { taskId: input.taskId, seed: input.seed };
              observation = await arm.run(input);
              return observation;
            },
          };
        },
      }],
      onCase(value) {
        assert.equal(progress, undefined, "one completed case per smoke");
        assert.equal(value.checked, 1);
        assert.ok(value.resolved === 0 || value.resolved === 1);
        progress = value;
        stop.abort(finished);
      },
    });
    throw new Error("smoke stop boundary unavailable");
  } catch (error) {
    if (error !== finished) throw error;
  }
  options.signal.throwIfAborted();
  assert.equal(calls, 1);
  assert.ok(observation && identity && progress);
  assert.ok(["completed", "budget", "aborted", "provider-error"].includes(observation.outcome));
  assert.match(identity.taskId, /^[a-z0-9-]+$/u);
  assert.ok(Number.isSafeInteger(identity.seed));
  const countNames = ["rounds", "toolCalls", "toolErrors"] as const;
  const usageNames = ["input", "output", "cacheRead", "cacheCreated", "totalInput"] as const;
  const metrics = {} as Pick<CodingSubjectResult["metrics"], typeof countNames[number] | typeof usageNames[number]>;
  for (const name of countNames) {
    const value = observation.metrics[name];
    assert.ok(Number.isSafeInteger(value) && value >= 0);
    metrics[name] = value;
  }
  for (const name of usageNames) {
    const value = observation.metrics[name];
    assert.ok(value === null || (Number.isFinite(value) && value >= 0));
    metrics[name] = value;
  }
  return {
    schema: "plur1bus.coding-smoke/1" as const,
    checked: 1 as const,
    ...identity,
    subject: observation.outcome,
    resolved: progress.resolved === 1,
    metrics,
    ready: observation.outcome === "completed" && progress.resolved === 1
      && usageNames.every((name) => metrics[name] !== null),
  };
}
