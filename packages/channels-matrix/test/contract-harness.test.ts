import assert from "node:assert/strict";
import { test } from "node:test";
import { makeContractHarness } from "./helpers/contract.ts";

test("contract harness: direct and group deliveries reach the channel and the fake sees its replies", async () => {
  const h = await makeContractHarness();
  try {
    assert.equal(h.name, "matrix");
    assert.equal(h.channel.name, "matrix");
    const got: string[] = [];
    h.channel.onMessage((m) => void got.push(m.text));
    await h.channel.start();
    await h.deliverDirect("dm text");
    await h.deliverGroupMentioned("group text");
    await h.deliverGroupUnmentioned("ignored text");
    assert.deepEqual(got, ["dm text", "@bot:hs.test group text"]);
    await h.channel.send({ chatId: "!room:hs.test", text: "reply" });
    assert.deepEqual(h.sentTexts(), ["reply"]);
    await h.channel.stop();
    const missing = await h.withMissingSecret();
    await assert.rejects(missing.start());
    assert.ok(!JSON.stringify(h.logs).includes(h.secretValues[0]!));
  } finally {
    await h.channel.stop();
    await h.dispose();
  }
});
