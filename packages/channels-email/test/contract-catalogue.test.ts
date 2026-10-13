import assert from "node:assert/strict";
import { connect as netConnect, type Socket } from "node:net";
import { test } from "node:test";
import type { ChannelHost, InboundMessage } from "../../core/src/channels/types.ts";
import { MemoryUidStore, type UidState, type UidStore } from "../src/index.ts";
import type { ConnectFn } from "../src/wire.ts";
import { ALLOWED, BOT, IMAP_PW, SMTP_PW, fixtureMail, makeEmailFixture } from "./helpers/contract.ts";

// Contract catalogue for the Email channel (packages/core/src/channels/types.ts), points a) to g), mirroring the Telegram catalogue.
//
// Transport notes that shape these tests:
//  - Email has no long-lived socket per se: the IMAP session is the "connection" (health() reports it as imap:up / imap:down,
//    docs/channels/email.md section 7). SMTP is one short session per send plus a NOOP checked at most every ten minutes.
//  - Mail that is already in the mailbox when the channel first starts is baselined, not processed. Tests that want a batch
//    waiting at start therefore pre-seed the UID cursor (MemoryUidStore with lastUid 0).
//  - The fixture's sleep seam parks every sleep (IDLE timer, backoff, send retry) until fx.release(), so a loop that is paused
//    in backoff can be inspected. waitFor() without `release` inspects a parked loop, with `release` it drives the loop.

type Fixture = Awaited<ReturnType<typeof makeEmailFixture>>;

interface HostRec {
  host: ChannelHost;
  received: InboundMessage[];
  failures: unknown[];
  hostLogs: { level: string; event: string }[];
}

function hostRec(): HostRec {
  const r: HostRec = {
    received: [],
    failures: [],
    hostLogs: [],
    host: {
      receive: async (m) => {
        r.received.push(m);
      },
      fail: (e) => {
        r.failures.push(e);
      },
      log: {
        info: (event) => void r.hostLogs.push({ level: "info", event }),
        warn: (event) => void r.hostLogs.push({ level: "warn", event }),
        error: (event) => void r.hostLogs.push({ level: "error", event }),
      },
    },
  };
  return r;
}

/**
 * Resolves once pred() holds. The predicate usually reads fake-side state (commands the fake IMAP saw, log lines), which raises
 * no host event, so it is re-checked on every turn of the event loop. With `release` every parked sleep is also released on each
 * turn (that is how a backoff or IDLE timer is driven). The 5 s guard only fires on failure.
 */
async function waitFor(fx: Fixture, pred: () => boolean, what: string, release = false): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    if (release) fx.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const idleCount = (fx: Fixture): number => fx.imap.commands.filter((c) => c === "IDLE").length;
const cmdCount = (fx: Fixture, name: string): number => fx.imap.commands.filter((c) => c === name).length;
/** The fake IMAP is idling, so a mail appended now reaches the channel as EXISTS (before this, no notification would be sent). */
const waitIdle = (fx: Fixture, n = 1): Promise<void> => waitFor(fx, () => idleCount(fx) >= n, `IDLE #${n} entered`);

type LogLine = { event: string; level: string; [k: string]: unknown };
const logLines = (fx: Fixture, event: string): LogLine[] => (fx.logs as LogLine[]).filter((l) => l.event === event);

function mail(text: string, messageId: string): Buffer {
  return fixtureMail({ from: ALLOWED, body: text, messageId });
}

/** Neither a password nor the rotated marker password may appear in logs or in what the host was told. */
function assertNoSecrets(fx: Fixture, h: HostRec): void {
  const text = JSON.stringify([fx.logs, h.hostLogs, h.failures.map((f) => (f as Error).message)]);
  for (const s of [IMAP_PW, SMTP_PW, "rotated-elsewhere"]) assert.ok(!text.includes(s), "secret leaked");
}

