// identity backfill.ts (Q4: deliberate, metadata-only rebind of v1 rows to the person's v2 principal, reversible by receipt)
// and recall.ts (reads take the union, writes one canonical principal). The engine side is a scripted recorder: it
// returns what the test tells it to and implements none of the behaviour under test.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createBackfill, type MetadataRebindPort } from "../../src/identity/backfill.ts";
import { createRecallScopeProvider } from "../../src/identity/recall.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { v1PrincipalOf, type ChannelIdentity } from "../../src/identity/service.ts";
import { ADMIN, OWNER, refuses, useIdentity } from "./helpers.ts";

const fixture = useIdentity();
const TG: ChannelIdentity = { channel: "telegram", accountId: "bot-a", userId: "1001" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Rebind = { from: string; to: string; dryRun: boolean; operationId: string };
type Reverse = { receipt: string; dryRun: boolean; operationId: string };
class ScriptedEngine implements MetadataRebindPort {
  rebinds: Rebind[] = []; reverses: Reverse[] = [];
  nextRebind: Array<{ count: number; receipt?: string } | Error> = [];
  nextReverse: Array<{ count: number } | Error> = [];
  gate: Promise<void> | null = null;
  async rebind(p: Rebind) {
    this.rebinds.push(p); if (this.gate) await this.gate;
    const r = this.nextRebind.shift() ?? { count: 3, receipt: "receipt-1" };
    if (r instanceof Error) throw r; return r;
  }
  async reverse(p: Reverse) {
    this.reverses.push(p);
    const r = this.nextReverse.shift() ?? { count: 3 };
    if (r instanceof Error) throw r; return r;
  }
}

function setup() {
  const f = fixture(); const engine = new ScriptedEngine();
  const bf = createBackfill({ service: f.svc, engine, clock: () => f.now() });
  const h = f.human("Person"); const { linkId } = f.pairAndLink(h.id, TG);
  return { f, engine, bf, h, linkId };
}

describe("identity backfill: run", () => {
  it("a preview asks the engine with dryRun, reports the count and writes nothing durable (a second preview is still a preview)", async () => {
    const { f, engine, bf, h, linkId } = setup();
    engine.nextRebind.push({ count: 7 });
    const r = await bf.run({ linkId, dryRun: true }, OWNER);
    assert.deepEqual(r, { linkId, from: v1PrincipalOf(TG), to: `user:v2:${sha(h.id)}`, dryRun: true, count: 7, at: f.now() });
    assert.equal(engine.rebinds[0]!.dryRun, true);
    engine.nextRebind.push({ count: 8 });
    assert.equal((await bf.run({ linkId, dryRun: true }, OWNER)).count, 8);
    assert.equal(engine.rebinds.length, 2);
  });

  it("applying rebinds exactly this link's v1 principal to the person's v2 principal, with an operation id, and returns the receipt", async () => {
    const { engine, bf, h, linkId } = setup();
    const r = await bf.run({ linkId, dryRun: false }, OWNER);
    assert.equal(r.count, 3); assert.equal(r.receipt, "receipt-1"); assert.equal(r.dryRun, false);
    assert.equal(engine.rebinds.length, 1);
    const call = engine.rebinds[0]!;
    assert.equal(call.from, v1PrincipalOf(TG)); assert.equal(call.to, `user:v2:${sha(h.id)}`); assert.equal(call.dryRun, false);
    assert.match(call.operationId, /^[0-9a-f-]{36}$/);
  });

  it("v1 principal derivation is independent of the service: sha256 over the JSON triple", () => {
    assert.equal(v1PrincipalOf(TG), `user:v1:${sha(JSON.stringify(["telegram", "bot-a", "1001"]))}`);
  });

  it("applying twice is idempotent: the engine is not asked again and the stored result is returned", async () => {
    const { engine, bf, linkId } = setup();
    const first = await bf.run({ linkId, dryRun: false }, OWNER);
    engine.nextRebind.push({ count: 99, receipt: "other" });
    const second = await bf.run({ linkId, dryRun: false }, OWNER);
    assert.equal(engine.rebinds.length, 1);
    assert.equal(second.count, first.count); assert.equal(second.receipt, first.receipt);
  });

  it("a rebind that returns no receipt cannot be recorded as applied: storage error, because it could not be reversed", async () => {
    const { engine, bf, linkId } = setup();
    engine.nextRebind.push({ count: 2 });
    await assert.rejects(bf.run({ linkId, dryRun: false }, OWNER), (e: unknown) => (e as { code?: string }).code === "storage");
    engine.nextRebind.push({ count: 2, receipt: "" });
    await assert.rejects(bf.run({ linkId, dryRun: false }, OWNER), (e: unknown) => (e as { code?: string }).code === "storage");
  });

  it("an engine count that is not a non-negative safe integer is a storage error, in a preview and when applying", async () => {
    for (const count of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "3" as never]) for (const dryRun of [true, false]) {
      const { engine, bf, linkId } = setup();
      engine.nextRebind.push({ count, receipt: "r" });
      await assert.rejects(bf.run({ linkId, dryRun }, OWNER), (e: unknown) => (e as { code?: string }).code === "storage", `${String(count)} dryRun=${dryRun}`);
    }
  });

  it("zero rows is a valid result", async () => {
    const { engine, bf, linkId } = setup(); engine.nextRebind.push({ count: 0, receipt: "empty" });
    assert.equal((await bf.run({ linkId, dryRun: false }, OWNER)).count, 0);
  });

  it("an engine failure is passed on, and the next attempt asks the engine again with the same operation id", async () => {
    const { engine, bf, linkId } = setup();
    engine.nextRebind.push(new Error("engine down"));
    await assert.rejects(bf.run({ linkId, dryRun: false }, OWNER), /engine down/);
    const r = await bf.run({ linkId, dryRun: false }, OWNER);
    assert.equal(r.count, 3);
    assert.equal(engine.rebinds.length, 2); assert.equal(engine.rebinds[1]!.operationId, engine.rebinds[0]!.operationId);
  });

  it("an unknown link is not-found; a removed link cannot be backfilled", async () => {
    const { f, bf, linkId } = setup();
    await assert.rejects(bf.run({ linkId: "nope", dryRun: true }, OWNER), (e: unknown) => (e as { code?: string }).code === "not-found");
    f.svc.unlink({ linkId }, OWNER);
    await assert.rejects(bf.run({ linkId, dryRun: true }, OWNER), (e: unknown) => (e as { code?: string }).code === "conflict");
  });

  it("only owner and admin may backfill: the person themself, a member of another person and an agent are all denied, before the engine is touched", async () => {
    const { f, engine, bf, h, linkId } = setup(); const other = f.human("Other");
    for (const who of [h.self, other.self, { ...OWNER, kind: "agent" as const }, { user: "x", host: "h", kind: "person" as const, role: "viewer" as const }]) {
      await assert.rejects(bf.run({ linkId, dryRun: true }, who), (e: unknown) => (e as { code?: string }).code === "denied");
    }
    assert.equal(engine.rebinds.length, 0);
    await bf.run({ linkId, dryRun: true }, ADMIN);
  });

  it("a second run on the same link while one is in flight is a conflict; other links are independent; the slot is freed afterwards", async () => {
    const { f, engine, bf, h, linkId } = setup();
    const second = f.pairAndLink(h.id, { ...TG, userId: "2002" });
    let release!: () => void; engine.gate = new Promise<void>((r) => { release = r; });
    const running = bf.run({ linkId, dryRun: true }, OWNER);
    await assert.rejects(bf.run({ linkId, dryRun: true }, OWNER), (e: unknown) => (e as { code?: string }).code === "conflict");
    const other = bf.run({ linkId: second.linkId, dryRun: true }, OWNER);
    release(); engine.gate = null;
    await running; await other;
    await bf.run({ linkId, dryRun: true }, OWNER);
  });

  it("the audit trail records the operation with hashed principals and no plain person data", async () => {
    const { f, bf, h, linkId } = setup();
    await bf.run({ linkId, dryRun: false }, OWNER);
    const ev = f.events.find((e) => e.action === "identity.backfill")!;
    assert.ok(ev); assert.equal(ev.detail.dryRun, false);
    const text = JSON.stringify(f.events);
    for (const secret of [h.id, TG.accountId, OWNER.user]) assert.equal(text.includes(secret), false, secret);
    // The channel user id is only four digits: as a plain substring it also occurs by chance inside timestamps, UUIDs and
    // sha256 digests in the events (flaky). Compare exactly instead: no key or value (string or number) may equal it, and no
    // string may carry it as a token delimited by non-identifier characters (e.g. "telegram:1001"). Digits inside a longer
    // hex digest or number are not a leak.
    const leaves: unknown[] = [];
    const walk = (v: unknown): void => { if (v !== null && typeof v === "object") { for (const [k, x] of Object.entries(v)) { leaves.push(k); walk(x); } } else leaves.push(v); };
    walk(f.events);
    assert.equal(leaves.some((x) => String(x) === TG.userId), false, "the channel user id as an exact key or value");
    const token = new RegExp(`(^|[^0-9A-Za-z_-])${TG.userId}($|[^0-9A-Za-z_-])`);
    assert.equal(leaves.some((x) => typeof x === "string" && token.test(x)), false, "the channel user id as a delimited token");
  });
});

