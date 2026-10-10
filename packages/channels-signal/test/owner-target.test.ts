import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCOUNT, DM, DM_UUID, GROUP, STRANGER, rig } from "./helpers/setup.ts";

test("owner target: an allowed number or uuid is returned as the chat id for send()", async () => {
  const r = await rig({ dmAllowlist: [DM, DM_UUID] }, false);
  assert.equal(await r.ch.resolveOwnerTarget({ userId: DM }), DM);
  assert.equal(await r.ch.resolveOwnerTarget({ userId: DM_UUID, accountId: ACCOUNT }), DM_UUID);
  await r.daemon.close();
});

test("owner target: refuses anything that is not a DM id on the allowlist", async () => {
  const r = await rig({}, false);
  for (const userId of [STRANGER, GROUP, "alice", "", "+123", `${DM}\n`, "11111111-2222-4333-8444-555555555555"])
    await assert.rejects(r.ch.resolveOwnerTarget({ userId }), `rejects ${JSON.stringify(userId)}`);
  await assert.rejects(r.ch.resolveOwnerTarget({ userId: 42 as never }));
  await r.daemon.close();
});

test("owner target: an account id other than the configured account is refused", async () => {
  const r = await rig({}, false);
  await assert.rejects(r.ch.resolveOwnerTarget({ userId: DM, accountId: STRANGER }));
  await r.daemon.close();
});
