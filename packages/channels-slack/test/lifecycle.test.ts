import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { FileSeenStore, MemorySeenStore, SlackChannel, resolveConfig, type SlackConfig } from "../src/index.ts";
import { FakeSlack, FAKE_BOT_TOKEN, TEAM, TEST_SECRETS, message } from "./helpers/fake-slack.ts";
import { wire } from "./helpers/wire.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fake: FakeSlack;
beforeEach(async () => {
  fake = new FakeSlack();
  await fake.listen();
});
afterEach(async () => {
  await fake.close();
});

test("start: secret read, auth.test, socket; health reflects the connection", async () => {
  const w = wire(fake);
  assert.equal((await w.ch.health()).ok, false);
  await w.ch.start(w.host);
  assert.equal((await w.ch.health()).ok, true);
  assert.equal(fake.callsOf("auth.test").length, 1);
  assert.equal(fake.callsOf("apps.connections.open")[0]!.auth, `Bearer ${TEST_SECRETS["slack-app-token"]}`);
  await w.ch.stop();
  assert.equal((await w.ch.health()).ok, false, "health is false after stop");
});

test("start is idempotent and concurrent calls share one start", async () => {
  const w = wire(fake);
  await Promise.all([w.ch.start(w.host), w.ch.start(w.host), w.ch.start()]);
  await w.ch.start(w.host);
  assert.equal(fake.callsOf("auth.test").length, 1);
  assert.equal(fake.sockets.length, 1);
  await w.ch.stop();
  await w.ch.stop();
});

test("restart after stop works and reconnects", async () => {
  const w = wire(fake);
  await w.ch.start(w.host);
  await w.ch.stop();
  await w.ch.start(w.host);
  assert.equal((await w.ch.health()).ok, true);
  assert.equal(fake.sockets.length, 2);
  await w.ch.stop();
});

test("missing and malformed secrets reject start without leaking any credential", async () => {
  const cases: Array<[string, (n: string) => string | null]> = [
    ["missing", () => null],
    ["malformed", () => "not-a-token-at-all"],
  ];
  for (const [label, pick] of cases) {
    const w = wire(fake, { secrets: { reveal: async (n) => pick(n) } });
    await assert.rejects(w.ch.start(w.host), (e: Error) => {
      assert.doesNotMatch(e.message, /xox|xapp|FAKE/);
      return /secret/.test(e.message);
    }, label);
    assert.equal(fake.calls.length, 0, `${label}: no network call`);
  }
});

test("a throwing secret reader rejects with a fixed message", async () => {
  const w = wire(fake, { secrets: { reveal: async () => { throw new Error("keychain said xoxb-LEAK"); } } });
  await assert.rejects(w.ch.start(w.host), (e: Error) => e.message === "slack bot token secret read failed");
});

test("invalid credentials (auth.test invalid_auth) reject start as authentication failure", async () => {
  const w = wire(fake, {
    secrets: { reveal: async (n) => (n === "slack-bot-token" ? "xoxb-000000000000-WRONGTOKENFORTESTSONLY" : TEST_SECRETS[n] ?? null) },
  });
  await assert.rejects(w.ch.start(w.host), (e: Error) => e.message === "slack authentication failed");
  assert.equal(fake.callsOf("auth.test").length, 1, "no retry storm");
});

test("workspace mismatch with teamId rejects start", async () => {
  fake.authTeam = "T0OTHER01";
  const w = wire(fake, { teamId: TEAM });
  await assert.rejects(w.ch.start(w.host), /workspace/);
});

test("a config that carries a credential instead of a secret name is refused", () => {
  assert.throws(() => resolveConfig({ botTokenSecret: FAKE_BOT_TOKEN, appTokenSecret: "x", allowlist: [], dmAllowlist: [] } as SlackConfig), RangeError);
});

test("invalid allowlist entries and media bounds are refused at construction", () => {
  const base = { botTokenSecret: "b", appTokenSecret: "a", allowlist: [], dmAllowlist: [] };
  assert.throws(() => resolveConfig({ ...base, allowlist: ["general"] }), RangeError);
  assert.throws(() => resolveConfig({ ...base, dmAllowlist: ["@someone"] }), RangeError);
  assert.throws(() => resolveConfig({ ...base, maxMediaBytes: 26 * 1024 * 1024 }), RangeError);
  assert.throws(() => resolveConfig({ ...base, replyPolicy: "shout" as "mention" }), RangeError);
  assert.doesNotThrow(() => new SlackChannel({ ...base, secrets: { reveal: async () => null } }));
});

test("persistent dedupe: corrupt state fails start closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-seen-"));
  writeFileSync(join(dir, "slack-seen.json"), "{not json");
  const w = wire(fake, { seen: new FileSeenStore(dir) });
  await assert.rejects(w.ch.start(w.host), /dedupe state/);
});

test("persistent dedupe: handled event ids are saved and survive a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-seen-"));
  const store = new FileSeenStore(dir);
  const w = wire(fake, { seen: store, replyPolicy: "always" });
  w.ch.onMessage(() => {});
  await w.ch.start(w.host);
  fake.push(message({ channel: "C0FAKE01", user: "UHUMAN01", text: "hi", ts: "1700000900.000001", eventId: "EvPERSIST1" }));
  await w.ch.idle();
  await w.ch.stop();
  assert.ok((await store.load())!.includes("ev:EvPERSIST1"));
  const again = wire(fake, { seen: store, replyPolicy: "always" });
  again.ch.onMessage(() => {});
  await again.ch.start(again.host);
  fake.push(message({ channel: "C0FAKE01", user: "UHUMAN01", text: "hi", ts: "1700000900.000001", eventId: "EvPERSIST1" }));
  await again.ch.idle();
  assert.equal(again.received.length, 0, "redelivery after restart is suppressed");
  await again.ch.stop();
  assert.ok(new MemorySeenStore(["ev:old"]));
});

test("unexpected start errors use fixed text", async () => {
  fake.failNext("auth.test", 500, "boom xapp-LEAK");
  const w = wire(fake);
  await assert.rejects(w.ch.start(w.host), (e: Error) => {
    assert.doesNotMatch(e.message, /LEAK|xapp|xoxb/);
    return true;
  });
});
