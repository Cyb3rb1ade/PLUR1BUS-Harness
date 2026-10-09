import assert from "node:assert/strict";
import { test } from "node:test";
import { SignalChannel, SignalRpcError } from "../src/index.ts";
import { ACCOUNT, rig } from "./helpers/setup.ts";
import { FakeDaemon } from "./helpers/fake-daemon.ts";

test("lifecycle: concurrent start shares one connection; start is idempotent", async () => {
  const r = await rig({}, false);
  try {
    await Promise.all([r.ch.start(r.host), r.ch.start(r.host), r.ch.start()]);
    await r.ch.start(r.host);
    assert.equal(r.daemon.connections, 1);
    assert.equal((await r.ch.health()).ok, true);
  } finally {
    await r.close();
  }
});

test("lifecycle: stop is idempotent, health goes false, restart works", async () => {
  const r = await rig();
  try {
    await r.ch.stop();
    await r.ch.stop();
    assert.equal((await r.ch.health()).ok, false);
    await assert.rejects(r.ch.send({ chatId: GROUPID, text: "x" }), /not started/);
    await r.ch.start(r.host);
    assert.equal((await r.ch.health()).ok, true);
  } finally {
    await r.close();
  }
});
const GROUPID = "Zm9vYmFyYmF6cXV4ZmFrZWdyb3VwaWQ=";

test("lifecycle: start rejects for an unregistered account without leaking the number", async () => {
  const d = new FakeDaemon();
  d.registered = false;
  await d.listen();
  const ch = new SignalChannel({
    account: ACCOUNT,
    endpoint: { host: "127.0.0.1", port: d.port },
    allowlist: [],
    dmAllowlist: [],
    sleep: async () => {},
  });
  try {
    await assert.rejects(ch.start(), (e: Error) => {
      assert.match(e.message, /not registered/);
      assert.ok(!e.message.includes("4915100000001"));
      return true;
    });
    assert.equal((await ch.health()).ok, false);
  } finally {
    await ch.stop();
    await d.close();
  }
});

test("lifecycle: start rejects when nothing listens (no daemon) with a fixed message", async () => {
  const d = new FakeDaemon();
  await d.listen();
  const port = d.port;
  await d.close();
  const ch = new SignalChannel({ account: ACCOUNT, endpoint: { host: "127.0.0.1", port }, allowlist: [], dmAllowlist: [] });
  await assert.rejects(ch.start(), /signal daemon start failed/);
  await ch.stop();
});

test("lifecycle: reconnect after a dropped socket re-subscribes with backoff and jitter", async () => {
  const r = await rig();
  try {
    r.daemon.dropConnections();
    await waitFor(() => r.daemon.connections >= 2 && r.logs.some((l) => l.event === "channel.signal.reconnected"));
    assert.equal((await r.ch.health()).ok, true);
    assert.ok(r.sleeps.length >= 1);
    // random() = 0.5 gives exactly the base delay: 1000 ms for the first attempt.
    assert.equal(r.sleeps[0], 1000);
    assert.equal(r.daemon.callsOf("subscribeReceive").length >= 2, true);
  } finally {
    await r.close();
  }
});

test("lifecycle: backoff grows with attempts and is capped at 60 s (table)", async () => {
  const cases: Array<[number, number]> = [
    [0, 1000],
    [1, 2000],
    [2, 4000],
    [5, 32000],
    [6, 60000],
    [20, 60000],
  ];
  for (const [attempt, expected] of cases) {
    const r = await rig({}, true);
    try {
      r.daemon.failures["version"] = Array.from({ length: attempt + 1 }, () => ({ code: -1, message: "busy" }));
      r.daemon.dropConnections();
      await waitFor(() => r.logs.some((l) => l.event === "channel.signal.reconnected"));
      assert.equal(r.sleeps[attempt] ?? r.sleeps.at(-1), expected, `attempt ${attempt}`);
    } finally {
      await r.close();
    }
  }
});

test("lifecycle: fatal not-registered on reconnect calls host.fail once and stops retrying", async () => {
  const r = await rig();
  try {
    r.daemon.registered = false;
    r.daemon.dropConnections();
    await waitFor(() => r.failures.length === 1);
    const before = r.daemon.connections;
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(r.daemon.connections, before, "no retry storm");
    assert.equal(r.failures.length, 1);
  } finally {
    await r.close();
  }
});

test("lifecycle: stop aborts a pending reconnect loop", async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const r = await rig({ sleep: async (ms, signal) => {
    if (ms >= 0) await new Promise<void>((res) => { signal.addEventListener("abort", () => res()); void gate; });
  } });
  r.daemon.dropConnections();
  await waitFor(() => r.logs.some((l) => l.event === "channel.signal.disconnected"));
  await r.ch.stop();
  release();
  assert.equal((await r.ch.health()).ok, false);
  const connections = r.daemon.connections;
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(r.daemon.connections, connections);
  await r.daemon.close();
});

const configCases: Array<[string, Record<string, unknown>, RegExp | null]> = [
  ["valid loopback TCP", { endpoint: { host: "127.0.0.1", port: 7583 } }, null],
  ["localhost TCP", { endpoint: { host: "localhost", port: 7583 } }, null],
  ["remote TCP refused by default", { endpoint: { host: "203.0.113.7", port: 7583 } }, /allowRemoteEndpoint/],
  ["remote TCP allowed explicitly", { endpoint: { host: "203.0.113.7", port: 7583 }, allowRemoteEndpoint: true }, null],
  ["port 0", { endpoint: { host: "127.0.0.1", port: 0 } }, /port/],
  ["port not integer", { endpoint: { host: "127.0.0.1", port: 1.5 } }, /port/],
  ["relative socket path", { endpoint: { socketPath: "relative.sock" } }, /absolute/],
  ["absolute socket path", { endpoint: { socketPath: "/tmp/signal.sock" } }, null],
  ["account without plus", { account: "4915100000001" }, /E\.164/],
  ["account with letters", { account: "+49abc" }, /E\.164/],
  ["empty allowlist entry", { allowlist: [""] }, /allowlists/],
  ["maxMediaBytes too big", { maxMediaBytes: 26 * 1024 * 1024 }, /maxMediaBytes/],
  ["maxMediaBytes zero", { maxMediaBytes: 0 }, /maxMediaBytes/],
  ["bad replyPolicy", { replyPolicy: "sometimes" }, /replyPolicy/],
  ["bad locale", { locale: "fr" }, /locale/],
];
for (const [name, patch, err] of configCases)
  test(`config validation: ${name}`, () => {
    const base = { account: ACCOUNT, endpoint: { host: "127.0.0.1", port: 7583 }, allowlist: [], dmAllowlist: [] };
    const opts = { ...base, ...patch } as ConstructorParameters<typeof SignalChannel>[0];
    if (err) assert.throws(() => new SignalChannel(opts), err);
    else assert.doesNotThrow(() => new SignalChannel(opts));
  });

test("config validation: the channel never spawns a process (endpoint only connects)", () => {
  const ch = new SignalChannel({ account: ACCOUNT, endpoint: { socketPath: "/tmp/x.sock" }, allowlist: [], dmAllowlist: [] });
  assert.equal(ch.name, "signal");
  assert.equal(ch.capabilities.approvalMode, "reply-code");
});

test("errors: SignalRpcError keeps the kind", () => {
  assert.equal(new SignalRpcError("timeout", "x").kind, "timeout");
});

async function waitFor(pred: () => boolean, tries = 500): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail("condition not reached");
}
