import assert from "node:assert/strict";
import { connect as netConnect, type Socket } from "node:net";
import { test } from "node:test";
import type { ChannelHealth, ChannelHost, InboundMessage } from "../../core/src/channels/types.ts";
import type { EmailChannel } from "../src/index.ts";
import type { SecretReader } from "../src/port.ts";
import type { ConnectFn } from "../src/wire.ts";
import { ALLOWED, BOT, fixtureMail, makeEmailFixture } from "./helpers/contract.ts";
import { imapServer, smtpServer, type Creds, type HostileConn, type HostileServer } from "./helpers/hostile-server.ts";
import { findLeaks, needlesFor } from "./helpers/redaction-scan.ts";

// Secret redaction catalogue for the Email channel (step 3 of the contract work).
//
// Two distinct invented passwords are planted: the IMAP password and the SMTP password (the config names a separate secret for
// each). Neither may appear, as a plain substring, in anything the channel hands to the outside:
//   - what it logs: the constructor logger (every level, incl. debug) and host.log (info, warn, error), with the fields argument;
//   - what it throws or reports: the rejection (message, cause, stack) of start(), send() and health(), and the error given to host.fail;
//   - health().detail;
//   - any URL or server greeting/response text inside the above.
// Every path is driven through a real socket: a refused IMAP LOGIN (NO), a refused SMTP AUTH (535), a socket reset, garbage where a
// protocol line belongs, a 451, and responses that echo the password back in their text. (There is no JSON protocol in an email
// channel, so "non-JSON response" is covered by binary garbage, an HTTP error page and a JSON-shaped document sent where IMAP or SMTP
// is expected.)
//
// How the scan is kept honest:
//   - The scanner (test/helpers/redaction-scan.ts) is plain `includes` over a recursive walk, not the package's redact.ts, which is
//     the object under test. A positive control proves it finds a marker in every kind of container, in an Error's message and
//     cause, in a base64 AUTH PLAIN blob and inside a URL, and a second control proves it covers every sink this file records.
//   - A control proves the markers are the credentials the channel really uses (the servers accept them; the wire carries them),
//     and every refusal scenario checks that the channel really presented its password before the server turned it down.
//   - Every hostile server says the marker and the word SRVTEXT in what it replies. The marker must not reach an output, and
//     neither may the server's own text: errors and log lines are fixed text.
//   - host.log is recorded WITH its fields argument (contract-catalogue.test.ts keeps only the event name).
//   - No real sleeping: backoff and send retries are parked behind the fixture's sleep seam and released with fx.release().

const MARKER_IMAP = "MARKER_SECRET_ONE";
const MARKER_SMTP = "MARKER_SECRET_TWO";
/** Added to everything a hostile server says. The channel relays no server text, so it must not show up either. */
const SRV = "SRVTEXT";

const NEEDLES = [...needlesFor(MARKER_IMAP, BOT), ...needlesFor(MARKER_SMTP, BOT)];
const SERVER_TEXT = [{ label: "server text", value: SRV }];

type Fixture = Awaited<ReturnType<typeof makeEmailFixture>>;

interface HostLine {
  level: string;
  event: string;
  fields: unknown;
}

interface Rig {
  readonly fx: Fixture;
  readonly ch: EmailChannel;
  readonly host: ChannelHost;
  readonly hostLogs: HostLine[];
  readonly failures: unknown[];
  readonly received: InboundMessage[];
  readonly errors: { label: string; error: unknown }[];
  readonly health: { label: string; result: ChannelHealth }[];
  readonly unhandled: unknown[];
  /** Everything the channel wrote to the IMAP and SMTP server, as text. */
  readonly wire: { imap: string[]; smtp: string[] };
  /** Redirects a configured server port to another one (a hostile server) for connections opened from now on. */
  readonly route: Map<number, number>;
  /** Secret names the channel asked the SecretReader for, in order. */
  readonly revealed: string[];
  serve(server: HostileServer): Promise<HostileServer>;
  /** Awaits p (driving parked sleeps). A rejection is recorded for the scan and returned. */
  attempt(label: string, p: Promise<unknown>): Promise<unknown>;
  healthOf(label: string): Promise<ChannelHealth>;
  /** Everything the channel gave to the outside world, in one tree for the scanner. */
  outputs(): unknown;
  close(): Promise<void>;
}

/**
 * Resolves once pred() holds, re-checked on every turn of the event loop. With `release` the fixture's parked sleeps (backoff,
 * retry, IDLE timer) are released on each turn. The 5 s guard only fires on failure.
 */
async function until(fx: Fixture, pred: () => boolean, what: string, release = false): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    if (release) fx.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Awaits p while releasing parked sleeps, so a send that retries after a 4xx or a network error runs to its end. */
async function settle<T>(fx: Fixture, p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => void (done = true),
    () => void (done = true),
  );
  await until(fx, () => done, "operation settled", true);
  return p;
}

function chunkText(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1");
}

/** A connect seam that records every byte the channel writes (per server role) and can redirect a port to another server. */
function tappedConnect(fx: Fixture, wire: { imap: string[]; smtp: string[] }, route: Map<number, number>): ConnectFn {
  return (host, port) =>
    new Promise<Socket>((resolve, reject) => {
      const role = port === fx.imap.port ? "imap" : "smtp";
      const s = netConnect({ host, port: route.get(port) ?? port });
      s.once("error", reject);
      s.once("connect", () => {
        s.removeAllListeners("error");
        s.on("error", () => {});
        const write = s.write.bind(s) as (...args: unknown[]) => boolean;
        s.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
          wire[role].push(chunkText(chunk));
          return write(chunk, ...rest);
        }) as typeof s.write;
        resolve(s);
      });
    });
}

/** True when the bytes the channel sent carry the secret: as text (IMAP LOGIN) or inside a base64 token (AUTH PLAIN / AUTH LOGIN). */
function wireCarries(chunks: readonly string[], secret: string): boolean {
  const text = chunks.join("");
  if (text.includes(secret)) return true;
  return text.split(/\s+/).some((token) => token.length >= 8 && Buffer.from(token, "base64").toString("utf8").includes(secret));
}