/** A UID store that can be made to fail, to model a full disk (save) or an unreadable state file (load). */
class FlakyUidStore implements UidStore {
  readonly inner: MemoryUidStore;
  failSaves = 0;
  failLoad = false;
  constructor(initial: UidState) {
    this.inner = new MemoryUidStore(initial);
  }
  async load(): Promise<UidState | undefined> {
    if (this.failLoad) throw new Error("state unreadable (simulated)");
    return this.inner.load();
  }
  async save(state: UidState): Promise<void> {
    if (this.failSaves > 0) {
      this.failSaves--;
      throw new Error("disk full (simulated)");
    }
    return this.inner.save(state);
  }
}

const seededStore = (): MemoryUidStore => new MemoryUidStore({ folder: "INBOX", uidValidity: 1, lastUid: 0 });

/** Records every socket the channel opens, so a test can pause a response in flight or check that stop() closed them. */
function recordingConnect(): { connect: ConnectFn; sockets: Socket[] } {
  const sockets: Socket[] = [];
  const connect: ConnectFn = (host, port) =>
    new Promise<Socket>((resolve, reject) => {
      const s = netConnect({ host, port });
      s.once("error", reject);
      s.once("connect", () => {
        s.removeAllListeners("error");
        s.on("error", () => {});
        sockets.push(s);
        resolve(s);
      });
    });
  return { connect, sockets };
}

/** Pauses the channel's IMAP socket as the server receives the next UID FETCH, so that fetch stays pending until the channel stops. */
function holdNextFetch(fx: Fixture, sockets: Socket[]): { held: () => boolean } {
  let held = false;
  const orig = fx.imap.onCommand.bind(fx.imap);
  fx.imap.onCommand = (name: string) => {
    orig(name);
    if (!held && name === "UID FETCH") {
      held = true;
      sockets.at(-1)!.pause();
    }
  };
  return { held: () => held };
}

/** Runs body with an unhandledRejection listener installed; asserts nothing surfaced once the event loop has drained. */
async function expectNoUnhandledRejection(body: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const onRejection = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    await body();
    for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// a) start resolves, then health reports ok (imap:up).
// Overlaps channel.test.ts "lifecycle: idempotent start, …, health" and "health: SMTP is checked lazily …".

test("a) start resolves and health reports ok with the IMAP session up", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    assert.deepEqual(await fx.channel.health(), { ok: false, detail: "stopped" }, "not healthy before start");
    await fx.channel.start(h.host);
    const health = await fx.channel.health();
    assert.equal(health.ok, true);
    assert.match(health.detail ?? "", /^imap:up smtp:/);
    assert.equal(h.failures.length, 0, "a healthy start never calls host.fail");
    assert.ok(h.hostLogs.some((l) => l.event === "channel.email.started"));
  } finally {
    await fx.dispose();
  }
});

test("a) health pins the documented SMTP check: one NOOP per ten minutes, not one per call", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const noops = () => fx.smtp.commands.filter((c) => c === "NOOP").length;
  try {
    await fx.channel.start(h.host);
    assert.match((await fx.channel.health()).detail ?? "", /^imap:up smtp:ok$/);
    await fx.channel.health();
    assert.equal(noops(), 1);
    fx.setClock(fx.now() + 10 * 60_000 - 1);
    await fx.channel.health();
    assert.equal(noops(), 1, "still inside the ten minute window");
    fx.setClock(fx.now() + 1);
    await fx.channel.health();
    assert.equal(noops(), 2, "the window has passed, the next health call checks SMTP again");
  } finally {
    await fx.dispose();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// b) stop is idempotent; stop on a never-started channel does not throw.
// Overlaps channel.test.ts "lifecycle: …" (it calls stop twice).

test("b) stop is idempotent: a second stop does not throw and the channel reports stopped", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    await fx.channel.stop();
    await fx.channel.stop();
    assert.deepEqual(await fx.channel.health(), { ok: false, detail: "stopped" });
    assert.equal(h.failures.length, 0, "a requested stop is not a failure");
  } finally {
    await fx.dispose();
  }
});

