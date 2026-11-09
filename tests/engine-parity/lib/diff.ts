import { leaks } from "../../system/redaction-fixture.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type StepResult = { result: Json; trace: Json };
export type Tolerance = { scores?: number };

const volatile = new Set([
  "acceptedAt", "checkedAt", "createdAt", "durationMs", "elapsedMs", "finishedAt",
  "runId", "parentRunId", "startedAt", "timestamp", "timing", "updatedAt",
]);
const scores = new Set([
  "score", "scores", "vectorScore", "rerankScore", "rawScore", "finalScore", "similarity",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertNoMarkers(value: unknown, channel: string): void {
  const text = JSON.stringify(value);
  if (text !== undefined && leaks(channel, "payload", text).length > 0) {
    throw new Error(`${channel}: secret marker detected`);
  }
  // An encoded JSON string exposes only its escaped form to a serialized scan.
  // Scan decoded strings too, including embedded JSON and unescaped object keys.
  const visit = (item: unknown): boolean => {
    if (typeof item === "string") return leaks(channel, "payload", item).length > 0;
    if (Array.isArray(item)) return item.some(visit);
    return isRecord(item) && Object.entries(item).some(([key, child]) => visit(key) || visit(child));
  };
  if (visit(value)) throw new Error(`${channel}: secret marker detected`);
}

function canonical(value: unknown): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([key, item]) => !volatile.has(key) && item !== undefined);
    entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item)]));
  }
  throw new Error("parity output is not JSON");
}

export function normalizeStep(raw: unknown): StepResult {
  assertNoMarkers(raw, "engine output");
  if (!isRecord(raw) || !Object.hasOwn(raw, "trace")) return { result: canonical(raw), trace: null };
  const { trace, ...result } = raw;
  return { result: canonical(result), trace: trace === undefined ? null : canonical(trace) };
}

function pointer(path: string, field: string): string {
  return `${path}/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

export function compare(
  expected: StepResult,
  actual: StepResult,
  tolerance: Tolerance = {},
  traceCompare: readonly string[] = [],
): string[] {
  const differences: string[] = [];
  const requiredNumbers = new Set(traceCompare.map(field => `/trace${field}`));
  const epsilon = tolerance.scores ?? 1e-6;

  const visit = (left: Json, right: Json, path: string, score: boolean, trace: boolean): void => {
    if (differences.length >= 40) return;
    const numeric = typeof left === "number" && typeof right === "number";
    if (numeric) requiredNumbers.delete(path);
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) differences.push(`${path}: array length differs`);
      const size = Math.min(left.length, right.length);
      for (let i = 0; i < size; i++) visit(left[i]!, right[i]!, pointer(path, String(i)), score, trace);
      return;
    }
    if (isRecord(left) && isRecord(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        const at = pointer(path, key);
        if (!Object.hasOwn(left, key)) differences.push(`${at}: unexpected field`);
        else if (!Object.hasOwn(right, key)) differences.push(`${at}: missing field`);
        else visit(left[key] as Json, right[key] as Json, at, scores.has(key), trace);
        if (differences.length >= 40) break;
      }
      return;
    }
    if (left === right) return;
    if (left === null || right === null || typeof left !== typeof right || typeof left === "object") {
      differences.push(`${path}: type differs`);
    } else if (trace && !traceCompare.includes(path.slice("/trace".length))) {
      return;
    } else if (score && numeric) {
      if (Math.abs(left - right) > epsilon) differences.push(`${path}: exceeds tolerance ${epsilon}`);
    } else {
      differences.push(`${path}: value differs`);
    }
  };

  visit(expected.result, actual.result, "/result", false, false);
  visit(expected.trace, actual.trace, "/trace", false, true);
  for (const path of requiredNumbers) differences.push(`${path}: numeric trace field required`);
  return differences;
}
