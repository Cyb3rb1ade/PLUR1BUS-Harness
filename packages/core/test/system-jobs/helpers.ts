// Shared helpers for the system-jobs tests (new file, system-jobs tests only).
import { afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeClock } from "../../src/discovery/testing.ts";
import type { RunTrigger } from "../../src/discovery/types.ts";
import { createSystemJobs, type CreateSystemJobsOptions, type SystemJobHandler, type SystemJobOutcome, type SystemJobSpec, type SystemJobs } from "../../src/system-jobs/index.ts";

/** Seeded PRNG (mulberry32): the only source of randomness in these tests. The seed is part of every failure message. */
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

/** Registers an afterEach hook in the calling scope; every directory made through `make()` is removed after each test. */
export function useTempDirs(prefix = "p1b-sysjobs-") {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { make(): string { const dir = mkdtempSync(path.join(tmpdir(), prefix)); made.push(dir); return dir; } };
}

/** The exact title of a documented-behaviour deviation: used as test name and as the `todo` reason. */
export function gap(fn: string, expected: string, actual: string): string {
  return `KNOWN GAP: core/system-jobs ${fn}: erwartet ${expected}, tatsächlich ${actual}`;
}

export const T0 = Date.parse("2026-10-13T12:00:00Z");

export interface HandlerScript {
  name?: string;
  run?: SystemJobHandler["run"];
  validateArgs?: SystemJobHandler["validateArgs"];
  nextRunAt?: () => number | null;
  schedule?: SystemJobSpec["schedule"];
  exclusive?: boolean;
}

/** A scripted handler; `calls` records what the module handed to it. The behaviour under test (the registry, the ledger) is not in here. */
export function scriptedHandler(s: HandlerScript = {}) {
  const calls: { args: Record<string, unknown>; ctx: { runId: string; trigger: RunTrigger; signal: AbortSignal } }[] = [];
  const validated: unknown[] = [];
  const handler: SystemJobHandler = {
    spec: { name: s.name ?? "test.job", needsLlm: false, singleton: true, schedule: s.schedule ?? { every: 60_000, jitter: 0.1 }, ...(s.exclusive ? { exclusive: true } : {}) },
    nextRunAt: s.nextRunAt ?? (() => null),
    validateArgs: (a) => { validated.push(a); return s.validateArgs ? s.validateArgs(a) : (a && typeof a === "object" ? { ...(a as Record<string, unknown>) } : {}); },
    run: async (args, ctx) => { calls.push({ args, ctx }); return s.run ? s.run(args, ctx) : ({ outcome: "completed", detail: null } satisfies SystemJobOutcome); },
  };
  return { handler, calls, validated };
}

export interface Setup {
  dir: string; ledgerPath: string; clock: FakeClock; jobs: SystemJobs; warnings: string[]; secured: string[]; failed: { runId: string; job: string; reason?: string }[];
}

export function setup(dirs: { make(): string }, over: Partial<CreateSystemJobsOptions> = {}): Setup {
  const dir = dirs.make();
  const ledgerPath = path.join(dir, "state", "system-jobs", "ledger.jsonl");
  const clock = new FakeClock(T0);
  const warnings: string[] = []; const secured: string[] = []; const failed: Setup["failed"] = [];
  const jobs = createSystemJobs({
    ledgerPath, clock, engineHasJob: () => false,
    securePath: (p) => { secured.push(p); return { applied: true }; },
    logger: { warn: (m) => { warnings.push(m); } },
    onFailed: (r) => { failed.push(r); },
    ...over,
  });
  return { dir, ledgerPath, clock, jobs, warnings, secured, failed };
}
