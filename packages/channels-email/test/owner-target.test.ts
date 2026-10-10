import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChannelHost } from "../../core/src/channels/types.ts";
import { parseMessage } from "../src/index.ts";
import { ALLOWED, BOT, CAROL, STRANGER, makeEmailFixture } from "./helpers/contract.ts";

const host: ChannelHost = { receive: async () => {}, fail() {}, log: { info() {}, warn() {}, error() {} } };

test("resolveOwnerTarget: allowlisted address -> a thread send() can use, addressed to that person", async () => {
  const fx = await makeEmailFixture();
  try {
    await fx.channel.start(host);
    const chatId = await fx.channel.resolveOwnerTarget({ userId: ` ${ALLOWED.toUpperCase()} `, accountId: BOT });
    assert.equal(chatId, await fx.channel.resolveOwnerTarget({ userId: ALLOWED }));
    await fx.channel.send({ chatId, text: "ping" });
    assert.deepEqual(fx.smtp.received.map((r) => r.rcpt), [[ALLOWED]]);
    assert.equal(parseMessage(fx.smtp.received[0]!.data).text.trim(), "ping");
  } finally {
    await fx.dispose();
  }
});

test("resolveOwnerTarget: domain entries match, everything else is rejected", async () => {
  const fx = await makeEmailFixture();
  try {
    const ch = fx.make(false, { dmAllowlist: ["*@example.test"] });
    await ch.resolveOwnerTarget({ userId: CAROL });
    for (const who of [
      { userId: STRANGER },
      { userId: BOT },
      { userId: "not-an-address" },
      { userId: "a@b.c\r\nBcc: x@y.z" },
      { userId: "*@example.test" },
      { userId: "" },
      { userId: ALLOWED, accountId: "other@example.test" },
    ])
      await assert.rejects(ch.resolveOwnerTarget(who), /email|identity|allowlist/, JSON.stringify(who));
  } finally {
    await fx.dispose();
  }
});
