import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import {
  REAL, cli, coreChild, corePid, daemonStatus, home, killPid, restartSupervisor, sleep, startDaemon, stopDaemon, supervisorPid, waitFor,
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
const SEED = Number(process.env.PLUR1BUS_SOAK_SEED ?? Date.now()) >>> 0;
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

/** A `1staid check --json` document (it exits 1 when a check fails). */
function firstAid(h: string): any {
  const r = cli(h, ["1staid", "check"], { allowFail: true });
  return typeof r.exit === "number" ? JSON.parse(r.stdout) : r;
}

const readyChild = (h: string): any => { const c = coreChild(h); return c?.process?.state === "ready" && c; };

// POSIX signals; the system job is Linux/macOS only.
describe("M1b-2a-H3 acceptance 2 — kill soak", { skip: (process.platform === "win32" && "POSIX signals") || (REAL && "flat embedder only") }, () => {
  it("criterion 2: kill soak", async (t) => {
    t.diagnostic(`turns ${N} over ${AGENTS} agent(s), seed ${SEED} (replay with PLUR1BUS_SOAK_SEED=${SEED}), supervisor time scale ${TIME_SCALE}`);
    const rand = mulberry32(SEED);
    const h = home();
    const env = { PLUR1BUS_SUPERVISOR_TIME_SCALE: String(TIME_SCALE) };
    const t0 = performance.now();
    const addMs: number[] = [];
    const recallMs: number[] = [];
    const counts = { stored: 0, journaled: 0, replayedTwice: 0, coreKills: 0, throttledKills: 0, unavailableRecalls: 0, engineDegradedRecalls: 0 };
    /** Fact index → how its add was answered. */
    const kept = new Map<number, "stored" | "journaled">();
    let outageObserved = false;
    try {
      for (let a = 0; a < AGENTS; a++) cli(h, ["agent", "create", `soak-${a}`]);
      // The flat embedder gives every text the same vector; above 1 the duplicate check never matches.
      cli(h, ["config", "set", "engine.duplicateThreshold", "1.01", "--yes"]);
      cli(h, ["config", "set", "supervisor.graceMs", "3000", "--yes"]);
      cli(h, ["config", "set", "supervisor.healthIntervalMs", "1000", "--yes"]);
      startDaemon(h, env);

      /** The OS service manager's pending restart of a SIGKILLed supervisor (performance.now() deadline). */
      let restartAt: number | null = null;
      /** Core exits this test caused during the current supervisor's lifetime (its give-up window counts only its own). */
      let kills: number[] = [];
      const restartDue = async (): Promise<void> => {
        if (restartAt === null) return;
        await sleep(Math.max(0, restartAt - performance.now()));
        await restartSupervisor(h, env);
        restartAt = null;
        kills = [];
      };
      const killSupervisor = async (afterMs: number): Promise<void> => {
        await restartDue();
        await killPid(supervisorPid(h)!, "SIGKILL");
        restartAt = performance.now() + afterMs;
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
        if (i === Math.floor(N / 3)) await killSupervisor(1000); // < grace: the core is adopted
        if (i === Math.floor((2 * N) / 3)) await killSupervisor(5000); // > grace: the core stops, a new one is spawned

        let killedThisTurn = false;
        if (rand() < KILL_P && restartAt === null) {
          const now = performance.now();
          kills = kills.filter((k) => now - k < GIVE_UP_WINDOW_MS);
          const pid = corePid(h);
          if (pid !== null && kills.length >= GIVE_UP_EXITS - 1) counts.throttledKills++;
          else if (pid !== null) {
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
      await restartDue();
      assert.ok(outageObserved, "one outage was seen in daemon status and 1staid check");
      assert.ok(counts.coreKills > 0 || N < 20, `no core kill in ${N} turns (seed ${SEED})`);

      const ready = await waitFor("the core to be ready", () => readyChild(h), 60_000);
      // The journal drains within 30 s.
      await waitFor("the journal to drain", () => firstAid(h).checks.find((c: any) => c.id === "journal.backlog")?.status === "ok", 30_000, 250);

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
      // gap ADR-012 §7 names, normally absorbed by the engine's vector dedup, which this soak switches off
      // (duplicateThreshold 1.01). Task 15 closes it (replay passes the line id as runId; the engine answers
      // duplicate-turn), and then this subtest must pass: remove its `todo` there.
      const replayedTwice = facts.filter((f) => f.how === "journaled" && f.n !== 1);
      counts.replayedTwice = replayedTwice.length;
      await t.test("journal replay leaves every journaled fact exactly once", { todo: "Task 15: replay runId + duplicate-turn (E4)" }, () => {
        assert.deepEqual(replayedTwice, [], `journaled facts replayed more than once: ${JSON.stringify(replayedTwice)}`);
      });

      // Exactly one supervisor and one core remain, and only the core holds LanceDB files.
      const status = daemonStatus(h);
      assert.equal(status.supervisor.children.length, 1, JSON.stringify(status));
      const pids = execFileSync("pgrep", ["-f", "--", `--home ${h}`], { encoding: "utf8" }).trim().split("\n").map(Number).sort();
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
      rmSync(h, { recursive: true, force: true });
    }
  });
});
