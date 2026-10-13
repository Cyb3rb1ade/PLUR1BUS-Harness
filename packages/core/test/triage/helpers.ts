// Shared helpers for the new triage tests (new file; test/triage/triage.test.ts is left alone).
import { MODEL_CLASSES, type ClassifierPort, type TriageDecision, type TriageTask, type ModelClass } from "../../src/triage/index.ts";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gap(fn: string, expected: string, actual: string): string {
  return `KNOWN GAP: core/triage ${fn}: erwartet ${expected}, tatsächlich ${actual}`;
}

export const classIndex = (c: ModelClass): number => MODEL_CLASSES.indexOf(c);

/** A syntactically valid single-task decision for `message`, to be varied by a test. */
export function taskOf(message: string, over: Partial<TriageTask> = {}): TriageTask {
  return {
    id: "k1", summary: message.slice(0, Math.max(1, message.length)), start: 0, end: message.length, categories: { "general.chat": 1 },
    modelClass: { small: 0.85, medium: 0.1, large: 0.04, frontier: 0.01 }, chosenClass: "small", effort: "low", dependsOn: [], confidence: 0.9, reason: "test", ...over,
  };
}
export const decision = (tasks: TriageTask[], over: Partial<TriageDecision> = {}): TriageDecision => ({ schema: "plur1bus.triage/1", shape: tasks.length > 1 ? "multi" : "single", tasks, ...over });
export const fixed = (d: TriageDecision): ClassifierPort => () => d;
