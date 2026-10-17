import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { MemoryOffsetStore, TelegramApi, TelegramApiError, TelegramChannel } from "../src/index.ts";
import { MAX_RETRY_AFTER_MS, MIN_RETRY_AFTER_MS } from "../src/api.ts";
import type { ChannelHost } from "../../core/src/channels/types.ts";
import { FakeTelegram, FAKE_TELEGRAM_TOKEN, textUpdate } from "./helpers/fake-telegram.ts";

/*
 * Step 5: rate limit and backoff. Every number below is taken from the product code or docs/channels/telegram.md:
 *
 *   retry_after clamp         [1 s, 5 min]      src/api.ts:87-88 (MIN/MAX_RETRY_AFTER_MS), applied at src/api.ts:226-229
 *   default 429 wait          1000 ms           src/api.ts:227-229: no retry_after in the body and no Retry-After header ->
 *                                               Number(null) = 0 -> clamped up to MIN_RETRY_AFTER_MS. The `?? 1000` at
 *                                               src/channel.ts:446 and :502 is a second layer that api.ts never lets fire.
 *   send retry limit          3 (default)       src/channel.ts:496 `maxSendRetries ?? 3`, docs/channels/telegram.md:73
 *   send retry kinds          rate-limited, network, timeout        src/channel.ts:495
 *   send backoff              min(60 s, 1 s * 2^attempt) * (0.75 + random * 0.5)   src/channel.ts:503; random 0.5 -> factor 1
 *   poll backoff              min(60 s, 1 s, 2 s, 4 s, ...) * the same jitter, no attempt limit   src/channel.ts:443-447
 *   poll stops without retry  unauthorized and forbidden (HTTP 401, 403, 404)   src/channel.ts:437-442
 *   limit reached             TelegramApiError (name "TelegramApiError"), the last attempt's error is rethrown   src/channel.ts:493-499
 *
 * Time is virtual: `now` is a fake clock that only moves when a sleep resolves, so the token buckets never add waits of their
 * own and `waits` holds exactly the retry and backoff waits. The hold seam parks a sleep until release(), which proves that
 * nothing is requested before the wait is over. There is no real sleeping; the only timer is a 5 s failure guard.
 */

const CHAT = "42";
const DEFAULT_SEND_RETRIES = 3;

interface LogLine {
  level: string;
  event: string;
  attrs: Record<string, unknown>;
}

/** Let every microtask and a few event-loop turns run, so a premature request would have reached the fetch seam. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await tick();
}

/** Resolves once pred() holds; rejects after 5 s (failure guard only). */
function waitFor(pred: () => boolean, what: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (!pred()) return;
      clearInterval(recheck);
      clearTimeout(guard);
      resolve();
    };
    const recheck = setInterval(check, 1);
    const guard = setTimeout(() => {
      clearInterval(recheck);
      reject(new Error(`timeout: ${what}`));
    }, 5000);
    check();
  });
}

/** Keeps a send that is still pending when a test fails from becoming an unhandled rejection; the original stays awaitable. */
function track<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

/**
 * A fresh Bot API fake per test: a request of a stopped channel that is still in flight must never reach, and consume a
 * scripted failure of, the next test.
 */
