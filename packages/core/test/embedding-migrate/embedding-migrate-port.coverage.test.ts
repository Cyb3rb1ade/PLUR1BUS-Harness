import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as port from "../../src/embedding-migrate/port.ts";
import type { EngineRecord, EngineState, ReembedEngine, SwitchPort } from "../../src/embedding-migrate/port.ts";
import type { EmbeddingFingerprint } from "../../src/embedding-migrate/probe.ts";
import { createFakeEngine, fp } from "./fake-engine.ts";

// port.ts holds only types: the module must load without runtime exports, and the fake engine used across the
// migration tests must satisfy the port's contract (one batch per apply/resume, optional validate, SwitchPort atomicity).
describe("embedding-migrate port contract", () => {
  it("is a types-only module: loading it yields no runtime exports", () => {
    assert.deepEqual(Object.keys(port), []);
  });

  it("the engine port has the documented shape (batchSize, plan, apply, resume, status; validate optional)", () => {
    const { engine } = createFakeEngine();
    assert.equal(typeof engine.batchSize, "number");
    for (const m of ["plan", "apply", "resume", "status"] as const) assert.equal(typeof engine[m], "function", m);
    assert.equal(typeof engine.validate, "function");
    const { engine: noValidate } = createFakeEngine({ withValidate: false });
    assert.equal(noValidate.validate, undefined);
  });

  it("status of an unknown id is null; plan yields a record in state planned with a confirmation token", async () => {
    const { engine } = createFakeEngine();
    assert.equal(await engine.status("nope"), null);
    const target: EmbeddingFingerprint = fp("b", 12);
    const p = await engine.plan({ id: "m1", target: { fingerprint: target } });
    assert.equal(p.plan.id, "m1");
    assert.ok(p.confirmation.token.length > 0);
    const r = (await engine.status("m1")) as EngineRecord;
    const state: EngineState = r.state;
    assert.equal(state, "planned");
    assert.equal(r.cursor.completedRows, 0);
  });

  it("apply runs exactly one batch per call and resume continues until validating", async () => {
    const { engine } = createFakeEngine({ rows: { t: 4 }, batchSize: 2 });
    const p = await engine.plan({ id: "m1", target: { fingerprint: fp("b", 12) } });
    const token = p.confirmation.token;
    const first = await engine.apply({ id: "m1", token });
    assert.equal(first.state, "running");
    assert.equal(first.cursor.completedRows, 2);
    const second = await engine.resume({ id: "m1", token });
    assert.equal(second.state, "validating");
    assert.equal(second.cursor.completedRows, 4);
    const v = await (engine as ReembedEngine).validate!({ id: "m1" });
    assert.equal(v.state, "ready_to_switch");
  });

  it("a wrong confirmation token is refused", async () => {
    const { engine } = createFakeEngine();
    await engine.plan({ id: "m1", target: { fingerprint: fp("b", 12) } });
    await assert.rejects(() => engine.apply({ id: "m1", token: "wrong" }), /invalid or expired reembedding confirmation/);
  });

  it("SwitchPort.apply takes generation, fingerprint and fingerprintId in one step", async () => {
    const sp: SwitchPort = { async apply() {} };
    const { switchPort, engine } = createFakeEngine();
    await engine.plan({ id: "m1", target: { fingerprint: fp("b", 12) } });
    await sp.apply({ generation: "x", fingerprint: fp("b", 12), fingerprintId: "id" });
    await switchPort.apply({ generation: "generation-m1", fingerprint: fp("b", 12), fingerprintId: "id" });
    assert.deepEqual(switchPort.applied, [{ generation: "generation-m1", fingerprint: fp("b", 12), fingerprintId: "id" }]);
  });
});
