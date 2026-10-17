import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { ChannelHealth, ChannelHost } from "../../core/src/channels/types.ts";
import type { SlackChannelOptions, SocketFactory } from "../src/index.ts";
import { FakeSlack, FAKE_APP_TOKEN, FAKE_BOT_TOKEN, FAKE_SOCKET_URL, message } from "./helpers/fake-slack.ts";
import {
  APP_DISTINCTIVE,
  APP_FRAGMENT,
  BOT_DISTINCTIVE,
  BOT_FRAGMENT,
  MARKERS,
  SOCKET_TICKET,
  errorText,
  findMarker,
  urlProblems,
  urlsIn,
  type Marker,
} from "./helpers/leak-scan.ts";
import { until, wire, type LogLine, type Wiring } from "./helpers/wire.ts";

// Step 3 (secret redaction) for channels-slack: the bot token and the app token are planted as the channel's secrets, then
// every error path is driven on purpose. After each one a plain substring scan (helpers/leak-scan.ts, independent of
// src/redact.ts) must find no marker in: the constructor logger (all levels), host.log (info/warn/error), host.fail, every
// error thrown by start() / send() / stop() (message, cause chain, own fields), health() including `detail`, and no URL
// that carries a query string or credentials in any log line. No real sleep: the injected sleep seam records and returns.

// What a hostile or broken peer could send back: both tokens and the ticket-bearing Socket Mode URL.
const POISON = [FAKE_BOT_TOKEN, FAKE_APP_TOKEN, FAKE_SOCKET_URL].join(" ");
const ECHO_BODY = { ok: false, error: POISON, detail: POISON, response_metadata: { messages: [POISON] } };
const HTML_BODY = `<html><body>${POISON}</body></html>`;
const NOT_JSON = `not json ${POISON}`;
const GROUP = "C0FAKE01";
const HUMAN = "UHUMAN01";

let fake: FakeSlack;
let current: Probe | undefined;
beforeEach(async () => {
  fake = new FakeSlack();
  await fake.listen();
});
afterEach(async () => {
  await current?.w.ch.stop();
  current = undefined;
  await fake.close();
});

// ------------------------------------------------------------------------------------------------ capture plumbing

interface Probe {
  /** `w.logs` holds host.log lines only (the constructor logger is replaced below), `w.failures` holds host.fail calls. */
  w: Wiring;
  /** Constructor logger lines, all levels including debug. */
  ctorLogs: LogLine[];
  /** Every error that came out of start(), send(), stop() or health(). */
  thrown: { where: string; error: unknown }[];
  healths: { where: string; value: unknown }[];
  /** Markers learned during a scenario (e.g. a one-time upload URL). */
  extra: Marker[];
}

function begin(extra: Partial<SlackChannelOptions> = {}): Probe {
  const ctorLogs: LogLine[] = [];
  const w = wire(fake, {
    logger: { log: (level, event, attrs) => void ctorLogs.push({ level, event, attrs: { ...attrs } }) },
    ...extra,
  });
  const p: Probe = { w, ctorLogs, thrown: [], healths: [], extra: [] };
  current = p;
  return p;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
async function attempt<T>(p: Probe, where: string, fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    p.thrown.push({ where, error });
    return { ok: false, error };
  }
}

async function health(p: Probe, where: string): Promise<ChannelHealth | undefined> {
  const r = await attempt(p, `health (${where})`, () => p.w.ch.health());
  if (!r.ok) return undefined;
  p.healths.push({ where, value: r.value });
  return r.value;
}

/** Findings as "<stream> <context>: <what was found>". Empty means clean. Never prints a log line, only the marker label. */
function leaks(p: Probe): string[] {
  const markers = [...MARKERS, ...p.extra];
  const found: string[] = [];
  const scan = (stream: string, text: string, context: string): void => {
    const label = findMarker(text, markers);
    if (label !== undefined) found.push(`${stream} ${context}: ${label}`);
  };
  const streams: [string, LogLine[]][] = [
    ["constructor logger", p.ctorLogs],
    ["host.log", p.w.logs],
  ];
  for (const [stream, lines] of streams) {
    for (const line of lines) {
      const text = JSON.stringify(line);
      scan(stream, text, `${line.level} ${line.event}`);
      for (const url of urlsIn(text)) for (const problem of urlProblems(url, markers)) found.push(`${stream} ${line.level} ${line.event}: a logged url ${problem}`);
    }
  }
  p.w.failures.forEach((err, i) => scan("host.fail", errorText(err), `#${i}`));
  for (const t of p.thrown) scan("thrown error", errorText(t.error), t.where);
  for (const h of p.healths) scan("health", JSON.stringify(h.value), h.where);
  return found;
}

