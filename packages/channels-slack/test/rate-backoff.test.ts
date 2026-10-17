// Rate limit and backoff of channels-slack (docs/channels/slack.md section 10 and section 11).
//
// Constants the assertions rest on, and where they live:
//   MAX_SEND_RETRIES = 3                       src/channel.ts:54, so a failing call makes 3 + 1 = 4 requests
//   send backoff     min(60 s, 1 s * 2^n) * (0.75 + random * 0.5), n = 0, 1, 2     src/channel.ts:790
//   Retry-After band MIN 1 s .. MAX 5 min       src/api.ts:31-32, applied at api.ts:125 (call) and api.ts:235 (upload)
//   no Retry-After   Number(null) is 0, so the clamp raises it to MIN_RETRY_AFTER_MS = 1 s (api.ts:125). The `?? 1000` in
//                    channel.ts:789 is a second guard that no api-built error can reach.
//   socket backoff   min(60 s, 1 s * 2^(n-1)) * (0.75 + random * 0.5), a hint is a floor    src/socket.ts:296-297
//   long-lived reset a connection that stayed up >= 30 s restarts the backoff               src/socket.ts:58, 162
//   pacing           per conversation 1 token per 1000 ms (channel.ts:724), global 20 tokens, one per 50 ms (channel.ts:129)
//
// Time is never real here. `SleepGate` is the injected sleep seam: it records every wait, advances a fake clock by the wait
// when it completes, and can park a wait until the test releases it (the hold seam). The only real timers are the failure-only
// guards in `until` and `SleepGate.parked`, which fire after 5 s and only when something is already broken.
//
// The retry waits are read from the `channel.slack.request-retry` log line (waitMs, attempt), not from the raw sleep list: the
// same sleep seam also serves the two token buckets, so the raw list can hold pacing waits that are not retries.

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { SlackApi, SlackApiError, SocketFatalError, SocketMode, TokenBucket } from "../src/index.ts";
import type { SlackChannel, SlackChannelOptions, SlackErrorKind, SocketLike } from "../src/index.ts";
import { MAX_RETRY_AFTER_MS, MIN_RETRY_AFTER_MS } from "../src/api.ts";
import { FakeSlack, FakeSocket, FAKE_APP_TOKEN, FAKE_BOT_TOKEN, message } from "./helpers/fake-slack.ts";
import { wire } from "./helpers/wire.ts";

const T = { timeout: 20_000 };
const RETRY_LIMIT = 3;
const ATTEMPTS = RETRY_LIMIT + 1;
const GUARD_MS = 5_000;
const CHAT = "C0FAKE01";

// ------------------------------------------------------------------------------------------------ helpers

interface Parked {
  readonly ms: number;
  resume(): void;
}

/** Injected sleep: records, advances the fake clock on completion, parks while `hold()` is on, resolves on abort. */
class SleepGate {
  now = 1_700_000_000_000;
  parks = 0;
  readonly waits: number[] = [];
  #holding = false;
  readonly #parked: Parked[] = [];
  #listeners: Array<() => void> = [];

  readonly clock = (): number => this.now;

  readonly sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    this.waits.push(ms);
    if (signal.aborted) return Promise.resolve();
    if (!this.#holding) {
      this.now += ms;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = (elapsed: boolean): void => {
        signal.removeEventListener("abort", onAbort);
        const i = this.#parked.indexOf(entry);
        if (i >= 0) this.#parked.splice(i, 1);
        if (elapsed) this.now += ms;
        resolve();
      };
      const onAbort = (): void => finish(false);
      const entry: Parked = { ms, resume: () => finish(true) };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#parked.push(entry);
      this.parks++;
      for (const l of this.#listeners.splice(0)) l();
    });
  };

  hold(): void {
    this.#holding = true;
  }
  /** Stops parking and lets every parked wait elapse. */
  free(): void {
    this.#holding = false;
    for (const p of [...this.#parked]) p.resume();
  }
  advance(ms: number): void {
    this.now += ms;
  }
  pending(): number[] {
    return this.#parked.map((p) => p.ms);
  }
  releaseNext(): void {
    const first = this.#parked[0];
    if (!first) throw new Error("no parked wait to release");
    first.resume();
  }
  /** Resolves once the n-th wait of this gate has been parked. Failure-only guard timer. */
  async parked(n: number, label: string): Promise<void> {
    while (this.parks < n) {
      await new Promise<void>((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), GUARD_MS);
        this.#listeners.push(() => {
          clearTimeout(guard);
          resolve();
        });
      });
    }
  }
}

interface Req {
  kind: string;
  url: string;
  at: number;
}
type Hook = (req: Req, nth: number) => Response | Error | undefined;
interface RetryLog {
  kind: unknown;
  waitMs: number;
  attempt: number;
}
interface Rig {
  ch: SlackChannel;
  gate: SleepGate;
  /** Every fetch the channel made, in order, stamped with the fake clock. Counted before the request is sent. */
  requests: Req[];
  retries: RetryLog[];
  hook: Hook | undefined;
  count(kind: string): number;
}

function kindOf(url: string): string {
  const path = new URL(url).pathname;
  const api = /^\/api\/([\w.]+)$/.exec(path);
  if (api) return api[1]!;
  if (path.startsWith("/upload/v1/")) return "upload";
  if (path.startsWith("/files/")) return "download";
  return path;
}

let fake: FakeSlack;
let rg: Rig | undefined;
beforeEach(async () => {
  fake = new FakeSlack();
  await fake.listen();
  rg = undefined;
});
afterEach(async () => {
  rg?.gate.free();
  await rg?.ch.stop();
  await fake.close();
});

