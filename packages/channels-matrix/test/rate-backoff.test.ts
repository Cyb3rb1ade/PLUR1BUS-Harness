import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { MAX_RETRY_AFTER_MS, MIN_RETRY_AFTER_MS, MatrixApiError, TokenBucket, type MatrixChannelOptions } from "../src/index.ts";
import { makeCatalogueHarness, type CatalogueHarness } from "./helpers/catalogue.ts";
import { FakeMatrix, ROOM } from "./helpers/fake-matrix.ts";
import { Rig, newFake } from "./helpers/rig.ts";

// Rate limits and backoff of the Matrix channel (docs/channels/matrix.md section 10), against the in-process homeserver fake.
// Nothing here waits on a wall clock: every wait goes through the injected `sleep` seam, which records the milliseconds it was
// asked for and can park the caller until the test releases it ("no earlier retry" is proven by looking at the requests that
// reached the fake while the wait is parked).
//
// Constants under test (the product is the source of truth; they are repeated here so a silent change fails a test):
//   DEFAULT_RETRY_AFTER_MS = 1_000                      src/api.ts:40, applied by clampRetryAfter (src/api.ts:58)
//   MIN/MAX_RETRY_AFTER_MS = 1_000 / 300_000            src/api.ts:38-39 (clamp band of a server-dictated wait)
//   send retries: `maxSendRetries ?? 3`                 src/channel.ts:834 (attempts = limit + 1)
//   send backoff: min(60_000, 1000 * 2 ** attempt) * (0.75 + random * 0.5)      src/channel.ts:848
//   rate-limited wait (send and /sync): the clamped retryAfterMs, never the backoff   src/channel.ts:846-847 and 476-478
//   /sync backoff: 1000, doubling, capped at 60_000, same jitter, reset by a good poll    src/channel.ts:462, 475-479
//
// Sends use a Rig with a virtual clock (`now` and `sleep` injected together) instead of the catalogue harness. Reason: every send
// attempt first takes a token from the per-room bucket (1 per second, src/channel.ts:816), and the catalogue harness reads the
// real Date.now, so its recorded sleeps would also contain a refill wait of 995 to 1000 ms before each retry. With one virtual
// clock that advances by exactly the slept time, the bucket is always full on a retry and the seam sees the retry waits only.
// The /sync loop takes no tokens, so those tests use the catalogue harness as it is.
//
// Overlaps (each test below only adds what these do not pin):
//   outbound.test.ts: 429 hint is waited (includes), 0 and huge hints are clamped (includes), 503 retried with the same txn, 400 and 403 once.
//   lifecycle.test.ts and contract-catalogue.test.ts e): /sync 503 backs off 1000, 2000 and /sync 429 waits 3000 (two failures only).
//   api.test.ts: the clamp function and the error kinds on their own (no channel, no seam).
// Not covered: /sync 403 (the catalogue pins nothing about it), and the wait order when 429 and 5xx are mixed in one sequence.

const SYNC = "/_matrix/client/v3/sync";
/** Failure prefix for the send PUTs; the only PUTs these tests make are sends. */
const ROOM_PUT = "/_matrix/client/v3/rooms/";

const limited = (retryAfterMs?: number): Record<string, unknown> => ({
  errcode: "M_LIMIT_EXCEEDED",
  error: "slow",
  ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
});

const sendCalls = (fake: FakeMatrix) => fake.calls.filter((c) => c.method === "PUT" && c.path.includes("/send/"));

function failSends(fake: FakeMatrix, status: number, count: number, body: Record<string, unknown>): void {
  for (let i = 0; i < count; i++) fake.failNext("PUT", ROOM_PUT, status, body);
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Resolves once pred() holds. The 5 s bound is a failure guard only; a healthy run resolves within milliseconds. */
async function until(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Lets queued work and a few loopback round trips run, so a request that was wrongly sent early would already have reached the fake. */
async function quiesce(fake: FakeMatrix): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await tick();
    await fetch(`${fake.baseUrl}/_probe`).then((r) => r.arrayBuffer());
  }
}

