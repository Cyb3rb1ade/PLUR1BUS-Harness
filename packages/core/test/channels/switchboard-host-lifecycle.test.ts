import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeBinding, FakeAdapter, makeRig, type Rig } from "./switchboard-rig.ts";

// Assembled at runtime so no token-shaped literal sits in the source.
const TOKEN = ["host", "lifecycle", "fixture", "0123456789"].join("-");

/** An enabled discord channel with its token stored, started and running. */
async function running(): Promise<Rig> {
  const rig = makeRig();
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  await rig.switchboard.idle();
  await rig.clock.advance(0);
  return rig;
}

/** A binding whose constructor refuses a non-snowflake allowlist entry: the schema accepts the string, the adapter does not. */
function validatingBinding(id: string, made: FakeAdapter[]) {
  return {
    id,
    manifest: fakeBinding(id, []).manifest,
    async load() {
      return (cfg: Record<string, unknown>, deps: Record<string, unknown>) => {
        const list = Array.isArray(cfg.allowlist) ? cfg.allowlist : [];
        if (list.some((x) => !/^\d{17,20}$/.test(String(x)))) throw new RangeError("allowlist must be Discord snowflake ids");
        const a = new FakeAdapter(id, cfg, deps);
        made.push(a);
        return a;
      };
    },
  };
}

test("a channel parked for a refused configuration starts once the configuration is corrected (no secret change, no restart)", async () => {
  const made: FakeAdapter[] = [];
  const rig = makeRig({ binding: (id) => validatingBinding(id, made) });
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true, allowlist: ["not-a-snowflake"] });
  await rig.switchboard.start();
  assert.equal(rig.switchboard.view.status("discord")?.state, "misconfigured");
  assert.match(rig.switchboard.view.status("discord")?.lastError ?? "", /invalid configuration: allowlist must be Discord snowflake ids/);
  assert.equal(made.length, 0, "a refused configuration builds nothing");

  rig.config.set("discord", { allowlist: ["123456789012345678"] });
  await rig.switchboard.idle();
  await rig.clock.advance(0);
  assert.equal(rig.switchboard.view.status("discord")?.state, "running");
  assert.equal(rig.switchboard.view.status("discord")?.lastError, undefined);
  rig.close();
});

test("a configuration change while a secret is still missing keeps the channel parked and reads the store again, not an adapter", async () => {
  const rig = makeRig();
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  const storeLooks = (): number => rig.secrets.reads.length;
  assert.equal(rig.switchboard.view.status("discord")?.state, "misconfigured");
  rig.config.set("discord", { allowlist: ["123456789012345678"] });
  await rig.switchboard.idle();
  assert.equal(rig.switchboard.view.status("discord")?.state, "misconfigured");
  assert.match(rig.switchboard.view.status("discord")?.lastError ?? "", /secret not found: channels\.discord\.token/);
  assert.equal(rig.made.length, 0, "no adapter is built while the secret is missing");
  assert.equal(storeLooks(), 0, "the store is only checked with has(), never read");
  rig.close();
});

test("a parked channel is looked up again on a doubling schedule, not on every tick (each look is an audited read)", async () => {
  const rig = makeRig({ switchboard: { recheckMs: 30_000 } });
  let looks = 0;
  const has = rig.secrets.has.bind(rig.secrets);
  rig.secrets.has = async (name: string) => { if (name === "channels.discord.token") looks++; return has(name); };
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  assert.equal(looks, 1, "the first check is at start");
  await rig.clock.advance(29_999);
  assert.equal(looks, 1);
  await rig.clock.advance(1); // +30 s: first recheck
  await rig.switchboard.idle();
  assert.equal(looks, 2);
  await rig.clock.advance(59_999); // the next gap doubles to 60 s
  assert.equal(looks, 2);
  await rig.clock.advance(1);
  await rig.switchboard.idle();
  assert.equal(looks, 3);
  rig.close();
});

test("a foreign secret name in a channel's configuration is never looked up in the store (has or read)", async () => {
  const rig = makeRig();
  const looked: string[] = [];
  const has = rig.secrets.has.bind(rig.secrets);
  const read = rig.secrets.read.bind(rig.secrets);
  rig.secrets.has = async (n: string) => { looked.push(`has:${n}`); return has(n); };
  rig.secrets.read = async (n: string) => { looked.push(`read:${n}`); return read(n); };
  rig.secrets.put("channels.slack.bot-token", "unused-foreign-value-000000");
  rig.config.set("discord", { enabled: true, tokenSecret: "channels.slack.bot-token" });
  await rig.switchboard.start();
  assert.equal(rig.switchboard.view.status("discord")?.state, "misconfigured");
  assert.match(rig.switchboard.view.status("discord")?.lastError ?? "", /secret names must start with channels\.discord\./);
  assert.deepEqual(looked, [], "the host does not even ask the store for another channel's credential");
  assert.equal(rig.made.length, 0);
  rig.close();
});

test("a config change that leaves a channel's values equal restarts nothing", async () => {
  const rig = await running();
  const a = rig.adapter();
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.idle();
  assert.equal(a.stops, 0);
  assert.equal(a.starts, 1);
  assert.equal(rig.adapter(), a, "the same adapter instance keeps running");
  rig.close();
});

test("stop() then start() on the same host runs the channel again, with no registration error logged", { todo: "KNOWN GAP: a host restart re-registers its own channels and logs switchboard.register.failed (\"already registered\")" }, async () => {
  const rig = await running();
  await rig.switchboard.stop();
  assert.equal(rig.switchboard.view.status("discord")?.state, "stopped");
  await rig.switchboard.start();
  await rig.switchboard.idle();
  await rig.clock.advance(0);
  assert.equal(rig.switchboard.view.status("discord")?.state, "running");
  assert.equal(rig.logs.some((l) => l.msg === "switchboard.register.failed"), false, "a restarted host must not report its own channels as a failed registration");
  rig.close();
});