/** A channel on the fake platform with the gate as sleep and clock, a counting fetch and `random` fixed (0.5 = no jitter). */
function make(opts: { random?: number; extra?: Partial<SlackChannelOptions> } = {}): Rig {
  const gate = new SleepGate();
  const requests: Req[] = [];
  const retries: RetryLog[] = [];
  const r: Rig = {
    ch: undefined as never,
    gate,
    requests,
    retries,
    hook: undefined,
    count: (kind) => requests.filter((q) => q.kind === kind).length,
  };
  const countingFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const req: Req = { kind: kindOf(url), url, at: gate.now };
    requests.push(req);
    const hooked = r.hook?.(req, r.count(req.kind));
    if (hooked instanceof Error) throw hooked;
    if (hooked) return hooked;
    return fetch(input, init);
  };
  const random = opts.random ?? 0.5;
  r.ch = wire(fake, {
    sleep: gate.sleep,
    now: gate.clock,
    random: () => random,
    fetch: countingFetch,
    logger: {
      log: (_level, event, attrs) => {
        if (event === "channel.slack.request-retry")
          retries.push({ kind: attrs.kind, waitMs: Number(attrs.waitMs), attempt: Number(attrs.attempt) });
      },
    },
    ...opts.extra,
  }).ch;
  rg = r;
  return r;
}

async function up(opts: { random?: number; extra?: Partial<SlackChannelOptions> } = {}): Promise<Rig> {
  const r = make(opts);
  await r.ch.start();
  return r;
}

const send = (r: Rig, text = "hello"): Promise<void> => r.ch.send({ chatId: CHAT, text });
const png = { kind: "photo", data: Buffer.from([137, 80, 78, 71]), mimeType: "image/png", filename: "a.png" } as const;

/** Event loop turns with no timers: gives a wrongly early retry every chance to show up. */
async function turns(n = 40): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function until(cond: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + GUARD_MS; // failure-only guard, never on a passing path
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface Outcome {
  ok: boolean;
  error?: unknown;
}
/** Starts watching a promise at once, so an early rejection is never unhandled. */
const track = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error }),
  );

function assertApiError(
  e: unknown,
  want: { kind: SlackErrorKind; message: string; status?: number; code?: string; retryAfterMs?: number },
): void {
  assert.ok(e instanceof SlackApiError, `SlackApiError expected, got ${String(e)}`);
  assert.equal(e.kind, want.kind);
  assert.equal(e.message, want.message);
  assert.equal(e.status, want.status);
  assert.equal(e.code, want.code);
  assert.equal(e.retryAfterMs, want.retryAfterMs);
}

const respond = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const retryAfter = (header: string | undefined): Record<string, string> => (header === undefined ? {} : { "retry-after": header });
const netError = (): Error => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

/** Retry-After header (absent = undefined) -> the wait SlackApi builds from it. */
const HINTS: Array<[header: string | undefined, ms: number]> = [
  [undefined, 1_000],
  ["", 1_000],
  ["soon", 1_000],
  ["Wed, 21 Oct 2015 07:28:00 GMT", 1_000],
  ["0", 1_000],
  ["0.4", 1_000],
  ["-3", 1_000],
  ["1", 1_000],
  ["1.5", 1_500],
  ["2", 2_000],
  ["299", 299_000],
  ["300", 300_000],
  ["301", 300_000],
  ["999999", 300_000],
];

/** Answers that are final: kind decided by SlackApi.call, never retried by the channel. */
interface Terminal {
  status: number;
  body: unknown;
  kind: SlackErrorKind;
  message: string;
  code?: string;
}
const NOT_RETRIED: Terminal[] = [
  { status: 400, body: { ok: false, error: "msg_too_long" }, kind: "bad-request", code: "msg_too_long", message: "chat.postMessage failed: msg_too_long" },
  { status: 400, body: { ok: false, error: "invalid_arguments" }, kind: "bad-request", code: "invalid_arguments", message: "chat.postMessage failed: invalid_arguments" },
  { status: 400, body: "", kind: "bad-request", message: "chat.postMessage failed" },
  { status: 401, body: { ok: false, error: "invalid_auth" }, kind: "unauthorized", code: "invalid_auth", message: "chat.postMessage unauthorized: invalid_auth" },
  { status: 403, body: { ok: false, error: "missing_scope" }, kind: "forbidden", code: "missing_scope", message: "chat.postMessage forbidden: missing_scope" },
  { status: 403, body: "Forbidden", kind: "forbidden", message: "chat.postMessage forbidden" },
  { status: 404, body: { ok: false, error: "unknown_method" }, kind: "bad-request", code: "unknown_method", message: "chat.postMessage failed: unknown_method" },
  { status: 404, body: "<html>not found</html>", kind: "bad-request", message: "chat.postMessage failed" },
  { status: 408, body: "", kind: "bad-request", message: "chat.postMessage failed" },
  { status: 200, body: { ok: false, error: "invalid_auth" }, kind: "unauthorized", code: "invalid_auth", message: "chat.postMessage unauthorized: invalid_auth" },
  { status: 200, body: { ok: false, error: "token_revoked" }, kind: "unauthorized", code: "token_revoked", message: "chat.postMessage unauthorized: token_revoked" },
  { status: 200, body: { ok: false, error: "no_permission" }, kind: "forbidden", code: "no_permission", message: "chat.postMessage forbidden: no_permission" },
  { status: 200, body: { ok: false, error: "invalid_blocks" }, kind: "bad-request", code: "invalid_blocks", message: "chat.postMessage failed: invalid_blocks" },
  { status: 200, body: "<html>sign in</html>", kind: "protocol", message: "chat.postMessage returned a non-JSON response" },
];
const statusOf = (t: Terminal): { status: number; code?: string } => ({ status: t.status, ...(t.code !== undefined ? { code: t.code } : {}) });

// ------------------------------------------------------------------------------------------------ SlackApi: what it decides

function stubApi(answer: () => Response): { api: SlackApi; calls: () => number } {
  let calls = 0;
  const stub: typeof fetch = async () => {
    calls++;
    return answer();
  };
  return { api: new SlackApi({ botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN, fetch: stub }), calls: () => calls };
}

