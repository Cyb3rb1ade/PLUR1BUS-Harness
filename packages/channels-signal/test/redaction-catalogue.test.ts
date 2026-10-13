import assert from "node:assert/strict";
import { test } from "node:test";
import type { Duplex } from "node:stream";
import type { ChannelHost } from "../../core/src/channels/types.ts";
import {
  SignalChannel,
  SignalRpcError,
  UnsupportedError,
  defaultConnect,
  type ChannelHealth,
  type ChannelLogger,
  type SignalChannelOptions,
  type SignalEndpoint,
} from "../src/index.ts";
import { ACCOUNT, BOT_UUID, DM, DM_UUID, GROUP, STRANGER, push, rig, type Rig } from "./helpers/setup.ts";
import { textEnvelope } from "./helpers/fake-daemon.ts";
import { duplexPair, manualTimeout } from "./helpers/duplex-pair.ts";
import { ScriptedPeer } from "./helpers/scripted-peer.ts";

// Secret redaction catalogue for the Signal channel.
//
// What counts as a secret here. Signal has no bearer credential: signal-cli owns the account and its keys, the channel
// "stores no credentials" and its config is "secret-free" (docs/channels/signal.md, intro and section 4), and the
// `SecretReader` type in port.ts is not used anywhere in src/. So the secrets are identifiers and access paths:
//   1. The account phone number (`account`, E.164). Personal data, and the identity the bot speaks as. It legitimately
//      travels to the daemon (every `send`, `sendTyping`, `getAttachment`, `subscribeReceive` carries it, and the pairing
//      port gets it as `accountId`), but it must never reach a log line, an error message or a health detail.
//      channel.ts #log scrubs it as a "known" string; this file does not rely on that scrubber (redact.ts is the object
//      under test, not a helper) and checks the outputs themselves. Marker: the digits of the existing ACCOUNT fixture.
//      The digits are searched without the "+", which is stricter than redact.ts (its E164 pattern and its known-string
//      replacement both need the "+").
//   2. The other numbers and uuids on the wire: the contact (DM), a stranger (STRANGER), the account's and the contact's
//      ACI uuid (BOT_UUID, DM_UUID). redact.ts calls these personal data. Markers: the digits of the existing DM and
//      STRANGER fixtures, and the two existing uuid constants.
//   3. The daemon address: a unix socket path or a TCP host:port. docs/channels/signal.md says "Anyone who can connect to
//      the socket can send messages as the account", so the address is an access path, and the socket path also carries
//      the service user's directory. Markers: MARKER_SECRET_ONE as the whole socket path (a single-segment path, which is
//      deliberately outside the SOCKET_PATH pattern of redact.ts, so a leak could not be hidden by the scrubber), and
//      MARKER_SECRET_TWO as the host of a TCP endpoint.
//   4. Password or auth material in the configuration: SignalConfig has no such field, so there is nothing real to plant.
//      As defence in depth the channel is still given stray `password` and `authToken` keys carrying MARKER_SECRET_THREE
//      (a host that passes a wider config object by mistake), because SignalChannel keeps the whole options object.
//      This is a guard against a future dump of the options, not a secret the channel really has. The `/link` pairing
//      code is the one real auth value on the inbound side; link.test.ts already pins that it never reaches a log, an
//      error or a reply, so it is not repeated here.
//
// Outputs that are scanned, by plain substring search, for every marker:
//   - the host logger passed to start() (info, warn, error) and the constructor logger (all four levels, debug included)
//   - every error that comes out of start(), send() and health()-adjacent calls: message, name, stack, own properties and
//     the whole `cause` chain; the whole health() result including `detail`; the errors handed to host.fail
//   - every URL, path or host:port shaped substring of a log line (and, separately, the configured address itself)
//
// Every daemon-side failure echoes all markers in its message and its `data`, the way signal-cli echoes numbers and
// paths in exception text. Each scenario also checks that the planted text really arrived on the wire (the session taps
// every byte the daemon sends), that the expected typed failure or log event happened (so the scan is not reading an empty
// log), and that the endpoint marker really reached the connect seam.
//
// Time: nothing sleeps. The channel's sleep and timeout seams are injected; waits are event-loop turns with a
// failure-only deadline.

const secretTest = (name: string, fn: () => Promise<void> | void) => test(name, { timeout: 15_000 }, fn);

// ---- markers ------------------------------------------------------------------------------------------------------------

const SOCKET_MARKER = "MARKER_SECRET_ONE";
const HOST_MARKER = "MARKER_SECRET_TWO";
const STRAY_MARKER = "MARKER_SECRET_THREE";
const SOCKET_PATH = `/${SOCKET_MARKER}.sock`;
const TCP_HOST = `${HOST_MARKER}.example`;
const TCP_PORT = 47583;

interface Marker {
  name: string;
  value: string;
}
const MARKERS: readonly Marker[] = [
  { name: "account number", value: ACCOUNT.slice(1) },
  { name: "account uuid", value: BOT_UUID },
  { name: "contact number", value: DM.slice(1) },
  { name: "contact uuid", value: DM_UUID },
  { name: "stranger number", value: STRANGER.slice(1) },
  { name: "socket path", value: SOCKET_MARKER },
  { name: "tcp host", value: HOST_MARKER },
  { name: "stray config credential", value: STRAY_MARKER },
];
const MARKER_NAMES = MARKERS.map((m) => m.name);
/** Text that holds every marker in a form a daemon exception could echo. */
const ECHO = [ACCOUNT, BOT_UUID, DM, DM_UUID, STRANGER, SOCKET_PATH, TCP_HOST, STRAY_MARKER].join(" ");

/** Plain substring search: the names of the markers that occur in text. */
function leaksIn(text: string): string[] {
  return MARKERS.filter((m) => text.includes(m.value)).map((m) => m.name);
}

/** A daemon error object whose message and data both echo every marker. */
function echoError(prefix: string, data: Record<string, unknown> = {}): { code: number; message: string; data: Record<string, unknown> } {
  return {
    code: -32603,
    message: `${prefix} ${ECHO}`,
    data: { account: ACCOUNT, contact: DM, address: SOCKET_PATH, note: STRAY_MARKER, ...data },
  };
}

