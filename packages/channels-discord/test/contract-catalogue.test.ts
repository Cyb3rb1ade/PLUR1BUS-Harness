import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordApiError, type DiscordChannel, type DiscordDeps } from "../src/index.ts";
import { makeEnv, started, type Env } from "./helpers/env.ts";
import { drive } from "./helpers/fake-clock.ts";
import { DM_CHANNEL, DM_USER, GUILD_CHANNEL, TOKEN, cdnAwareFetch, snowflake } from "./helpers/fake-discord.ts";

// Contract catalogue for the Discord channel (packages/core/src/channels/types.ts), mirroring the Telegram and Slack harnesses.
//
// Transport mapping. Telegram long-polls; Discord has no poll. Its inbound path is a gateway WebSocket (the "gateway read") and
// its outbound path is REST with bounded retries. So "polling recovers" is proven as "the gateway reconnects and a later
// MESSAGE_CREATE reaches host.receive", and "transient 5xx / 429" is proven on the REST calls start() and send() make.
// Everything runs on the in-process fakes: virtual time (FakeClock, whose parked sleeps are the "hold" seam that lets a test
// inspect the channel while its loop is paused), the scripted gateway and the loopback REST stand-in. No real sleeping.

let seq = 0;
const nextId = () => snowflake(++seq + 90_000);

function dm(content: string, over: Record<string, unknown> = {}) {
  return {
    id: nextId(),
    type: 0,
    channel_id: DM_CHANNEL,
    author: { id: DM_USER },
    content,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    mentions: [],
    attachments: [],
    ...over,
  };
}

/** Resolves once `pred` holds; re-polled on a 1 ms timer because fake-side state raises no host event. Guard only fires on failure. */
async function until(what: string, pred: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise<void>((r) => setTimeout(r, 1));
  }
}

const healthy = (ch: DiscordChannel) => async () => (await ch.health()).ok;

/** Loses the gateway connection, then lets the (virtual) backoff elapse until socket number `sockets` has completed its handshake. */
async function reconnected(e: Env, ch: DiscordChannel, sockets: number): Promise<void> {
  await e.clock.flush();
  await e.clock.advance(5000);
  // FakeGateway.whenReady() is sticky after the first READY, so wait on the channel's own view instead.
  await until(`socket #${sockets} is up`, async () => e.gateway.sockets.length === sockets && (await ch.health()).ok);
}

const errText = (list: unknown[]) => list.map((f) => (f instanceof Error ? f.message : String(f)));

/** Runs `body` with a started-or-not channel and always stops it before the loopback server closes (a closed server would turn an in-flight fetch into a spurious rejection). */
async function withChannel(
  body: (e: Env, ch: DiscordChannel) => Promise<void>,
  extra: (e: Env) => Partial<DiscordDeps> = () => ({}),
): Promise<void> {
  const e = await makeEnv();
  const ch = e.channel({}, extra(e));
  try {
    await body(e, ch);
  } finally {
    await ch.stop();
    await e.close();
  }
}

/** point g: a listener installed before the body and removed in finally; asserts nothing leaked once the event loop has drained. */
async function noUnhandledRejection(body: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const onRejection = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    await body();
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
    assert.deepEqual(errText(unhandled), [], "no unhandled promise rejection");
  } finally {
    process.off("unhandledRejection", onRejection);
  }
}