describe("identity backfill: reverse", () => {
  it("without an applied backfill there is nothing to reverse", async () => {
    const { bf, linkId } = setup();
    await assert.rejects(bf.reverse({ linkId, dryRun: false }, OWNER), (e: unknown) => (e as { code?: string }).code === "conflict");
  });

  it("reversal uses exactly the receipt of the apply and a derived operation id", async () => {
    const { engine, bf, linkId } = setup();
    engine.nextRebind.push({ count: 4, receipt: "exact-receipt" });
    await bf.run({ linkId, dryRun: false }, OWNER);
    engine.nextReverse.push({ count: 4 });
    const r = await bf.reverse({ linkId, dryRun: false }, OWNER);
    assert.deepEqual(r, { count: 4 });
    assert.equal(engine.reverses[0]!.receipt, "exact-receipt"); assert.equal(engine.reverses[0]!.operationId, `${engine.rebinds[0]!.operationId}:reverse`); assert.equal(engine.reverses[0]!.dryRun, false);
  });

  it("a reversal preview changes no state: the backfill can still be reversed for real afterwards", async () => {
    const { engine, bf, linkId } = setup();
    await bf.run({ linkId, dryRun: false }, OWNER);
    await bf.reverse({ linkId, dryRun: true }, OWNER);
    assert.equal(engine.reverses[0]!.dryRun, true);
    await bf.reverse({ linkId, dryRun: false }, OWNER);
    assert.equal(engine.reverses.length, 2);
  });

  it("reversing again returns the recorded count without asking the engine; applying after a reversal is refused", async () => {
    const { engine, bf, linkId } = setup();
    await bf.run({ linkId, dryRun: false }, OWNER);
    engine.nextReverse.push({ count: 5 });
    await bf.reverse({ linkId, dryRun: false }, OWNER);
    const again = await bf.reverse({ linkId, dryRun: false }, OWNER);
    assert.equal(again.count, 5); assert.equal(engine.reverses.length, 1);
    await assert.rejects(bf.run({ linkId, dryRun: false }, OWNER), (e: unknown) => (e as { code?: string }).code === "conflict");
    await assert.rejects(bf.run({ linkId, dryRun: true }, OWNER), (e: unknown) => (e as { code?: string }).code === "conflict", "even a preview");
  });

  it("an engine failure during reversal leaves it 'reversing': apply stays refused and the reversal can be retried", async () => {
    const { engine, bf, linkId } = setup();
    await bf.run({ linkId, dryRun: false }, OWNER);
    engine.nextReverse.push(new Error("reverse failed"));
    await assert.rejects(bf.reverse({ linkId, dryRun: false }, OWNER), /reverse failed/);
    await assert.rejects(bf.run({ linkId, dryRun: false }, OWNER), (e: unknown) => (e as { code?: string }).code === "conflict");
    assert.deepEqual(await bf.reverse({ linkId, dryRun: false }, OWNER), { count: 3 });
  });

  it("a reversal is authorized like an apply", async () => {
    const { engine, bf, h, linkId } = setup();
    await bf.run({ linkId, dryRun: false }, OWNER);
    await assert.rejects(bf.reverse({ linkId, dryRun: false }, h.self), (e: unknown) => (e as { code?: string }).code === "denied");
    assert.equal(engine.reverses.length, 0);
  });
});