/** What Node reports for a refused or missing endpoint: path, address and a cause, all carrying markers. */
function nodeConnectError(): Error {
  return Object.assign(new Error(`connect ECONNREFUSED ${SOCKET_PATH} ${ECHO}`, { cause: new Error(`inner ${ECHO}`) }), {
    code: "ECONNREFUSED",
    errno: -111,
    syscall: "connect",
    address: SOCKET_PATH,
    port: TCP_PORT,
  });
}

// ---- scanner and capture ------------------------------------------------------------------------------------------------

/** Every string reachable from an error: message, name, stack, own properties (cause included), recursively. */
function describeError(err: unknown, depth = 0): string {
  if (depth > 6) return "";
  if (err instanceof Error) {
    const parts = [err.name, err.message, err.stack ?? ""];
    for (const key of Object.getOwnPropertyNames(err)) {
      if (key === "stack" || key === "message" || key === "name") continue;
      parts.push(key, describeError((err as unknown as Record<string, unknown>)[key], depth + 1));
    }
    return parts.join("\n");
  }
  if (err !== null && typeof err === "object") {
    try {
      return JSON.stringify(err) ?? "";
    } catch {
      return "";
    }
  }
  return String(err);
}

interface LogLine {
  level: string;
  event: string;
  fields: unknown;
}

/** Collects everything the channel emits on its own: both loggers, host.fail, and the errors and results of calls. */
function capture() {
  const hostLogs: LogLine[] = [];
  const ctorLogs: LogLine[] = [];
  const outputs: Array<{ where: string; text: string }> = [];
  const failures: unknown[] = [];
  const state: { receiveError: unknown } = { receiveError: undefined };
  const host: ChannelHost = {
    receive: async () => {
      if (state.receiveError !== undefined) throw state.receiveError;
    },
    fail: (e) => {
      failures.push(e);
      outputs.push({ where: "host.fail error", text: describeError(e) });
    },
    log: {
      info: (event, fields) => void hostLogs.push({ level: "info", event, fields }),
      warn: (event, fields) => void hostLogs.push({ level: "warn", event, fields }),
      error: (event, fields) => void hostLogs.push({ level: "error", event, fields }),
    },
  };
  const logger: ChannelLogger = {
    log: (level, event, fields) => void ctorLogs.push({ level, event, fields }),
  };
  return {
    host,
    logger,
    hostLogs,
    ctorLogs,
    outputs,
    failures,
    failReceiveWith(e: unknown) {
      state.receiveError = e;
    },
    /** Runs op, requires it to reject, records the error text for the sweep and returns the error. */
    async rejects(where: string, op: () => Promise<unknown>): Promise<unknown> {
      try {
        await op();
      } catch (e) {
        outputs.push({ where: `${where} error`, text: describeError(e) });
        return e;
      }
      return assert.fail(`${where} was expected to reject`);
    },
    /** Runs op, requires it to resolve, records the JSON of the value for the sweep and returns it. */
    async resolves<T>(where: string, op: () => Promise<T>): Promise<T> {
      const value = await op();
      outputs.push({ where: `${where} result`, text: JSON.stringify(value) ?? "" });
      return value;
    },
  };
}
type Capture = ReturnType<typeof capture>;

/** Every marker found in every captured output, with where it was found. Empty means clean. */
function leaks(cap: Capture): Array<{ where: string; marker: string }> {
  const found: Array<{ where: string; marker: string }> = [];
  const scan = (where: string, text: string) => {
    for (const marker of leaksIn(text)) found.push({ where, marker });
  };
  cap.hostLogs.forEach((l, i) => scan(`host.log #${i} ${l.level} ${l.event}`, JSON.stringify(l)));
  cap.ctorLogs.forEach((l, i) => scan(`constructor logger #${i} ${l.level} ${l.event}`, JSON.stringify(l)));
  for (const o of cap.outputs) scan(o.where, o.text);
  return found;
}

const hasEvent = (lines: readonly LogLine[], event: string) => lines.some((l) => l.event === event);
const eventsOf = (lines: readonly LogLine[]) => lines.map((l) => l.event);
const reasonsOf = (lines: readonly LogLine[], event: string) =>
  lines.filter((l) => l.event === event).map((l) => (l.fields as { reason?: unknown }).reason);

// ---- address shapes in log lines -----------------------------------------------------------------------------------------

const ADDRESS_SHAPES: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi, // URL
  /(?:^|[\s"'=:(])\/[\w.@-]+(?:\/[\w.@-]+)*/g, // unix path
  /[\w.-]+:\d{2,5}\b/g, // host:port
];
function addressesIn(text: string): string[] {
  return ADDRESS_SHAPES.flatMap((re) => text.match(re) ?? []);
}

// ---- time and waiting seams ---------------------------------------------------------------------------------------------

/** The first `passes` waits return at once; later ones park until the channel aborts them (stop), so a loop cannot spin. */
function makeSleeper(passes: number) {
  const sleeps: number[] = [];
  const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    sleeps.push(ms);
    if (sleeps.length <= passes || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  return { sleeps, sleep };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Yields to the event loop until pred() holds. The 5 s deadline is a failure-only guard; nothing sleeps on the way. */
async function until(pred: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!pred()) {
    if (performance.now() > deadline) throw new Error(`timeout: ${what}`);
    await flush();
  }
}

// ---- a daemon end the test drives line by line --------------------------------------------------------------------------

/**
 * One half of an in-memory duplex pair that answers like signal-cli, except that for chosen methods it writes the given raw
 * text (a non-JSON line, say) instead of the reply. ScriptedPeer cannot write raw lines, so this is the small sibling.
 */
class RawPeer {
  readonly client: Duplex;
  readonly requests: Array<{ id: number; method: string }> = [];
  readonly instead = new Map<string, string>();
  readonly #server: Duplex;
  #buf = "";
  constructor() {
    const [client, server] = duplexPair();
    this.client = client;
    this.#server = server;
    server.on("data", (chunk: Buffer) => this.#onData(chunk.toString("utf8")));
  }
  #onData(text: string): void {
    this.#buf += text;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (!line.trim()) continue;
      const req = JSON.parse(line) as { id: number; method: string };
      this.requests.push({ id: req.id, method: req.method });
      const raw = this.instead.get(req.method);
      if (raw !== undefined) {
        this.#server.write(raw);
        continue;
      }
      this.#server.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: this.#resultFor(req.method) }) + "\n");
    }
  }
  #resultFor(method: string): unknown {
    switch (method) {
      case "version":
        return { version: "0.13.0-fake" };
      case "listAccounts":
        return [{ number: ACCOUNT, uuid: BOT_UUID }];
      case "send":
        return { timestamp: 1_700_000_200_000 };
      default:
        return {};
    }
  }
}

