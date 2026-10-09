import assert from "node:assert/strict";
import { test } from "node:test";
import { makeContractHarness } from "./helpers/contract.ts";

test("contract harness drives the channel end to end against the fake platform", async () => {
  const h = await makeContractHarness();
  try {
    assert.equal(h.name, "slack");
    assert.equal((h.manifest as { name: string }).name, "slack");
    const host = {
      receive: async () => {},
      fail: () => {},
      log: { info() {}, warn() {}, error() {} },
    };
    await h.channel.start(host);
    await h.deliverDirect("hello from DM");
    await h.deliverGroupUnmentioned("nobody addressed");
    await h.deliverGroupMentioned("addressed");
    await h.channel.send({ chatId: "D0FAKE01", text: "reply **bold**" });
    assert.ok(h.sentTexts().includes("reply *bold*"));
    const logText = JSON.stringify(h.logs);
    for (const s of h.secretValues) assert.ok(!logText.includes(s));
    const missing = await h.withMissingSecret();
    await assert.rejects(missing.start(), /not set/);
  } finally {
    await h.dispose();
  }
});
