import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackApiError, SocketFatalError, SocketMode, type SocketEnvelope, type SocketLike } from "../src/index.ts";
import { FakeSocket } from "./helpers/fake-slack.ts";
import { until } from "./helpers/wire.ts";

interface Harness {
  sockets: FakeSocket[];
  urls: string[];
  processed: string[];
  states: boolean[];
  fatal: SocketFatalError[];
  sleeps: number[];
  opens: number;
  mode: SocketMode;
  failOpen: Array<Error | "ok">;
}

function harness(opts: { random?: number; helloTimeoutMs?: number } = {}): Harness {
  const h: Harness = {
    sockets: [],
    urls: [],
    processed: [],
    states: [],
    fatal: [],
    sleeps: [],
    opens: 0,
    failOpen: [],
    mode: undefined as unknown as SocketMode,
  };
  h.mode = new SocketMode({
    openUrl: async () => {
      h.opens++;
      const next = h.failOpen.shift();
      if (next && next !== "ok") throw next;
      const url = `wss://wss.fake-slack.test/link/?ticket=T${h.opens}`;
      h.urls.push(url);
      return url;
    },
    socketFactory: (url) => {
      const s = new FakeSocket(url, true);
      h.sockets.push(s);
      queueMicrotask(() => s.open());
      return s as SocketLike;
    },
    onEnvelope: (env: SocketEnvelope) => {
      h.processed.push(String(env.envelope_id));
    },
    onFatal: (e) => h.fatal.push(e),
    onState: (c) => h.states.push(c),
    log: () => {},
    sleep: async (ms) => {
      h.sleeps.push(ms);
    },
    random: () => opts.random ?? 0.5,
    now: () => 0,
    ...(opts.helloTimeoutMs !== undefined ? { helloTimeoutMs: opts.helloTimeoutMs } : {}),
  });
  return h;
}

const env = (id: string, type = "events_api", extra: Record<string, unknown> = {}): SocketEnvelope => ({
  envelope_id: id,
  type,
  payload: { event_id: `Ev-${id}` },
  ...extra,
});

test("hello establishes the connection; envelopes are acked before they are processed", async () => {
  const h = harness();
  const ac = new AbortController();
  let ackedAtProcessing = -1;
  h.mode = new SocketMode({
    ...(harnessOpts(h)),
    onEnvelope: (e) => {
      ackedAtProcessing = h.sockets[0]!.sent.length;
      h.processed.push(String(e.envelope_id));
    },
  });
  await h.mode.start(ac.signal);
  assert.equal(h.mode.connected, true);
  h.sockets[0]!.serverPush(env("e1"));
  await until(() => h.processed.length === 1);
  assert.equal(ackedAtProcessing, 1, "ack was sent before processing");
  assert.deepEqual(h.sockets[0]!.ackedIds(), ["e1"]);
  ac.abort();
  await h.mode.stop();
});

function harnessOpts(h: Harness) {
  return {
    openUrl: async () => {
      h.opens++;
      const next = h.failOpen.shift();
      if (next && next !== "ok") throw next;
      const url = `wss://wss.fake-slack.test/link/?ticket=T${h.opens}`;
      h.urls.push(url);
      return url;
    },
    socketFactory: (url: string) => {
      const s = new FakeSocket(url, true);
      h.sockets.push(s);
      queueMicrotask(() => s.open());
      return s as SocketLike;
    },
    onEnvelope: () => {},
    onFatal: (e: SocketFatalError) => h.fatal.push(e),
    onState: (c: boolean) => h.states.push(c),
    log: () => {},
    sleep: async (ms: number) => {
      h.sleeps.push(ms);
    },
    random: () => 0.5,
    now: () => 0,
  };
}

test("duplicate envelope ids are acked again but processed once", async () => {
  const h = harness();
  const ac = new AbortController();
  await h.mode.start(ac.signal);
  const s = h.sockets[0]!;
  s.serverPush(env("dup"));
  s.serverPush(env("dup", "events_api", { retry_attempt: 1 }));
  await until(() => s.sent.length === 2);
  assert.equal(h.processed.length, 1);
  assert.deepEqual(s.ackedIds(), ["dup", "dup"]);
  ac.abort();
  await h.mode.stop();
});

test("malformed frames and envelopes without ids are ignored, not acked", async () => {
  const h = harness();
  const ac = new AbortController();
  await h.mode.start(ac.signal);
  const s = h.sockets[0]!;
  s.serverSend({ type: "events_api" });
  (s as unknown as { emitRaw: unknown }).emitRaw = undefined;
  s.serverPush({ type: "events_api", envelope_id: "bad id with spaces" } as SocketEnvelope);
  await until(() => s.sent.length === 0 && h.processed.length === 0, "quiet");
  assert.deepEqual(s.sent, []);
  ac.abort();
  await h.mode.stop();
});