/** A line that is not JSON and carries every marker. */
const GARBAGE_LINE = `this is not json ${ECHO}\n`;

// ---- session: a channel with every seam injected -------------------------------------------------------------------------

/** Opens the transport for connection attempt `attempt` (1 is the start). `daemon()` connects to the fake daemon. */
type Transport = (attempt: number, signal: AbortSignal, daemon: () => Promise<Duplex>) => Promise<Duplex>;
interface SessionOptions {
  endpoint?: "socket" | "tcp";
  passes?: number;
  transport?: Transport;
  over?: Partial<SignalChannelOptions>;
}

/** Stray credential keys a host might pass by mistake (see the header, point 4). The type does not know them on purpose. */
const STRAY_CONFIG = { password: STRAY_MARKER, authToken: STRAY_MARKER } as unknown as Partial<SignalChannelOptions>;

async function session(o: SessionOptions = {}) {
  const sleeper = makeSleeper(o.passes ?? Number.POSITIVE_INFINITY);
  const cap = capture();
  const seen: SignalEndpoint[] = [];
  const wire: string[] = [];
  let attempts = 0;
  let r!: Rig;
  const toDaemon = (signal: AbortSignal) => defaultConnect({ host: "127.0.0.1", port: r.daemon.port }, signal);
  const connect = async (endpoint: SignalEndpoint, signal: AbortSignal): Promise<Duplex> => {
    seen.push(endpoint);
    attempts += 1;
    const stream = o.transport ? await o.transport(attempts, signal, () => toDaemon(signal)) : await toDaemon(signal);
    // Tap every byte the daemon sends, so a test can show that the planted text really arrived.
    stream.on("data", (chunk: Buffer | string) => void wire.push(String(chunk)));
    return stream;
  };
  const tcp = o.endpoint === "tcp";
  const endpoint: SignalEndpoint = tcp ? { host: TCP_HOST, port: TCP_PORT } : { socketPath: SOCKET_PATH };
  r = await rig(
    {
      endpoint,
      ...(tcp ? { allowRemoteEndpoint: true } : {}),
      logger: cap.logger,
      sleep: sleeper.sleep,
      connect,
      ...STRAY_CONFIG,
      ...o.over,
    },
    false,
  );
  return {
    r,
    ch: r.ch,
    cap,
    sleeper,
    seen,
    wire: () => wire.join(""),
    attempts: () => attempts,
    start: () => r.ch.start(cap.host),
    dispose: () => r.close(),
  };
}
type Session = Awaited<ReturnType<typeof session>>;

async function withSession(o: SessionOptions, body: (s: Session) => Promise<void>): Promise<void> {
  const s = await session(o);
  try {
    await body(s);
  } finally {
    await s.dispose();
  }
}

/** The shared closing check of every scenario: the endpoint marker reached the channel, and no marker came out. */
function assertClean(s: Session, label: string): void {
  assert.ok(s.seen.length > 0, "the channel handed its endpoint to the connect seam");
  assert.ok(leaksIn(JSON.stringify(s.seen[0])).length > 0, "the endpoint marker was in the channel's configuration");
  assert.deepEqual(leaks(s.cap), [], `no secret marker may reach an output (${label})`);
}
/** The daemon really sent the echo text to the channel. */
function assertEchoed(s: Session): void {
  assert.ok(s.wire().includes(ECHO), "the daemon's reply carried every marker");
}

function expectRpcError(e: unknown, kind: string, message: string): void {
  assert.ok(e instanceof SignalRpcError, `a typed error, got ${String(e)}`);
  assert.equal(e.kind, kind);
  assert.equal(e.message, message);
  assert.equal(e.cause, undefined, "no cause is chained");
}
function expectFixedError(e: unknown, message: string): void {
  assert.ok(e instanceof Error && !(e instanceof SignalRpcError), `a plain error, got ${String(e)}`);
  assert.equal(e.message, message);
  assert.equal(e.cause, undefined, "no cause is chained");
}
const NOT_STARTED = "signal channel is not started";

// ---- controls: the scanner is not vacuous ---------------------------------------------------------------------------------

secretTest("control: the substring scanner finds every marker in text that holds it and nothing in text that does not", () => {
  for (const m of MARKERS) assert.deepEqual(leaksIn(`before ${m.value} after`), [m.name], `finds the ${m.name}`);
  assert.deepEqual(leaksIn(ACCOUNT), ["account number"], "the +E.164 form carries the digit marker");
  assert.deepEqual(leaksIn(DM), ["contact number"]);
  assert.deepEqual(leaksIn(`{"reason":"timeout","attempt":2,"waitMs":2000}`), []);
  assert.deepEqual(leaksIn("signal daemon is not reachable"), []);
  assert.deepEqual(leaksIn(ECHO), MARKER_NAMES, "the echo text plants every marker");
});