interface RigOptions {
  /** Replaces the SecretReader. Receives the two configured secret names. */
  secretsFor?: (names: { imap: string; smtp: string }) => SecretReader;
}

async function makeRig(opts: RigOptions = {}): Promise<Rig> {
  const fx = await makeEmailFixture();
  const names = { imap: fx.config.imap.passwordSecret, smtp: fx.config.smtp.passwordSecret };
  assert.notEqual(names.imap, names.smtp, "the fixture configures a separate SMTP secret");
  fx.imap.opts.password = MARKER_IMAP;
  fx.smtp.opts.password = MARKER_SMTP;
  const revealed: string[] = [];
  const secrets: SecretReader = opts.secretsFor
    ? opts.secretsFor(names)
    : {
        reveal: async (name) => {
          revealed.push(name);
          return name === names.imap ? MARKER_IMAP : name === names.smtp ? MARKER_SMTP : null;
        },
      };
  const wire = { imap: [] as string[], smtp: [] as string[] };
  const route = new Map<number, number>();
  const hostLogs: HostLine[] = [];
  const failures: unknown[] = [];
  const received: InboundMessage[] = [];
  const errors: { label: string; error: unknown }[] = [];
  const health: { label: string; result: ChannelHealth }[] = [];
  const unhandled: unknown[] = [];
  const servers: HostileServer[] = [];
  const onRejection = (reason: unknown): void => void unhandled.push(reason);
  process.on("unhandledRejection", onRejection);
  const record =
    (level: string) =>
    (event: string, fields?: Record<string, unknown>): void =>
      void hostLogs.push({ level, event, fields });
  const host: ChannelHost = {
    receive: async (m) => {
      received.push(m);
    },
    fail: (e) => void failures.push(e),
    log: { info: record("info"), warn: record("warn"), error: record("error") },
  };
  const ch = fx.make(false, { secrets, connect: tappedConnect(fx, wire, route) });
  const rig: Rig = {
    fx,
    ch,
    host,
    hostLogs,
    failures,
    received,
    errors,
    health,
    unhandled,
    wire,
    route,
    revealed,
    serve: async (server) => {
      await server.listen();
      servers.push(server);
      return server;
    },
    attempt: async (label, p) => {
      try {
        await settle(fx, p);
        return undefined;
      } catch (error) {
        errors.push({ label, error });
        return error;
      }
    },
    healthOf: async (label) => {
      const result = await settle(fx, ch.health());
      health.push({ label, result });
      return result;
    },
    outputs: () => ({ ctorLogs: fx.logs, hostLogs, hostFailures: failures, hostReceived: received, errors, health, unhandled }),
    close: async () => {
      process.off("unhandledRejection", onRejection);
      await ch.stop();
      for (const s of servers) await s.close();
      await fx.dispose();
    },
  };
  return rig;
}

/** Nothing the channel gave to the outside may contain either secret, and none of it may be the servers' own text. */
function assertNoLeak(rig: Rig, ctx: string): void {
  const out = rig.outputs();
  assert.deepEqual(findLeaks(out, NEEDLES), [], `${ctx}: a secret reached an output`);
  assert.deepEqual(findLeaks(out, SERVER_TEXT), [], `${ctx}: server text reached an output`);
}

const idleCount = (fx: Fixture): number => fx.imap.commands.filter((c) => c === "IDLE").length;
type LogLine = { event: string; level: string; [k: string]: unknown };
const reconnects = (rig: Rig): HostLine[] => rig.hostLogs.filter((l) => l.event === "channel.email.reconnect");
const fieldOf = (l: HostLine | undefined, key: string): unknown => (l?.fields as Record<string, unknown> | undefined)?.[key];

// ---------------------------------------------------------------------------------------------------------------------------
// Controls: the scanner and the recorders must be able to fail before a pass means anything.

test("control: the scanner finds a marker in every kind of container (a vacuous scan is ruled out)", () => {
  const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
  // A plain string.
  assert.deepEqual(findLeaks(`before ${MARKER_IMAP} after`, NEEDLES), [`$: ${MARKER_IMAP} (raw)`]);
  assert.deepEqual(findLeaks(MARKER_SMTP, NEEDLES), [`$: ${MARKER_SMTP} (raw)`]);
  // Nested objects and arrays, with the path in the answer.
  assert.deepEqual(findLeaks({ a: [{ b: `x ${MARKER_SMTP} y` }] }, NEEDLES), [`$.a[0].b: ${MARKER_SMTP} (raw)`]);
  // A URL inside a log line.
  const urlLine = { level: "info", event: "x", url: `imaps://${BOT}:${MARKER_IMAP}@mail.example.test/INBOX` };
  assert.deepEqual(findLeaks(urlLine, NEEDLES), [`$.url: ${MARKER_IMAP} (raw)`]);
  // Errors: JSON.stringify(new Error("...")) is "{}", so errors must be read field by field.
  assert.equal(JSON.stringify(new Error(MARKER_IMAP)), "{}");
  assert.ok(findLeaks(new Error(`failed for ${MARKER_IMAP}`), NEEDLES).some((h) => h.startsWith("$.message")));
  assert.deepEqual(
    findLeaks(new Error("outer", { cause: new Error(`inner ${MARKER_SMTP}`) }), NEEDLES).filter((h) => h.startsWith("$.cause.message")),
    [`$.cause.message: ${MARKER_SMTP} (raw)`],
  );
  assert.ok(findLeaks(new Error("x", { cause: MARKER_IMAP }), NEEDLES).some((h) => h.startsWith("$.cause:")));
  assert.deepEqual(findLeaks(Object.assign(new Error("fixed"), { detail: MARKER_IMAP }), NEEDLES), [`$.detail: ${MARKER_IMAP} (raw)`]);
  // Encoded forms: the AUTH PLAIN blob and the bare base64 password (AUTH LOGIN).
  const blob = b64(`\0${BOT}\0${MARKER_IMAP}`);
  assert.ok(findLeaks(`AUTH PLAIN ${blob}`, NEEDLES).includes(`$: ${MARKER_IMAP} (AUTH PLAIN blob)`));
  assert.deepEqual(findLeaks(b64(MARKER_SMTP), NEEDLES), [`$: ${MARKER_SMTP} (base64)`]);
  // Keys, byte buffers, maps, sets.
  assert.equal(findLeaks({ [MARKER_IMAP]: 1 }, NEEDLES).length, 1);
  assert.deepEqual(findLeaks(Buffer.from(`xx${MARKER_SMTP}xx`), NEEDLES), [`$: ${MARKER_SMTP} (raw)`]);
  assert.equal(findLeaks(new Map([["k", MARKER_IMAP]]), NEEDLES).length, 1);
  assert.equal(findLeaks(new Set([MARKER_SMTP]), NEEDLES).length, 1);
  // No false positives, and a cyclic structure ends.
  const clean: Record<string, unknown> = {
    a: "MARKER_SECRET_THREE",
    b: ["MARKER_SECRET_ON", BOT, "marker_secret_one"],
    c: new Error("fixed text"),
    d: 7,
  };
  clean.self = clean;
  assert.deepEqual(findLeaks(clean, NEEDLES), []);
  assert.deepEqual(findLeaks([], NEEDLES), []);
  // The server-text canary is found the same way.
  assert.deepEqual(findLeaks({ reason: `got ${SRV}` }, SERVER_TEXT), [`$.reason: server text`]);
});

