// RE-D166/R1: the fixed texts the Rust engine sends for re-embedding failures, as the EngineClient turns them into
// errors (RpcError with the wire's code, message and reason), go through the driver's own classification. The texts
// come from the fixture the Rust allowlist is checked against, so both sides read the same list.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMigrationDriver, MigrationError } from "../../src/embedding-migrate/driver.ts";
import { createStateStore } from "../../src/embedding-migrate/state.ts";
import type { ReembedEngine } from "../../src/embedding-migrate/port.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import { createFakeEngine, fp } from "./fake-engine.ts";

interface Entry { text: string; error: "E_CONFLICT" | "E_INVALID_PARAMS"; reason: string; outcome: string }
const fixture = JSON.parse(readFileSync(new URL("../../../../crates/plur1bus-engine/tests/fixtures/ops/reembedding-wire-errors.json", import.meta.url), "utf8")) as { errors: Entry[] };
const wire = (e: { text: string; error: Entry["error"]; reason: string }) => new RpcError(e.error, e.text, { reason: e.reason });
const target = fp("b", 12);
const codeOf = (e: unknown) => (e instanceof MigrationError ? e.code : String(e));

/** A driver over the fake engine whose `plan` or `resume` answers once with `failure` (a Rust wire error). */
function rig(at: "plan" | "resume", failure: Error) {
  const dir = mkdtempSync(path.join(tmpdir(), "p1-reembed-wire-"));
  const clock = 1_000;
  const fake = createFakeEngine({ now: () => clock });
  let fired = false;
  const once = <T>(call: () => Promise<T>): Promise<T> => { if (fired) return call(); fired = true; return Promise.reject(failure); };
  const engine: ReembedEngine = {
    ...fake.engine,
    plan: (req) => (at === "plan" ? once(() => fake.engine.plan(req)) : fake.engine.plan(req)),
    resume: (a) => (at === "resume" ? once(() => fake.engine.resume(a)) : fake.engine.resume(a)),
  };
  const driver = createMigrationDriver({
    newId: () => "m1", engine, store: createStateStore(dir), switchPort: fake.switchPort, now: () => clock, sleep: async () => {},
  });
  return { driver, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("Rust engine wire errors through the migration driver", () => {
  it("the fixture lists the seven fixed texts and their classes", () => {
    assert.equal(fixture.errors.length, 7);
    assert.deepEqual([...new Set(fixture.errors.map((e) => e.outcome))].sort(), ["compatible", "confirmation-invalid", "migration-active", "source-drift"]);
  });

  for (const entry of fixture.errors.filter((e) => e.outcome === "source-drift" || e.outcome === "confirmation-invalid")) {
    it(`a run answered "${entry.text}" fails for good as ${entry.outcome}`, async () => {
      const r = rig("resume", wire(entry)); try {
        await r.driver.plan({ target, throttleMs: 0 });
        const cp = await r.driver.run();
        assert.equal(cp.phase, "failed");
        assert.equal(cp.error?.code, entry.outcome);
      } finally { r.done(); }
    });
  }

  for (const entry of fixture.errors.filter((e) => e.outcome === "compatible")) {
    it(`a plan answered "${entry.text}" is compatible: nothing to migrate`, async () => {
      const r = rig("plan", wire(entry)); try {
        const out = await r.driver.plan({ target });
        assert.equal(out.plan, null);
        assert.equal(out.probe.verdict, "compatible");
      } finally { r.done(); }
    });
  }

  for (const entry of fixture.errors.filter((e) => e.outcome === "migration-active")) {
    it(`a plan answered "${entry.text}" is migration-active with its expiry, not a refused plan`, async () => {
      const r = rig("plan", wire(entry)); try {
        await assert.rejects(r.driver.plan({ target }), (e) => codeOf(e) === "migration-active" && /at most an hour/.test((e as Error).message));
      } finally { r.done(); }
    });
  }

  it("without the fixed text (the previous generic answer) a run only halts, resumably", async () => {
    const r = rig("resume", wire({ text: "engine memory operation failed", error: "E_CONFLICT", reason: "conflict" })); try {
      await r.driver.plan({ target, throttleMs: 0 });
      const cp = await r.driver.run();
      assert.equal(cp.phase, "aborted");
      assert.equal(cp.error?.code, "engine-error");
    } finally { r.done(); }
  });
});
