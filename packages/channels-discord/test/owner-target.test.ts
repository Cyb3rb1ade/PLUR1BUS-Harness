import assert from "node:assert/strict";
import { test } from "node:test";
import { makeEnv, started } from "./helpers/env.ts";
import { DM_USER, OTHER_USER, TOKEN } from "./helpers/fake-discord.ts";

async function setup(over = {}) {
  const e = await makeEnv(over);
  const ch = e.channel();
  await started(e, ch);
  return { e, ch };
}

test("resolveOwnerTarget opens the DM once, caches it and lets the bot send into it", async () => {
  const { e, ch } = await setup();
  const dm = await ch.resolveOwnerTarget({ userId: DM_USER });
  assert.equal(dm, e.rest.dms.get(DM_USER));
  assert.notEqual(dm, DM_USER, "the DM channel id is not the user id");
  const post = e.rest.callsOf("POST", "/api/v10/users/@me/channels");
  assert.equal(post.length, 1);
  assert.deepEqual(post[0]!.json, { recipient_id: DM_USER });
  assert.equal(await ch.resolveOwnerTarget({ userId: DM_USER, accountId: "x" }), dm);
  assert.equal(e.rest.callsOf("POST", "/api/v10/users/@me/channels").length, 1, "cached");
  await ch.send({ chatId: dm, text: "hi" });
  assert.equal(e.rest.messages.at(-1)!.channelId, dm);
  await e.close();
});

test("resolveOwnerTarget refuses users off the dmAllowlist and sends nothing to their DM", async () => {
  const { e, ch } = await setup();
  await assert.rejects(ch.resolveOwnerTarget({ userId: OTHER_USER }), /dmAllowlist/);
  assert.equal(e.rest.callsOf("POST", "/api/v10/users/@me/channels").length, 0, "no DM is even opened");
  await assert.rejects(ch.send({ chatId: "777000000000000099", text: "x" }), /allowlist/);
  await e.close();
});

test("resolveOwnerTarget validates the snowflake and requires a started channel", async () => {
  const { e, ch } = await setup();
  await assert.rejects(ch.resolveOwnerTarget({ userId: "not-an-id" }), /invalid discord user id/);
  const idle = e.channel();
  await assert.rejects(idle.resolveOwnerTarget({ userId: DM_USER }), /not started/);
  await e.close();
});

test("resolveOwnerTarget surfaces API errors redacted, and does not cache a failure", async () => {
  const { e, ch } = await setup();
  e.rest.fail("POST /api/v10/users/@me/channels", { status: 403, body: { message: `Missing Access ${TOKEN}`, code: 50001 } });
  const err = await ch.resolveOwnerTarget({ userId: DM_USER }).then(() => undefined, (x: Error) => x);
  assert.ok(err && /forbidden \(403\)/.test(err.message));
  assert.ok(!err.message.includes(TOKEN));
  await assert.rejects(ch.send({ chatId: "777000000000000099", text: "x" }), /allowlist/);
  assert.ok(await ch.resolveOwnerTarget({ userId: DM_USER }), "a later attempt succeeds");
  await e.close();
});

test("resolveOwnerTarget rejects a malformed DM channel answer", async () => {
  const { e, ch } = await setup();
  e.rest.fail("POST /api/v10/users/@me/channels", { status: 200, body: { id: "oops" } });
  await assert.rejects(ch.resolveOwnerTarget({ userId: DM_USER }), /invalid DM channel/);
  await e.close();
});