/** Stop, read health once more, then require that no captured stream carries a marker. */
async function finish(p: Probe): Promise<void> {
  await attempt(p, "stop", () => p.w.ch.stop());
  await health(p, "after stop");
  assert.deepEqual(leaks(p), [], "a secret, a ticket or a credentialed url reached an output");
}

const count = (lines: readonly LogLine[], event: string): number => lines.filter((l) => l.event === event).length;
const connected = (p: Probe): number => count(p.ctorLogs, "channel.slack.connected");
const send = (p: Probe, text = "hello"): Promise<Outcome<void>> => attempt(p, "send", () => p.w.ch.send({ chatId: GROUP, text }));

async function startedProbe(extra: Partial<SlackChannelOptions> = {}): Promise<Probe> {
  const p = begin({ replyPolicy: "always", ...extra });
  const r = await attempt(p, "start", () => p.w.ch.start(p.w.host));
  assert.equal(r.ok, true, "start() must succeed for a scenario that begins after a healthy start");
  await until(() => connected(p) === 1, "first connection", 2000);
  return p;
}

// ------------------------------------------------------------------------------------------------ fault injection

interface Seen {
  urls: string[];
  raised: Error[];
}
/**
 * A fetch that behaves like the real one except for the next `times` requests whose URL contains `match`: those get `make()`,
 * either a thrown error or a Response. The channel captures `fetch` at construction, so this is passed in the options.
 */
function intercept(match: string, times: number, make: (url: string, init: RequestInit | undefined) => Error | Response): { fetch: typeof fetch; seen: Seen } {
  const seen: Seen = { urls: [], raised: [] };
  let left = times;
  const wrapped = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    seen.urls.push(url);
    if (left > 0 && url.includes(match)) {
      left -= 1;
      const out = make(url, init);
      if (out instanceof Response) return out;
      seen.raised.push(out);
      throw out;
    }
    return fetch(input, init);
  }) as typeof fetch;
  return { fetch: wrapped, seen };
}

/** A network failure whose message and cause both carry the request URL, the Authorization header and every secret. */
function networkPoison(url: string, init: RequestInit | undefined): Error {
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  return new Error(`fetch failed: POST ${url} authorization: ${auth} ${POISON}`, {
    cause: Object.assign(new Error(`socket hang up ${url} ${POISON}`), { code: "ECONNRESET" }),
  });
}

/** The poison itself must carry the markers, otherwise a clean result would prove nothing. */
function assertPlanted(errors: readonly Error[], atLeast = 1): void {
  assert.ok(errors.length >= atLeast, `the interceptor raised ${errors.length} poisoned errors, expected at least ${atLeast}`);
  for (const e of errors) {
    const text = errorText(e);
    for (const marker of [BOT_DISTINCTIVE, APP_DISTINCTIVE, SOCKET_TICKET]) assert.ok(text.includes(marker), "the injected network error must carry the secret it tests");
  }
}

// ------------------------------------------------------------------------------------------------ 1. scanner self-tests

test("scanner self-test: a planted marker is found and a clean string is not (rules out a vacuous pass)", () => {
  // The markers are derived from the existing fake tokens, never typed again.
  assert.ok(BOT_DISTINCTIVE.length >= 16 && APP_DISTINCTIVE.length >= 16, "markers are long enough to be distinctive");
  assert.ok(FAKE_BOT_TOKEN.endsWith(BOT_DISTINCTIVE) && FAKE_APP_TOKEN.endsWith(APP_DISTINCTIVE), "markers are parts of the planted tokens");
  assert.ok(BOT_DISTINCTIVE.startsWith(BOT_FRAGMENT) && APP_DISTINCTIVE.startsWith(APP_FRAGMENT));
  assert.notEqual(BOT_DISTINCTIVE, APP_DISTINCTIVE);
  assert.ok(FAKE_SOCKET_URL.includes(SOCKET_TICKET));

  for (const m of MARKERS) {
    assert.equal(findMarker(`x ${m.value} y`, [m]), m.label, m.label);
    assert.notEqual(findMarker(`x ${m.value} y`), undefined, m.label);
    assert.notEqual(findMarker(JSON.stringify({ a: { b: [m.value] } })), undefined, `${m.label} inside nested JSON`);
  }
  assert.equal(findMarker(`before ${BOT_DISTINCTIVE} after`), "bot token (distinctive part)");
  assert.equal(findMarker(`before ${APP_DISTINCTIVE} after`), "app token (distinctive part)");
  assert.equal(findMarker(FAKE_BOT_TOKEN), "bot token (distinctive part)");

  // Clean text, including the fixed messages the channel produces, is not flagged.
  for (const clean of ["", "slack authentication failed", "slack start failed", "chat.postMessage failed with HTTP 500", "wss://[redacted]", "Bearer [redacted]", "[redacted]"]) {
    assert.equal(findMarker(clean), undefined, clean);
  }

  // errorText exposes message, cause chain (error, object and string causes), own fields and aggregated errors.
  assert.notEqual(findMarker(errorText(new Error(`boom ${BOT_DISTINCTIVE}`))), undefined, "message");
  assert.notEqual(findMarker(errorText(new Error("outer", { cause: new Error(`inner ${APP_DISTINCTIVE}`) }))), undefined, "error cause");
  assert.notEqual(findMarker(errorText(new Error("outer", { cause: { detail: { url: FAKE_SOCKET_URL } } }))), undefined, "object cause");
  assert.notEqual(findMarker(errorText(new Error("outer", { cause: `text ${BOT_FRAGMENT}` }))), undefined, "string cause");
  assert.notEqual(findMarker(errorText(Object.assign(new Error("outer"), { code: APP_DISTINCTIVE }))), undefined, "own field");
  assert.notEqual(findMarker(errorText(new AggregateError([new Error(`one ${SOCKET_TICKET}`)], "many"))), undefined, "aggregated error");
  assert.equal(findMarker(errorText(new Error("slack authentication failed"))), undefined);
  assert.equal(findMarker(errorText(undefined)), undefined);
});

