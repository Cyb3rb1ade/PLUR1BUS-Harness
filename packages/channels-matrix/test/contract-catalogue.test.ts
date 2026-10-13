import assert from "node:assert/strict";
import { test } from "node:test";
import { FAKE_TOKEN, ROOM } from "./helpers/fake-matrix.ts";
import { makeCatalogueHarness, type CatalogueHarness } from "./helpers/catalogue.ts";

// Contract catalogue for the Matrix channel (packages/core/src/channels/types.ts), mirroring the Telegram catalogue.
// Points a) to g) are expressed against the in-process homeserver fake. No test waits on a wall clock: backoff sleeps go
// through an injected seam, and the sync loop is released by queued events. Several existing tests overlap; each test
// names the one it overlaps and only adds what that one does not pin (host.receive, host.fail, injected sleeps).

const SYNC = "/_matrix/client/v3/sync";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Runs `run` with an unhandledRejection listener installed, then lets the event loop turn twice before asserting. */
async function expectNoUnhandledRejection(run: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const onRejection = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    await run();
    await tick();
    await tick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
}

async function withHarness(opts: { resumed?: boolean }, body: (h: CatalogueHarness) => Promise<void>): Promise<void> {
  const h = await makeCatalogueHarness(opts);
  try {
    await body(h);
  } finally {
    await h.dispose();
  }
}

// ----------------------------------------------------------------------------------------------------------- a) start

// Overlaps lifecycle.test.ts "start performs whoami, initial sync, persists the token and reports healthy ...".
for (const resumed of [false, true]) {
  test(`a) start resolves and health reports ok (${resumed ? "resumed from a stored sync position" : "cold first start"})`, async () => {
    await withHarness({ resumed }, async (h) => {
      assert.deepEqual(await h.channel.health(), { ok: false }, "not healthy before start");
      await h.channel.start(h.host);
      assert.deepEqual(await h.channel.health(), { ok: true });
      await h.fake.waitIdle();
      assert.deepEqual(await h.channel.health(), { ok: true }, "still healthy once the loop is parked on its first long poll");
      assert.equal(h.failures.length, 0);
    });
  });
}

// ------------------------------------------------------------------------------------------------------------ b) stop

// Overlaps lifecycle.test.ts "stop and start are idempotent and restart works".
test("b) stop is idempotent: a second stop does not throw", async () => {
  await withHarness({}, async (h) => {
    await h.start();
    await h.channel.stop();
    await h.channel.stop();
    assert.deepEqual(await h.channel.health(), { ok: false });
  });
});

// New: lifecycle.test.ts never stops a channel that was not started.
test("b) stop on a channel that never started does not throw and makes no request", async () => {
  await withHarness({}, async (h) => {
    await h.channel.stop();
    await h.channel.stop();
    assert.deepEqual(await h.channel.health(), { ok: false });
    assert.equal(h.fake.calls.length, 0);
  });
});

// ------------------------------------------------------------------------------------------------------------- c) send

// Overlaps outbound.test.ts "sending to a non-allowlisted room, a malformed id, or before start is refused", which has no control send
// and does not check what reached the homeserver.
test("c) send after stop is rejected with a defined error and nothing reaches the homeserver", async () => {
  await withHarness({}, async (h) => {
    await h.start();
    // Control: the same send succeeds while started, so the rejection below is about the stopped state.
    await h.channel.send({ chatId: ROOM, text: "before stop" });
    assert.deepEqual(h.sentTexts(), ["before stop"]);
    await h.channel.stop();
    const callsAfterStop = h.fake.calls.length;
    await assert.rejects(h.channel.send({ chatId: ROOM, text: "after stop" }), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.message, "matrix channel is not started");
      return true;
    });
    assert.deepEqual(h.sentTexts(), ["before stop"]);
    assert.equal(h.fake.calls.length, callsAfterStop, "the rejected send made no request at all");
  });
});

// ------------------------------------------------------------------------------------------------- d) exactly-once receive

// Overlaps inbound.test.ts "duplicate event ids are delivered once", which counts the onMessage handler and never one batch
// carrying both copies; this one asserts on host.receive.
test("d) an event is handed to host.receive exactly once when one sync batch carries it twice", async () => {
  await withHarness({}, async (h) => {
    // Queued before start with a stored sync position, so the first poll returns one batch with both copies. (A cold start would
    // swallow them: the initial sync records timeline ids and discards the events.)
    const dupe = h.event("once", "$dupe-in-one-batch");
    h.fake.deliverNoWait(ROOM, [dupe, dupe, h.event("sentinel", "$sentinel-one")]);
    await h.start();
    await h.waitFor(() => h.received.some((m) => m.text === "sentinel"), "sentinel delivered");
    // Proof the duplicate was on the wire: one answer carried the same event id twice.
    assert.ok(h.syncBatches().some((b) => b.filter((id) => id === "$dupe-in-one-batch").length === 2));
    assert.deepEqual(
      h.received.map((m) => m.text),
      ["once", "sentinel"],
    );
    assert.equal(h.received[0]!.messageId, "$dupe-in-one-batch");
    assert.equal(h.received[0]!.channel, "matrix");
    assert.equal(h.received[0]!.chatId, ROOM);
  });
});

