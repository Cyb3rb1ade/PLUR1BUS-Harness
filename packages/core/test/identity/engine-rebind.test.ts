// engine-rebind.test.ts — ADR-007 Q4 back-fill against the REAL engine (contract 1.12.0), not a scripted recorder:
// the memories of a deliberately linked channel identity move to the harness user by an owner-metadata rewrite only
// (no copy, no /share, no vector rewrite), a preview changes nothing, the step is reversible and N:1 holds.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { defaults } from "@plur1bus/config-schema";
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { buildEngineConfig } from "../../src/engine-config.ts";
import { layout } from "../../src/paths.ts";
import { createTempHost } from "../../src/import/importers/hermes-stores.ts";
import { createBackfill } from "../../src/identity/backfill.ts";
import { createEngineRebindPort, rebindLookupFromService } from "../../src/identity/engine-rebind.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { v1PrincipalOf, type ChannelIdentity } from "../../src/identity/service.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { IdentityError } from "../../src/identity/store.ts";
import { OWNER, useIdentity } from "./helpers.ts";

const refuses = (fn: () => unknown, code: string) => assert.rejects(async () => fn(), (e: unknown) => e instanceof IdentityError && e.code === code, `expected IdentityError ${code}`);

// The engine ships no type declaration for its test seam; the rows (owner, vector) are read through it, never written.
const { internalsOf } = (await import("@cyb3rb1ade/plur1bus-memory/engine/internals.js" as string)) as { internalsOf: (e: unknown) => any };

const fixture = useIdentity();
const TG: ChannelIdentity = { channel: "telegram", accountId: "bot-a", userId: "1001" };
const DC: ChannelIdentity = { channel: "discord", accountId: "bot-a", userId: "d-2002" };
const OTHER: ChannelIdentity = { channel: "telegram", accountId: "bot-a", userId: "9009" };
const AGENT = "bernd";
const userAgent = { origin: "user", background: false } as const;
const systemAgent = { origin: "system", background: false } as const;
const timeout = 60_000;

const principalOf = (id: ChannelIdentity, user = v1PrincipalOf(id)) =>
  ({ agentId: AGENT, channel: id.channel, accountId: id.accountId, chat: { id: "c1", kind: "direct" }, trust: "proved", user }) as any;

