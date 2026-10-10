import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRig } from "./switchboard-rig.ts";

const TOKEN = ["host", "lifecycle", "fixture", "0123456789"].join("-");

test("stop() then start() on the same host runs the channel again, with no registration error logged", async (t) => {
  const rig = makeRig();
  t.after(() => rig.close());
  rig.secrets.put("channels.discord.token", TOKEN);
  rig.config.set("discord", { enabled: true });
  await rig.switchboard.start();
  await rig.clock.advance(0);
  for (let i = 0; i < 3; i++) {
    const first = rig.adapter();
    await rig.switchboard.stop();
    assert.equal(first.stops, 1);
    assert.equal(rig.switchboard.view.status("discord")?.state, "stopped");
    assert.equal(rig.config.listeners(), 0);
    await rig.switchboard.start();
    await rig.switchboard.idle();
    await rig.clock.advance(0);
    assert.equal(rig.switchboard.view.status("discord")?.state, "running");
    assert.notEqual(rig.adapter(), first);
    assert.equal(rig.adapter().starts, 1);
    assert.equal(rig.config.listeners(), 1);
    assert.equal(rig.switchboard.view.list().length, 1);
    assert.equal(rig.logs.some((l) => l.msg === "switchboard.register.failed"), false, "a restarted host must not report its own channels as a failed registration");
  }
  rig.config.set("discord", { enabled: false });
  await rig.switchboard.idle();
  assert.equal(rig.switchboard.view.status("discord")?.state, "stopped");
});
