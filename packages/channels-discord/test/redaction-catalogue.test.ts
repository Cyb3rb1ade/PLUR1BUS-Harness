import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChannelHealth, ChannelHost } from "../../core/src/channels/types.ts";
import { DiscordApiError, DiscordChannel, type DiscordConfig, type DiscordDeps, type DiscordErrorKind } from "../src/index.ts";
import { BASE_CONFIG, makeEnv, type Env } from "./helpers/env.ts";
import { drive, settle } from "./helpers/fake-clock.ts";
import { DM_CHANNEL, DM_USER, GUILD_CHANNEL, TOKEN, cdnAwareFetch, snowflake, type FakeSocket } from "./helpers/fake-discord.ts";

// Secret redaction for the Discord channel. A credential marker is planted (as the bot token the secret store hands out, and in a few
// places in the configuration) and then every error path is driven. The marker must never appear, as a plain substring, in
//   - the host logger (every level the channel might call) and the logger given to the constructor,
//   - err.message and err.cause (recursively) of whatever start(), send() and health() raise, and of host.fail,
//   - health().detail,
//   - any URL inside a log line, nor in any URL the channel dials (fetch and WebSocket).
// The expectations are written here on purpose; redact.ts is the object under test and is not used as a helper.
//
// MARKER. channel.ts (TOKEN_FORMAT, checked in start() before any request) refuses a secret that is not token-shaped, so a marker
// like "MARKER_SECRET_ONE" would stop at "unexpected format" and never reach REST or the gateway. The fixture TOKEN is the package's
// own token-shaped placeholder, so it is reused. Besides the full value, two long distinctive segments are searched for; that also
// catches a partial echo (one segment surviving redaction). The short middle segment is left out because it is not distinctive.
const NEEDLES: ReadonlyArray<{ name: string; text: string }> = [
  { name: "full token", text: TOKEN },
  { name: "first segment", text: TOKEN.split(".")[0]! },
  { name: "last segment", text: TOKEN.split(".")[2]! },
];

// ---- the scanner --------------------------------------------------------------------------------------------------------

interface Line {
  level: string;
  event: string;
  attrs: unknown;
}
interface Capture {
  /** What the channel wrote to the host logger, whatever level it asked for. */
  hostLog: Line[];
  /** What the channel wrote to the logger given to its constructor. */
  ctorLog: Line[];
  /** Every rejection of start()/send()/health()/..., plus every host.fail argument. */
  errors: Array<{ where: string; err: unknown }>;
  health: unknown[];
  /** Every URL the channel dialled over fetch or WebSocket. */
  urls: string[];
}
const newCapture = (): Capture => ({ hostLog: [], ctorLog: [], errors: [], health: [], urls: [] });