test("scanner self-test: urls are extracted, and a ticket query or credentials in a url are flagged", () => {
  const line = JSON.stringify({ level: "info", event: "x", attrs: { reason: FAKE_SOCKET_URL.slice(0, 40) } });
  const urls = urlsIn(line);
  assert.equal(urls.length, 1, "the truncated socket url inside a log line is found");
  assert.ok(urls[0]!.startsWith("wss://"));
  assert.notEqual(urlProblems(urls[0]!).length, 0, "a url with a query string is a problem even when the ticket itself is cut off");
  assert.notEqual(urlProblems(FAKE_SOCKET_URL).length, 0);
  assert.notEqual(urlProblems("wss://user:pw@host.example/link").length, 0, "credentials in the authority");
  assert.deepEqual(urlProblems("wss://[redacted]"), []);
  assert.deepEqual(urlProblems("https://slack.com/api"), []);
  assert.deepEqual(urlsIn("no url in here, only wss: and ://"), []);
});

test("scanner self-test: every captured stream is scanned, so a marker planted in any of them is reported", () => {
  const seeds: [string, (p: Probe) => void][] = [
    ["constructor logger", (p) => void p.ctorLogs.push({ level: "debug", event: "x", attrs: { a: BOT_DISTINCTIVE } })],
    ["host.log", (p) => void p.w.logs.push({ level: "warn", event: "x", attrs: { a: APP_DISTINCTIVE } })],
    ["host.fail", (p) => void p.w.failures.push(new Error("x", { cause: { detail: BOT_FRAGMENT } }))],
    ["thrown error", (p) => void p.thrown.push({ where: "send", error: Object.assign(new Error("x"), { code: APP_DISTINCTIVE }) })],
    ["health", (p) => void p.healths.push({ where: "w", value: { ok: false, detail: SOCKET_TICKET } })],
  ];
  for (const [stream, plant] of seeds) {
    const p = begin();
    assert.deepEqual(leaks(p), [], `${stream}: a fresh probe is clean`);
    plant(p);
    const found = leaks(p);
    assert.equal(found.length, 1, `${stream}: exactly one finding, got ${JSON.stringify(found)}`);
    assert.ok(found[0]!.startsWith(stream), `${stream}: reported against its own stream`);
  }
  const p = begin();
  p.ctorLogs.push({ level: "info", event: "x", attrs: { reason: FAKE_SOCKET_URL.slice(0, 40) } });
  assert.match(leaks(p).join("\n"), /a logged url carries a query string/);
  const q = begin();
  q.extra.push({ label: "one-time upload url", value: "http://one-time.example/u/1" });
  q.w.logs.push({ level: "info", event: "x", attrs: { a: "see http://one-time.example/u/1" } });
  assert.match(leaks(q).join("\n"), /one-time upload url/, "markers learned during a scenario are scanned too");
});

// ------------------------------------------------------------------------------------------------ 2. start(): auth.test