secretTest("control: a marker written into each sink the sweeps read is reported, and an untouched capture is clean", async () => {
  assert.deepEqual(leaks(capture()), []);
  const sinks: Array<[string, (c: Capture) => Promise<unknown> | void]> = [
    ["host.log info", (c) => c.host.log.info("x", { note: STRAY_MARKER })],
    ["host.log warn", (c) => c.host.log.warn("x", { note: STRAY_MARKER })],
    ["host.log error", (c) => c.host.log.error("x", { note: STRAY_MARKER })],
    ["constructor logger debug", (c) => c.logger.log("debug", "x", { note: STRAY_MARKER })],
    ["constructor logger info", (c) => c.logger.log("info", "x", { note: STRAY_MARKER })],
    ["error message", (c) => c.rejects("op", () => Promise.reject(new Error(`x ${STRAY_MARKER}`)))],
    ["error cause", (c) => c.rejects("op", () => Promise.reject(new Error("outer", { cause: new Error(STRAY_MARKER) })))],
    ["error property", (c) => c.rejects("op", () => Promise.reject(Object.assign(new Error("outer"), { address: STRAY_MARKER })))],
    ["health detail", (c) => c.resolves<ChannelHealth>("health()", async () => ({ ok: false, detail: STRAY_MARKER }))],
    ["host.fail", (c) => c.host.fail(new Error(STRAY_MARKER))],
  ];
  for (const [sink, plant] of sinks) {
    const c = capture();
    await plant(c);
    const found = leaks(c);
    assert.ok(found.length > 0, `a marker in ${sink} is found`);
    assert.ok(found.every((f) => f.marker === "stray config credential"), `${sink}: the right marker is named`);
  }
  // A benign capture with fixed fields stays clean.
  const c = capture();
  c.host.log.warn("channel.signal.rate-limited", { waitMs: 2000 });
  c.logger.log("debug", "channel.signal.dropped", { reason: "dm-not-allowed" });
  await c.rejects("op", () => Promise.reject(new SignalRpcError("timeout", "signal request timed out")));
  assert.deepEqual(leaks(c), []);
});

secretTest("control: the address extractor finds URLs, paths and host:port in a line and nothing in a plain log line", () => {
  assert.deepEqual(addressesIn(`{"note":"see https://example.test/a?b=1 now"}`).length > 0, true, "URL");
  assert.deepEqual(addressesIn(`{"note":"/var/run/signal.sock"}`).length > 0, true, "path");
  assert.deepEqual(addressesIn(`{"note":"127.0.0.1:7583"}`).length > 0, true, "host:port");
  assert.deepEqual(addressesIn(`{"note":"daemon.internal:7583"}`).length > 0, true, "named host:port");
  assert.deepEqual(addressesIn(`{"level":"warn","event":"channel.signal.rate-limited","fields":{"waitMs":2000,"attempt":1}}`), []);
  assert.deepEqual(addressesIn(`{"level":"error","event":"channel.signal.start-failed","fields":{"reason":"not-registered"}}`), []);
});

// ---- constructor ---------------------------------------------------------------------------------------------------------

secretTest("constructor: validation errors for hostile config values are fixed text and echo nothing", () => {
  const base = { account: ACCOUNT, endpoint: { socketPath: SOCKET_PATH }, allowlist: [], dmAllowlist: [] };
  const hostile: Array<[string, Partial<SignalChannelOptions>]> = [
    ["account with a trailing character", { account: `${ACCOUNT}x` }],
    ["account that is a marker", { account: `+${STRAY_MARKER}` }],
    ["relative socket path", { endpoint: { socketPath: `${SOCKET_MARKER}.sock` } }],
    ["socket path with a NUL", { endpoint: { socketPath: `${SOCKET_PATH}\u0000${ACCOUNT}` } }],
    ["remote host without the opt-in", { endpoint: { host: TCP_HOST, port: TCP_PORT } }],
    ["port out of range", { endpoint: { host: TCP_HOST, port: 0 } }],
    ["allowlist entry with a control character", { allowlist: [`${DM}\u0000${STRAY_MARKER}`] }],
    ["dm allowlist entry that is too long", { dmAllowlist: [`${ECHO} ${ECHO} ${ECHO}`] }],
    ["locale", { locale: STRAY_MARKER as never }],
    ["reply policy", { replyPolicy: STRAY_MARKER as never }],
  ];
  for (const [what, over] of hostile) {
    let thrown: unknown;
    try {
      new SignalChannel({ ...base, ...over });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof RangeError, `${what}: construction is refused`);
    assert.deepEqual(leaksIn(describeError(thrown)), [], `${what}: the error text holds no marker`);
    assert.equal(thrown.cause, undefined);
  }
});

// ---- start(): daemon says the account is not registered ------------------------------------------------------------------

secretTest("start: the built-in 'account not registered' reply (which names the number) is reported with fixed text", async () => {
  // fake-daemon.ts replies "NotRegisteredException: User +4915100000001 is not registered." once registered = false.
  await withSession({}, async (s) => {
    s.r.daemon.registered = false;
    const err = await s.cap.rejects("start()", () => s.start());
    expectFixedError(err, "signal account is not registered with the daemon");
    assert.ok(s.wire().includes(ACCOUNT), "the daemon's reply named the account");
    assert.deepEqual(await s.cap.resolves("health()", () => s.ch.health()), { ok: false });
    // channel.ts clears #host before it logs start-failed, so only the constructor logger sees this line.
    assert.deepEqual(reasonsOf(s.cap.ctorLogs, "channel.signal.start-failed"), ["not-registered"]);
    assertClean(s, "start, not registered");
  });
});

secretTest("start: a 'not registered' error that echoes every marker in message and data is reported with fixed text", async () => {
  await withSession({}, async (s) => {
    s.r.daemon.failNext("subscribeReceive", echoError("NotRegisteredException: the account is not registered."));
    const err = await s.cap.rejects("start()", () => s.start());
    expectFixedError(err, "signal account is not registered with the daemon");
    assertEchoed(s);
    assert.deepEqual(reasonsOf(s.cap.ctorLogs, "channel.signal.start-failed"), ["not-registered"]);
    assertClean(s, "start, echoing not-registered");
  });
});

