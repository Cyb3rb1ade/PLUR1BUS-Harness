// The registry's restart loop for a channel that keeps failing: the gap grows from the first step to the cap, never
// passes it, and stop() ends the loop. Time is the injected FakeClock; no test here sleeps or touches a real timer.
//
// Numbers, from the code (the registry in these tests runs with its default backoff, no `backoff` option):
//   - first gap 1000 ms, cap 60 000 ms: `DEFAULT_BACKOFF` in src/channels/backoff.ts:3, used by the registry
//     constructor default (src/channels/registry.ts:55).
//   - the gap before restart n (n = 0, 1, ...) is `min(maxMs, baseMs * 2^n)` (src/channels/backoff.ts:8), so
//     1000, 2000, 4000, 8000, 16 000, 32 000, then 64 000 clamped to 60 000 (the 7th gap), and 60 000 from there on.
//   - a manifest's `maxRestarts` defaults to 8 (src/channels/manifest.ts:21); one more crash then ends in "failed"
//     (src/channels/registry.ts:215).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelRegistry, ChannelRouter, DEFAULT_BACKOFF, type Channel, type ChannelHost, type ChannelHealth, type ChannelLogger, type OutboundMessage } from "../../src/channels/index.ts";
import { FakeClock, FakeIdentity, FakeSessions, silentLog } from "./helpers.ts";

const BASE_MS = 1000;
const CAP_MS = 60_000;
/** The expected gaps from the first restart on: doubling from BASE_MS, clamped to CAP_MS from the 7th gap. */
const SEQ = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000];
/** Failure-only guard: a real timer that only matters if a test hangs (the node:test runner cancels it on completion). */
const GUARD = { timeout: 30_000 };

const manifest = (o: Record<string, unknown> = {}) => ({ name: "lb", version: "0.1.0", kind: "channel", apiVersion: "1", ...o });

/** A FakeClock that also keeps every duration the registry asked for, so a test can see which timers were ever armed. */
class RecordingClock extends FakeClock {
  timerMs: number[] = [];
  override setTimer(fn: () => void, ms: number) {
    this.timerMs.push(ms);
    return super.setTimer(fn, ms);
  }
}

/** A logger that keeps what the registry reports, to read the "gave up" and "crashed" events back. */
function recordingLog() {
  const log: { event: string; fields: Record<string, unknown> }[] = [];
  const rec: ChannelLogger = {
    info: (event, fields = {}) => { log.push({ event, fields }); },
    warn: (event, fields = {}) => { log.push({ event, fields }); },
    error: (event, fields = {}) => { log.push({ event, fields }); },
  };
  return { log, rec };
}

function setup(log: ChannelLogger = silentLog) {
  const clock = new RecordingClock();
  const router = new ChannelRouter({ identity: new FakeIdentity(), sessions: new FakeSessions(), clock, log: silentLog });
  const registry = new ChannelRegistry({ clock, router, log }); // default backoff, default timeouts
  return { clock, registry };
}

/**
 * - "in-start": `start` reports host.fail (`failCalls` times) and still resolves, i.e. the start itself succeeds.
 * - "after-start": `start` succeeds and the channel runs; the test calls host.fail on the running channel with `crash()`.
 * - "reject": `start` rejects outright.
 * Every start is stamped with the injected clock, so the gaps are read off the fake time axis.
 */
