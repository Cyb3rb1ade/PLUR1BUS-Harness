import assert from "node:assert/strict";
import { test } from "node:test";
import { makeContractHarness } from "./helpers/contract.ts";
import { textUpdate } from "./helpers/fake-telegram.ts";

// Contract catalogue for the Telegram channel (packages/core/src/channels/types.ts), mirroring the Slack harness.

test("contract harness drives the channel end to end against the fake Bot API", async () => {
  const h = await makeContractHarness();
  try {
    assert.equal(h.name, "telegram");
    assert.equal((h.manifest as { name: string }).name, "telegram");
    await h.channel.start(h.host);
    h.deliver("hello from harness");
    await h.waitFor(() => h.received.length === 1, "inbound message");
    await h.channel.send({ chatId: "42", text: "reply" });
    assert.deepEqual(h.sentTexts(), ["reply"]);
  } finally {
    await h.dispose();
  }
});

test("a) start resolves and health reports ok", async () => {
  const h = await makeContractHarness();
  try {
    assert.deepEqual(await h.channel.health(), { ok: false }, "not healthy before start");
    await h.channel.start(h.host);
    assert.deepEqual(await h.channel.health(), { ok: true });
  } finally {
    await h.dispose();
  }
});

test("b) stop is idempotent: a second stop does not throw", async () => {
  const h = await makeContractHarness();
  try {
    await h.channel.start(h.host);
    await h.channel.stop();
    await h.channel.stop();
    assert.deepEqual(await h.channel.health(), { ok: false });
  } finally {
    await h.dispose();
  }
});

test("b) stop on a channel that never started does not throw", async () => {
  const h = await makeContractHarness();
  try {
    await h.channel.stop();
    await h.channel.stop();
    assert.deepEqual(await h.channel.health(), { ok: false });
  } finally {
    await h.dispose();
  }
});

test("c) send after stop is rejected with a defined error and nothing reaches the platform", async () => {
  const h = await makeContractHarness();
  try {
    await h.channel.start(h.host);
    // Control: the same send succeeds while started, so the rejection below is about the stopped state.
    await h.channel.send({ chatId: "42", text: "before stop" });
    assert.deepEqual(h.sentTexts(), ["before stop"]);
    await h.channel.stop();
    await assert.rejects(h.channel.send({ chatId: "42", text: "after stop" }), /telegram channel is not started/);
    assert.deepEqual(h.sentTexts(), ["before stop"]);
  } finally {
    await h.dispose();
  }
});

test("d) an update is handed to host.receive exactly once, even when it is delivered twice in one batch", async () => {
  const h = await makeContractHarness();
  try {
    // Both copies of update 7 are queued before start, so one getUpdates batch carries them together.
    h.fake.push(textUpdate(7, 42, "once"));
    h.fake.push(textUpdate(7, 42, "once"));
    h.fake.push(textUpdate(8, 42, "sentinel"));
    await h.channel.start(h.host);
    await h.waitFor(() => h.received.some((m) => m.text === "sentinel"), "sentinel delivered");
    assert.deepEqual(
      h.received.map((m) => m.text),
      ["once", "sentinel"],
    );
    assert.equal(h.received[0]!.messageId, "70");
    assert.equal(h.received[0]!.chatId, "42");
    assert.equal(h.received[0]!.channel, "telegram");
  } finally {
    await h.dispose();
  }
});

test("d) the next poll asks for the offset after the last delivered update", async () => {
  const h = await makeContractHarness();
  try {
    h.fake.push(textUpdate(7, 42, "one"));
    await h.channel.start(h.host);
    await h.waitFor(() => h.received.length === 1, "first delivery");
    await h.waitFor(() => h.fake.callsOf("getUpdates").some((c) => c.body.offset === 8), "offset 8 requested");
    assert.equal(h.received.length, 1);
  } finally {
    await h.dispose();
  }
});

test("e) a final 401 calls host.fail exactly once and marks the channel unhealthy", async () => {
  const h = await makeContractHarness();
  try {
    h.fake.failNext("getUpdates", 401, { ok: false, error_code: 401, description: "Unauthorized" });
    await h.channel.start(h.host);
    await h.waitFor(() => h.failures.length === 1, "host.fail");
    assert.equal(h.failures.length, 1);
    assert.equal(h.received.length, 0);
    assert.deepEqual(await h.channel.health(), { ok: false });
  } finally {
    await h.dispose();
  }
});

test("e) transient 500 and 429 do not call host.fail; polling backs off and recovers", async () => {
  const h = await makeContractHarness();
  try {
    h.fake.failNext("getUpdates", 500, { ok: false, error_code: 500, description: "Internal" });
    h.fake.failNext("getUpdates", 429, {
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 2",
      parameters: { retry_after: 2 },
    });
    await h.channel.start(h.host);
    h.deliver("after transient errors");
    await h.waitFor(() => h.received.length === 1, "recovered delivery");
    assert.equal(h.failures.length, 0, "transient errors must not fail the channel");
    // 500 backs off by the base step (1 s with jitter fixed at 0.5); 429 waits the server's retry_after (2 s).
    assert.deepEqual(h.sleeps, [1000, 2000]);
    assert.ok(h.logs.some((l) => l.event === "channel.telegram.poll-failed" && l.attrs.kind === "http"));
    assert.ok(h.logs.some((l) => l.event === "channel.telegram.poll-failed" && l.attrs.kind === "rate-limited"));
  } finally {
    await h.dispose();
  }
});

test(
  "f) health is not ok after the connection is lost",
  {
    todo:
      "KNOWN GAP: channels-telegram TelegramChannel.health: erwartet ok=false nach Verbindungsverlust, tatsächlich ok=true (#healthy wird im Poll-Backoff nur bei 401/403 gesetzt)",
  },
  async () => {
    const h = await makeContractHarness();
    try {
      h.setHoldSleeps(true);
      await h.channel.start(h.host);
      // Lose the connection before the next poll; the in-flight long poll returns this sentinel first.
      h.setConnectionDown(true);
      h.deliver("sentinel before loss");
      await h.waitFor(() => h.received.length === 1, "sentinel delivered");
      // The next getUpdates fails at transport level and the loop parks in backoff.
      await h.waitFor(() => h.sleeps.length === 1, "backoff after connection loss");
      assert.equal(h.failures.length, 0);
      assert.deepEqual(await h.channel.health(), { ok: false });
    } finally {
      await h.dispose();
    }
  },
);

test("g) stop does not leak an unhandled rejection while a long poll is in flight", async () => {
  const h = await makeContractHarness();
  const unhandled: unknown[] = [];
  const onRejection = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    await h.channel.start(h.host);
    h.deliver("in flight");
    await h.waitFor(() => h.received.length === 1, "delivery");
    await h.channel.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onRejection);
    await h.dispose();
  }
});

test("g) stop issued while start is still running settles without an unhandled rejection", async () => {
  const h = await makeContractHarness();
  const unhandled: unknown[] = [];
  const onRejection = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const starting = h.channel.start(h.host);
    const stopping = h.channel.stop();
    await Promise.allSettled([starting, stopping]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.deepEqual(await h.channel.health(), { ok: false });
  } finally {
    process.off("unhandledRejection", onRejection);
    await h.dispose();
  }
});