async function setup() {
  const f = fixture();
  const home = tempDir("p2-rebind-");
  const l = layout(home);
  mkdirSync(l.workspaceDir(AGENT), { recursive: true });
  const engine = createEngine(createTempHost(l.state, async (id: string) => l.workspaceDir(id)), buildEngineConfig(defaults(), l) as any, { internals: flatTestInternals() });
  const seed = async (id: ChannelIdentity, n: number, tag: string) => {
    const p = principalOf(id);
    const res = await engine.memory.import({ agentId: AGENT, principal: p, cards: Array.from({ length: n }, (_, i) => ({ idempotencyKey: `${tag}-${i}`, text: `${tag} fact number ${i}`, provenance: "imported" as const, scope: "user" as const })) }, p, systemAgent);
    assert.equal(res.created, n);
    return res.cards.map((c: any) => c.id as string);
  };
  const agentCard = await (async () => {
    const p = { agentId: AGENT, channel: "cli", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" } as any;
    const res = await engine.memory.import({ agentId: AGENT, principal: p, cards: [{ idempotencyKey: "agent-knowledge", text: "agent knowledge, not a person memory", provenance: "imported", scope: "agent-private" }] }, p, systemAgent);
    return res.cards[0]!.id as string;
  })();
  const tg = await seed(TG, 2, "tg");
  const dc = await seed(DC, 1, "dc");
  const other = await seed(OTHER, 1, "other");
  const row = (id: string) => internalsOf(engine).pool.withDb(AGENT, (db: any) => db.getById(id));
  const person = f.human("Person");
  const bf = createBackfill({ service: f.svc, engine: createEngineRebindPort({ engine, agentId: AGENT, lookup: rebindLookupFromService(f.svc) }), clock: () => f.now() });
  const visibleTo = async (user: string, id: ChannelIdentity = TG) => (await engine.memory.list({ since: 0, limit: 100 }, principalOf(id, user), userAgent)).items.filter((c: any) => c.scope === "user").map((c: any) => c.id as string).sort();
  return { f, home, engine, bf, person, tg, dc, other, agentCard, row, visibleTo, close: () => engine.close({ budgetMs: 5_000 }) };
}

describe("identity back-fill on the real engine (ADR-007 Q4)", () => {
  it("a preview counts and changes nothing; apply moves the owner of exactly the linked identity's person memories, nothing else", { timeout }, async () => {
    const s = await setup();
    try {
      const { linkId } = s.f.pairAndLink(s.person.id, TG);
      const v2 = deriveUserPrincipal(s.person.id);
      const before = await Promise.all([...s.tg, ...s.dc, ...s.other, s.agentCard].map(async (id) => [id, await s.row(id)] as const));

      const preview = await s.bf.run({ linkId, dryRun: true }, OWNER);
      assert.equal(preview.count, 2, "the preview counts the two Telegram person memories");
      assert.equal(preview.receipt, undefined);
      assert.deepEqual(await s.visibleTo(v2), [], "the preview moved nothing");

      const applied = await s.bf.run({ linkId, dryRun: false }, OWNER);
      assert.equal(applied.count, 2);
      assert.ok(applied.receipt);
      assert.deepEqual(await s.visibleTo(v2), [...s.tg].sort(), "the person now owns them under the harness user");
      assert.deepEqual(await s.visibleTo(v1PrincipalOf(TG)), [], "and the old channel principal no longer does");

      // Metadata only: same rows, same text, byte-identical vectors, no copies, no shared rows, other owners untouched.
      for (const [id, was] of before) {
        const now = await s.row(id);
        assert.equal(now.text, was.text);
        assert.deepEqual(Array.from(now.vector as ArrayLike<number>), Array.from(was.vector as ArrayLike<number>), "no vector rewrite");
        const moved = s.tg.includes(id);
        assert.equal(now.ownerUserId, moved ? v2 : was.ownerUserId, moved ? "owner rebound" : "owner untouched");
        assert.equal(now.scope, was.scope);
      }
      const total = await internalsOf(s.engine).pool.withDb(AGENT, async (db: any) => (await db.scanActiveBatches({ batchSize: 100 }).next()).value.length);
      assert.equal(total, before.length, "no row was added (nothing was copied or shared)");
      assert.deepEqual(await s.visibleTo(v1PrincipalOf(DC), DC), [...s.dc].sort(), "an unlinked identity of the same person stays where it was");
    } finally { await s.close(); }
  });

  it("one user, many channel identities: a second link back-fills into the same user; applying twice changes nothing more", { timeout }, async () => {
    const s = await setup();
    try {
      const a = s.f.pairAndLink(s.person.id, TG);
      const b = s.f.pairAndLink(s.person.id, DC);
      const v2 = deriveUserPrincipal(s.person.id);
      assert.equal((await s.bf.run({ linkId: a.linkId, dryRun: false }, OWNER)).count, 2);
      assert.equal((await s.bf.run({ linkId: b.linkId, dryRun: false }, OWNER)).count, 1);
      assert.deepEqual(await s.visibleTo(v2), [...s.tg, ...s.dc].sort(), "the person memories of both sources end up together");
      const again = await s.bf.run({ linkId: a.linkId, dryRun: false }, OWNER);
      assert.equal(again.count, 2, "the recorded result, not a second run");
      assert.deepEqual(await s.visibleTo(v2), [...s.tg, ...s.dc].sort());
    } finally { await s.close(); }
  });

  it("reversal restores the old owner of exactly the touched rows and skips cards written after the back-fill", { timeout }, async () => {
    const s = await setup();
    try {
      const { linkId } = s.f.pairAndLink(s.person.id, TG);
      const v2 = deriveUserPrincipal(s.person.id);
      await s.bf.run({ linkId, dryRun: false }, OWNER);
      // A card the person gets under the new principal after the back-fill must stay with them.
      const p2 = principalOf(TG, v2);
      const added = await s.engine.memory.import({ agentId: AGENT, principal: p2, cards: [{ idempotencyKey: "after", text: "learned after the back-fill", provenance: "imported", scope: "user" }] }, p2, systemAgent);
      assert.equal((await s.bf.reverse({ linkId, dryRun: true }, OWNER)).count, 2, "the preview names the two touched rows");
      assert.equal((await s.bf.reverse({ linkId, dryRun: false }, OWNER)).count, 2);
      assert.deepEqual(await s.visibleTo(v1PrincipalOf(TG)), [...s.tg].sort(), "the old owner is back");
      assert.deepEqual(await s.visibleTo(v2), [added.cards[0]!.id], "the later card was left alone");
    } finally { await s.close(); }
  });

  it("exclusive per channel identity: a second user cannot take over a bound identity; unlink, reverse and relink moves the memories", { timeout }, async () => {
    const s = await setup();
    try {
      const first = s.f.pairAndLink(s.person.id, TG);
      await s.bf.run({ linkId: first.linkId, dryRun: false }, OWNER);
      const second = s.f.human("Second");
      await refuses(() => s.f.pairAndLink(second.id, TG), "conflict"); // the service: one channel identity, exactly one user
      s.f.svc.unlink({ linkId: first.linkId }, OWNER);
      const relink = s.f.pairAndLink(second.id, TG);
      await refuses(() => s.bf.run({ linkId: relink.linkId, dryRun: false }, OWNER), "conflict"); // the engine: still bound to the first user
      await s.bf.reverse({ linkId: first.linkId, dryRun: false }, OWNER);
      assert.equal((await s.bf.run({ linkId: relink.linkId, dryRun: false }, OWNER)).count, 2);
      assert.deepEqual(await s.visibleTo(deriveUserPrincipal(second.id)), [...s.tg].sort());
      assert.deepEqual(await s.visibleTo(deriveUserPrincipal(s.person.id)), []);
      const actions = s.f.events.map((e) => e.action);
      for (const a of ["identity.backfill", "identity.backfill.reversed", "identity.unlink"]) assert.ok(actions.includes(a), `${a} is audit-logged`);
      for (const e of s.f.events.filter((x) => x.action.startsWith("identity.backfill"))) assert.ok(!JSON.stringify(e).includes("fact number"), "the audit record carries counts, never card text");
    } finally { await s.close(); }
  });
});