type Mode = "in-start" | "after-start" | "reject";
class FailingChannel implements Channel {
  readonly name = "lb";
  readonly startedAt: number[] = [];
  stops = 0;
  host?: ChannelHost;
  readonly #clock: FakeClock;
  readonly #mode: Mode;
  readonly #failCalls: number;
  constructor(clock: FakeClock, mode: Mode, failCalls = 1) { this.#clock = clock; this.#mode = mode; this.#failCalls = failCalls; }
  async start(host: ChannelHost) {
    this.startedAt.push(this.#clock.now());
    this.host = host;
    if (this.#mode === "reject") return Promise.reject(new Error("start rejected"));
    if (this.#mode === "in-start") for (let i = 0; i < this.#failCalls; i++) host.fail(new Error("socket died"));
  }
  /** Make a started channel report its failure ("after-start" only; the other modes have already done so). */
  crash(registry: ChannelRegistry): void {
    if (this.#mode !== "after-start") return;
    assert.equal(registry.status("lb")?.state, "running", "the channel must be running before it reports the failure");
    this.host!.fail(new Error("socket died"));
  }
  async stop() { this.stops++; }
  async health(): Promise<ChannelHealth> { return { ok: true }; }
  async send(_m: OutboundMessage) {}
}

const gapsOf = (ts: number[]) => ts.slice(1).map((t, i) => t - ts[i]!);

/** Walk the expected gaps one by one: not a start one ms early, one start exactly on the gap's end. */
async function stepThrough(registry: ChannelRegistry, clock: FakeClock, ch: FailingChannel, gaps: number[], error: RegExp) {
  for (const [i, gap] of gaps.entries()) {
    ch.crash(registry);
    const st = registry.status("lb");
    assert.equal(st?.state, "backoff", `after failure ${i + 1} the channel waits in backoff`);
    assert.equal(st?.attempts, i + 1, `failure ${i + 1} is exactly one backoff step`);
    assert.match(st?.lastError ?? "", error);
    await clock.advance(gap - 1);
    assert.equal(ch.startedAt.length, i + 1, `no restart ${i + 1} one ms before its gap of ${gap} ms is over`);
    await clock.advance(1);
    assert.equal(ch.startedAt.length, i + 2, `restart ${i + 1} happens exactly when its gap of ${gap} ms is over`);
  }
}

test("pin: the default policy is 1000 ms first gap and a 60 000 ms cap (the numbers the tests below rely on)", GUARD, () => {
  assert.deepEqual(DEFAULT_BACKOFF, { baseMs: BASE_MS, maxMs: CAP_MS });
  assert.equal(SEQ[0], BASE_MS);
  assert.equal(SEQ.at(-1), CAP_MS);
  assert.equal(BASE_MS * 2 ** 6, 64_000, "the 7th gap would be 64 000 ms uncapped, so it is the first one the cap clamps");
});

for (const mode of ["in-start", "after-start"] as const) {
  test(`a channel that reports host.fail after every start (${mode}) is restarted with gaps growing from 1000 ms to the 60 000 ms cap`, GUARD, async () => {
    const { registry, clock } = setup();
    const ch = new FailingChannel(clock, mode);
    registry.register({ manifest: manifest(), factory: () => ch }); // maxRestarts: the manifest default of 8
    registry.start("lb");
    await clock.advance(0);
    assert.equal(ch.startedAt.length, 1);

    await stepThrough(registry, clock, ch, SEQ.slice(0, 8), /socket died/);

    const gaps = gapsOf(ch.startedAt);
    assert.deepEqual(gaps, SEQ.slice(0, 8), "gaps read off the start timestamps of the fake clock");
    assert.equal(gaps[0], BASE_MS, "the first gap is the base");
    for (let i = 1; i < 6; i++) assert.equal(gaps[i], gaps[i - 1]! * 2, `gap ${i + 1} doubles gap ${i}`);
    assert.equal(gaps[6], CAP_MS, "the 7th gap is clamped from 64 000 to the cap");
    assert.equal(gaps[7], CAP_MS, "and stays there");
    assert.ok(ch.stops >= 8, "every failed run was stopped before the restart");
  });
}

test("repeated host.fail calls within one run are one backoff step, not one per call", GUARD, async () => {
  const { registry, clock } = setup();
  const ch = new FailingChannel(clock, "in-start", 3);
  registry.register({ manifest: manifest(), factory: () => ch });
  registry.start("lb");
  await clock.advance(0);
  await stepThrough(registry, clock, ch, SEQ.slice(0, 4), /socket died/);
  assert.deepEqual(gapsOf(ch.startedAt), SEQ.slice(0, 4));
});

test("the gaps never exceed the cap, however many restarts run", GUARD, async () => {
  const { registry, clock } = setup();
  const ch = new FailingChannel(clock, "in-start");
  const RESTARTS = 20;
  registry.register({ manifest: manifest({ maxRestarts: 40 }), factory: () => ch });
  registry.start("lb");
  await clock.advance(0);
  // One fake second per step (the smallest gap is 1000 ms, so a step never holds two starts); the bound is the loop guard.
  for (let step = 0; step < 5000 && ch.startedAt.length < RESTARTS + 1; step++) await clock.advance(1000);
  assert.ok(ch.startedAt.length >= RESTARTS + 1, `reached ${RESTARTS} restarts`);

  const gaps = gapsOf(ch.startedAt);
  assert.ok(gaps.length >= RESTARTS);
  assert.ok(gaps.every((g) => g <= CAP_MS), `no gap above ${CAP_MS}: ${JSON.stringify(gaps)}`);
  assert.equal(Math.max(...gaps), CAP_MS, "the cap is reached");
  assert.deepEqual(gaps.slice(0, 6), SEQ.slice(0, 6), "strict doubling up to the cap");
  assert.ok(gaps.slice(6).every((g) => g === CAP_MS), "from the 7th gap on, every gap is exactly the cap");
  assert.ok(gaps.every((g, i) => i === 0 || g >= gaps[i - 1]!), "a gap is never shorter than the one before it");
  assert.ok(clock.timerMs.every((ms) => ms <= CAP_MS), "the registry never armed a timer longer than the cap");
  assert.equal(registry.status("lb")?.state, "backoff", "still restarting: maxRestarts (40) is far away");
});

test("after maxRestarts (default 8) the restart loop ends in failed: no further start, no timer left", GUARD, async () => {
  const { log, rec } = recordingLog();
  const { registry, clock } = setup(rec);
  const ch = new FailingChannel(clock, "in-start");
  registry.register({ manifest: manifest(), factory: () => ch });
  registry.start("lb");
  await clock.advance(0);
  await stepThrough(registry, clock, ch, SEQ.slice(0, 8), /socket died/);
  assert.equal(ch.startedAt.length, 9, "the first start plus maxRestarts (8) restarts");
  // The 9th start reported host.fail within start; attempts has reached maxRestarts, so this crash gives up.
  const st = registry.status("lb");
  assert.equal(st?.state, "failed");
  assert.equal(st?.attempts, 8);
  assert.equal(clock.pending(), 0, "nothing is armed once the channel has failed");
  await clock.advance(10 * CAP_MS);
  assert.equal(ch.startedAt.length, 9, "no start after giving up");
  assert.equal(registry.status("lb")?.state, "failed");
  assert.deepEqual(log.filter((l) => l.event === "channel.gave-up").map((l) => l.fields), [{ channel: "lb", attempts: 8 }]);
});

test("stop() on a running channel ends the loop: a late host.fail of the stopped run restarts nothing", GUARD, async () => {
  const { registry, clock } = setup();
  const ch = new FailingChannel(clock, "after-start");
  registry.register({ manifest: manifest(), factory: () => ch });
  registry.start("lb");
  await clock.advance(0);
  assert.equal(registry.status("lb")?.state, "running");
  const oldHost = ch.host!;

  await registry.stop("lb");
  assert.equal(registry.status("lb")?.state, "stopped");
  assert.equal(clock.pending(), 0, "stop() leaves no timer armed");
  oldHost.fail(new Error("late failure of the stopped run"));
  await clock.advance(10 * CAP_MS);
  assert.equal(ch.startedAt.length, 1, "no start after stop");
  assert.equal(registry.status("lb")?.state, "stopped");
  assert.equal(clock.pending(), 0);
});

test("a failure reported by the old run after stop() and a fresh start() is ignored; the new run is still restarted on its own failure", GUARD, async () => {
  const { registry, clock } = setup();
  const ch = new FailingChannel(clock, "after-start");
  registry.register({ manifest: manifest(), factory: () => ch });
  registry.start("lb");
  await clock.advance(0);
  const oldHost = ch.host!;
  await registry.stop("lb");
  registry.start("lb");
  await clock.advance(0);
  assert.equal(registry.status("lb")?.state, "running");
  assert.equal(ch.startedAt.length, 2);
  assert.notEqual(ch.host, oldHost);
  const stopsBefore = ch.stops;

  oldHost.fail(new Error("late failure of the old run"));
  await clock.advance(CAP_MS);
  assert.equal(registry.status("lb")?.state, "running", "the old run cannot take the new one down");
  assert.equal(ch.startedAt.length, 2);
  assert.equal(ch.stops, stopsBefore);

  ch.crash(registry); // the current run does count, and starts at the first gap
  await clock.advance(BASE_MS - 1);
  assert.equal(ch.startedAt.length, 2);
  await clock.advance(1);
  assert.equal(ch.startedAt.length, 3);
});

test("stop() right after a failure, before its restart timer has run, ends the loop", GUARD, async () => {
  const { registry, clock } = setup();
  const ch = new FailingChannel(clock, "after-start");
  registry.register({ manifest: manifest({ maxRestarts: 40 }), factory: () => ch });
  registry.start("lb");
  await clock.advance(0);
  for (const gap of SEQ.slice(0, 3)) { ch.crash(registry); await clock.advance(gap); }
  assert.equal(ch.startedAt.length, 4);

  ch.crash(registry); // arms the next gap (8000 ms) synchronously ...
  assert.equal(registry.status("lb")?.state, "backoff");
  assert.ok(clock.pending() > 0);
  await registry.stop("lb"); // ... and stop() comes in the same tick
  assert.equal(registry.status("lb")?.state, "stopped");
  assert.equal(clock.pending(), 0);
  await clock.advance(10 * CAP_MS);
  assert.equal(ch.startedAt.length, 4, "the armed restart never fires");
  assert.equal(registry.status("lb")?.state, "stopped");
});

// Waiting in the first gap, in a mid-sequence gap and in a gap at the cap (restarts done before the stop: 0, 3, 8).
for (const restarts of [0, 3, 8]) {
  test(`stop() while the registry waits in a gap (after ${restarts} restarts, gap ${SEQ[restarts]} ms) ends the loop`, GUARD, async () => {
    const { registry, clock } = setup();
    const ch = new FailingChannel(clock, "in-start");
    registry.register({ manifest: manifest({ maxRestarts: 40 }), factory: () => ch });
    registry.start("lb");
    await clock.advance(0);
    for (const gap of SEQ.slice(0, restarts)) await clock.advance(gap);
    assert.equal(ch.startedAt.length, restarts + 1);
    const gap = SEQ[restarts]!;

    await clock.advance(gap / 2); // in the middle of the gap
    assert.equal(registry.status("lb")?.state, "backoff");
    assert.equal(ch.startedAt.length, restarts + 1);
    assert.ok(clock.pending() > 0, "the restart timer is armed");

    await registry.stop("lb");
    assert.equal(registry.status("lb")?.state, "stopped");
    assert.equal(clock.pending(), 0, "stop() cancelled the restart timer");
    await clock.advance(gap); // well past the moment the timer would have fired
    await clock.advance(10 * CAP_MS);
    assert.equal(ch.startedAt.length, restarts + 1, "no start after stop");
    assert.equal(registry.status("lb")?.state, "stopped");
    assert.equal(clock.pending(), 0);

    // The loop is ended, not wedged: an explicit start() begins again at the first gap.
    registry.start("lb");
    await clock.advance(0);
    assert.equal(ch.startedAt.length, restarts + 2);
    await clock.advance(BASE_MS - 1);
    assert.equal(ch.startedAt.length, restarts + 2);
    await clock.advance(1);
    assert.equal(ch.startedAt.length, restarts + 3, "a fresh start() after stop() restarts the sequence at the 1000 ms step");
    await registry.stop("lb");
  });
}

test("a start that rejects outright is retried with the same growing gaps, up to the cap, then marked failed", GUARD, async () => {
  const { log, rec } = recordingLog();
  const { registry, clock } = setup(rec);
  const ch = new FailingChannel(clock, "reject");
  registry.register({ manifest: manifest({ maxRestarts: 10 }), factory: () => ch });
  registry.start("lb");
  await clock.advance(0);
  assert.equal(ch.startedAt.length, 1);

  await stepThrough(registry, clock, ch, SEQ, /start rejected/);

  assert.deepEqual(gapsOf(ch.startedAt), SEQ, "same sequence as a failure reported through host.fail, capped at 60 000");
  assert.equal(ch.startedAt.length, 11, "the first start plus maxRestarts (10) restarts");
  assert.equal(registry.status("lb")?.state, "failed");
  assert.equal(registry.status("lb")?.attempts, 10);
  assert.match(registry.status("lb")?.lastError ?? "", /start rejected/);
  assert.equal(clock.pending(), 0);
  await clock.advance(10 * CAP_MS);
  assert.equal(ch.startedAt.length, 11, "no start once failed");
  assert.deepEqual(log.filter((l) => l.event === "channel.gave-up").map((l) => l.fields), [{ channel: "lb", attempts: 10 }]);
  assert.equal(log.filter((l) => l.event === "channel.crashed").length, 11, "one channel.crashed per rejected start");
});

test("a factory that cannot build its channel is not retried (unlike a failing start): failed at once", GUARD, async () => {
  const { registry, clock } = setup();
  let builds = 0;
  registry.register({ manifest: manifest(), factory: () => { builds++; throw new Error("cannot build"); } });
  registry.start("lb");
  await clock.advance(0);
  assert.equal(builds, 1);
  assert.equal(registry.status("lb")?.state, "failed");
  assert.equal(registry.status("lb")?.attempts, 0, "no backoff step was taken");
  assert.match(registry.status("lb")?.lastError ?? "", /cannot build/);
  assert.equal(clock.pending(), 0);
  await clock.advance(10 * CAP_MS);
  assert.equal(builds, 1, "never built again");
});
