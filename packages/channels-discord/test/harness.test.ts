import assert from "node:assert/strict";
import { test } from "node:test";
import { makeContractHarness } from "./helpers/contract.ts";
import { TOKEN } from "./helpers/fake-discord.ts";

test("contract harness: direct and mention deliveries reach the host, unmentioned group traffic does not", async () => {
  const h = await makeContractHarness();
  try {
    assert.equal(h.name, "discord");
    assert.deepEqual(h.secretValues, [TOKEN]);
    await h.channel.start(h.host);
    await h.deliverDirect("hello from DM");
    await h.deliverGroupMentioned("hello group");
    await h.deliverGroupUnmentioned("nobody asked");
    const delivered = h.logs.filter((l) => (l as { event?: string }).event === "host.receive");
    assert.equal(delivered.length, 2);
    await h.channel.send({ chatId: "777000000000000001", text: "reply to DM" });
    assert.deepEqual(h.sentTexts(), ["reply to DM"]);
    assert.ok(!JSON.stringify(h.logs).includes(TOKEN));
  } finally {
    await h.dispose();
  }
});

test("contract harness: a missing secret yields a channel whose start rejects without leaking", async () => {
  const h = await makeContractHarness();
  try {
    const ch = await h.withMissingSecret();
    await assert.rejects(ch.start(h.host));
    assert.ok(!JSON.stringify(h.logs).includes(TOKEN));
  } finally {
    await h.dispose();
  }
});