test("the Retry-After band is 1 s to 5 min, the numbers docs/channels/slack.md section 10 gives", T, () => {
  assert.equal(MIN_RETRY_AFTER_MS, 1_000);
  assert.equal(MAX_RETRY_AFTER_MS, 300_000);
});

test("SlackApi.call: a 429 becomes rate-limited with the clamped hint; no header means the 1 s minimum; one request, no loop", T, async () => {
  for (const [header, ms] of HINTS) {
    const { api, calls } = stubApi(() => respond(429, { ok: false, error: "ratelimited" }, retryAfter(header)));
    const err = await api.call("chat.postMessage", {}, new AbortController().signal).catch((e: unknown) => e);
    assertApiError(err, { kind: "rate-limited", message: "chat.postMessage rate limited", status: 429, retryAfterMs: ms });
    assert.equal(calls(), 1, `Retry-After ${header}: SlackApi itself never retries`);
  }
});

test("SlackApi.call: ok:false ratelimited and rate_limited are rate limits even on HTTP 200, hint and default as for a 429", T, async () => {
  for (const error of ["ratelimited", "rate_limited"]) {
    for (const [header, ms] of [[undefined, 1_000], ["4", 4_000]] as const) {
      const { api } = stubApi(() => respond(200, { ok: false, error }, retryAfter(header)));
      const err = await api.call("chat.postMessage", {}, new AbortController().signal).catch((e: unknown) => e);
      assertApiError(err, { kind: "rate-limited", message: "chat.postMessage rate limited", status: 200, retryAfterMs: ms });
    }
  }
});

test("SlackApi.call: every 4xx other than 429 and every Slack ok:false is a final kind, never rate-limited or http", T, async () => {
  for (const t of NOT_RETRIED) {
    const { api, calls } = stubApi(() => respond(t.status, t.body));
    const err = await api.call("chat.postMessage", {}, new AbortController().signal).catch((e: unknown) => e);
    assertApiError(err, { kind: t.kind, message: t.message, ...statusOf(t) });
    assert.equal(calls(), 1);
  }
});

test("SlackApi.uploadBytes: 429 carries the clamped hint, 5xx is http (retryable), other 4xx is bad-request (final)", T, async () => {
  const url = "https://files.slack.com/upload/v1/FAKE";
  const bytes = new Uint8Array([1, 2, 3]);
  for (const [header, ms] of HINTS) {
    const { api, calls } = stubApi(() => respond(429, "", retryAfter(header)));
    const err = await api.uploadBytes(url, bytes, new AbortController().signal).catch((e: unknown) => e);
    assertApiError(err, { kind: "rate-limited", message: "file upload rate limited", status: 429, retryAfterMs: ms });
    assert.equal(calls(), 1);
  }
  for (const [status, kind] of [[500, "http"], [502, "http"], [503, "http"], [504, "http"], [400, "bad-request"], [403, "bad-request"], [404, "bad-request"]] as const) {
    const { api, calls } = stubApi(() => respond(status, ""));
    const err = await api.uploadBytes(url, bytes, new AbortController().signal).catch((e: unknown) => e);
    assertApiError(err, { kind, message: `file upload failed with HTTP ${status}`, status });
    assert.equal(calls(), 1);
  }
});

// ------------------------------------------------------------------------------------------------ 1. 429 with Retry-After

test("429 with Retry-After: no retry before the hinted wait is over; parked wait, request count unchanged, then one retry (hold seam)", T, async () => {
  const r = await up();
  r.gate.hold();
  const cases: Array<[header: string, waitMs: number]> = [
    ["2", 2_000],
    ["7", 7_000],
    ["1", 1_000],
    ["0", 1_000], // clamp up to MIN_RETRY_AFTER_MS
    ["300", 300_000],
    ["999999", 300_000], // clamp down to MAX_RETRY_AFTER_MS
  ];
  for (const [header, waitMs] of cases) {
    r.gate.advance(1_000); // refills the 1 token per second conversation bucket: the only parked wait is the retry wait
    const before = r.count("chat.postMessage");
    const parks = r.gate.parks;
    fake.failNext("chat.postMessage", 429, { ok: false, error: "ratelimited" }, { "retry-after": header });
    const out = track(send(r));
    await r.gate.parked(parks + 1, `the retry wait for Retry-After ${header}`);
    assert.deepEqual(r.gate.pending(), [waitMs], `Retry-After ${header}`);
    assert.equal(r.count("chat.postMessage"), before + 1, "one request so far");
    await turns();
    assert.equal(r.count("chat.postMessage"), before + 1, `Retry-After ${header}: nothing is sent while the wait is parked`);
    assert.equal(fake.callsOf("chat.postMessage").length, before + 1, "and the platform saw only one");
    r.gate.releaseNext();
    assert.deepEqual(await out, { ok: true });
    assert.equal(r.count("chat.postMessage"), before + 2);
    const [first, second] = r.requests.slice(-2);
    assert.equal(second!.at - first!.at, waitMs, "the retry went out exactly one hinted wait after the first request");
    assert.deepEqual(r.retries.at(-1), { kind: "rate-limited", waitMs, attempt: 0 });
  }
});

