import assert from "node:assert/strict";
import { test } from "node:test";
import { SignalRpcError, defaultConnect, type SignalChannelOptions } from "../src/index.ts";
import { ACCOUNT, DM, STRANGER, push, rig, type Rig } from "./helpers/setup.ts";
import { textEnvelope } from "./helpers/fake-daemon.ts";
import { manualTimeout } from "./helpers/duplex-pair.ts";
import { ScriptedPeer } from "./helpers/scripted-peer.ts";

// Contract catalogue for the Signal channel (packages/core/src/channels/types.ts: start/stop/health/send,
// host.receive/fail/log), points a) to g). The same catalogue exists for the other channels; the points that Signal's
// transport changes are explained where they differ:
//   - Signal has no credential. The daemon owns the account, so "final auth failure" means "the daemon says the account is
//     not registered". That is the only error that reaches host.fail (channel.ts, #supervise). `untrusted-identity` and
//     daemon rate limits are send-time errors for one message and never fail the channel.
//   - The reader is a `data` listener on the daemon socket, not a polling loop. A "pending read" is therefore an RPC
//     whose reply has not arrived (ScriptedPeer keeps the reply back), not a request in flight.
//   - A lost connection is repaired by an endless reconnect loop with capped backoff. The channel does not give up on a
//     dead daemon and does not call host.fail for it; it reports the loss through health().
//
// Overlap with existing tests (this file re-states each point as a contract and adds the cases those do not cover):
//   a) lifecycle.test.ts "concurrent start shares one connection", outbound.test.ts "channel-level health reflects ..."
//   b) lifecycle.test.ts "stop is idempotent, health goes false, restart works"
//   c) lifecycle.test.ts (same test, /not started/), outbound.test.ts "a send before start rejects"
//   d) inbound.test.ts "duplicate source+timestamp is processed once"
//   e) lifecycle.test.ts "fatal not-registered on reconnect calls host.fail once ...", "start rejects for an unregistered
//      account ...", "backoff grows with attempts ..."
//   f) lifecycle.test.ts "reconnect after a dropped socket ..." (checks recovery, not the state while down)
//   g) lifecycle.test.ts "stop aborts a pending reconnect loop" (no unhandled-rejection watch)

type Connect = typeof defaultConnect;

// A regression that makes stop() wait forever must fail the test, not hang the suite.
const contractTest = (name: string, fn: () => Promise<void>) => test(name, { timeout: 15_000 }, fn);