const startHttpCases: [string, number, unknown, Record<string, string>?][] = [
  ["auth.test answers ok:false invalid_auth (200)", 200, { ok: false, error: "invalid_auth" }],
  ["auth.test answers ok:false not_authed (200)", 200, { ok: false, error: "not_authed" }],
  ["auth.test answers 401 with a body echoing both tokens and the socket url", 401, ECHO_BODY],
  ["auth.test answers 403 with a body echoing both tokens and the socket url", 403, ECHO_BODY],
  ["auth.test answers 400 with the bot token as the error code", 400, { ok: false, error: FAKE_BOT_TOKEN }],
  ["auth.test answers 500 with a JSON body echoing both tokens and the socket url", 500, ECHO_BODY],
  ["auth.test answers 502 with an HTML page echoing both tokens and the socket url", 502, HTML_BODY],
  ["auth.test answers 200 with a body that is not valid JSON", 200, NOT_JSON],
  ["auth.test answers 429 with Retry-After and a body echoing the tokens", 429, ECHO_BODY, { "retry-after": "3" }],
];
for (const [name, status, body, headers] of startHttpCases) {
  test(`start() rejects without a leak: ${name}`, async () => {
    fake.failNext("auth.test", status, body, headers);
    const p = begin();
    const r = await attempt(p, "start", () => p.w.ch.start(p.w.host));
    assert.equal(r.ok, false, "start() must reject on this path");
    assert.equal(fake.callsOf("auth.test").length, 1, "the poisoned answer was delivered once and not retried");
    assert.equal(fake.callsOf("apps.connections.open").length, 0, "no socket ticket is requested after a failed identity check");
    assert.equal((await health(p, "after failed start"))?.ok, false);
    assert.deepEqual(p.w.sleeps, [], "no sleep on a start failure");
    await finish(p);
  });
}

test("start() rejects without a leak: a network failure whose message and cause carry the tokens, the url and the Authorization header", async () => {
  const net = intercept("/api/auth.test", 1, networkPoison);
  const p = begin({ fetch: net.fetch });
  const r = await attempt(p, "start", () => p.w.ch.start(p.w.host));
  assert.equal(r.ok, false);
  assertPlanted(net.seen.raised);
  assert.equal(fake.callsOf("auth.test").length, 0, "the request never reached the fake platform");
  assert.equal((await health(p, "after failed start"))?.ok, false);
  await finish(p);
});

test("start() rejects without a leak: the secret store throws an error carrying the secrets", async () => {
  const p = begin({ secrets: { reveal: async () => { throw new Error(`keychain refused ${POISON}`); } } });
  const r = await attempt(p, "start", () => p.w.ch.start(p.w.host));
  assert.equal(r.ok, false);
  assert.equal(fake.calls.length, 0);
  await finish(p);
});

// ------------------------------------------------------------------------------------------------ 3. start(): Socket Mode connect

const connectFatalCases: [string, number, unknown][] = [
  ["apps.connections.open answers ok:false invalid_auth (200)", 200, { ok: false, error: "invalid_auth" }],
  ["apps.connections.open answers ok:false not_authed (200)", 200, { ok: false, error: "not_authed" }],
  ["apps.connections.open answers 401 with a body echoing the tokens and the url", 401, ECHO_BODY],
];
for (const [name, status, body] of connectFatalCases) {
  test(`start() rejects without a leak: ${name}`, async () => {
    fake.failNext("apps.connections.open", status, body);
    const p = begin();
    const r = await attempt(p, "start", () => p.w.ch.start(p.w.host));
    assert.equal(r.ok, false, "a rejected app-level token is fatal for start()");
    assert.equal(fake.callsOf("apps.connections.open").length, 1, "no retry storm");
    assert.equal(fake.sockets.length, 0);
    // The host is detached again before a failed start logs, so only the constructor logger sees this line.
    assert.ok(count(p.ctorLogs, "channel.slack.auth-failed") >= 1, "the auth failure was logged to the constructor logger");
    assert.equal((await health(p, "after failed start"))?.ok, false);
    await finish(p);
  });
}

test("start() rejects without a leak: the socket factory throws an error carrying the ticket url and the tokens", async () => {
  const dialed: string[] = [];
  const webSocket: SocketFactory = (url) => {
    dialed.push(url);
    throw new Error(`cannot dial ${url} ${POISON}`, { cause: new Error(`tls failure for ${url} ${POISON}`) });
  };
  const p = begin({ webSocket });
  const r = await attempt(p, "start", () => p.w.ch.start(p.w.host));
  assert.equal(r.ok, false);
  assert.deepEqual(dialed, [FAKE_SOCKET_URL], "the ticket-bearing url really was handed to the factory");
  assert.equal((await health(p, "after failed start"))?.ok, false);
  await finish(p);
});