/** Everything a reader of `v` could see. JSON.stringify(new Error("x")) is "{}" (message, name and cause are not enumerable), so errors are walked by hand. */
function render(v: unknown, depth = 0): string {
  if (depth > 8) return "";
  if (v instanceof Error) {
    return [v.name, v.message, render(Object.fromEntries(Object.entries(v)), depth + 1), render(v.cause, depth + 1)].join("\n");
  }
  if (typeof v === "string") return v;
  if (v === undefined) return "";
  try {
    return JSON.stringify(v, (_k, x: unknown) => (x instanceof Error ? render(x, depth + 1) : x)) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Plain substring search, nothing cleverer. */
function findMarker(text: string): string | undefined {
  return NEEDLES.find((n) => text.includes(n.text))?.name;
}

function urlsIn(text: string): string[] {
  return text.match(/\b(?:https?|wss?):\/\/[^\s"'<>\\]+/g) ?? [];
}

/** One entry per surface that shows the marker; an empty list is the pass condition. */
function audit(cap: Capture): string[] {
  const leaks: string[] = [];
  const check = (where: string, v: unknown): void => {
    const hit = findMarker(render(v));
    if (hit !== undefined) leaks.push(`${where}: ${hit}`);
  };
  const lines = (name: string, list: Line[]): void =>
    list.forEach((l, i) => {
      check(`${name}[${i}] ${l.level} ${l.event}`, l);
      for (const u of urlsIn(render(l))) check(`url in ${name}[${i}]`, u);
    });
  lines("host.log", cap.hostLog);
  lines("ctor logger", cap.ctorLog);
  for (const { where, err } of cap.errors) {
    check(`${where} message`, err instanceof Error ? err.message : err);
    check(`${where} cause`, err instanceof Error ? err.cause : undefined);
    check(`${where} whole error`, err);
  }
  cap.health.forEach((h, i) => check(`health[${i}]`, h));
  cap.urls.forEach((u, i) => check(`dialled url[${i}]`, u));
  return leaks;
}

// ---- rig: the in-process environment plus capture -----------------------------------------------------------------------

type Settled<T> = { ok: true; value: T } | { ok: false; err: unknown };
interface Req {
  method: string;
  url: URL;
}
type Responder = (req: Req) => Response | Promise<Response>;
interface Net {
  fetch: typeof fetch;
  /** Replies for requests whose "METHOD /path" starts with `prefix`, consumed in order; afterwards the request reaches the loopback fake. */
  script(prefix: string, ...steps: Responder[]): void;
  unconsumed(): number;
  /** Requests that carried the real bot token in their Authorization header (proves the marker is in play). */
  authSeen: number;
}
interface Rig {
  readonly e: Env;
  readonly cap: Capture;
  readonly net: Net;
  readonly host: ChannelHost;
  readonly ch: DiscordChannel;
  /** Settles `p` under virtual time and records a rejection under `where`. */
  attempt<T>(where: string, p: Promise<T>): Promise<Settled<T>>;
  health(): Promise<ChannelHealth>;
  started(): Promise<void>;
}
interface RigOptions {
  over?: Partial<DiscordConfig>;
  deps?: (parts: { e: Env; cap: Capture; net: Net }) => Partial<DiscordDeps>;
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Responder =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const text =
  (status: number, body: string, headers: Record<string, string> = {}): Responder =>
  () =>
    new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
const fail =
  (make: () => unknown): Responder =>
  () => {
    throw make();
  };

function makeNet(e: Env, cap: Capture): Net {
  const real = cdnAwareFetch(e.rest);
  const rules: Array<{ prefix: string; steps: Responder[] }> = [];
  const net: Net = {
    authSeen: 0,
    script(prefix, ...steps) {
      rules.push({ prefix, steps: [...steps] });
    },
    unconsumed: () => rules.reduce((n, r) => n + r.steps.length, 0),
    fetch: ((input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      cap.urls.push(url.href);
      const method = (init?.method ?? "GET").toUpperCase();
      if ((init?.headers as Record<string, string> | undefined)?.authorization === `Bot ${TOKEN}`) net.authSeen += 1;
      const key = `${method} ${url.pathname}`;
      const rule = rules.find((r) => key.startsWith(r.prefix) && r.steps.length > 0);
      if (!rule) return real(input, init);
      const step = rule.steps.shift()!;
      return Promise.resolve().then(() => step({ method, url }));
    }) as typeof fetch,
  };
  return net;
}

/** Waits for `p` under virtual time (retries and backoff sleep on the fake clock) and records a rejection under `where`. */
async function settleAndRecord<T>(e: Env, cap: Capture, where: string, p: Promise<T>): Promise<Settled<T>> {
  const settled = p.then(
    (value): Settled<T> => ({ ok: true, value }),
    (err: unknown): Settled<T> => ({ ok: false, err }),
  );
  await drive(e.clock, settled);
  const r = await settled;
  if (!r.ok) cap.errors.push({ where, err: r.err });
  return r;
}

/** Runs `body` on a fresh environment, stops the channel, then audits everything captured. The audit is the assertion every scenario shares. */
async function withRig(body: (r: Rig) => Promise<void>, opts: RigOptions = {}): Promise<void> {
  const e = await makeEnv(opts.over);
  const cap = newCapture();
  const net = makeNet(e, cap);
  const host: ChannelHost = {
    receive: async () => {},
    fail: (err) => void cap.errors.push({ where: "host.fail", err }),
    // A Proxy so that any level the channel might call (also ones the interface does not declare) is recorded.
    log: new Proxy({} as ChannelHost["log"], {
      get: (_t, level) => (event: string, attrs?: unknown) => void cap.hostLog.push({ level: String(level), event, attrs }),
    }),
  };
  const deps: Partial<DiscordDeps> = {
    logger: { log: (level, event, attrs) => void cap.ctorLog.push({ level, event, attrs }) },
    fetch: net.fetch,
    webSocket: (url) => {
      cap.urls.push(url);
      return e.gateway.factory(url);
    },
    ...opts.deps?.({ e, cap, net }),
  };
  const ch = e.channel({}, deps);
  const rig: Rig = {
    e,
    cap,
    net,
    host,
    ch,
    attempt: (where, p) => settleAndRecord(e, cap, where, p),
    async health() {
      try {
        const h = await ch.health();
        cap.health.push(h);
        return h;
      } catch (err) {
        cap.errors.push({ where: "health", err });
        throw err;
      }
    },
    async started() {
      const s = await rig.attempt("start", ch.start(host));
      assert.ok(s.ok, "start() resolves");
    },
  };
  try {
    await body(rig);
  } finally {
    await ch.stop();
    await e.close();
  }
  assert.ok(cap.ctorLog.length + cap.errors.length > 0, "the scenario produced something to scan");
  assert.deepEqual(audit(cap), [], "the marker must not appear in logs, errors, health or URLs");
}

/** Polls until `pred` holds. The 5 s deadline only matters on failure. */
async function until(what: string, pred: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise<void>((r) => setTimeout(r, 1));
  }
}

function closeWithReason(s: FakeSocket, code: number, reason: string): void {
  s.closed = { code, reason };
  s.onclose?.({ code, reason });
}

let seq = 0;
const dmMessage = (content: string) => ({
  id: snowflake(++seq + 95_000),
  type: 0,
  channel_id: DM_CHANNEL,
  author: { id: DM_USER },
  content,
  timestamp: new Date(1_700_000_000_000).toISOString(),
  mentions: [],
  attachments: [],
});

// ---- positive controls: the scanner is not vacuous ----------------------------------------------------------------------

test("control: the needles are distinctive pieces of the fixture token", () => {
  for (const n of NEEDLES) {
    assert.ok(TOKEN.includes(n.text), n.name);
    assert.ok(n.text.length >= 20, `${n.name} is long enough to be distinctive`);
  }
  assert.equal(findMarker(`before ${TOKEN} after`), "full token");
  assert.equal(findMarker(`only ${NEEDLES[1]!.text} here`), "first segment");
  assert.equal(findMarker(`only ${NEEDLES[2]!.text} here`), "last segment");
  assert.equal(findMarker("discord bot token secret has an unexpected format"), undefined);
  assert.equal(findMarker(""), undefined);
});

test("control: JSON.stringify is blind to errors, render() is not", () => {
  const inner = new Error(`inner ${TOKEN}`);
  const outer = new Error("outer", { cause: inner });
  assert.equal(findMarker(JSON.stringify(outer)), undefined, "a stringify-and-search scanner would pass vacuously");
  assert.ok(findMarker(render(inner)));
  assert.ok(findMarker(render(outer)), "found through .cause");
  assert.ok(findMarker(render(new Error("deep", { cause: new Error("mid", { cause: { detail: [TOKEN] } }) }))), "found through a non-Error cause");
  assert.ok(findMarker(render(Object.assign(new Error("own props"), { detail: TOKEN }))), "found in an own enumerable property");
  assert.ok(findMarker(render({ a: [{ b: TOKEN }] })));
  assert.ok(findMarker(render(TOKEN)));
  assert.equal(findMarker(render(new Error("clean", { cause: new Error("also clean") }))), undefined);
});

test("control: audit() reports the marker on every surface it covers, and nothing on a clean capture", () => {
  const surfaces: Array<[string, (c: Capture) => void, string]> = [
    ["host.log attribute", (c) => c.hostLog.push({ level: "debug", event: "e", attrs: { detail: `x ${TOKEN}` } }), "host.log[0]"],
    ["host.log event name", (c) => c.hostLog.push({ level: "info", event: TOKEN, attrs: {} }), "host.log[0]"],
    ["constructor logger attribute", (c) => c.ctorLog.push({ level: "warn", event: "e", attrs: { detail: NEEDLES[2]!.text } }), "ctor logger[0]"],
    ["URL inside a log line", (c) => c.hostLog.push({ level: "info", event: "e", attrs: { url: `https://discord.com/api/webhooks/1/${TOKEN}/m` } }), "url in host.log[0]"],
    ["start() message", (c) => c.errors.push({ where: "start", err: new Error(`bad ${TOKEN}`) }), "start message"],
    ["send() cause", (c) => c.errors.push({ where: "send", err: new Error("fixed", { cause: new Error(TOKEN) }) }), "send cause"],
    ["host.fail argument", (c) => c.errors.push({ where: "host.fail", err: new Error(`close ${TOKEN}`) }), "host.fail message"],
    ["health() detail", (c) => c.health.push({ ok: false, detail: `x ${TOKEN}` }), "health[0]"],
    ["dialled URL", (c) => c.urls.push(`wss://gateway.test.invalid/?token=${TOKEN}`), "dialled url[0]"],
  ];
  for (const [name, plant, expected] of surfaces) {
    const c = newCapture();
    plant(c);
    const leaks = audit(c);
    assert.ok(leaks.some((l) => l.startsWith(expected)), `${name}: expected a report starting with "${expected}", got ${JSON.stringify(leaks)}`);
  }
  const clean = newCapture();
  clean.hostLog.push({ level: "info", event: "channel.discord.started", attrs: { resumed: false, commands: 1 } });
  clean.errors.push({ where: "send", err: new DiscordApiError("http", "discord http (500): Internal Server Error", { status: 500 }) });
  clean.health.push({ ok: true, detail: "connected" });
  clean.urls.push("wss://gateway.test.invalid/?v=10&encoding=json");
  assert.deepEqual(audit(clean), []);
  assert.deepEqual(urlsIn(`GET https://a.test/x/${TOKEN}/y, then "wss://b.test/?v=10"`), [`https://a.test/x/${TOKEN}/y,`, "wss://b.test/?v=10"]);
});

test("baseline: a healthy start, send and stop leaks nothing, and the marker is in play on the wire", async () => {
  await withRig(async (r) => {
    await r.started(); // also proves the fixture token passes the channel's own token-format gate
    const sent = await r.attempt("send", r.ch.send({ chatId: GUILD_CHANNEL, text: "hello" }));
    assert.ok(sent.ok);
    assert.deepEqual(await r.health(), { ok: true, detail: "connected" });
    // The credential really travels: Authorization header on REST and the gateway identify frame. Neither is scanned (it is the wire).
    assert.ok(r.net.authSeen >= 2, "REST requests carried the bot token");
    const identify = r.e.gateway.frames.find((f) => f.frame.op === 2);
    assert.equal((identify!.frame.d as { token?: string }).token, TOKEN);
    assert.ok(findMarker(render(identify)), "the scanner would flag the identify frame, so the wire is rightly excluded");
    assert.ok(findMarker(r.e.rest.calls[0]!.auth ?? ""), "and the Authorization header");
    // Something was logged, so the empty audit is not an empty haystack.
    assert.ok(r.cap.ctorLog.some((l) => l.event === "channel.discord.started"));
    assert.ok(r.cap.hostLog.some((l) => l.event === "channel.discord.started"));
  });
});

// ---- REST failures: auth, 5xx, invalid JSON, 429 ----------------------------------------------------------------------------

interface RestCase {
  status: number;
  kind: DiscordErrorKind;
  /** Requests the call makes before the error surfaces (retries included). */
  attempts: number;
  reply: Responder;
}

const webhookUrl = `https://discord.com/api/v10/webhooks/${snowflake(7)}/${TOKEN}/messages/@original`;
/** Error bodies in which an upstream (or a proxy in front of it) repeats the credential. */
const ECHO_BODIES: Array<[string, unknown]> = [
  ["token in message", { message: `Internal error ${TOKEN}`, code: 0 }],
  ["Authorization header form in message", { message: `Authorization: Bot ${TOKEN}`, code: 0 }],
  ["webhook URL in message", { message: `POST ${webhookUrl} failed`, code: 0 }],
  ["token straddling the 200 character cut", { message: `${"x".repeat(165)} ${TOKEN}`, code: 0 }],
  ["token only in fields the channel does not read", { message: "Internal Server Error", error: TOKEN, errors: { _errors: [{ message: TOKEN }] }, code: 0 }],
];

const REST_CASES: Array<[string, RestCase]> = [
  ["401 without an echo", { status: 401, kind: "unauthorized", attempts: 1, reply: json(401, { message: "401: Unauthorized", code: 0 }) }],
  ...ECHO_BODIES.map(([n, body]): [string, RestCase] => [`401, ${n}`, { status: 401, kind: "unauthorized", attempts: 1, reply: json(401, body) }]),
  ...ECHO_BODIES.map(([n, body]): [string, RestCase] => [`500, ${n}`, { status: 500, kind: "http", attempts: 1, reply: json(500, body) }]),
  ...ECHO_BODIES.map(([n, body]): [string, RestCase] => [`503 until retries run out, ${n}`, { status: 503, kind: "http", attempts: 4, reply: json(503, body) }]),
  ["429 until retries run out, token in message", { status: 429, kind: "rate-limited", attempts: 4, reply: json(429, { message: `You are being rate limited ${TOKEN}`, retry_after: 0.2, global: false }) }],
  [
    "429 until retries run out, token in every field and header",
    {
      status: 429,
      kind: "rate-limited",
      attempts: 4,
      reply: json(429, { message: `Bot ${TOKEN}`, retry_after: TOKEN, global: true }, { "retry-after": TOKEN, "x-ratelimit-global": "true", "x-ratelimit-scope": TOKEN, "x-ratelimit-bucket": TOKEN }),
    },
  ],
  ["200 that is not JSON, token in the body", { status: 200, kind: "protocol", attempts: 1, reply: text(200, `<html>${TOKEN}</html>`) }],
  ["200 that is truncated JSON, token in the body", { status: 200, kind: "protocol", attempts: 1, reply: text(200, `{"id":"1","username":"${TOKEN}`) }],
  ["502 with an HTML body, token in the body", { status: 502, kind: "http", attempts: 4, reply: text(502, `<html><body>Bad gateway ${TOKEN}</body></html>`) }],
  ["500 with truncated JSON, token in the body", { status: 500, kind: "http", attempts: 1, reply: text(500, `{"message":"boom ${TOKEN}`) }],
  ["401 with a non-JSON body, token in the body", { status: 401, kind: "unauthorized", attempts: 1, reply: text(401, `Unauthorized ${TOKEN}`) }],
];

function assertApiError(s: Settled<unknown>, c: RestCase, what: string): void {
  assert.ok(!s.ok, `${what} rejects`);
  assert.ok(s.err instanceof DiscordApiError, `${what}: ${String(s.err)}`);
  assert.equal(s.err.kind, c.kind, what);
  assert.equal(s.err.status, c.status, what);
}

for (const [name, c] of REST_CASES) {
  test(`rest: ${name}: start(), send() and health() show no marker`, async () => {
    await withRig(async (r) => {
      // start(): the identity call fails.
      r.net.script("GET /api/v10/users/@me", ...Array<Responder>(c.attempts).fill(c.reply));
      assertApiError(await r.attempt("start", r.ch.start(r.host)), c, "start()");
      assert.equal(r.net.unconsumed(), 0, "every scripted reply was served");
      assert.equal(r.net.authSeen, c.attempts, "each attempt carried the token in the Authorization header, where it belongs");
      assert.equal((await r.health()).ok, false);
      // send(): after a clean start, the message POST fails. The text itself carries the marker (it is the user's content, so Discord
      // gets it) and must not come back in the error either.
      await r.started();
      r.net.script("POST /api/v10/channels/", ...Array<Responder>(c.attempts).fill(c.reply));
      assertApiError(await r.attempt("send", r.ch.send({ chatId: GUILD_CHANNEL, text: `please do not leak ${TOKEN}` })), c, "send()");
      assert.equal(r.net.unconsumed(), 0);
      // The channel still works afterwards and still reports healthy.
      assert.ok((await r.attempt("send", r.ch.send({ chatId: GUILD_CHANNEL, text: "after" }))).ok);
      assert.deepEqual(await r.health(), { ok: true, detail: "connected" });
    });
  });
}

test("rest: transient 503 and 429 with echoing bodies are retried, and the retry logs and results show no marker", async () => {
  await withRig(async (r) => {
    const echo503 = json(503, { message: `unavailable ${TOKEN}` });
    const echo429 = json(429, { message: `slow down ${TOKEN}`, retry_after: 0.2 }, { "retry-after": TOKEN });
    r.net.script("GET /api/v10/users/@me", echo429, echo503);
    r.net.script("PUT /api/v10/applications/", echo503, echo429);
    await r.started();
    r.net.script("POST /api/v10/channels/", echo503, echo429);
    assert.ok((await r.attempt("send", r.ch.send({ chatId: GUILD_CHANNEL, text: "retried" }))).ok);
    assert.equal(r.net.unconsumed(), 0);
    assert.equal(r.cap.errors.length, 0, "nothing was raised");
    assert.deepEqual(await r.health(), { ok: true, detail: "connected" });
  });
});

// ---- network failures ---------------------------------------------------------------------------------------------------

const NETWORK_FAILURES: Array<[string, () => unknown, DiscordErrorKind]> = [
  ["Error whose message and cause chain carry the token", () => new TypeError(`fetch failed: connect ECONNREFUSED ${TOKEN}`, { cause: new Error(`Bot ${TOKEN}`, { cause: TOKEN }) }), "network"],
  ["a rejection with the bare token string", () => TOKEN, "network"],
  ["a rejection with a plain object", () => ({ message: TOKEN, cause: { token: TOKEN } }), "network"],
  ["a TimeoutError whose message carries the token", () => new DOMException(`The operation timed out ${TOKEN}`, "TimeoutError"), "timeout"],
];

for (const [name, make, kind] of NETWORK_FAILURES) {
  test(`network: fetch rejects with ${name}: start(), send() and health() show no marker`, async () => {
    await withRig(async (r) => {
      r.net.script("GET /api/v10/users/@me", ...Array<Responder>(4).fill(fail(make)));
      const s = await r.attempt("start", r.ch.start(r.host));
      assert.ok(!s.ok && s.err instanceof DiscordApiError && s.err.kind === kind, String(!s.ok && s.err));
      assert.equal(r.net.unconsumed(), 0, "all four attempts hit the failing transport");
      assert.equal((await r.health()).ok, false);
      await r.started();
      r.net.script("POST /api/v10/channels/", ...Array<Responder>(4).fill(fail(make)));
      const sent = await r.attempt("send", r.ch.send({ chatId: GUILD_CHANNEL, text: "x" }));
      assert.ok(!sent.ok && sent.err instanceof DiscordApiError && sent.err.kind === kind, String(!sent.ok && sent.err));
      assert.equal(r.net.unconsumed(), 0);
      assert.deepEqual(await r.health(), { ok: true, detail: "connected" }, "a failed send does not take the gateway down");
    });
  });
}

test("network: the WebSocket factory throws with the token in message and cause; start() waits out READY, health says reconnecting", async () => {
  await withRig(
    async (r) => {
      await r.started(); // resolves after the 30 s (virtual) READY wait, as documented in channel.ts
      assert.deepEqual(await r.health(), { ok: false, detail: "reconnecting" });
      assert.equal(r.e.gateway.sockets.length, 0, "no socket was ever opened");
      assert.ok(r.cap.ctorLog.some((l) => l.event === "channel.discord.ready-timeout"));
      assert.ok(r.cap.ctorLog.some((l) => l.event === "channel.discord.gateway-reconnect"), "the reconnect line was logged and scanned");
      assert.ok(r.cap.urls.some((u) => u.startsWith("wss://")), "the dialled gateway URL was recorded and scanned");
    },
    {
      deps: ({ cap }) => ({
        webSocket: (url) => {
          cap.urls.push(url);
          throw new Error(`socket factory failed for ${TOKEN}`, { cause: new Error(`Bot ${TOKEN}`) });
        },
      }),
    },
  );
});

test("network: socket errors and a close reason carrying the token are ignored, the reconnect resumes, nothing leaks", async () => {
  await withRig(async (r) => {
    await r.started();
    const s = r.e.gateway.latest;
    s.onerror?.(new Error(`socket error ${TOKEN}`, { cause: new Error(TOKEN) }));
    closeWithReason(s, 1006, `connection lost for ${TOKEN}`);
    await r.e.clock.flush();
    assert.deepEqual(await r.health(), { ok: false, detail: "reconnecting" });
    await r.e.clock.advance(5000);
    await settle(r.e.clock, () => r.e.gateway.sockets.length === 2 && r.e.gateway.frames.some((f) => f.socket === 1 && f.frame.op === 6));
    await r.e.clock.flush();
    assert.deepEqual(await r.health(), { ok: true, detail: "connected" });
    assert.equal(r.cap.errors.length, 0, "a lost connection is retried, not raised");
    assert.ok(r.cap.ctorLog.some((l) => l.event === "channel.discord.gateway-reconnect"));
  });
});

// ---- gateway auth failures ----------------------------------------------------------------------------------------------

for (const code of [4004, 4014]) {
  test(`gateway: fatal close ${code} after start, close reason carries the token: host.fail, logs and health show no marker`, async () => {
    await withRig(async (r) => {
      await r.started();
      closeWithReason(r.e.gateway.latest, code, `Authentication failed for ${TOKEN}`);
      await r.e.clock.flush();
      await r.e.clock.advance(120_000);
      assert.equal(r.e.gateway.sockets.length, 1, "no reconnect after a fatal close");
      const failures = r.cap.errors.filter((x) => x.where === "host.fail");
      assert.equal(failures.length, 1);
      assert.match((failures[0]!.err as Error).message, new RegExp(`close ${code}`));
      assert.deepEqual(await r.health(), { ok: false, detail: "authentication failed" });
      assert.ok(r.cap.hostLog.some((l) => l.event === "channel.discord.gateway-refused" && l.level === "error"), "the refusal was logged and scanned");
      // Whatever send() does once the gateway is gone for good (the channel stays started until the host stops it), it is scanned too.
      await r.attempt("send", r.ch.send({ chatId: GUILD_CHANNEL, text: "x" }));
    });
  });

  test(`gateway: fatal close ${code} in answer to IDENTIFY (during start), reason carries the token: start() rejects without the marker`, async () => {
    await withRig(async (r) => {
      r.e.gateway.onClientFrame = (s, f) => {
        if (f.op === 2) closeWithReason(s, code, `Authentication failed for ${TOKEN}`);
      };
      const s = await r.attempt("start", r.ch.start(r.host));
      assert.ok(!s.ok && s.err instanceof DiscordApiError && s.err.kind === "unauthorized", String(!s.ok && s.err));
      assert.equal(r.cap.errors.filter((x) => x.where === "host.fail").length, 1);
      assert.deepEqual(await r.health(), { ok: false, detail: "authentication failed" });
      assert.equal(r.e.gateway.sockets.length, 1);
    });
  });
}

// ---- secret store, state store, handlers ----------------------------------------------------------------------------------

test("secrets: reveal() throws with the token in message and cause: start() raises fixed text", async () => {
  await withRig(
    async (r) => {
      const s = await r.attempt("start", r.ch.start(r.host));
      assert.ok(!s.ok && s.err instanceof DiscordApiError && s.err.kind === "protocol" && s.err.message === "discord secret read failed", String(!s.ok && s.err));
      assert.equal(r.e.rest.calls.length, 0, "nothing was sent");
      assert.equal((await r.health()).ok, false);
    },
    {
      deps: () => ({
        secrets: {
          reveal: async () => {
            throw new Error(`keyring said ${TOKEN}`, { cause: new Error(TOKEN) });
          },
        },
      }),
    },
  );
});

for (const [name, wrap] of [
  ["trailing newline", (t: string) => `${t}\n`],
  ["leading space", (t: string) => ` ${t}`],
  ["Bot prefix", (t: string) => `Bot ${t}`],
  ["quoted", (t: string) => `"${t}"`],
] as const) {
  test(`secrets: a stored value that is the token plus ${name} is refused with fixed text that does not echo it`, async () => {
    await withRig(
      async (r) => {
        const s = await r.attempt("start", r.ch.start(r.host));
        assert.ok(!s.ok && s.err instanceof DiscordApiError && /unexpected format/.test(s.err.message), String(!s.ok && s.err));
        assert.equal(r.e.rest.calls.length, 0);
        assert.equal(r.net.authSeen, 0, "the malformed value was never sent anywhere");
      },
      { deps: () => ({ secrets: { reveal: async () => wrap(TOKEN) } }) },
    );
  });
}

test("state store: load() throws with the token in message and cause: start() raises a generic error without it", async () => {
  await withRig(
    async (r) => {
      const s = await r.attempt("start", r.ch.start(r.host));
      assert.ok(!s.ok && s.err instanceof Error && s.err.message === "discord start failed", String(!s.ok && s.err));
      assert.equal(r.net.authSeen > 0, true, "the identity call went out before the state store failed");
      assert.equal((await r.health()).ok, false);
    },
    {
      deps: () => ({
        stateStore: {
          load: async () => {
            throw new Error(`state unreadable ${TOKEN}`, { cause: new Error(TOKEN) });
          },
          save: async () => {},
          clear: async () => {},
        },
      }),
    },
  );
});

test("state store: save() rejects with the token: the failure is logged without it", async () => {
  await withRig(
    async (r) => {
      await r.started();
      await r.e.clock.flush();
      assert.ok(r.cap.ctorLog.some((l) => l.event === "channel.discord.state-save-failed" && l.level === "error"), "the save failure was logged and scanned");
      assert.deepEqual(await r.health(), { ok: true, detail: "connected" });
    },
    {
      deps: () => ({
        stateStore: {
          load: async () => undefined,
          save: async () => {
            throw new Error(`disk full ${TOKEN}`, { cause: new Error(TOKEN) });
          },
          clear: async () => {},
        },
      }),
    },
  );
});

test("handlers: an onMessage handler and host.receive that throw the token are logged without it", async () => {
  await withRig(async (r) => {
    r.ch.onMessage(() => {
      throw new Error(`handler failed ${TOKEN}`, { cause: new Error(TOKEN) });
    });
    r.host.receive = async () => {
      throw new Error(`receive failed ${TOKEN}`, { cause: new Error(TOKEN) });
    };
    await r.started();
    r.e.gateway.dispatch("MESSAGE_CREATE", dmMessage("hello"));
    await r.ch.idle();
    assert.ok(r.cap.hostLog.some((l) => l.event === "channel.discord.handler-failed"));
    assert.ok(r.cap.hostLog.some((l) => l.event === "channel.discord.host-failed"));
    assert.deepEqual(await r.health(), { ok: true, detail: "connected" });
  });
});

// ---- the marker planted in the configuration -----------------------------------------------------------------------------

// A common mistake: the token itself is pasted into `tokenSecret`, which holds the NAME of a secret. TOKEN is made of characters the
// name pattern allows, so the channel accepts it as a name.
test("config: the token pasted into tokenSecret, secret store has no such name: start() says 'not set' and never echoes the name", async () => {
  await withRig(
    async (r) => {
      const s = await r.attempt("start", r.ch.start(r.host));
      assert.ok(!s.ok && s.err instanceof DiscordApiError && s.err.message === "discord bot token secret is not set", String(!s.ok && s.err));
      assert.equal((await r.health()).ok, false);
    },
    { over: { tokenSecret: TOKEN }, deps: () => ({ secrets: { reveal: async () => null } }) },
  );
});

test("config: the token pasted into tokenSecret and stored under that name: the channel runs and shows the name nowhere", async () => {
  await withRig(
    async (r) => {
      await r.started();
      assert.ok((await r.attempt("send", r.ch.send({ chatId: GUILD_CHANNEL, text: "x" }))).ok);
      assert.deepEqual(await r.health(), { ok: true, detail: "connected" });
      assert.ok(r.cap.ctorLog.length > 0);
    },
    { over: { tokenSecret: TOKEN }, deps: () => ({ secrets: { reveal: async (name) => (name === TOKEN ? TOKEN : null) } }) },
  );
});

function constructError(over: Record<string, unknown>): unknown {
  try {
    new DiscordChannel({ ...BASE_CONFIG, ...over, secrets: { reveal: async () => null } } as never);
  } catch (err) {
    return err;
  }
  throw new Error("the constructor accepted the configuration");
}

const BAD_VALUES: Array<[string, Record<string, unknown>]> = [
  ["tokenSecret with a character a secret name may not have", { tokenSecret: `${TOKEN} ` }],
  ["tokenSecret that is too long", { tokenSecret: TOKEN.repeat(3) }],
  ["tokenSecret that is not a string", { tokenSecret: { token: TOKEN } }],
  ["applicationId", { applicationId: TOKEN }],
  ["allowlist", { allowlist: [TOKEN] }],
  ["dmAllowlist", { dmAllowlist: [TOKEN] }],
  ["userAllowlist", { userAllowlist: [TOKEN] }],
  ["replyPolicy", { replyPolicy: TOKEN }],
  ["locale", { locale: TOKEN }],
  ["maxMediaBytes", { maxMediaBytes: TOKEN }],
  ["intents as a string", { intents: TOKEN }],
];
for (const [name, over] of BAD_VALUES) {
  test(`config: the token as ${name} is refused by the constructor without echoing it`, () => {
    const cap = newCapture();
    cap.errors.push({ where: "constructor", err: constructError(over) });
    assert.ok(cap.errors[0]!.err instanceof RangeError);
    assert.deepEqual(audit(cap), []);
  });
}

// Validation messages never quote a rejected value (intents.ts, config.ts): a credential pasted into the configuration by mistake
// must not come back in an error message.
test(
  "config: the token as an intent name is refused without echoing it",
  () => {
    const cap = newCapture();
    cap.errors.push({ where: "constructor", err: constructError({ intents: [TOKEN] }) });
    assert.deepEqual(audit(cap), []);
  },
);

test(
  "config: the token as an unknown option name is refused without echoing it",
  () => {
    const cap = newCapture();
    cap.errors.push({ where: "constructor", err: constructError({ [TOKEN]: true }) });
    assert.deepEqual(audit(cap), []);
  },
);

// ---- caller input carrying the marker -------------------------------------------------------------------------------------

test("input: identifiers carrying the marker are refused with fixed text by send(), edit() and resolveOwnerTarget()", async () => {
  await withRig(async (r) => {
    await r.started();
    const refused = async (where: string, p: Promise<unknown>): Promise<void> => {
      const s = await r.attempt(where, p);
      assert.ok(!s.ok && s.err instanceof Error, `${where} rejects`);
    };
    await refused("send", r.ch.send({ chatId: TOKEN, text: "x" }));
    await refused("send", r.ch.send({ chatId: GUILD_CHANNEL, text: "x", replyTo: TOKEN }));
    await refused("send", r.ch.send({ chatId: snowflake(424242), text: `to nowhere ${TOKEN}` }));
    await refused("edit", r.ch.edit({ chatId: GUILD_CHANNEL, messageId: TOKEN }, "x"));
    await refused("resolveOwnerTarget", r.ch.resolveOwnerTarget({ userId: TOKEN }));
    assert.equal(r.e.rest.callsOf("POST", "/api/v10/channels/").length, 0, "nothing reached Discord");
  });
});