test("control: the wire check sees a password inside AUTH PLAIN, AUTH LOGIN and IMAP LOGIN, and does not confuse the two secrets", () => {
  const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
  assert.equal(wireCarries([`A0004 AUTHENTICATE PLAIN\r\n`, `${b64(`\0${BOT}\0${MARKER_IMAP}`)}\r\n`], MARKER_IMAP), true);
  assert.equal(wireCarries([`AUTH PLAIN ${b64(`\0${BOT}\0${MARKER_SMTP}`)}\r\n`], MARKER_SMTP), true);
  assert.equal(wireCarries([`AUTH LOGIN\r\n`, `${b64(BOT)}\r\n`, `${b64(MARKER_SMTP)}\r\n`], MARKER_SMTP), true);
  assert.equal(wireCarries([`A0004 LOGIN "${BOT}" "${MARKER_IMAP}"\r\n`], MARKER_IMAP), true);
  assert.equal(wireCarries([`AUTH PLAIN ${b64(`\0${BOT}\0${MARKER_SMTP}`)}\r\n`], MARKER_IMAP), false);
  assert.equal(wireCarries([`EHLO example.test\r\n`, `A0001 CAPABILITY\r\n`], MARKER_IMAP), false);
});

test("control: the scanner covers every sink the rig records (a leak planted in any of them is found)", async () => {
  const rig = await makeRig();
  try {
    rig.fx.logs.push({ level: "warn", event: "planted", reason: MARKER_IMAP });
    rig.host.log.info("planted", { url: `smtps://${BOT}:${MARKER_SMTP}@mail.example.test` });
    rig.host.fail(new Error("planted", { cause: new Error(MARKER_IMAP) }));
    await rig.host.receive({ channel: "email", chatId: "planted", chatKind: "direct", senderId: ALLOWED, text: MARKER_SMTP });
    rig.errors.push({ label: "planted", error: new Error(`planted ${MARKER_SMTP}`) });
    rig.health.push({ label: "planted", result: { ok: true, detail: `imap:up ${MARKER_IMAP}` } });
    rig.unhandled.push(new Error(MARKER_SMTP));
    const hits = findLeaks(rig.outputs(), NEEDLES);
    for (const where of [
      "$.ctorLogs[0].reason",
      "$.hostLogs[0].fields.url",
      "$.hostFailures[0].cause.message",
      "$.hostReceived[0].text",
      "$.errors[0].error.message",
      "$.health[0].result.detail",
      "$.unhandled[0].message",
    ]) {
      assert.ok(
        hits.some((h) => h.startsWith(`${where}:`)),
        `${where} is scanned`,
      );
    }
    assert.notEqual(findLeaks(rig.outputs(), NEEDLES).length, 0);
    assert.notEqual(findLeaks({ planted: `x ${SRV}` }, SERVER_TEXT).length, 0);
  } finally {
    await rig.close();
  }
});

test("control: both markers are the credentials the channel really uses, and a clean run leaves nothing to find", async () => {
  const rig = await makeRig();
  const { fx } = rig;
  try {
    await rig.ch.start(rig.host);
    // The channel asked for exactly the two configured secrets, IMAP first, and the servers accepted what it sent.
    assert.deepEqual(rig.revealed, [fx.config.imap.passwordSecret, fx.config.smtp.passwordSecret]);
    assert.ok(fx.imap.authenticated >= 1, "the IMAP server accepted the marker as the password");
    assert.equal(wireCarries(rig.wire.imap, MARKER_IMAP), true);
    assert.equal(wireCarries(rig.wire.imap, MARKER_SMTP), false, "the SMTP secret is never sent to the IMAP server");
    const chatId = await rig.ch.resolveOwnerTarget({ userId: ALLOWED });
    assert.equal(await rig.attempt("send", rig.ch.send({ chatId, text: "hello" })), undefined);
    assert.equal(fx.smtp.received.length, 1);
    assert.ok(fx.smtp.authenticated >= 1, "the SMTP server accepted the other marker as the password");
    assert.equal(wireCarries(rig.wire.smtp, MARKER_SMTP), true);
    assert.equal(wireCarries(rig.wire.smtp, MARKER_IMAP), false, "the IMAP secret is never sent to the SMTP server");
    assert.deepEqual(await rig.healthOf("healthy"), { ok: true, detail: "imap:up smtp:ok" });
    await rig.ch.stop();
    assert.ok(rig.hostLogs.length > 0 && fx.logs.length > 0, "both loggers recorded something");
    assertNoLeak(rig, "clean run");
  } finally {
    await rig.close();
  }
});