secretTest("start: a generic daemon error on the version handshake that echoes every marker fails with fixed text", async () => {
  await withSession({}, async (s) => {
    s.r.daemon.failNext("version", echoError("Internal error while checking the version"));
    const err = await s.cap.rejects("start()", () => s.start());
    expectFixedError(err, "signal daemon start failed");
    assertEchoed(s);
    assert.deepEqual(reasonsOf(s.cap.ctorLogs, "channel.signal.start-failed"), ["rpc"]);
    assert.deepEqual(await s.cap.resolves("health()", () => s.ch.health()), { ok: false });
    assertClean(s, "start, echoing rpc error");
  });
});

secretTest("start: echoing errors on listAccounts and subscribeReceive are tolerated and log nothing but the fixed start line", async () => {
  await withSession({}, async (s) => {
    s.r.daemon.failNext("listAccounts", echoError("listAccounts failed"));
    s.r.daemon.failNext("subscribeReceive", echoError("subscribeReceive failed"));
    await s.start();
    assertEchoed(s);
    assert.deepEqual(eventsOf(s.cap.ctorLogs), ["channel.signal.started"]);
    assert.deepEqual(await s.cap.resolves("health()", () => s.ch.health()), { ok: true });
    assertClean(s, "start with tolerated echoing errors");
  });
});

secretTest("start: a transport error that names the socket path, address and an inner cause is replaced by fixed text", async () => {
  const injected = nodeConnectError();
  assert.deepEqual(leaksIn(describeError(injected)), MARKER_NAMES, "the injected transport error carries every marker");
  await withSession(
    {
      transport: (attempt) =>
        attempt === 1
          ? Promise.reject(injected)
          : Promise.reject(new SignalRpcError("not-connected", "signal daemon is not reachable")),
    },
    async (s) => {
      expectFixedError(await s.cap.rejects("start() #1", () => s.start()), "signal daemon start failed");
      expectFixedError(await s.cap.rejects("start() #2", () => s.start()), "signal daemon start failed");
      assert.equal(s.attempts(), 2);
      assert.deepEqual(reasonsOf(s.cap.ctorLogs, "channel.signal.start-failed"), ["unknown", "not-connected"]);
      assertClean(s, "start, transport errors");
    },
  );
});

secretTest("start: the same transport error on a TCP endpoint whose host is a marker is replaced by fixed text", async () => {
  await withSession({ endpoint: "tcp", transport: () => Promise.reject(nodeConnectError()) }, async (s) => {
    expectFixedError(await s.cap.rejects("start()", () => s.start()), "signal daemon start failed");
    assert.deepEqual(s.seen, [{ host: TCP_HOST, port: TCP_PORT }]);
    assertClean(s, "start, tcp endpoint");
  });
});

// ---- start(): non-JSON line, EOF and reset during the handshake ---------------------------------------------------------

secretTest("start: a non-JSON line in place of the handshake reply, then the deadline, fails with fixed text", async () => {
  const timers = manualTimeout();
  const peer = new RawPeer();
  peer.instead.set("version", GARBAGE_LINE);
  await withSession({ transport: () => Promise.resolve(peer.client), over: { timeout: timers.fn } }, async (s) => {
    const starting = s.cap.rejects("start()", () => s.start());
    await until(() => peer.requests.some((q) => q.method === "version"), "version request sent");
    await flush();
    await flush();
    timers.fireAll();
    expectFixedError(await starting, "signal daemon start failed");
    assert.ok(s.wire().includes(ECHO), "the garbage line carried every marker");
    assert.deepEqual(reasonsOf(s.cap.ctorLogs, "channel.signal.start-failed"), ["timeout"]);
    assertClean(s, "start, garbage line");
  });
});

for (const mode of ["eof", "reset"] as const) {
  secretTest(`start: a socket ${mode} while the handshake waits for its reply fails with fixed text`, async () => {
    const peer = new ScriptedPeer();
    peer.answering = false;
    await withSession({ transport: () => Promise.resolve(peer.client) }, async (s) => {
      const starting = s.cap.rejects("start()", () => s.start());
      await until(() => peer.unanswered.some((q) => q.method === "version"), "version request sent");
      if (mode === "eof") peer.close();
      else {
        const reset = new Error(`read ECONNRESET ${ECHO}`);
        assert.deepEqual(leaksIn(reset.message), MARKER_NAMES, "the injected reset error carries every marker");
        peer.client.destroy(reset);
      }
      expectFixedError(await starting, "signal daemon start failed");
      assert.deepEqual(reasonsOf(s.cap.ctorLogs, "channel.signal.start-failed"), ["disconnected"]);
      assertClean(s, `start, socket ${mode}`);
    });
  });
}

// ---- send() --------------------------------------------------------------------------------------------------------------

secretTest("send: an 'account not registered' reply after start fails that send with fixed text", async () => {
  await withSession({}, async (s) => {
    await s.start();
    s.r.daemon.failNext("send", echoError("NotRegisteredException: the account is not registered."));
    const err = await s.cap.rejects("send()", () => s.ch.send({ chatId: DM, text: "hello" }));
    expectRpcError(err, "not-registered", "signal account is not registered");
    assertEchoed(s);
    s.r.daemon.registered = false;
    expectRpcError(
      await s.cap.rejects("send() on an unregistered daemon", () => s.ch.send({ chatId: DM, text: "again" })),
      "not-registered",
      "signal account is not registered",
    );
    assert.equal(s.cap.failures.length, 0, "a send-time error never fails the channel");
    assertClean(s, "send, not registered");
  });
});

secretTest("send: a generic daemon error that echoes every marker in message and data fails with fixed text", async () => {
  await withSession({}, async (s) => {
    await s.start();
    s.r.daemon.failNext("send", echoError("Failed to send message"));
    const err = await s.cap.rejects("send()", () => s.ch.send({ chatId: DM, text: "hello" }));
    expectRpcError(err, "rpc", "signal request failed");
    assert.equal((err as SignalRpcError).code, -32603, "only the numeric code is carried");
    assertEchoed(s);
    assertClean(s, "send, echoing rpc error");
  });
});

