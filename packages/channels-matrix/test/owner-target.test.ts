import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ALICE, CAROL, DM, FAKE_TOKEN, FakeMatrix, ROOM } from "./helpers/fake-matrix.ts";
import { Rig, newFake } from "./helpers/rig.ts";

const open: { fake: FakeMatrix; rig: Rig }[] = [];
afterEach(async () => {
  for (const { rig, fake } of open.splice(0)) {
    await rig.close().catch(() => {});
    await fake.close().catch(() => {});
  }
});

async function setup(withDm: boolean): Promise<Rig> {
  const fake = await newFake();
  if (withDm) {
    fake.addRoom(DM, { members: 2 });
    fake.direct = { [ALICE]: [DM] };
  }
  const rig = new Rig(fake);
  open.push({ fake, rig });
  await rig.start();
  return rig;
}

test("owner target: an existing m.direct room with the person is reused, nothing is created", async () => {
  const rig = await setup(true);
  assert.equal(await rig.ch.resolveOwnerTarget({ userId: ALICE }), DM);
  assert.equal(rig.fake.created.length, 0);
  await rig.ch.send({ chatId: DM, text: "x" });
  assert.equal(rig.fake.sent.at(-1)!.roomId, DM);
});

test("owner target: without a direct room a private is_direct room is created, the person invited, and the room is cached", async () => {
  const rig = await setup(false);
  const room = await rig.ch.resolveOwnerTarget({ userId: ALICE });
  assert.notEqual(room, ALICE);
  assert.match(room, /^!/);
  assert.equal(rig.fake.created.length, 1);
  assert.deepEqual(rig.fake.created[0]!.body, { is_direct: true, invite: [ALICE], preset: "trusted_private_chat", visibility: "private" });
  assert.equal("initial_state" in rig.fake.created[0]!.body, false, "no encryption");
  assert.deepEqual(rig.fake.direct, { [ALICE]: [room] }, "m.direct records the new room");
  assert.equal(await rig.ch.resolveOwnerTarget({ userId: ALICE }), room);
  assert.equal(rig.fake.created.length, 1, "cached");
  await rig.ch.send({ chatId: room, text: "hello" });
  assert.equal(rig.fake.sent.at(-1)!.roomId, room);
});

test("owner target: concurrent calls share one room", async () => {
  const rig = await setup(false);
  const [a, b] = await Promise.all([rig.ch.resolveOwnerTarget({ userId: ALICE }), rig.ch.resolveOwnerTarget({ userId: ALICE })]);
  assert.equal(a, b);
  assert.equal(rig.fake.created.length, 1);
});

test("owner target: a person off dmAllowlist is refused and nothing is created or made sendable", async () => {
  const rig = await setup(false);
  await assert.rejects(rig.ch.resolveOwnerTarget({ userId: CAROL }), /allowlist/);
  assert.equal(rig.fake.created.length, 0);
  await assert.rejects(rig.ch.send({ chatId: "!nope:hs.test", text: "x" }), /allowlist/);
  // a group room on the allowlist is not a direct room for anybody
  assert.equal(rig.fake.created.length, 0);
  void ROOM;
});

test("owner target: a malformed mxid is refused; a stopped channel is refused", async () => {
  const rig = await setup(false);
  for (const bad of ["alice", "@alice", "@a b:hs.test", "", `@${"x".repeat(300)}:hs.test`])
    await assert.rejects(rig.ch.resolveOwnerTarget({ userId: bad }), RangeError);
  await rig.ch.stop();
  await assert.rejects(rig.ch.resolveOwnerTarget({ userId: ALICE }), /not started/);
});

test("owner target: a failed createRoom is redacted, not cached, and retried next time", async () => {
  const rig = await setup(false);
  rig.fake.failNext("POST", "/_matrix/client/v3/createRoom", 403, { errcode: "M_FORBIDDEN", error: `denied ${FAKE_TOKEN}` });
  await assert.rejects(rig.ch.resolveOwnerTarget({ userId: ALICE }), (e: Error) => {
    assert.ok(!e.message.includes(FAKE_TOKEN));
    return true;
  });
  assert.ok(!rig.allLogText().includes(FAKE_TOKEN));
  const room = await rig.ch.resolveOwnerTarget({ userId: ALICE });
  assert.match(room, /^!created/);
});

test("owner target: a failing m.direct write does not fail the resolution", async () => {
  const rig = await setup(false);
  rig.fake.failNext("PUT", "/_matrix/client/v3/user/", 500, { errcode: "M_UNKNOWN", error: "boom" });
  const room = await rig.ch.resolveOwnerTarget({ userId: ALICE });
  await rig.ch.send({ chatId: room, text: "still sendable" });
  assert.equal(rig.fake.sent.at(-1)!.roomId, room);
});
