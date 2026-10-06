import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEnginePort, ENGINE_BATCH_SIZE } from "../../src/embedding-migrate/engine-port.ts";

const fpA = { provider: "local-transformers", model: "a", revision: "r".repeat(40), dimensions: 384 };
const fpB = { ...fpA, model: "b" };
const record = (state = "running", over: Record<string, unknown> = {}) => ({
  id: "m1", state, revision: 3, planDigest: "sha256:x", confirmation: { tokenHash: "h" }, receipts: { secret: "no" },
  cursor: { tableIndex: 0, offset: 8, completedRows: 8, providerCalls: 1, bytes: 800 },
  source: { generation: "g0", fingerprintId: "A", fingerprint: fpA, configRevision: null, tables: [{ tableId: "memories", version: "1", rowCount: 20, estimatedBytes: 2000 }] },
  target: { generation: "generation-m1", fingerprintId: "B", fingerprint: fpB, probeStatus: "passed" }, error: null, ...over,
});
const planResult = () => ({
  plan: { id: "m1", source: record().source, target: record().target, estimates: { rows: 20, providerCalls: 20, sourceBytes: 2000, targetBytes: 5000, requiredFreeBytes: 6250, freeBytes: 1e9 } },
  planDigest: "sha256:" + "a".repeat(64), confirmation: { token: "reemb_v1_tok", persisted: { tokenHash: "h" } }, record: record("planned"),
});
function stubEngine(extra: Record<string, unknown> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const mk = (name: string, ret: () => unknown) => (...args: unknown[]) => { calls.push({ name, args }); return Promise.resolve(ret()); };
  const reembedding = { plan: mk("plan", planResult), apply: mk("apply", () => record()), resume: mk("resume", () => record("validating")), status: mk("status", () => record()), rollback: mk("rollback", () => null), switch: mk("switch", () => null), ...extra };
  return { engine: { admin: { reembedding } } as never, calls };
}

describe("engine port over Engine.admin.reembedding", () => {
  it("passes the coordinator's argument shapes and projects the answers", async () => {
    const { engine, calls } = stubEngine(); const port = createEnginePort(engine);
    assert.equal(port.batchSize, ENGINE_BATCH_SIZE);
    const plan = await port.plan({ id: "m1", target: { fingerprint: fpB as never }, confirmationTtlMs: 3_600_000 });
    assert.deepEqual(calls[0], { name: "plan", args: [{ id: "m1", target: { fingerprint: fpB }, confirmationTtlMs: 3_600_000 }] });
    assert.equal(plan.confirmation.token, "reemb_v1_tok"); assert.equal(plan.plan.estimates.rows, 20);
    assert.ok(!("persisted" in plan.confirmation), "the engine's persisted confirmation is not carried");
    const rec = await port.apply({ id: "m1", token: "reemb_v1_tok" });
    assert.deepEqual(calls[1], { name: "apply", args: [{ id: "m1", token: "reemb_v1_tok" }] });
    assert.equal(rec.state, "running"); assert.equal(rec.cursor.completedRows, 8);
    assert.ok(!("receipts" in rec) && !("confirmation" in rec) && !("planDigest" in rec), "only the fields the driver reads");
    assert.equal((await port.resume({ id: "m1", token: "reemb_v1_tok" })).state, "validating");
    assert.deepEqual(calls[2], { name: "resume", args: [{ id: "m1", token: "reemb_v1_tok" }] });
    assert.equal((await port.status("m1"))?.id, "m1"); assert.deepEqual(calls[3], { name: "status", args: ["m1"] });
  });

  it("status of an unknown migration is null", async () => {
    const { engine } = stubEngine({ status: () => Promise.resolve(undefined) });
    assert.equal(await createEnginePort(engine).status("nope"), null);
  });

  it("the pinned contract has no validate: the port does not pretend to; with one it is exposed", async () => {
    assert.equal("validate" in createEnginePort(stubEngine().engine), false);
    const validateCalls: unknown[][] = [];
    const { engine } = stubEngine({ validate: (...args: unknown[]) => { validateCalls.push(args); return Promise.resolve(record("ready_to_switch")); } });
    const port = createEnginePort(engine);
    assert.equal((await port.validate!({ id: "m1" })).state, "ready_to_switch"); assert.deepEqual(validateCalls, [[{ id: "m1" }]]);
  });

  it("a malformed engine answer is an error, never a half-trusted record", async () => {
    for (const bad of [null, "x", { id: "m1", state: "bogus", cursor: {}, source: {}, target: {} }, { ...record(), cursor: { tableIndex: -1 } }]) {
      const { engine } = stubEngine({ apply: () => Promise.resolve(bad) });
      await assert.rejects(createEnginePort(engine).apply({ id: "m1", token: "t" }), /malformed/);
    }
    const { engine } = stubEngine({ plan: () => Promise.resolve({ plan: {} }) });
    await assert.rejects(createEnginePort(engine).plan({ id: "m1", target: { fingerprint: fpB as never } }), /malformed/);
  });

  it("engine errors propagate with their own message (the driver classifies them)", async () => {
    const { engine } = stubEngine({ resume: () => Promise.reject(new Error("reembedding source version drift: memories")) });
    await assert.rejects(createEnginePort(engine).resume({ id: "m1", token: "t" }), /source version drift/);
  });
});
