// The switchboard behind the real channel.* RPC surface: the answers carry what the host knows, not placeholders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildChannelSurface, TEST_MESSAGE } from "../../src/rpc/channel-surface.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import { DEFAULT_BINDINGS } from "../../src/channels/bindings.ts";
import type { CallContext } from "../../src/rpc/server.ts";
import { fakeBinding, makeRig, type Rig } from "./switchboard-rig.ts";

const TOKEN = "rpc-test-token-0123456789";
// A credential-shaped string built at runtime so no secret scanner sees a literal token in the repository.
const LEAK = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");

function surface(rig: Rig, person = "local-owner", withHost = true) {
  const raw = buildChannelSurface({
    config: rig.config.current,
    source: { current: rig.config.current, set: () => null },
    secrets: { list: async () => [...rig.secrets.values.keys()].map((name) => ({ name })) },
    identity: () => rig.identity,
    registry: () => (withHost ? rig.switchboard.view : null),
    clock: () => rig.clock.now(),
  });
  const methods = guardMethods(raw, { resolve: () => ({ userId: person, role: "owner", kind: "person" }) as never, now: () => 1 });
  const ctx: CallContext = { requestId: "r", connectionId: "c", signal: new AbortController().signal };
  return (m: string, p: unknown = {}): Promise<any> => methods[m]!(p, ctx) as Promise<any>;
}

test("without a host every channel is not-registered (the core before this change)", async () => {
  const rig = makeRig({ ids: ["discord", "slack", "matrix", "signal", "email"] });
  const r = await surface(rig, "local-owner", false)("channel.list");
  assert.equal(r.host, false);
  assert.ok(r.channels.every((c: any) => c.state === "not-registered"));
  rig.close();
});

test("with a host: list/status/get show registered, running, health, lastError and startedAt from the registry", async () => {
  const rig = makeRig({ ids: ["discord", "slack"] });
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true });
  rig.config.set("slack", { enabled: true }); // its two secrets are missing
  await rig.switchboard.start();
  await rig.clock.advance(1234);
  const call = surface(rig);

  const list = await call("channel.list");
  assert.equal(list.host, true);
  const by = Object.fromEntries(list.channels.map((c: any) => [c.id, c]));
  assert.deepEqual(by.discord, { id: "discord", displayName: "discord", enabled: true, configured: true, state: "running", health: "ok" });
  assert.equal(by.slack.state, "misconfigured");
  assert.equal(by.slack.health, "failing");
  assert.equal(by.slack.configured, false);
  assert.equal(by.matrix.state, "not-registered");

  const status = await call("channel.status");
  const st = Object.fromEntries(status.channels.map((c: any) => [c.id, c]));
  assert.equal(st.discord.state, "running");
  assert.equal(st.discord.lastError, undefined);
  assert.match(st.slack.lastError, /secret not found: channels\.slack\.bot-token, channels\.slack\.app-token/);

  const get = await call("channel.get", { id: "discord" });
  assert.equal(get.state, "running");
  assert.equal(get.startedAt, 0);
  assert.deepEqual(get.probe, { ok: true });
  assert.equal(get.attempts, 0);
  assert.equal(get.version, "0.1.0");
  assert.deepEqual(get.chatKinds, ["direct", "group"]);
  rig.close();
});

test("an unhealthy adapter shows failing and its detail comes from the adapter", async () => {
  const rig = makeRig();
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  await rig.clock.advance(0);
  rig.adapter().healthAnswer = { ok: false, detail: "gateway closed" };
  const get = await surface(rig)("channel.get", { id: "discord" });
  assert.deepEqual(get.probe, { ok: false, detail: "gateway closed" });
  rig.close();
});

test("a start error with a token-shaped value is masked in channel.status", async () => {
  const rig = makeRig({ binding: (id, made) => fakeBinding(id, made, { onMake: (a) => { a.startPlan = ["throw"]; a.startError = `denied for ${LEAK}`; } }) });
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  await rig.clock.advance(0);
  const s = await surface(rig)("channel.status");
  const d = s.channels.find((c: any) => c.id === "discord");
  assert.equal(d.state, "backoff");
  assert.ok(!JSON.stringify(s).includes(LEAK));
  rig.close();
});

test("channel test --send-owner sends to the adapter's direct target, not to the linked handle", async () => {
  const rig = makeRig();
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true });
  const { humanId } = rig.link("discord", "bot-1", "user-42");
  await rig.switchboard.start();
  await rig.clock.advance(0);
  rig.adapter().ownerTarget = async (who) => `dm-channel-of-${who.userId}`;
  const r = await surface(rig, humanId)("channel.test", { id: "discord", sendOwner: true });
  assert.equal(r.sent, true);
  assert.deepEqual(rig.adapter().sent, [{ chatId: "dm-channel-of-user-42", text: TEST_MESSAGE }]);
  rig.close();
});

test("channel test --send-owner without an adapter resolver keeps the handle as the chat (Telegram-style platforms)", async () => {
  const rig = makeRig();
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true });
  const { humanId } = rig.link("discord", "bot-1", "user-42");
  await rig.switchboard.start();
  await rig.clock.advance(0);
  Object.defineProperty(rig.adapter(), "resolveOwnerTarget", { value: undefined });
  await surface(rig, humanId)("channel.test", { id: "discord", sendOwner: true });
  assert.equal(rig.adapter().sent[0]?.chatId, "user-42");
  rig.close();
});

test("channel test --send-owner on a parked channel says it is not running", async () => {
  const rig = makeRig();
  rig.config.set("discord", { enabled: true });
  const { humanId } = rig.link("discord", "bot-1", "user-42");
  await rig.switchboard.start();
  await assert.rejects(surface(rig, humanId)("channel.test", { id: "discord", sendOwner: true }), (e: any) => e.reason === "channel-not-running");
  rig.close();
});

test("the inline manifests equal the packages' channel.json", () => {
  for (const b of DEFAULT_BINDINGS) {
    const file = JSON.parse(readFileSync(new URL(`../../../channels-${b.id}/channel.json`, import.meta.url), "utf8"));
    assert.deepEqual(b.manifest, file, b.id);
  }
});
