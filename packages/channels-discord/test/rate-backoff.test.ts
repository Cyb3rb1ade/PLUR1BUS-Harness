import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordApi, DiscordApiError, Gateway, type DiscordChannel, MAX_RETRY_MS, MIN_RETRY_MS } from "../src/index.ts";
import { makeEnv, started, type Env } from "./helpers/env.ts";
import { FakeClock, drive, settle } from "./helpers/fake-clock.ts";
import { FakeDiscordRest, FakeGateway, BOT_ID, GUILD_CHANNEL, TOKEN, cdnAwareFetch, type Failure } from "./helpers/fake-discord.ts";

// Step 5: rate limit and backoff. Everything runs on virtual time: FakeClock.sleep only resolves when the test advances the clock,
// so a parked sleep is the "hold" seam. A test parks the retry, proves that no second request has been issued, then releases it.
// "No second request" is read on the client side (the recording fetch below sees the call the moment it is issued); the loopback
// server's own call list is checked as well, but real I/O alone could not prove an absence. `random` is always pinned.
//
// Where the numbers come from (all in packages/channels-discord/src):
//   MIN_RETRY_MS 1000 and MAX_RETRY_MS 300000      api.ts:34-35, applied by clampRetryMs (api.ts:58-62). docs/channels/discord.md:143
//                                                   says "clamped Retry-After (1 s to 5 min)".
//   429 wait = body.retry_after ?? Retry-After      api.ts:101 (seconds, clamped); a missing or unreadable value becomes MIN_RETRY_MS.
//   default retry limit 3                           api.ts:78 (`maxRetries ?? 3`): one call plus three retries is four attempts.
//   retried statuses 502, 503, 504                  api.ts:108. Other 5xx and every 4xx except 429 are not retried.
//   5xx / network backoff 1000 * 2**attempt         api.ts:213: capped at 60000, then times (0.75 + random * 0.5).
//   gateway reconnect 1000 * 2**(failures-1)        gateway.ts:88-89: capped at maxBackoffMs (60000), same jitter.
//   gateway: close 4008 waits at least 5000        gateway.ts:90; invalid session waits 1000 + floor(random * 4000) (gateway.ts:85);
//   a session that was READY for >= 5000 ms resets the failure count (gateway.ts:81-82).
const DEFAULT_MAX_RETRIES = 3;
const ME_PATH = "/api/v10/users/@me";
const ME = `GET ${ME_PATH}`;
const POST_PATH = "/api/v10/channels/";
const POST_KEY = `POST ${POST_PATH}`;
const SEND_PATH = `/channels/${GUILD_CHANNEL}/messages`;
const SEND_KEY = `POST /api/v10${SEND_PATH}`;
// A call that must be rejected at once would park on the fake clock forever if the product retried it; this turns that into a failure.
const NO_RETRY_GUARD_MS = 2000;
const BACKOFF_RANDOM_HALF = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];