test("b) stop on a channel that never started does not throw", async () => {
  const fx = await makeEmailFixture();
  try {
    await fx.channel.stop();
    await fx.channel.stop();
    assert.deepEqual(await fx.channel.health(), { ok: false, detail: "stopped" });
    assert.equal(fx.imap.commands.length, 0, "no IMAP traffic from a channel that never started");
    assert.equal(fx.smtp.commands.length, 0, "no SMTP traffic from a channel that never started");
  } finally {
    await fx.dispose();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// c) send after stop is rejected with a defined error and nothing reaches SMTP. No existing test covers send() on a stopped channel.

test("c) send after stop is rejected and nothing reaches the SMTP server", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    await fx.deliver(ALLOWED, "open a thread");
    const chatId = h.received[0]!.chatId;
    // Control: the same send succeeds while the channel is started, so the rejection below is about the stopped state.
    await fx.channel.send({ chatId, text: "before stop" });
    assert.equal(fx.smtp.received.length, 1);
    const smtpTraffic = fx.smtp.commands.length;
    await fx.channel.stop();
    await assert.rejects(fx.channel.send({ chatId, text: "after stop" }), /^Error: email channel is not started$/);
    assert.equal(fx.smtp.received.length, 1, "no mail left the channel after stop");
    assert.equal(fx.smtp.commands.length, smtpTraffic, "not even an SMTP session was opened");
  } finally {
    await fx.dispose();
  }
});

test("c) send on a channel that never started is rejected the same way", async () => {
  const fx = await makeEmailFixture();
  try {
    await assert.rejects(fx.channel.send({ chatId: "t-00000000000000000000000000000000", text: "x" }), /^Error: email channel is not started$/);
    assert.equal(fx.smtp.commands.length, 0);
  } finally {
    await fx.dispose();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// d) an inbound message reaches host.receive exactly once, even when the same IMAP UID is seen twice.
// Overlaps channel.test.ts "duplicate Message-ID is processed once" (two mails, one Message-ID) and stores.test.ts (the store alone).

test("d) one fetch batch that carries the same UID twice delivers the mail once", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const ch = fx.make(false, {}, seededStore());
  try {
    // The duplicate is queued before start, so a single UID SEARCH answers "1 1 2". (A real server never repeats a UID in one SEARCH;
    // this is the hostile shape of "the same UID seen twice". The repeat is caught by the in-process Message-ID set.)
    const raw = mail("once", "cat-d1@x");
    const uid = fx.imap.append(raw);
    fx.imap.messages.push({ uid, raw, seen: false });
    fx.imap.append(mail("sentinel", "cat-d1-sentinel@x"));
    await ch.start(h.host);
    assert.deepEqual(h.received.map((m) => m.text), ["once", "sentinel"]);
    assert.equal(h.received[0]!.messageId, "cat-d1@x");
    assert.equal(logLines(fx, "channel.email.duplicate").length, 1, "the repeat was recognised and dropped");
    assert.equal(h.failures.length, 0);
  } finally {
    await ch.stop();
    await fx.dispose();
  }
});

test(
  "d) the same UID twice in one batch is delivered once even when the mail has no Message-ID",
  {
    todo:
      "KNOWN GAP: channels-email EmailChannel.#sync/#handleRaw: erwartet 1 host.receive für dieselbe UID im selben Batch, tatsächlich 2 (nur Message-ID wird dedupliziert, die UID nicht; ohne Message-ID gibt es keine Unterdrückung)",
  },
  async () => {
    const fx = await makeEmailFixture();
    const h = hostRec();
    const ch = fx.make(false, {}, seededStore());
    try {
      const raw = Buffer.from(
        [
          "Authentication-Results: mx.test; dmarc=pass",
          `From: ${ALLOWED}`,
          `To: ${BOT}`,
          "Subject: hello",
          "Date: Thu, 08 Oct 2026 10:00:00 +0000",
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "no id",
          "",
        ].join("\r\n"),
        "utf8",
      );
      const uid = fx.imap.append(raw);
      fx.imap.messages.push({ uid, raw, seen: false });
      fx.imap.append(mail("sentinel", "cat-d2-sentinel@x"));
      await ch.start(h.host);
      assert.deepEqual(h.received.map((m) => m.text), ["no id", "sentinel"]);
    } finally {
      await ch.stop();
      await fx.dispose();
    }
  },
);

test("d) a UID that is fetched again after a failed cursor save is delivered once", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const store = new FlakyUidStore({ folder: "INBOX", uidValidity: 1, lastUid: 0 });
  const ch = fx.make(false, {}, store);
  try {
    await ch.start(h.host);
    await waitIdle(fx);
    // The hand-off happens, then saving the cursor fails: the loop reconnects and sees UID 1 above the old cursor again.
    store.failSaves = 1;
    fx.imap.append(mail("once", "cat-d3@x"));
    await waitFor(fx, () => logLines(fx, "channel.email.reconnect").length === 1, "reconnect after the failed save");
    assert.deepEqual(h.received.map((m) => m.text), ["once"]);
    assert.equal(h.failures.length, 0, "a failed cursor save is transient, not fatal");
    await waitFor(fx, () => fx.imap.messages[0]!.seen, "UID 1 processed on the second pass", true);
    assert.equal(cmdCount(fx, "UID FETCH"), 4, "UID 1 was fetched twice (size and body, two passes)");
    assert.deepEqual(h.received.map((m) => m.text), ["once"], "the second sighting was suppressed");
    assert.equal(logLines(fx, "channel.email.duplicate").length, 1);
    assert.equal((await store.inner.load())?.lastUid, 1);
  } finally {
    await ch.stop();
    await fx.dispose();
  }
});

test("d) a restarted channel does not re-deliver mail below the persisted UID cursor", async () => {
  const fx = await makeEmailFixture();
  const store = new MemoryUidStore();
  const h1 = hostRec();
  const h2 = hostRec();
  const ch1 = fx.make(false, {}, store);
  const ch2 = fx.make(false, {}, store);
  try {
    await ch1.start(h1.host);
    await fx.deliverRaw(mail("once", "cat-d4-once@x"));
    await ch1.stop();
    assert.deepEqual(h1.received.map((m) => m.text), ["once"]);
    // ch2 has an empty Message-ID set, so only the persisted cursor keeps UID 1 (still in the mailbox) from being fetched again.
    await ch2.start(h2.host);
    await fx.deliverRaw(mail("sentinel", "cat-d4-sentinel@x"));
    assert.deepEqual(h2.received.map((m) => m.text), ["sentinel"]);
    assert.equal((await store.load())?.lastUid, 2);
  } finally {
    await ch1.stop();
    await ch2.stop();
    await fx.dispose();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// e) final failures call host.fail; transient ones do not and the loop recovers.
// Overlaps channel.test.ts "runtime auth failure after reconnect is fatal: host.fail, no retry storm" and
// "reconnects after a dropped connection and keeps delivering".
//
// Which responses are final (channel.ts #run): an IMAP authentication refusal (NO on AUTHENTICATE/LOGIN, imap.ts authenticate) and
// an unreadable UID state. Both reach host.fail only from the running loop (a reconnect or a sync). At start() the same
// conditions reject start() instead. An SMTP refusal never calls host.fail: send() rejects and health() shows smtp:failed.

test("e) a final IMAP authentication failure calls host.fail once, stops retrying and reports imap:down", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    await waitIdle(fx);
    fx.imap.opts.password = "rotated-elsewhere"; // the password changed behind the channel's back
    fx.imap.dropOnSelect = 1;
    fx.imap.append(mail("never handled", "cat-e1@x"));
    await waitFor(fx, () => h.failures.length === 1, "host.fail", true);
    assert.equal((h.failures[0] as Error).message, "email authentication failed");
    // No retry storm: keep driving the loop, nothing more happens.
    for (let i = 0; i < 20; i++) {
      fx.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(h.failures.length, 1);
    assert.equal(cmdCount(fx, "AUTHENTICATE"), 2, "the first login and exactly one refused retry");
    assert.equal(h.received.length, 0);
    assert.ok(h.hostLogs.some((l) => l.level === "error" && l.event === "channel.email.fatal"));
    const health = await fx.channel.health();
    assert.equal(health.ok, false);
    assert.match(health.detail ?? "", /^imap:down /);
    assertNoSecrets(fx, h);
  } finally {
    await fx.channel.stop();
    await fx.dispose();
  }
});

test("e) a rejected password at start rejects start() and does not also call host.fail", async () => {
  // Pins the documented semantics: at start the rejection of start() is the failure report (the registry restarts on it), so
  // host.fail would be a second report of the same event. host.fail is for failures after start succeeded.
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    fx.imap.opts.password = "rotated-elsewhere";
    await assert.rejects(fx.channel.start(h.host), /^Error: IMAP authentication failed$/);
    assert.equal(h.failures.length, 0);
    assert.deepEqual(await fx.channel.health(), { ok: false, detail: "stopped" });
    assertNoSecrets(fx, h);
  } finally {
    await fx.dispose();
  }
});

test("e) an unreadable UID state after start is the other final failure: host.fail once", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const store = new FlakyUidStore({ folder: "INBOX", uidValidity: 1, lastUid: 0 });
  const ch = fx.make(false, {}, store);
  try {
    await ch.start(h.host);
    await waitIdle(fx);
    store.failLoad = true;
    fx.imap.append(mail("never handled", "cat-e3@x"));
    await waitFor(fx, () => h.failures.length === 1, "host.fail", true);
    assert.equal((h.failures[0] as Error).message, "email state is invalid");
    assert.equal(h.received.length, 0, "fail closed: nothing is processed without a readable cursor");
    assert.equal(logLines(fx, "channel.email.reconnect").length, 0, "no retry for a state failure");
    assert.equal((await ch.health()).ok, false);
  } finally {
    await ch.stop();
    await fx.dispose();
  }
});

test("e) transient IMAP drops do not call host.fail; backoff grows and a later mail is delivered", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    await waitIdle(fx);
    fx.imap.dropOnSelect = 2; // the next two SELECTs lose the connection: the sync after IDLE, then the first reconnect
    fx.imap.append(mail("survives two drops", "cat-e4-a@x"));
    await waitFor(fx, () => logLines(fx, "channel.email.reconnect").length === 1, "first backoff");
    assert.equal(h.failures.length, 0);
    await waitFor(fx, () => h.received.length === 1, "delivery after recovery", true);
    assert.deepEqual(h.received.map((m) => m.text), ["survives two drops"]);
    // jitter is fixed (random 0.5 gives factor 1), so the waits are the plain exponential steps
    assert.deepEqual(logLines(fx, "channel.email.reconnect").map((l) => l.waitMs), [1000, 2000]);
    assert.equal(h.failures.length, 0, "transient failures never call host.fail");
    // The loop is alive again: a later mail is delivered too.
    fx.imap.append(mail("a later one", "cat-e4-b@x"));
    await waitFor(fx, () => h.received.length === 2, "a later mail after recovery", true);
    assert.equal(h.received[1]!.text, "a later one");
    assert.equal(h.failures.length, 0);
    assert.match((await fx.channel.health()).detail ?? "", /^imap:up /);
  } finally {
    await fx.channel.stop();
    await fx.dispose();
  }
});