/** A sleep seam that records every wait and, while holding, parks it until release() or until the channel aborts it. */
function makeSleeper() {
  const sleeps: number[] = [];
  const parked: Array<() => void> = [];
  let holding = false;
  const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    sleeps.push(ms);
    if (!holding || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      parked.push(resolve);
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
  /** Backoff and bucket waits the channel asked for, in order. */
  sleeps: number[];
  hold(on: boolean): void;
  release(): void;
  dispose(): Promise<void>;
}

async function harness(over: Partial<SignalChannelOptions> = {}, opts: { start?: boolean; hold?: boolean } = {}): Promise<Harness> {
  const s = makeSleeper();
  s.hold(opts.hold === true);
  const r = await rig({ sleep: s.sleep, ...over }, opts.start ?? true);
  return {
    r,
    sleeps: s.sleeps,
    hold: s.hold,
    release: s.release,
    async dispose() {
      s.hold(false);
      s.release();
      await r.close();
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

const reconnected = (r: Rig) => r.logs.some((l) => l.event === "channel.signal.reconnected");
const texts = (r: Rig) => r.received.map((m) => m.text);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
/** The same line the daemon writes for one incoming message. */
const receiveLine = (envelope: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { envelope, account: ACCOUNT } }) + "\n";

/** Runs body with an unhandledRejection listener installed and asserts that nothing reached it. */
async function withoutUnhandledRejections(body: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const onRejection = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    await body();
    // Node reports unhandled rejections after the microtask queue drains; two macrotask turns cover it.
    await flush();
    await flush();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
}

// ---- a) start resolves, then health reports ok -------------------------------------------------------------------------

contractTest("a) start resolves only after the daemon handshake, then health reports ok", async () => {
  const h = await harness({}, { start: false });
  try {
    assert.deepEqual(await h.r.ch.health(), { ok: false }, "not healthy before start");
    await h.r.ch.start(h.r.host);
    assert.deepEqual(
      h.r.daemon.calls.map((c) => c.method),
      ["version", "listAccounts", "subscribeReceive"],
      "start resolved after the handshake",
    );
    assert.deepEqual(await h.r.ch.health(), { ok: true });
    assert.equal(h.r.failures.length, 0);
  } finally {
    await h.dispose();
  }
});

// ---- b) stop is idempotent ---------------------------------------------------------------------------------------------

contractTest("b) stop is idempotent: two stops, also concurrent ones, do not throw", async () => {
  const h = await harness();
  try {
    await h.r.ch.stop();
    await h.r.ch.stop();
    assert.deepEqual(await h.r.ch.health(), { ok: false });
    await h.r.ch.start(h.r.host);
    await Promise.all([h.r.ch.stop(), h.r.ch.stop()]);
    assert.deepEqual(await h.r.ch.health(), { ok: false });
    assert.equal(h.r.failures.length, 0, "stopping is not a failure");
  } finally {
    await h.dispose();
  }
});

contractTest("b) stop on a channel that never started does not throw and touches no daemon", async () => {
  const h = await harness({}, { start: false });
  try {
    await h.r.ch.stop();
    await h.r.ch.stop();
    assert.deepEqual(await h.r.ch.health(), { ok: false });
    assert.equal(h.r.daemon.connections, 0);
  } finally {
    await h.dispose();
  }
});

// ---- c) send after stop is rejected ------------------------------------------------------------------------------------

const NOT_STARTED = "signal channel is not started";
const isNotStarted = (e: unknown) => e instanceof Error && !(e instanceof SignalRpcError) && e.message === NOT_STARTED;

contractTest("c) send after stop is rejected with a defined error and nothing reaches the daemon", async () => {
  const h = await harness();
  try {
    // Control: the same send succeeds while started, so the rejection below is about the stopped state.
    await h.r.ch.send({ chatId: DM, text: "before stop" });
    assert.deepEqual(
      h.r.daemon.sent().map((p) => p.message),
      ["before stop"],
    );
    await h.r.ch.stop();
    const callsAfterStop = h.r.daemon.calls.length;
    await assert.rejects(h.r.ch.send({ chatId: DM, text: "after stop" }), isNotStarted);
    assert.deepEqual(
      h.r.daemon.sent().map((p) => p.message),
      ["before stop"],
    );
    assert.equal(h.r.daemon.calls.length, callsAfterStop, "no request of any kind went out");
  } finally {
    await h.dispose();
  }
});

contractTest("c) send on a channel that never started is rejected the same way", async () => {
  const h = await harness({}, { start: false });
  try {
    await assert.rejects(h.r.ch.send({ chatId: DM, text: "too early" }), isNotStarted);
    assert.equal(h.r.daemon.calls.length, 0);
  } finally {
    await h.dispose();
  }
});

contractTest("c) send while the daemon connection is lost is rejected, not queued", async () => {
  // Pinned semantics: the channel has no outbox. While disconnected, send() fails with the same "not started" error
  // (the wording says "started", the state is "connected") and the message is not delivered after the reconnect either.
  const h = await harness({}, { hold: true });
  try {
    h.r.daemon.dropConnections();
    await waitFor(() => h.sleeps.length === 1, "reconnect backoff parked");
    const callsWhileDown = h.r.daemon.calls.length;
    await assert.rejects(h.r.ch.send({ chatId: DM, text: "during outage" }), isNotStarted);
    h.hold(false);
    h.release();
    await waitFor(() => reconnected(h.r), "reconnected");
    assert.deepEqual(h.r.daemon.sent(), [], "the rejected message was not replayed");
    assert.ok(h.r.daemon.calls.length > callsWhileDown, "the reconnect handshake did reach the daemon");
  } finally {
    await h.dispose();
  }
});

// ---- d) an inbound message reaches host.receive exactly once -------------------------------------------------------------

contractTest("d) an inbound message reaches host.receive once with the channel's own fields", async () => {
  const h = await harness();
  try {
    await push(h.r, textEnvelope({ message: "hello", ts: 1_700_000_000_601 }));
    assert.equal(h.r.received.length, 1);
    const m = h.r.received[0]!;
    assert.deepEqual(
      { channel: m.channel, chatId: m.chatId, chatKind: m.chatKind, senderId: m.senderId, text: m.text, messageId: m.messageId },
      { channel: "signal", chatId: DM, chatKind: "direct", senderId: DM, text: "hello", messageId: "1700000000601" },
    );
  } finally {
    await h.dispose();
  }
});

contractTest("d) the same envelope delivered twice in a row reaches host.receive once", async () => {
  const h = await harness();
  try {
    const env = textEnvelope({ message: "once", ts: 1_700_000_000_611 });
    // Three notifications back to back, then one read barrier: the daemon replies to `version` after all of them.
    h.r.daemon.push(env);
    h.r.daemon.push(env);
    h.r.daemon.push(textEnvelope({ message: "sentinel", ts: 1_700_000_000_612 }));
    await h.r.ch.health();
    await h.r.ch.whenIdle();
    assert.deepEqual(texts(h.r), ["once", "sentinel"]);
  } finally {
    await h.dispose();
  }
});

contractTest("d) the duplicate arriving in the same socket chunk as the original is still delivered once", async () => {
  // FakeDaemon can only write to a connected socket, so "queue before start" is not possible here. One raw write puts
  // both copies (and a sentinel) into a single TCP segment, which is what a single read batch means on this transport.
  const h = await harness();
  try {
    const env = textEnvelope({ message: "once", ts: 1_700_000_000_621 });
    h.r.daemon.writeRaw(receiveLine(env) + receiveLine(env) + receiveLine(textEnvelope({ message: "sentinel", ts: 1_700_000_000_622 })));
    await h.r.ch.health();
    await h.r.ch.whenIdle();
    assert.deepEqual(texts(h.r), ["once", "sentinel"]);
  } finally {
    await h.dispose();
  }
});

contractTest("d) dedupe is keyed on sender and timestamp: other senders and other timestamps are not swallowed", async () => {
  const h = await harness({ dmAllowlist: [DM, STRANGER] });
  try {
    const ts = 1_700_000_000_631;
    await push(h.r, textEnvelope({ message: "from first", ts }));
    await push(h.r, textEnvelope({ number: STRANGER, message: "same timestamp, other sender", ts }));
    await push(h.r, textEnvelope({ message: "same sender, other timestamp", ts: ts + 1 }));
    await push(h.r, textEnvelope({ message: "from first", ts }));
    assert.deepEqual(texts(h.r), ["from first", "same timestamp, other sender", "same sender, other timestamp"]);
  } finally {
    await h.dispose();
  }
});

contractTest("d) an envelope the daemon repeats after a reconnect is still delivered once", async () => {
  const h = await harness();
  try {
    const env = textEnvelope({ message: "once", ts: 1_700_000_000_641 });
    await push(h.r, env);
    h.r.daemon.dropConnections();
    await waitFor(() => reconnected(h.r), "reconnected");
    await push(h.r, env);
    await push(h.r, textEnvelope({ message: "sentinel", ts: 1_700_000_000_642 }));
    assert.deepEqual(texts(h.r), ["once", "sentinel"]);
  } finally {
    await h.dispose();
  }
});

// ---- e) final failure calls host.fail, transient failures do not and the channel recovers --------------------------------

contractTest("e) a final failure on reconnect (account no longer registered) calls host.fail once and the loop ends", async () => {
  const h = await harness();
  try {
    h.r.daemon.registered = false;
    h.r.daemon.dropConnections();
    await waitFor(() => h.r.failures.length === 1, "host.fail");
    const error = h.r.failures[0];
    assert.ok(error instanceof Error);
    assert.match(error.message, /not registered/);
    assert.ok(!error.message.includes("4915100000001"), "the account number does not leak into the failure");
    assert.deepEqual(await h.r.ch.health(), { ok: false });
    // The loop returned after host.fail: stop() awaits it, and no further attempt was made in the meantime.
    const connectionsAtFailure = h.r.daemon.connections;
    await h.r.ch.stop();
    assert.equal(h.r.failures.length, 1, "host.fail is called once, not on every attempt");
    assert.equal(h.r.daemon.connections, connectionsAtFailure, "no retry storm");
    assert.deepEqual(h.sleeps, [1000], "one backoff wait, then the fatal answer");
    assert.equal(h.r.received.length, 0);
  } finally {
    await h.dispose();
  }
});

contractTest("e) after host.fail the registry's stop and start bring the channel back", async () => {
  // The registry reacts to host.fail by stopping the channel and starting it again with backoff (types.ts, ChannelHost.fail).
  const h = await harness();
  try {
    h.r.daemon.registered = false;
    h.r.daemon.dropConnections();
    await waitFor(() => h.r.failures.length === 1, "host.fail");
    h.r.daemon.registered = true;
    await h.r.ch.stop();
    await h.r.ch.start(h.r.host);
    assert.deepEqual(await h.r.ch.health(), { ok: true });
    await push(h.r, textEnvelope({ message: "back again", ts: 1_700_000_000_651 }));
    assert.deepEqual(texts(h.r), ["back again"]);
    assert.equal(h.r.failures.length, 1);
  } finally {
    await h.dispose();
  }
});

contractTest("e) a failure at start travels through the start() rejection, not through host.fail", async () => {
  // Pinned semantics: start() rejects with a fixed message when the daemon does not know the account; host.fail is
  // reserved for failures after start (channel.ts, #supervise).
  const h = await harness({}, { start: false });
  try {
    h.r.daemon.registered = false;
    await assert.rejects(h.r.ch.start(h.r.host), (e: Error) => /not registered/.test(e.message) && !e.message.includes("4915100000001"));
    assert.equal(h.r.failures.length, 0);
    assert.deepEqual(await h.r.ch.health(), { ok: false });
  } finally {
    await h.dispose();
  }
});

contractTest("e) transient daemon errors during reconnect do not call host.fail; backoff grows and a later message arrives", async () => {
  const h = await harness();
  try {
    // Scripted after start: FakeDaemon keeps one failure queue per method across connections, and health() also asks `version`.
    h.r.daemon.failNext("version", { code: -1, message: "busy" });
    h.r.daemon.failNext("version", { code: -1, message: "busy" });
    h.r.daemon.dropConnections();
    await waitFor(() => reconnected(h.r), "reconnected after two failed attempts");
    assert.equal(h.r.failures.length, 0, "transient errors must not fail the channel");
    assert.deepEqual(h.sleeps, [1000, 2000, 4000]);
    const reasons = new Set(h.r.logs.filter((l) => l.event === "channel.signal.reconnect-failed").map((l) => l.reason));
    assert.deepEqual([...reasons], ["rpc"]);
    await push(h.r, textEnvelope({ message: "after transient errors", ts: 1_700_000_000_661 }));
    assert.deepEqual(texts(h.r), ["after transient errors"]);
    assert.deepEqual(await h.r.ch.health(), { ok: true });
  } finally {
    await h.dispose();
  }
});

contractTest("e) an unreachable daemon during reconnect does not call host.fail; the channel recovers when it is back", async () => {
  let attempts = 0;
  // Connection attempts 2 and 3 fail the way defaultConnect fails on ECONNREFUSED; attempt 1 is the start, 4 is the recovery.
  const connect: Connect = (endpoint, signal) => {
    attempts += 1;
    if (attempts === 2 || attempts === 3) return Promise.reject(new SignalRpcError("not-connected", "signal daemon is not reachable"));
    return defaultConnect(endpoint, signal);
  };
  const h = await harness({ connect });
  try {
    h.r.daemon.dropConnections();
    await waitFor(() => reconnected(h.r), "reconnected after two unreachable attempts");
    assert.equal(attempts, 4);
    assert.equal(h.r.failures.length, 0);
    assert.deepEqual(h.sleeps, [1000, 2000, 4000]);
    const reasons = new Set(h.r.logs.filter((l) => l.event === "channel.signal.reconnect-failed").map((l) => l.reason));
    assert.deepEqual([...reasons], ["not-connected"]);
    await push(h.r, textEnvelope({ message: "daemon is back", ts: 1_700_000_000_671 }));
    assert.deepEqual(texts(h.r), ["daemon is back"]);
  } finally {
    await h.dispose();
  }
});

contractTest("e) a daemon that does not answer the reconnect handshake times out without host.fail and the next attempt recovers", async () => {
  const timers = manualTimeout();
  const silent = new ScriptedPeer();
  silent.answering = false;
  let attempts = 0;
  const connect: Connect = async (endpoint, signal) => {
    attempts += 1;
    return attempts === 2 ? silent.client : defaultConnect(endpoint, signal);
  };
  const h = await harness({ connect, timeout: timers.fn });
  try {
    h.r.daemon.dropConnections();
    await waitFor(() => silent.unanswered.some((q) => q.method === "version"), "handshake sent to the silent daemon");
    timers.fireAll();
    await waitFor(() => reconnected(h.r), "reconnected after the timeout");
    assert.equal(h.r.failures.length, 0);
    const reasons = new Set(h.r.logs.filter((l) => l.event === "channel.signal.reconnect-failed").map((l) => l.reason));
    assert.deepEqual([...reasons], ["timeout"]);
    await push(h.r, textEnvelope({ message: "after the timeout", ts: 1_700_000_000_681 }));
    assert.deepEqual(texts(h.r), ["after the timeout"]);
  } finally {
    await h.dispose();
  }
});

contractTest("e) a send-time error (untrusted identity) fails that send only: no host.fail, the channel stays healthy", async () => {
  // Signal has no credential to revoke. Per-recipient errors are the caller's, never the channel's.
  const h = await harness();
  try {
    h.r.daemon.failNext("send", { code: -1, message: "UntrustedIdentityException: key changed" });
    await assert.rejects(h.r.ch.send({ chatId: DM, text: "first" }), (e: unknown) => e instanceof SignalRpcError && e.kind === "untrusted-identity");
    assert.equal(h.r.failures.length, 0);
    assert.deepEqual(await h.r.ch.health(), { ok: true });
    await h.r.ch.send({ chatId: DM, text: "second" });
    assert.equal(h.r.daemon.sent().length, 2);
  } finally {
    await h.dispose();
  }
});

// ---- f) after connection loss health() is not ok -------------------------------------------------------------------------

contractTest("f) health is not ok while the connection is lost and ok again once the reconnect has landed", async () => {
  const h = await harness({}, { hold: true });
  try {
    assert.deepEqual(await h.r.ch.health(), { ok: true });
    h.r.daemon.dropConnections();
    // The reconnect loop is parked in its first backoff wait, so the lost state can be inspected.
    await waitFor(() => h.sleeps.length === 1, "backoff after connection loss");
    assert.equal((await h.r.ch.health()).ok, false);
    assert.equal(h.r.failures.length, 0, "a lost connection is not a failure of the channel");
    h.hold(false);
    h.release();
    await waitFor(() => reconnected(h.r), "reconnected");
    assert.deepEqual(await h.r.ch.health(), { ok: true });
  } finally {
    await h.dispose();
  }
});

contractTest("f) a daemon that stays gone keeps health not ok while the channel backs off and keeps trying", async () => {
  // Pinned semantics (docs/channels/signal.md, Troubleshooting): the channel retries a dead daemon with growing backoff
  // and never calls host.fail for it. The loss is visible through health(), which the registry watches.
  const h = await harness({}, { hold: true });
  try {
    await h.r.daemon.close();
    await waitFor(() => h.sleeps.length === 1, "first backoff");
    assert.equal((await h.r.ch.health()).ok, false);
    h.release();
    await waitFor(() => h.sleeps.length === 2, "second backoff after a refused attempt");
    assert.deepEqual(h.sleeps, [1000, 2000]);
    assert.equal((await h.r.ch.health()).ok, false);
    assert.equal(h.r.failures.length, 0);
  } finally {
    await h.dispose();
  }
});

contractTest("f) a daemon that stays connected but stops answering is reported as not ok by health", async () => {
  const timers = manualTimeout();
  const peer = new ScriptedPeer();
  const h = await harness({ connect: async () => peer.client, timeout: timers.fn });
  try {
    assert.deepEqual(await h.r.ch.health(), { ok: true });
    peer.answering = false;
    const probe = h.r.ch.health();
    await waitFor(() => peer.unanswered.some((q) => q.method === "version"), "health probe sent");
    timers.fireAll();
    const answer = await probe;
    assert.equal(answer.ok, false);
    assert.equal(typeof answer.detail, "string");
    assert.ok(!String(answer.detail).includes("4915100000001"));
    assert.equal(h.r.failures.length, 0);
  } finally {
    await h.dispose();
  }
});

// ---- g) stop leaves no unhandled rejection -------------------------------------------------------------------------------

contractTest("g) stop of an idle started channel, with the daemon socket still being read, leaves no unhandled rejection", async () => {
  const h = await harness();
  try {
    await withoutUnhandledRejections(async () => {
      await push(h.r, textEnvelope({ message: "in flight", ts: 1_700_000_000_701 }));
      assert.deepEqual(texts(h.r), ["in flight"]);
      await h.r.ch.stop();
      assert.deepEqual(await h.r.ch.health(), { ok: false });
    });
  } finally {
    await h.dispose();
  }
});

contractTest("g) stop while a send is waiting for the daemon's reply rejects that send and leaves no unhandled rejection", async () => {
  const peer = new ScriptedPeer();
  const h = await harness({ connect: async () => peer.client });
  try {
    await withoutUnhandledRejections(async () => {
      peer.answering = false;
      const pending = h.r.ch.send({ chatId: DM, text: "never answered" });
      // Attach the rejection handler before stop(), so the test itself is not the source of an unhandled rejection.
      const outcome = assert.rejects(pending, (e: unknown) => e instanceof SignalRpcError);
      await waitFor(() => peer.unanswered.some((q) => q.method === "send"), "send request written");
      await h.r.ch.stop();
      await outcome;
      assert.deepEqual(await h.r.ch.health(), { ok: false });
    });
  } finally {
    await h.dispose();
  }
});

contractTest("g) stop while the reconnect handshake is waiting for a reply leaves no unhandled rejection and no further attempt", async () => {
  const silent = new ScriptedPeer();
  silent.answering = false;
  let attempts = 0;
  const connect: Connect = async (endpoint, signal) => {
    attempts += 1;
    return attempts === 2 ? silent.client : defaultConnect(endpoint, signal);
  };
  const h = await harness({ connect });
  try {
    await withoutUnhandledRejections(async () => {
      h.r.daemon.dropConnections();
      await waitFor(() => silent.unanswered.some((q) => q.method === "version"), "handshake read pending");
      await h.r.ch.stop();
      assert.deepEqual(await h.r.ch.health(), { ok: false });
      assert.equal(attempts, 2, "stop ended the loop, no attempt after it");
      assert.equal(h.r.failures.length, 0, "stopping is not a failure");
    });
  } finally {
    await h.dispose();
  }
});

contractTest("g) stop while the reconnect loop sleeps in its backoff leaves no unhandled rejection", async () => {
  const h = await harness({}, { hold: true });
  try {
    await withoutUnhandledRejections(async () => {
      h.r.daemon.dropConnections();
      await waitFor(() => h.sleeps.length === 1, "backoff parked");
      await h.r.ch.stop();
      assert.deepEqual(await h.r.ch.health(), { ok: false });
      assert.deepEqual(h.sleeps, [1000], "the aborted sleep did not trigger another attempt");
    });
  } finally {
    await h.dispose();
  }
});

contractTest("g) stop issued while start is still connecting settles both calls without an unhandled rejection", async () => {
  const h = await harness({}, { start: false });
  try {
    await withoutUnhandledRejections(async () => {
      const starting = h.r.ch.start(h.r.host);
      const stopping = h.r.ch.stop();
      const [started, stopped] = await Promise.allSettled([starting, stopping]);
      assert.equal(stopped.status, "fulfilled");
      // The abort lands while the socket is connecting, so start() reports its fixed failure message.
      assert.equal(started.status, "rejected");
      assert.match(String((started as PromiseRejectedResult).reason?.message), /signal daemon start failed/);
      assert.deepEqual(await h.r.ch.health(), { ok: false });
      assert.equal(h.r.failures.length, 0);
    });
  } finally {
    await h.dispose();
  }
});