interface Outcome {
  done: boolean;
  error: unknown;
  wait: Promise<void>;
}
/** Follows a promise without ever rejecting (a send that is torn down by cleanup must not become an unhandled rejection). */
function settle(p: Promise<unknown>): Outcome {
  const o: Outcome = { done: false, error: undefined, wait: Promise.resolve() };
  o.wait = p.then(
    () => void (o.done = true),
    (e: unknown) => {
      o.done = true;
      o.error = e;
    },
  );
  return o;
}

// ------------------------------------------------------------------------------------------------ send rig (virtual clock)

interface SendRig {
  rig: Rig;
  fake: FakeMatrix;
  /** Every wait the channel asked the sleep seam for, in milliseconds, in order. */
  sleeps: number[];
  /** While true, a sleep parks until release(); the virtual clock moves only when a sleep is released. */
  hold(on: boolean): void;
  /** Resolves every parked sleep (and advances the virtual clock by what each one asked for). Holding stays as it was. */
  release(): void;
  /**
   * Stops holding, releases whatever is parked and waits for the send to settle. If the channel parked more waits than the test
   * expected, this lets them pass, so the failure is an assertion on the counts and never a hang (the 5 s bound is a failure guard).
   */
  finish(out: Outcome): Promise<void>;
  /** The channel's own `channel.matrix.request-retry` log lines. */
  retryLogs(): { kind: unknown; waitMs: unknown; attempt: unknown }[];
}

const open: SendRig[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.rig.close().catch(() => {});
});

