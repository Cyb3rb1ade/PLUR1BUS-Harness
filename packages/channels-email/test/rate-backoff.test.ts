import assert from "node:assert/strict";
import { connect as netConnect, type Socket } from "node:net";
import { test } from "node:test";
import type { ChannelHost } from "../../core/src/channels/types.ts";
import type { IdentityService } from "../../core/src/identity/service.ts";
import type { EmailChannel, EmailChannelOptions, SleepFn } from "../src/index.ts";
import type { ConnectFn } from "../src/wire.ts";
import { ALLOWED, CAROL, fixtureMail, makeEmailFixture } from "./helpers/contract.ts";
import { smtpServer, type HostileServer } from "./helpers/hostile-server.ts";

// Step 5: rate limit and backoff for the Email channel.
//
// Email has no HTTP 429 and no Retry-After. What exists in src/, and what the tests below pin:
//  - SMTP send retry: channel.ts #deliver (SEND_ATTEMPTS = 3). Retries only EmailError kinds "temporary" (any 4xx reply, smtp.ts fail()) and
//    "network"; everything else is final. Wait before attempt n+1 is round(min(60 000, 2000 * 2^(n-1)) * (0.75 + random * 0.5)), so with
//    random = 0.5 (jitter factor exactly 1) it is 2000 ms, then 4000 ms. The 60 000 ms cap cannot be reached with three attempts.
//  - NO wait hint is read from an SMTP reply: the reply text is never parsed (errors are fixed text, wire.ts). So there is nothing "to honour"
//    except the computed wait; "no hint" and "hint present" behave the same, and the default is the 2000 ms above. docs/channels/email.md
//    section 8 only says "three attempts".
//  - IMAP reconnect loop: channel.ts #run. wait = round(min(300 000, 1000 * 2^min(failures-1, 12)) * jitter), failures resets to 0 after a
//    successful open; "auth" and "state" errors are fatal (host.fail once, no retry). docs section 7 says "exponential backoff and jitter".
//  - Poll interval: when IDLE is unavailable the loop waits imap.pollIntervalSec between syncs (docs section 3 table, channel.ts #pollLoop).
//  - A send rate limit DOES exist, but it is a hard refusal, not a backoff: SlidingWindow(30, 1 h) per recipient address in #compose
//    ("email outbound rate limit reached", docs section 4) and SlidingWindow(3, 1 h) for refusal/notice replies per thread (#replyQuietly).
//
// How a wait is proven here: the sleep seam is a recorder that notes the ms it was asked for and then PARKS until the test releases it
// (the fixture's own seam ignores ms). "Honoured" means: the ms argument equals the logged waitMs and the computed value, no SMTP/IMAP
// command and no new connection happens while the wait is parked (quiesce(): a fixed number of event-loop turns once the previous
// connection is closed, no clock), and exactly one more attempt follows each release. Nothing sleeps in real time; the 5 s guard in
// until() fires on failure only.

type Fixture = Awaited<ReturnType<typeof makeEmailFixture>>;
type LogLine = { event: string; level: string; [k: string]: unknown };

/** The IDLE timer (imap.ts IDLE_MAX_MS, channel.ts IDLE_MS) also goes through the sleep seam; every other sleep is a backoff or poll wait. */
const IDLE_TIMER_MS = 25 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface Recorder {
  readonly sleep: SleepFn;
  /** Every ms the channel asked to sleep, in order, including the IDLE timer. */
  readonly calls: number[];
  /** Retry, reconnect and poll waits: every call except the IDLE timer. */
  waits(): number[];
  parked(): number;
  release(): void;
}