test("e) SMTP trouble never calls host.fail: 451 is retried, a refused login rejects send(), IMAP keeps delivering", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    await fx.deliver(ALLOWED, "open a thread");
    const chatId = h.received[0]!.chatId;
    assert.match((await fx.channel.health()).detail ?? "", /^imap:up smtp:ok$/);

    // Transient: 451 on MAIL, one retry after the (parked) backoff, the mail leaves exactly once.
    fx.smtp.failNext("MAIL", 451);
    const sending = fx.channel.send({ chatId, text: "retried" });
    await waitFor(fx, () => logLines(fx, "channel.email.send-retry").length === 1, "send retry parked");
    assert.equal(fx.smtp.received.length, 0);
    fx.release();
    await sending;
    assert.equal(fx.smtp.received.length, 1);
    assert.equal(h.failures.length, 0);

    // Final for this send, but not for the channel: SMTP login refused (535).
    fx.smtp.failNext("AUTH", 535);
    await assert.rejects(fx.channel.send({ chatId, text: "refused" }), /^Error: SMTP authentication failed$/);
    assert.equal(fx.smtp.received.length, 1, "nothing was sent");
    assert.equal(h.failures.length, 0, "host.fail is reserved for the IMAP session; SMTP trouble surfaces through send() and health()");
    // Documented health semantics: the IMAP session decides ok, the last SMTP outcome is reported in the detail.
    assert.deepEqual(await fx.channel.health(), { ok: true, detail: "imap:up smtp:failed" });
    await fx.deliver(ALLOWED, "still reading");
    assert.deepEqual(h.received.map((m) => m.text), ["open a thread", "still reading"]);
    assertNoSecrets(fx, h);
  } finally {
    await fx.dispose();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// f) after IMAP connection loss, health() reports imap:down (docs/channels/email.md section 7).
// Overlaps channel.test.ts "health: SMTP is checked lazily" (detail format only); nothing else pins imap:down.

test("f) after the IMAP connection is lost health reports imap:down, and imap:up again once it recovers", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    assert.deepEqual(await fx.channel.health(), { ok: true, detail: "imap:up smtp:ok" });
    await waitIdle(fx);
    fx.imap.dropOnSelect = 1; // the server drops the connection on the next SELECT (the sync that follows the IDLE wake-up)
    fx.imap.append(mail("after the loss", "cat-f1@x"));
    // The loop parks in backoff; inspect it there (no release).
    await waitFor(fx, () => logLines(fx, "channel.email.reconnect").length === 1, "loop parked in backoff");
    assert.deepEqual(await fx.channel.health(), { ok: false, detail: "imap:down smtp:ok" });
    assert.equal(h.failures.length, 0, "a lost connection is retried, not reported as fatal");
    await waitFor(fx, () => h.received.length === 1, "delivery after reconnect", true);
    assert.equal((await fx.channel.health()).ok, true);
    assert.match((await fx.channel.health()).detail ?? "", /^imap:up /);
  } finally {
    await fx.channel.stop();
    await fx.dispose();
  }
});

