import assert from "node:assert/strict";
import { test } from "node:test";
import { makeContractHarness } from "./helpers/contract.ts";
import { textEnvelope } from "./helpers/fake-daemon.ts";

test("contract harness: wires a channel, delivers and records what the fake daemon received", async () => {
  const h = await makeContractHarness();
  try {
    assert.equal(h.name, "signal");
    assert.deepEqual(h.secretValues, []);
    await h.deliverDirect("hello there");
    await h.deliverGroupMentioned("ping");
    await h.deliverGroupUnmentioned("ignored");
    await h.channel.send({ chatId: "+4915100000002", text: "pong" });
    assert.deepEqual(h.sentTexts(), ["pong"]);
    const missing = await h.withMissingSecret();
    await assert.rejects(missing.start(), /not registered/);
    await missing.stop();
    assert.ok(h.logs.length > 0);
  } finally {
    await h.dispose();
  }
});

test("contract harness: unmentioned group traffic is not answered by default", async () => {
  const h = await makeContractHarness();
  try {
    await h.deliverGroupUnmentioned("quiet");
    assert.equal(h.sentTexts().length, 0);
    void textEnvelope;
  } finally {
    await h.dispose();
  }
});