function recorder(): Recorder {
  const calls: number[] = [];
  const parked = new Set<() => void>();
  const sleep: SleepFn = (ms, signal) =>
    new Promise<void>((resolve) => {
      calls.push(ms);
      if (signal.aborted) return resolve();
      const done = () => {
        parked.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      parked.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  return {
    sleep,
    calls,
    waits: () => calls.filter((ms) => ms !== IDLE_TIMER_MS),
    parked: () => parked.size,
    release: () => {
      for (const p of [...parked]) p();
    },
  };
}

interface HostRec {
  host: ChannelHost;
  failures: unknown[];
  received: string[];
}

function hostRec(): HostRec {
  const r: HostRec = {
    failures: [],
    received: [],
    host: {
      receive: async (m) => {
        r.received.push(m.text);
      },
      fail: (e) => {
        r.failures.push(e);
      },
      log: { info() {}, warn() {}, error() {} },
    },
  };
  return r;
}

interface Counts {
  /** Connections the channel has started, per server. Incremented synchronously at the connect call. */
  imap: number;
  smtp: number;
  /** Connections started and not yet closed, per server (a connect that failed counts as closed). */
  open: { imap: number; smtp: number };
}

/** Counts every connection the channel opens, and how many of them are still open, per server. */
function countingConnect(counts: Counts, imapPort: number): ConnectFn {
  return (host, port) =>
    new Promise<Socket>((resolve, reject) => {
      const role = port === imapPort ? "imap" : "smtp";
      counts[role]++;
      counts.open[role]++;
      const s = netConnect({ host, port });
      s.once("close", () => void counts.open[role]--);
      s.once("error", reject);
      s.once("connect", () => {
        s.removeAllListeners("error");
        s.on("error", () => {});
        resolve(s);
      });
    });
}

interface RigOptions {
  /** Value returned by the injected random(); 0.5 gives a jitter factor of exactly 1. */
  random?: number;
  /** A hostile SMTP server to route the channel to instead of the fixture's FakeSmtp. */
  smtp?: HostileServer;
  /** Runs after the fake servers listen and before the channel starts. */
  prepare?: (fx: Fixture) => void;
  extra?: (fx: Fixture) => Partial<EmailChannelOptions>;
}

interface Rig {
  fx: Fixture;
  rec: Recorder;
  counts: Counts;
  host: HostRec;
  channel: EmailChannel;
  /** A thread for ALLOWED, created without any inbound mail. */
  chatId: string;
  close(): Promise<void>;
}

/** A started channel on the recording sleep seam, with the IMAP loop parked in its first wait. */
async function makeRig(o: RigOptions = {}): Promise<Rig> {
  const fx = await makeEmailFixture();
  if (o.smtp) await o.smtp.listen();
  o.prepare?.(fx);
  const rec = recorder();
  const counts: Counts = { imap: 0, smtp: 0, open: { imap: 0, smtp: 0 } };
  const random = o.random ?? 0.5;
  const channel = fx.make(false, {
    sleep: rec.sleep,
    random: () => random,
    connect: countingConnect(counts, fx.imap.port),
    smtp: { ...fx.config.smtp, port: o.smtp?.port ?? fx.smtp.port },
    ...(o.extra ? o.extra(fx) : {}),
  });
  const host = hostRec();
  await channel.start(host.host);
  const chatId = await channel.resolveOwnerTarget({ userId: ALLOWED });
  await until(() => rec.calls.length > 0, "the IMAP loop reached its first wait");
  return {
    fx,
    rec,
    counts,
    host,
    channel,
    chatId,
    close: async () => {
      await channel.stop();
      await o.smtp?.close();
      await fx.dispose();
    },
  };
}

/** Resolves once pred() holds, re-checked on every turn of the event loop. With `rec`, every parked sleep is released on each turn. */
async function until(pred: () => boolean, what: string, rec?: Recorder): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    rec?.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Quiescence without a clock, for the "this must NOT happen" assertions. Every attempt the channel could make starts with a connect() call, and
 * countingConnect() counts that call synchronously; the only things that can lead to one are promise continuations of a woken sleep. So a fixed
 * number of event-loop turns (no time) is enough for an early retry to be counted, on any machine speed. Pair it with closed(), which first
 * waits (by cause, not by time) until the sockets of the previous attempt are gone, so the counts it compares are final.
 */
async function quiesce(turns = 200): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Resolves once every connection the channel opened to `role` is closed: the previous session is over, nothing is in flight. */
const closed = (rig: Rig, role: "imap" | "smtp"): Promise<void> => until(() => rig.counts.open[role] === 0, `every ${role} connection is closed`);

/** Awaits p while releasing every parked wait, so a send that retries runs to its end. */
async function settle<T>(rig: Rig, p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => void (done = true),
    () => void (done = true),
  );
  await until(() => done, "operation settled", rig.rec);
  return p;
}

/** Releases everything for a while and checks that no further SMTP attempt, retry log or wait appears. */
async function assertNothingMoreHappens(rig: Rig, attempts: number, waits: readonly number[]): Promise<void> {
  const retries = logs(rig, "channel.email.send-retry").length;
  await closed(rig, "smtp");
  for (let i = 0; i < 50; i++) {
    rig.rec.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await quiesce();
  assert.equal(rig.counts.smtp, attempts, "no attempt after the last one");
  assert.equal(rig.counts.open.smtp, 0, "no SMTP session is open");
  assert.deepEqual(rig.rec.waits(), [...waits], "no further wait was requested");
  assert.equal(logs(rig, "channel.email.send-retry").length, retries, "no further send-retry log");
}

const logs = (rig: Rig, event: string): LogLine[] => (rig.fx.logs as LogLine[]).filter((l) => l.event === event);
const count = (list: readonly string[], verb: string): number => list.filter((c) => c === verb).length;
const hostText = "hello";

interface Probe {
  /** Commands the SMTP server has seen so far (all sessions). */
  commands(): number;
  delivered(): number;
}

/**
 * Drives a send through `expected.length` parked retry waits. At each one: the recorded ms and the logged waitMs are the computed
 * value, nothing reaches the SMTP server while it is parked, and the next attempt happens only after the release.
 */
async function expectHeldRetries(rig: Rig, probe: Probe, send: Promise<unknown>, expected: readonly number[]): Promise<void> {
  send.catch(() => {});
  for (let k = 0; k < expected.length; k++) {
    await until(() => rig.rec.waits().length === k + 1, `retry wait #${k + 1} is parked`);
    assert.deepEqual(rig.rec.waits(), expected.slice(0, k + 1));
    assert.equal(rig.counts.smtp, k + 1, "one SMTP session per attempt so far");
    await closed(rig, "smtp");
    const commands = probe.commands();
    await quiesce();
    assert.equal(probe.commands(), commands, "no SMTP command while the wait is parked");
    assert.equal(rig.counts.smtp, k + 1, "no new SMTP connection while the wait is parked");
    assert.equal(rig.counts.open.smtp, 0, "no SMTP session is open while the wait is parked");
    assert.equal(probe.delivered(), 0, "nothing is delivered before the last retry");
    rig.rec.release();
  }
  await send;
  assert.equal(rig.counts.smtp, expected.length + 1, "exactly one more attempt per released wait");
  assert.equal(probe.delivered(), 1, "delivered exactly once");
  assert.deepEqual(rig.rec.waits(), [...expected], "no wait after the attempt that succeeded");
  assert.deepEqual(
    logs(rig, "channel.email.send-retry").map((l) => [l.attempt, l.waitMs]),
    expected.map((ms, i) => [i + 1, ms]),
    "the logged waitMs is the ms the sleep seam received",
  );
}

const fakeProbe = (rig: Rig): Probe => ({ commands: () => rig.fx.smtp.commands.length, delivered: () => rig.fx.smtp.received.length });

/** A hostile SMTP server that accepts everything except one verb, which it answers with `reply` the first `times` times. */
function flakySmtp(verb: string, reply: string, times: number): { server: HostileServer; stats: { commands: string[]; delivered: number } } {
  const stats = { commands: [] as string[], delivered: 0 };
  let left = times;
  const server = smtpServer({
    onCredentials: (_c, conn) => conn.send("235 2.7.0 authenticated\r\n"),
    intercept: (cmd, conn) => {
      stats.commands.push(cmd.verb);
      if (cmd.verb === verb && left > 0) {
        left--;
        conn.send(`${reply}\r\n`);
        return true;
      }
      if (cmd.verb === "END") stats.delivered++;
      return false;
    },
  });
  return { server, stats };
}

// ---------------------------------------------------------------------------------------------------------------------------
// SMTP: transient replies are retried after the computed wait (channel.ts #deliver).

for (const verb of ["EHLO", "MAIL", "RCPT", "DATA", "end"]) {
  test(`SMTP 451 on ${verb}: the retry waits the computed 2000 ms, nothing is sent while parked, then one more attempt delivers once`, async () => {
    const rig = await makeRig({ prepare: (fx) => fx.smtp.failNext(verb, 451) });
    try {
      await expectHeldRetries(rig, fakeProbe(rig), rig.channel.sendTurn({ chatId: rig.chatId, text: hostText }), [2000]);
      assert.equal(rig.host.failures.length, 0, "SMTP trouble never reaches host.fail");
    } finally {
      await rig.close();
    }
  });
}

for (const verb of ["STARTTLS", "MAIL"]) {
  test(`SMTP 454 on ${verb}: retried on the same schedule, held while parked, delivered once`, async () => {
    const { server, stats } = flakySmtp(verb, "454 4.7.0 temporary failure", 1);
    const rig = await makeRig({ smtp: server });
    try {
      await expectHeldRetries(rig, { commands: () => stats.commands.length, delivered: () => stats.delivered }, rig.channel.sendTurn({ chatId: rig.chatId, text: hostText }), [2000]);
    } finally {
      await rig.close();
    }
  });
}

test("SMTP default wait without any hint: 2000 ms before the second attempt, 4000 ms before the third, each one held", async () => {
  // channel.ts #deliver: 2000 * 2^(attempt - 1) at jitter factor 1. The reply carries no hint, and the code reads none.
  const rig = await makeRig({ prepare: (fx) => fx.smtp.failNext("MAIL", 451, 2) });
  try {
    await expectHeldRetries(rig, fakeProbe(rig), rig.channel.sendTurn({ chatId: rig.chatId, text: hostText }), [2000, 4000]);
  } finally {
    await rig.close();
  }
});

test("SMTP: a wait hint in the reply text is not read, the wait stays the 2000 ms default", async () => {
  // Pins that reply text never steers the sender (a hostile or buggy server cannot park it for a day); wire.ts keeps errors fixed text.
  const { server, stats } = flakySmtp("MAIL", "451 4.7.1 Greylisted, please retry in 300 seconds (Retry-After: 600)", 1);
  const rig = await makeRig({ smtp: server });
  try {
    await expectHeldRetries(rig, { commands: () => stats.commands.length, delivered: () => stats.delivered }, rig.channel.sendTurn({ chatId: rig.chatId, text: hostText }), [2000]);
  } finally {
    await rig.close();
  }
});

for (const [random, waits] of [
  [0, [1500, 3000]],
  [0.999999, [2500, 5000]],
] as const) {
  test(`SMTP jitter is 0.75..1.25 of the base wait (random ${random}): waits ${waits.join(", ")}`, async () => {
    const rig = await makeRig({ random, prepare: (fx) => fx.smtp.failNext("MAIL", 451, 2) });
    try {
      await settle(rig, rig.channel.sendTurn({ chatId: rig.chatId, text: hostText }));
      assert.deepEqual(rig.rec.waits(), [...waits]);
      assert.deepEqual(
        logs(rig, "channel.email.send-retry").map((l) => l.waitMs),
        [...waits],
      );
    } finally {
      await rig.close();
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// SMTP: permanent replies are final, one attempt.

const PERMANENT = [
  { name: "550 on RCPT TO", verb: "RCPT", code: 550, message: "SMTP RCPT TO rejected", kind: "permanent" },
  { name: "554 on MAIL FROM", verb: "MAIL", code: 554, message: "SMTP MAIL FROM rejected", kind: "permanent" },
  { name: "554 on DATA", verb: "DATA", code: 554, message: "SMTP DATA rejected", kind: "permanent" },
  { name: "554 after the message body", verb: "end", code: 554, message: "SMTP message rejected", kind: "permanent" },
  { name: "535 on AUTH", verb: "AUTH", code: 535, message: "SMTP authentication failed", kind: "auth" },
  // Pinned, see the comment on the next test: smtp.ts authenticate() turns every non-235 reply into "auth", 4xx included.
  { name: "451 on AUTH (pinned: reported as an auth failure)", verb: "AUTH", code: 451, message: "SMTP authentication failed", kind: "auth" },
  { name: "454 on AUTH (pinned: reported as an auth failure)", verb: "AUTH", code: 454, message: "SMTP authentication failed", kind: "auth" },
] as const;

// smtp.ts:171 says "Temporary (4xx) ... failures are retried by the caller", but authenticate() (smtp.ts:147) throws kind "auth" for ANY reply
// other than 235, so a 451 or 454 at AUTH (RFC 4954 defines 454 as "temporary authentication failure") is final and the send is not retried.
// test/redaction-catalogue.test.ts already pins the fixed message for both codes, so these two rows pin the attempt count as well.
for (const c of PERMANENT) {
  test(`SMTP ${c.name}: exactly one attempt, no retry, no wait`, async () => {
    const rig = await makeRig({ prepare: (fx) => fx.smtp.failNext(c.verb, c.code, 5) });
    try {
      await assert.rejects(settle(rig, rig.channel.sendTurn({ chatId: rig.chatId, text: hostText })), (e: unknown) => e instanceof Error && e.message === c.message);
      assert.equal(rig.counts.smtp, 1, "one SMTP session");
      assert.equal(rig.fx.smtp.fails.find((f) => f.verb === c.verb)?.times, 4, "exactly one of the injected replies was consumed");
      assert.deepEqual(rig.rec.waits(), []);
      assert.equal(logs(rig, "channel.email.send-retry").length, 0);
      assert.deepEqual(logs(rig, "channel.email.send-failed").map((l) => l.kind), [c.kind]);
      assert.equal(rig.fx.smtp.received.length, 0);
      await assertNothingMoreHappens(rig, 1, []);
    } finally {
      await rig.close();
    }
  });
}

test("SMTP 554 as the greeting is permanent: exactly one attempt", async () => {
  const server = smtpServer({ greeting: "554 5.3.2 not accepting mail\r\n" });
  const rig = await makeRig({ smtp: server });
  try {
    await assert.rejects(settle(rig, rig.channel.sendTurn({ chatId: rig.chatId, text: hostText })), (e: unknown) => e instanceof Error && e.message === "SMTP greeting rejected");
    assert.equal(rig.counts.smtp, 1);
    assert.deepEqual(logs(rig, "channel.email.send-failed").map((l) => l.kind), ["permanent"]);
    await assertNothingMoreHappens(rig, 1, []);
  } finally {
    await rig.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// SMTP: the retry limit (SEND_ATTEMPTS = 3). Bounded: three attempts, two waits, then a fixed-text rejection and nothing more.

test("SMTP: three transient replies exhaust the retry limit; send rejects with the fixed text and no further attempt happens", async () => {
  const rig = await makeRig({ prepare: (fx) => fx.smtp.failNext("MAIL", 451, 5) });
  try {
    await assert.rejects(
      settle(rig, rig.channel.sendTurn({ chatId: rig.chatId, text: hostText })),
      (e: unknown) => e instanceof Error && e.message === "SMTP MAIL FROM deferred",
    );
    assert.equal(rig.counts.smtp, 3, "SEND_ATTEMPTS = 3");
    assert.equal(count(rig.fx.smtp.commands, "MAIL"), 3);
    assert.equal(rig.fx.smtp.fails[0]?.times, 2, "five were injected, three were consumed");
    assert.deepEqual(rig.rec.waits(), [2000, 4000], "two waits between three attempts, none after the last one");
    assert.deepEqual(
      logs(rig, "channel.email.send-retry").map((l) => [l.attempt, l.waitMs]),
      [
        [1, 2000],
        [2, 4000],
      ],
    );
    assert.deepEqual(logs(rig, "channel.email.send-failed").map((l) => l.kind), ["temporary"], "the kind is in the log line, the rejection carries the fixed text");
    assert.equal(rig.fx.smtp.received.length, 0);
    await assertNothingMoreHappens(rig, 3, [2000, 4000]);
    assert.equal(rig.host.failures.length, 0);
  } finally {
    await rig.close();
  }
});

test("SMTP: three network failures exhaust the retry limit the same way", async () => {
  const rig = await makeRig();
  try {
    await rig.fx.smtp.close(); // connection refused from now on
    await assert.rejects(
      settle(rig, rig.channel.sendTurn({ chatId: rig.chatId, text: hostText })),
      (e: unknown) => e instanceof Error && e.message === "SMTP connection failed",
    );
    assert.equal(rig.counts.smtp, 3);
    assert.deepEqual(rig.rec.waits(), [2000, 4000]);
    assert.deepEqual(logs(rig, "channel.email.send-failed").map((l) => l.kind), ["network"]);
    await assertNothingMoreHappens(rig, 3, [2000, 4000]);
  } finally {
    await rig.close();
  }
});

// channel.ts #deliver passes the channel's abort signal to the retry wait and refuses to retry once it is aborted (`|| this.#ac?.signal.aborted`),
// so stop() is meant to end a send that is waiting to retry. But that check runs only after an attempt FAILS: stop() wakes the parked wait, the
// loop goes straight on to the next attempt, and the mail is delivered after stop().
test(
  "SMTP: stop() during a parked retry wait ends the send: no attempt after stop, nothing delivered, the send rejects",
  async () => {
    const rig = await makeRig({ prepare: (fx) => fx.smtp.failNext("MAIL", 451, 1) });
    try {
      const sending = rig.channel.sendTurn({ chatId: rig.chatId, text: hostText });
      let outcome = "pending";
      sending.then(
        () => void (outcome = "resolved"),
        () => void (outcome = "rejected"),
      );
      await until(() => rig.rec.waits().length === 1, "retry wait parked");
      await rig.channel.stop();
      await quiesce();
      await closed(rig, "smtp"); // an attempt that did start has finished, so what the server received is final
      assert.equal(rig.counts.smtp, 1, "no SMTP attempt after stop()");
      assert.equal(rig.fx.smtp.received.length, 0, "nothing is delivered after stop()");
      assert.equal(outcome, "rejected", "a send that never left must not report success");
    } finally {
      await rig.close();
    }
  },
);

// ---------------------------------------------------------------------------------------------------------------------------
// IMAP: the reconnect loop (channel.ts #run).

/** Parks the loop in its first backoff: the next `drops` SELECTs lose the connection, and the IDLE timer is released to start the first sync. */
function dropAndWake(rig: Rig, drops: number): void {
  rig.fx.imap.dropOnSelect = drops;
  rig.rec.release();
}

const reconnectWaits = (rig: Rig): unknown[] => logs(rig, "channel.email.reconnect").map((l) => l.waitMs);
const idleTimers = (rig: Rig): number => rig.rec.calls.filter((ms) => ms === IDLE_TIMER_MS).length;

test("IMAP: transient drops back off 1000, 2000, 4000 ... and stop growing at the 300000 ms cap; the slept ms is the logged waitMs", async () => {
  const rig = await makeRig();
  try {
    dropAndWake(rig, 11); // the sync SELECT, then ten reconnects, each lose the connection: eleven backoffs
    await until(() => rig.rec.waits().length >= 11, "eleven backoffs", rig.rec);
    // random 0.5 is a jitter factor of 1, so these are the plain steps: min(300000, 1000 * 2^(n-1)).
    assert.deepEqual(rig.rec.waits(), [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000]);
    assert.deepEqual(reconnectWaits(rig), rig.rec.waits());
    assert.equal(rig.host.failures.length, 0, "transient drops never call host.fail");
  } finally {
    await rig.close();
  }
});

for (const [random, waits] of [
  [0, [750, 1500, 3000, 6000, 12000, 24000, 48000, 96000, 192000, 225000, 225000]],
  [0.999999, [1250, 2500, 5000, 10000, 20000, 40000, 80000, 160000, 320000, 375000, 375000]],
] as const) {
  test(`IMAP jitter stays in 0.75..1.25 of the base wait, also at the cap (random ${random}: first ${waits[0]}, cap ${waits[9]})`, async () => {
    const rig = await makeRig({ random });
    try {
      dropAndWake(rig, 11);
      await until(() => rig.rec.waits().length >= 11, "eleven backoffs", rig.rec);
      assert.deepEqual(rig.rec.waits(), [...waits]);
    } finally {
      await rig.close();
    }
  });
}

test("IMAP: no reconnect happens while the backoff is parked, and exactly one attempt follows each release", async () => {
  const rig = await makeRig();
  try {
    dropAndWake(rig, 1_000_000);
    await until(() => rig.rec.waits().length === 1, "first backoff parked");
    assert.deepEqual(rig.rec.waits(), [1000]);
    await closed(rig, "imap");
    const connects = rig.counts.imap;
    const commands = rig.fx.imap.commands.length;
    await quiesce();
    assert.equal(rig.counts.imap, connects, "no new IMAP connection while parked");
    assert.equal(rig.counts.open.imap, 0, "no IMAP connection is open while parked");
    assert.equal(rig.fx.imap.commands.length, commands, "no IMAP command while parked");
    assert.deepEqual(await rig.channel.health(), { ok: false, detail: "imap:down smtp:ok" });

    rig.rec.release();
    await until(() => rig.rec.waits().length === 2, "second backoff parked");
    assert.equal(rig.counts.imap, connects + 1, "one reconnect attempt for one release");
    assert.deepEqual(rig.rec.waits(), [1000, 2000]);
    await closed(rig, "imap");
    const after = rig.counts.imap;
    await quiesce();
    assert.equal(rig.counts.imap, after, "parked again, nothing happens");
    assert.equal(rig.counts.open.imap, 0, "no IMAP connection is open while parked");
    assert.equal(rig.host.failures.length, 0);
  } finally {
    await rig.close();
  }
});

test("IMAP: after a successful reconnect the backoff starts again from 1000 ms", async () => {
  const rig = await makeRig();
  try {
    dropAndWake(rig, 1);
    await until(() => rig.rec.waits().length === 1, "first backoff parked");
    rig.rec.release(); // the reconnect succeeds (channel.ts #run: failures = 0)
    await until(() => idleTimers(rig) === 2 && rig.rec.parked() === 1, "back in IDLE after the reconnect");
    dropAndWake(rig, 1);
    await until(() => rig.rec.waits().length === 2, "second backoff parked");
    assert.deepEqual(rig.rec.waits(), [1000, 1000], "not 2000: the counter was reset by the successful open");
    assert.deepEqual(reconnectWaits(rig), [1000, 1000]);
  } finally {
    await rig.close();
  }
});

test("IMAP: a rejected password at reconnect is fatal, not retried: host.fail once, no further wait or connection", async () => {
  // Overlaps contract-catalogue.test.ts e) and channel.test.ts; this one adds the no-wait / no-connection proof on the recording seam.
  const rig = await makeRig();
  try {
    dropAndWake(rig, 1);
    await until(() => rig.rec.waits().length === 1, "first backoff parked");
    rig.fx.imap.opts.password = "rotated-elsewhere";
    rig.rec.release();
    await until(() => rig.host.failures.length === 1, "host.fail called");
    assert.equal((rig.host.failures[0] as Error).message, "email authentication failed");
    await closed(rig, "imap");
    const connects = rig.counts.imap;
    for (let i = 0; i < 50; i++) {
      rig.rec.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await quiesce();
    assert.equal(rig.counts.imap, connects, "the bad password is not presented again");
    assert.equal(rig.counts.open.imap, 0, "the loop stopped: no IMAP connection is open");
    assert.deepEqual(rig.rec.waits(), [1000], "no backoff after the fatal error");
    assert.equal(rig.host.failures.length, 1);
    assert.equal(logs(rig, "channel.email.reconnect").length, 1);
    assert.equal((await rig.channel.health()).ok, false);
  } finally {
    await rig.close();
  }
});

test("IMAP without IDLE: the loop waits imap.pollIntervalSec between syncs and not less", async () => {
  const rig = await makeRig({
    prepare: (fx) => {
      fx.imap.opts.idle = false;
    },
    extra: (fx) => ({ imap: { ...fx.config.imap, pollIntervalSec: 90 } }),
  });
  try {
    assert.deepEqual(rig.rec.calls, [90_000], "the first wait is the configured interval, 90 s");
    const selects = count(rig.fx.imap.commands, "SELECT");
    const connects = rig.counts.imap;
    rig.fx.imap.append(fixtureMail({ from: ALLOWED, body: "polled mail", messageId: "poll-1@x" }));
    await quiesce(); // the one IMAP connection stays open and idle; only the parked wait could start the next sync
    assert.equal(count(rig.fx.imap.commands, "SELECT"), selects, "no sync while the poll wait is parked");
    assert.equal(rig.counts.imap, connects, "no reconnect either");
    assert.deepEqual(rig.host.received, []);
    rig.rec.release();
    await until(() => rig.host.received.length === 1, "the mail is fetched after the wait");
    assert.equal(count(rig.fx.imap.commands, "SELECT"), selects + 1, "one sync per interval");
    await until(() => rig.rec.calls.length === 2, "next poll wait requested");
    assert.deepEqual(rig.rec.calls, [90_000, 90_000]);
  } finally {
    await rig.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// Outbound rate limit (docs/channels/email.md section 4): a refusal, not a backoff. No SMTP command, no wait, no retry log.

const LIMIT_ERROR = /^Error: email outbound rate limit reached$/;

test("rate limit: the 31st send to one recipient within the hour is refused before any SMTP command; other peers are unaffected; the window slides", async () => {
  const rig = await makeRig({ extra: () => ({ dmAllowlist: [ALLOWED, CAROL] }) });
  try {
    const carol = await rig.channel.resolveOwnerTarget({ userId: CAROL });
    const t0 = rig.fx.now();
    for (let i = 0; i < 30; i++) await rig.channel.sendTurn({ chatId: rig.chatId, text: `m${i}` });
    assert.equal(rig.fx.smtp.received.length, 30);

    const connects = rig.counts.smtp;
    const commands = rig.fx.smtp.commands.length;
    await assert.rejects(rig.channel.sendTurn({ chatId: rig.chatId, text: "one too many" }), LIMIT_ERROR);
    assert.equal(rig.counts.smtp, connects, "no SMTP connection for a refused send");
    assert.equal(rig.fx.smtp.commands.length, commands, "no SMTP command for a refused send");
    assert.deepEqual(rig.rec.waits(), [], "a refusal is not retried and not delayed");
    assert.equal(logs(rig, "channel.email.send-retry").length + logs(rig, "channel.email.send-failed").length, 0);

    await rig.channel.sendTurn({ chatId: carol, text: "another recipient has its own allowance" });
    assert.equal(rig.fx.smtp.received.length, 31);

    rig.fx.setClock(t0 + HOUR_MS - 1);
    await assert.rejects(rig.channel.sendTurn({ chatId: rig.chatId, text: "still inside the hour" }), LIMIT_ERROR);
    rig.fx.setClock(t0 + HOUR_MS);
    await rig.channel.sendTurn({ chatId: rig.chatId, text: "the hour is over" });
    assert.equal(rig.fx.smtp.received.length, 32);
  } finally {
    await rig.close();
  }
});

test("rate limit: SMTP retries of one message use one slot of the 30 per hour, not one per attempt", async () => {
  const rig = await makeRig({ prepare: (fx) => fx.smtp.failNext("MAIL", 451, 2) });
  try {
    await settle(rig, rig.channel.sendTurn({ chatId: rig.chatId, text: "needs three attempts" }));
    assert.equal(rig.counts.smtp, 3);
    for (let i = 1; i < 30; i++) await rig.channel.sendTurn({ chatId: rig.chatId, text: `m${i}` });
    assert.equal(rig.fx.smtp.received.length, 30, "thirty messages were delivered");
    await assert.rejects(rig.channel.sendTurn({ chatId: rig.chatId, text: "one too many" }), LIMIT_ERROR);
    assert.equal(rig.counts.smtp, 3 + 29, "the refused send opened no connection");
  } finally {
    await rig.close();
  }
});

test("rate limit: refusal and notice replies are limited to three per thread per hour", async () => {
  const pairing = {
    claim: () => {
      throw new Error("unused: the refusal comes before the claim");
    },
  } as unknown as Pick<IdentityService, "claim">;
  const fx = await makeEmailFixture();
  const ch = fx.make(false, { pairing });
  const host = hostRec();
  try {
    await ch.start(host.host);
    // No Authentication-Results header: /link is refused with the uniform failure reply. All mails share one thread through References.
    const linkMail = (n: number): Buffer =>
      fixtureMail({ from: ALLOWED, body: "link LINKCODE9", messageId: `refusal-${n}@x`, auth: null, extraHeaders: ["References: <refusal-root@x>"] });
    for (let n = 1; n <= 5; n++) await fx.deliverRaw(linkMail(n));
    assert.equal(fx.smtp.received.length, 3, "five refused requests, three replies");
    fx.setClock(fx.now() + HOUR_MS);
    await fx.deliverRaw(linkMail(6));
    assert.equal(fx.smtp.received.length, 4, "the window has passed: one more reply");
    assert.deepEqual(host.received, [], "refused link requests are never forwarded as text");
  } finally {
    await ch.stop();
    await fx.dispose();
  }
});
