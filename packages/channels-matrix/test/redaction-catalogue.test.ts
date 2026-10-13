import assert from "node:assert/strict";
import { test } from "node:test";
import { MatrixApiError, type MatrixErrorKind } from "../src/index.ts";
import { FAKE_TOKEN, ROOM } from "./helpers/fake-matrix.ts";
import {
  KINDS,
  NEEDLES,
  PROFILE,
  SEND,
  SYNC,
  TOKEN_INNER,
  WHOAMI,
  deepText,
  faultOn,
  leakReport,
  makeRedactionRig,
  planted,
  urlsIn,
  type Kind,
  type RedactionRig,
  type RigOptions,
  type SeenRequest,
} from "./helpers/redaction.ts";

// Secret redaction catalogue for the Matrix channel. The access token (FAKE_TOKEN, see helpers/redaction.ts for why that one) is
// planted into every failure a homeserver or the network can produce: an echoing 401, a socket error whose message and cause hold the
// request URL and the Authorization header, a 5xx whose body repeats the token, a non-JSON body, a 429, and valid JSON of the wrong
// shape. After each scenario the token must not appear, as a plain substring, in host.log at any level, the constructor logger at any
// level, anything passed to host.fail, err.message / err.cause / own properties of every error start() and send() reject with, the
// result of health(), or any URL that shows up in a log line. The scanner is plain substring search (helpers/redaction.ts) and does
// not use src/redact.ts, which is the object under test. No test waits on a wall clock: backoff goes through an injected sleep.

const NO_ERROR = Symbol("no error");

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (e) {
    return e;
  }
  return NO_ERROR;
}

async function withRig(opts: RigOptions, body: (rig: RedactionRig) => Promise<void>): Promise<void> {
  const rig = await makeRedactionRig(opts);
  try {
    await body(rig);
  } finally {
    await rig.dispose();
  }
}

function assertNoLeak(label: string, text: string): void {
  assert.deepEqual(leakReport(text), [], label);
}

/** The error is a MatrixApiError of `kind`, or (kind undefined) at least an Error: proves the scenario reached the intended failure. */
function assertRejectedWith(label: string, error: unknown, kind: MatrixErrorKind | undefined): asserts error is Error {
  assert.notEqual(error, NO_ERROR, `${label}: expected a rejection`);
  assert.ok(error instanceof Error, `${label}: rejected with a non-Error`);
  if (kind !== undefined) {
    assert.ok(error instanceof MatrixApiError, `${label}: expected a MatrixApiError, got ${error.name}`);
    assert.equal(error.kind, kind, `${label}: error kind`);
  }
}

interface Collected {
  errors?: unknown[];
  health?: unknown[];
  /** False when the scenario ends before the channel makes any request, so there is no transport to inspect. */
  transport?: boolean;
}

/** Every observable output of the channel after a scenario, scanned for the token. */
function assertNothingLeaked(rig: RedactionRig, label: string, collected: Collected = {}): void {
  assertNoLeak(`${label}: host.log output`, rig.hostLogText());
  assertNoLeak(`${label}: constructor logger output`, rig.loggerText());
  assertNoLeak(`${label}: host.fail errors`, rig.failureText());
  for (const [i, e] of (collected.errors ?? []).entries()) {
    assertNoLeak(`${label}: error ${i}, whole value (message, cause, own properties)`, deepText(e));
    if (e instanceof Error) {
      assertNoLeak(`${label}: error ${i} message`, e.message);
      assertNoLeak(`${label}: error ${i} cause`, deepText(e.cause));
    }
  }
  for (const [i, h] of (collected.health ?? []).entries()) {
    assertNoLeak(`${label}: health() result ${i}`, deepText(h));
    const detail = (h as { detail?: unknown }).detail;
    if (detail !== undefined) assertNoLeak(`${label}: health() detail ${i}`, deepText(detail));
  }
  // No URL in any log line may carry the token, whatever else it holds.
  for (const url of urlsIn(rig.allOutputText())) assertNoLeak(`${label}: URL in a log line (${url.split("?")[0]})`, url);
  if (collected.transport !== false) assertTokenOnlyInHeader(rig, label);
}