test("429 with Retry-After on every outbound step: only the failed step is repeated, after the hinted wait", T, async () => {
  const r = await up();
  const [ref] = await r.ch.sendTurn({ chatId: CHAT, text: "draft" });
  const steps: Array<{ name: string; kinds: string[]; failed: string; arm: () => void; run: () => Promise<unknown> }> = [
    {
      name: "send",
      kinds: ["chat.postMessage"],
      failed: "chat.postMessage",
      arm: () => fake.failNext("chat.postMessage", 429, { ok: false, error: "ratelimited" }, { "retry-after": "3" }),
      run: () => send(r),
    },
    {
      name: "edit",
      kinds: ["chat.update"],
      failed: "chat.update",
      arm: () => fake.failNext("chat.update", 429, { ok: false, error: "ratelimited" }, { "retry-after": "3" }),
      run: () => r.ch.edit(ref!, "final"),
    },
    {
      name: "owner DM",
      kinds: ["conversations.open"],
      failed: "conversations.open",
      arm: () => fake.failNext("conversations.open", 429, { ok: false, error: "ratelimited" }, { "retry-after": "3" }),
      run: () => r.ch.resolveOwnerTarget({ userId: "UHUMAN01" }),
    },
    {
      name: "upload slot",
      kinds: ["files.getUploadURLExternal", "upload", "files.completeUploadExternal"],
      failed: "files.getUploadURLExternal",
      arm: () => fake.failNext("files.getUploadURLExternal", 429, { ok: false, error: "ratelimited" }, { "retry-after": "3" }),
      run: () => r.ch.sendTurn({ chatId: CHAT, text: "", attachments: [png] }),
    },
    {
      name: "upload bytes",
      kinds: ["files.getUploadURLExternal", "upload", "files.completeUploadExternal"],
      failed: "upload",
      arm: () => {
        const first = r.count("upload") + 1; // the first upload request of this step (earlier steps already uploaded)
        r.hook = (req, nth) => (req.kind === "upload" && nth === first ? respond(429, "", { "retry-after": "3" }) : undefined);
      },
      run: () => r.ch.sendTurn({ chatId: CHAT, text: "", attachments: [png] }),
    },
    {
      name: "upload complete",
      kinds: ["files.getUploadURLExternal", "upload", "files.completeUploadExternal"],
      failed: "files.completeUploadExternal",
      arm: () => fake.failNext("files.completeUploadExternal", 429, { ok: false, error: "ratelimited" }, { "retry-after": "3" }),
      run: () => r.ch.sendTurn({ chatId: CHAT, text: "", attachments: [png] }),
    },
  ];
  for (const s of steps) {
    r.gate.advance(2_000);
    r.hook = undefined;
    const before = Object.fromEntries(s.kinds.map((k) => [k, r.count(k)]));
    const retriesBefore = r.retries.length;
    s.arm();
    await s.run();
    for (const k of s.kinds) assert.equal(r.count(k) - before[k]!, k === s.failed ? 2 : 1, `${s.name}: ${k}`);
    assert.deepEqual(r.retries.slice(retriesBefore), [{ kind: "rate-limited", waitMs: 3_000, attempt: 0 }], s.name);
    const [first, second] = r.requests.filter((q) => q.kind === s.failed).slice(-2);
    assert.equal(second!.at - first!.at, 3_000, `${s.name}: the repeat waited the hint`);
  }
});

test("ok:false ratelimited on HTTP 200 is waited out like a 429", T, async () => {
  const r = await up();
  for (const error of ["ratelimited", "rate_limited"]) {
    r.gate.advance(1_000);
    const before = r.count("chat.postMessage");
    fake.failNext("chat.postMessage", 200, { ok: false, error }, { "retry-after": "5" });
    await send(r);
    assert.equal(r.count("chat.postMessage") - before, 2, error);
    assert.deepEqual(r.retries.at(-1), { kind: "rate-limited", waitMs: 5_000, attempt: 0 });
  }
});

test("429 on apps.connections.open: the reconnect loop waits the hint before the next open (hold seam)", T, async () => {
  const r = make();
  r.gate.hold();
  fake.failNext("apps.connections.open", 429, { ok: false, error: "ratelimited" }, { "retry-after": "7" });
  await r.ch.start();
  await r.gate.parked(1, "the reconnect wait");
  assert.deepEqual(r.gate.pending(), [7_000]);
  assert.equal(r.count("apps.connections.open"), 1);
  await turns();
  assert.equal(r.count("apps.connections.open"), 1, "no second open while the wait is parked");
  assert.equal((await r.ch.health()).ok, false);
  r.gate.releaseNext();
  await until(async () => (await r.ch.health()).ok, "connected after the wait");
  const [a, b] = r.requests.filter((q) => q.kind === "apps.connections.open");
  assert.equal(r.count("apps.connections.open"), 2);
  assert.equal(b!.at - a!.at, 7_000);
});

// ------------------------------------------------------------------------------------------------ 2. 429 without Retry-After

test("429 without a usable Retry-After waits the documented default of 1 s (MIN_RETRY_AFTER_MS, api.ts:31)", T, async () => {
  const r = await up();
  const cases: Array<[label: string, headers: Record<string, string> | undefined]> = [
    ["no header", undefined],
    ["empty header", { "retry-after": "" }],
    ["not a number", { "retry-after": "soon" }],
  ];
  for (const [label, headers] of cases) {
    r.gate.advance(1_000);
    const before = r.count("chat.postMessage");
    fake.failNext("chat.postMessage", 429, { ok: false, error: "ratelimited" }, headers);
    await send(r);
    assert.equal(r.count("chat.postMessage") - before, 2, label);
    assert.deepEqual(r.retries.at(-1), { kind: "rate-limited", waitMs: 1_000, attempt: 0 }, label);
    const [first, second] = r.requests.slice(-2);
    assert.equal(second!.at - first!.at, 1_000, `${label}: the default is a real wait`);
  }
});

test("429 without Retry-After on the upload URL and on an ok:false rate limit waits the same default", T, async () => {
  const r = await up();
  r.hook = (req, nth) => (req.kind === "upload" && nth === 1 ? respond(429, "") : undefined);
  await r.ch.sendTurn({ chatId: CHAT, text: "", attachments: [png] });
  assert.equal(r.count("upload"), 2);
  assert.deepEqual(r.retries.at(-1), { kind: "rate-limited", waitMs: 1_000, attempt: 0 });
  r.hook = undefined;
  r.gate.advance(1_000);
  fake.failNext("chat.postMessage", 200, { ok: false, error: "ratelimited" });
  await send(r);
  assert.deepEqual(r.retries.at(-1), { kind: "rate-limited", waitMs: 1_000, attempt: 0 });
});

