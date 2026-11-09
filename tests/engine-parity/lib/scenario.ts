import { readFileSync } from "node:fs";
import { assertNoMarkers, isRecord, type StepResult, type Tolerance } from "./diff.ts";

export const PIN = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
export const scenarioRoot = "tests/engine-parity/scenarios";
const ops = [
  "capture", "recall", "checkpoint", "jobs.run",
  "memory.list", "memory.show", "memory.forget", "memory.state", "memory.correct",
  "memory.share", "memory.import", "memory.rebind", "memory.unbind", "memory.unimport", "memory.link",
  "memory.propose", "memory.proposals.list", "memory.proposals.accept", "memory.proposals.reject",
  "admin.migrate", "snapshot", "adopt",
] as const;

export interface Step {
  op: typeof ops[number];
  args: Record<string, unknown>;
  expect: "golden" | Record<string, unknown>;
  tolerance: Tolerance;
  traceCompare: string[];
}

export interface Scenario {
  store: "store-v1" | "store-v1-scored" | "empty";
  config: Record<string, unknown>;
  seams: {
    embedder: "flat" | "hash" | "real";
    reranker: "none" | "real" | `fixture:${string}`;
    llm: "none" | `fixture:${string}`;
    clock: number;
  };
  steps: Step[];
}

export interface Golden {
  schema: "engine-parity.golden/1";
  recordedFrom: { engine: "node"; commit: string; at: string };
  steps: StepResult[];
}

function only(object: Record<string, unknown>, keys: readonly string[], where: string): void {
  if (Object.keys(object).some(key => !keys.includes(key))) throw new Error(`${where}: unknown field`);
}

const fixture = (value: unknown): value is `fixture:${string}` =>
  typeof value === "string" && /^fixture:[a-z0-9][a-z0-9_-]*\.json$/.test(value);

export function readScenario(file: string): Scenario {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  assertNoMarkers(value, "scenario");
  if (!isRecord(value) || value.schema !== "engine-parity.scenario/1") throw new Error("expected engine-parity.scenario/1");
  only(value, ["schema", "store", "config", "seams", "steps"], "scenario");
  const { store, config, seams, steps } = value;
  if (store !== "empty" && store !== "store-v1" && store !== "store-v1-scored") throw new Error("unknown scenario store");
  if (!isRecord(config) || !isRecord(seams) || !Array.isArray(steps) || steps.length === 0) throw new Error("scenario needs config, seams and steps");
  only(seams, ["embedder", "reranker", "llm", "clock"], "seams");
  const { embedder, reranker, llm, clock } = seams;
  if ((embedder !== "flat" && embedder !== "hash" && embedder !== "real")
      || (reranker !== "none" && reranker !== "real" && !fixture(reranker))
      || (llm !== "none" && !fixture(llm))
      || typeof clock !== "number" || !Number.isSafeInteger(clock) || clock < 0 || !Number.isFinite(new Date(clock).getTime())) {
    throw new Error("invalid scenario seams");
  }
  return { store, config, seams: { embedder, reranker, llm, clock }, steps: steps.map(readStep) };
}

function readStep(value: unknown, index: number): Step {
  const at = `step ${index + 1}`;
  if (!isRecord(value)) throw new Error(`${at}: expected an object`);
  only(value, ["op", "args", "expect", "tolerance", "trace"], at);
  const { op, args, expect, tolerance, trace } = value;
  if (!ops.includes(op as Step["op"]) || !isRecord(args) || (expect !== "golden" && !isRecord(expect))) {
    throw new Error(`${at}: invalid operation, args or expectation`);
  }
  let tol: Tolerance = {};
  if (tolerance !== "default") {
    if (!isRecord(tolerance) || typeof tolerance.scores !== "number" || !Number.isFinite(tolerance.scores) || tolerance.scores < 0) {
      throw new Error(`${at}: invalid tolerance`);
    }
    only(tolerance, ["scores"], at);
    tol = { scores: tolerance.scores };
  }
  let traceCompare: string[] = [];
  if (trace !== undefined) {
    if (!isRecord(trace) || !Array.isArray(trace.compare) || !trace.compare.every(
      (item: unknown) => typeof item === "string" && /^(\/(?:[^~\/]|~[01])*)+$/.test(item),
    )) throw new Error(`${at}: expected trace.compare JSON pointers`);
    only(trace, ["compare"], at);
    traceCompare = trace.compare;
  }
  return { op: op as Step["op"], args, expect, tolerance: tol, traceCompare };
}

export function readGolden(file: string, scenario: string): Golden {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(`missing golden. Run pnpm parity --record ${scenarioRoot}/${scenario}.json`);
  }
  const value: unknown = JSON.parse(raw);
  assertNoMarkers(value, "golden");
  if (!isRecord(value) || value.schema !== "engine-parity.golden/1" || !isRecord(value.recordedFrom)
    || value.recordedFrom.engine !== "node" || value.recordedFrom.commit !== PIN
    || typeof value.recordedFrom.at !== "string" || !Number.isFinite(Date.parse(value.recordedFrom.at))
    || !Array.isArray(value.steps) || !value.steps.every(step => isRecord(step)
      && Object.hasOwn(step, "result") && Object.hasOwn(step, "trace"))) {
    throw new Error("invalid golden or recording pin");
  }
  return value as unknown as Golden;
}
