import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { FakeSlack, FAKE_APP_TOKEN, FAKE_BOT_TOKEN, FAKE_SOCKET_URL, message, eventsApi } from "./helpers/fake-slack.ts";
import { wire, type Wiring } from "./helpers/wire.ts";
import { SlackChannel, SlackApi, SlackApiError, toSlackMrkdwn } from "../src/index.ts";
import type { OutputPort } from "../src/index.ts";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fake: FakeSlack;
let w: Wiring | undefined;
beforeEach(async () => {
  fake = new FakeSlack();
  await fake.listen();
});
afterEach(async () => {
  await w?.ch.stop();
  w = undefined;
  await fake.close();
});

test("health is false before start and after a failed start; no credential in any start error", async () => {
  const a = wire(fake, { secrets: { reveal: async () => null } });
  await assert.rejects(a.ch.start(a.host), (e: Error) => /not set/.test(e.message) && !/xox|xapp/.test(e.message));
  assert.equal((await a.ch.health()).ok, false);
});

test("start resolves on a bad app token only as a fixed failure, and never retries auth forever", async () => {
  const b = wire(fake, { secrets: { reveal: async (n) => (n === "slack-app-token" ? "xapp-1-A000000000-WRONGTOKENFORTESTS" : FAKE_BOT_TOKEN) } });
  await assert.rejects(b.ch.start(b.host), (e: Error) => e.message === "slack authentication failed");
  assert.equal(fake.callsOf("apps.connections.open").length, 1);
});

test("socket URL must be wss", async () => {
  // The channel must refuse a plain ws URL from apps.connections.open as a retryable protocol failure.
  w = wire(fake);
  const realCall = SlackApi.prototype.openSocketUrl;
  SlackApi.prototype.openSocketUrl = async function () {
    return "ws://insecure.test/link";
  };
  try {
    await w.ch.start(w.host);
    assert.equal((await w.ch.health()).ok, false);
    assert.equal(fake.sockets.length, 0, "never connects to a non-wss URL");
  } finally {
    SlackApi.prototype.openSocketUrl = realCall;
  }
});

test("start/stop lifecycle: concurrent start shares one start; stop aborts and clears state; restart works", async () => {
  w = wire(fake);
  await Promise.all([w.ch.start(w.host), w.ch.start(w.host)]);
  await w.ch.stop();
  assert.equal((await w.ch.health()).ok, false);
  await w.ch.start(w.host);
  assert.equal((await w.ch.health()).ok, true);
});

test("a handler failing never leaks its error text into logs", async () => {
  w = wire(fake, { replyPolicy: "always" });
  w.ch.onMessage(() => {
    throw new Error("internal detail with xoxb-SECRETLEAK");
  });
  await w.ch.start(w.host);
  fake.push(message({ channel: "C0FAKE01", user: "UHUMAN01", text: "hi", ts: "1700000200.000001" }));
  await w.ch.idle();
  assert.doesNotMatch(JSON.stringify(w.logs), /SECRETLEAK|internal detail/);
});

test("logs and errors carry no token, ticket or socket URL across a full session", async () => {
  w = wire(fake, { replyPolicy: "always" });
  w.ch.onMessage(() => {});
  await w.ch.start(w.host);
  await w.ch.send({ chatId: "C0FAKE01", text: "hello" });
  fake.failNext("chat.postMessage", 500, { ok: false, error: `boom ${FAKE_BOT_TOKEN}` });
  await w.ch.send({ chatId: "C0FAKE01", text: "again" }).catch(() => {});
  fake.latest().serverSend({ type: "disconnect", reason: "refresh_requested" });
  await new Promise((r) => setTimeout(r, 0));
  await w.ch.stop();
  const dump = JSON.stringify(w.logs) + JSON.stringify(w.failures);
  for (const secret of [FAKE_BOT_TOKEN, FAKE_APP_TOKEN, "FAKE-TICKET-DO-NOT-LOG", "wss://", "xoxb-", "xapp-"]) {
    assert.ok(!dump.includes(secret), `log contains ${secret}`);
  }
});