// ------------------------------------------------------------------------------------------------ 3. 5xx: backoff, growth, limit + 1

test("5xx: waits grow 1 s, 2 s, 4 s, nothing is sent while a wait is parked, and the attempt count is the limit plus one", T, async () => {
  const r = await up();
  r.gate.hold();
  for (let i = 0; i < 10; i++) fake.failNext("chat.postMessage", 500, { ok: false, error: "internal_error" });
  const out = track(send(r));
  const waits = [1_000, 2_000, 4_000];
  for (const [i, ms] of waits.entries()) {
    await r.gate.parked(i + 1, `backoff wait ${i + 1}`);
    assert.deepEqual(r.gate.pending(), [ms]);
    assert.equal(r.count("chat.postMessage"), i + 1);
    await turns();
    assert.equal(r.count("chat.postMessage"), i + 1, `nothing is sent during wait ${i + 1}`);
    r.gate.releaseNext();
  }
  assert.equal((await out).ok, false);
  assert.equal(r.count("chat.postMessage"), ATTEMPTS, "limit (3) plus the first attempt");
  assert.deepEqual(r.retries.map((x) => x.waitMs), waits);
  assert.deepEqual(r.retries.map((x) => x.attempt), [0, 1, 2]);
  assert.ok(waits.every((w, i) => i === 0 || w > waits[i - 1]!), "strictly growing");
});

test("5xx: jitter stays inside minus/plus 25 percent of the base and the waits still grow strictly", T, async () => {
  for (const [random, expected] of [
    [0, [750, 1_500, 3_000]],
    [0.5, [1_000, 2_000, 4_000]],
    [1, [1_250, 2_500, 5_000]],
  ] as const) {
    fake.failures["chat.postMessage"] = [];
    const r = await up({ random });
    for (let i = 0; i < 10; i++) fake.failNext("chat.postMessage", 503, { ok: false, error: "service_unavailable" });
    assert.equal((await track(send(r))).ok, false);
    assert.equal(r.count("chat.postMessage"), ATTEMPTS, `random ${random}`);
    const waits = r.retries.map((x) => x.waitMs);
    assert.deepEqual(waits, expected, `random ${random}`);
    assert.ok(waits.every((w, i) => i === 0 || w > waits[i - 1]!), `random ${random}: growing`);
    await r.ch.stop();
  }
});

test("5xx classes (500, 502, 503, 504; JSON, HTML and empty bodies) are retried; one transient failure is invisible to the caller", T, async () => {
  const r = await up();
  const cases: Array<[number, unknown]> = [
    [500, { ok: false, error: "internal_error" }],
    [502, "<html>Bad Gateway</html>"],
    [503, { ok: false, error: "service_unavailable" }],
    [504, ""],
  ];
  for (const [status, body] of cases) {
    r.gate.advance(1_000);
    const before = r.count("chat.postMessage");
    fake.failNext("chat.postMessage", status, body);
    await send(r);
    assert.equal(r.count("chat.postMessage") - before, 2, `HTTP ${status}`);
    assert.deepEqual(r.retries.at(-1), { kind: "http", waitMs: 1_000, attempt: 0 }, `HTTP ${status}`);
  }
});

test("network errors are retried on the same schedule and the last one is a network SlackApiError", T, async () => {
  const r = await up();
  r.hook = (req) => (req.kind === "chat.postMessage" ? netError() : undefined);
  const out = await track(send(r));
  assert.equal(out.ok, false);
  assertApiError(out.error, { kind: "network", message: "chat.postMessage network error (ECONNRESET)" });
  assert.equal(r.count("chat.postMessage"), ATTEMPTS);
  assert.equal(fake.callsOf("chat.postMessage").length, 0, "the platform never saw a request");
  assert.deepEqual(r.retries.map((x) => x.waitMs), [1_000, 2_000, 4_000]);
});

test("an upload that keeps answering 5xx is retried with growing waits, up to the limit, and complete is never called", T, async () => {
  const r = await up();
  r.hook = (req) => (req.kind === "upload" ? respond(503, "") : undefined);
  const out = await track(r.ch.sendTurn({ chatId: CHAT, text: "", attachments: [png] }));
  assert.equal(out.ok, false);
  assertApiError(out.error, { kind: "http", message: "file upload failed with HTTP 503", status: 503 });
  assert.equal(r.count("upload"), ATTEMPTS);
  assert.equal(r.count("files.getUploadURLExternal"), 1, "the slot is not requested again");
  assert.equal(r.count("files.completeUploadExternal"), 0);
  assert.deepEqual(r.retries.map((x) => x.waitMs), [1_000, 2_000, 4_000]);
});

test("socket reconnect after 5xx on apps.connections.open backs off 1 s, 2 s, 4 s and then connects", T, async () => {
  const r = make();
  for (let i = 0; i < 3; i++) fake.failNext("apps.connections.open", 500, { ok: false, error: "internal_error" });
  await r.ch.start();
  await until(async () => (await r.ch.health()).ok, "connected after three failures");
  assert.equal(r.count("apps.connections.open"), 4);
  assert.deepEqual(r.gate.waits, [1_000, 2_000, 4_000]);
});