async function makeRig(opts: { mode?: "polling" | "webhook"; maxSendRetries?: number } = {}) {
  const fake = new FakeTelegram();
  await fake.listen();
  let clock = 1_000_000;
  let hold = false;
  const waits: number[] = [];
  const parked: Array<() => void> = [];
  const requests: { method: string; at: number }[] = [];
  const networkDown = new Map<string, number>();
  const logs: LogLine[] = [];
  const failures: unknown[] = [];
  const received: unknown[] = [];

  // Records every request at the client, before it can fail or reach the fake, together with the virtual time of the request.
  const fetchSeam: typeof fetch = async (input, init) => {
    const method = /\/bot[^/]+\/(\w+)$/.exec(String(input))?.[1] ?? "file";
    requests.push({ method, at: clock });
    const left = networkDown.get(method) ?? 0;
    if (left > 0) {
      networkDown.set(method, left - 1);
      throw new TypeError("fetch failed");
    }
    return fetch(input, init);
  };

  const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    waits.push(ms);
    if (!hold) {
      clock += ms;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (advance: boolean) => {
        if (done) return;
        done = true;
        if (advance) clock += ms;
        resolve();
      };
      parked.push(() => finish(true));
      signal.addEventListener("abort", () => finish(false), { once: true });
    });
  };

  const channel = new TelegramChannel({
    tokenSecret: "telegram/bot",
    secrets: { reveal: async () => FAKE_TELEGRAM_TOKEN },
    allowlist: [Number(CHAT)],
    offsetStore: new MemoryOffsetStore(),
    logger: { log: (level, event, attrs) => void logs.push({ level, event, attrs: { ...attrs } }) },
    baseUrl: fake.baseUrl,
    fetch: fetchSeam,
    sleep,
    now: () => clock,
    random: () => 0.5,
    pollTimeoutSec: 1,
    ...(opts.mode === "polling" ? {} : { mode: "webhook" as const, webhook: { url: "https://example.test/telegram", secret: "test_webhook_secret" } }),
    ...(opts.maxSendRetries !== undefined ? { maxSendRetries: opts.maxSendRetries } : {}),
  });
  const host: ChannelHost = {
    receive: async (msg) => void received.push(msg),
    fail: (err) => void failures.push(err),
    log: { info() {}, warn() {}, error() {} },
  };
  const ofMethod = (method: string) => requests.filter((r) => r.method === method);

  return {
    fake,
    channel,
    host,
    waits,
    logs,
    failures,
    received,
    count: (method: string) => ofMethod(method).length,
    /** Virtual time of the n-th request of a method. */
    at: (method: string, n: number) => ofMethod(method)[n]!.at,
    elapsed: () => clock - 1_000_000,
    setHold: (on: boolean) => {
      hold = on;
    },
    parkedCount: () => parked.length,
    /** Resolve every parked sleep (the virtual clock advances by its wait); hold stays as set. */
    release: () => {
      for (const go of parked.splice(0)) go();
    },
    /** Make the next `times` requests of a method fail at transport level (no connection). */
    failNetwork: (method: string, times: number) => {
      networkDown.set(method, times);
    },
    pendingNetworkFailures: (method: string) => networkDown.get(method) ?? 0,
    deliver: (id: number, text: string) => fake.push(textUpdate(id, Number(CHAT), text)),
    dispose: async () => {
      hold = false;
      for (const go of parked.splice(0)) go();
      await channel.stop();
      await fake.close();
    },
  };
}
type Rig = Awaited<ReturnType<typeof makeRig>>;

const tooMany = (retryAfter?: unknown) => ({
  ok: false,
  error_code: 429,
  description: "Too Many Requests",
  ...(retryAfter !== undefined ? { parameters: { retry_after: retryAfter } } : {}),
});
const serverError = (status: number) => ({ ok: false, error_code: status, description: `Server Error ${status}` });

/** Predicate for assert.rejects: a TelegramApiError of this kind with exactly this message. */
function apiError(kind: string, message: string, extra: { status?: number; retryAfterMs?: number } = {}) {
  return (e: unknown): boolean => {
    assert.ok(e instanceof TelegramApiError, `expected a TelegramApiError, got ${String(e)}`);
    assert.equal(e.name, "TelegramApiError");
    assert.equal(e.kind, kind);
    assert.equal(e.message, message);
    if (extra.status !== undefined) assert.equal(e.status, extra.status);
    if (extra.retryAfterMs !== undefined) assert.equal(e.retryAfterMs, extra.retryAfterMs);
    return true;
  };
}

const retryLogs = (rig: Rig) => rig.logs.filter((l) => l.event === "channel.telegram.request-retry");
const pollLogs = (rig: Rig) => rig.logs.filter((l) => l.event === "channel.telegram.poll-failed");

// ---------------------------------------------------------------------------------------------------------------------
// 1. 429 with retry_after: no retry before the wait the server asked for
// ---------------------------------------------------------------------------------------------------------------------

test("the clamp band is 1 s to 5 min", () => {
  assert.equal(MIN_RETRY_AFTER_MS, 1000);
  assert.equal(MAX_RETRY_AFTER_MS, 300_000);
});