test("control: the recorders see every level of the constructor logger and the host logger", async () => {
  const rig = await makeRig();
  try {
    await rig.ch.start(rig.host);
    // The second mail repeats a Message-ID: the channel logs that at debug level, which only the constructor logger receives.
    await rig.fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "one", messageId: "level-1@example.test" }));
    await rig.fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "again", messageId: "level-1@example.test" }));
    await rig.ch.stop();
    const ctorLevels = new Set((rig.fx.logs as LogLine[]).map((l) => l.level));
    assert.ok(ctorLevels.has("debug") && ctorLevels.has("info"), "the constructor logger recorded debug and info");
    assert.ok(rig.hostLogs.some((l) => l.level === "info" && l.event === "channel.email.started"), "host.log recorded info");
    assert.ok(rig.hostLogs.every((l) => l.fields !== undefined), "host.log lines are recorded together with their fields");
    // warn and error are recorded and scanned in the runtime scenarios below, where the channel logs reconnect and fatal.
    assertNoLeak(rig, "levels");
  } finally {
    await rig.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// IMAP at start(): the refusal, reset and garbage paths. A failed start() is the failure report (no host.fail), and the rejection
// is the only output besides the logs.

test("imap start: a refused AUTHENTICATE PLAIN (NO) rejects with fixed text", async () => {
  const rig = await makeRig();
  try {
    rig.fx.imap.opts.password = "rotated-elsewhere";
    const err = await rig.attempt("start", rig.ch.start(rig.host));
    assert.ok(err instanceof Error);
    assert.equal(err.message, "IMAP authentication failed");
    assert.equal(wireCarries(rig.wire.imap, MARKER_IMAP), true, "the channel did present the marker before it was refused");
    assert.equal(rig.fx.imap.authenticated, 0);
    assert.deepEqual(await rig.healthOf("after failed start"), { ok: false, detail: "stopped" });
    await rig.ch.stop();
    assertNoLeak(rig, "AUTHENTICATE NO");
  } finally {
    await rig.close();
  }
});

test("imap start: a refused LOGIN (NO) puts the password on the wire in the command and rejects with fixed text", async () => {
  const rig = await makeRig();
  try {
    rig.fx.imap.opts.authPlain = false; // no AUTH=PLAIN advertised: the client falls back to LOGIN "user" "password"
    rig.fx.imap.opts.password = "rotated-elsewhere";
    const err = await rig.attempt("start", rig.ch.start(rig.host));
    assert.ok(err instanceof Error);
    assert.equal(err.message, "IMAP authentication failed");
    assert.ok(rig.fx.imap.commands.includes("LOGIN"), "the LOGIN path was the one taken");
    assert.ok(rig.wire.imap.join("").includes(`LOGIN "${BOT}" "${MARKER_IMAP}"`), "the marker travelled in the LOGIN command");
    await rig.ch.stop();
    assertNoLeak(rig, "LOGIN NO");
  } finally {
    await rig.close();
  }
});

test("imap start: the connection is reset while selecting the mailbox", async () => {
  const rig = await makeRig();
  try {
    rig.fx.imap.dropOnSelect = 1;
    const err = await rig.attempt("start", rig.ch.start(rig.host));
    assert.ok(err instanceof Error);
    assert.equal(err.message, "connection closed");
    assert.equal(wireCarries(rig.wire.imap, MARKER_IMAP), true);
    assert.ok(rig.fx.imap.authenticated >= 1, "the login itself had succeeded");
    await rig.ch.stop();
    assertNoLeak(rig, "drop on SELECT");
  } finally {
    await rig.close();
  }
});

interface ImapStartCase {
  name: string;
  server: () => HostileServer;
  /** The one fixed message start() must reject with. */
  message: RegExp;
  /** The client got as far as presenting the password. */
  credentials: boolean;
  /** The server's own text carried the marker (false when it only reset or closed). */
  said: boolean;
}

const IMAP_GREETING = `* OK [CAPABILITY IMAP4rev1] ${SRV} hello ${MARKER_IMAP}\r\n`;
const imapAccepts = (_c: Creds, tag: string, conn: HostileConn): void => conn.send(`${tag} OK authenticated\r\n`);
const garbage = (marker: string): Uint8Array =>
  Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x1b]), Buffer.from(`${marker} ${SRV}`), Buffer.from("\r\n")]);
const httpPage = (marker: string): string => `HTTP/1.1 400 Bad Request ${SRV} ${marker}\r\n`;
const jsonDoc = (marker: string): string => `{"error":"bad request","detail":"${SRV} ${marker}"}\r\n`;