/** A fetch seam that parks requests whose URL contains `match` until the request's signal aborts (a REST call or a CDN download in flight). */
function parkingFetch(e: Env, net: { match: string | undefined; inflight: number }): typeof fetch {
  const real = cdnAwareFetch(e.rest);
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (net.match === undefined || !url.includes(net.match)) return real(input, init);
    net.inflight += 1;
    return new Promise<Response>((_, reject) => {
      const abort = () => reject(new DOMException("This operation was aborted", "AbortError"));
      if (init?.signal?.aborted) return abort();
      init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
}

// ---- a) start resolves, health reports ok ----------------------------------------------------------------------------

// Overlaps channel.test.ts:43 ("health follows the connection") and contract-suite.test.ts "starts idempotently, reports healthy…".
// New here: health is ok the moment start() resolves, without a further wait on the gateway (start gates on READY).
test("a) start resolves and health reports ok immediately", async () => {
  await withChannel(async (e, ch) => {
    assert.deepEqual(await ch.health(), { ok: false, detail: "stopped" }, "not healthy before start");
    await ch.start(e.host);
    assert.deepEqual(await ch.health(), { ok: true, detail: "connected" });
    assert.equal(e.rest.callsOf("GET", "/api/v10/users/@me").length, 1);
    assert.equal(e.gateway.sockets.length, 1);
    assert.equal(e.failures.length, 0);
  });
});

// ---- b) stop is idempotent ---------------------------------------------------------------------------------------------

// Overlaps channel.test.ts:43 (two sequential stops). New here: the second stop does nothing observable (no second "stopped" line).
test("b) stop is idempotent: a second stop does not throw and does nothing", async () => {
  await withChannel(async (e, ch) => {
    await started(e, ch);
    await ch.stop();
    const linesAfterFirst = e.logs.length;
    await ch.stop();
    assert.equal(e.logs.length, linesAfterFirst, "second stop logs nothing");
    assert.deepEqual(await ch.health(), { ok: false, detail: "stopped" });
    assert.equal(e.gateway.sockets[0]!.closed?.code, 4000, "stop closes the gateway with the resumable code");
  });
});

test("b) two stops issued concurrently both settle", async () => {
  await withChannel(async (e, ch) => {
    await started(e, ch);
    await Promise.all([ch.stop(), ch.stop()]);
    assert.deepEqual(await ch.health(), { ok: false, detail: "stopped" });
  });
});

// No existing test stops a channel that never started.
test("b) stop on a channel that never started does not throw and touches nothing", async () => {
  await withChannel(async (e, ch) => {
    await ch.stop();
    await Promise.all([ch.stop(), ch.stop()]);
    assert.deepEqual(await ch.health(), { ok: false, detail: "stopped" });
    assert.equal(e.rest.calls.length, 0);
    assert.equal(e.gateway.sockets.length, 0);
    assert.equal(e.logs.length, 0, "no 'stopped' line for a channel that was not running");
  });
});

// ---- c) send after stop is rejected -----------------------------------------------------------------------------------

// Overlaps channel.test.ts:476, which only covers sending before the first start.
test("c) send after stop is rejected with a defined error and nothing reaches the platform", async () => {
  await withChannel(async (e, ch) => {
    await started(e, ch);
    // Control: the same send succeeds while started, so the rejection below is about the stopped state.
    await ch.send({ chatId: GUILD_CHANNEL, text: "before stop" });
    assert.deepEqual(
      e.rest.messages.map((m) => m.content),
      ["before stop"],
    );
    await ch.stop();
    const callsBefore = e.rest.calls.length;
    const socketsBefore = e.gateway.sockets.length;
    await assert.rejects(ch.send({ chatId: GUILD_CHANNEL, text: "after stop" }), /discord channel is not started/);
    assert.equal(e.rest.calls.length, callsBefore, "no REST request was made");
    assert.deepEqual(
      e.rest.messages.map((m) => m.content),
      ["before stop"],
    );
    assert.equal(e.gateway.sockets.length, socketsBefore, "no reconnect either");
  });
});

// ---- d) an inbound message reaches host.receive exactly once ----------------------------------------------------------

// Overlaps channel.test.ts:326, which awaits between the two copies. Here both copies are dispatched in one tick, so both are
// queued on the inbound chain before either is processed (the analogue of "one getUpdates batch carries both").
test("d) a message reaches host.receive exactly once when the same MESSAGE_CREATE is delivered twice back to back", async () => {
  await withChannel(async (e, ch) => {
    await started(e, ch);
    const dup = dm("once");
    e.gateway.dispatch("MESSAGE_CREATE", dup);
    e.gateway.dispatch("MESSAGE_CREATE", dup);
    e.gateway.dispatch("MESSAGE_CREATE", dm("sentinel"));
    await ch.idle();
    assert.deepEqual(
      (e.received as { text: string }[]).map((m) => m.text),
      ["once", "sentinel"],
    );
    const first = e.received[0] as { channel: string; chatId: string; chatKind: string; messageId: string };
    assert.equal(first.messageId, dup.id);
    assert.equal(first.chatId, DM_CHANNEL);
    assert.equal(first.channel, "discord");
    assert.equal(first.chatKind, "direct");
  });
});

// A RESUME replays events on a new socket; a message already delivered before the loss must not be delivered again.
test("d) a message replayed on the resumed gateway session is not delivered a second time", async () => {
  await withChannel(async (e, ch) => {
    await started(e, ch);
    const dup = dm("once");
    e.gateway.dispatch("MESSAGE_CREATE", dup);
    await ch.idle();
    assert.equal(e.received.length, 1);
    e.gateway.latest.remoteClose(1006);
    await reconnected(e, ch, 2);
    assert.equal(e.gateway.sockets[1]!.sent[0]!.op, 6, "the second connection resumes the session (op 6)");
    e.gateway.dispatch("MESSAGE_CREATE", dup);
    e.gateway.dispatch("MESSAGE_CREATE", dm("sentinel"));
    await ch.idle();
    assert.deepEqual(
      (e.received as { text: string }[]).map((m) => m.text),
      ["once", "sentinel"],
    );
  });
});

// ---- e) final auth failure -> host.fail; transient failures do not --------------------------------------------------

// Overlaps channel.test.ts:112 (4004) and gateway.test.ts:173 (all fatal codes at the Gateway level). 4013 and 4014 are the
// close codes docs/channels/discord.md names as "stops with host.fail and no retry".
for (const code of [4004, 4013, 4014]) {
  test(`e) a final gateway close ${code} calls host.fail exactly once, never retries and marks the channel unhealthy`, async () => {
    await withChannel(async (e, ch) => {
      await started(e, ch);
      e.gateway.latest.remoteClose(code);
      await e.clock.flush();
      await e.clock.advance(120_000);
      assert.equal(e.failures.length, 1);
      assert.match(errText(e.failures)[0]!, new RegExp(`close ${code}`));
      assert.equal(e.gateway.sockets.length, 1, "no reconnect after a fatal close");
      assert.deepEqual(await ch.health(), { ok: false, detail: "authentication failed" });
      assert.ok(!JSON.stringify([errText(e.failures), e.logs]).includes(TOKEN), "token not in failure or logs");
    });
  });
}

// Pins where the two kinds of auth failure surface. A 401 on the identity call during start() rejects start() and never reaches
// host.fail (overlaps channel.test.ts:101). A 401 on a later REST call rejects that call with kind "unauthorized" and leaves the
// liveness verdict to the gateway: a revoked token ends in a fatal close (previous test), so host.fail has exactly one source.
test("e) a REST 401 rejects the call with unauthorized and does not itself call host.fail", async () => {
  await withChannel(async (e, ch) => {
    e.rest.fail("GET /api/v10/users/@me", { status: 401, body: { message: "401: Unauthorized", code: 0 } });
    await assert.rejects(ch.start(e.host), (err: unknown) => err instanceof DiscordApiError && err.kind === "unauthorized");
    assert.equal(e.failures.length, 0, "start rejection is the signal, not host.fail");
    assert.equal(e.gateway.sockets.length, 0);
    await started(e, ch);
    e.rest.fail("POST /api/v10/channels/", { status: 401, body: { message: "401: Unauthorized", code: 0 } });
    await assert.rejects(ch.send({ chatId: GUILD_CHANNEL, text: "x" }), (err: unknown) => err instanceof DiscordApiError && err.kind === "unauthorized");
    assert.equal(e.failures.length, 0);
    assert.equal(e.rest.callsOf("POST", "/api/v10/channels/").length, 1, "401 is not retried");
  });
});

// A fatal close while start() is still waiting for READY: start() rejects and host.fail is called as well (one failure), because
// the host is bound before the gateway runs. The registry ignores the late callback once the start has failed (gen guard).
// health() keeps the "authentication failed" detail after such a failed start (the fatal flag is only reset by the next start).
test("e) a fatal close during start rejects start and reports host.fail once", async () => {
  const e = await makeEnv();
  e.gateway.auto = false; // the scripted server answers by hand so the close can land on IDENTIFY
  const ch = e.channel();
  try {
    const outcome = ch.start(e.host).then(
      () => "resolved" as const,
      (err: unknown) => err,
    );
    await until("socket dialled", () => e.gateway.sockets.length === 1);
    const s = e.gateway.latest;
    s.server({ op: 10, d: { heartbeat_interval: 41_250 } });
    await until("identify sent", () => s.sent.some((f) => f.op === 2));
    s.remoteClose(4014);
    const err = await outcome;
    assert.ok(err instanceof DiscordApiError && err.kind === "unauthorized", String(err));
    assert.equal(e.failures.length, 1);
    assert.match(errText(e.failures)[0]!, /close 4014/);
    assert.deepEqual(await ch.health(), { ok: false, detail: "authentication failed" });
  } finally {
    await ch.stop();
    await e.close();
  }
});

// Transient REST failures at start: a 503 on the identity call and a 429 on the command registration are retried after the
// backoff / the clamped Retry-After. start() still resolves, host.fail is silent, and a later inbound message is delivered.
// Overlaps channel.test.ts:554 (429 on send) and rest.test.ts:154 (5xx is retried); virtual time via `drive`.
test("e) transient 503 and 429 while starting do not call host.fail; start recovers and a later message is delivered", async () => {
  await withChannel(async (e, ch) => {
    e.rest.fail("GET /api/v10/users/@me", { status: 503, body: {} });
    e.rest.fail("PUT /api/v10/applications/", { status: 429, body: { retry_after: 0.2 } });
    const starting = ch.start(e.host);
    await drive(e.clock, starting);
    await starting;
    assert.equal(e.failures.length, 0, "transient errors must not fail the channel");
    // 503: first retry step (1 s with jitter fixed at 0.5). 429: 0.2 s is raised to the 1 s floor.
    assert.deepEqual(
      e.clock.slept.filter((ms) => ms < 5000),
      [1000, 1000],
    );
    assert.equal(e.rest.callsOf("GET", "/api/v10/users/@me").length, 2);
    assert.equal(e.rest.callsOf("PUT", "/api/v10/applications/").length, 2);
    assert.equal((await ch.health()).ok, true);
    e.gateway.dispatch("MESSAGE_CREATE", dm("after transient errors"));
    await ch.idle();
    assert.deepEqual(
      (e.received as { text: string }[]).map((m) => m.text),
      ["after transient errors"],
    );
  });
});

// Transient REST failures on send. Only 429 and 502/503/504 are retried (api.ts); a plain 500 surfaces to the caller as kind
// "http" instead of being retried, because Discord may already have applied the POST. None of them touches host.fail, and the
// next send works, which is what "recovers" means for an outbound path.
test("e) transient 503, 429 and 500 on send never call host.fail; the channel keeps working", async () => {
  await withChannel(async (e, ch) => {
    await started(e, ch);
    e.rest.fail("POST /api/v10/channels/", { status: 503, body: {} });
    e.rest.fail("POST /api/v10/channels/", { status: 429, body: { retry_after: 0.2 } });
    const retried = ch.send({ chatId: GUILD_CHANNEL, text: "after 503 and 429" });
    await drive(e.clock, retried);
    await retried;
    assert.deepEqual(
      e.rest.messages.map((m) => m.content),
      ["after 503 and 429"],
    );
    e.rest.fail("POST /api/v10/channels/", { status: 500, body: { message: "Internal Server Error", code: 0 } });
    await assert.rejects(
      ch.send({ chatId: GUILD_CHANNEL, text: "hit by 500" }),
      (err: unknown) => err instanceof DiscordApiError && err.kind === "http" && err.status === 500,
    );
    await ch.send({ chatId: GUILD_CHANNEL, text: "after 500" });
    assert.deepEqual(
      e.rest.messages.map((m) => m.content),
      ["after 503 and 429", "after 500"],
    );
    assert.equal(e.failures.length, 0);
    assert.deepEqual(await ch.health(), { ok: true, detail: "connected" });
  });
});

// Transient gateway failures: a retryable close backs off, reconnects (resume for 1006, a fresh identify for 4009) and a
// message sent afterwards is delivered. host.fail stays silent. Overlaps channel.test.ts:126 and gateway.test.ts:186, which do
// not prove delivery after recovery.
for (const code of [1006, 4009]) {
  test(`e) a transient gateway close ${code} does not call host.fail; the reconnect delivers a later message`, async () => {
    await withChannel(async (e, ch) => {
      await started(e, ch);
      e.gateway.latest.remoteClose(code);
      await reconnected(e, ch, 2);
      assert.equal(e.failures.length, 0);
      assert.equal(e.gateway.sockets[1]!.sent[0]!.op, code === 4009 ? 2 : 6, "4009 loses the session, 1006 keeps it");
      e.gateway.dispatch("MESSAGE_CREATE", dm("after the reconnect"));
      await ch.idle();
      assert.deepEqual(
        (e.received as { text: string }[]).map((m) => m.text),
        ["after the reconnect"],
      );
    });
  });
}

// ---- f) health is not ok after the connection is lost -----------------------------------------------------------------

// docs/channels/discord.md does not define health(); it documents reconnect with backoff (sections 10 and 11). The code reports
// {ok:false, detail:"reconnecting"} while the channel is started but the gateway is down (channel.ts health()). Unlike Telegram
// this is not a gap: Gateway.finish() clears the connected flag on the close event. Overlaps channel.test.ts:126.
test("f) health is not ok while the gateway reconnects, and ok again once it is back", async () => {
  await withChannel(async (e, ch) => {
    await started(e, ch);
    assert.equal((await ch.health()).ok, true);
    e.gateway.latest.remoteClose(1006);
    await e.clock.flush();
    // The loop is parked in its backoff sleep on the fake clock, so the lost state can be inspected without racing it.
    assert.ok(e.clock.pending >= 1);
    assert.equal(e.gateway.sockets.length, 1, "still parked");
    assert.deepEqual(await ch.health(), { ok: false, detail: "reconnecting" });
    assert.equal(e.failures.length, 0, "a lost connection is retried, not failed");
    await reconnected(e, ch, 2);
    assert.deepEqual(await ch.health(), { ok: true, detail: "connected" });
  });
});

// Connection loss modelled as a transport fault: every new socket attempt fails (the factory throws), instead of closing servers.
test("f) health stays not ok while every reconnect attempt fails at the transport, and recovers when the network is back", async () => {
  const net = { down: false };
  await withChannel(
    async (e, ch) => {
      await started(e, ch);
      net.down = true;
      e.gateway.latest.remoteClose(1006);
      await e.clock.flush();
      await e.clock.advance(5000); // several failed attempts on growing backoff steps
      assert.equal(e.gateway.sockets.length, 1, "no socket could be opened");
      assert.ok(e.clock.pending >= 1, "the loop is parked in backoff");
      assert.deepEqual(await ch.health(), { ok: false, detail: "reconnecting" });
      assert.equal(e.failures.length, 0);
      net.down = false;
      await e.clock.advance(60_000);
      await until("recovered", healthy(ch));
      assert.equal(e.gateway.sockets.length, 2);
      e.gateway.dispatch("MESSAGE_CREATE", dm("network is back"));
      await ch.idle();
      assert.equal(e.received.length, 1);
    },
    (e) => ({
      webSocket: (url: string) => {
        if (net.down) throw new Error("network unreachable");
        return e.gateway.factory(url);
      },
    }),
  );
});

// ---- g) stop leaves no unhandled promise rejection ----------------------------------------------------------------------

// Overlaps gateway.test.ts:228 (abort ends run()); here at channel level and watching process-wide rejections.
test("g) stop while the gateway read is pending (connected, idle) leaves no unhandled rejection", async () => {
  await noUnhandledRejection(() =>
    withChannel(async (e, ch) => {
      await started(e, ch);
      await ch.stop();
      await e.clock.flush();
      assert.equal(e.gateway.latest.closed?.code, 4000);
      assert.deepEqual(await ch.health(), { ok: false, detail: "stopped" });
    }),
  );
});

test("g) stop while the loop is parked in reconnect backoff leaves no unhandled rejection", async () => {
  await noUnhandledRejection(() =>
    withChannel(async (e, ch) => {
      await started(e, ch);
      e.gateway.latest.remoteClose(1006);
      await e.clock.flush();
      assert.ok(e.clock.pending >= 1);
      await ch.stop(); // the abort resolves the parked sleep, the loop sees the abort and exits
      await e.clock.flush();
      assert.equal(e.gateway.sockets.length, 1, "no reconnect after stop");
      assert.deepEqual(await ch.health(), { ok: false, detail: "stopped" });
    }),
  );
});

test("g) stop issued while start is still running settles without an unhandled rejection", async () => {
  await noUnhandledRejection(() =>
    withChannel(async (e, ch) => {
      const starting = ch.start(e.host);
      const stopping = ch.stop();
      const [s, p] = await Promise.allSettled([starting, stopping]);
      assert.equal(p.status, "fulfilled");
      assert.ok(s.status === "rejected" && s.reason instanceof DiscordApiError && s.reason.kind === "aborted", JSON.stringify(s));
      assert.equal(e.rest.calls.length, 0, "the aborted start reached the platform with nothing");
      assert.equal(e.gateway.sockets.length, 0);
      assert.deepEqual(await ch.health(), { ok: false, detail: "stopped" });
    }),
  );
});

test("g) stop while a REST send is in flight rejects that send as aborted, with no unhandled rejection", async () => {
  const net: { match: string | undefined; inflight: number } = { match: undefined, inflight: 0 };
  await noUnhandledRejection(() =>
    withChannel(
      async (e, ch) => {
        await started(e, ch);
        net.match = "/messages";
        const sending = ch.send({ chatId: GUILD_CHANNEL, text: "in flight" }).then(
          () => "sent" as const,
          (err: unknown) => err,
        );
        await until("request parked", () => net.inflight === 1);
        await ch.stop();
        const err = await sending;
        assert.ok(err instanceof DiscordApiError && err.kind === "aborted", String(err));
        assert.equal(e.rest.messages.length, 0);
      },
      (e) => ({ fetch: parkingFetch(e, net) }),
    ),
  );
});

test("g) stop while a send waits out a 429 Retry-After rejects it as aborted, with no unhandled rejection", async () => {
  await noUnhandledRejection(() =>
    withChannel(async (e, ch) => {
      await started(e, ch);
      e.rest.fail("POST /api/v10/channels/", { status: 429, body: { retry_after: 45 } });
      const sending = ch.send({ chatId: GUILD_CHANNEL, text: "rate limited" }).then(
        () => "sent" as const,
        (err: unknown) => err,
      );
      // 45 s is distinct from every other sleep the channel schedules (30 s READY wait, 20 s hello timeout, 41.25 s heartbeat).
      await until("retry wait parked", () => e.clock.slept.includes(45_000));
      await ch.stop();
      const err = await sending;
      assert.ok(err instanceof DiscordApiError && err.kind === "aborted", String(err));
      assert.equal(e.rest.callsOf("POST", "/api/v10/channels/").length, 1, "no retry after stop");
      assert.equal(e.rest.messages.length, 0);
    }),
  );
});

test("g) stop while an inbound attachment download is in flight settles without an unhandled rejection", async () => {
  const net: { match: string | undefined; inflight: number } = { match: undefined, inflight: 0 };
  await noUnhandledRejection(() =>
    withChannel(
      async (e, ch) => {
        await started(e, ch);
        net.match = "cdn.discordapp.com";
        const attachment = { url: "https://cdn.discordapp.com/attachments/1/2/pic.png", size: 4, filename: "pic.png", content_type: "image/png" };
        e.gateway.dispatch("MESSAGE_CREATE", dm("look", { attachments: [attachment] }));
        await until("download parked", () => net.inflight === 1);
        await ch.stop(); // stop waits for the inbound chain, which the abort lets finish
        assert.equal(e.received.length, 0, "the interrupted message is dropped, not half-delivered");
      },
      (e) => ({ fetch: parkingFetch(e, net) }),
    ),
  );
});

// The gateway never answers, so start() is parked waiting for the first READY. stop() must not have to wait for that: it aborts the
// connection and should settle at once. It does not: #start() races READY against a sleep on its own `timer.signal` (channel.ts:239-240),
// which stop()'s abort does not reach, and stop() awaits the pending start (channel.ts:262). So stop() blocks until READY_WAIT_MS
// (30 s) has elapsed; on the fake clock, which only moves when the test advances it, it never settles. The test lets the clock run
// afterwards so nothing is left pending. The 1 s guard only fires on the failing path.
test(
  "g) stop while start waits for the first READY settles promptly instead of waiting out READY_WAIT_MS",
  {
    todo:
      "KNOWN GAP: channels-discord DiscordChannel.stop: erwartet, dass stop() während start() auf das erste READY wartet sofort abschließt, tatsächlich blockiert es, bis READY_WAIT_MS (30 s) abgelaufen ist (channel.ts:239-240 wartet auf timer.signal statt auf das Stop-Signal)",
  },
  async () => {
    const e = await makeEnv();
    e.gateway.auto = false; // the scripted server never answers HELLO
    const ch = e.channel();
    let promptly = false;
    try {
      const starting = ch.start(e.host).catch(() => undefined);
      await until("socket dialled", () => e.gateway.sockets.length === 1);
      const stopping = ch.stop().then(() => true);
      let guard: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<boolean>((resolve) => {
        guard = setTimeout(() => resolve(false), 1000);
      });
      promptly = await Promise.race([stopping, timedOut]);
      clearTimeout(guard);
      await e.clock.advance(31_000); // releases the parked READY wait whichever way the race went
      await Promise.all([starting, stopping]);
    } finally {
      await ch.stop();
      await e.close();
    }
    assert.ok(promptly, "stop() did not settle while start() was waiting for READY");
  },
);