describe("identity recall scope", () => {
  it("reads take the person's v2 followed by every approved v1 in link order, once each; writes take the v2 alone", () => {
    const f = fixture(); const h = f.human(); const scope = createRecallScopeProvider(f.svc);
    const a = { ...TG, userId: "1" }; const b = { ...TG, userId: "2" }; const c = { channel: "discord", accountId: "g", userId: "3" };
    for (const i of [a, b, c]) { f.pairAndLink(h.id, i); f.advance(1); }
    const v2 = deriveUserPrincipal(h.id);
    assert.deepEqual(scope.resolvePrincipals(v2), [v2, v1PrincipalOf(a), v1PrincipalOf(b), v1PrincipalOf(c)]);
    assert.equal(scope.capturePrincipal(v2), v2);
  });

  it("an unlinked identity leaves the union at once; the v2 stays; relinking brings it back", () => {
    const f = fixture(); const h = f.human(); const scope = createRecallScopeProvider(f.svc); const v2 = deriveUserPrincipal(h.id);
    const { linkId } = f.pairAndLink(h.id, TG);
    f.svc.unlink({ linkId }, OWNER);
    assert.deepEqual(scope.resolvePrincipals(v2), [v2]);
    f.pairAndLink(h.id, TG);
    assert.deepEqual(scope.resolvePrincipals(v2), [v2, v1PrincipalOf(TG)]);
  });

  it("another person's identities never appear in this person's union", () => {
    const f = fixture(); const a = f.human("A"); const b = f.human("B"); const scope = createRecallScopeProvider(f.svc);
    f.pairAndLink(a.id, TG); f.pairAndLink(b.id, { ...TG, userId: "2" });
    assert.deepEqual(scope.resolvePrincipals(deriveUserPrincipal(a.id)), [deriveUserPrincipal(a.id), v1PrincipalOf(TG)]);
    assert.equal(scope.resolvePrincipals(deriveUserPrincipal(b.id)).includes(v1PrincipalOf(TG)), false);
  });

  it("an unknown person is not-found, a malformed or v1 principal is invalid-params; capture accepts only a known v2", () => {
    const f = fixture(); const h = f.human(); const scope = createRecallScopeProvider(f.svc);
    const unknown = deriveUserPrincipal("00000000-0000-7000-8000-000000000000");
    refuses(() => scope.resolvePrincipals(unknown), "not-found"); refuses(() => scope.capturePrincipal(unknown), "not-found");
    for (const bad of ["", "user:v2:abc", deriveUserPrincipal(h.id).toUpperCase(), v1PrincipalOf(TG), `${deriveUserPrincipal(h.id)}\n`, ` ${deriveUserPrincipal(h.id)}`, 5 as never, null as never]) {
      refuses(() => scope.resolvePrincipals(bad), "invalid-params", undefined, String(bad)); refuses(() => scope.capturePrincipal(bad), "invalid-params", undefined, String(bad));
    }
  });
});
