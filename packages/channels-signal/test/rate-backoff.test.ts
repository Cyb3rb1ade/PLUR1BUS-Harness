import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RATE_LIMIT_MAX_MS,
  RATE_LIMIT_MIN_MS,
  SignalRpcError,
  defaultConnect,
  type SignalChannelOptions,
  type SignalErrorKind,
} from "../src/index.ts";
import { DM, STRANGER, rig, type Rig } from "./helpers/setup.ts";
import { manualTimeout } from "./helpers/duplex-pair.ts";
import { ScriptedPeer } from "./helpers/scripted-peer.ts";

// Rate limit and backoff contract for the Signal channel. Where each rule lives:
//   - Detection: mapRpcError (src/rpc.ts) matches /RATE_LIMIT|rate.?limit|too many requests|\b429\b/i on the error's
//     message plus the JSON of its nested `data`. The numeric JSON-RPC `code` is never looked at. Signal's daemon reports
//     a rate limit as a JSON-RPC error, not as an HTTP status.
//   - Hint: `"retryAfterSeconds": N` in the data, or `retry-after N` in the text. The wait is clamped to
//     [RATE_LIMIT_MIN_MS, RATE_LIMIT_MAX_MS] = [1 s, 5 min]; with no hint it is RATE_LIMIT_MIN_MS
//     (docs/channels/signal.md, "Limits and known gaps"). mapRpcError always fills retryAfterMs for a rate limit, so the
//     `?? 1000` fallback in channel.ts (#sendParams) is never reached.
//   - Send retry: #sendParams (src/channel.ts) retries only `rate-limited`, at most `maxSendRetries ?? 3` times, so the
//     default is 4 requests in all. After the last one the original SignalRpcError (kind "rate-limited", fixed message
//     "signal rate limit") is rethrown. Every other error, a timeout and a dropped connection included, is not retried.
//   - Reconnect: #supervise (src/channel.ts) is endless by design, with wait = round(min(60 s, 1 s * 2^attempt) *
//     (0.75 + random() * 0.5)) and the attempt counter restarting after every success. It never gives up except for
//     `not-registered`, so these tests step through a bounded number of waits and never assert how many the code makes.
//   - The per-chat TokenBucket (3 tokens, 1 token per second) shares the sleep seam. The sleeper here advances a virtual
//     clock by every wait it completes, as a real clock would, so the bucket refills during a retry wait and the recorded
//     waits are exactly the retry and backoff waits.

type Connect = typeof defaultConnect;

// A regression that makes a loop spin or a wait hang must fail the test, not hang the suite.
const contractTest = (name: string, fn: () => Promise<void>) => test(name, { timeout: 15_000 }, fn);

/**
 * A sleep seam that records every wait and, while holding, parks it until release() or until the channel aborts it.
 * A completed wait moves the virtual clock forward by its length. While holding, the reconnect loop of a daemon that
 * stays unreachable can only advance one wait per release(); without holding it would spin without ever yielding.
 */
