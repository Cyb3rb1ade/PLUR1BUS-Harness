import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FAKE_TOKEN, FakeMatrix, ROOM, ALICE, BOT } from "./helpers/fake-matrix.ts";
import { Rig, newFake } from "./helpers/rig.ts";
import { MatrixChannel, MemorySyncTokenStore } from "../src/index.ts";

const SECRET = "matrix/bot-token";

let fake: FakeMatrix;
let rig: Rig | undefined;

beforeEach(async () => {
  fake = await newFake();
});
afterEach(async () => {
  await rig?.close();
  rig = undefined;
  await fake?.close().catch(() => {});
});

test("start performs whoami, initial sync, persists the token and reports healthy; stop reports unhealthy", async () => {
  rig = new Rig(fake);
  await rig.start();
  assert.equal(fake.callsTo("GET", "/_matrix/client/v3/account/whoami").length, 1);
  const initial = fake.syncs[0]!;
  assert.equal(initial.since, null, "first sync has no since token (initial sync)");
  assert.equal(initial.timeout, 0);
  assert.deepEqual(await rig.ch.health(), { ok: true });
  assert.equal(typeof (await rig.store.load()), "string", "initial sync persisted a next_batch token");
  await rig.ch.stop();
  assert.deepEqual(await rig.ch.health(), { ok: false });
});

test("stop and start are idempotent and restart works", async () => {
  rig = new Rig(fake);
  await rig.start();
  await rig.ch.start(rig.host as never); // already started: no second whoami
  assert.equal(fake.callsTo("GET", "/_matrix/client/v3/account/whoami").length, 1);
  await rig.ch.stop();
  await rig.ch.stop();
  rig.recreate();
  await rig.start();
  assert.deepEqual(await rig.ch.health(), { ok: true });
});

test("concurrent start calls share one start", async () => {
  rig = new Rig(fake);
  await Promise.all([rig.ch.start(rig.host as never), rig.ch.start(rig.host as never)]);
  await fake.waitIdle();
  assert.equal(fake.callsTo("GET", "/_matrix/client/v3/account/whoami").length, 1);
});

test("stop aborts a held long poll promptly", async () => {
  rig = new Rig(fake, { syncTimeoutMs: 60_000 });
  await rig.start();
  const t0 = Date.now();
  await rig.ch.stop();
  assert.ok(Date.now() - t0 < 2000, "stop returned without waiting out the poll");
});

test("missing access token secret rejects start without leaking anything", async () => {
  rig = new Rig(fake, { secrets: { reveal: async () => null } });
  await assert.rejects(rig.ch.start(rig.host as never), (e: Error) => {
    assert.ok(!e.message.includes(FAKE_TOKEN));
    return true;
  });
  assert.deepEqual(await rig.ch.health(), { ok: false });
  assert.equal(fake.calls.length, 0, "no request leaves the process without a token");
});

test("secret reader failure rejects start with a fixed message", async () => {
  rig = new Rig(fake, {
    secrets: {
      reveal: async () => {
        throw new Error(`keyring said ${FAKE_TOKEN}`);
      },
    },
  });
  await assert.rejects(rig.ch.start(rig.host as never), (e: Error) => {
    assert.equal(e.message, "matrix secret read failed");
    return true;
  });
  assert.ok(!rig.allLogText().includes(FAKE_TOKEN));
});

test("malformed token value is refused before any request", async () => {
  rig = new Rig(fake, { secrets: { reveal: async () => "not a token with spaces" } });
  await assert.rejects(rig.ch.start(rig.host as never), /unexpected format/);
  assert.equal(fake.calls.length, 0);
});

test("revoked token (401 at whoami) rejects start once, without retry", async () => {
  fake.revoked = true;
  rig = new Rig(fake);
  await assert.rejects(rig.ch.start(rig.host as never), (e: { kind?: string }) => e.kind === "unauthorized");
  assert.equal(fake.callsTo("GET", "/_matrix/client/v3/account/whoami").length, 1);
  assert.deepEqual(await rig.ch.health(), { ok: false });
});

test("account mismatch (whoami user id differs from config) rejects start", async () => {
  fake.whoamiUserId = "@other:hs.test";
  rig = new Rig(fake);
  await assert.rejects(rig.ch.start(rig.host as never), /does not match/);
});

test("device mismatch when deviceId is configured rejects start", async () => {
  rig = new Rig(fake, { deviceId: "SOMEOTHER" });
  await assert.rejects(rig.ch.start(rig.host as never), /deviceId/);
});

test("matching deviceId is accepted", async () => {
  rig = new Rig(fake, { deviceId: "BOTDEVICE" });
  await rig.start();
  assert.deepEqual(await rig.ch.health(), { ok: true });
});