/** Control for every scenario: the token really was in play on the wire, in the Authorization header, and in no request URL. */
function assertTokenOnlyInHeader(rig: RedactionRig, label: string): void {
  assert.ok(rig.requests.length > 0, `${label}: the channel made no request`);
  for (const r of rig.requests) {
    assert.equal(r.authorization, `Bearer ${FAKE_TOKEN}`, `${label}: request ${r.n} ${r.method} carries the token in the Authorization header`);
    assertNoLeak(`${label}: URL of request ${r.n}`, r.url);
  }
}

const isSyncFailed = (l: { event: string }) => l.event === "channel.matrix.sync-failed";

// ------------------------------------------------------------------------------------------------- positive controls

test("control: the scanner finds the token in strings, fragments, URLs, header text and nested errors, and stays quiet on clean text", () => {
  assert.ok(TOKEN_INNER.length >= 32, "the inner run is long enough to be distinctive");
  assert.equal(new Set(NEEDLES.map(([, n]) => n)).size, NEEDLES.length, "three different needles");
  assert.ok(NEEDLES.every(([, n]) => n.length >= 12 && FAKE_TOKEN.includes(n)));

  assert.ok(leakReport(`value ${FAKE_TOKEN} end`).includes("contains the full token"));
  assert.ok(leakReport(`value ${TOKEN_INNER} end`).includes("contains the distinctive inner run of the token"));
  assert.ok(leakReport(`cut ${FAKE_TOKEN.slice(0, 12)} short`).includes("contains the leading fragment of the token"));

  const url = `http://127.0.0.1:1/_matrix/client/v3/sync?timeout=0&access_token=${FAKE_TOKEN}`;
  assert.deepEqual(urlsIn(`GET ${url} failed`), [url]);
  assert.ok(leakReport(`GET ${url} failed`).some((h) => h.startsWith("contains a URL that carries credentials")));
  assert.ok(leakReport("GET http://user:pw@127.0.0.1:1/x failed").some((h) => h.startsWith("contains a URL that carries credentials")));
  assert.ok(leakReport("GET http://127.0.0.1:1/x?access_token=abcdef failed").length > 0);

  assert.ok(leakReport("Authorization: Bearer abcdefgh1234").includes("contains Authorization header text (Bearer <value>)"));

  const nested = { a: [{ err: new Error("outer", { cause: new Error(`inner ${FAKE_TOKEN}`) }) }] };
  assert.ok(leakReport(deepText(nested)).includes("contains the full token"), "token in a nested cause");
  const hidden = new Error("plain");
  Object.defineProperty(hidden, "secret", { value: FAKE_TOKEN, enumerable: false });
  assert.ok(leakReport(deepText(hidden)).includes("contains the full token"), "token in a non-enumerable own property");

  for (const clean of [
    "",
    "matrix authentication failed",
    "whoami failed with HTTP 401",
    "sync network error (ECONNRESET)",
    "GET http://127.0.0.1:1/_matrix/client/v3/sync?timeout=0 failed",
    "Authorization: Bearer [redacted]",
    "access_token=[redacted]",
  ])
    assert.deepEqual(leakReport(clean), [], JSON.stringify(clean));
});

test("control: every captured surface records a planted token, so a clean scan is not a capture gap", async () => {
  await withRig({}, async (rig) => {
    assert.deepEqual(leakReport(rig.allOutputText()), [], "a fresh rig holds nothing");
    for (const level of ["info", "warn", "error"] as const) {
      rig.host.log[level]("planted", { value: FAKE_TOKEN });
      const last = rig.hostLogs.at(-1)!;
      assert.equal(last.level, level);
      assert.notDeepEqual(leakReport(deepText(last)), [], `host.log.${level} line is scanned`);
    }
    for (const level of ["debug", "info", "warn", "error"] as const) {
      rig.logger.log(level, "planted", { value: FAKE_TOKEN });
      const last = rig.loggerLines.at(-1)!;
      assert.equal(last.level, level);
      assert.notDeepEqual(leakReport(deepText(last)), [], `constructor logger ${level} line is scanned`);
    }
    rig.host.fail(new Error("outer", { cause: new Error(FAKE_TOKEN) }));
    assert.notDeepEqual(leakReport(rig.failureText()), [], "host.fail argument is scanned");
    assert.notDeepEqual(leakReport(rig.hostLogText()), []);
    assert.notDeepEqual(leakReport(rig.loggerText()), []);
    assert.notDeepEqual(leakReport(rig.allOutputText()), []);
  });
});