secretTest("send: a failed typing indicator logs only the fixed debug line, on the constructor logger only", async () => {
  await withSession({}, async (s) => {
    await s.start();
    s.r.daemon.failNext("sendTyping", echoError("Failed to send typing"));
    await s.cap.resolves("typing()", () => s.ch.typing(DM));
    assertEchoed(s);
    assert.ok(s.cap.ctorLogs.some((l) => l.level === "debug" && l.event === "channel.signal.typing-failed"), "debug level reached the constructor logger");
    assert.ok(!hasEvent(s.cap.hostLogs, "channel.signal.typing-failed"), "debug lines are not forwarded to the host logger");
    assertClean(s, "typing failure");
  });
});

secretTest("send: a rate limit that echoes every marker is retried after the hint and logs only the wait", async () => {
  await withSession({}, async (s) => {
    await s.start();
    s.r.daemon.failNext("send", echoError("RATE_LIMIT: too many requests", { retryAfterSeconds: 2 }));
    await s.cap.resolves("send()", () => s.ch.send({ chatId: DM, text: "hello" }));
    assertEchoed(s);
    assert.ok(s.sleeper.sleeps.includes(2000), "the channel waited the daemon's hint");
    const line = s.cap.hostLogs.find((l) => l.event === "channel.signal.rate-limited");
    assert.deepEqual(line, { level: "warn", event: "channel.signal.rate-limited", fields: { waitMs: 2000 } });
    assert.ok(hasEvent(s.cap.ctorLogs, "channel.signal.rate-limited"));
    assertClean(s, "rate limit, retried");
  });
});

secretTest("send: a rate limit that keeps coming back ends with the fixed rate-limit error once the retries are spent", async () => {
  await withSession({}, async (s) => {
    await s.start();
    for (let i = 0; i < 4; i++) s.r.daemon.failNext("send", echoError("RATE_LIMIT: too many requests", { retryAfterSeconds: 1 }));
    const err = await s.cap.rejects("send()", () => s.ch.send({ chatId: DM, text: "hello" }));
    expectRpcError(err, "rate-limited", "signal rate limit");
    assert.equal((err as SignalRpcError).retryAfterMs, 1000);
    assertEchoed(s);
    assert.equal(s.cap.ctorLogs.filter((l) => l.event === "channel.signal.rate-limited").length, 3, "three retries, each logged");
    assert.equal(s.cap.failures.length, 0);
    assertClean(s, "rate limit, exhausted");
  });
});

secretTest("send: an untrusted-identity error that names the recipient fails with fixed text and no retry", async () => {
  await withSession({}, async (s) => {
    await s.start();
    s.r.daemon.failNext(
      "send",
      echoError(`UntrustedIdentityException: Untrusted identity key of ${DM} (${DM_UUID}) changed`, { number: DM, uuid: DM_UUID }),
    );
    const err = await s.cap.rejects("send()", () => s.ch.send({ chatId: DM, text: "hello" }));
    expectRpcError(err, "untrusted-identity", "signal identity key is not trusted for the recipient");
    assertEchoed(s);
    assert.equal(s.r.daemon.callsOf("send").length, 1, "an untrusted identity is not retried");
    assert.deepEqual(await s.cap.resolves("health()", () => s.ch.health()), { ok: true });
    assert.equal(s.cap.failures.length, 0);
    assertClean(s, "send, untrusted identity");
  });
});

for (const mode of ["eof", "reset"] as const) {
  secretTest(`send: a socket ${mode} while a send waits for its reply rejects with fixed text and the outage logs only fixed lines`, async () => {
    const peer = new ScriptedPeer();
    // passes: 0 parks the reconnect backoff, so the lost state can be inspected and nothing spins.
    await withSession(
      { passes: 0, transport: (n) => (n === 1 ? Promise.resolve(peer.client) : Promise.reject(nodeConnectError())) },
      async (s) => {
        await s.start();
        peer.answering = false;
        const sending = s.cap.rejects("send()", () => s.ch.send({ chatId: DM, text: "hello" }));
        await until(() => peer.unanswered.some((q) => q.method === "send"), "send request written");
        if (mode === "eof") peer.close();
        else {
          const reset = new Error(`read ECONNRESET ${ECHO}`);
          assert.deepEqual(leaksIn(reset.message), MARKER_NAMES, "the injected reset error carries every marker");
          peer.client.destroy(reset);
        }
        expectRpcError(await sending, "disconnected", "signal daemon connection closed");
        await until(() => s.sleeper.sleeps.length === 1, "reconnect backoff parked");
        assert.ok(hasEvent(s.cap.ctorLogs, "channel.signal.disconnected"));
        assert.deepEqual(await s.cap.resolves("health()", () => s.ch.health()), { ok: false });
        expectFixedError(await s.cap.rejects("send() while down", () => s.ch.send({ chatId: DM, text: "again" })), NOT_STARTED);
        assertClean(s, `send, socket ${mode}`);
      },
    );
  });
}

secretTest("send: a reply that never comes ends with the fixed timeout error", async () => {
  const timers = manualTimeout();
  const peer = new ScriptedPeer();
  await withSession({ transport: () => Promise.resolve(peer.client), over: { timeout: timers.fn } }, async (s) => {
    await s.start();
    peer.answering = false;
    const sending = s.cap.rejects("send()", () => s.ch.send({ chatId: DM, text: "hello" }));
    await until(() => peer.unanswered.some((q) => q.method === "send"), "send request written");
    timers.fireAll();
    expectRpcError(await sending, "timeout", "signal request timed out");
    assertClean(s, "send, timeout");
  });
});

secretTest("send: non-JSON, non-object and unmatched lines on a healthy socket are skipped without a trace", async () => {
  await withSession({}, async (s) => {
    await s.start();
    const unmatched = JSON.stringify({ jsonrpc: "2.0", id: 9999, result: ECHO });
    s.r.daemon.writeRaw(GARBAGE_LINE + `[${JSON.stringify(ECHO)}]\n${JSON.stringify(ECHO)}\n${unmatched}\n`);
    await push(s.r, textEnvelope({ message: "sentinel", ts: 1_700_000_000_801 }));
    assert.deepEqual(await s.cap.resolves("health()", () => s.ch.health()), { ok: true });
    await s.cap.resolves("send()", () => s.ch.send({ chatId: DM, text: "still works" }));
    assert.ok(s.wire().includes(ECHO), "the garbage really arrived");
    assert.deepEqual(eventsOf(s.cap.ctorLogs), ["channel.signal.started"], "the garbage logged nothing");
    assertClean(s, "garbage on a healthy socket");
  });
});

