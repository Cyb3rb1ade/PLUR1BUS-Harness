// Fixtures for the dreaming scheduler tests: a virtual clock, a scriptable engine job registry, a temp-dir store.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FakeClock } from "../../src/discovery/testing.ts";
import { DreamScheduler, type SchedulerOptions } from "../../src/dreams/scheduler.ts";
import { DreamStore } from "../../src/dreams/store.ts";
import type { DreamEngine, DreamEvent, DreamJobRun, Phase } from "../../src/dreams/types.ts";
import { tempDir } from "./temp-dir.ts";

export const T0 = Date.parse("2026-10-06T00:00:00Z");
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

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

/** An engine whose job registry is scripted per job; records every call, and the peak number of jobs in flight. */
export class FakeEngine implements DreamEngine {
  readonly calls: { job: string; agentId: string; trigger?: string }[] = [];
  readonly behaviours = new Map<string, Behaviour>();
  inFlight = 0; peak = 0;
  onRun?: (job: string, agentId: string) => void;
  extraJobs: typeof JOBS = [];
  jobs: DreamEngine["jobs"] = {
    list: () => [...JOBS, ...this.extraJobs],
    run: async (job, agentId, opts) => {
      const n = this.calls.filter((c) => c.job === job).length + 1;
      this.calls.push({ job, agentId, ...(opts?.trigger !== undefined ? { trigger: opts.trigger } : {}) });
      this.inFlight++; this.peak = Math.max(this.peak, this.inFlight);
      try {
        this.onRun?.(job, agentId);
        const b = this.behaviours.get(job);
        const o = b ? await b(agentId, n) : {};
        return { runId: `eng-${job}-${n}`, job, outcome: "completed", cost: { ms: 1, inputTokens: 100, outputTokens: 50 }, ...o } as DreamJobRun;
      } finally { this.inFlight--; }
    },
  };
  callsOf(job: string): number { return this.calls.filter((c) => c.job === job).length; }
}

export interface Harness {
  dir: string; clock: FakeClock; store: DreamStore; engine: FakeEngine; sched: DreamScheduler; events: DreamEvent[]; agents: string[];
  warnings: string[]; make(over?: Partial<SchedulerOptions>): DreamScheduler;
  /** Advances virtual time hour by hour, letting every fired run finish before the next step. */
  advance(ms: number, step?: number): Promise<void>;
  captures(agentId: string, n: number): void;
}

export function mkHarness(o: { agents?: string[]; over?: Partial<SchedulerOptions>; engine?: FakeEngine; start?: number } = {}): Harness {
  const dir = tempDir("dreams-");
  const clock = new FakeClock(o.start ?? T0);
  const store = new DreamStore(path.join(dir, "dreams.db"));
  const engine = o.engine ?? new FakeEngine();
  const events: DreamEvent[] = []; const warnings: string[] = [];
  const agents = o.agents ?? ["bernd"];
  const make = (over: Partial<SchedulerOptions> = {}) => new DreamScheduler({
    store, engine, clock, agents: () => agents, logsDir: path.join(dir, "logs"), defaultTimezone: "UTC", staggerWindowS: 0,
    logger: { info() {}, warn: (m) => { warnings.push(m); }, error: (m) => { warnings.push(m); } }, onEvent: (e) => events.push(e),
    ...o.over, ...over,
  });
  const h: Harness = {
    dir, clock, store, engine, events, agents, warnings, make, sched: make(),
    async advance(ms, step = HOUR) { for (let left = ms; left > 0; left -= step) { await clock.advance(Math.min(step, left)); await h.sched.idle(); } },
    captures(agentId, n) { for (let i = 0; i < n; i++) h.sched.recordCapture(agentId, 1); },
  };
  return h;
}

export function writeDiary(dir: string, agentId: string, text: string): string {
  const p = path.join(dir, "workspace", agentId, "dreaming.md");
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}