// Socket reconnect is endless by design (SocketMode.#supervise loops until aborted), so there is no attempt limit to assert:
// the run below is bounded by a finite list of failures, and what is checked is growth, plateau and cap.
interface SockRig {
  mode: SocketMode;
  sockets: FakeSocket[];
  waits: number[];
  clock: { now: number };
  failOpen: Array<Error | "ok">;
  opens: number;
  fatal: SocketFatalError[];
}
function sockRig(random: number): SockRig {
  const h: SockRig = { mode: undefined as never, sockets: [], waits: [], clock: { now: 0 }, failOpen: [], opens: 0, fatal: [] };
  h.mode = new SocketMode({
    openUrl: async () => {
      h.opens++;
      const next = h.failOpen.shift();
      if (next && next !== "ok") throw next;
      return `wss://wss.fake-slack.test/link/?ticket=T${h.opens}`;
    },
    socketFactory: (url) => {
      const s = new FakeSocket(url, true);
      h.sockets.push(s);
      queueMicrotask(() => s.open());
      return s as SocketLike;
    },
    onEnvelope: () => {},
    onFatal: (e) => h.fatal.push(e),
    onState: () => {},
    log: () => {},
    sleep: async (ms) => {
      h.waits.push(ms);
      h.clock.now += ms;
    },
    random: () => random,
    now: () => h.clock.now,
  });
  return h;
}

test("socket reconnect: waits double up to a 60 s base, then stay there; jitter is plus/minus 25 percent; attempts are not bounded by the send limit", T, async () => {
  const bases = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000];
  for (const [random, factor] of [[0, 0.75], [0.5, 1], [1, 1.25]] as const) {
    const h = sockRig(random);
    h.failOpen = [...bases.map(() => new SlackApiError("http", "x", { status: 503 })), "ok"];
    const ac = new AbortController();
    try {
      await h.mode.start(ac.signal);
      await until(() => h.mode.connected, `connected after ${bases.length} failures (random ${random})`);
      assert.deepEqual(h.waits, bases.map((b) => Math.round(b * factor)), `random ${random}`);
      assert.equal(h.opens, bases.length + 1, "one open per failure plus the one that worked");
      assert.ok(h.opens > ATTEMPTS, "no attempt limit like the send path has");
      const growth = h.waits.slice(0, 7);
      assert.ok(growth.every((w, i) => i === 0 || w > growth[i - 1]!), "strictly growing until the cap");
      assert.ok(h.waits.slice(6).every((w) => w === h.waits[6]), "flat once capped");
      assert.ok(Math.max(...h.waits) <= 75_000, "never above the 60 s cap plus 25 percent jitter");
    } finally {
      ac.abort();
      await h.mode.stop();
    }
  }
});

test("socket reconnect: a connection that stayed up 30 s restarts the backoff, one that fell 1 ms short does not", T, async () => {
  const h = sockRig(0.5);
  const ac = new AbortController();
  try {
    await h.mode.start(ac.signal);
    const dropAfter = async (upMs: number, nth: number): Promise<void> => {
      h.clock.now += upMs;
      h.sockets.at(-1)!.serverDrop();
      await until(() => h.sockets.length === nth && h.mode.connected, `socket ${nth}`);
    };
    await dropAfter(100, 2);
    await dropAfter(100, 3);
    await dropAfter(100, 4);
    await dropAfter(30_000, 5); // exactly LONG_LIVED_MS: backoff restarts
    await dropAfter(29_999, 6); // 1 ms short: it keeps growing
    await dropAfter(31_000, 7);
    assert.deepEqual(h.waits, [1_000, 2_000, 4_000, 1_000, 2_000, 1_000]);
  } finally {
    ac.abort();
    await h.mode.stop();
  }
});

// ------------------------------------------------------------------------------------------------ 4. not retried

test("4xx other than 429 and Slack ok:false answers are not retried: exactly one request, no retry wait, a typed error", T, async () => {
  const r = await up();
  for (const t of NOT_RETRIED) {
    r.gate.advance(1_000); // keeps the conversation bucket full: any sleep at all would be a retry wait
    const before = r.count("chat.postMessage");
    fake.failNext("chat.postMessage", t.status, t.body);
    const out = await track(send(r));
    assert.equal(out.ok, false, `${t.status} ${JSON.stringify(t.body)}`);
    assertApiError(out.error, { kind: t.kind, message: t.message, ...statusOf(t) });
    assert.equal(r.count("chat.postMessage") - before, 1, `${t.status} ${JSON.stringify(t.body)}: one request`);
  }
  await turns();
  assert.deepEqual(r.retries, []);
  assert.deepEqual(r.gate.waits, [], "no sleep of any kind");
});

test("the other outbound steps do not retry a final answer either: owner DM, upload slot, upload bytes, upload complete, download", T, async () => {
  const r = await up();
  fake.failNext("conversations.open", 400, { ok: false, error: "user_not_found" });
  await assert.rejects(r.ch.resolveOwnerTarget({ userId: "UHUMAN01" }), /conversations\.open failed: user_not_found/);
  assert.equal(r.count("conversations.open"), 1);

  fake.failNext("files.getUploadURLExternal", 400, { ok: false, error: "invalid_arguments" });
  await assert.rejects(r.ch.sendTurn({ chatId: CHAT, text: "", attachments: [png] }), /files\.getUploadURLExternal failed: invalid_arguments/);
  assert.equal(r.count("files.getUploadURLExternal"), 1);
  assert.equal(r.count("upload"), 0);

  for (const status of [400, 403, 404]) {
    const before = r.count("upload");
    r.hook = (req) => (req.kind === "upload" ? respond(status, "") : undefined);
    const out = await track(r.ch.sendTurn({ chatId: CHAT, text: "", attachments: [png] }));
    assertApiError(out.error, { kind: "bad-request", message: `file upload failed with HTTP ${status}`, status });
    assert.equal(r.count("upload") - before, 1, `upload ${status}`);
  }
  r.hook = undefined;
  assert.equal(r.count("files.completeUploadExternal"), 0);

  fake.failNext("files.completeUploadExternal", 403, { ok: false, error: "no_permission" });
  await assert.rejects(r.ch.sendTurn({ chatId: CHAT, text: "", attachments: [png] }), /files\.completeUploadExternal forbidden: no_permission/);
  assert.equal(r.count("files.completeUploadExternal"), 1);

  const got: unknown[] = [];
  r.ch.onMessage((m) => void got.push(m));
  fake.push(message({ channel: "D0FAKE01", user: "UHUMAN01", text: "see", ts: "1700000020.000100", files: [{ id: "F1", name: "pic.png", mimetype: "image/png", size: 4, url_private_download: `${fake.root}/files/NOPE` }] }));
  await r.ch.idle();
  assert.equal(r.count("download"), 1, "a 404 on a file download is one request");
  assert.equal(got.length, 0);
  assert.deepEqual(r.retries, []);
});