test("f) with the IMAP server gone for good health stays imap:down, the channel keeps retrying and never calls host.fail", async () => {
  // Pins the documented semantics (section 7): network failures are transient by definition for email, so "connection lost for good"
  // is not escalated to host.fail; only a rejected password or unreadable state is. The host sees it through health().
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    await waitIdle(fx);
    await fx.imap.close(); // destroys the channel's socket and refuses new connections
    await waitFor(fx, () => logLines(fx, "channel.email.reconnect").length === 1, "loop parked in backoff");
    assert.deepEqual(await fx.channel.health(), { ok: false, detail: "imap:down smtp:ok" });
    await waitFor(fx, () => logLines(fx, "channel.email.reconnect").length === 2, "second backoff after a refused reconnect", true);
    assert.deepEqual(logLines(fx, "channel.email.reconnect").map((l) => l.waitMs), [1000, 2000]);
    assert.equal((await fx.channel.health()).ok, false);
    assert.equal(h.failures.length, 0);
  } finally {
    await fx.channel.stop();
    await fx.dispose();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// g) stop, including while an IDLE or a fetch is pending, leaves no unhandled promise rejection. No existing test covers this.

test("g) stop while an IDLE is pending settles cleanly, closes the socket and leaves no unhandled rejection", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const rec = recordingConnect();
  const ch = fx.make(false, { connect: rec.connect });
  try {
    await expectNoUnhandledRejection(async () => {
      await ch.start(h.host);
      await waitIdle(fx);
      await ch.stop();
      assert.deepEqual(await ch.health(), { ok: false, detail: "stopped" });
      assert.equal(h.failures.length, 0);
      assert.ok(rec.sockets.length > 0 && rec.sockets.every((s) => s.destroyed), "stop closed the IMAP socket");
    });
  } finally {
    await ch.stop();
    await fx.dispose();
  }
});

test("g) stop while a UID FETCH is pending settles cleanly and leaves no unhandled rejection", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const rec = recordingConnect();
  const ch = fx.make(false, { connect: rec.connect });
  try {
    await expectNoUnhandledRejection(async () => {
      await ch.start(h.host);
      await waitIdle(fx);
      const fetch = holdNextFetch(fx, rec.sockets);
      fx.imap.append(mail("in flight", "cat-g2@x"));
      await waitFor(fx, fetch.held, "fetch is pending");
      await ch.stop();
      assert.equal(h.received.length, 0, "the pending mail was never handed over");
      assert.equal(h.failures.length, 0, "stopping is not a failure");
      assert.ok(rec.sockets.every((s) => s.destroyed));
      assert.deepEqual(await ch.health(), { ok: false, detail: "stopped" });
    });
  } finally {
    await ch.stop();
    await fx.dispose();
  }
});