test("control: every planted fault really carries the token, the URL and the Authorization header", async () => {
  const sample: SeenRequest = {
    n: 0,
    method: "GET",
    url: "http://127.0.0.1:1/_matrix/client/v3/sync?timeout=0",
    authorization: `Bearer ${FAKE_TOKEN}`,
  };
  const status: Record<Exclude<Kind, "network">, number> = {
    auth: 401,
    "server-error": 500,
    "rate-limit": 429,
    "bad-gateway-html": 502,
    "not-json": 200,
    "wrong-shape": 200,
  };
  for (const kind of KINDS) {
    const f = planted(kind, sample);
    let text: string;
    if (f instanceof Error) {
      assert.equal(kind, "network");
      text = deepText(f);
      assert.ok(deepText(f.cause).includes(FAKE_TOKEN), "the cause holds the token too");
      assert.equal((f.cause as { code?: string }).code, "ECONNRESET", "the code is a plain Node code, never the token");
    } else {
      assert.equal(f.status, status[kind as Exclude<Kind, "network">], kind);
      const headerLines: string[] = [];
      f.headers.forEach((value, name) => void headerLines.push(`${name}: ${value}`));
      text = `${await f.clone().text()}\n${headerLines.join("\n")}`;
    }
    const hits = leakReport(text);
    assert.ok(hits.includes("contains the full token"), `${kind}: ${hits.join("; ")}`);
    assert.ok(hits.includes("contains Authorization header text (Bearer <value>)"), `${kind}: ${hits.join("; ")}`);
    assert.ok(hits.some((h) => h.startsWith("contains a URL that carries credentials")), `${kind}: ${hits.join("; ")}`);
  }
});

test("control: the token travels only in the Authorization header of real requests and never in a URL", async () => {
  await withRig({}, async (rig) => {
    await rig.startParked();
    await rig.channel.send({ chatId: ROOM, text: "control" });
    const seen = rig.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    assert.ok(seen.includes("GET /_matrix/client/v3/account/whoami"), seen.join(", "));
    assert.ok(seen.some((s) => s.startsWith("GET /_matrix/client/v3/profile/")));
    assert.ok(seen.includes("GET /_matrix/client/v3/sync"));
    assert.ok(seen.some((s) => s.startsWith("PUT /_matrix/client/v3/rooms/") && s.includes("/send/")));
    assertNothingLeaked(rig, "healthy run", { health: [await rig.channel.health()] });
  });
});

// ------------------------------------------------------------------------------------------------- start(): requests fail

// What start() rejects with for each kind when the request is the whoami call. A wrong-shape answer is a different account: a plain Error.
const START_REJECTS: Record<Kind, MatrixErrorKind | undefined> = {
  auth: "unauthorized",
  network: "network",
  "server-error": "http",
  "bad-gateway-html": "http",
  "not-json": "protocol",
  "rate-limit": "rate-limited",
  "wrong-shape": undefined,
};

for (const kind of KINDS) {
  test(`start: whoami fails (${kind}) and the token is nowhere in the error, the logs or health`, async () => {
    await withRig({ fault: faultOn(WHOAMI, kind) }, async (rig) => {
      const err = await failureOf(() => rig.channel.start(rig.host));
      assertRejectedWith("start()", err, START_REJECTS[kind]);
      if (kind === "wrong-shape") assert.equal(err.message, "matrix account does not match the configured userId");
      assert.equal(rig.requests.filter((r) => WHOAMI.test(r.url)).length, 1, "the planted failure was met exactly once");
      if (kind === "auth") assert.ok(rig.loggerLines.some((l) => l.level === "error" && l.event === "channel.matrix.auth-failed"));
      const health = await rig.channel.health();
      assert.equal(health.ok, false);
      assertNothingLeaked(rig, `whoami ${kind}`, { errors: [err], health: [health] });
    });
  });
}