test("d) an event is handed to host.receive exactly once when it comes again in a later sync batch", async () => {
  await withHarness({ resumed: false }, async (h) => {
    await h.start();
    const dupe = h.event("once", "$dupe-in-two-batches");
    await h.fake.deliver(ROOM, [dupe]);
    assert.deepEqual(
      h.received.map((m) => m.text),
      ["once"],
    );
    // The homeserver sends the same event id again (the second batch also carries a fresh sentinel so delivery is observable).
    await h.fake.deliver(ROOM, [dupe, h.event("sentinel", "$sentinel-two")]);
    assert.deepEqual(
      h.received.map((m) => m.text),
      ["once", "sentinel"],
    );
    assert.deepEqual(
      h.received.map((m) => m.messageId),
      ["$dupe-in-two-batches", "$sentinel-two"],
    );
    // Proof the duplicate was on the wire: two different answers carried the same event id.
    assert.equal(h.syncBatches().filter((b) => b.includes("$dupe-in-two-batches")).length, 2);
  });
});

// ---------------------------------------------------------------------------------------------------- e) failure handling

// Overlaps lifecycle.test.ts "401 during the sync loop is fatal ...", which waits 100 ms of wall clock.
test("e) a final 401 M_UNKNOWN_TOKEN on /sync calls host.fail once, ends the loop and marks the channel unhealthy", async () => {
  await withHarness({}, async (h) => {
    h.fake.failNext("GET", SYNC, 401, { errcode: "M_UNKNOWN_TOKEN", error: "Unrecognised access token" });
    // Not h.start(): the loop ends instead of parking on a poll, so the harness would wait for an idle that never comes.
    await h.channel.start(h.host);
    await h.waitFor(() => h.failures.length === 1, "host.fail");
    assert.ok(h.failures[0] instanceof Error);
    assert.equal((h.failures[0] as Error).message, "matrix authentication failed");
    assert.ok(!String((h.failures[0] as Error).message).includes(FAKE_TOKEN));
    assert.equal(h.received.length, 0);
    assert.deepEqual(await h.channel.health(), { ok: false });
    assert.equal(h.sleeps.length, 0, "no backoff for an auth failure");
    assert.ok(h.logs.some((l) => l.event === "channel.matrix.auth-failed" && l.level === "error"));
    // No retry storm: an event queued now is never fetched, because the loop has returned.
    h.fake.deliverNoWait(ROOM, [h.event("after the end")]);
    await tick();
    await tick();
    assert.equal(h.fake.syncs.length, 1, "exactly the one failed poll");
    assert.equal(h.received.length, 0);
    assert.equal(h.failures.length, 1, "host.fail is not repeated");
  });
});

// Overlaps lifecycle.test.ts "sync 5xx backs off ..." and "sync 429 waits ...", which use real timeouts and never look at host.receive.
test("e) transient 503 and 429 on /sync do not call host.fail; the loop backs off and a later event is delivered", async () => {
  await withHarness({}, async (h) => {
    h.fake.failNext("GET", SYNC, 503, { errcode: "M_UNKNOWN", error: "busy" });
    h.fake.failNext("GET", SYNC, 429, { errcode: "M_LIMIT_EXCEEDED", error: "slow", retry_after_ms: 3000 });
    // The loop meets both failures, backs off through the injected sleep, and parks on the third poll.
    await h.start();
    assert.equal(h.failures.length, 0, "transient errors must not fail the channel");
    // 503 backs off by the base step (1 s, jitter factor 1.0 at random 0.5); 429 waits the server's retry_after_ms.
    assert.deepEqual(h.sleeps, [1000, 3000]);
    assert.ok(h.logs.some((l) => l.event === "channel.matrix.sync-failed" && l.attrs.kind === "http" && l.attrs.status === 503));
    assert.ok(h.logs.some((l) => l.event === "channel.matrix.sync-failed" && l.attrs.kind === "rate-limited"));
    // Recovery: an event that arrives after the outage reaches the host.
    await h.fake.deliver(ROOM, [h.event("after transient errors")]);
    assert.deepEqual(
      h.received.map((m) => m.text),
      ["after transient errors"],
    );
    assert.equal(h.failures.length, 0);
    assert.deepEqual(await h.channel.health(), { ok: true });
  });
});