test("g) stop while start's own first sync is waiting on a fetch settles and leaves no unhandled rejection", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const rec = recordingConnect();
  const ch = fx.make(false, { connect: rec.connect }, seededStore());
  try {
    await expectNoUnhandledRejection(async () => {
      fx.imap.append(mail("waiting at start", "cat-g3@x"));
      const fetch = holdNextFetch(fx, rec.sockets);
      const starting = ch.start(h.host);
      await waitFor(fx, fetch.held, "start's fetch is pending");
      const stopping = ch.stop();
      const [start, stop] = await Promise.allSettled([starting, stopping]);
      assert.equal(stop.status, "fulfilled");
      assert.equal(start.status, "rejected", "start() reports that it did not complete");
      assert.equal(h.received.length, 0);
      assert.equal(h.failures.length, 0);
      assert.ok(rec.sockets.every((s) => s.destroyed));
      assert.deepEqual(await ch.health(), { ok: false, detail: "stopped" });
    });
  } finally {
    await ch.stop();
    await fx.dispose();
  }
});

test("g) stop issued right after start() was called settles without an unhandled rejection", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const ch = fx.make(false);
  try {
    await expectNoUnhandledRejection(async () => {
      const starting = ch.start(h.host);
      const stopping = ch.stop();
      const [, stop] = await Promise.allSettled([starting, stopping]);
      assert.equal(stop.status, "fulfilled");
      assert.deepEqual(await ch.health(), { ok: false, detail: "stopped" });
      assert.equal(h.failures.length, 0);
    });
  } finally {
    await ch.stop();
    await fx.dispose();
  }
});

test(
  "g) stop issued right after start() was called leaves no IMAP socket open",
  {
    todo:
      "KNOWN GAP: channels-email EmailChannel.stop/#start: erwartet alle IMAP-Sockets nach stop() geschlossen, tatsächlich 1 Socket offen und start() erfüllt (#start weist #conn nach dem close() in stop() zu, channel.ts:196-197 gegen 228-231)",
  },
  async () => {
    const fx = await makeEmailFixture();
    const h = hostRec();
    const rec = recordingConnect();
    const ch = fx.make(false, { connect: rec.connect });
    try {
      const starting = ch.start(h.host);
      const stopping = ch.stop();
      await Promise.allSettled([starting, stopping]);
      assert.equal(rec.sockets.length, 1, "the racing start still opened its IMAP connection");
      assert.ok(rec.sockets.every((s) => s.destroyed), "stop() has resolved, so no IMAP connection may stay open");
    } finally {
      await ch.stop();
      for (const s of rec.sockets) s.destroy(); // the leak must not outlive the test
      await fx.dispose();
    }
  },
);