test("send: 429 retry_after=7 parks the retry; nothing is requested until the 7 s wait is released", async () => {
  const rig = await makeRig();
  try {
    await rig.channel.start(rig.host);
    rig.fake.failNext("sendMessage", 429, tooMany(7));
    rig.setHold(true);
    const sent = track(rig.channel.send(CHAT, "hi"));
    await waitFor(() => rig.waits.length === 1, "retry wait requested");
    assert.deepEqual(rig.waits, [7000]);
    assert.equal(rig.count("sendMessage"), 1);
    await settle();
    assert.equal(rig.count("sendMessage"), 1, "no sendMessage while the retry wait is parked");
    assert.equal(rig.parkedCount(), 1);
    rig.release();
    assert.equal((await sent).length, 1);
    assert.equal(rig.count("sendMessage"), 2);
    assert.ok(rig.at("sendMessage", 1) - rig.at("sendMessage", 0) >= 7000, "the retry is at least 7 s after the 429");
    assert.deepEqual(rig.waits, [7000], "only the server's wait, no extra bucket wait");
  } finally {
    await rig.dispose();
  }
});

test("send: each 429 is waited out with its own retry_after (2 s, 5 s, 9 s), never earlier", async () => {
  const rig = await makeRig();
  try {
    await rig.channel.start(rig.host);
    const asked = [2, 5, 9];
    for (const s of asked) rig.fake.failNext("sendMessage", 429, tooMany(s));
    rig.setHold(true);
    const sent = track(rig.channel.send(CHAT, "hi"));
    for (const [i, s] of asked.entries()) {
      await waitFor(() => rig.waits.length === i + 1, `wait ${i + 1} requested`);
      assert.equal(rig.waits[i], s * 1000);
      assert.equal(rig.count("sendMessage"), i + 1);
      await settle();
      assert.equal(rig.count("sendMessage"), i + 1, `no request while the ${s} s wait is parked`);
      rig.release();
    }
    assert.equal((await sent).length, 1);
    assert.equal(rig.count("sendMessage"), 4);
    for (const [i, s] of asked.entries())
      assert.ok(rig.at("sendMessage", i + 1) - rig.at("sendMessage", i) >= s * 1000, `retry ${i + 1} came after ${s} s`);
    assert.deepEqual(rig.waits, [2000, 5000, 9000]);
  } finally {
    await rig.dispose();
  }
});

test("poll: 429 retry_after=7 parks the next getUpdates; nothing is requested until the wait is released", async () => {
  const rig = await makeRig({ mode: "polling" });
  try {
    rig.fake.failNext("getUpdates", 429, tooMany(7));
    rig.setHold(true);
    await rig.channel.start(rig.host);
    await waitFor(() => rig.waits.length === 1, "poll wait requested");
    assert.deepEqual(rig.waits, [7000]);
    assert.equal(rig.count("getUpdates"), 1);
    await settle();
    assert.equal(rig.count("getUpdates"), 1, "no getUpdates while the poll wait is parked");
    assert.equal(rig.parkedCount(), 1);
    rig.release();
    await waitFor(() => rig.count("getUpdates") === 2, "second getUpdates after release");
    assert.ok(rig.at("getUpdates", 1) - rig.at("getUpdates", 0) >= 7000, "the next poll is at least 7 s after the 429");
    assert.deepEqual(rig.waits, [7000]);
    assert.deepEqual(
      pollLogs(rig).map((l) => [l.attrs.kind, l.attrs.waitMs]),
      [["rate-limited", 7000]],
    );
  } finally {
    await rig.dispose();
  }
});

// A server value outside the band is clamped before the channel sleeps on it (src/api.ts:226-229).
const clampCases: [string, unknown, number][] = [
  ["0 s", 0, MIN_RETRY_AFTER_MS],
  ["0.4 s", 0.4, MIN_RETRY_AFTER_MS],
  ["1 s", 1, 1000],
  ["1.5 s", 1.5, 1500],
  ["7 s", 7, 7000],
  ['the string "7"', "7", 7000],
  ["300 s (upper edge)", 300, MAX_RETRY_AFTER_MS],
  ["301 s", 301, MAX_RETRY_AFTER_MS],
  ["86400 s", 86_400, MAX_RETRY_AFTER_MS],
  ["a negative value", -5, MIN_RETRY_AFTER_MS],
  ["a non-numeric value", "soon", MIN_RETRY_AFTER_MS],
];