/** Failure-only guard: fails the test instead of letting it hang when `p` never settles. The timer is cleared once `p` settles. */
async function guard<T>(p: Promise<T>, what: string, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`guard: ${what} did not settle`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- REST rig ---------------------------------------------------------------------------------------------------------------

async function rig(extra: Partial<ConstructorParameters<typeof DiscordApi>[0]> = {}, inner?: typeof fetch) {
  const rest = new FakeDiscordRest();
  await rest.listen();
  const clock = new FakeClock();
  /** Virtual time of every request the client issued (recorded when fetch is called, before any network I/O). */
  const attempts: number[] = [];
  const real = inner ?? cdnAwareFetch(rest);
  const api = new DiscordApi({
    token: TOKEN,
    baseUrl: `${rest.baseUrl}/api/v10`,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0.5,
    fetch: (input, init) => {
      attempts.push(clock.t);
      return real(input, init);
    },
    cdnHosts: ["cdn.discordapp.com"],
    ...extra,
  });
  return { rest, clock, api, attempts, close: () => rest.close() };
}
type Rig = Awaited<ReturnType<typeof rig>>;

const ac = () => new AbortController().signal;
const getMe = (r: Rig) => r.api.request<{ id: string }>({ method: "GET", path: "/users/@me", signal: ac() });
const postMessage = (r: Rig) => r.api.request({ method: "POST", path: SEND_PATH, json: { content: "x" }, signal: ac() });

/** Runs `body` against a fresh rig and always closes the loopback server. */
async function withRig(extra: Partial<ConstructorParameters<typeof DiscordApi>[0]>, body: (r: Rig) => Promise<void>, inner?: typeof fetch): Promise<void> {
  const r = await rig(extra, inner);
  try {
    await body(r);
  } finally {
    await r.close();
  }
}

/**
 * The retry sleep `waitMs` is parked on the clock. Proves that the next request is issued only once that wait is over: nothing
 * has been sent while parked, nothing one millisecond before the end, and a second request exists one millisecond later.
 */
async function assertParkedUntil(r: Rig, waitMs: number, serverSide = true): Promise<void> {
  await settle(r.clock, () => r.clock.pending === 1 && r.clock.slept.at(-1) === waitMs);
  assert.equal(r.attempts.length, 1, "parked after the first request");
  if (serverSide) assert.equal(r.rest.calls.length, 1);
  await r.clock.advance(waitMs - 1);
  assert.equal(r.attempts.length, 1, "no second request one millisecond before the wait is over");
  if (serverSide) assert.equal(r.rest.calls.length, 1);
  assert.equal(r.clock.pending, 1, "still parked");
  await r.clock.advance(1);
  await settle(r.clock, () => r.attempts.length === 2);
  assert.ok(r.attempts[1]! - r.attempts[0]! >= waitMs, `second request after ${r.attempts[1]! - r.attempts[0]!} ms, wanted at least ${waitMs}`);
}

/** After a rejected call: the clock runs far ahead and nothing else is sent or parked (a bounded check, not an endless wait). */
async function assertNoFurtherAttempts(r: Rig, expectedAttempts: number): Promise<void> {
  await r.clock.advance(10 * 60_000);
  assert.equal(r.attempts.length, expectedAttempts, "no attempt after the call was rejected");
  assert.equal(r.rest.calls.length, expectedAttempts);
  assert.equal(r.clock.pending, 0, "nothing is parked any more");
}

function assertApiError(e: unknown, kind: string, message: string, status: number | undefined): asserts e is DiscordApiError {
  assert.ok(e instanceof DiscordApiError, `expected DiscordApiError, got ${String(e)}`);
  assert.equal(e.name, "DiscordApiError");
  assert.equal(e.kind, kind);
  assert.equal(e.message, message);
  assert.equal(e.status, status);
}

// ---- 1. 429 with an asked wait -----------------------------------------------------------------------------------------------

const askedWaits: Array<[string, Failure, number]> = [
  ["body retry_after of 2 s", { status: 429, body: { message: "slow down", retry_after: 2, global: false } }, 2000],
  ["body retry_after of 2.5 s is not rounded down", { status: 429, body: { message: "slow down", retry_after: 2.5, global: false } }, 2500],
  ["body retry_after below the floor is raised to MIN_RETRY_MS", { status: 429, body: { retry_after: 0.2 } }, MIN_RETRY_MS],
  ["body retry_after above the band is cut to MAX_RETRY_MS", { status: 429, body: { retry_after: 1_000_000 } }, MAX_RETRY_MS],
  ["Retry-After header when the body has none", { status: 429, body: { message: "x" }, headers: { "retry-after": "3" } }, 3000],
  ["Retry-After header below the floor", { status: 429, body: {}, headers: { "retry-after": "0.2" } }, MIN_RETRY_MS],
  ["Retry-After header above the band", { status: 429, body: {}, headers: { "retry-after": "100000" } }, MAX_RETRY_MS],
];
for (const [name, failure, waitMs] of askedWaits)
  test(`429: ${name}; the retry is held until the wait is over`, async () => {
    await withRig({}, async (r) => {
      r.rest.fail(ME, failure);
      const p = getMe(r);
      await assertParkedUntil(r, waitMs);
      assert.equal((await guard(p, "request")).id, BOT_ID);
      assert.equal(r.attempts.length, 2);
      assert.deepEqual(r.clock.slept, [waitMs], "one wait, the asked one; no extra backoff step");
    });
  });

test("429: the asked wait replaces the 5xx backoff formula (not doubled, not jittered)", async () => {
  // random is pinned far from 0.5 so that any jitter on the asked wait would show.
  await withRig({ random: () => 0.99 }, async (r) => {
    for (const asked of [2, 3, 5]) r.rest.fail(ME, { status: 429, body: { retry_after: asked } });
    const p = getMe(r);
    await drive(r.clock, p);
    assert.equal((await p).id, BOT_ID);
    assert.deepEqual(r.clock.slept, [2000, 3000, 5000]);
    assert.equal(r.attempts.length, 4);
  });
});

// ---- 2. 429 without any retry_after ------------------------------------------------------------------------------------------

// Nothing the server sent can be read as seconds, so the wait is MIN_RETRY_MS: api.ts:34 (1000 ms), reached through clampRetryMs
// (api.ts:60-61: not finite -> MIN_RETRY_MS). docs/channels/discord.md:143 gives the same lower edge of the band.
const unreadable: Array<[string, Failure]> = [
  ["empty JSON body, no header", { status: 429, body: {} }],
  ["body that is not an object", { status: 429, body: "slow down" }],
  ["body retry_after that is not a number", { status: 429, body: { retry_after: "soon" } }],
  ["body retry_after is null and no header", { status: 429, body: { retry_after: null } }],
  ["header that is not a number", { status: 429, body: {}, headers: { "retry-after": "soon" } }],
];
for (const [name, failure] of unreadable)
  test(`429 without a usable retry_after (${name}): waits MIN_RETRY_MS, then retries`, async () => {
    await withRig({}, async (r) => {
      r.rest.fail(ME, failure);
      const p = getMe(r);
      assert.equal(MIN_RETRY_MS, 1000);
      await assertParkedUntil(r, MIN_RETRY_MS);
      assert.equal((await guard(p, "request")).id, BOT_ID);
      assert.deepEqual(r.clock.slept, [MIN_RETRY_MS]);
    });
  });

test("429 with a body that is not JSON at all (an HTML error page) waits MIN_RETRY_MS", async () => {
  let n = 0;
  const html = (async () => {
    n += 1;
    return n === 1
      ? new Response("<html>Too Many Requests</html>", { status: 429, headers: { "content-type": "text/html" } })
      : new Response(JSON.stringify({ id: BOT_ID }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await withRig({}, async (r) => {
    const p = getMe(r);
    await assertParkedUntil(r, MIN_RETRY_MS, false);
    assert.equal((await guard(p, "request")).id, BOT_ID);
  }, html);
});

// ---- 3. 5xx is retried with backoff up to the limit -------------------------------------------------------------------------

// The recorded waits are api.ts:213 with random pinned at 0.5 (factor exactly 1): 1000 * 2**attempt.
for (const status of [502, 503, 504])
  test(`${status} is retried with growing waits; default limit gives ${DEFAULT_MAX_RETRIES + 1} attempts, then a defined error`, async () => {
    await withRig({}, async (r) => {
      for (let i = 0; i < DEFAULT_MAX_RETRIES + 2; i++) r.rest.fail(ME, { status, body: {} });
      const p = getMe(r);
      await drive(r.clock, p);
      await assert.rejects(p, (e: unknown) => {
        assertApiError(e, "http", `discord http (${status})`, status);
        return true;
      });
      assert.deepEqual(r.clock.slept, [1000, 2000, 4000]);
      assert.equal(r.attempts.length, DEFAULT_MAX_RETRIES + 1, "limit plus one attempts");
      for (let i = 0; i < r.clock.slept.length; i++)
        assert.ok(r.attempts[i + 1]! - r.attempts[i]! >= r.clock.slept[i]!, `retry ${i + 1} came after its wait`);
      assert.equal(r.rest.failures.length, 1, "the spare scripted failure was never requested");
      await assertNoFurtherAttempts(r, DEFAULT_MAX_RETRIES + 1);
    });
  });

for (const limit of [1, 2, 5]) {
  test(`5xx with maxRetries ${limit}: ${limit + 1} attempts, waits grow step by step`, async () => {
    await withRig({ maxRetries: limit }, async (r) => {
      for (let i = 0; i < limit + 2; i++) r.rest.fail(ME, { status: 503, body: {} });
      const p = getMe(r);
      await drive(r.clock, p);
      await assert.rejects(p, (e: unknown) => e instanceof DiscordApiError && e.kind === "http");
      assert.equal(r.attempts.length, limit + 1);
      assert.deepEqual(r.clock.slept, BACKOFF_RANDOM_HALF.slice(0, limit));
      for (let i = 1; i < r.clock.slept.length; i++) assert.ok(r.clock.slept[i]! > r.clock.slept[i - 1]!, "each wait is longer than the one before");
      await assertNoFurtherAttempts(r, limit + 1);
    });
  });
}

test("5xx backoff stops growing at 60 s", async () => {
  await withRig({ maxRetries: 8 }, async (r) => {
    for (let i = 0; i < 10; i++) r.rest.fail(ME, { status: 503, body: {} });
    const p = getMe(r);
    await drive(r.clock, p);
    await assert.rejects(p, (e: unknown) => e instanceof DiscordApiError && e.kind === "http");
    assert.equal(r.attempts.length, 9);
    assert.deepEqual(r.clock.slept, BACKOFF_RANDOM_HALF, "the last two waits are the 60 s cap");
  });
});

// api.ts:213 factor 0.75 + random * 0.5: random 0 gives 0.75, random 1 gives 1.25 (the jitter band around each step).
for (const [random, expected] of [
  [0, [750, 1500, 3000]],
  [1, [1250, 2500, 5000]],
] as const)
  test(`5xx backoff jitter band edge (random ${random}): ${expected.join(", ")}`, async () => {
    await withRig({ random: () => random }, async (r) => {
      for (let i = 0; i < 5; i++) r.rest.fail(ME, { status: 502, body: {} });
      const p = getMe(r);
      await drive(r.clock, p);
      await assert.rejects(p, (e: unknown) => e instanceof DiscordApiError && e.kind === "http");
      assert.deepEqual(r.clock.slept, expected);
    });
  });

test("5xx: the first retry is held until its backoff step is over", async () => {
  await withRig({}, async (r) => {
    r.rest.fail(ME, { status: 503, body: {} });
    const p = getMe(r);
    await assertParkedUntil(r, 1000);
    assert.equal((await guard(p, "request")).id, BOT_ID);
    assert.equal(r.attempts.length, 2);
  });
});

test("5xx that clears up after two failures succeeds on the third attempt", async () => {
  await withRig({}, async (r) => {
    r.rest.fail(ME, { status: 503, body: {} });
    r.rest.fail(ME, { status: 504, body: {} });
    const p = getMe(r);
    await drive(r.clock, p);
    assert.equal((await p).id, BOT_ID);
    assert.equal(r.attempts.length, 3);
    assert.deepEqual(r.clock.slept, [1000, 2000]);
  });
});

test("a transport failure is retried with the same backoff and ends as kind network after the limit", async () => {
  let calls = 0;
  const down = (async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await withRig({}, async (r) => {
    const p = getMe(r);
    await drive(r.clock, p);
    await assert.rejects(p, (e: unknown) => {
      assertApiError(e, "network", "discord network failure", undefined);
      return true;
    });
    assert.equal(calls, DEFAULT_MAX_RETRIES + 1);
    assert.deepEqual(r.clock.slept, [1000, 2000, 4000]);
    assert.equal(r.clock.pending, 0);
  }, down);
});

// ---- 4. 4xx other than 429 is never retried; neither is a 5xx outside the retried set --------------------------------------

const kinds: Record<number, string> = { 400: "bad-request", 401: "unauthorized", 403: "forbidden", 404: "not-found", 405: "http", 409: "http", 422: "http" };
const routes: Array<[string, string, (r: Rig) => Promise<unknown>]> = [
  ["GET", ME, getMe],
  ["POST", POST_KEY, postMessage],
];
for (const [method, key, call] of routes)
  for (const [code, kind] of Object.entries(kinds)) {
    const status = Number(code);
    test(`${status} on ${method} is not retried: one request, no wait, ${kind}`, async () => {
      await withRig({}, async (r) => {
        r.rest.fail(key, { status, body: { message: "nope", code: 50001 } });
        r.rest.fail(key, { status, body: { message: "nope", code: 50001 } });
        await assert.rejects(guard(call(r), "request is rejected without a retry", NO_RETRY_GUARD_MS), (e: unknown) => {
          assertApiError(e, kind, `discord ${kind} (${status}): nope`, status);
          assert.equal(e.code, 50001);
          return true;
        });
        assert.equal(r.attempts.length, 1);
        assert.deepEqual(r.clock.slept, [], "no wait of any kind");
        assert.equal(r.rest.failures.length, 1, "the second scripted failure was never requested");
        await assertNoFurtherAttempts(r, 1);
      });
    });
  }

// api.ts:108 retries exactly 502, 503 and 504. This pins the code's current set (not a rule written in the docs), so that a change
// to it is deliberate.
for (const status of [500, 501]) {
  test(`${status} is outside the retried 5xx set: one request, surfaced as kind http`, async () => {
    await withRig({}, async (r) => {
      r.rest.fail(ME, { status, body: {} });
      await assert.rejects(guard(getMe(r), "request is rejected without a retry", NO_RETRY_GUARD_MS), (e: unknown) => {
        assertApiError(e, "http", `discord http (${status})`, status);
        return true;
      });
      assert.deepEqual(r.clock.slept, []);
      await assertNoFurtherAttempts(r, 1);
    });
  });
}

// ---- 5. After the limit: a defined error and no further attempts ------------------------------------------------------------

test("429 after the limit: kind rate-limited with the last asked wait; four attempts, then silence", async () => {
  await withRig({}, async (r) => {
    // Four 429s with growing asks, plus a spare that must stay unused.
    for (const asked of [2, 3, 5, 7, 11]) r.rest.fail(ME, { status: 429, body: { retry_after: asked } });
    const p = getMe(r);
    await drive(r.clock, p);
    await assert.rejects(p, (e: unknown) => {
      assertApiError(e, "rate-limited", "discord rate limit", 429);
      assert.equal(e.retryAfterMs, 7000, "carries the wait of the final 429");
      return true;
    });
    assert.deepEqual(r.clock.slept, [2000, 3000, 5000], "the final 429 is not waited out");
    assert.equal(r.attempts.length, DEFAULT_MAX_RETRIES + 1);
    assert.equal(r.rest.failures.length, 1);
    await assertNoFurtherAttempts(r, DEFAULT_MAX_RETRIES + 1);
  });
});

test("429 with maxRetries 0 is surfaced at once, and the route then stays blocked for the asked wait", async () => {
  await withRig({ maxRetries: 0 }, async (r) => {
    r.rest.fail(ME, { status: 429, body: { retry_after: 9 } });
    await assert.rejects(guard(getMe(r), "request is rejected without a retry", NO_RETRY_GUARD_MS), (e: unknown) => {
      assertApiError(e, "rate-limited", "discord rate limit", 429);
      assert.equal(e.retryAfterMs, 9000);
      return true;
    });
    assert.equal(r.attempts.length, 1);
    assert.deepEqual(r.clock.slept, [], "the call itself did not wait");
    // The limiter learned the 429: a new call on the same route is held for the asked 9 s.
    const next = getMe(r);
    await settle(r.clock, () => r.clock.pending === 1 && r.clock.slept.at(-1) === 9000);
    await r.clock.advance(8999);
    assert.equal(r.attempts.length, 1, "no new request before the penalty is over");
    await r.clock.advance(1);
    assert.equal((await guard(next, "second call")).id, BOT_ID);
    assert.equal(r.attempts.length, 2);
  });
});

test("5xx with maxRetries 0 is not retried", async () => {
  await withRig({ maxRetries: 0 }, async (r) => {
    r.rest.fail(ME, { status: 503, body: {} });
    await assert.rejects(guard(getMe(r), "request is rejected without a retry", NO_RETRY_GUARD_MS), (e: unknown) => {
      assertApiError(e, "http", "discord http (503)", 503);
      return true;
    });
    assert.deepEqual(r.clock.slept, []);
    await assertNoFurtherAttempts(r, 1);
  });
});

test("the retry budget is shared between 429 and 5xx: four attempts in total, whichever failures they were", async () => {
  await withRig({}, async (r) => {
    r.rest.fail(ME, { status: 503, body: {} });
    r.rest.fail(ME, { status: 429, body: { retry_after: 4 } });
    r.rest.fail(ME, { status: 502, body: {} });
    r.rest.fail(ME, { status: 504, body: {} });
    r.rest.fail(ME, { status: 503, body: {} });
    const p = getMe(r);
    await drive(r.clock, p);
    await assert.rejects(p, (e: unknown) => {
      assertApiError(e, "http", "discord http (504)", 504);
      return true;
    });
    // attempt 0 backs off 1000, attempt 1 waits the asked 4000, attempt 2 backs off 1000 * 2**2; attempt 3 is the last.
    assert.deepEqual(r.clock.slept, [1000, 4000, 4000]);
    assert.equal(r.attempts.length, DEFAULT_MAX_RETRIES + 1);
    assert.equal(r.rest.failures.length, 1);
    await assertNoFurtherAttempts(r, DEFAULT_MAX_RETRIES + 1);
  });
});

// ---- Gateway reconnect backoff (src/gateway.ts) -----------------------------------------------------------------------------

interface GwRig {
  clock: FakeClock;
  gw: FakeGateway;
  ac: AbortController;
  /** `waitMs` of every "gateway-reconnect" log line, in order: the wait the loop is about to sleep. */
  waits: number[];
  dials: () => number;
  down: { value: boolean };
  setRandom(v: number): void;
  run: Promise<void>;
}

/** A gateway whose transport can be switched off: while `down`, the socket factory throws (a dial that fails at once). */
function gwRig(o: { random?: number; maxBackoffMs?: number; down?: boolean } = {}): GwRig {
  const clock = new FakeClock();
  const gw = new FakeGateway();
  gw.heartbeatInterval = 1000;
  const ac = new AbortController();
  const waits: number[] = [];
  const down = { value: o.down ?? false };
  let dials = 0;
  let rnd = o.random ?? 0.5;
  const g = new Gateway({
    token: TOKEN,
    intents: 1,
    url: "wss://gateway.test.invalid",
    webSocket: (url) => {
      dials += 1;
      if (down.value) throw new Error("network unreachable");
      return gw.factory(url);
    },
    signal: ac.signal,
    sleep: clock.sleep,
    random: () => rnd,
    now: clock.now,
    botId: BOT_ID,
    onReady: () => {},
    onDispatch: () => {},
    onConnection: () => {},
    onSession: () => {},
    onFatal: () => {},
    log: (_level, event, attrs) => {
      if (event === "channel.discord.gateway-reconnect") waits.push(attrs.waitMs as number);
    },
    ...(o.maxBackoffMs !== undefined ? { maxBackoffMs: o.maxBackoffMs } : {}),
  });
  const run = g.run();
  return { clock, gw, ac, waits, dials: () => dials, down, setRandom: (v) => void (rnd = v), run };
}

async function stopGw(r: GwRig): Promise<void> {
  r.ac.abort();
  await guard(r.run, "gateway run() ends after abort");
}

/** The loop is parked in a backoff of `waitMs` (just logged): nothing is dialled until it is over. */
async function assertGatewayHeld(r: GwRig, waitMs: number): Promise<void> {
  const dialsBefore = r.dials();
  assert.equal(r.waits.at(-1), waitMs);
  assert.equal(r.clock.pending, 1, "the loop is parked in its backoff sleep");
  await r.clock.advance(waitMs - 1);
  assert.equal(r.dials(), dialsBefore, "no new connection attempt one millisecond before the wait is over");
  await r.clock.advance(1);
  assert.equal(r.dials(), dialsBefore + 1, "the attempt comes once the wait is over");
}

test("gateway: a dead transport backs off 1, 2, 4 ... s up to the 60 s cap, and nothing is dialled early", async () => {
  const r = gwRig({ down: true });
  try {
    await r.clock.flush();
    assert.equal(r.dials(), 1);
    for (let i = 0; i < BACKOFF_RANDOM_HALF.length; i++) {
      assert.equal(r.waits[i], BACKOFF_RANDOM_HALF[i]);
      await assertGatewayHeld(r, BACKOFF_RANDOM_HALF[i]!);
      await r.clock.flush();
    }
    assert.deepEqual(r.waits.slice(0, BACKOFF_RANDOM_HALF.length), BACKOFF_RANDOM_HALF);
    assert.deepEqual(r.clock.slept.slice(0, BACKOFF_RANDOM_HALF.length), BACKOFF_RANDOM_HALF, "the loop really slept those waits");
  } finally {
    await stopGw(r);
  }
});

for (const [random, expected] of [
  [0, [750, 1500, 3000]],
  [1, [1250, 2500, 5000]],
] as const)
  test(`gateway: reconnect jitter band edge (random ${random}): ${expected.join(", ")}`, async () => {
    const r = gwRig({ random, down: true });
    try {
      await r.clock.flush();
      for (const w of expected) {
        assert.equal(r.waits.at(-1), w);
        await r.clock.advance(w);
      }
      assert.deepEqual(r.waits.slice(0, expected.length), expected);
    } finally {
      await stopGw(r);
    }
  });

test("gateway: maxBackoffMs lowers the cap", async () => {
  const r = gwRig({ maxBackoffMs: 3000, down: true });
  try {
    await r.clock.flush();
    for (let i = 0; i < 4; i++) await r.clock.advance(r.waits.at(-1)!);
    assert.deepEqual(r.waits.slice(0, 5), [1000, 2000, 3000, 3000, 3000]);
  } finally {
    await stopGw(r);
  }
});

/** Three failed dials (waits 1, 2, 4 s), then the network is back and a connection reaches READY. */
async function reachReadyAfterThreeFailures(r: GwRig): Promise<void> {
  await r.clock.flush();
  await r.clock.advance(1000);
  await r.clock.advance(2000);
  assert.deepEqual(r.waits, [1000, 2000, 4000]);
  r.down.value = false;
  await r.clock.advance(4000);
  await guard(r.gw.whenReady(), "READY after the network came back");
  await r.clock.flush();
  assert.equal(r.gw.sockets.length, 1);
}

test("gateway: a connection that reaches READY but dies within 5 s does not reset the backoff", async () => {
  const r = gwRig({ down: true });
  try {
    await reachReadyAfterThreeFailures(r);
    await r.clock.advance(1000);
    r.gw.latest.remoteClose(1006);
    await r.clock.flush();
    assert.equal(r.waits.at(-1), 8000, "the fourth failure in a row keeps climbing");
    assert.equal(r.clock.pending, 1);
    await r.clock.advance(7999);
    assert.equal(r.gw.sockets.length, 1, "no reconnect before the wait is over");
    await r.clock.advance(1);
    assert.equal(r.gw.sockets.length, 2);
  } finally {
    await stopGw(r);
  }
});

test("gateway: a connection that stays READY for 5 s or more resets the backoff", async () => {
  const r = gwRig({ down: true });
  try {
    await reachReadyAfterThreeFailures(r);
    await r.clock.advance(6000);
    r.gw.latest.remoteClose(1006);
    await r.clock.flush();
    // gateway.ts:82 sets failures to 0, so the exponent in gateway.ts:88 is -1: at most the first failure step, never 8000.
    assert.ok(r.waits.at(-1)! <= 1000, `waited ${r.waits.at(-1)} ms after a stable session`);
    assert.ok(r.waits.at(-1)! > 0);
  } finally {
    await stopGw(r);
  }
});

test("gateway: close 4008 (the gateway's own rate limit) waits at least 5 s before the next dial", async () => {
  const r = gwRig();
  try {
    await r.gw.whenReady();
    await r.clock.flush();
    r.gw.latest.remoteClose(4008);
    await r.clock.flush();
    assert.equal(r.waits.at(-1), 5000, "the first backoff step of 1000 ms is raised to the 4008 floor (gateway.ts:90)");
    await r.clock.advance(4999);
    assert.equal(r.gw.sockets.length, 1, "no reconnect before 5 s");
    await r.clock.advance(1);
    assert.equal(r.gw.sockets.length, 2);
  } finally {
    await stopGw(r);
  }
});

// Discord asks a client to wait a random 1 to 5 s after an invalid session; gateway.ts:85 is 1000 + floor(random * 4000).
for (const [random, expected] of [
  [0, 1000],
  [0.9999, 4999],
] as const)
  test(`gateway: invalid session waits ${expected} ms (random ${random}), inside the 1-5 s band`, async () => {
    const r = gwRig({ random });
    try {
      await r.gw.whenReady();
      await r.clock.flush();
      r.gw.latest.server({ op: 9, d: false });
      await r.clock.flush();
      assert.equal(r.waits.at(-1), expected);
      assert.ok(expected >= 1000 && expected < 5000);
      await r.clock.advance(expected - 1);
      assert.equal(r.gw.sockets.length, 1, "no reconnect before the wait is over");
      await r.clock.advance(1);
      assert.equal(r.gw.sockets.length, 2);
    } finally {
      await stopGw(r);
    }
  });

// ---- Channel level: start() and reconnect ---------------------------------------------------------------------------------

/** One started-or-not channel with a recording fetch (client-side request log) and a switchable transport. */
async function withChannelEnv(
  body: (e: Env, ch: DiscordChannel, net: { requests: string[]; down: boolean; dials: number; reconnectWaits: number[] }) => Promise<void>,
): Promise<void> {
  const e = await makeEnv();
  const net = { requests: [] as string[], down: false, dials: 0, reconnectWaits: [] as number[] };
  const real = cdnAwareFetch(e.rest);
  const ch = e.channel(
    {},
    {
      // The channel logs through this logger and through host.log; reading one of them keeps every line single.
      logger: {
        log: (_level, event, attrs) => {
          if (event === "channel.discord.gateway-reconnect") net.reconnectWaits.push(attrs.waitMs as number);
        },
      },
      fetch: (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        net.requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
        return real(input, init);
      },
      webSocket: (url: string) => {
        net.dials += 1;
        if (net.down) throw new Error("network unreachable");
        return e.gateway.factory(url);
      },
    },
  );
  try {
    await body(e, ch, net);
  } finally {
    await ch.stop();
    await e.close();
  }
}
const count = (net: { requests: string[] }, key: string) => net.requests.filter((x) => x === key).length;

test("start: a 503 on the identity call is retried after 1 s, then start completes and the channel is healthy", async () => {
  await withChannelEnv(async (e, ch, net) => {
    e.rest.fail(ME, { status: 503, body: {} });
    const starting = ch.start(e.host);
    await settle(e.clock, () => e.clock.slept.length === 1);
    assert.deepEqual(e.clock.slept, [1000], "the first sleep of start() is the backoff step");
    assert.equal(count(net, ME), 1);
    await e.clock.advance(999);
    assert.equal(count(net, ME), 1, "no second identity request before the wait is over");
    await e.clock.advance(1);
    await guard(starting, "start()");
    assert.equal(count(net, ME), 2);
    assert.equal(e.rest.callsOf("GET", ME_PATH).length, 2);
    assert.deepEqual(await ch.health(), { ok: true, detail: "connected" });
  });
});

test("start: identity 429 holds the retry for the asked 12 s", async () => {
  await withChannelEnv(async (e, ch, net) => {
    e.rest.fail(ME, { status: 429, body: { retry_after: 12 } });
    const starting = ch.start(e.host);
    await settle(e.clock, () => e.clock.slept.length === 1 && e.clock.pending === 1);
    assert.deepEqual(e.clock.slept, [12_000]);
    await e.clock.advance(11_999);
    assert.equal(count(net, ME), 1, "no second identity request one millisecond early");
    assert.equal(e.gateway.sockets.length, 0, "no gateway connection while start is waiting");
    await e.clock.advance(1);
    await guard(starting, "start()");
    assert.equal(count(net, ME), 2);
    assert.deepEqual(await ch.health(), { ok: true, detail: "connected" });
  });
});

test("start: identity 5xx beyond the limit rejects with the defined error, opens no gateway and stops retrying", async () => {
  await withChannelEnv(async (e, ch, net) => {
    for (let i = 0; i < DEFAULT_MAX_RETRIES + 2; i++) e.rest.fail(ME, { status: 503, body: {} });
    const starting = ch.start(e.host);
    await drive(e.clock, starting);
    await assert.rejects(starting, (e2: unknown) => {
      assertApiError(e2, "http", "discord http (503)", 503);
      return true;
    });
    assert.deepEqual(e.clock.slept, [1000, 2000, 4000]);
    assert.equal(count(net, ME), DEFAULT_MAX_RETRIES + 1);
    assert.equal(e.rest.failures.length, 1, "the spare scripted failure was never requested");
    assert.equal(e.gateway.sockets.length, 0);
    assert.deepEqual(await ch.health(), { ok: false, detail: "stopped" });
    await e.clock.advance(10 * 60_000);
    assert.equal(count(net, ME), DEFAULT_MAX_RETRIES + 1, "nothing is retried after start() rejected");
    assert.equal(e.clock.pending, 0);
    assert.equal(net.dials, 0);
  });
});

test("start: identity 403 is not retried", async () => {
  await withChannelEnv(async (e, ch, net) => {
    e.rest.fail(ME, { status: 403, body: { message: "Missing Access", code: 50001 } });
    e.rest.fail(ME, { status: 403, body: { message: "Missing Access", code: 50001 } });
    await assert.rejects(guard(ch.start(e.host), "start()"), (e2: unknown) => {
      assertApiError(e2, "forbidden", "discord forbidden (403): Missing Access", 403);
      return true;
    });
    assert.equal(count(net, ME), 1);
    assert.deepEqual(e.clock.slept, []);
    assert.equal(e.rest.failures.length, 1);
    assert.deepEqual(await ch.health(), { ok: false, detail: "stopped" });
  });
});

test("reconnect: with the transport down the channel backs off 1, 2, 4 ... 60 s, never dials early and never calls host.fail", async () => {
  await withChannelEnv(async (e, ch, net) => {
    await started(e, ch);
    assert.equal(net.dials, 1);
    net.down = true;
    e.gateway.latest.remoteClose(1006);
    await e.clock.flush();
    const waitsLogged = () => net.reconnectWaits;
    for (const [i, w] of BACKOFF_RANDOM_HALF.entries()) {
      assert.equal(waitsLogged().at(-1), w, `wait ${i + 1}`);
      const dialsBefore: number = net.dials;
      assert.ok(e.clock.pending >= 1, "parked in backoff");
      assert.deepEqual(await ch.health(), { ok: false, detail: "reconnecting" });
      await e.clock.advance(w - 1);
      assert.equal(net.dials, dialsBefore, `no dial one millisecond before wait ${i + 1} is over`);
      await e.clock.advance(1);
      assert.equal(net.dials, dialsBefore + 1, `dial after wait ${i + 1}`);
    }
    assert.deepEqual(waitsLogged().slice(0, BACKOFF_RANDOM_HALF.length), BACKOFF_RANDOM_HALF);
    assert.equal(e.failures.length, 0, "a lost connection is retried, not reported as a failure");
    // The network is back: the next dial after the cap-sized wait succeeds and the channel is healthy again.
    net.down = false;
    await e.clock.advance(60_000);
    await settle(e.clock, () => e.gateway.sockets.length === 2);
    for (let i = 0; i < 5000 && !(await ch.health()).ok; i++) await new Promise<void>((r) => setTimeout(r, 1));
    assert.deepEqual(await ch.health(), { ok: true, detail: "connected" });
  });
});

// ---- Channel level: send() goes through the same retry rules -----------------------------------------------------------------

test("send: a 503 is retried after 1 s and the message is delivered exactly once", async () => {
  await withChannelEnv(async (e, ch, net) => {
    await started(e, ch);
    const sleptBefore = e.clock.slept.length;
    e.rest.fail(POST_KEY, { status: 503, body: {} });
    const sending = ch.send({ chatId: GUILD_CHANNEL, text: "hello" });
    await settle(e.clock, () => e.clock.slept.length === sleptBefore + 1);
    assert.equal(e.clock.slept.at(-1), 1000);
    assert.equal(count(net, SEND_KEY), 1);
    await e.clock.advance(999);
    assert.equal(count(net, SEND_KEY), 1, "not re-sent before the wait is over");
    assert.equal(e.rest.messages.length, 0);
    await e.clock.advance(1);
    await guard(sending, "send()");
    assert.equal(count(net, SEND_KEY), 2);
    assert.equal(e.rest.messages.length, 1, "one message on the platform");
  });
});

test("send: 5xx beyond the limit rejects with the defined error and posts nothing", async () => {
  await withChannelEnv(async (e, ch, net) => {
    await started(e, ch);
    const sleptBefore = e.clock.slept.length;
    for (let i = 0; i < DEFAULT_MAX_RETRIES + 2; i++) e.rest.fail(POST_KEY, { status: 502, body: {} });
    const sending = ch.send({ chatId: GUILD_CHANNEL, text: "hello" });
    await drive(e.clock, sending);
    await assert.rejects(sending, (e2: unknown) => {
      assertApiError(e2, "http", "discord http (502)", 502);
      return true;
    });
    assert.deepEqual(e.clock.slept.slice(sleptBefore), [1000, 2000, 4000]);
    assert.equal(count(net, SEND_KEY), DEFAULT_MAX_RETRIES + 1);
    assert.equal(e.rest.messages.length, 0);
    assert.equal(e.rest.failures.length, 1);
    await e.clock.advance(10 * 60_000);
    assert.equal(count(net, SEND_KEY), DEFAULT_MAX_RETRIES + 1, "no attempt after the rejection");
    assert.equal((await ch.health()).ok, true, "a failed send does not take the connection down");
  });
});

test("send: a 429 holds the re-send for the asked 3 s", async () => {
  await withChannelEnv(async (e, ch, net) => {
    await started(e, ch);
    const sleptBefore = e.clock.slept.length;
    e.rest.fail(POST_KEY, { status: 429, body: { retry_after: 3 } });
    const sending = ch.send({ chatId: GUILD_CHANNEL, text: "hello" });
    await settle(e.clock, () => e.clock.slept.length === sleptBefore + 1);
    assert.equal(e.clock.slept.at(-1), 3000);
    await e.clock.advance(2999);
    assert.equal(count(net, SEND_KEY), 1, "not re-sent one millisecond early");
    assert.equal(e.rest.messages.length, 0);
    await e.clock.advance(1);
    await guard(sending, "send()");
    assert.equal(count(net, SEND_KEY), 2);
    assert.equal(e.rest.messages.length, 1);
  });
});

test("send: a 403 is not retried", async () => {
  await withChannelEnv(async (e, ch, net) => {
    await started(e, ch);
    const sleptBefore = e.clock.slept.length;
    e.rest.fail(POST_KEY, { status: 403, body: { message: "Missing Access", code: 50001 } });
    await assert.rejects(guard(ch.send({ chatId: GUILD_CHANNEL, text: "hello" }), "send()"), (e2: unknown) => {
      assertApiError(e2, "forbidden", "discord forbidden (403): Missing Access", 403);
      return true;
    });
    assert.equal(count(net, SEND_KEY), 1);
    assert.deepEqual(e.clock.slept.slice(sleptBefore), []);
    assert.equal(e.rest.messages.length, 0);
  });
});