const IMAP_START_CASES: ImapStartCase[] = [
  {
    name: "a tagged NO to AUTHENTICATE PLAIN echoes the password",
    server: () =>
      imapServer({
        greeting: IMAP_GREETING,
        onCredentials: (c, tag, conn) => conn.send(`${tag} NO [AUTHENTICATIONFAILED] ${SRV} login for ${c.user} rejected, password ${c.password}\r\n`),
      }),
    message: /^IMAP authentication failed$/,
    credentials: true,
    said: true,
  },
  {
    name: "a tagged NO to LOGIN echoes the password",
    server: () =>
      imapServer({
        greeting: IMAP_GREETING,
        caps: "IMAP4rev1 STARTTLS",
        onCredentials: (c, tag, conn) => conn.send(`${tag} NO [AUTHENTICATIONFAILED] ${SRV} LOGIN ${c.user} ${c.password} refused\r\n`),
      }),
    message: /^IMAP authentication failed$/,
    credentials: true,
    said: true,
  },
  {
    name: "a tagged BAD echoes the whole credential pair",
    server: () =>
      imapServer({
        greeting: IMAP_GREETING,
        onCredentials: (c, tag, conn) => conn.send(`${tag} BAD ${SRV} cannot parse ${c.user}:${c.password}\r\n`),
      }),
    message: /^IMAP authentication failed$/,
    credentials: true,
    said: true,
  },
  {
    name: "an untagged NO [ALERT] with the password comes before the tagged NO",
    server: () =>
      imapServer({
        greeting: IMAP_GREETING,
        onCredentials: (c, tag, conn) => conn.send(`* NO [ALERT] ${SRV} ${c.password}\r\n${tag} NO login failed\r\n`),
      }),
    message: /^IMAP authentication failed$/,
    credentials: true,
    said: true,
  },
  {
    name: "BYE with the password replaces the answer to the login",
    server: () =>
      imapServer({
        greeting: IMAP_GREETING,
        onCredentials: (c, _tag, conn) => conn.send(`* BYE ${SRV} too many failed logins, last password ${c.password}\r\n`),
      }),
    message: /^server closed the connection$/,
    credentials: true,
    said: true,
  },
  {
    name: "the greeting itself is a BYE that names the marker",
    server: () => imapServer({ greeting: `* BYE ${SRV} ${MARKER_IMAP}\r\n` }),
    message: /^server refused connection$/,
    credentials: false,
    said: true,
  },
  {
    name: "the first CAPABILITY is answered with a NO that names the marker",
    server: () =>
      imapServer({
        greeting: IMAP_GREETING,
        intercept: (cmd, conn) => (cmd.verb === "CAPABILITY" ? (conn.send(`${cmd.tag} NO ${SRV} ${MARKER_IMAP}\r\n`), true) : false),
      }),
    message: /^CAPABILITY failed$/,
    credentials: false,
    said: true,
  },
  {
    name: "SELECT is refused with a NO that echoes the password after a good login",
    server: () =>
      imapServer({
        greeting: IMAP_GREETING,
        onCredentials: imapAccepts,
        intercept: (cmd, conn, creds) =>
          cmd.verb === "SELECT" ? (conn.send(`${cmd.tag} NO [NONEXISTENT] ${SRV} no mailbox for ${creds?.password}\r\n`), true) : false,
      }),
    message: /^mailbox unavailable$/,
    credentials: true,
    said: true,
  },
  {
    name: "the server resets the connection as soon as the credentials arrive",
    server: () => imapServer({ greeting: IMAP_GREETING, onCredentials: (_c, _tag, conn) => conn.reset() }),
    message: /^connection closed$/,
    credentials: true,
    said: true,
  },
  {
    name: "the server closes right after a greeting that names the marker",
    server: () =>
      imapServer({
        onConnect: (conn) => {
          conn.send(IMAP_GREETING);
          conn.end();
        },
      }),
    message: /^connection closed$/,
    credentials: false,
    said: true,
  },
  {
    name: "the server resets before saying anything",
    server: () => imapServer({ onConnect: (conn) => conn.reset() }),
    message: /^(connection closed|IMAP connection failed)$/, // the RST may land before or after the TCP connect completes
    credentials: false,
    said: false,
  },
  {
    name: "the greeting is binary garbage around the marker",
    server: () => imapServer({ greeting: garbage(MARKER_IMAP) }),
    message: /^unexpected IMAP greeting$/,
    credentials: false,
    said: true,
  },
  {
    name: "the greeting is an HTTP error page that names the marker",
    server: () => imapServer({ greeting: httpPage(MARKER_IMAP) }),
    message: /^unexpected IMAP greeting$/,
    credentials: false,
    said: true,
  },
  {
    name: "the greeting is a JSON document that names the marker",
    server: () => imapServer({ greeting: jsonDoc(MARKER_IMAP) }),
    message: /^unexpected IMAP greeting$/,
    credentials: false,
    said: true,
  },
  {
    name: "the greeting is a line longer than the reader's limit, marker first",
    server: () => imapServer({ greeting: `${MARKER_IMAP}${"A".repeat(70_000)}` }),
    message: /^line too long$/,
    credentials: false,
    said: true,
  },
  {
    name: "the answer to CAPABILITY is a continuation line that names the marker",
    server: () =>
      imapServer({
        greeting: IMAP_GREETING,
        intercept: (cmd, conn) => (cmd.verb === "CAPABILITY" ? (conn.send(`+ ${SRV} ${MARKER_IMAP}\r\n`), true) : false),
      }),
    message: /^unexpected IMAP continuation$/,
    credentials: false,
    said: true,
  },
  {
    name: "the tagged status is malformed and names the marker",
    server: () =>
      imapServer({
        greeting: IMAP_GREETING,
        intercept: (cmd, conn) => (cmd.verb === "CAPABILITY" ? (conn.send(`${cmd.tag} MAYBE ${SRV} ${MARKER_IMAP}\r\n`), true) : false),
      }),
    message: /^malformed IMAP status$/,
    credentials: false,
    said: true,
  },
  {
    name: "a tagged line arrives for a tag nobody sent, and names the marker",
    server: () =>
      imapServer({
        greeting: IMAP_GREETING,
        intercept: (cmd, conn) => (cmd.verb === "CAPABILITY" ? (conn.send(`A9999 OK ${SRV} ${MARKER_IMAP}\r\n`), true) : false),
      }),
    message: /^unexpected IMAP response$/,
    credentials: false,
    said: true,
  },
];