interface RecoverCase {
  name: string;
  prepare: () => { extra?: Partial<SlackChannelOptions>; verify?: (p: Probe) => void };
}
const connectRecoverCases: RecoverCase[] = [
  {
    name: "apps.connections.open answers 500 with a JSON body echoing the tokens and the url",
    prepare: () => (fake.failNext("apps.connections.open", 500, ECHO_BODY), {}),
  },
  {
    name: "apps.connections.open answers 502 with an HTML page echoing the tokens and the url",
    prepare: () => (fake.failNext("apps.connections.open", 502, HTML_BODY), {}),
  },
  {
    name: "apps.connections.open answers 403 with a body echoing the tokens and the url",
    prepare: () => (fake.failNext("apps.connections.open", 403, ECHO_BODY), {}),
  },
  {
    name: "apps.connections.open answers 200 with a body that is not valid JSON",
    prepare: () => (fake.failNext("apps.connections.open", 200, NOT_JSON), {}),
  },
  {
    name: "apps.connections.open answers 429 with Retry-After",
    prepare: () => (
      fake.failNext("apps.connections.open", 429, ECHO_BODY, { "retry-after": "7" }),
      { verify: (p) => assert.ok(p.w.sleeps.includes(7000), "the Retry-After hint went through the sleep seam, not a real wait") }
    ),
  },
  {
    name: "a network failure whose message and cause carry the tokens, the url and the Authorization header",
    prepare: () => {
      const net = intercept("/api/apps.connections.open", 1, networkPoison);
      return { extra: { fetch: net.fetch }, verify: () => assertPlanted(net.seen.raised) };
    },
  },
];
for (const c of connectRecoverCases) {
  test(`start() resolves, retries in the background and leaks nothing: ${c.name}`, async () => {
    const { extra, verify } = c.prepare();
    const p = begin(extra);
    const r = await attempt(p, "start", () => p.w.ch.start(p.w.host));
    assert.equal(r.ok, true, "a retryable connect failure does not reject start()");
    await health(p, "right after start, connect retry pending");
    await until(() => connected(p) === 1, "connection after the failed attempt", 2000);
    verify?.(p);
    assert.equal((await health(p, "recovered"))?.ok, true);
    await finish(p);
  });
}

// ------------------------------------------------------------------------------------------------ 4. Socket Mode during a session

test("a disconnect reason that echoes a token, a bearer header or the socket url is not logged verbatim", async () => {
  const p = await startedProbe();
  const reasons = [FAKE_BOT_TOKEN, FAKE_APP_TOKEN, FAKE_SOCKET_URL, `Bearer ${FAKE_BOT_TOKEN}`, `token=${FAKE_APP_TOKEN}`, `url: ${FAKE_SOCKET_URL}`];
  for (const [i, reason] of reasons.entries()) {
    fake.latest().serverSend({ type: "disconnect", reason });
    await until(() => connected(p) === i + 2, `reconnect after reason #${i}`, 2000);
  }
  assert.equal(count(p.ctorLogs, "channel.slack.disconnect-received"), reasons.length, "every tainted reason was logged once (this is the only place server text enters a log)");
  assert.equal(count(p.w.logs, "channel.slack.disconnect-received"), reasons.length, "and reached host.log too");
  assert.equal(fake.callsOf("apps.connections.open").length, reasons.length + 1);
  await finish(p);
});

const fatalDuringSession: [string, number, unknown][] = [
  ["token_revoked (200 ok:false)", 200, { ok: false, error: "token_revoked" }],
  ["not_authed (200 ok:false)", 200, { ok: false, error: "not_authed" }],
  ["401 with a body echoing the tokens and the url", 401, ECHO_BODY],
];
for (const [name, status, body] of fatalDuringSession) {
  test(`a refresh that finds the app token rejected reports one clean failure to the host: ${name}`, async () => {
    const p = await startedProbe();
    fake.failNext("apps.connections.open", status, body);
    fake.latest().serverSend({ type: "disconnect", reason: "refresh_requested" });
    await until(() => p.w.failures.length > 0, "host.fail", 2000);
    assert.equal(p.w.failures.length, 1, "reported exactly once");
    assert.ok(count(p.ctorLogs, "channel.slack.auth-failed") >= 1 && count(p.w.logs, "channel.slack.auth-failed") >= 1);
    assert.equal((await health(p, "after fatal"))?.ok, false);
    await finish(p);
  });
}

test("a link_disabled disconnect reports one clean failure to the host", async () => {
  const p = await startedProbe();
  fake.latest().serverSend({ type: "disconnect", reason: "link_disabled" });
  await until(() => p.w.failures.length > 0, "host.fail", 2000);
  assert.equal(p.w.failures.length, 1);
  assert.equal((await health(p, "after link_disabled"))?.ok, false);
  await finish(p);
});

// ------------------------------------------------------------------------------------------------ 5. send()