test("disconnect with refresh_requested reconnects with a fresh URL, overlapping the old socket", async () => {
  const h = harness();
  const ac = new AbortController();
  let oldOpenWhenReplacementCreated: boolean | undefined;
  h.mode = new SocketMode({
    ...harnessOpts(h),
    socketFactory: (url: string) => {
      if (h.sockets.length === 1) oldOpenWhenReplacementCreated = !h.sockets[0]!.closed;
      const s = new FakeSocket(url, true);
      h.sockets.push(s);
      queueMicrotask(() => s.open());
      return s as SocketLike;
    },
    onEnvelope: (e: SocketEnvelope) => {
      h.processed.push(String(e.envelope_id));
    },
  });
  await h.mode.start(ac.signal);
  const old = h.sockets[0]!;
  old.serverSend({ type: "disconnect", reason: "refresh_requested" });
  await until(() => h.sockets.length === 2 && h.urls.length === 2, "replacement");
  assert.notEqual(h.urls[0], h.urls[1], "fresh URL");
  assert.equal(oldOpenWhenReplacementCreated, true, "old socket still open when the replacement was created");
  await until(() => old.closed, "old socket closed after replacement adopted");
  old.serverPush(env("late"));
  assert.equal(h.processed.length, 0, "closed socket delivers nothing");
  h.sockets[1]!.serverPush(env("new-1"));
  await until(() => h.processed.includes("new-1"));
  ac.abort();
  await h.mode.stop();
});

test("disconnect with warning is treated like a refresh request", async () => {
  const h = harness();
  const ac = new AbortController();
  await h.mode.start(ac.signal);
  h.sockets[0]!.serverSend({ type: "disconnect", reason: "warning" });
  await until(() => h.sockets.length === 2, "replacement socket");
  ac.abort();
  await h.mode.stop();
});

test("unexpected close reconnects after exponential backoff with jitter", async () => {
  const h = harness({ random: 0 });
  const ac = new AbortController();
  await h.mode.start(ac.signal);
  h.sockets[0]!.serverDrop();
  await until(() => h.sockets.length === 2 && h.sockets[1]!.url !== "", "reconnect");
  assert.deepEqual(h.sleeps, [750], "first retry waits 1 s base with -25% jitter");
  assert.deepEqual(h.states, [true, false, true]);
  ac.abort();
  await h.mode.stop();
});

test("retryable connect failures back off exponentially with clamped rate-limit hints", async () => {
  const h = harness({ random: 0.5 });
  const ac = new AbortController();
  h.failOpen = [new SlackApiError("http", "x", { status: 503 }), new SlackApiError("rate-limited", "x", { retryAfterMs: 5000 }), new SlackApiError("network", "x"), "ok"];
  await h.mode.start(ac.signal);
  await until(() => h.sockets.length === 1 && h.opens === 4, "fourth attempt succeeds");
  assert.deepEqual(h.sleeps, [1000, 5000, 4000]);
  ac.abort();
  await h.mode.stop();
});

test("invalid_auth on connect is fatal: start rejects, no retry storm", async () => {
  const h = harness();
  const ac = new AbortController();
  h.failOpen = [new SlackApiError("unauthorized", "x", { code: "invalid_auth" })];
  await assert.rejects(h.mode.start(ac.signal), (e: unknown) => e instanceof SocketFatalError && e.code === "invalid_auth");
  assert.equal(h.opens, 1);
  assert.deepEqual(h.sleeps, []);
  ac.abort();
  await h.mode.stop();
});

test("fatal codes during a running session stop the loop and report exactly once", async () => {
  for (const code of ["account_inactive", "token_revoked"]) {
    const h = harness();
    const ac = new AbortController();
    await h.mode.start(ac.signal);
    h.failOpen = [new SlackApiError("unauthorized", "x", { code })];
    h.sockets[0]!.serverDrop();
    await until(() => h.fatal.length === 1, code);
    assert.equal(h.fatal[0]!.code, code);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.opens, 2, `${code}: exactly one reconnect attempt`);
    ac.abort();
    await h.mode.stop();
  }
});

test("disconnect with link_disabled is fatal", async () => {
  const h = harness();
  const ac = new AbortController();
  await h.mode.start(ac.signal);
  h.sockets[0]!.serverSend({ type: "disconnect", reason: "link_disabled" });
  await until(() => h.fatal.length === 1, "fatal");
  assert.equal(h.fatal[0]!.code, "link_disabled");
  ac.abort();
  await h.mode.stop();
});

test("stop aborts the loop: no further connects, and the socket is closed", async () => {
  const h = harness();
  const ac = new AbortController();
  await h.mode.start(ac.signal);
  ac.abort();
  await h.mode.stop();
  assert.equal(h.sockets[0]!.closed, true);
  h.sockets[0]!.serverDrop();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.opens, 1);
  assert.equal(h.mode.connected, false);
});

test("a connection that never says hello is abandoned and retried", async () => {
  const h = harness({ helloTimeoutMs: 1 });
  h.mode = new SocketMode({
    ...harnessOpts(h),
    socketFactory: (url) => {
      const s = new FakeSocket(url, false);
      h.sockets.push(s);
      queueMicrotask(() => s.open());
      return s as SocketLike;
    },
    helloTimeoutMs: 1,
  });
  const ac = new AbortController();
  const first = await h.mode.start(ac.signal).then(() => "resolved", () => "rejected");
  assert.equal(first, "resolved", "retryable failure keeps start resolving");
  assert.equal(h.mode.connected, false);
  ac.abort();
  await h.mode.stop();
});

test("SocketFatalError never carries a ticket or URL", () => {
  const e = new SocketFatalError("invalid_auth");
  assert.doesNotMatch(e.message + e.code, /wss:|ticket|xapp/i);
});