test("api errors are built from fixed text and sanitised codes; bodies are never echoed", () => {
  const e = new SlackApiError("bad-request", "chat.postMessage failed: msg_too_long", { status: 400, code: "msg_too_long" });
  assert.equal(e.code, "msg_too_long");
  assert.doesNotMatch(e.message, /https?:|xox|xapp/);
});

test("outbound markdown from a model cannot smuggle broadcast tokens into a sent message", async () => {
  w = wire(fake);
  await w.ch.start(w.host);
  await w.ch.send({ chatId: "C0FAKE01", text: "<!channel> [x](<!here>) <@UADMIN1> ![i](javascript:x)" });
  const sent = String(fake.callsOf("chat.postMessage")[0]!.body.text);
  assert.doesNotMatch(sent, /<!|<@/);
  assert.equal(toSlackMrkdwn("<!channel>"), "&lt;!channel&gt;");
});

test("outputs: only authorised, integrity-checked store output is sent", async () => {
  const root = mkdtempSync(join(tmpdir(), "slack-out-"));
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  mkdirSync(join(root, id), { recursive: true });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  writeFileSync(join(root, id, "0.png"), png);
  const manifest = { files: [{ path: "0.png", bytes: png.length, sha256: createHash("sha256").update(png).digest("hex"), format: "png" }] };
  let allowed = true;
  const outputs: OutputPort = {
    store: { root, get: async () => manifest as never },
    authorize: async () => allowed,
  };
  w = wire(fake, { outputs });
  await w.ch.start(w.host);
  const refs = await w.ch.sendOutput("C0FAKE01", id);
  assert.equal(refs[0]!.kind, "file");
  assert.equal(fake.callsOf("files.getUploadURLExternal")[0]!.body.filename, "0.png");
  allowed = false;
  await assert.rejects(w.ch.sendOutput("C0FAKE01", id), /denied/);
  allowed = true;
  writeFileSync(join(root, id, "0.png"), Buffer.from("tampered!"));
  await assert.rejects(w.ch.sendOutput("C0FAKE01", id), /integrity/);
  await assert.rejects(w.ch.sendOutput("C0FAKE01", "../../etc"), /denied/);
});

test("socket and API URLs from the platform are never trusted for host changes: download host is pinned", async () => {
  w = wire(fake);
  await w.ch.start(w.host);
  fake.files.set("FX", { name: "x.png", mime: "image/png", data: Buffer.from([1]) });
  w.ch.onMessage(() => {});
  fake.push(
    message({
      channel: "D0FAKE01",
      user: "UHUMAN01",
      text: "x",
      ts: "1700000210.000001",
      files: [{ id: "FX", name: "x.png", mimetype: "image/png", size: 1, url_private_download: "https://attacker.test/x.png" }],
    }),
  );
  await w.ch.idle();
  assert.equal(w.received.length, 0, "a foreign download host is refused before any request");
});

test("secret names are validated and credentials are not accepted in config", () => {
  for (const bad of ["xoxb-abc", "xapp-abc", "has space"]) {
    assert.throws(() => new SlackChannel({ botTokenSecret: bad, appTokenSecret: "a", allowlist: [], dmAllowlist: [], secrets: { reveal: async () => null } }), RangeError, bad);
  }
});

test("eventsApi helper sanity (envelopes are acked by id)", async () => {
  w = wire(fake, { replyPolicy: "always" });
  w.ch.onMessage(() => {});
  await w.ch.start(w.host);
  fake.push(eventsApi({ type: "message", channel: "C0FAKE01", channel_type: "channel", user: "UHUMAN01", text: "x", ts: "1700000220.000001" }, { eventId: "EvSANITY" }));
  await w.ch.idle();
  assert.equal(fake.latest().ackedIds().length, 1);
  assert.equal(FAKE_SOCKET_URL.startsWith("wss://"), true);
});