interface SendCase {
  name: string;
  /** Arms the fault and returns what it needs to be proven delivered. */
  arm: () => { extra?: Partial<SlackChannelOptions>; verify?: (p: Probe) => void };
  /** Whether send() is expected to reject once every retry is spent. */
  rejects: boolean;
}
// More poisoned answers than the retry budget, so a retryable fault ends in a rejection whatever that budget is.
const MANY = 8;
const armHttp = (method: string, status: number, body: unknown, times: number, headers?: Record<string, string>): void => {
  for (let i = 0; i < times; i++) fake.failNext(method, status, body, headers);
};
const sendCases: SendCase[] = [
  { name: "chat.postMessage answers ok:false invalid_auth", rejects: true, arm: () => (armHttp("chat.postMessage", 200, { ok: false, error: "invalid_auth" }, 1), {}) },
  { name: "chat.postMessage answers ok:false not_authed", rejects: true, arm: () => (armHttp("chat.postMessage", 200, { ok: false, error: "not_authed" }, 1), {}) },
  { name: "chat.postMessage answers 401 with a body echoing the tokens and the url", rejects: true, arm: () => (armHttp("chat.postMessage", 401, ECHO_BODY, 1), {}) },
  { name: "chat.postMessage answers 403 with a body echoing the tokens and the url", rejects: true, arm: () => (armHttp("chat.postMessage", 403, ECHO_BODY, 1), {}) },
  { name: "chat.postMessage answers 400 with the bot token as the error code", rejects: true, arm: () => (armHttp("chat.postMessage", 400, { ok: false, error: FAKE_BOT_TOKEN }, 1), {}) },
  {
    name: "chat.postMessage answers 500 with a JSON body echoing the tokens and the url, every time",
    rejects: true,
    arm: () => (armHttp("chat.postMessage", 500, ECHO_BODY, MANY), { verify: (p) => assert.ok(count(p.w.logs, "channel.slack.request-retry") >= 1, "the retry warning was logged") }),
  },
  { name: "chat.postMessage answers 502 with an HTML page echoing the tokens and the url, every time", rejects: true, arm: () => (armHttp("chat.postMessage", 502, HTML_BODY, MANY), {}) },
  { name: "chat.postMessage answers 200 with a body that is not valid JSON", rejects: true, arm: () => (armHttp("chat.postMessage", 200, NOT_JSON, 1), {}) },
  {
    name: "chat.postMessage answers 429 with Retry-After and an echoing body, every time",
    rejects: true,
    arm: () => (armHttp("chat.postMessage", 429, ECHO_BODY, MANY, { "retry-after": "2" }), { verify: (p) => assert.ok(p.w.sleeps.includes(2000), "Retry-After was honoured through the sleep seam") }),
  },
  {
    name: "chat.postMessage answers 429 with Retry-After once, then succeeds",
    rejects: false,
    arm: () => (armHttp("chat.postMessage", 429, ECHO_BODY, 1, { "retry-after": "2" }), { verify: (p) => assert.ok(p.w.sleeps.includes(2000)) }),
  },
  { name: "chat.postMessage answers 500 with an echoing body once, then succeeds", rejects: false, arm: () => (armHttp("chat.postMessage", 500, ECHO_BODY, 1), {}) },
  {
    name: "a network failure whose message and cause carry the tokens, the url and the Authorization header, every time",
    rejects: true,
    arm: () => {
      const net = intercept("/api/chat.postMessage", MANY, networkPoison);
      return { extra: { fetch: net.fetch }, verify: () => assertPlanted(net.seen.raised, 2) };
    },
  },
  {
    name: "a network failure once, then success",
    rejects: false,
    arm: () => {
      const net = intercept("/api/chat.postMessage", 1, networkPoison);
      return { extra: { fetch: net.fetch }, verify: () => assertPlanted(net.seen.raised) };
    },
  },
];
for (const c of sendCases) {
  test(`send() leaks nothing: ${c.name}`, async () => {
    const { extra, verify } = c.arm();
    const p = await startedProbe(extra);
    const r = await send(p);
    assert.equal(r.ok, !c.rejects, c.rejects ? "send() must reject on this path" : "send() must recover on this path");
    assert.ok(fake.callsOf("chat.postMessage").length >= 1 || verify !== undefined, "the poisoned path ran");
    verify?.(p);
    assert.equal((await health(p, "after send"))?.ok, true, "a failed send does not take the connection down");
    await finish(p);
  });
}

test("send() before start rejects without a leak", async () => {
  const p = begin();
  const r = await send(p);
  assert.equal(r.ok, false);
  assert.equal((await health(p, "never started"))?.ok, false);
  await finish(p);
});

test("send() leaks nothing when the chat id is hostile and carries the secrets", async () => {
  const p = await startedProbe();
  for (const chatId of [FAKE_BOT_TOKEN, `${GROUP}:${FAKE_APP_TOKEN}`, FAKE_SOCKET_URL]) {
    const r = await attempt(p, "send (hostile chat id)", () => p.w.ch.send({ chatId, text: "x" }));
    assert.equal(r.ok, false);
  }
  assert.equal(fake.callsOf("chat.postMessage").length, 0);
  await finish(p);
});

