// Shared helpers for the dreams tests (new file, dreams tests only): a virtual clock, a scripted engine job registry,
// a temp-dir store, a seeded PRNG. Nothing here implements scheduling behaviour: the scheduler under test is the real one.
import { afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeClock } from "../../src/discovery/testing.ts";
import { DreamScheduler, type SchedulerOptions } from "../../src/dreams/scheduler.ts";
import { DreamStore } from "../../src/dreams/store.ts";
import type { DreamEngine, DreamEvent, DreamJobRun, Phase } from "../../src/dreams/types.ts";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** A fixed UTC midnight: 2026-10-13 (a Tuesday). */
export const T0 = Date.parse("2026-10-13T00:00:00Z");

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
export function useTempDirs(prefix = "p1b-dreams-") {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { make(): string { const dir = mkdtempSync(path.join(tmpdir(), prefix)); made.push(dir); return dir; } };
}

/** The exact title of a documented-behaviour deviation: used as test name and as the `todo` reason. */
export function gap(fn: string, expected: string, actual: string): string {
  return `KNOWN GAP: core/dreams ${fn}: erwartet ${expected}, tatsächlich ${actual}`;
}

export const iso = (s: string): number => Date.parse(s);
export const at = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

const JOBS: { name: string; needsLlm: boolean; singleton: boolean; phase?: Phase }[] = [
  { name: "light-dream", needsLlm: true, singleton: false, phase: "light" },
  { name: "embedding-drain", needsLlm: false, singleton: false },
  { name: "rem-dream", needsLlm: true, singleton: false, phase: "rem" },
  { name: "discover-semantic-links", needsLlm: false, singleton: false },
  { name: "consolidate-daily", needsLlm: true, singleton: false, phase: "deep" },
  { name: "auto-accept-stale", needsLlm: false, singleton: false },
  { name: "gc-run", needsLlm: false, singleton: true },
];

type Behaviour = (agentId: string, n: number) => Partial<DreamJobRun> | Promise<Partial<DreamJobRun>>;

/** A scripted engine job registry: records every call (with the options it was given) and answers per job. */
export class ScriptedEngine implements DreamEngine {
  readonly calls: { job: string; agentId: string; trigger?: string; signal?: AbortSignal }[] = [];
  readonly behaviours = new Map<string, Behaviour>();
  available: string[] = JOBS.map((j) => j.name);
  jobs: DreamEngine["jobs"] = {
    list: () => JOBS.filter((j) => this.available.includes(j.name)),
    run: async (job, agentId, opts) => {
      const n = this.calls.filter((c) => c.job === job).length + 1;
      this.calls.push({ job, agentId, ...(opts?.trigger !== undefined ? { trigger: opts.trigger } : {}), ...(opts?.signal ? { signal: opts.signal } : {}) });
      const b = this.behaviours.get(job);
      const o = b ? await b(agentId, n) : {};
      return { runId: `eng-${job}-${n}`, job, outcome: "completed", cost: { ms: 1, inputTokens: 100, outputTokens: 50 }, ...o } as DreamJobRun;
    },
  };
  callsOf(job: string): number { return this.calls.filter((c) => c.job === job).length; }
  callsFor(agentId: string): number { return this.calls.filter((c) => c.agentId === agentId).length; }
}

/** Lets already-queued microtasks and immediates run; the scheduler awaits real promises, not the virtual clock. */
export async function settle(times = 20): Promise<void> { for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r)); }

export interface Harness {
  dir: string; clock: FakeClock; store: DreamStore; engine: ScriptedEngine; sched: DreamScheduler; events: DreamEvent[]; warnings: string[];
  /** The mutable agent registry the scheduler reads through `agents()`. */
  agents: string[];
  make(over?: Partial<SchedulerOptions>): DreamScheduler;
  /** Advances virtual time in steps, letting every fired run finish before the next step. */
  advance(ms: number, step?: number): Promise<void>;
  captures(agentId: string, n: number): void;
}

export function harness(dirs: { make(): string }, o: { agents?: string[]; over?: Partial<SchedulerOptions>; start?: number; engine?: ScriptedEngine } = {}): Harness {
  const dir = dirs.make();
  const clock = new FakeClock(o.start ?? T0);
  const store = new DreamStore(path.join(dir, "dreams.db"));
  const engine = o.engine ?? new ScriptedEngine();
  const events: DreamEvent[] = []; const warnings: string[] = [];
  const agents = o.agents ?? ["alpha"];
  const make = (over: Partial<SchedulerOptions> = {}) => new DreamScheduler({
    store, engine, clock, agents: () => agents, logsDir: path.join(dir, "logs"), defaultTimezone: "UTC", staggerWindowS: 0,
    logger: { info() {}, warn: (m) => { warnings.push(m); }, error: (m) => { warnings.push(m); } }, onEvent: (e) => events.push(e),
    ...o.over, ...over,
  });
  const h: Harness = {
    dir, clock, store, engine, events, warnings, agents, make, sched: make(),
    async advance(ms, step = HOUR) { for (let left = ms; left > 0; left -= step) { await clock.advance(Math.min(step, left)); await h.sched.idle(); } },
    captures(agentId, n) { for (let i = 0; i < n; i++) h.sched.recordCapture(agentId, 1); },
  };
  return h;
}
