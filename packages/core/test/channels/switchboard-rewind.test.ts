/** Shared-room conversation does not confer authority to discard another person's history. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Role } from "../../src/rbac/types.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { Compactor, defaultCompaction } from "../../src/session/compaction.ts";
import { RewindService } from "../../src/session/rewind.ts";
import { TurnRunner } from "../../src/session/turn-loop.ts";
import type { SwitchboardOptions } from "../../src/channels/switchboard.ts";
import { requireRewindSender } from "../../src/channels/rewind.ts";
import { makeRig } from "./switchboard-rig.ts";

async function room(locale: "de" | "en" = "en") {
  let turns: ReturnType<SwitchboardOptions["turns"]> = null;
  const roles = new Map<string, Role>();
  let roleFailure = false;
  const options = { turns: () => turns, personRole: (id: string) => { if (roleFailure) throw new Error("role lookup failed"); return roles.get(id); } };
  const r = makeRig({ switchboard: options });
  const rewind = new RewindService({ store: r.store, audit: memoryAuditSink(), now: () => r.clock.now() });
  const runner = new TurnRunner({ store: r.store, compactor: new Compactor(r.store, defaultCompaction(8192), { beforeSwap: async () => {} }),
    provider: () => r.provider, rewind, memory: { recall: async () => ({ text: "", degraded: null }), capture: async () => {}, checkpoint: async () => {} } });
  turns = { store: r.store, runner, agentId: () => "main" };
  r.secrets.put("channels.discord.token", "unit-test-token-0123456789"); r.config.set("discord", { enabled: true, locale });
  await r.switchboard.start(); await r.clock.advance(0);
  const owner = r.link("discord", "bot", "sender-a").humanId, other = r.link("discord", "bot", "sender-b").humanId;
  roles.set(owner, "member"); roles.set(other, "member");
  let n = 0;
  const send = (senderId: string, text: string) => r.adapter().inbound({ accountId: "bot", senderId, chatId: "shared-room", chatKind: "group", addressed: true, messageId: `message-${++n}`, text });
  await send("sender-a", "owner task"); await send("sender-b", "ordinary member reply");
  const session = r.store.listSessions({ owner: deriveUserPrincipal(owner), kind: "channel" }).sessions[0]!;
  return { ...r, roles, owner, other, session, send, failRoleLookup: () => { roleFailure = true; },
    closeRoom: async () => { await runner.idle(); await r.switchboard.stop(); r.close(); } };
}

test("a second room member can converse but cannot rewind the owner's conversation", { timeout: 10_000 }, async () => {
  const r = await room();
  try {
    assert.equal(r.provider.requests.length, 2);
    const before = r.store.listMessages(r.session.id), events = r.store.listEvents(r.session.id);
    await r.send("sender-b", '/rewind 0 --lesson "member override"');
    assert.deepEqual(r.store.rewinds(r.session.id), []);
    assert.deepEqual(r.store.listMessages(r.session.id), before);
    assert.deepEqual(r.store.listEvents(r.session.id), events);
    await r.send("sender-b", "a later ordinary reply");
    assert.equal(r.provider.requests.length, 3);
  } finally { await r.closeRoom(); }
});

for (const locale of ["de", "en"] as const) {
  test(`a denied room member receives the specific rewind explanation in ${locale}`, { timeout: 10_000 }, async () => {
    const r = await room(locale);
    try {
      const before = r.store.listMessages(r.session.id), events = r.store.listEvents(r.session.id);
      await r.send("sender-b", "/rewind 0");
      assert.equal(r.adapter().sent.at(-1)?.text, locale === "de"
        ? "Nur die Person, der dieses Gespräch gehört, oder Owner/Admin darf hier zurückspulen."
        : "Only the owner of this conversation or an Owner/Admin can rewind it.");
      assert.deepEqual(r.store.listMessages(r.session.id), before);
      assert.deepEqual(r.store.listEvents(r.session.id), events);
      assert.equal(r.provider.requests.length, 2);
    } finally { await r.closeRoom(); }
  });
}

test("room undo requires the session owner or a live Owner/Admin role, including after demotion", { timeout: 10_000 }, async () => {
  const r = await room();
  try {
    await r.send("sender-a", '/rewind 0 --lesson "owner lesson"');
    const first = r.store.rewinds(r.session.id)[0]!; assert.ok(first);
    await r.send("sender-b", `/rewind --undo ${first.id}`);
    assert.equal(r.store.rewinds(r.session.id)[0]!.undoneAt, null);
    r.roles.set(r.other, "admin");
    await r.send("sender-b", `/rewind --undo ${first.id}`);
    assert.notEqual(r.store.rewinds(r.session.id)[0]!.undoneAt, null);
    r.roles.set(r.other, "member");
    await r.send("sender-b", '/rewind 0 --lesson "demoted override"');
    assert.equal(r.store.rewinds(r.session.id).length, 1);
    r.roles.set(r.other, "owner");
    await r.send("sender-b", '/rewind 0 --lesson "administrator lesson"');
    assert.equal(r.store.rewinds(r.session.id).length, 2);
    const second = r.store.rewinds(r.session.id)[1]!;
    r.roles.set(r.other, "member");
    await r.send("sender-b", `/rewind --undo ${second.id}`);
    assert.equal(r.store.rewinds(r.session.id)[1]!.undoneAt, null);
  } finally { await r.closeRoom(); }
});

test("missing or failed role lookup does not promote a room member", { timeout: 10_000 }, async () => {
  const r = await room();
  try {
    r.roles.delete(r.other);
    await r.send("sender-b", "/rewind 0"); assert.equal(r.store.rewinds(r.session.id).length, 0);
    r.roles.set(r.other, "admin"); r.failRoleLookup();
    await r.send("sender-b", "/rewind 0"); assert.equal(r.store.rewinds(r.session.id).length, 0);
    await r.send("sender-a", "/rewind 0"); assert.equal(r.store.rewinds(r.session.id).length, 1);
  } finally { await r.closeRoom(); }
});

test("denied room commands have the exact typed reason, including malformed rewind and an unknown chat kind", () => {
  for (const chatKind of ["group", undefined] as const) {
    for (const text of ["/rewind 0", "/rewind --undo rewind-id", "/rewind 0 --role owner"]) {
      assert.throws(() => requireRewindSender({ text, chatKind, owner: deriveUserPrincipal("owner"), person: "member", role: "member" }),
        { name: "RpcError", error: "E_DENIED", reason: "rewind-not-allowed" });
    }
  }
  assert.doesNotThrow(() => requireRewindSender({ text: "ordinary reply", chatKind: "group", owner: deriveUserPrincipal("owner"), person: "member" }));
});