for (const kind of KINDS) {
  test(`start: the initial sync fails (${kind}) and the token is nowhere in the error, the logs or health`, async () => {
    await withRig({ resumed: false, fault: faultOn(SYNC, kind) }, async (rig) => {
      const err = await failureOf(() => rig.channel.start(rig.host));
      assertRejectedWith("start()", err, START_REJECTS[kind]);
      assert.equal(rig.requests.filter((r) => SYNC.test(r.url)).length, 1, "the planted failure was met exactly once, with no retry");
      const health = await rig.channel.health();
      assert.equal(health.ok, false);
      assertNothingLeaked(rig, `initial sync ${kind}`, { errors: [err], health: [health] });
    });
  });
}

for (const kind of KINDS) {
  // The display-name lookup is best effort: only a revoked token ends start(); every other failure is swallowed without a trace.
  test(`start: the display-name lookup fails (${kind}) and the token is nowhere in what start() does or logs`, async () => {
    await withRig({ fault: faultOn(PROFILE, kind) }, async (rig) => {
      if (kind === "auth") {
        const err = await failureOf(() => rig.channel.start(rig.host));
        assertRejectedWith("start()", err, "unauthorized");
        assertNothingLeaked(rig, "profile auth", { errors: [err], health: [await rig.channel.health()] });
        return;
      }
      await rig.startParked();
      assert.equal(rig.requests.filter((r) => PROFILE.test(r.url)).length, 1, "the planted failure was met");
      assert.equal(rig.failures.length, 0);
      const health = await rig.channel.health();
      assert.equal(health.ok, true);
      assertNothingLeaked(rig, `profile ${kind}`, { health: [health] });
    });
  });
}

// ------------------------------------------------------------------------------------------- start(): before any request

test("start: a secret reader that fails with the token in its error exposes nothing through start()", async () => {
  const leaky = Object.assign(new Error(`keyring lookup failed for ${FAKE_TOKEN}`), { cause: new Error(`cause ${FAKE_TOKEN}`) });
  assert.notDeepEqual(leakReport(deepText(leaky)), [], "control: the planted reader error holds the token");
  await withRig({ reveal: async () => Promise.reject(leaky) }, async (rig) => {
    const err = await failureOf(() => rig.channel.start(rig.host));
    assertRejectedWith("start()", err, undefined);
    assert.equal(err.message, "matrix secret read failed");
    assert.equal(rig.requests.length, 0, "nothing was requested");
    assertNothingLeaked(rig, "secret reader failure", { errors: [err], health: [await rig.channel.health()], transport: false });
  });
});

test("start: a token of the wrong shape is refused without echoing it", async () => {
  await withRig({ reveal: async () => `${FAKE_TOKEN} with a space` }, async (rig) => {
    const err = await failureOf(() => rig.channel.start(rig.host));
    assertRejectedWith("start()", err, undefined);
    assert.equal(err.message, "matrix access token secret has an unexpected format");
    assert.equal(rig.requests.length, 0, "nothing was requested");
    assertNothingLeaked(rig, "malformed token", { errors: [err], health: [await rig.channel.health()], transport: false });
  });
});

// ------------------------------------------------------------------------------------------------------ the sync loop

const LOOP_LOGS_KIND: Record<Exclude<Kind, "auth">, string> = {
  network: "network",
  "server-error": "http",
  "bad-gateway-html": "http",
  "not-json": "protocol",
  "rate-limit": "rate-limited",
  "wrong-shape": "protocol",
};