secretTest("send: a non-JSON line in place of the send reply, then the deadline, fails with the fixed timeout error", async () => {
  const timers = manualTimeout();
  const peer = new RawPeer();
  await withSession({ transport: () => Promise.resolve(peer.client), over: { timeout: timers.fn } }, async (s) => {
    await s.start();
    peer.instead.set("send", GARBAGE_LINE);
    const sending = s.cap.rejects("send()", () => s.ch.send({ chatId: DM, text: "hello" }));
    await until(() => peer.requests.some((q) => q.method === "send"), "send request written");
    await flush();
    await flush();
    timers.fireAll();
    expectRpcError(await sending, "timeout", "signal request timed out");
    assert.ok(s.wire().includes(ECHO), "the garbage line carried every marker");
    assertClean(s, "send, garbage reply");
  });
});

secretTest("send: refusals made by the channel itself name no number, path or id", async () => {
  await withSession({}, async (s) => {
    await s.start();
    const callsBefore = s.r.daemon.calls.length;
    expectFixedError(await s.cap.rejects("send() stranger", () => s.ch.send({ chatId: STRANGER, text: "x" })), "recipient is not on the signal allowlist");
    expectFixedError(await s.cap.rejects("send() marker id", () => s.ch.send({ chatId: SOCKET_MARKER, text: "x" })), "group is not on the signal allowlist");
    expectFixedError(await s.cap.rejects("send() long id", () => s.ch.send({ chatId: `${ECHO} ${ECHO}`, text: "x" })), "invalid signal conversation id");
    const buttons = await s.cap.rejects("sendTurn() buttons", () =>
      s.ch.sendTurn({ chatId: DM, text: "x", buttons: [[{ text: ECHO, data: ECHO }]] }),
    );
    assert.ok(buttons instanceof UnsupportedError);
    assert.equal(buttons.message, "signal does not support buttons");
    const edit = await s.cap.rejects("edit()", () => s.ch.edit({ chatId: DM, messageId: ECHO }, "x"));
    assert.ok(edit instanceof RangeError);
    assert.equal(edit.message, "invalid message reference");
    assert.equal(s.r.daemon.calls.length, callsBefore, "none of these reached the daemon");
    assertClean(s, "send, refusals");
  });
});

// ---- health() ------------------------------------------------------------------------------------------------------------

secretTest("health: a daemon error that echoes every marker gives the fixed detail and then recovers", async () => {
  await withSession({}, async (s) => {
    await s.start();
    s.r.daemon.failNext("version", echoError("Internal error while checking the version"));
    assert.deepEqual(await s.cap.resolves("health() #1", () => s.ch.health()), { ok: false, detail: "daemon version check failed" });
    assertEchoed(s);
    assert.deepEqual(await s.cap.resolves("health() #2", () => s.ch.health()), { ok: true });
    assertClean(s, "health, echoing rpc error");
  });
});

secretTest("health: a daemon that stays connected but stops answering gives the fixed detail", async () => {
  const timers = manualTimeout();
  const peer = new ScriptedPeer();
  await withSession({ transport: () => Promise.resolve(peer.client), over: { timeout: timers.fn } }, async (s) => {
    await s.start();
    peer.answering = false;
    const probe = s.cap.resolves("health()", () => s.ch.health());
    await until(() => peer.unanswered.some((q) => q.method === "version"), "health probe written");
    timers.fireAll();
    assert.deepEqual(await probe, { ok: false, detail: "daemon version check failed" });
    assertClean(s, "health, silent daemon");
  });
});

secretTest("health: a non-JSON line in place of the version reply gives the fixed detail", async () => {
  const timers = manualTimeout();
  const peer = new RawPeer();
  await withSession({ transport: () => Promise.resolve(peer.client), over: { timeout: timers.fn } }, async (s) => {
    await s.start();
    peer.instead.set("version", GARBAGE_LINE);
    const probe = s.cap.resolves("health()", () => s.ch.health());
    await until(() => peer.requests.filter((q) => q.method === "version").length === 2, "health probe written");
    await flush();
    await flush();
    timers.fireAll();
    assert.deepEqual(await probe, { ok: false, detail: "daemon version check failed" });
    assert.ok(s.wire().includes(ECHO), "the garbage line carried every marker");
    assertClean(s, "health, garbage reply");
  });
});

// ---- reconnect loop and host.fail ---------------------------------------------------------------------------------------

secretTest("reconnect: an 'account not registered' answer after a lost connection hands host.fail a fixed error", async () => {
  await withSession({}, async (s) => {
    await s.start();
    s.r.daemon.failNext("subscribeReceive", echoError("NotRegisteredException: the account is not registered."));
    s.r.daemon.registered = false;
    s.r.daemon.dropConnections();
    await until(() => s.cap.failures.length === 1, "host.fail");
    expectFixedError(s.cap.failures[0], "signal account is not registered with the daemon");
    assertEchoed(s);
    assert.deepEqual(await s.cap.resolves("health()", () => s.ch.health()), { ok: false });
    assert.deepEqual(reasonsOf(s.cap.hostLogs, "channel.signal.reconnect-failed"), ["not-registered"]);
    assertClean(s, "reconnect, not registered");
  });
});

secretTest("reconnect: transport and daemon errors that echo every marker are logged as fixed reasons only", async () => {
  await withSession(
    { transport: (n, _signal, daemon) => (n === 2 ? Promise.reject(nodeConnectError()) : daemon()) },
    async (s) => {
      await s.start();
      s.r.daemon.failNext("version", echoError("Internal error while checking the version"));
      s.r.daemon.dropConnections();
      await until(() => hasEvent(s.cap.ctorLogs, "channel.signal.reconnected"), "reconnected");
      assertEchoed(s);
      assert.deepEqual(s.sleeper.sleeps, [1000, 2000, 4000]);
      assert.deepEqual(reasonsOf(s.cap.ctorLogs, "channel.signal.reconnect-failed"), ["unknown", "rpc"]);
      assert.deepEqual(reasonsOf(s.cap.hostLogs, "channel.signal.reconnect-failed"), ["unknown", "rpc"]);
      assert.equal(s.cap.failures.length, 0);
      assert.deepEqual(await s.cap.resolves("health()", () => s.ch.health()), { ok: true });
      assertClean(s, "reconnect, transient errors");
    },
  );
});