test("auth failures on apps.connections.open are fatal: start rejects once, one open request, no wait, no later attempt", T, async () => {
  const cases: Array<[number, unknown]> = [
    [200, { ok: false, error: "invalid_auth" }],
    [200, { ok: false, error: "token_revoked" }],
    [403, { ok: false, error: "missing_scope" }],
  ];
  for (const [status, body] of cases) {
    const r = make();
    fake.failNext("apps.connections.open", status, body);
    const before = fake.callsOf("apps.connections.open").length;
    await assert.rejects(r.ch.start(), (e: Error) => e.message === "slack authentication failed");
    await turns();
    assert.equal(fake.callsOf("apps.connections.open").length - before, 1, JSON.stringify(body));
    assert.deepEqual(r.gate.waits, []);
    assert.equal((await r.ch.health()).ok, false);
  }
});

test("a non-fatal failure on apps.connections.open (unlike a send) is retried by design: only the listed auth codes stop the loop", T, async () => {
  const r = make();
  fake.failNext("apps.connections.open", 404, { ok: false, error: "unknown_method" });
  await r.ch.start();
  await until(async () => (await r.ch.health()).ok, "connected after one failure");
  assert.equal(r.count("apps.connections.open"), 2);
  assert.deepEqual(r.gate.waits, [1_000]);
});

// ------------------------------------------------------------------------------------------------ 5. limit reached

test("after the limit the call rejects with the last error (kind http, status 500, fixed message) and no further attempt happens", T, async () => {
  const r = await up();
  for (let i = 0; i < 10; i++) fake.failNext("chat.postMessage", 500, { ok: false, error: "internal_error" });
  const out = await track(send(r));
  assert.equal(out.ok, false);
  assertApiError(out.error, { kind: "http", message: "chat.postMessage failed with HTTP 500: internal_error", status: 500, code: "internal_error" });
  assert.equal(r.count("chat.postMessage"), ATTEMPTS);
  assert.deepEqual(r.retries, [
    { kind: "http", waitMs: 1_000, attempt: 0 },
    { kind: "http", waitMs: 2_000, attempt: 1 },
    { kind: "http", waitMs: 4_000, attempt: 2 },
  ]);
  const queued = fake.failures["chat.postMessage"]!.length;
  assert.equal(queued, 10 - ATTEMPTS, "the failures the platform never got to serve are still queued");
  await turns(80);
  assert.equal(r.count("chat.postMessage"), ATTEMPTS, "still four after a long quiet period");
  assert.equal(fake.failures["chat.postMessage"]!.length, queued);
  assert.deepEqual(r.gate.pending(), []);
});

test("after the limit a 429 rejects as rate-limited; every retry waited the hint, no growth on top of it", T, async () => {
  const r = await up();
  for (let i = 0; i < 10; i++) fake.failNext("chat.postMessage", 429, { ok: false, error: "ratelimited" }, { "retry-after": "2" });
  const out = await track(send(r));
  assert.equal(out.ok, false);
  assertApiError(out.error, { kind: "rate-limited", message: "chat.postMessage rate limited", status: 429, retryAfterMs: 2_000 });
  assert.equal(r.count("chat.postMessage"), ATTEMPTS);
  assert.deepEqual(r.retries.map((x) => x.waitMs), [2_000, 2_000, 2_000]);
  await turns(80);
  assert.equal(r.count("chat.postMessage"), ATTEMPTS);
  assert.equal(fake.failures["chat.postMessage"]!.length, 10 - ATTEMPTS);
});

test("the retry budget belongs to one call: three failures then success works, and a later call starts with a full budget", T, async () => {
  const r = await up();
  for (let i = 0; i < 10; i++) fake.failNext("chat.postMessage", 500, { ok: false, error: "internal_error" });
  assert.equal((await track(send(r))).ok, false);
  fake.failures["chat.postMessage"] = [];
  const before = r.count("chat.postMessage");
  for (let i = 0; i < RETRY_LIMIT; i++) fake.failNext("chat.postMessage", 502, "<html>Bad Gateway</html>");
  r.gate.advance(1_000);
  await send(r);
  assert.equal(r.count("chat.postMessage") - before, ATTEMPTS, "the third retry is the one that succeeds");
});

test("stopping the channel while a retry wait is parked ends the retry loop: abort error, no further request", T, async () => {
  const r = await up();
  r.gate.hold();
  fake.failNext("chat.postMessage", 503, { ok: false, error: "service_unavailable" });
  const out = track(send(r));
  await r.gate.parked(1, "the retry wait");
  assert.equal(r.count("chat.postMessage"), 1);
  await r.ch.stop();
  const result = await out;
  assert.equal(result.ok, false);
  assert.equal((result.error as { name?: string }).name, "AbortError");
  await turns();
  assert.equal(r.count("chat.postMessage"), 1);
});

// ------------------------------------------------------------------------------------------------ pacing (rate-limit.ts)

function bucketRig(capacity: number, intervalMs: number): { bucket: TokenBucket; waits: number[]; clock: { now: number } } {
  const waits: number[] = [];
  const clock = { now: 0 };
  const bucket = new TokenBucket(capacity, intervalMs, () => clock.now, async (ms) => {
    waits.push(ms);
    clock.now += ms;
  });
  return { bucket, waits, clock };
}

test("TokenBucket: a bucket of 1 token per second serves the first take at once and waits 1000 ms before each further one", T, async () => {
  const { bucket, waits } = bucketRig(1, 1_000);
  const signal = new AbortController().signal;
  await bucket.take(signal);
  assert.deepEqual(waits, []);
  await bucket.take(signal);
  await bucket.take(signal);
  assert.deepEqual(waits, [1_000, 1_000]);
});