for (const kind of KINDS) {
  if (kind === "auth") {
    test("sync loop: a 401 that echoes the token ends the loop through host.fail and exposes nothing", async () => {
      await withRig({ fault: faultOn(SYNC, "auth") }, async (rig) => {
        // Not startParked(): the loop ends instead of parking on a poll.
        await rig.channel.start(rig.host);
        await rig.waitFor(() => rig.failures.length === 1, "host.fail");
        assert.ok(rig.failures[0] instanceof Error);
        assert.equal((rig.failures[0] as Error).message, "matrix authentication failed");
        assert.ok(rig.hostLogs.some((l) => l.level === "error" && l.msg === "channel.matrix.auth-failed"), "the host saw the auth failure at error level");
        const health = await rig.channel.health();
        assert.equal(health.ok, false);
        assertNothingLeaked(rig, "loop auth", { errors: [...rig.failures], health: [health] });
      });
    });
    continue;
  }
  test(`sync loop: /sync fails twice (${kind}), the loop backs off and recovers, and the token is nowhere`, async () => {
    await withRig({ fault: faultOn(SYNC, kind, { times: 2 }) }, async (rig) => {
      await rig.channel.start(rig.host);
      await rig.waitFor(() => rig.loggerLines.filter(isSyncFailed).length === 2, "two sync failures logged");
      await rig.fake.waitIdle();
      assert.deepEqual(
        rig.loggerLines.filter(isSyncFailed).map((l) => (l.attrs as { kind: string }).kind),
        [LOOP_LOGS_KIND[kind], LOOP_LOGS_KIND[kind]],
      );
      assert.ok(rig.hostLogs.some((l) => l.level === "warn" && l.msg === "channel.matrix.sync-failed"), "the host saw the failure at warn level");
      assert.equal(rig.sleeps.length, 2, "one injected backoff per failure");
      assert.equal(rig.failures.length, 0, "a transient failure is not fatal");
      const health = await rig.channel.health();
      assert.equal(health.ok, true);
      assertNothingLeaked(rig, `loop ${kind}`, { health: [health] });
    });
  });
}

// --------------------------------------------------------------------------------------------------------------- send()

// What send() rejects with, and how many PUT /send requests it takes: only network, 5xx, timeout and 429 are retried (3 retries).
const SEND_REJECTS: Record<Kind, { kind: MatrixErrorKind; attempts: number }> = {
  auth: { kind: "unauthorized", attempts: 1 },
  network: { kind: "network", attempts: 4 },
  "server-error": { kind: "http", attempts: 4 },
  "bad-gateway-html": { kind: "http", attempts: 4 },
  "not-json": { kind: "protocol", attempts: 1 },
  "rate-limit": { kind: "rate-limited", attempts: 4 },
  "wrong-shape": { kind: "protocol", attempts: 1 },
};

for (const kind of KINDS) {
  test(`send: the homeserver or network fails (${kind}) and the token is nowhere in the error, the retry logs or health`, async () => {
    await withRig({}, async (rig) => {
      await rig.startParked();
      rig.setFault(faultOn(SEND, kind, { method: "PUT" }));
      const err = await failureOf(() => rig.channel.send({ chatId: ROOM, text: "hello" }));
      const want = SEND_REJECTS[kind];
      assertRejectedWith("send()", err, want.kind);
      const attempts = rig.requests.filter((r) => r.method === "PUT" && SEND.test(r.url)).length;
      assert.equal(attempts, want.attempts, "number of PUT /send requests");
      assert.equal(rig.loggerLines.filter((l) => l.event === "channel.matrix.request-retry").length, want.attempts - 1, "one retry log line per retry");
      assert.equal(rig.fake.sent.length, 0, "nothing reached the homeserver");
      const health = await rig.channel.health();
      assert.equal(health.ok, true, "a failed send does not change liveness");
      assertNothingLeaked(rig, `send ${kind}`, { errors: [err], health: [health] });
    });
  });
}

// --------------------------------------------------------------------------- the homeserver fake's own 401 and 5xx answers

const WHOAMI_PATH = "/_matrix/client/v3/account/whoami";
const SYNC_PATH = "/_matrix/client/v3/sync";
const echoBody = { errcode: "M_UNKNOWN_TOKEN", error: `Unrecognised access token ${FAKE_TOKEN}` };

test("homeserver 401 on whoami (revoked token): start rejects as unauthorized and exposes nothing", async () => {
  await withRig({}, async (rig) => {
    rig.fake.revoked = true;
    const err = await failureOf(() => rig.channel.start(rig.host));
    assertRejectedWith("start()", err, "unauthorized");
    assert.equal(err.message, "whoami failed with HTTP 401");
    assert.ok(rig.loggerLines.some((l) => l.level === "error" && l.event === "channel.matrix.auth-failed"));
    assertNothingLeaked(rig, "revoked token", { errors: [err], health: [await rig.channel.health()] });
  });
});