async function makeSendRig(over: Partial<MatrixChannelOptions> = {}): Promise<SendRig> {
  const fake = await newFake();
  let clock = 1_000_000;
  let holding = false;
  const sleeps: number[] = [];
  const parked: Array<() => void> = [];
  const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    sleeps.push(ms);
    if (!holding || signal.aborted) {
      clock += ms;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      parked.push(() => {
        clock += ms;
        resolve();
      });
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
  const rig = new Rig(fake, { now: () => clock, sleep, random: () => 0.5, ...over });
  const s: SendRig = {
    rig,
    fake,
    sleeps,
    hold: (on) => {
      holding = on;
    },
    release: () => {
      for (const r of parked.splice(0)) r();
    },
    finish: async (out) => {
      holding = false;
      for (const r of parked.splice(0)) r();
      await until(() => out.done, "the send settles");
    },
    retryLogs: () =>
      rig.logs
        .map((l) => JSON.parse(l) as { event?: string; attrs?: Record<string, unknown> })
        .filter((l) => l.event === "channel.matrix.request-retry")
        .map((l) => ({ kind: l.attrs?.kind, waitMs: l.attrs?.waitMs, attempt: l.attrs?.attempt })),
  };
  open.push(s);
  await rig.start();
  return s;
}

// ---------------------------------------------------------------------------------- 1) 429 with retry_after_ms (Matrix form)

test("1) send: 429 with retry_after_ms is not retried before the wait the server asked for", async () => {
  const s = await makeSendRig();
  failSends(s.fake, 429, 1, limited(2500));
  s.hold(true);
  const out = settle(s.rig.ch.send({ chatId: ROOM, text: "eventually" }));
  await until(() => s.sleeps.length === 1, "the retry wait is parked");
  assert.deepEqual(s.sleeps, [2500], "the wait is the server's retry_after_ms");
  assert.equal(sendCalls(s.fake).length, 1);
  await quiesce(s.fake);
  assert.equal(sendCalls(s.fake).length, 1, "still one request while the wait is parked");
  assert.equal(out.done, false, "the send has not settled");
  assert.equal(s.fake.sent.length, 0);

  await s.finish(out);
  assert.equal(out.error, undefined);
  assert.equal(sendCalls(s.fake).length, 2, "one retry after the wait");
  assert.equal(new Set(sendCalls(s.fake).map((c) => c.path)).size, 1, "the retry reuses the transaction id");
  assert.equal(s.fake.sent.length, 1);
  assert.deepEqual(s.sleeps, [2500], "exactly one wait");
});

test("1) send: the server's wait is clamped to [1 s, 5 min] before it reaches the sleep seam", async () => {
  assert.equal(MIN_RETRY_AFTER_MS, 1000);
  assert.equal(MAX_RETRY_AFTER_MS, 300_000);
  const hints = [250, 1000, 1001, 299_999, 300_000, 300_001, 99_999_999];
  const want = [1000, 1000, 1001, 299_999, 300_000, 300_000, 300_000];
  const s = await makeSendRig({ maxSendRetries: hints.length });
  for (const h of hints) failSends(s.fake, 429, 1, limited(h));
  await s.rig.ch.send({ chatId: ROOM, text: "clamped" });
  assert.deepEqual(s.sleeps, want);
  assert.equal(sendCalls(s.fake).length, hints.length + 1);
  assert.equal(s.fake.sent.length, 1);
});

// ------------------------------------------------------------------------------------ 2) 429 without retry_after_ms

const noHint: [name: string, body: Record<string, unknown>][] = [
  ["empty JSON object", {}],
  ["errcode only", limited()],
];
for (const [name, body] of noHint) {
  test(`2) send: 429 without retry_after_ms waits the 1 s default (${name})`, async () => {
    const s = await makeSendRig();
    failSends(s.fake, 429, 1, body);
    await s.rig.ch.send({ chatId: ROOM, text: "default" });
    assert.deepEqual(s.sleeps, [1000], "DEFAULT_RETRY_AFTER_MS, src/api.ts:40");
    assert.equal(sendCalls(s.fake).length, 2);
    assert.equal(s.fake.sent.length, 1);
  });
}

// What the fake cannot send (headers, a body that is not JSON): the first send PUT gets a canned answer, the rest reaches the fake.
const canned: [name: string, answer: () => Response, wantWait: number][] = [
  ["body is not JSON, no header: default", () => new Response("<html>slow down</html>", { status: 429 }), 1000],
  ["Retry-After in seconds, no body hint", () => new Response("{}", { status: 429, headers: { "retry-after": "4" } }), 4000],
  [
    "retry_after_ms beats the Retry-After header",
    () => new Response(JSON.stringify(limited(2500)), { status: 429, headers: { "retry-after": "9" } }),
    2500,
  ],
  [
    "Retry-After as an HTTP date is not a number: default",
    () => new Response("{}", { status: 429, headers: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" } }),
    1000,
  ],
];
for (const [name, answer, wantWait] of canned) {
  test(`2) send: 429 wait from the response itself (${name})`, async () => {
    let served = 0;
    const cannedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (served === 0 && init?.method === "PUT" && String(input).includes("/send/")) {
        served++;
        return answer();
      }
      return globalThis.fetch(input, init);
    }) as typeof fetch;
    const s = await makeSendRig({ fetch: cannedFetch });
    await s.rig.ch.send({ chatId: ROOM, text: "canned" });
    assert.equal(served, 1);
    assert.deepEqual(s.sleeps, [wantWait]);
    assert.equal(sendCalls(s.fake).length, 1, "the retry is the only request that reached the fake");
    assert.equal(s.fake.sent.length, 1);
  });
}

// ----------------------------------------------------------------------- 3) and 5) 5xx on sends: backoff, limit, final error

const limits: [limit: number | undefined, attempts: number, waits: number[]][] = [
  [0, 1, []],
  [1, 2, [1000]],
  [2, 3, [1000, 2000]],
  [undefined, 4, [1000, 2000, 4000]], // the default limit is 3 (src/channel.ts:834)
  [5, 6, [1000, 2000, 4000, 8000, 16000]],
];
for (const [limit, attempts, waits] of limits) {
  const label = limit === undefined ? "default limit 3" : `maxSendRetries ${limit}`;
  test(`3/5) send: 503 is retried with doubling backoff, ${label}: ${attempts} attempts, then a defined error and no more requests`, async () => {
    const s = await makeSendRig(limit === undefined ? {} : { maxSendRetries: limit });
    // Three more failures than attempts can ever consume, so a retry beyond the limit would show as a smaller backlog.
    failSends(s.fake, 503, attempts + 2, { errcode: "M_UNKNOWN", error: "busy" });
    s.hold(true);
    const out = settle(s.rig.ch.send({ chatId: ROOM, text: "never lands" }));
    for (let k = 0; k < waits.length; k++) {
      await until(() => s.sleeps.length === k + 1, `wait ${k + 1} is parked`);
      assert.equal(sendCalls(s.fake).length, k + 1, `attempt ${k + 1} has been made`);
      await quiesce(s.fake);
      assert.equal(sendCalls(s.fake).length, k + 1, `attempt ${k + 2} does not start while wait ${k + 1} (${s.sleeps[k]} ms) is parked`);
      s.release();
    }
    await s.finish(out);

    assert.deepEqual(s.sleeps, waits, "jitter factor is exactly 1.0 at random 0.5");
    for (let i = 1; i < s.sleeps.length; i++) assert.ok(s.sleeps[i]! > s.sleeps[i - 1]!, `wait ${i + 1} is longer than wait ${i}`);
    assert.equal(sendCalls(s.fake).length, attempts, "attempts = limit + 1");
    assert.equal(new Set(sendCalls(s.fake).map((c) => c.path)).size, 1, "every attempt reuses one transaction id");
    assert.equal(s.fake.failures.length, 2, "two injected failures were never consumed");
    assert.equal(s.fake.sent.length, 0);
    assert.deepEqual(
      s.retryLogs().map((l) => [l.kind, l.attempt, l.waitMs]),
      waits.map((w, i) => ["http", i, w]),
      "one request-retry log line per wait, attempts counted from 0",
    );

    assert.ok(out.error instanceof MatrixApiError);
    const e = out.error as MatrixApiError;
    assert.equal(e.kind, "http");
    assert.equal(e.message, "send failed with HTTP 503", "fixed text built in src/api.ts:353, no server text");
    assert.equal(e.status, 503);
    assert.equal(e.errcode, "M_UNKNOWN");
    assert.equal(e.retryAfterMs, undefined);

    await quiesce(s.fake);
    assert.equal(sendCalls(s.fake).length, attempts, "nothing is retried after the rejection");
    assert.equal(s.rig.failures.length, 0, "an exhausted send does not fail the channel");
    assert.deepEqual(await s.rig.ch.health(), { ok: true });
  });
}

test("3) send: the backoff keeps doubling and is capped at 60 s", async () => {
  const s = await makeSendRig({ maxSendRetries: 8 });
  failSends(s.fake, 503, 10, { errcode: "M_UNKNOWN", error: "busy" });
  await assert.rejects(s.rig.ch.send({ chatId: ROOM, text: "capped" }), (e: unknown) => e instanceof MatrixApiError && e.kind === "http");
  // 1000 * 2 ** 6 is 64_000, which the cap (src/channel.ts:848) holds at 60_000.
  assert.deepEqual(s.sleeps, [1000, 2000, 4000, 8000, 16000, 32000, 60_000, 60_000]);
  assert.equal(sendCalls(s.fake).length, 9);
  assert.equal(s.fake.failures.length, 1);
});

test("3) send: jitter stays within 75 % to 125 % of each backoff step", async () => {
  // The backoff waits are read from the channel's request-retry log lines. In the sleep seam the first step at random() = 0 is
  // 750 ms followed by a 250 ms top-up: the per-room bucket (1 event per second) does not let two attempts follow each other faster.
  for (const [random, waits, slept] of [
    [0, [750, 1500, 3000], [750, 250, 1500, 3000]],
    [1, [1250, 2500, 5000], [1250, 2500, 5000]],
  ] as const) {
    const s = await makeSendRig({ random: () => random });
    failSends(s.fake, 503, 5, { errcode: "M_UNKNOWN", error: "busy" });
    await assert.rejects(s.rig.ch.send({ chatId: ROOM, text: "jitter" }), (e: unknown) => e instanceof MatrixApiError);
    assert.deepEqual(
      s.retryLogs().map((l) => l.waitMs),
      waits,
      `random() = ${random}`,
    );
    assert.deepEqual(s.sleeps, slept, `random() = ${random}`);
    assert.equal(sendCalls(s.fake).length, 4);
  }
});

test("3) send: 500, 502, 503 and 504 are all retried", async () => {
  const statuses = [500, 502, 503, 504];
  const s = await makeSendRig({ maxSendRetries: statuses.length });
  for (const st of statuses) failSends(s.fake, st, 1, { errcode: "M_UNKNOWN", error: "busy" });
  await s.rig.ch.send({ chatId: ROOM, text: "after four 5xx" });
  assert.deepEqual(s.sleeps, [1000, 2000, 4000, 8000]);
  assert.equal(sendCalls(s.fake).length, statuses.length + 1);
  assert.equal(s.fake.sent.length, 1);
});

test("5) send: a rate limit that never lifts rejects after limit + 1 attempts with kind rate-limited", async () => {
  const s = await makeSendRig();
  failSends(s.fake, 429, 5, limited(2500));
  await assert.rejects(s.rig.ch.send({ chatId: ROOM, text: "throttled" }), (e: unknown) => {
    assert.ok(e instanceof MatrixApiError);
    assert.equal(e.kind, "rate-limited");
    assert.equal(e.message, "send rate limited", "fixed text built in src/api.ts:335");
    assert.equal(e.status, 429);
    assert.equal(e.errcode, "M_LIMIT_EXCEEDED");
    assert.equal(e.retryAfterMs, 2500);
    return true;
  });
  assert.deepEqual(s.sleeps, [2500, 2500, 2500], "a rate limit waits the server's interval each time, it does not double");
  assert.equal(sendCalls(s.fake).length, 4, "attempts = limit + 1 with the default limit 3");
  assert.equal(s.fake.failures.length, 1, "the fifth injected failure was never consumed");
  assert.equal(s.fake.sent.length, 0);
  await quiesce(s.fake);
  assert.equal(sendCalls(s.fake).length, 4, "nothing is retried after the rejection");
});

// ------------------------------------------------------------------------------------------ 4) 4xx other than 429 on sends

const clientErrors: [status: number, errcode: string, kind: string][] = [
  [400, "M_BAD_JSON", "bad-request"],
  [401, "M_UNKNOWN_TOKEN", "unauthorized"],
  [403, "M_FORBIDDEN", "forbidden"],
  [404, "M_NOT_FOUND", "not-found"],
  [409, "M_UNKNOWN", "http"],
  [413, "M_TOO_LARGE", "too-large"],
];
for (const [status, errcode, kind] of clientErrors) {
  // A fresh rig per status: a 403 marks the room inactive for the rest of the run (src/channel.ts:827).
  test(`4) send: HTTP ${status} is not retried: one request, no wait, error kind ${kind}`, async () => {
    const s = await makeSendRig();
    failSends(s.fake, status, 3, { errcode, error: "no" });
    await assert.rejects(s.rig.ch.send({ chatId: ROOM, text: "once" }), (e: unknown) => {
      assert.ok(e instanceof MatrixApiError);
      assert.equal(e.kind, kind);
      assert.equal(e.status, status);
      assert.equal(e.errcode, errcode);
      assert.equal(e.message, `send failed with HTTP ${status}`);
      return true;
    });
    assert.equal(sendCalls(s.fake).length, 1);
    assert.deepEqual(s.sleeps, [], "no backoff wait");
    assert.deepEqual(s.retryLogs(), []);
    assert.equal(s.fake.failures.length, 2, "the other two failures were never consumed");
    await quiesce(s.fake);
    assert.equal(sendCalls(s.fake).length, 1, "nothing is retried later either");
  });
}

test("4) send: a retry_after_ms hint on a status other than 429 does not make it retryable", async () => {
  const s = await makeSendRig();
  failSends(s.fake, 400, 2, { errcode: "M_BAD_JSON", error: "no", retry_after_ms: 5000 });
  await assert.rejects(s.rig.ch.send({ chatId: ROOM, text: "once" }), (e: unknown) => e instanceof MatrixApiError && e.kind === "bad-request");
  assert.equal(sendCalls(s.fake).length, 1);
  assert.deepEqual(s.sleeps, []);
  assert.equal(s.fake.failures.length, 1);
});

// ------------------------------------------------------------------------------------- the channel's own outbound pacing

test("own pacing) a second send to the same room waits out the per-room bucket (1 event per second) before it is sent", async () => {
  const s = await makeSendRig();
  await s.rig.ch.send({ chatId: ROOM, text: "first" });
  assert.deepEqual(s.sleeps, [], "the first send of a room takes a full bucket and is not delayed");
  s.hold(true);
  const out = settle(s.rig.ch.send({ chatId: ROOM, text: "second" }));
  await until(() => s.sleeps.length === 1, "the bucket wait is parked");
  assert.deepEqual(s.sleeps, [1000]);
  assert.equal(sendCalls(s.fake).length, 1);
  await quiesce(s.fake);
  assert.equal(sendCalls(s.fake).length, 1, "the second event is not sent while the bucket wait is parked");
  await s.finish(out);
  assert.equal(out.error, undefined);
  assert.equal(sendCalls(s.fake).length, 2);
  assert.deepEqual(
    s.fake.sent.map((m) => m.content.body),
    ["first", "second"],
  );
});

// --------------------------------------------------------------------------------------------------- the /sync loop's backoff

async function withHarness(body: (h: CatalogueHarness) => Promise<void>): Promise<void> {
  const h = await makeCatalogueHarness();
  try {
    await body(h);
  } finally {
    await h.dispose();
  }
}

const syncFailed = (h: CatalogueHarness) => h.logs.filter((l) => l.event === "channel.matrix.sync-failed").map((l) => l.attrs);

// The loop has no attempt limit by design (an inbound loop must outlive an outage), so "limit + 1" applies to sends only. A bounded
// run is a finite queue of failures: the loop meets all of them, then parks on a long poll.
test("3) /sync: 5xx backs off 1 s, doubling, capped at 60 s, without ever calling host.fail", async () => {
  await withHarness(async (h) => {
    const statuses = [500, 502, 503, 504, 500, 502, 503, 504, 500];
    for (const st of statuses) h.fake.failNext("GET", SYNC, st, { errcode: "M_UNKNOWN", error: "busy" });
    await h.start();
    const want = [1000, 2000, 4000, 8000, 16000, 32000, 60_000, 60_000, 60_000];
    assert.deepEqual(h.sleeps, want, "1000 * 2 ** 6 is 64_000, held at 60_000 (src/channel.ts:475)");
    for (let i = 1; i < 7; i++) assert.ok(h.sleeps[i]! > h.sleeps[i - 1]!, `wait ${i + 1} is longer than wait ${i}`);
    assert.equal(h.fake.syncs.length, statuses.length + 1, "every failed poll, then the poll the loop is parked on");
    assert.equal(h.fake.failures.length, 0);
    assert.deepEqual(
      syncFailed(h).map((a) => [a.kind, a.status, a.waitMs]),
      statuses.map((st, i) => ["http", st, want[i]]),
    );
    assert.equal(h.failures.length, 0);
    assert.deepEqual(await h.channel.health(), { ok: true });
  });
});

test("3) /sync: a good poll resets the backoff to 1 s", async () => {
  await withHarness(async (h) => {
    h.fake.failNext("GET", SYNC, 503, { errcode: "M_UNKNOWN", error: "busy" });
    h.fake.failNext("GET", SYNC, 503, { errcode: "M_UNKNOWN", error: "busy" });
    await h.start();
    assert.deepEqual(h.sleeps, [1000, 2000]);
    // The loop is parked on a long poll now; the failure is met by the poll that follows the delivered batch.
    h.fake.failNext("GET", SYNC, 503, { errcode: "M_UNKNOWN", error: "busy" });
    await h.fake.deliver(ROOM, [h.event("recovered")]);
    assert.deepEqual(h.sleeps, [1000, 2000, 1000], "the step after the good poll starts again at 1 s, not at 4 s");
    assert.deepEqual(
      h.received.map((m) => m.text),
      ["recovered"],
    );
    assert.equal(h.failures.length, 0);
  });
});

test("1) /sync: 429 does not poll again before the server's retry_after_ms has been waited out", async () => {
  await withHarness(async (h) => {
    h.fake.failNext("GET", SYNC, 429, limited(3000));
    h.setHoldSleeps(true);
    // Not h.start(): the loop parks in its backoff, never on a long poll, so the harness's wait for an idle poll would time out.
    await h.channel.start(h.host);
    await h.waitFor(() => h.sleeps.length === 1, "the retry wait is parked");
    assert.deepEqual(h.sleeps, [3000]);
    assert.equal(h.fake.syncs.length, 1);
    await quiesce(h.fake);
    assert.equal(h.fake.syncs.length, 1, "no second poll while the wait is parked");
    assert.equal(h.failures.length, 0);

    h.setHoldSleeps(false);
    h.releaseSleeps();
    await h.fake.waitIdle();
    assert.equal(h.fake.syncs.length, 2, "one poll after the wait, now held open");
    assert.deepEqual(h.sleeps, [3000]);
    assert.equal(h.failures.length, 0);
  });
});

test("1/2) /sync: 429 waits the clamped server interval, and the 1 s default when there is no retry_after_ms", async () => {
  await withHarness(async (h) => {
    for (const body of [{}, limited(), limited(250), limited(99_999_999)]) h.fake.failNext("GET", SYNC, 429, body);
    await h.start();
    assert.deepEqual(h.sleeps, [1000, 1000, 1000, 300_000], "default, default, clamped up, clamped down");
    assert.deepEqual(
      syncFailed(h).map((a) => [a.kind, a.status, a.waitMs]),
      [
        ["rate-limited", 429, 1000],
        ["rate-limited", 429, 1000],
        ["rate-limited", 429, 1000],
        ["rate-limited", 429, 300_000],
      ],
    );
    assert.equal(h.failures.length, 0);
  });
});

// -------------------------------------------------------------------------------------------- TokenBucket (src/rate-limit.ts)

/** A bucket on a virtual clock; sleeping advances the clock, as the file header of src/rate-limit.ts expects. */
function bucket(capacity: number, intervalMs: number) {
  const state = { clock: 0, waits: [] as number[] };
  const sleep = async (ms: number): Promise<void> => {
    state.waits.push(ms);
    state.clock += ms;
  };
  return { state, bucket: new TokenBucket(capacity, intervalMs, () => state.clock, sleep) };
}

test("bucket: the full capacity is free, then each token costs one interval; refill is proportional to elapsed time", async () => {
  const { state, bucket: b } = bucket(2, 1000);
  const signal = new AbortController().signal;
  await b.take(signal);
  await b.take(signal);
  assert.deepEqual(state.waits, [], "two tokens, two free takes");
  await b.take(signal);
  assert.deepEqual(state.waits, [1000], "an empty bucket waits one full interval");
  state.clock += 250;
  await b.take(signal);
  assert.deepEqual(state.waits, [1000, 750], "a quarter interval has refilled a quarter token, so three quarters remain to wait");
});

test("bucket: idle time never refills past the capacity", async () => {
  const { state, bucket: b } = bucket(2, 1000);
  const signal = new AbortController().signal;
  await b.take(signal);
  await b.take(signal);
  state.clock += 1_000_000;
  await b.take(signal);
  await b.take(signal);
  assert.deepEqual(state.waits, [], "two tokens are back after a long idle");
  await b.take(signal);
  assert.deepEqual(state.waits, [1000], "but not three");
});

test("bucket: concurrent takes are serialized, so none of them spends a token another one holds", async () => {
  const { state, bucket: b } = bucket(1, 1000);
  const signal = new AbortController().signal;
  await Promise.all([b.take(signal), b.take(signal), b.take(signal)]);
  assert.deepEqual(state.waits, [1000, 1000], "one free token, then one interval for each of the other two");
  assert.equal(state.clock, 2000);
});

test("bucket: an aborted take rejects without spending a token or blocking the next one", async () => {
  const { state, bucket: b } = bucket(1, 1000);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(b.take(aborted.signal), { name: "AbortError" });
  await b.take(new AbortController().signal);
  assert.deepEqual(state.waits, [], "the token the aborted take did not spend is still there");
});
