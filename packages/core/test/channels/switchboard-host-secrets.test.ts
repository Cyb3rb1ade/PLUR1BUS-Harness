import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRig, type FakeAdapter } from "./switchboard-rig.ts";

// Assembled at runtime so no token-shaped literal sits in the source.
const TOKEN = ["secrets", "fixture", "value", "9876543210"].join("-");

test("an unreadable secret store parks the channel with the store's reason, builds nothing, and starts once the store answers", async () => {
  const rig = makeRig({ switchboard: { recheckMs: 30_000 } });
  let storeDown = true;
  const has = rig.secrets.has.bind(rig.secrets);
  rig.secrets.has = async (name: string) => {
    if (storeDown) throw new Error("keychain is locked");
    return has(name);
  };
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  const parked = rig.switchboard.view.status("discord");
  assert.equal(parked?.state, "misconfigured");
  assert.match(parked?.lastError ?? "", /secret not readable: channels\.discord\.token \(secret store: keychain is locked\)/);
  assert.equal(rig.made.length, 0, "no adapter is built while the store cannot be read");
  assert.equal(rig.logs.some((l) => l.msg === "channel.misconfigured" && l.fields?.reason === "secret-missing"), true);

  storeDown = false;
  await rig.clock.advance(30_000);
  await rig.switchboard.idle();
  await rig.clock.advance(0);
  assert.equal(rig.switchboard.view.status("discord")?.state, "running");
  assert.equal(rig.switchboard.view.status("discord")?.lastError, undefined);
  rig.close();
});

test("a secret name that only shares a prefix with the channel's own namespace is foreign (channels.discordx.* is not channels.discord.*)", async () => {
  const rig = makeRig();
  const looked: string[] = [];
  const has = rig.secrets.has.bind(rig.secrets);
  rig.secrets.has = async (n: string) => { looked.push(n); return has(n); };
  rig.secrets.put("channels.discordx.token", TOKEN);
  rig.config.set("discord", { enabled: true, tokenSecret: "channels.discordx.token" });
  await rig.switchboard.start();
  assert.equal(rig.switchboard.view.status("discord")?.state, "misconfigured");
  assert.match(rig.switchboard.view.status("discord")?.lastError ?? "", /not allowed: channels\.discordx\.token/);
  assert.deepEqual(looked, []);
  assert.equal(rig.made.length, 0);
  rig.close();
});

test("a store error that echoes a secret value the adapter already read is redacted in the parked reason", async () => {
  const rig = makeRig({ switchboard: { recheckMs: 30_000 } });
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  await rig.clock.advance(0);
  const adapter: FakeAdapter = rig.adapter();
  // The adapter reveals its secret the normal way, then the adapter's channel goes down and the store fails on the next look.
  assert.equal(await (adapter.deps.secrets as { reveal(n: string): Promise<string | null> }).reveal("channels.discord.token"), TOKEN);
  rig.config.set("discord", { enabled: false });
  await rig.switchboard.idle();
  const has = rig.secrets.has.bind(rig.secrets);
  rig.secrets.has = async (name: string) => { throw new Error(`store refused ${TOKEN} for ${name}`); };
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.idle();
  const s = rig.switchboard.view.status("discord");
  assert.equal(s?.state, "misconfigured");
  assert.match(s?.lastError ?? "", /secret not readable: channels\.discord\.token \(secret store: store refused \[redacted\] for channels\.discord\.token\)/);
  assert.equal(JSON.stringify({ status: s, logs: rig.logs }).includes(TOKEN), false, "no status or log line carries the value");
  rig.secrets.has = has;
  rig.close();
});