function makeSleeper(clock: { t: number }) {
  const sleeps: number[] = [];
  const parked: Array<() => void> = [];
  let holding = false;
  const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    sleeps.push(ms);
    if (!holding || signal.aborted) {
      if (!signal.aborted) clock.t += ms;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      parked.push(() => {
        clock.t += ms;
        resolve();
      });
      // stop() aborts the signal; a parked sleep must wake up then, or stop() would wait for it forever.
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
  return {
    sleeps,
    sleep,
    hold(on: boolean) {
      holding = on;
    },
    release() {
      for (const r of parked.splice(0)) r();
    },
  };
}

interface Harness {
  r: Rig;
  clock: { t: number };
  /** Every wait the channel asked for, in order: retry waits, reconnect backoff and bucket waits. */
  sleeps: number[];
  hold(on: boolean): void;
  release(): void;
  dispose(): Promise<void>;
}

async function harness(over: Partial<SignalChannelOptions> = {}, opts: { start?: boolean; hold?: boolean } = {}): Promise<Harness> {
  const clock = { t: 1_000_000 };
  const s = makeSleeper(clock);
  s.hold(opts.hold === true);
  // The rig feeds r.logs from both the logger option and the host, so every event would appear twice. The logger is
  // silenced here: the host sink alone gives one record per event, which lets the tests count them.
  const r = await rig({ sleep: s.sleep, now: () => clock.t, logger: { log: () => {} }, ...over }, opts.start ?? true);
  return {
    r,
    clock,
    sleeps: s.sleeps,
    hold: s.hold,
    release: s.release,
    async dispose() {
      // Hold stays on while stopping: stop() aborts the signal, which wakes a parked wait and ends the loop. Releasing
      // first would let a loop against an unreachable daemon run on without a pause.
      await r.close();
      s.hold(false);
      s.release();
    },
  };
}

/**
 * Resolves once pred() holds. Predicates read fake-side state (what the daemon saw, what the loop slept), which raises
 * no event of its own, so it is re-checked every millisecond. The 5 s guard only fires when something is wrong.
 */
function waitFor(pred: () => boolean, what: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const recheck = setInterval(check, 1);
    const guard = setTimeout(() => {
      clearInterval(recheck);
      reject(new Error(`timeout: ${what}`));
    }, 5000);
    function check() {
      if (!pred()) return;
      clearInterval(recheck);
      clearTimeout(guard);
      resolve();
    }
    check();
  });
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const sendCount = (r: Rig) => r.daemon.callsOf("send").length;
const reconnects = (r: Rig) => r.logs.filter((l) => l.event === "channel.signal.reconnected").length;
const retryWaits = (r: Rig) => r.logs.filter((l) => l.event === "channel.signal.rate-limited").map((l) => l.waitMs);
const reconnectFailures = (r: Rig) => r.logs.filter((l) => l.event === "channel.signal.reconnect-failed").map((l) => l.reason);

/**
 * Proves that nothing is still on its way to the daemon. The version probe travels on the socket every request uses, so
 * the daemon has seen every earlier frame by the time the probe answers (the ordering argument of the contract helper).
 */