// ------------------------------------------------------------------------------------------------ 6. send(): file upload

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sendFile = (p: Probe): Promise<Outcome<unknown>> =>
  attempt(p, "sendTurn (upload)", () =>
    p.w.ch.sendTurn({ chatId: GROUP, text: "", attachments: [{ kind: "photo", data: PNG, mimeType: "image/png", filename: "a.png" }] }),
  );
const uploadCases: { name: string; make: () => { fetch: typeof fetch; seen: Seen }; verify?: (p: Probe) => void }[] = [
  { name: "a network failure on the one-time upload url, message and cause carry the url and the tokens", make: () => intercept("/upload/v1/", MANY, networkPoison) },
  {
    name: "the upload answers 500 with a body echoing the tokens",
    make: () => intercept("/upload/v1/", MANY, () => new Response(HTML_BODY, { status: 500 })),
  },
  {
    name: "the upload answers 429 with Retry-After",
    make: () => intercept("/upload/v1/", MANY, () => new Response(HTML_BODY, { status: 429, headers: { "retry-after": "4" } })),
    verify: (p) => assert.ok(p.w.sleeps.includes(4000), "Retry-After went through the sleep seam"),
  },
];
for (const c of uploadCases) {
  test(`sendTurn() with an attachment leaks nothing: ${c.name}`, async () => {
    const net = c.make();
    const p = await startedProbe({ fetch: net.fetch });
    // The one-time upload url is a credential of its own: learn it from the fake platform's slot and scan for it too.
    p.extra.push({ label: "one-time upload url", value: `${fake.root}/upload/v1/` });
    const r = await sendFile(p);
    assert.equal(r.ok, false, "the upload must fail on this path");
    assert.ok(net.seen.urls.some((u) => u.includes("/upload/v1/")), "the upload url was really requested");
    c.verify?.(p);
    assert.equal((await health(p, "after failed upload"))?.ok, true);
    await finish(p);
  });
}

test("sendTurn() with an attachment leaks nothing: files.completeUploadExternal answers 500 echoing the tokens", async () => {
  armHttp("files.completeUploadExternal", 500, ECHO_BODY, MANY);
  const p = await startedProbe();
  p.extra.push({ label: "one-time upload url", value: `${fake.root}/upload/v1/` });
  const r = await sendFile(p);
  assert.equal(r.ok, false);
  assert.ok(fake.callsOf("files.completeUploadExternal").length >= 1);
  await finish(p);
});

// ------------------------------------------------------------------------------------------------ 7. every log level in one session

test("a session that logs at every level: planted secrets reach the transport, no stream carries them", async () => {
  // Every acknowledgement write fails with an error carrying the secrets (a webSocket wrapper that misbehaves).
  const ackFailing: SocketFactory = (url) => {
    const s = fake.webSocket(url);
    return {
      addEventListener: (type, listener) => s.addEventListener(type, listener),
      close: () => s.close(),
      send: () => {
        throw new Error(`ack write failed on ${url} ${POISON}`);
      },
    };
  };
  const p = begin({ replyPolicy: "always", webSocket: ackFailing });
  p.w.ch.onMessage(() => {
    throw new Error(`handler failed with ${POISON}`);
  });
  const host: ChannelHost = {
    ...p.w.host,
    receive: async () => {
      throw new Error(`host failed with ${POISON}`);
    },
  };
  const started = await attempt(p, "start", () => p.w.ch.start(host));
  assert.equal(started.ok, true);
  await until(() => connected(p) === 1, "connection", 2000);

  // The planted secrets are what the channel really sends, so a clean result is not an artefact of the fake.
  assert.equal(fake.callsOf("auth.test")[0]!.auth, `Bearer ${FAKE_BOT_TOKEN}`);
  assert.equal(fake.callsOf("apps.connections.open")[0]!.auth, `Bearer ${FAKE_APP_TOKEN}`);

  // debug: an envelope without an id is ignored. error + warn: the message reaches a throwing handler and a throwing host,
  // and its acknowledgement cannot be written.
  fake.latest().serverSend({ type: "events_api" });
  fake.push(message({ channel: GROUP, user: HUMAN, text: "hello", ts: "1700000300.000001" }));
  await p.w.ch.idle();
  // warn: a rate limit with Retry-After, then success.
  armHttp("chat.postMessage", 429, ECHO_BODY, 1, { "retry-after": "2" });
  const sent = await send(p);
  assert.equal(sent.ok, true);
  assert.equal(fake.callsOf("chat.postMessage")[0]!.auth, `Bearer ${FAKE_BOT_TOKEN}`);
  assert.ok(p.w.sleeps.includes(2000));

  // Level coverage, so no level is scanned while empty.
  const levels = (lines: readonly LogLine[]): string[] => [...new Set(lines.map((l) => l.level))].sort();
  assert.deepEqual(levels(p.ctorLogs), ["debug", "error", "info", "warn"], "the constructor logger saw every level");
  assert.deepEqual(levels(p.w.logs), ["error", "info", "warn"], "host.log saw info, warn and error (debug never reaches the host)");
  for (const event of ["channel.slack.envelope-ignored", "channel.slack.ack-failed", "channel.slack.handler-failed", "channel.slack.host-failed", "channel.slack.request-retry"]) {
    assert.ok(count(p.ctorLogs, event) >= 1, `${event} was logged`);
  }
  await health(p, "mid session");
  await finish(p);
});