for (const c of IMAP_START_CASES) {
  test(`imap start: ${c.name}`, async () => {
    const rig = await makeRig();
    try {
      const server = await rig.serve(c.server());
      rig.route.set(rig.fx.imap.port, server.port);
      const err = await rig.attempt("start", rig.ch.start(rig.host));
      assert.ok(err instanceof Error, "start() rejects");
      assert.match(err.message, c.message);
      assert.equal(wireCarries(rig.wire.imap, MARKER_IMAP), c.credentials, "the password was presented exactly when the case says so");
      assert.equal(wireCarries(rig.wire.imap, MARKER_SMTP), false, "the SMTP secret never goes to the IMAP server");
      if (c.said) assert.ok(server.text().includes(MARKER_IMAP), "the hostile server really said the marker");
      assert.equal(rig.failures.length, 0, "a failed start is reported by its rejection, not by host.fail");
      assert.deepEqual(await rig.healthOf("after failed start"), { ok: false, detail: "stopped" });
      await rig.ch.stop();
      assertNoLeak(rig, c.name);
    } finally {
      await rig.close();
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// SMTP at send() and health(). The channel starts against the fake IMAP server; only SMTP is broken. health() runs one SMTP NOOP
// session straight away and another after the ten minute window; send() retries 4xx and network errors three times.

interface SmtpCase {
  name: string;
  /** A hostile SMTP server; without it the fixture's own FakeSmtp is used and `setup` injects the failure. */
  server?: () => HostileServer;
  /** Runs after the first, healthy health() and before send(). */
  setup?: (fx: Fixture) => void;
  /** The one fixed message send() must reject with. */
  message: RegExp;
  /** The client got as far as presenting the password. */
  credentials: boolean;
  /** The hostile server's own text carried the marker (false when it only reset or closed). */
  said?: boolean;
}

const SMTP_GREETING = `220 ${SRV} hostile.test ready for ${MARKER_SMTP}\r\n`;
const smtpAccepts = (_c: Creds, conn: HostileConn): void => conn.send("235 2.7.0 authenticated\r\n");

const SMTP_CASES: SmtpCase[] = [
  // The fixture's own SMTP server.
  {
    name: "535 from the fake server after the password was rotated",
    setup: (fx) => {
      fx.smtp.opts.password = "rotated-elsewhere";
    },
    message: /^SMTP authentication failed$/,
    credentials: true,
  },
  {
    name: "535 injected into AUTH on the fake server",
    setup: (fx) => fx.smtp.failNext("AUTH", 535),
    message: /^SMTP authentication failed$/,
    credentials: true,
  },
  {
    name: "451 injected into AUTH on the fake server",
    setup: (fx) => fx.smtp.failNext("AUTH", 451),
    message: /^SMTP authentication failed$/,
    credentials: true,
  },
  {
    name: "451 on EHLO, three times, on the fake server",
    setup: (fx) => fx.smtp.failNext("EHLO", 451, 3),
    message: /^SMTP EHLO deferred$/,
    credentials: true,
  },
  {
    name: "451 on MAIL FROM, three times, on the fake server",
    setup: (fx) => fx.smtp.failNext("MAIL", 451, 3),
    message: /^SMTP MAIL FROM deferred$/,
    credentials: true,
  },
  {
    name: "451 on RCPT TO, three times, on the fake server",
    setup: (fx) => fx.smtp.failNext("RCPT", 451, 3),
    message: /^SMTP RCPT TO deferred$/,
    credentials: true,
  },
  {
    name: "451 on DATA, three times, on the fake server",
    setup: (fx) => fx.smtp.failNext("DATA", 451, 3),
    message: /^SMTP DATA deferred$/,
    credentials: true,
  },
  {
    name: "451 after the message body, three times, on the fake server",
    setup: (fx) => fx.smtp.failNext("end", 451, 3),
    message: /^SMTP message deferred$/,
    credentials: true,
  },
  // Hostile servers that echo the password.
  {
    name: "a 535 to AUTH PLAIN echoes the password",
    server: () =>
      smtpServer({
        greeting: SMTP_GREETING,
        onCredentials: (c, conn) => conn.send(`535 5.7.8 ${SRV} authentication failed for ${c.user}, password ${c.password}\r\n`),
      }),
    message: /^SMTP authentication failed$/,
    credentials: true,
  },
  {
    name: "a 535 to AUTH LOGIN echoes the password",
    server: () =>
      smtpServer({
        greeting: SMTP_GREETING,
        auth: "LOGIN",
        onCredentials: (c, conn) => conn.send(`535 5.7.8 ${SRV} authentication failed for ${c.user}, password ${c.password}\r\n`),
      }),
    message: /^SMTP authentication failed$/,
    credentials: true,
  },
  {
    name: "a temporary 454 to AUTH echoes the password",
    server: () =>
      smtpServer({
        greeting: SMTP_GREETING,
        onCredentials: (c, conn) => conn.send(`454 4.7.0 ${SRV} temporary authentication failure, password ${c.password}\r\n`),
      }),
    message: /^SMTP authentication failed$/,
    credentials: true,
  },
  {
    name: "a 451 to MAIL FROM echoes the password, three times",
    server: () =>
      smtpServer({
        greeting: SMTP_GREETING,
        onCredentials: smtpAccepts,
        intercept: (cmd, conn, creds) => (cmd.verb === "MAIL" ? (conn.send(`451 4.3.0 ${SRV} try later, ${creds?.password}\r\n`), true) : false),
      }),
    message: /^SMTP MAIL FROM deferred$/,
    credentials: true,
  },
  {
    name: "a 550 to RCPT TO echoes the password",
    server: () =>
      smtpServer({
        greeting: SMTP_GREETING,
        onCredentials: smtpAccepts,
        intercept: (cmd, conn, creds) => (cmd.verb === "RCPT" ? (conn.send(`550 5.1.1 ${SRV} no such user, ${creds?.password}\r\n`), true) : false),
      }),
    message: /^SMTP RCPT TO rejected$/,
    credentials: true,
  },
  {
    name: "a 554 to DATA echoes the password",
    server: () =>
      smtpServer({
        greeting: SMTP_GREETING,
        onCredentials: smtpAccepts,
        intercept: (cmd, conn, creds) => (cmd.verb === "DATA" ? (conn.send(`554 5.3.0 ${SRV} refused, ${creds?.password}\r\n`), true) : false),
      }),
    message: /^SMTP DATA rejected$/,
    credentials: true,
  },
  {
    name: "a 452 after the message body echoes the password, three times",
    server: () =>
      smtpServer({
        greeting: SMTP_GREETING,
        onCredentials: smtpAccepts,
        intercept: (cmd, conn, creds) => (cmd.verb === "END" ? (conn.send(`452 4.3.1 ${SRV} storage full, ${creds?.password}\r\n`), true) : false),
      }),
    message: /^SMTP message deferred$/,
    credentials: true,
  },
  {
    name: "a 554 greeting names the marker",
    server: () => smtpServer({ greeting: `554 5.3.2 ${SRV} ${MARKER_SMTP} not accepting mail\r\n` }),
    message: /^SMTP greeting rejected$/,
    credentials: false,
  },
  {
    name: "a 421 greeting names the marker, three times",
    server: () => smtpServer({ greeting: `421 4.3.2 ${SRV} ${MARKER_SMTP} shutting down\r\n` }),
    message: /^SMTP greeting deferred$/,
    credentials: false,
  },
  {
    name: "EHLO is refused with a 502 that names the marker",
    server: () =>
      smtpServer({
        greeting: SMTP_GREETING,
        intercept: (cmd, conn) => (cmd.verb === "EHLO" ? (conn.send(`502 5.5.1 ${SRV} ${MARKER_SMTP}\r\n`), true) : false),
      }),
    message: /^SMTP EHLO rejected$/,
    credentials: false,
  },
  {
    name: "STARTTLS is refused with a 454 that names the marker, three times",
    server: () =>
      smtpServer({
        greeting: SMTP_GREETING,
        intercept: (cmd, conn) => (cmd.verb === "STARTTLS" ? (conn.send(`454 4.7.0 ${SRV} ${MARKER_SMTP}\r\n`), true) : false),
      }),
    message: /^SMTP STARTTLS deferred$/,
    credentials: false,
  },
  // Resets.
  {
    name: "the server resets the connection as soon as the credentials arrive",
    server: () => smtpServer({ greeting: SMTP_GREETING, onCredentials: (_c, conn) => conn.reset() }),
    message: /^connection closed$/,
    credentials: true,
  },
  {
    name: "the server resets the connection when MAIL FROM arrives",
    server: () =>
      smtpServer({
        greeting: SMTP_GREETING,
        onCredentials: smtpAccepts,
        intercept: (cmd, conn) => (cmd.verb === "MAIL" ? (conn.reset(), true) : false),
      }),
    message: /^connection closed$/,
    credentials: true,
  },
  {
    name: "the server closes right after a greeting that names the marker",
    server: () =>
      smtpServer({
        onConnect: (conn) => {
          conn.send(SMTP_GREETING);
          conn.end();
        },
      }),
    message: /^connection closed$/,
    credentials: false,
  },
  {
    name: "the server resets before saying anything",
    server: () => smtpServer({ onConnect: (conn) => conn.reset() }),
    message: /^(connection closed|SMTP connection failed)$/, // the RST may land before or after the TCP connect completes
    credentials: false,
    said: false,
  },
  // Garbage where an SMTP reply belongs.
  {
    name: "the greeting is binary garbage around the marker",
    server: () => smtpServer({ greeting: garbage(MARKER_SMTP) }),
    message: /^malformed SMTP reply$/,
    credentials: false,
  },
  {
    name: "the greeting is an HTTP error page that names the marker",
    server: () => smtpServer({ greeting: httpPage(MARKER_SMTP) }),
    message: /^malformed SMTP reply$/,
    credentials: false,
  },
  {
    name: "the greeting is a JSON document that names the marker",
    server: () => smtpServer({ greeting: jsonDoc(MARKER_SMTP) }),
    message: /^malformed SMTP reply$/,
    credentials: false,
  },
  {
    name: "the greeting is a line longer than the reader's limit, marker first",
    server: () => smtpServer({ greeting: `${MARKER_SMTP}${"A".repeat(5000)}` }),
    message: /^line too long$/,
    credentials: false,
  },
  {
    name: "the EHLO reply is an HTTP error page that names the marker",
    server: () =>
      smtpServer({
        greeting: SMTP_GREETING,
        intercept: (cmd, conn) => (cmd.verb === "EHLO" ? (conn.send(httpPage(MARKER_SMTP)), true) : false),
      }),
    message: /^malformed SMTP reply$/,
    credentials: false,
  },
];

for (const c of SMTP_CASES) {
  test(`smtp send and health: ${c.name}`, async () => {
    const rig = await makeRig();
    const { fx } = rig;
    try {
      let server: HostileServer | undefined;
      if (c.server) {
        server = await rig.serve(c.server());
        rig.route.set(fx.smtp.port, server.port);
      }
      await rig.ch.start(rig.host);
      const chatId = await rig.ch.resolveOwnerTarget({ userId: ALLOWED });
      await rig.healthOf("first health");
      c.setup?.(fx);
      const err = await rig.attempt("send", rig.ch.send({ chatId, text: "hello" }));
      assert.ok(err instanceof Error, "send() rejects");
      assert.match(err.message, c.message);
      assert.equal(fx.smtp.received.length, 0, "nothing was delivered");
      // Past the ten minute window the next health() opens a fresh SMTP session.
      fx.setClock(fx.now() + 10 * 60_000);
      const second = await rig.healthOf("second health");
      assert.match(second.detail ?? "", /^imap:up smtp:(ok|failed)$/);
      assert.equal(wireCarries(rig.wire.smtp, MARKER_SMTP), c.credentials, "the password was presented exactly when the case says so");
      assert.equal(wireCarries(rig.wire.smtp, MARKER_IMAP), false, "the IMAP secret never goes to the SMTP server");
      if (server && c.said !== false) assert.ok(server.text().includes(MARKER_SMTP), "the hostile server really said the marker");
      assert.equal(rig.failures.length, 0, "SMTP trouble never calls host.fail");
      await rig.ch.stop();
      assertNoLeak(rig, c.name);
    } finally {
      await rig.close();
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// IMAP while the channel is running: a lost connection, then a reconnect that goes wrong. These are the paths that reach host.fail
// and the warn and error levels of host.log.

/** Starts the channel, waits for IDLE, drops the connection and waits until the loop is parked in its first backoff. */
async function intoBackoff(rig: Rig): Promise<void> {
  const { fx } = rig;
  await rig.ch.start(rig.host);
  await until(fx, () => idleCount(fx) >= 1, "IDLE entered");
  fx.imap.dropOnSelect = 1;
  fx.imap.append(fixtureMail({ from: ALLOWED, body: "wake up", messageId: "runtime-wake@example.test" }));
  await until(fx, () => reconnects(rig).length >= 1, "loop parked in its first backoff");
}

async function expectFatalAuth(rig: Rig): Promise<void> {
  await until(rig.fx, () => rig.failures.length === 1, "host.fail", true);
  assert.equal((rig.failures[0] as Error).message, "email authentication failed");
  assert.ok(rig.hostLogs.some((l) => l.level === "error" && l.event === "channel.email.fatal"), "host.log recorded the error level");
  assert.ok(rig.hostLogs.some((l) => l.level === "warn" && l.event === "channel.email.reconnect"), "host.log recorded the warn level");
  const h = await rig.healthOf("after the fatal failure");
  assert.equal(h.ok, false);
  assert.match(h.detail ?? "", /^imap:down /);
}

test("imap runtime: the password is refused at reconnect (fake server) and host.fail gets fixed text", async () => {
  const rig = await makeRig();
  try {
    await intoBackoff(rig);
    rig.fx.imap.opts.password = "rotated-elsewhere";
    await expectFatalAuth(rig);
    await rig.ch.stop();
    assertNoLeak(rig, "runtime NO");
  } finally {
    await rig.close();
  }
});

test("imap runtime: the reconnect is refused with a NO that echoes the password", async () => {
  const rig = await makeRig();
  try {
    const server = await rig.serve(
      imapServer({
        greeting: IMAP_GREETING,
        onCredentials: (c, tag, conn) => conn.send(`${tag} NO [AUTHENTICATIONFAILED] ${SRV} login for ${c.user} rejected, password ${c.password}\r\n`),
      }),
    );
    await intoBackoff(rig);
    rig.route.set(rig.fx.imap.port, server.port);
    await expectFatalAuth(rig);
    assert.ok(server.text().includes(MARKER_IMAP), "the reconnect presented the password and the server echoed it");
    await rig.ch.stop();
    assertNoLeak(rig, "runtime NO with echo");
  } finally {
    await rig.close();
  }
});

test("imap runtime: every reconnect is reset by the server; health stays imap:down and nothing is escalated", async () => {
  const rig = await makeRig();
  try {
    const server = await rig.serve(imapServer({ greeting: IMAP_GREETING, onCredentials: (_c, _tag, conn) => conn.reset() }));
    await intoBackoff(rig);
    rig.route.set(rig.fx.imap.port, server.port);
    await until(rig.fx, () => reconnects(rig).length >= 3, "three backoffs", true);
    assert.equal(fieldOf(reconnects(rig).at(-1), "kind"), "network");
    assert.equal(rig.failures.length, 0, "a network failure is retried, not reported as fatal");
    assert.ok(server.text().includes(MARKER_IMAP));
    const h = await rig.healthOf("while down");
    assert.match(h.detail ?? "", /^imap:down /);
    await rig.ch.stop();
    assertNoLeak(rig, "runtime reset");
  } finally {
    await rig.close();
  }
});

test("imap runtime: every reconnect meets garbage that names the marker", async () => {
  const rig = await makeRig();
  try {
    const server = await rig.serve(imapServer({ greeting: httpPage(MARKER_IMAP) }));
    await intoBackoff(rig);
    rig.route.set(rig.fx.imap.port, server.port);
    await until(rig.fx, () => reconnects(rig).length >= 3, "three backoffs", true);
    assert.equal(fieldOf(reconnects(rig).at(-1), "kind"), "protocol");
    assert.equal(rig.failures.length, 0);
    assert.ok(server.text().includes(MARKER_IMAP));
    await rig.healthOf("while down");
    await rig.ch.stop();
    assertNoLeak(rig, "runtime garbage");
  } finally {
    await rig.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// The secret store itself misbehaves. The channel must not pass on whatever the store's error says.

// What start() reports when the secret store fails or has no value: every error that is not an EmailError is rewritten to this
// fixed text (channel.ts #start). docs/channels/email.md section 8 names "email password secret is not set" for the missing-secret
// case, which the channel does not currently produce; that mismatch is a docs question and not a leak.
const STORE_FAILURE = "email start failed";

test("secret reader: an error that carries the IMAP password is replaced by fixed text", async () => {
  const rig = await makeRig({
    secretsFor: () => ({
      reveal: async (name) => {
        throw new Error(`keyring backend failed for ${name}: value ${MARKER_IMAP}`);
      },
    }),
  });
  try {
    const err = await rig.attempt("start", rig.ch.start(rig.host));
    assert.ok(err instanceof Error);
    assert.equal(err.message, STORE_FAILURE);
    assert.deepEqual(await rig.healthOf("after failed start"), { ok: false, detail: "stopped" });
    await rig.ch.stop();
    assertNoLeak(rig, "reader error, IMAP secret");
  } finally {
    await rig.close();
  }
});

test("secret reader: an error that carries the SMTP password is replaced by fixed text, after the IMAP one was read", async () => {
  const rig = await makeRig({
    secretsFor: (names) => ({
      reveal: async (name) => {
        if (name === names.smtp) throw new Error(`keyring backend failed for ${name}: value ${MARKER_SMTP}`);
        return MARKER_IMAP;
      },
    }),
  });
  try {
    const err = await rig.attempt("start", rig.ch.start(rig.host));
    assert.ok(err instanceof Error);
    assert.equal(err.message, STORE_FAILURE);
    assert.equal(rig.wire.imap.length, 0, "no connection was opened with half the credentials");
    await rig.ch.stop();
    assertNoLeak(rig, "reader error, SMTP secret");
  } finally {
    await rig.close();
  }
});

test("secret reader: a missing SMTP secret rejects start() with fixed text while the IMAP secret is in hand", async () => {
  const rig = await makeRig({ secretsFor: (names) => ({ reveal: async (name) => (name === names.imap ? MARKER_IMAP : null) }) });
  try {
    const err = await rig.attempt("start", rig.ch.start(rig.host));
    assert.ok(err instanceof Error);
    assert.equal(err.message, STORE_FAILURE);
    assert.equal(rig.wire.imap.length, 0);
    await rig.ch.stop();
    assertNoLeak(rig, "missing SMTP secret");
  } finally {
    await rig.close();
  }
});

test("secret reader: a password with a line break is refused for LOGIN with fixed text and never reaches the wire", async () => {
  const injected = `${MARKER_IMAP}\r\nA9999 LOGOUT`;
  const rig = await makeRig({ secretsFor: (names) => ({ reveal: async (name) => (name === names.imap ? injected : MARKER_SMTP) }) });
  try {
    rig.fx.imap.opts.authPlain = false; // LOGIN "user" "password" puts the password into a command line
    const err = await rig.attempt("start", rig.ch.start(rig.host));
    assert.ok(err instanceof Error);
    assert.equal(err.message, "invalid character in IMAP argument");
    assert.ok(!rig.fx.imap.commands.includes("LOGIN") && !rig.fx.imap.commands.includes("LOGOUT"), "no command was sent");
    assert.ok(!rig.wire.imap.join("").includes("A9999"), "the injected command never reached the server");
    await rig.ch.stop();
    assertNoLeak(rig, "password with line break");
  } finally {
    await rig.close();
  }
});