async function drain(r: Rig): Promise<void> {
  await r.ch.health();
  await flush();
  await flush();
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
/** Starts watching a promise without awaiting it, so a test can look at the world while it is still pending. */
function watch<T>(p: Promise<T>): { outcome: Promise<Outcome<T>>; done: () => boolean } {
  let finished = false;
  const outcome = p.then(
    (value): Outcome<T> => {
      finished = true;
      return { ok: true, value };
    },
    (error: unknown): Outcome<T> => {
      finished = true;
      return { ok: false, error };
    },
  );
  return { outcome, done: () => finished };
}

function assertRpcError(out: Outcome<unknown>, kind: SignalErrorKind, message: string): SignalRpcError {
  assert.equal(out.ok, false, "the send must reject");
  const error = (out as { ok: false; error: unknown }).error;
  assert.ok(error instanceof SignalRpcError, "a typed SignalRpcError");
  assert.equal(error.kind, kind);
  assert.equal(error.message, message);
  return error;
}

const resetError = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

// ---- 1. a rate limit with a hint is honoured ---------------------------------------------------------------------------

contractTest("hint: the retry waits the daemon's hint and is not sent a moment earlier", async () => {
  const h = await harness({}, { hold: true });
  try {
    h.r.daemon.failNext("send", { code: -1, message: "RATE_LIMIT", data: { retryAfterSeconds: 2 } });
    const sending = watch(h.r.ch.sendTurn({ chatId: DM, text: "hello" }));
    await waitFor(() => h.sleeps.length === 1, "retry wait parked");
    assert.deepEqual(h.sleeps, [2000]);
    await drain(h.r);
    assert.equal(sendCount(h.r), 1, "no second request while the wait is parked");
    assert.equal(sending.done(), false, "the send is still waiting");
    h.hold(false);
    h.release();
    const out = await sending.outcome;
    assert.equal(out.ok, true);
    assert.equal(sendCount(h.r), 2, "exactly one retry after the wait");
    assert.deepEqual(h.sleeps, [2000], "no wait besides the hint");
    assert.deepEqual(retryWaits(h.r), [2000]);
  } finally {
    await h.dispose();
  }
});

contractTest("hint: every retry waits its own hint, in order, and each wait gates the next request", async () => {
  const h = await harness({}, { hold: true });
  try {
    for (const secs of [3, 6]) h.r.daemon.failNext("send", { code: -1, message: "RATE_LIMIT", data: { retryAfterSeconds: secs } });
    const sending = watch(h.r.ch.sendTurn({ chatId: DM, text: "hello" }));
    await waitFor(() => h.sleeps.length === 1, "first wait parked");
    await drain(h.r);
    assert.equal(sendCount(h.r), 1);
    h.release();
    await waitFor(() => h.sleeps.length === 2, "second wait parked");
    await drain(h.r);
    assert.equal(sendCount(h.r), 2, "the second request went out after the first wait only");
    assert.equal(sending.done(), false);
    assert.deepEqual(h.sleeps, [3000, 6000]);
    h.hold(false);
    h.release();
    assert.equal((await sending.outcome).ok, true);
    assert.equal(sendCount(h.r), 3);
  } finally {
    await h.dispose();
  }
});

const hintCases: Array<{ name: string; code?: number; message: string; data?: unknown; waitMs: number }> = [
  { name: "whole seconds in data", message: "RATE_LIMIT", data: { retryAfterSeconds: 7 }, waitMs: 7000 },
  { name: "fractional seconds are rounded to milliseconds", message: "RATE_LIMIT", data: { retryAfterSeconds: 7.5 }, waitMs: 7500 },
  {
    name: "hint nested in a result list",
    message: "send failed",
    data: { response: { results: [{ type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 12 }] } },
    waitMs: 12_000,
  },
  { name: "hint written in the message text", message: "Rate limit exceeded, retry after 9 seconds", waitMs: 9000 },
  { name: "the numeric error code is not consulted", code: -32603, message: "RATE_LIMIT", data: { retryAfterSeconds: 4 }, waitMs: 4000 },
  { name: "a hint of 0 is raised to the floor", message: "RATE_LIMIT", data: { retryAfterSeconds: 0 }, waitMs: RATE_LIMIT_MIN_MS },
  { name: "a hint below the floor is raised to it", message: "RATE_LIMIT", data: { retryAfterSeconds: 0.2 }, waitMs: RATE_LIMIT_MIN_MS },
  { name: "a hint at the ceiling is kept", message: "RATE_LIMIT", data: { retryAfterSeconds: 300 }, waitMs: RATE_LIMIT_MAX_MS },
  { name: "a hint above the ceiling is cut to it", message: "RATE_LIMIT", data: { retryAfterSeconds: 3600 }, waitMs: RATE_LIMIT_MAX_MS },
];
for (const c of hintCases)
  contractTest(`hint table: ${c.name}`, async () => {
    const h = await harness();
    try {
      h.r.daemon.failNext("send", { code: c.code ?? -1, message: c.message, ...(c.data !== undefined ? { data: c.data } : {}) });
      await h.r.ch.sendTurn({ chatId: DM, text: "hello" });
      assert.deepEqual(h.sleeps, [c.waitMs]);
      assert.deepEqual(retryWaits(h.r), [c.waitMs]);
      assert.equal(sendCount(h.r), 2);
    } finally {
      await h.dispose();
    }
  });

test("hint table: the floor and the ceiling are 1 s and 5 min (docs/channels/signal.md)", () => {
  assert.equal(RATE_LIMIT_MIN_MS, 1000);
  assert.equal(RATE_LIMIT_MAX_MS, 300_000);
});

contractTest("hint: stop() during a parked retry wait does not send the retry", async () => {
  const h = await harness({}, { hold: true });
  try {
    h.r.daemon.failNext("send", { code: -1, message: "RATE_LIMIT", data: { retryAfterSeconds: 30 } });
    const sending = watch(h.r.ch.sendTurn({ chatId: DM, text: "hello" }));
    await waitFor(() => h.sleeps.length === 1, "retry wait parked");
    await h.r.ch.stop();
    const out = await sending.outcome;
    assert.equal(out.ok, false, "the aborted send is not reported as delivered");
    assert.equal(sendCount(h.r), 1, "the abort cut the wait short but did not trigger an early retry");
    assert.deepEqual(h.sleeps, [30_000]);
  } finally {
    await h.dispose();
  }
});

// ---- 2. a rate limit without a hint uses the default ------------------------------------------------------------------

const noHintCases: Array<{ name: string; message: string; data?: unknown }> = [
  { name: "RATE_LIMIT and no data at all", message: "RATE_LIMIT" },
  { name: "data without a hint", message: "RATE_LIMIT", data: { detail: "slow down" } },
  { name: "text 'Too many requests'", message: "Too many requests" },
  { name: "text 'rate limit' in lower case", message: "request rejected by the rate limit" },
  { name: "text with a bare 429", message: "Failed with response code 429" },
];
for (const c of noHintCases)
  contractTest(`default wait: ${c.name} waits RATE_LIMIT_MIN_MS, not a moment less`, async () => {
    const h = await harness({}, { hold: true });
    try {
      h.r.daemon.failNext("send", { code: -1, message: c.message, ...(c.data !== undefined ? { data: c.data } : {}) });
      const sending = watch(h.r.ch.sendTurn({ chatId: DM, text: "hello" }));
      await waitFor(() => h.sleeps.length === 1, "retry wait parked");
      // One retry on a fresh chat takes two bucket tokens of three, so the only wait is the retry wait itself.
      assert.deepEqual(h.sleeps, [RATE_LIMIT_MIN_MS]);
      assert.equal(RATE_LIMIT_MIN_MS, 1000);
      assert.deepEqual(retryWaits(h.r), [1000]);
      await drain(h.r);
      assert.equal(sendCount(h.r), 1, "no request while the default wait is parked");
      h.hold(false);
      h.release();
      assert.equal((await sending.outcome).ok, true);
      assert.equal(sendCount(h.r), 2);
    } finally {
      await h.dispose();
    }
  });

// ---- 3. transport failures are repaired by the reconnect loop, with growing waits ---------------------------------------

contractTest("reconnect: an EOF and a connection reset are each repaired, re-subscribed, and restart at the first wait", async () => {
  const peers: ScriptedPeer[] = [];
  const connect: Connect = async () => {
    const peer = new ScriptedPeer();
    peers.push(peer);
    return peer.client;
  };
  const h = await harness({ connect });
  try {
    assert.equal(peers.length, 1);
    peers[0]!.close(); // EOF: the daemon goes away
    await waitFor(() => reconnects(h.r) === 1, "reconnected after the EOF");
    assert.equal(peers.length, 2);
    assert.deepEqual(h.sleeps, [1000]);

    peers[1]!.client.destroy(resetError()); // reset: the socket dies with an error
    await waitFor(() => reconnects(h.r) === 2, "reconnected after the reset");
    assert.equal(peers.length, 3);
    assert.deepEqual(h.sleeps, [1000, 1000], "a successful reconnect restarts the backoff");

    for (const peer of peers.slice(1)) assert.ok(peer.requests.some((q) => q.method === "subscribeReceive"), "re-subscribed");
    assert.equal(h.r.failures.length, 0, "a lost connection is repaired, not reported as a failure");
    assert.deepEqual(await h.r.ch.health(), { ok: true });
  } finally {
    await h.dispose();
  }
});

/** After the start, every connection attempt fails: one way in two attempts, refused or reset in the handshake. */
function failingConnect(state: { recovered: boolean; attempts: number }): Connect {
  return async (endpoint, signal) => {
    state.attempts += 1;
    if (state.attempts === 1 || state.recovered) return defaultConnect(endpoint, signal);
    if (state.attempts % 2 === 0) throw new SignalRpcError("not-connected", "signal daemon is not reachable");
    const peer = new ScriptedPeer();
    peer.answering = false;
    setImmediate(() => peer.client.destroy(resetError()));
    return peer.client;
  };
}

/** Steps the held reconnect loop through `count` waits, one release() per wait, and returns what it slept. */
async function stepBackoff(h: Harness, count: number): Promise<number[]> {
  for (let k = 1; k <= count; k++) {
    await waitFor(() => h.sleeps.length === k, `backoff wait ${k} parked`);
    if (k < count) h.release();
  }
  return [...h.sleeps];
}

contractTest("reconnect: repeated refusals and resets double the wait up to the 60 s cap and the loop never gives up", async () => {
  const state = { recovered: false, attempts: 0 };
  const h = await harness({ connect: failingConnect(state) }, { hold: true });
  try {
    h.r.daemon.dropConnections();
    // Nine waits are the test's own bound. The loop has none: two waits at the cap show that it keeps going.
    const waits = await stepBackoff(h, 9);
    assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    for (let i = 1; i < waits.length; i++) assert.ok(waits[i]! >= waits[i - 1]!, `wait ${i} did not shrink`);
    assert.equal(h.r.failures.length, 0, "an unreachable daemon is never a failure of the channel");
    assert.equal((await h.r.ch.health()).ok, false);
    const reasons = new Set(reconnectFailures(h.r));
    assert.ok(reasons.has("not-connected") && reasons.has("disconnected"), `both kinds were retried, saw ${[...reasons].join(",")}`);

    // The daemon is back: the next attempt succeeds, and the next outage starts at the first wait again.
    state.recovered = true;
    h.hold(false);
    h.release();
    await waitFor(() => reconnects(h.r) === 1, "reconnected once the daemon is back");
    assert.deepEqual(await h.r.ch.health(), { ok: true });
    assert.equal(h.sleeps.length, 9, "the successful attempt needed no further wait");
    h.hold(true);
    h.r.daemon.dropConnections();
    await waitFor(() => h.sleeps.length === 10, "first wait of the next outage");
    assert.equal(h.sleeps[9], 1000);
    assert.equal(h.r.failures.length, 0);
  } finally {
    await h.dispose();
  }
});

const jitterCases: Array<{ name: string; random: () => number; waits: number[] }> = [
  { name: "random() = 0 gives 75 % of the base", random: () => 0, waits: [750, 1500, 3000, 6000, 12_000, 24_000, 45_000, 45_000] },
  { name: "random() = 1 gives 125 % of the base", random: () => 1, waits: [1250, 2500, 5000, 10_000, 20_000, 40_000, 75_000, 75_000] },
];
for (const c of jitterCases)
  contractTest(`reconnect jitter: ${c.name}; the 60 s cap bounds the base, jitter is added on top of it`, async () => {
    const state = { recovered: false, attempts: 0 };
    const h = await harness({ connect: failingConnect(state), random: c.random }, { hold: true });
    try {
      h.r.daemon.dropConnections();
      assert.deepEqual(await stepBackoff(h, c.waits.length), c.waits);
      assert.equal(h.r.failures.length, 0);
    } finally {
      await h.dispose();
    }
  });

// ---- 4. errors that are not rate limits are sent exactly once ---------------------------------------------------------

const notRetried: Array<{ name: string; error: { code: number; message: string; data?: unknown }; kind: SignalErrorKind; message: string }> = [
  {
    name: "untrusted identity",
    error: { code: -1, message: "UntrustedIdentityException: key changed" },
    kind: "untrusted-identity",
    message: "signal identity key is not trusted for the recipient",
  },
  {
    name: "recipient not registered",
    error: { code: -32603, message: "NotRegisteredException: recipient is not registered" },
    kind: "not-registered",
    message: "signal account is not registered",
  },
  { name: "bad request (invalid params)", error: { code: -32602, message: "invalid params" }, kind: "rpc", message: "signal request failed" },
  { name: "method not found", error: { code: -32601, message: "Method not found" }, kind: "rpc", message: "signal method not found" },
  { name: "internal error", error: { code: -32603, message: "internal error" }, kind: "rpc", message: "signal request failed" },
  {
    name: "a limit that is not a rate limit (attachment size)",
    error: { code: -1, message: "attachment size limit exceeded" },
    kind: "rpc",
    message: "signal request failed",
  },
  {
    name: "a bare numeric code 429 without rate-limit text (matching is on message and data only)",
    error: { code: 429, message: "request failed" },
    kind: "rpc",
    message: "signal request failed",
  },
];
for (const c of notRetried)
  contractTest(`not retried: ${c.name} is one request, no wait, a typed error`, async () => {
    const h = await harness();
    try {
      // The error is scripted twice. A retry would consume the second one, and would show as a second request.
      h.r.daemon.failNext("send", c.error);
      h.r.daemon.failNext("send", c.error);
      const out = await watch(h.r.ch.sendTurn({ chatId: DM, text: "hello" })).outcome;
      assertRpcError(out, c.kind, c.message);
      await drain(h.r);
      assert.equal(sendCount(h.r), 1);
      assert.equal(h.r.daemon.failures["send"]?.length, 1, "the second scripted error was never asked for");
      assert.deepEqual(h.sleeps, [], "no retry wait and no backoff");
      assert.equal(h.r.failures.length, 0);
      assert.deepEqual(await h.r.ch.health(), { ok: true });
    } finally {
      await h.dispose();
    }
  });

contractTest("not retried: a request that times out is sent once (it may already be delivered; docs/channels/signal.md)", async () => {
  const timers = manualTimeout();
  const peer = new ScriptedPeer();
  const h = await harness({ connect: async () => peer.client, timeout: timers.fn });
  try {
    peer.answering = false;
    const sending = watch(h.r.ch.sendTurn({ chatId: DM, text: "hello" }));
    await waitFor(() => peer.unanswered.some((q) => q.method === "send"), "send request is on the wire");
    timers.fireAll();
    assertRpcError(await sending.outcome, "timeout", "signal request timed out");
    await flush();
    await flush();
    assert.equal(peer.requests.filter((q) => q.method === "send").length, 1);
    assert.deepEqual(h.sleeps, [], "no retry wait");
  } finally {
    await h.dispose();
  }
});

contractTest("not retried: a connection lost mid-send is sent once; the new connection never sees the send again", async () => {
  const peers: ScriptedPeer[] = [];
  const connect: Connect = async () => {
    const peer = new ScriptedPeer();
    peers.push(peer);
    return peer.client;
  };
  const h = await harness({ connect }, { hold: true });
  try {
    peers[0]!.answering = false;
    const sending = watch(h.r.ch.sendTurn({ chatId: DM, text: "hello" }));
    await waitFor(() => peers[0]!.unanswered.some((q) => q.method === "send"), "send request is on the wire");
    peers[0]!.close();
    assertRpcError(await sending.outcome, "disconnected", "signal daemon connection closed");
    // The reconnect loop is parked in its first wait; let it connect, then look at what the new connection saw.
    await waitFor(() => h.sleeps.length === 1, "reconnect wait parked");
    h.hold(false);
    h.release();
    await waitFor(() => reconnects(h.r) === 1, "reconnected");
    assert.equal(peers.length, 2);
    assert.equal(peers[0]!.requests.filter((q) => q.method === "send").length, 1);
    assert.equal(peers[1]!.requests.filter((q) => q.method === "send").length, 0, "the lost send was not replayed");
    assert.deepEqual(h.sleeps, [1000], "the only wait was the reconnect backoff");
    assert.equal(h.r.failures.length, 0);
  } finally {
    await h.dispose();
  }
});

// ---- 5. the send retry limit ends in a defined error ---------------------------------------------------------------------

contractTest("retry limit: the default is three retries, then a rate-limited error, then no further request", async () => {
  const h = await harness();
  try {
    // Four failures with distinct hints. A fifth request would find the daemon willing and succeed, so a send that
    // rejects with exactly four requests behind it proves the bound and not the lack of an answer.
    for (const secs of [2, 3, 4, 5]) h.r.daemon.failNext("send", { code: -1, message: "RATE_LIMIT", data: { retryAfterSeconds: secs } });
    const out = await watch(h.r.ch.sendTurn({ chatId: DM, text: "hello" })).outcome;
    const error = assertRpcError(out, "rate-limited", "signal rate limit");
    assert.equal(error.retryAfterMs, 5000, "the error is the last one the daemon sent");
    await drain(h.r);
    assert.equal(sendCount(h.r), 4, "one request and three retries");
    assert.deepEqual(h.sleeps, [2000, 3000, 4000], "a wait before each retry and none after the last failure");
    assert.deepEqual(retryWaits(h.r), [2000, 3000, 4000]);
    assert.equal(h.r.daemon.failures["send"]?.length, 0);
    assert.equal(h.r.failures.length, 0, "a rate-limited send is that message's error, not the channel's");
    assert.deepEqual(await h.r.ch.health(), { ok: true });

    // The bound is per send: the next one starts from a clean count and goes through.
    await h.r.ch.sendTurn({ chatId: DM, text: "again" });
    assert.equal(sendCount(h.r), 5);
  } finally {
    await h.dispose();
  }
});

const limitCases: Array<{ maxSendRetries: number; requests: number }> = [
  { maxSendRetries: 0, requests: 1 },
  { maxSendRetries: 1, requests: 2 },
  { maxSendRetries: 5, requests: 6 },
];
for (const c of limitCases)
  contractTest(`retry limit: maxSendRetries ${c.maxSendRetries} gives ${c.requests} request(s) and then a rate-limited error`, async () => {
    const h = await harness({ maxSendRetries: c.maxSendRetries });
    try {
      for (let i = 0; i < c.requests; i++) h.r.daemon.failNext("send", { code: -1, message: "RATE_LIMIT", data: { retryAfterSeconds: 1 } });
      const out = await watch(h.r.ch.sendTurn({ chatId: DM, text: "hello" })).outcome;
      assertRpcError(out, "rate-limited", "signal rate limit");
      await drain(h.r);
      assert.equal(sendCount(h.r), c.requests);
      assert.equal(h.sleeps.length, c.requests - 1, "one wait between consecutive requests");
      assert.ok(h.sleeps.every((ms) => ms === 1000));
      assert.equal(h.r.daemon.failures["send"]?.length, 0);
    } finally {
      await h.dispose();
    }
  });

contractTest("retry limit: the error keeps the daemon's text out of its fixed message", async () => {
  const h = await harness({ maxSendRetries: 0 });
  try {
    h.r.daemon.failNext("send", { code: -1, message: `RATE_LIMIT for ${STRANGER}, retry after 42 s`, data: { retryAfterSeconds: 42 } });
    const out = await watch(h.r.ch.sendTurn({ chatId: DM, text: "hello" })).outcome;
    const error = assertRpcError(out, "rate-limited", "signal rate limit");
    assert.equal(error.retryAfterMs, 42_000);
    assert.ok(!error.message.includes("42") && !error.message.includes(STRANGER));
  } finally {
    await h.dispose();
  }
});