test("401 during the sync loop is fatal: host.fail once, loop ends, no retry storm", async () => {
  rig = new Rig(fake);
  await rig.start();
  fake.failNext("GET", "/_matrix/client/v3/sync", 401, { errcode: "M_UNKNOWN_TOKEN", error: "gone" });
  fake.deliverNoWait(ROOM, [fake.message(ROOM, ALICE, { msgtype: "m.text", body: "x" })]);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(rig.failures.length, 1);
  assert.equal(rig.sleeps.length, 0, "no backoff sleep for an auth failure");
  assert.deepEqual(await rig.ch.health(), { ok: false });
});

test("corrupt sync state fails closed: start refuses and makes no sync request", async () => {
  const store = { load: async () => { throw new Error("matrix sync state is invalid"); }, save: async () => {} };
  rig = new Rig(fake, {}, store);
  await assert.rejects(rig.ch.start(rig.host as never), /refusing to start/);
  assert.equal(fake.syncs.length, 0);
});

test("a resumed start uses the persisted token and does not run an initial sync", async () => {
  const store = new MemorySyncTokenStore("s7");
  rig = new Rig(fake, {}, store);
  await rig.start();
  assert.equal(fake.syncs.every((s) => s.since !== null), true);
  assert.equal(fake.syncs[0]!.since, "s7");
  assert.equal(fake.syncs[0]!.timeout, 5000, "loop uses the configured long-poll timeout");
});

test("secrets and the access token never appear in any log line", async () => {
  rig = new Rig(fake);
  await rig.start();
  fake.failNext("GET", "/_matrix/client/v3/sync", 500, { errcode: "M_UNKNOWN", error: `leak ${FAKE_TOKEN}` });
  await fake.deliver(ROOM, [fake.message(ROOM, ALICE, { msgtype: "m.text", body: "hello" })]);
  await rig.ch.stop();
  assert.ok(rig.logs.length > 0);
  assert.ok(!rig.allLogText().includes(FAKE_TOKEN));
  assert.ok(!/syt_[A-Za-z0-9_-]{8,}/.test(rig.allLogText()));
});

test("the homeserver never sees the token outside the Authorization header", async () => {
  rig = new Rig(fake);
  await rig.start();
  for (const c of fake.calls) assert.ok(!c.path.includes(FAKE_TOKEN));
});

test("homeserverUrl must be https unless loopback http (constructor refuses)", () => {
  const base = { userId: BOT, accessTokenSecret: SECRET, allowlist: [], dmAllowlist: [], secrets: { reveal: async () => null }, syncStore: new MemorySyncTokenStore() };
  assert.throws(() => new MatrixChannel({ ...base, homeserverUrl: "http://matrix.example.org" }), RangeError);
  assert.throws(() => new MatrixChannel({ ...base, homeserverUrl: "https://u:p@matrix.example.org" }), RangeError);
  assert.throws(() => new MatrixChannel({ ...base, homeserverUrl: "https://matrix.example.org/?x=1" }), RangeError);
  assert.doesNotThrow(() => new MatrixChannel({ ...base, homeserverUrl: "https://matrix.example.org" }));
  assert.doesNotThrow(() => new MatrixChannel({ ...base, homeserverUrl: "http://127.0.0.1:8008" }));
  assert.doesNotThrow(() => new MatrixChannel({ ...base, homeserverUrl: "http://localhost:8008" }));
});


test("sync 5xx backs off exponentially with jitter (injected random) and then recovers", async () => {
  rig = new Rig(fake, { random: () => 0.5 });
  await rig.start();
  fake.failNext("GET", "/_matrix/client/v3/sync", 503, { errcode: "M_UNKNOWN", error: "busy" });
  fake.failNext("GET", "/_matrix/client/v3/sync", 503, { errcode: "M_UNKNOWN", error: "busy" });
  await fake.deliver(ROOM, [fake.message(ROOM, ALICE, { msgtype: "m.text", body: "after outage" })]).catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(rig.sleeps.slice(0, 2), [1000, 2000], "doubling backoff; jitter factor 1.0 at random 0.5");
  assert.equal(rig.rich.length, 0, "no delivery from the failed polls, but the loop is still alive");
  assert.deepEqual(await rig.ch.health(), { ok: true });
});

test("sync 429 waits the clamped server interval, not the backoff", async () => {
  rig = new Rig(fake);
  await rig.start();
  fake.failNext("GET", "/_matrix/client/v3/sync", 429, { errcode: "M_LIMIT_EXCEEDED", error: "slow", retry_after_ms: 3000 });
  await fake.deliver(ROOM, [fake.message(ROOM, ALICE, { msgtype: "m.text", body: "x" })]).catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(rig.sleeps.includes(3000));
});