async function rateLimitedBy(body: unknown, headers: Record<string, string> = {}): Promise<TelegramApiError> {
  const api = new TelegramApi({
    token: FAKE_TELEGRAM_TOKEN,
    baseUrl: "http://bot.invalid",
    fetch: async () =>
      new Response(JSON.stringify(body), { status: 429, headers: { "content-type": "application/json", ...headers } }),
  });
  try {
    await api.sendMessage(CHAT, "x", new AbortController().signal);
  } catch (e) {
    assert.ok(e instanceof TelegramApiError, "a 429 surfaces as TelegramApiError");
    return e;
  }
  return assert.fail("a 429 must reject");
}

test("TelegramApi clamps a server retry_after into [1 s, 5 min]", async () => {
  for (const [label, raw, expected] of clampCases) {
    const e = await rateLimitedBy(tooMany(raw));
    assert.equal(e.kind, "rate-limited", label);
    assert.equal(e.status, 429, label);
    assert.equal(e.message, "sendMessage rate limited", label);
    assert.equal(e.retryAfterMs, expected, `retry_after ${label}`);
  }
});

test("TelegramApi takes a Retry-After header only when the body has no retry_after", async () => {
  assert.equal((await rateLimitedBy(tooMany(), { "retry-after": "7" })).retryAfterMs, 7000);
  assert.equal((await rateLimitedBy(tooMany(3), { "retry-after": "9" })).retryAfterMs, 3000);
  assert.equal((await rateLimitedBy(tooMany(), { "retry-after": "86400" })).retryAfterMs, MAX_RETRY_AFTER_MS);
});