// ------------------------------------------------------------------------------------------------ 8. urls in log lines

test("no log line carries a url with a ticket, a query string or credentials, across connect, refresh, reconnect and stop", async () => {
  const p = await startedProbe();
  fake.latest().serverSend({ type: "disconnect", reason: "refresh_requested" });
  await until(() => connected(p) === 2, "refresh reconnect", 2000);
  fake.latest().serverSend({ type: "disconnect", reason: "warning" });
  await until(() => connected(p) === 3, "second refresh", 2000);
  fake.latest().serverDrop();
  await until(() => connected(p) === 4, "reconnect after a dropped connection", 2000);
  assert.equal(fake.callsOf("apps.connections.open").length, 4, "four ticket-bearing urls were issued during the session");
  const lines = [...p.ctorLogs, ...p.w.logs];
  assert.ok(lines.length >= 8, "there are log lines to scan");
  for (const line of lines) {
    const text = JSON.stringify(line);
    assert.ok(!text.includes(FAKE_SOCKET_URL), `${line.event} must not log the socket url`);
    assert.ok(!text.includes(SOCKET_TICKET), `${line.event} must not log the ticket`);
    for (const url of urlsIn(text)) assert.deepEqual(urlProblems(url), [], `${line.event}: url in a log line`);
  }
  await finish(p);
});

// ------------------------------------------------------------------------------------------------ 9. health()

test("health() never carries a secret or a ticket in `detail`, before start, while retrying, after a failure and after stop", async () => {
  const p = begin();
  await health(p, "before start");
  fake.failNext("apps.connections.open", 500, ECHO_BODY);
  await attempt(p, "start", () => p.w.ch.start(p.w.host));
  await health(p, "connect retry pending");
  await until(() => connected(p) === 1, "connection", 2000);
  await health(p, "connected");
  fake.failNext("apps.connections.open", 401, ECHO_BODY);
  fake.latest().serverSend({ type: "disconnect", reason: "refresh_requested" });
  await until(() => p.w.failures.length > 0, "host.fail", 2000);
  await health(p, "after fatal");
  assert.equal(p.healths.length, 4);
  for (const h of p.healths) {
    const value = h.value as ChannelHealth;
    assert.equal(typeof value.ok, "boolean", h.where);
    assert.ok(value.detail === undefined || typeof value.detail === "string", `${h.where}: detail is a string when present`);
    assert.equal(findMarker(String(value.detail ?? "")), undefined, `${h.where}: detail`);
  }
  await finish(p);
});

// ------------------------------------------------------------------------------------------------ 10. reconnect, factory failure

test(
  "a webSocket factory that throws while reconnecting keeps its error text out of the process",
  async () => {
    // At start a throwing factory is mapped to a fixed message (see section 3). After a successful start the same failure
    // happens inside the background reconnect loop, which has no handler of its own. Expected: the error text, which here
    // carries the ticket-bearing url and both tokens, never leaves the channel.
    let dials = 0;
    const webSocket: SocketFactory = (url) => {
      dials += 1;
      if (dials > 1) throw new Error(`cannot dial ${url} ${POISON}`, { cause: new Error(`tls failure for ${url} ${POISON}`) });
      return fake.webSocket(url);
    };
    const p = await startedProbe({ webSocket });
    // Collect what escapes as an unhandled rejection instead of letting the runner attribute it; the runner's own listeners
    // are put back in the finally block.
    const escaped: unknown[] = [];
    const saved = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", (reason) => void escaped.push(reason));
    try {
      fake.latest().serverSend({ type: "disconnect", reason: "closed_by_test" });
      await until(() => dials >= 2, "the reconnect attempt", 2000);
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
      await finish(p);
    } finally {
      process.removeAllListeners("unhandledRejection");
      for (const listener of saved) process.on("unhandledRejection", listener);
    }
    assert.equal(dials, 2, "the throwing factory was really reached on the reconnect");
    assert.deepEqual(
      escaped.map((reason) => findMarker(errorText(reason))).filter((label) => label !== undefined),
      [],
      "an unhandled rejection carries a secret or the ticket url",
    );
  },
);