test("TokenBucket: concurrent takes are serialised, no two spend the same token; idle time never banks more than the capacity", T, async () => {
  const a = bucketRig(1, 1_000);
  const signal = new AbortController().signal;
  await Promise.all([a.bucket.take(signal), a.bucket.take(signal), a.bucket.take(signal)]);
  assert.deepEqual(a.waits, [1_000, 1_000]);
  assert.equal(a.clock.now, 2_000);
  const b = bucketRig(1, 1_000);
  await b.bucket.take(signal);
  b.clock.now += 10_000;
  await b.bucket.take(signal);
  assert.deepEqual(b.waits, [], "refilled while idle");
  await b.bucket.take(signal);
  assert.deepEqual(b.waits, [1_000], "ten idle seconds did not buy a second free token");
});

test("TokenBucket: the global shape (20 tokens, one per 50 ms) lets 20 through and holds the 21st for 50 ms", T, async () => {
  const { bucket, waits } = bucketRig(20, 50);
  const signal = new AbortController().signal;
  for (let i = 0; i < 20; i++) await bucket.take(signal);
  assert.deepEqual(waits, []);
  await bucket.take(signal);
  assert.deepEqual(waits, [50]);
});

test("TokenBucket: an abort during the wait rejects the take and does not wedge the bucket", T, async () => {
  const clock = { now: 0 };
  const waits: number[] = [];
  let park = true;
  const bucket = new TokenBucket(1, 1_000, () => clock.now, (ms, signal) => {
    waits.push(ms);
    if (!park) {
      clock.now += ms;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const first = new AbortController();
  await bucket.take(first.signal);
  const waiting = track(bucket.take(first.signal));
  await until(() => waits.length === 1, "the take to start waiting");
  first.abort();
  const out = await waiting;
  assert.equal(out.ok, false);
  assert.equal((out.error as { name?: string }).name, "AbortError");
  park = false;
  await bucket.take(new AbortController().signal);
  assert.deepEqual(waits, [1_000, 1_000], "the next take waited in full: the aborted one never got its token");
});

test("per-conversation pacing: the second message to one chat waits 1000 ms, another chat does not, and none of it is a retry", T, async () => {
  const r = await up();
  await send(r, "one");
  await send(r, "two");
  await r.ch.send({ chatId: "G0GROUP1", text: "other chat" });
  assert.deepEqual(r.gate.waits, [1_000]);
  assert.deepEqual(r.retries, []);
  assert.equal(r.count("chat.postMessage"), 3);
});

test("global pacing: 20 sends to 20 different chats pass, the 21st waits 50 ms", T, async () => {
  const chats = "ABCDEFGHIJKLMNOPQRSTU".split("").map((c) => `C0PACE${c}`);
  const r = await up({ extra: { allowlist: chats } });
  for (const [i, chat] of chats.entries()) {
    await r.ch.send({ chatId: chat, text: `m${i}` });
    assert.deepEqual(r.gate.waits, i < 20 ? [] : [50], `after send ${i + 1}`);
  }
  assert.deepEqual(r.retries, []);
});

// ------------------------------------------------------------------------------------------------ known gaps

test(
  "an inbound file download retries a transient 503 like any other 5xx",
  {
    ...T,
  },
  async () => {
    const r = await up();
    const got: unknown[] = [];
    r.ch.onMessage((m) => void got.push(m));
    fake.files.set("F1", { name: "pic.png", mime: "image/png", data: Buffer.from([137, 80, 78, 71]) });
    r.hook = (req, nth) => (req.kind === "download" && nth === 1 ? respond(503, "") : undefined);
    fake.push(message({ channel: "D0FAKE01", user: "UHUMAN01", text: "see", ts: "1700000010.000100", files: [{ id: "F1", name: "pic.png", mimetype: "image/png", size: 4, url_private_download: `${fake.root}/files/F1` }] }));
    await r.ch.idle();
    assert.equal(r.count("download"), 2, "retried once after the 503");
    assert.equal(got.length, 1, "the message with its attachment is delivered");
  },
);

test(
  "an inbound file download waits the Retry-After of a 429 and retries",
  {
    ...T,
  },
  async () => {
    const r = await up();
    const got: unknown[] = [];
    r.ch.onMessage((m) => void got.push(m));
    fake.files.set("F1", { name: "pic.png", mime: "image/png", data: Buffer.from([137, 80, 78, 71]) });
    r.hook = (req, nth) => (req.kind === "download" && nth === 1 ? respond(429, "", { "retry-after": "2" }) : undefined);
    fake.push(message({ channel: "D0FAKE01", user: "UHUMAN01", text: "see", ts: "1700000011.000100", files: [{ id: "F1", name: "pic.png", mimetype: "image/png", size: 4, url_private_download: `${fake.root}/files/F1` }] }));
    await r.ch.idle();
    assert.equal(r.count("download"), 2, "retried once after the 429");
    assert.deepEqual(r.retries.at(-1), { kind: "rate-limited", waitMs: 2_000, attempt: 0 });
    assert.equal(got.length, 1);
  },
);

test(
  "the server error codes api.ts lists as retryable are retried when Slack sends them on HTTP 200",
  {
    ...T,
  },
  async () => {
    const r = await up();
    for (const error of ["internal_error", "service_unavailable", "fatal_error", "request_timeout", "team_added_to_org"]) {
      r.gate.advance(1_000);
      const before = r.count("chat.postMessage");
      fake.failNext("chat.postMessage", 200, { ok: false, error });
      const out = await track(send(r));
      assert.equal(out.ok, true, `${error}: the retry succeeds`);
      assert.equal(r.count("chat.postMessage") - before, 2, `${error}: one retry`);
    }
  },
);