for (const [label, raw, expected] of [
  ["0 s is raised to the 1 s floor", 0, MIN_RETRY_AFTER_MS],
  ["86400 s is cut to the 5 min ceiling", 86_400, MAX_RETRY_AFTER_MS],
] as const) {
  test(`send: retry_after ${label}; the retry waits the clamped time`, async () => {
    const rig = await makeRig();
    try {
      await rig.channel.start(rig.host);
      rig.fake.failNext("sendMessage", 429, tooMany(raw));
      rig.setHold(true);
      const sent = track(rig.channel.send(CHAT, "hi"));
      await waitFor(() => rig.waits.length === 1, "retry wait requested");
      assert.deepEqual(rig.waits, [expected]);
      await settle();
      assert.equal(rig.count("sendMessage"), 1);
      rig.release();
      await sent;
      assert.equal(rig.count("sendMessage"), 2);
      assert.ok(rig.at("sendMessage", 1) - rig.at("sendMessage", 0) >= expected);
    } finally {
      await rig.dispose();
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. 429 without retry_after: the documented default is MIN_RETRY_AFTER_MS = 1000 ms (src/api.ts:87, 227-229)
// ---------------------------------------------------------------------------------------------------------------------

test("TelegramApi: a 429 without retry_after and without Retry-After header carries the 1 s default", async () => {
  assert.equal(MIN_RETRY_AFTER_MS, 1000);
  const e = await rateLimitedBy({ ok: false, error_code: 429, description: "Too Many Requests" });
  assert.equal(e.retryAfterMs, 1000);
  assert.equal((await rateLimitedBy({})).retryAfterMs, 1000, "an empty body is treated the same");
});

test("send: a 429 without retry_after waits the 1 s default before retrying", async () => {
  const rig = await makeRig();
  try {
    await rig.channel.start(rig.host);
    rig.fake.failNext("sendMessage", 429, tooMany());
    rig.setHold(true);
    const sent = track(rig.channel.send(CHAT, "hi"));
    await waitFor(() => rig.waits.length === 1, "retry wait requested");
    assert.deepEqual(rig.waits, [MIN_RETRY_AFTER_MS]);
    await settle();
    assert.equal(rig.count("sendMessage"), 1, "no request while the default wait is parked");
    rig.release();
    assert.equal((await sent).length, 1);
    assert.equal(rig.count("sendMessage"), 2);
    assert.ok(rig.at("sendMessage", 1) - rig.at("sendMessage", 0) >= 1000);
    assert.deepEqual(rig.waits, [1000]);
  } finally {
    await rig.dispose();
  }
});

test("poll: a 429 without retry_after waits the 1 s default before the next getUpdates", async () => {
  const rig = await makeRig({ mode: "polling" });
  try {
    rig.fake.failNext("getUpdates", 429, tooMany());
    rig.setHold(true);
    await rig.channel.start(rig.host);
    await waitFor(() => rig.waits.length === 1, "poll wait requested");
    assert.deepEqual(rig.waits, [MIN_RETRY_AFTER_MS]);
    await settle();
    assert.equal(rig.count("getUpdates"), 1, "no getUpdates while the default wait is parked");
    rig.release();
    await waitFor(() => rig.count("getUpdates") === 2, "second getUpdates after release");
    assert.ok(rig.at("getUpdates", 1) - rig.at("getUpdates", 0) >= 1000);
  } finally {
    await rig.dispose();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Transient failures are retried with growing backoff up to the limit; polling backs off without a limit but with a cap
// ---------------------------------------------------------------------------------------------------------------------

test("poll: consecutive 5xx back off 1 s, 2 s, 4 s ... doubling up to the 60 s cap, then stay at 60 s", async () => {
  const rig = await makeRig({ mode: "polling" });
  try {
    const expected = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000];
    for (let i = 0; i < expected.length; i++) {
      const status = i % 2 === 0 ? 500 : 503;
      rig.fake.failNext("getUpdates", status, serverError(status));
    }
    rig.deliver(101, "after the outage");
    await rig.channel.start(rig.host);
    await waitFor(() => rig.received.length === 1, "update delivered once the server recovers");
    assert.deepEqual(rig.waits, expected);
    assert.equal(pollLogs(rig).length, expected.length);
    assert.ok(pollLogs(rig).every((l) => l.attrs.kind === "http"));
    assert.deepEqual(
      pollLogs(rig).map((l) => l.attrs.waitMs),
      expected,
    );
    assert.equal(rig.failures.length, 0, "a transient 5xx never fails the channel");
  } finally {
    await rig.dispose();
  }
});

test("poll: the backoff starts over at 1 s after a successful poll", async () => {
  const rig = await makeRig({ mode: "polling" });
  try {
    rig.fake.failNext("getUpdates", 500, serverError(500));
    rig.fake.failNext("getUpdates", 500, serverError(500));
    rig.deliver(101, "first");
    await rig.channel.start(rig.host);
    await waitFor(() => rig.received.length === 1, "first update delivered");
    assert.deepEqual(rig.waits, [1000, 2000]);
    rig.fake.failNext("getUpdates", 500, serverError(500));
    rig.deliver(102, "second");
    await waitFor(() => rig.waits.length === 3, "third wait");
    assert.deepEqual(rig.waits, [1000, 2000, 1000], "a successful poll resets the doubling");
  } finally {
    await rig.dispose();
  }
});

// Retry limit vs. attempts: limit + 1 requests, one wait between each pair, the wait doubles and is capped at 60 s.
const networkLimits: [string, number | undefined, number[]][] = [
  ["maxSendRetries 0", 0, []],
  ["maxSendRetries 1", 1, [1000]],
  ["the default limit of 3 (src/channel.ts:496)", undefined, [1000, 2000, 4000]],
  ["maxSendRetries 8 (reaches the 60 s cap)", 8, [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]],
];

for (const [label, limit, expected] of networkLimits) {
  test(`send: a lost connection is retried with doubling backoff, ${label}: limit + 1 attempts, then TelegramApiError(network)`, async () => {
    const attempts = (limit ?? DEFAULT_SEND_RETRIES) + 1;
    assert.equal(expected.length, attempts - 1);
    const rig = await makeRig(limit === undefined ? {} : { maxSendRetries: limit });
    try {
      await rig.channel.start(rig.host);
      rig.failNetwork("sendMessage", attempts + 2);
      await assert.rejects(
        rig.channel.send(CHAT, "hi"),
        apiError("network", "sendMessage network error"),
      );
      assert.equal(rig.count("sendMessage"), attempts, "limit + 1 attempts");
      assert.deepEqual(rig.waits, expected);
      assert.equal(rig.elapsed(), expected.reduce((a, b) => a + b, 0), "virtual time spent equals the sum of the waits");
      assert.deepEqual(
        retryLogs(rig).map((l) => [l.attrs.kind, l.attrs.attempt, l.attrs.waitMs]),
        expected.map((w, i) => ["network", i, w]),
      );
      await settle();
      assert.equal(rig.count("sendMessage"), attempts, "no attempt after the limit");
      assert.equal(rig.pendingNetworkFailures("sendMessage"), 2, "the two spare failures were never consumed");
      assert.equal(rig.fake.callsOf("sendMessage").length, 0, "nothing reached the server");
    } finally {
      await rig.dispose();
    }
  });
}

test("send: a network failure followed by a good answer is retried once after the 1 s base wait", async () => {
  const rig = await makeRig();
  try {
    await rig.channel.start(rig.host);
    rig.failNetwork("sendMessage", 1);
    assert.equal((await rig.channel.send(CHAT, "hi")).length, 1);
    assert.deepEqual(rig.waits, [1000]);
    assert.equal(rig.count("sendMessage"), 2);
    assert.equal(rig.fake.callsOf("sendMessage").length, 1);
  } finally {
    await rig.dispose();
  }
});

for (const status of [500, 503]) {
  test(
    `send: HTTP ${status} is retried with backoff up to maxSendRetries`,
    async () => {
      const rig = await makeRig();
      try {
        await rig.channel.start(rig.host);
        for (let i = 0; i < DEFAULT_SEND_RETRIES + 3; i++) rig.fake.failNext("sendMessage", status, serverError(status));
        await assert.rejects(
          rig.channel.send(CHAT, "hi"),
          apiError("http", `sendMessage failed with HTTP ${status}: Server Error ${status}`, { status }),
        );
        assert.equal(
          rig.count("sendMessage"),
          DEFAULT_SEND_RETRIES + 1,
          `erwartet ${DEFAULT_SEND_RETRIES + 1} Anfragen bei HTTP ${status}, tatsächlich ${rig.count("sendMessage")}`,
        );
        assert.deepEqual(rig.waits, [1000, 2000, 4000]);
        await settle();
        assert.equal(rig.count("sendMessage"), DEFAULT_SEND_RETRIES + 1, "no attempt after the limit");
      } finally {
        await rig.dispose();
      }
    },
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. 4xx other than 429 is not retried: exactly one request
// ---------------------------------------------------------------------------------------------------------------------

// src/api.ts:235-245: 400 -> bad-request, 401 and 404 -> unauthorized, 403 -> forbidden, 409 -> conflict.
const clientErrors: [number, string, string][] = [
  [400, "bad-request", "Bad Request: chat not found"],
  [401, "unauthorized", "Unauthorized"],
  [403, "forbidden", "Forbidden: bot was blocked by the user"],
  [404, "unauthorized", "Not Found"],
  [409, "conflict", "Conflict: terminated by other getUpdates request"],
];

for (const [status, kind, description] of clientErrors) {
  test(`send: HTTP ${status} is not retried; one request, no wait, TelegramApiError(${kind})`, async () => {
    const rig = await makeRig();
    try {
      await rig.channel.start(rig.host);
      rig.fake.failNext("sendMessage", status, { ok: false, error_code: status, description });
      rig.fake.failNext("sendMessage", status, { ok: false, error_code: status, description });
      await assert.rejects(
        rig.channel.send(CHAT, "hi"),
        apiError(kind, `sendMessage failed with HTTP ${status}: ${description}`, { status }),
      );
      assert.equal(rig.count("sendMessage"), 1, "exactly one request");
      assert.deepEqual(rig.waits, [], "no backoff wait was requested");
      await settle();
      assert.equal(rig.count("sendMessage"), 1, "no later attempt");
      assert.equal(rig.fake.failures.sendMessage?.length, 1, "the second scripted failure was never used");
      assert.deepEqual(retryLogs(rig), []);
    } finally {
      await rig.dispose();
    }
  });
}

for (const status of [401, 403, 404]) {
  test(`poll: HTTP ${status} on getUpdates stops polling after one request and reports the failure to the host`, async () => {
    const rig = await makeRig({ mode: "polling" });
    try {
      rig.fake.failNext("getUpdates", status, { ok: false, error_code: status, description: "rejected" });
      await rig.channel.start(rig.host);
      await waitFor(() => rig.failures.length === 1, "host.fail called");
      assert.equal(rig.count("getUpdates"), 1, "exactly one getUpdates");
      assert.deepEqual(rig.waits, [], "no backoff wait was requested");
      assert.equal((rig.failures[0] as Error).message, "telegram authentication failed");
      await settle();
      assert.equal(rig.count("getUpdates"), 1, "polling does not resume");
      assert.equal(rig.failures.length, 1);
    } finally {
      await rig.dispose();
    }
  });
}

test(
  "poll: HTTP 400 on getUpdates is not retried",
  async () => {
    const rig = await makeRig({ mode: "polling" });
    try {
      rig.fake.failNext("getUpdates", 400, { ok: false, error_code: 400, description: "Bad Request: invalid offset" });
      rig.setHold(true);
      await rig.channel.start(rig.host);
      await waitFor(() => rig.waits.length > 0 || rig.failures.length > 0, "the poll loop reacted to the 400");
      assert.deepEqual(
        rig.waits,
        [],
        `erwartet keine Wiederholung bei HTTP 400, tatsächlich Backoff-Retry in ${rig.waits[0]} ms`,
      );
      rig.release();
      await settle();
      assert.equal(rig.count("getUpdates"), 1, "exactly one getUpdates");
    } finally {
      await rig.dispose();
    }
  },
);

// ---------------------------------------------------------------------------------------------------------------------
// 5. After the limit the call rejects with a defined error and nothing more is requested
// ---------------------------------------------------------------------------------------------------------------------

const rateLimitLimits: [string, number | undefined][] = [
  ["maxSendRetries 0", 0],
  ["maxSendRetries 1", 1],
  ["the default limit of 3", undefined],
  ["maxSendRetries 5", 5],
];

for (const [label, limit] of rateLimitLimits) {
  test(`send: persistent 429 with ${label}: limit + 1 attempts, each retry waits the server's 2 s, then TelegramApiError(rate-limited)`, async () => {
    const retries = limit ?? DEFAULT_SEND_RETRIES;
    const rig = await makeRig(limit === undefined ? {} : { maxSendRetries: limit });
    try {
      await rig.channel.start(rig.host);
      for (let i = 0; i < retries + 3; i++) rig.fake.failNext("sendMessage", 429, tooMany(2));
      await assert.rejects(
        rig.channel.send(CHAT, "hi"),
        apiError("rate-limited", "sendMessage rate limited", { status: 429, retryAfterMs: 2000 }),
      );
      assert.equal(rig.count("sendMessage"), retries + 1, "limit + 1 attempts");
      assert.deepEqual(rig.waits, Array<number>(retries).fill(2000), "one wait per retry; the last rejection waits no more");
      assert.equal(rig.elapsed(), retries * 2000);
      assert.deepEqual(
        retryLogs(rig).map((l) => [l.attrs.kind, l.attrs.attempt, l.attrs.waitMs]),
        Array.from({ length: retries }, (_, i) => ["rate-limited", i, 2000]),
      );
      await settle();
      assert.equal(rig.count("sendMessage"), retries + 1, "no attempt after the limit");
      assert.equal(rig.fake.failures.sendMessage?.length, 2, "the two spare 429s were never consumed");
    } finally {
      await rig.dispose();
    }
  });
}

test("send: after a rejected send the channel is not stuck; the next send gets a fresh retry budget", async () => {
  const rig = await makeRig({ maxSendRetries: 1 });
  try {
    await rig.channel.start(rig.host);
    rig.fake.failNext("sendMessage", 429, tooMany(2));
    rig.fake.failNext("sendMessage", 429, tooMany(2));
    await assert.rejects(rig.channel.send(CHAT, "one"), apiError("rate-limited", "sendMessage rate limited"));
    assert.equal(rig.count("sendMessage"), 2);
    rig.fake.failNext("sendMessage", 429, tooMany(2));
    assert.equal((await rig.channel.send(CHAT, "two")).length, 1);
    assert.equal(rig.count("sendMessage"), 4, "second send: one 429, one retry");
    // 2 s retry wait of the first send; 1 s per-chat bucket spacing (private chat, 1 message per second, src/channel.ts:471)
    // before the second send, which then waits 2 s for its own 429.
    assert.deepEqual(rig.waits, [2000, 1000, 2000]);
  } finally {
    await rig.dispose();
  }
});
