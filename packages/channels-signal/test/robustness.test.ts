import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCOUNT, DM, GROUP, push, rig } from "./helpers/setup.ts";
import { textEnvelope } from "./helpers/fake-daemon.ts";

test("robustness: after a busy session no log line contains the account, numbers, uuids, or socket paths", async () => {
  const r = await rig({ pairing: { claim: () => { throw new Error(`leak ${ACCOUNT}`); } } as never });
  try {
    await push(r, textEnvelope({ message: "hi", ts: 1 }));
    await push(r, textEnvelope({ message: "￼ yo", groupId: GROUP, mentions: [{ number: ACCOUNT, start: 0, length: 1 }], ts: 2 }));
    await push(r, textEnvelope({ message: "/link 123456", ts: 3 }));
    r.daemon.failNext("send", { code: -1, message: `failed for ${DM} at /run/user/501/signal.sock` });
    await r.ch.send({ chatId: DM, text: "x" }).catch(() => {});
    const text = JSON.stringify(r.logs);
    for (const secret of [ACCOUNT, DM, "aaaaaaaa-bbbb", "/run/user", "123456"]) assert.ok(!text.includes(secret), secret);
  } finally {
    await r.close();
  }
});

test("robustness: error messages from start and send are fixed text, never daemon text", async () => {
  const r = await rig();
  try {
    r.daemon.failNext("send", { code: -1, message: `secret-daemon-text ${DM}` });
    await assert.rejects(r.ch.send({ chatId: DM, text: "x" }), (e: Error) => {
      assert.ok(!e.message.includes("secret-daemon-text") && !e.message.includes(DM));
      return true;
    });
  } finally {
    await r.close();
  }
});