// ---- inbound -------------------------------------------------------------------------------------------------------------

secretTest("inbound: handler, host and pairing failures that echo every marker are logged as fixed events", async () => {
  await withSession(
    { over: { pairing: { claim: () => { throw new Error(`claim failed ${ECHO}`); } } as never } },
    async (s) => {
      await s.start();
      s.ch.onMessage(() => {
        throw new Error(`handler failed ${ECHO}`);
      });
      s.cap.failReceiveWith(new Error(`host.receive failed ${ECHO}`));
      await push(s.r, textEnvelope({ message: "hello", ts: 1_700_000_000_811 }));
      await push(s.r, textEnvelope({ message: "/link CODE", ts: 1_700_000_000_812 }));
      assert.deepEqual(
        eventsOf(s.cap.hostLogs),
        ["channel.signal.started", "channel.signal.handler-failed", "channel.signal.host-failed"],
      );
      assert.equal(s.r.daemon.sent().at(-1)!.message, "Pairing failed. Request a new code in My identities.", "the pairing failure got the uniform reply");
      assertClean(s, "inbound, failing consumers");
    },
  );
});

secretTest("inbound: dropped messages from a stranger and from groups log only the fixed reason, at debug level", async () => {
  await withSession({}, async (s) => {
    await s.start();
    await push(s.r, textEnvelope({ number: STRANGER, message: `hello ${ECHO}`, ts: 1_700_000_000_821 }));
    await push(s.r, textEnvelope({ message: `hello ${ECHO}`, groupId: STRAY_MARKER, ts: 1_700_000_000_822 }));
    await push(s.r, textEnvelope({ message: `hello ${ECHO}`, groupId: GROUP, ts: 1_700_000_000_823 }));
    const dropped = s.cap.ctorLogs.filter((l) => l.event === "channel.signal.dropped");
    assert.deepEqual(
      dropped.map((l) => [l.level, (l.fields as { reason: string }).reason]),
      [["debug", "dm-not-allowed"], ["debug", "group-not-allowed"], ["debug", "group-policy"]],
    );
    assert.ok(!hasEvent(s.cap.hostLogs, "channel.signal.dropped"), "debug lines are not forwarded to the host logger");
    assertClean(s, "inbound, drops");
  });
});

secretTest("inbound: an attachment fetch that fails with an echoing daemon error logs only the chat kind", async () => {
  await withSession({}, async (s) => {
    await s.start();
    s.r.daemon.failNext("getAttachment", echoError("Attachment lookup failed"));
    await push(
      s.r,
      textEnvelope({ message: "see attached", ts: 1_700_000_000_831, attachments: [{ id: "att1", contentType: "image/png", size: 10 }] }),
    );
    assertEchoed(s);
    const line = s.cap.hostLogs.find((l) => l.event === "channel.signal.media-rejected");
    assert.deepEqual(line, { level: "warn", event: "channel.signal.media-rejected", fields: { chatKind: "direct" } });
    assertClean(s, "inbound, attachment failure");
  });
});

// ---- addresses in log lines ---------------------------------------------------------------------------------------------

for (const kind of ["socket", "tcp"] as const) {
  secretTest(`logs: across a start failure, a retry, a failing consumer, a drop and a reconnect no ${kind} address appears in any log line`, async () => {
    await withSession(
      { endpoint: kind, transport: (n, _signal, daemon) => (n === 3 ? Promise.reject(nodeConnectError()) : daemon()) },
      async (s) => {
        s.r.daemon.failNext("version", echoError("Internal error while checking the version"));
        await s.cap.rejects("start() #1", () => s.start());
        await s.start();
        s.r.daemon.failNext("send", echoError("RATE_LIMIT: too many requests", { retryAfterSeconds: 1 }));
        await s.cap.resolves("send()", () => s.ch.send({ chatId: DM, text: "hello" }));
        s.ch.onMessage(() => {
          throw new Error(`handler failed ${ECHO}`);
        });
        await push(s.r, textEnvelope({ message: "hello", ts: 1_700_000_000_841 }));
        await push(s.r, textEnvelope({ number: STRANGER, message: "hello", ts: 1_700_000_000_842 }));
        s.r.daemon.dropConnections();
        await until(() => hasEvent(s.cap.ctorLogs, "channel.signal.reconnected"), "reconnected");

        // The scenario really produced every kind of line it is meant to cover.
        for (const event of [
          "channel.signal.start-failed",
          "channel.signal.started",
          "channel.signal.rate-limited",
          "channel.signal.handler-failed",
          "channel.signal.dropped",
          "channel.signal.disconnected",
          "channel.signal.reconnect-failed",
          "channel.signal.reconnected",
        ])
          assert.ok(hasEvent(s.cap.ctorLogs, event), `${event} was logged`);
        assert.deepEqual(s.seen[0], kind === "tcp" ? { host: TCP_HOST, port: TCP_PORT } : { socketPath: SOCKET_PATH });

        const lines = [...s.cap.hostLogs, ...s.cap.ctorLogs].map((l) => JSON.stringify(l));
        assert.ok(lines.length >= 8);
        assert.deepEqual(lines.flatMap(addressesIn), [], "no URL, path or host:port shaped text in any log line");
        const address = kind === "tcp" ? [TCP_HOST, `${TCP_HOST}:${TCP_PORT}`, String(TCP_PORT)] : [SOCKET_PATH];
        for (const line of lines) for (const part of address) assert.ok(!line.includes(part), `the configured address is not in ${line}`);
        assertClean(s, `address sweep, ${kind}`);
      },
    );
  });
}
