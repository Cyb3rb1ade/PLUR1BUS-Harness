import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  REAL, cli, coreChild, corePid, daemonStatus, home, homePids, killPid, reapHome, restartSupervisor, sleep, startDaemon, stopDaemon, supervisorPid, waitFor,
} from "./helpers.ts";

/** S16: 200 turns in the PR system job, 1 000 in the nightly (same file). */
const N = Number(process.env.PLUR1BUS_SOAK_TURNS ?? 200);
/**
 * Ruling H3-R19: criterion 2 is durability under kills, not recall latency. Facts go round-robin to one agent per
 * 100 turns (PR: 2 agents, nightly: 10), so no agent's LanceDB table grows large: at the engine pin every capture
 * adds a fragment and nothing compacts them outside consolidate-daily, so add and recall slow down with every card
 * (an engine follow-up; the per-third percentiles below keep it visible).
 */
const AGENTS = Number(process.env.PLUR1BUS_SOAK_AGENTS ?? Math.max(1, Math.ceil(N / 100)));
const SEED = ((raw) => {
  if (raw === undefined) return Date.now() >>> 0;
  if (!/^\d+$/.test(raw)) throw new Error(`PLUR1BUS_SOAK_SEED must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return Number(raw) >>> 0;
})(process.env.PLUR1BUS_SOAK_SEED);
/** H3-R19: per `memory add`. */
const ADD_BUDGET_MS = 5000;
/** Per `memory recall` (criterion 2); the core's own hard recall budget (600 ms) bounds it. */
const RECALL_BUDGET_MS = 1000;
/** S16: the core is SIGKILLed at random with p = 1/20 per turn. */
const KILL_P = 1 / 20;
/**
 * The supervisor's time-scale seam (PLUR1BUS_SUPERVISOR_TIME_SCALE, test internals only). 0.1 turns the restart
 * backoff into 0.1 s … 6 s and the give-up window into 60 s, and keeps the ready timeout (6 s) and the hang
 * threshold (3 s) well above a flat-embedder core's start and a recall.
 */
const TIME_SCALE = 0.1;
/**
 * Ruling H3-R20: the supervisor gives up after five exits within a trailing 10 min × scale window, counted per
 * supervisor process (spec §6.4, Task 4 `Backoff`). S16's random kill rate would reach that at any usable scale, so a
 * random kill that would be the fifth in the window (plus a margin for the supervisor's own clock) is skipped and
 * counted as throttled, and the soak asserts that the supervisor never gives up. The rule itself is pinned by the
 * second test in this file.
 */
const GIVE_UP_WINDOW_MS = 600_000 * TIME_SCALE * 1.2;
const GIVE_UP_EXITS = 5;
/** Random core kills pause this many turns before each supervisor kill, so that phase starts from a ready core. */
const QUIET_TURNS = 3;
/** How long a core may take to be ready (journal replay included) before a supervisor-kill phase. */
const READY_BUDGET_MS = 60_000;
/**
 * Journal drain budget after the last turn: 2 s (supervisor restart, core start) + 1 s per line still journaled, plus
 * any restart backoff or supervisor restart still pending then. A replayed line is one engine capture, and captures
 * slow down as the agents' tables grow (see the add p50/p95 per third). Measured in the Task 12 fix-round runs, from
 * the last turn to "no journal line left and the core ready": 36 lines in 13.1 s, 29 in 12.4 s, 33 in 8.0 s, i.e.
 * 240–430 ms per line with the core start included (the reviewer measured about 310 ms per line). End-of-run captures
 * reach p95 800–900 ms, so 1 s per line keeps the budget above the slowest replays seen, not only the average.
 */
const DRAIN_BASE_MS = 2000;
const DRAIN_PER_LINE_MS = 1000;

/** mulberry32: a tiny seeded PRNG, so a failing run can be replayed with PLUR1BUS_SOAK_SEED. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const agentOf = (i: number): string => `soak-${i % AGENTS}`;
const factText = (i: number): string => `Please remember soak fact ${i}.`;

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;
}

/** p50/p95 of each third of the run (start, middle, end). */
function thirds(ms: number[]): string {
  const n = ms.length;
  const cut = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n];
  return ["start", "middle", "end"].map((name, k) => {
    const part = ms.slice(cut[k], cut[k + 1]);
    return `${name} p50 ${percentile(part, 50).toFixed(0)} p95 ${percentile(part, 95).toFixed(0)}`;
  }).join(", ") + ` (max ${Math.max(...ms).toFixed(0)}) ms`;
}

/** Every live card of `agent`: `memory list --since 0 --until <u> --limit 100` pages back by createdAt (the flat
 *  embedder gives every text the same vector, so `--topic` cannot single out one fact). Returned as a list, so that a
 *  duplicate card stays visible. */
function allCards(h: string, agent: string): any[] {
  const cards = new Map<string, any>();
  let until = Date.now() + 60_000;
  for (;;) {
    const page = cli(h, ["memory", "list", "--agent", agent, "--since", "0", "--until", String(until), "--limit", "100"]);
    let fresh = 0;
    for (const c of page.items) if (!cards.has(c.id)) { cards.set(c.id, c); fresh++; }
    if (!page.truncated) return [...cards.values()];
    const oldest = Math.min(...page.items.map((c: any) => c.createdAt));
    // The page boundary is inclusive, so the next page repeats `oldest`; step past it only if nothing new came back.
    until = fresh === 0 ? oldest - 1 : oldest;
  }
}

/** Complete lines in every journal file of `h`, including a replay in progress (`*.jsonl.replaying-*`). */
function journalLines(h: string): number {
  const dir = join(h, "state", "journal");
  let n = 0;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return 0; }
  for (const f of entries.filter((e) => /\.jsonl(\.replaying-\d+)?$/.test(e))) {
    try { n += readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim() !== "").length; } catch { /* renamed or removed meanwhile */ }
  }
  return n;
}

/** A `1staid check --json` document (it exits 1 when a check fails). */
function firstAid(h: string): any {
  const r = cli(h, ["1staid", "check"], { allowFail: true });
  return typeof r.exit === "number" ? JSON.parse(r.stdout) : r;
}

/** The soak's `logs.keep`: high enough that its core logs never rotate out (checked, see coreLogRecords). */
const LOGS_KEEP = 20;

/** Every JSON line of `logs/core.log` and its rotated files (`core.log.1` …), unparseable lines skipped; null when
 *  the set may be incomplete (the oldest slot `core.log.<LOGS_KEEP>` exists, so older lines may have been dropped). */
function coreLogRecords(h: string): any[] | null {
  const dir = join(h, "logs");
  const files = readdirSync(dir).filter((f) => /^core\.log(\.\d+)?$/.test(f));
  if (files.includes(`core.log.${LOGS_KEEP}`)) return null;
  const out: any[] = [];
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn by a SIGKILL */ }
    }
  }
  return out;
}

/**
 * Ruling H3-R24: the one duplicate the soak tolerates. A journal line whose replayed capture stored the turn, but whose
 * core was SIGKILLed before the engine's turn guard recorded it, is replayed again at the next start and stored twice:
 * the guard records late (engine PR E4.1). A SIGKILL qualifies for a line when the killed core (by pid) logged
 * `journal: replay start` for that line id before the kill and never logged `journal: replayed` for it (core.log is
 * written with synchronous fd writes, so what the core logged before the kill is on disk). Returns the qualifying
 * kills; each can add at most one extra copy.
 */
function killsDuringReplay(records: any[], kills: Array<{ at: number; pid: number }>, lineId: string): Array<{ at: number; pid: number; startAt: number }> {
  const mine = records.filter((r) => r.id === lineId && typeof r.pid === "number");
  const out: Array<{ at: number; pid: number; startAt: number }> = [];
  for (const k of kills) {
    const start = mine.find((r) => r.msg === "journal: replay start" && r.pid === k.pid && Date.parse(r.at) <= k.at);
    if (!start) continue;
    if (mine.some((r) => r.msg === "journal: replayed" && r.pid === k.pid)) continue;
    out.push({ at: k.at, pid: k.pid, startAt: Date.parse(start.at) });
  }
  return out;
}

const readyChild = (h: string): any => { const c = coreChild(h); return c?.process?.state === "ready" && c; };

// POSIX signals; the system job is Linux/macOS only.
describe("M1b-2a-H3 acceptance 2 — kill soak", { skip: (process.platform === "win32" && "POSIX signals") || (REAL && "flat embedder only") }, () => {
  it("criterion 2: kill soak", async (t) => {
    t.diagnostic(`turns ${N} over ${AGENTS} agent(s), seed ${SEED} (PLUR1BUS_SOAK_SEED=${SEED} replays the kill schedule only; timing, outages and replays differ), supervisor time scale ${TIME_SCALE}`);
    const rand = mulberry32(SEED);
    const h = home();
    const env = { PLUR1BUS_SUPERVISOR_TIME_SCALE: String(TIME_SCALE) };
    const t0 = performance.now();
    const addMs: number[] = [];
    const recallMs: number[] = [];
    const counts = { adoptions: 0, respawns: 0, stored: 0, journaled: 0, replayedTwice: 0, coreKills: 0, throttledKills: 0, unavailableRecalls: 0, engineDegradedRecalls: 0 };
    /** Fact index → how its add was answered. */
    const kept = new Map<number, "stored" | "journaled">();
    /** H3-R24: fact index → its journal line (id from `memory add --json`, when it was journaled). */
    const journalLine = new Map<number, { id: string; at: number }>();
    /** H3-R24: every core the soak SIGKILLed: when, and its pid. */
    const sigkills: Array<{ at: number; pid: number }> = [];
    let outageObserved = false;
    try {
      for (let a = 0; a < AGENTS; a++) cli(h, ["agent", "create", `soak-${a}`]);
      // The flat embedder gives every text the same vector; above 1 the duplicate check never matches.
      cli(h, ["config", "set", "engine.duplicateThreshold", "1.01", "--yes"]);
      cli(h, ["config", "set", "supervisor.graceMs", "3000", "--yes"]);
      cli(h, ["config", "set", "supervisor.healthIntervalMs", "1000", "--yes"]);
      cli(h, ["config", "set", "logs.keep", String(LOGS_KEEP), "--yes"]); // H3-R24 reads every core log line
      startDaemon(h, env);

      /** The OS service manager's pending restart of a SIGKILLed supervisor (performance.now() deadline). */
      let restartAt: number | null = null;
      /** Core exits this test caused during the current supervisor's lifetime (its give-up window counts only its own).
       *  Only the test's own kills are counted: the throttle assumes the supervisor sees no other exit, which the
       *  never-gives-up assertion below would expose if it were wrong. */
      let kills: number[] = [];
      /** The supervisor-kill phase whose restart is pending: its core pid, and whether that core must be adopted. */
      let phase: { core: number; adopt: boolean } | null = null;
      /** ms spent waiting for a pending supervisor restart after the last turn (added to the drain budget). */
      let restartWaitMs = 0;
      const restartDue = async (): Promise<void> => {
        if (restartAt === null) return;
        const wait = Math.max(0, restartAt - performance.now());
        await sleep(wait);
        restartWaitMs = wait;
        await restartSupervisor(h, env);
        restartAt = null;
        kills = [];
        const p = phase!;
        phase = null;
        if (p.adopt) {
          // < grace: the running core is adopted, not respawned.
          const c = await waitFor("the core to be adopted", () => { const c = coreChild(h); return c?.adopted === true && c; }, 10_000);
          assert.equal(c.pid, p.core, `the adopted core is the same process: ${JSON.stringify(c)}`);
          counts.adoptions++;
        } else {
          // > grace: the orphaned core stopped on its own, and the new supervisor spawns a new one.
          const c = await waitFor("a new core process", () => { const c = coreChild(h); return c?.pid != null && c; }, 10_000);
          assert.notEqual(c.pid, p.core, `a new core after the grace: ${JSON.stringify(c)}`);
          assert.equal(c.adopted, false, JSON.stringify(c));
          const logs = readdirSync(join(h, "logs")).filter((f) => /^core\.log(\.\d+)?$/.test(f));
          assert.ok(logs.some((f) => readFileSync(join(h, "logs", f), "utf8").includes("orphan grace expired")), `core.log records the grace expiry (${logs.join(", ")})`);
          counts.respawns++;
        }
      };
      const killSupervisor = async (afterMs: number, adopt: boolean): Promise<void> => {
        await restartDue();
        const ready = await waitFor("a ready core before the supervisor kill", () => readyChild(h), READY_BUDGET_MS);
        await killPid(supervisorPid(h)!, "SIGKILL");
        restartAt = performance.now() + afterMs;
        phase = { core: ready.pid, adopt };
      };
      const timed = (args: string[], into: number[], budgetMs: number): any => {
        const s = performance.now();
        const out = cli(h, args);
        const ms = performance.now() - s;
        into.push(ms);
        assert.ok(ms < budgetMs, `${args.join(" ")} took ${ms.toFixed(0)} ms (budget ${budgetMs} ms)`);
        return out;
      };

      for (let i = 0; i < N; i++) {
        if (restartAt !== null && performance.now() >= restartAt) await restartDue();
        const phaseTurns = [Math.floor(N / 3), Math.floor((2 * N) / 3)];
        if (i === phaseTurns[0]) await killSupervisor(1000, true); // < grace: the core is adopted
        if (i === phaseTurns[1]) await killSupervisor(5000, false); // > grace: the core stops, a new one is spawned
        const quiet = phaseTurns.some((p) => i >= p - QUIET_TURNS && i < p);

        let killedThisTurn = false;
        // rand() is drawn on every turn, so a seed keeps the same schedule whatever is skipped.
        if (rand() < KILL_P && restartAt === null && !quiet) {
          const now = performance.now();
          kills = kills.filter((k) => now - k < GIVE_UP_WINDOW_MS);
          const pid = corePid(h);
          if (pid !== null && kills.length >= GIVE_UP_EXITS - 1) counts.throttledKills++;
          else if (pid !== null) {
            sigkills.push({ at: Date.now(), pid });
            await killPid(pid, "SIGKILL");
            kills.push(performance.now());
            counts.coreKills++;
            killedThisTurn = true;
            if (!outageObserved) {
              // One outage, seen from both sides: the supervisor's status and 1staid check.
              const child = await waitFor("the supervisor to see the core exit", () => {
                const c = coreChild(h);
                return (c?.process?.state !== "ready" || c?.pid !== pid) && c;
              }, 2000, 10);
              const coreState = firstAid(h).checks.find((c: any) => c.id === "core.state");
              const restarting = child.process.state === "crashed" && child.nextRestartAt !== null;
              if (["crashed", "starting"].includes(child.process.state) && coreState?.status !== "ok") {
                outageObserved = true;
                t.diagnostic(`outage at turn ${i}: daemon status ${child.process.state}${restarting ? " (restarting)" : ""}, 1staid core.state ${coreState.status}: ${coreState.summary}`);
              }
            }
          }
        }

        const agent = agentOf(i);
        const add = timed(["memory", "add", "--agent", agent, "--session", "soak", factText(i)], addMs, ADD_BUDGET_MS);
        if (add.journaled === true) {
          assert.equal(add.degraded?.reason, "core-unavailable", JSON.stringify(add));
          assert.ok(add.degraded.detail, `a journaled add names why: ${JSON.stringify(add)}`);
          kept.set(i, "journaled");
          if (typeof add.id === "string") journalLine.set(i, { id: add.id, at: Date.now() });
          counts.journaled++;
        } else {
          assert.equal(add.stored, 1, `turn ${i}: ${JSON.stringify(add)}`);
          kept.set(i, "stored");
          counts.stored++;
        }
        const recall = timed(["memory", "recall", "--agent", agent, `soak fact ${i}`], recallMs, RECALL_BUDGET_MS);
        if (recall.degraded?.reason === "core-unavailable") {
          counts.unavailableRecalls++;
          assert.ok(recall.degraded.detail, `a degraded recall names why: ${JSON.stringify(recall.degraded)}`);
        } else if (recall.degraded !== null) {
          // H3-R19: the core answered, but the engine did not finish inside the recall's hard budget: accepted, counted.
          assert.ok(["aborted", "timeout"].includes(recall.degraded.reason), `turn ${i}: ${JSON.stringify(recall.degraded)}`);
          counts.engineDegradedRecalls++;
        }
        if (killedThisTurn) {
          // Every outage is visible: the turn right after a kill runs with the core down.
          assert.equal(add.journaled, true, `turn ${i} after a core kill: ${JSON.stringify(add)}`);
          assert.equal(recall.degraded?.reason, "core-unavailable", `turn ${i} after a core kill: ${JSON.stringify(recall.degraded)}`);
        }
        const child = restartAt === null ? coreChild(h) : null;
        assert.ok(!(child?.process?.state === "crashed" && child.nextRestartAt === null), `turn ${i}: the supervisor gave up: ${JSON.stringify(child)}`);
      }
      const lastTurnAt = performance.now();
      const backlogAtEnd = journalLines(h);
      // A core killed in the last turns may still be in its restart backoff (up to 60 s × scale): that wait is the
      // supervisor's, not the replay's, so it is added to both budgets below as reported.
      const endChild = restartAt === null ? coreChild(h) : null;
      const backoffMs = endChild?.nextRestartAt ? Math.max(0, endChild.nextRestartAt - Date.now()) : 0;
      await restartDue();
      assert.ok(outageObserved, "one outage was seen in daemon status and 1staid check");
      assert.ok(counts.coreKills > 0 || N < 20, `no core kill in ${N} turns (seed ${SEED})`);

      assert.equal(counts.adoptions, 1, "the 1 s supervisor outage ended in an adoption");
      assert.equal(counts.respawns, 1, "the 5 s supervisor outage ended in a new core");
      // The journal drains within a budget sized to what was still journaled after the last turn.
      const drainBudgetMs = DRAIN_BASE_MS + DRAIN_PER_LINE_MS * backlogAtEnd + restartWaitMs + backoffMs;
      // Drained: no line left in any journal file (a replay in progress renames `<agent>.jsonl` to
      // `<agent>.jsonl.replaying-<pid>`, which `1staid check` counts too), the core ready (it is ready only once its
      // replay is done), and `1staid check` agrees.
      await waitFor(`the journal to drain (${backlogAtEnd} line(s))`,
        () => journalLines(h) === 0 && readyChild(h) && firstAid(h).checks.find((c: any) => c.id === "journal.backlog")?.status === "ok",
        Math.max(0, drainBudgetMs - (performance.now() - lastTurnAt)), 100);
      const drainMs = performance.now() - lastTurnAt;
      t.diagnostic(`journal drained ${drainMs.toFixed(0)} ms after the last turn: ${backlogAtEnd} line(s) backlogged, budget ${drainBudgetMs.toFixed(0)} ms (restart backoff ${backoffMs.toFixed(0)} ms, supervisor restart ${restartWaitMs.toFixed(0)} ms)`);
      const ready = readyChild(h);
      assert.ok(ready, "the core is ready");

      // No journal line is lost and none is replayed twice: every stored or journaled fact is exactly one live card.
      const seen = new Map<string, number>();
      for (let a = 0; a < AGENTS; a++) for (const c of allCards(h, `soak-${a}`)) seen.set(`${a}:${c.text}`, (seen.get(`${a}:${c.text}`) ?? 0) + 1);
      const facts = [...kept.keys()].map((i) => ({ i, how: kept.get(i)!, n: seen.get(`${i % AGENTS}:${factText(i)}`) ?? 0 }));
      const lost = facts.filter((f) => f.n === 0);
      assert.deepEqual(lost, [], `facts lost: ${JSON.stringify(lost)}`);
      const storedTwice = facts.filter((f) => f.how === "stored" && f.n !== 1);
      assert.deepEqual(storedTwice, [], `stored facts not present exactly once: ${JSON.stringify(storedTwice)}`);
      const unknown = [...seen.keys()].filter((k) => !facts.some((f) => `${f.i % AGENTS}:${factText(f.i)}` === k));
      assert.deepEqual(unknown, [], "no card the soak did not write");
      // A core killed while it replays the journal replays the same lines again at its next start: the at-least-once
      // gap ADR-012 §7 names. The engine's vector dedup cannot absorb it here (duplicateThreshold 1.01); the turn
      // guard does (Task 15, E4 Q3): replay passes `journal:<line id>` as runId, the same at every start, and the
      // engine answers a turn it already captured with duplicate-turn, which removes the line.
      const replayedTwice = facts.filter((f) => f.how === "journaled" && f.n !== 1);
      counts.replayedTwice = replayedTwice.length;
      const third = (i: number): number => Math.min(2, Math.floor((3 * i) / N));
      const perThird = [0, 1, 2].map((k) => ({
        journaled: facts.filter((f) => f.how === "journaled" && third(f.i) === k).length,
        twice: replayedTwice.filter((f) => third(f.i) === k).length,
      }));
      t.diagnostic(`journaled facts replayed more than once, per third: ${perThird.map((x, k) => `${["first", "middle", "last"][k]} ${x.twice}/${x.journaled}`).join(", ")}`);
      // H3-R24: tolerated only for a core SIGKILLed while that line was being replayed (engine PR E4.1: the guard
      // records late); reported with the line id. Every other duplicate fails.
      // At most one extra copy per qualifying kill; with an incomplete log set nothing is tolerated.
      const records = replayedTwice.length > 0 ? coreLogRecords(h) : [];
      if (records === null) t.diagnostic(`core logs rotated past logs.keep ${LOGS_KEEP}: no duplicate is tolerated`);
      const untolerated = replayedTwice.filter((f) => {
        const line = journalLine.get(f.i);
        const qualifying = line && records ? killsDuringReplay(records, sigkills, line.id) : [];
        const ok = f.n >= 2 && f.n - 1 <= qualifying.length;
        if (ok) {
          const ev = qualifying.map((k) => `pid ${k.pid} logged replay start at ${new Date(k.startAt).toISOString()}, SIGKILLed at ${new Date(k.at).toISOString()}, no replayed`).join("; ");
          t.diagnostic(`todo (engine PR E4.1): fact ${f.i} stored ${f.n}x, journal line ${line!.id}: ${ev}`);
        }
        return !ok;
      });
      assert.deepEqual(untolerated, [], `journaled facts not present exactly once: ${JSON.stringify(untolerated.map((f) => ({ ...f, line: journalLine.get(f.i)?.id ?? null })))}`);

      // Exactly one supervisor and one core remain, and only the core holds LanceDB files.
      const status = daemonStatus(h);
      assert.equal(status.supervisor.children.length, 1, JSON.stringify(status));
      const pids = homePids(h).sort();
      assert.deepEqual(pids, [status.supervisor.supervisor.pid, ready.pid].sort(), `pgrep -f -- "--home ${h}"`);
      if (process.platform === "linux") {
        const lancedb = `${realpathSync(h)}/state/lancedb`;
        const owners = pids.filter((pid) => readdirSync(`/proc/${pid}/fd`).some((fd) => {
          try { return readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith(lancedb); } catch { return false; }
        }));
        assert.ok(owners.every((pid) => pid === ready.pid), `LanceDB fds held by ${owners.join(", ")}; core is ${ready.pid}`);
      }

      stopDaemon(h);
      t.diagnostic(`${N} turns in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${JSON.stringify(counts)}`);
      t.diagnostic(`memory add: ${thirds(addMs)}`);
      t.diagnostic(`memory recall: ${thirds(recallMs)}`);
    } finally {
      try { cli(h, ["daemon", "stop"], { allowFail: true }); } catch { /* best effort */ }
      await reapHome(h);
      rmSync(h, { recursive: true, force: true });
    }
  });

  it("S16: five core exits inside the give-up window make the supervisor give up, visible in daemon status", async (t) => {
    const h = home();
    const env = { PLUR1BUS_SUPERVISOR_TIME_SCALE: String(TIME_SCALE) }; // window 60 s; the five kills take a few seconds
    try {
      cli(h, ["agent", "create", "bernd"]);
      startDaemon(h, env);
      const t0 = performance.now();
      let last: number | null = null;
      for (let k = 1; k <= GIVE_UP_EXITS; k++) {
        // A new generation each time: right after a kill the supervisor may still report the dead pid as ready.
        const pid: number = (await waitFor(`a new core to be ready before kill ${k}`, () => { const c = readyChild(h); return c && c.pid !== last && c; }, 30_000, 20)).pid;
        await killPid(pid, "SIGKILL");
        last = pid;
      }
      const elapsed = performance.now() - t0;
      assert.ok(elapsed < 600_000 * TIME_SCALE, `the five kills took ${elapsed.toFixed(0)} ms, beyond the window`);
      const gaveUp = await waitFor("the supervisor to give up", () => {
        const c = coreChild(h);
        return c?.process?.state === "crashed" && c.nextRestartAt === null && c;
      }, 5000, 20);
      assert.equal(gaveUp.pid, null, JSON.stringify(gaveUp));
      assert.equal(gaveUp.lastExit?.signal, "SIGKILL", JSON.stringify(gaveUp));
      // Sticky: no restart is scheduled later either.
      await sleep(1000);
      const still = coreChild(h);
      assert.equal(still.process.state, "crashed", JSON.stringify(still));
      assert.equal(still.nextRestartAt, null, JSON.stringify(still));
      assert.equal(still.pid, null, JSON.stringify(still));
      // Only `daemon start` resets it (S9, spec §6.4).
      const started = startDaemon(h, env);
      const back = started.status?.children?.[0] ?? readyChild(h);
      assert.equal(back?.process?.state, "ready", JSON.stringify(started));
      t.diagnostic(`gave up after ${GIVE_UP_EXITS} kills in ${elapsed.toFixed(0)} ms; daemon start restarted core ${back.pid}`);
      stopDaemon(h);
    } finally {
      try { cli(h, ["daemon", "stop"], { allowFail: true }); } catch { /* best effort */ }
      await reapHome(h);
      rmSync(h, { recursive: true, force: true });
    }
  });
});