// ------------------------------------------------------------------------------------------------- f) connection loss

// docs/channels/matrix.md (sections 10 and 11) only defines 401 as fatal (`host.fail`, the channel stops) and says nothing about what
// health() reports while the homeserver is unreachable. The core contract (channels/types.ts) reserves host.fail for a connection lost for
// good and describes health() as whether the channel is alive; a channel that cannot reach its homeserver and sits in backoff is not.
// This expectation mirrors the Telegram catalogue's gap. The sync loop never clears #healthy for a transport failure.
test(
  "f) health is not ok after the connection is lost",
  {
    todo:
      "KNOWN GAP: channels-matrix MatrixChannel.health: erwartet ok=false nach Verbindungsverlust, tatsächlich ok=true (#healthy wird im Sync-Loop nur bei 401 zurückgesetzt, channel.ts:470)",
  },
  async () => {
    await withHarness({}, async (h) => {
      h.setHoldSleeps(true);
      await h.start();
      // Lose the connection before the next poll; the in-flight long poll returns this sentinel first.
      h.setConnectionDown(true);
      h.fake.deliverNoWait(ROOM, [h.event("sentinel before loss")]);
      await h.waitFor(() => h.received.length === 1, "sentinel delivered");
      // The next /sync fails at transport level and the loop parks in backoff.
      await h.waitFor(() => h.sleeps.length === 1, "backoff after connection loss");
      assert.equal(h.failures.length, 0);
      assert.deepEqual(await h.channel.health(), { ok: false });
    });
  },
);

// Pins what holds today and must keep holding after the gap above is fixed: a lost connection is not fatal (no host.fail),
// the loop keeps retrying, nothing delivered before the loss is replayed, and once the connection is back everything works.
test("f) a lost connection is not fatal: the loop backs off, then recovers and health is ok again", async () => {
  await withHarness({}, async (h) => {
    h.setHoldSleeps(true);
    await h.start();
    h.setConnectionDown(true);
    h.fake.deliverNoWait(ROOM, [h.event("sentinel before loss")]);
    await h.waitFor(() => h.received.length === 1, "sentinel delivered");
    await h.waitFor(() => h.sleeps.length === 1, "backoff after connection loss");
    assert.equal(h.failures.length, 0, "connection loss alone is not a fatal failure");
    assert.ok(h.logs.some((l) => l.event === "channel.matrix.sync-failed" && l.attrs.kind === "network"));
    // Connection back: release the parked backoff; the loop polls again and parks on a long poll.
    h.setConnectionDown(false);
    h.setHoldSleeps(false);
    h.releaseSleeps();
    await h.fake.waitIdle();
    await h.fake.deliver(ROOM, [h.event("after reconnect")]);
    assert.deepEqual(
      h.received.map((m) => m.text),
      ["sentinel before loss", "after reconnect"],
    );
    assert.deepEqual(h.sleeps, [1000]);
    assert.equal(h.failures.length, 0);
    assert.deepEqual(await h.channel.health(), { ok: true });
  });
});

// ------------------------------------------------------------------------------------------------ g) no unhandled rejection

// Overlaps lifecycle.test.ts "stop aborts a held long poll promptly", which does not look at unhandled rejections.
test("g) stop does not leak an unhandled rejection while a long poll is pending", async () => {
  await withHarness({}, async (h) => {
    await expectNoUnhandledRejection(async () => {
      await h.start();
      await h.fake.deliver(ROOM, [h.event("in flight")]);
      assert.equal(h.received.length, 1);
      // start() waited for idle, so the loop is parked on a held long poll right now.
      await h.channel.stop();
      assert.deepEqual(await h.channel.health(), { ok: false });
    });
  });
});

test("g) stop issued while start is still running settles without an unhandled rejection", async () => {
  await withHarness({}, async (h) => {
    await expectNoUnhandledRejection(async () => {
      const starting = h.channel.start(h.host);
      const stopping = h.channel.stop();
      await Promise.allSettled([starting, stopping]);
      assert.deepEqual(await h.channel.health(), { ok: false });
    });
  });
});

test("g) stop while the sync loop is parked in backoff settles without an unhandled rejection", async () => {
  await withHarness({}, async (h) => {
    await expectNoUnhandledRejection(async () => {
      h.setHoldSleeps(true);
      await h.start();
      h.setConnectionDown(true);
      h.fake.deliverNoWait(ROOM, [h.event("sentinel before loss")]);
      await h.waitFor(() => h.sleeps.length === 1, "backoff after connection loss");
      await h.channel.stop();
      assert.deepEqual(await h.channel.health(), { ok: false });
      assert.equal(h.failures.length, 0, "stopping is not a failure");
    });
  });
});