test("homeserver 401 on whoami with an echoing body: start rejects and exposes nothing", async () => {
  await withRig({}, async (rig) => {
    rig.fake.failNext("GET", WHOAMI_PATH, 401, echoBody);
    const err = await failureOf(() => rig.channel.start(rig.host));
    assertRejectedWith("start()", err, "unauthorized");
    assert.equal(rig.fake.failures.length, 0, "the planted answer was served");
    assertNothingLeaked(rig, "whoami 401 echo", { errors: [err], health: [await rig.channel.health()] });
  });
});

test("homeserver 401 on the initial sync during a cold start: start rejects and exposes nothing", async () => {
  await withRig({ resumed: false }, async (rig) => {
    rig.fake.failNext("GET", SYNC_PATH, 401, echoBody);
    const err = await failureOf(() => rig.channel.start(rig.host));
    assertRejectedWith("start()", err, "unauthorized");
    assert.equal(rig.fake.failures.length, 0, "the planted answer was served");
    assertNothingLeaked(rig, "initial sync 401 echo", { errors: [err], health: [await rig.channel.health()] });
  });
});

test("homeserver 401 on /sync in the loop: host.fail gets a fixed error and nothing is exposed", async () => {
  await withRig({}, async (rig) => {
    rig.fake.failNext("GET", SYNC_PATH, 401, echoBody);
    await rig.channel.start(rig.host);
    await rig.waitFor(() => rig.failures.length === 1, "host.fail");
    assert.equal((rig.failures[0] as Error).message, "matrix authentication failed");
    assert.equal(rig.fake.failures.length, 0, "the planted answer was served");
    assertNothingLeaked(rig, "loop 401 echo", { errors: [...rig.failures], health: [await rig.channel.health()] });
  });
});

test("homeserver 5xx with an echoing body on whoami: start rejects and exposes nothing", async () => {
  await withRig({}, async (rig) => {
    rig.fake.failNext("GET", WHOAMI_PATH, 503, { errcode: "M_UNKNOWN", error: `upstream said ${FAKE_TOKEN}`, access_token: FAKE_TOKEN });
    const err = await failureOf(() => rig.channel.start(rig.host));
    assertRejectedWith("start()", err, "http");
    assert.equal((err as MatrixApiError).status, 503);
    assertNothingLeaked(rig, "whoami 503 echo", { errors: [err], health: [await rig.channel.health()] });
  });
});

test("send with a token revoked after start: the real 401 rejects send() as unauthorized and exposes nothing", async () => {
  await withRig({}, async (rig) => {
    await rig.startParked();
    rig.fake.revoked = true;
    const err = await failureOf(() => rig.channel.send({ chatId: ROOM, text: "after revocation" }));
    assertRejectedWith("send()", err, "unauthorized");
    assert.equal(err.message, "send failed with HTTP 401");
    assertNothingLeaked(rig, "send after revocation", { errors: [err], health: [await rig.channel.health()] });
  });
});

// --------------------------------------------------------------------------------------------------------------- health()

test("health: no result in any lifecycle state carries the token or a detail with it", async () => {
  const results: unknown[] = [];
  await withRig({}, async (rig) => {
    results.push(await rig.channel.health());
    await rig.startParked();
    results.push(await rig.channel.health());
    await rig.channel.send({ chatId: ROOM, text: "while healthy" });
    results.push(await rig.channel.health());
    await rig.channel.stop();
    results.push(await rig.channel.health());
    assert.deepEqual(
      results.map((r) => (r as { ok: boolean }).ok),
      [false, true, true, false],
    );
    assertNothingLeaked(rig, "health lifecycle", { health: results });
  });
  await withRig({ fault: faultOn(SYNC, "auth") }, async (rig) => {
    await rig.channel.start(rig.host);
    await rig.waitFor(() => rig.failures.length === 1, "host.fail");
    const failed = await rig.channel.health();
    assert.equal(failed.ok, false);
    assertNothingLeaked(rig, "health after a fatal 401", { health: [failed] });
  });
  for (const r of results) assert.ok(Object.keys(r as object).every((k) => k === "ok" || k === "detail"), "only the documented fields");
});
