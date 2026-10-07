import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createPermissionRuntime } from "../../src/approvals/runtime.ts";
import { staticKeySource, type ChainKeySource } from "../../src/approvals/keys.ts";
import { createPolicyAudit } from "../../src/policy/audit.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import { FakeClock, KEY, askFor, dbFile, tick } from "./service-helpers.ts";

const T = { timeout: 20_000 };

function make(o: { keys?: ChainKeySource } = {}) {
  const path = dbFile();
  const clock = new FakeClock();
  const events: string[] = [];
  const loads = { n: 0 };
  const keys: ChainKeySource = o.keys ?? { load: async () => { loads.n += 1; return staticKeySource(KEY).load(); } };
  const rt = createPermissionRuntime({
    dbPath: path, keys, clock, audit: createPolicyAudit({ sink: memoryAuditSink(), clock, host: "h" }),
    events: { emit: (name) => { events.push(name); } },
  });
  return { rt, path, clock, events, loads };
}

describe("permission runtime: stores open on first use", () => {
  it("nothing is created or read until open(); concurrent first uses share one open", T, async () => {
    const { rt, path, loads } = make();
    assert.equal(existsSync(path), false);
    assert.equal(rt.isOpen(), false);
    assert.equal(rt.current(), null);
    const [a, b] = await Promise.all([rt.open(), rt.open()]);
    assert.equal(a, b);
    assert.equal(loads.n, 1);
    assert.equal(rt.isOpen(), true);
    assert.equal(existsSync(path), true);
    assert.equal(await rt.open(), a);
    assert.equal(rt.current(), a);
    await rt.close();
  });

  it("a failed open (key unavailable) rejects and is retried by the next use", T, async () => {
    let fail = true;
    const { rt } = make({ keys: { load: async () => { if (fail) throw new Error("keychain locked"); return staticKeySource(KEY).load(); } } });
    await assert.rejects(rt.open(), /keychain locked/);
    assert.equal(rt.isOpen(), false);
    fail = false;
    assert.ok(await rt.open());
    await rt.close();
  });

  it("the service announces through the injected events; close() ends waiting calls as not approved and closes the database", T, async () => {
    const { rt, events } = make();
    const { service, stores } = await rt.open();
    const pending = service.request(askFor({ actionHash: "ab".padEnd(64, "0") }));
    await tick();
    assert.deepEqual(events, ["approval.requested"]);
    await rt.close();
    assert.equal((await pending).approved, false);
    assert.throws(() => stores.db.prepare("SELECT 1").get(), /not open|closed/i);
    assert.equal(rt.isOpen(), false);
  });

  it("after close() nothing opens again (E_NOT_AVAILABLE stopping); a close during a slow open leaves nothing open", T, async () => {
    const a = make();
    await a.rt.close();
    await assert.rejects(a.rt.open(), (e: unknown) => e instanceof RpcError && e.error === "E_NOT_AVAILABLE" && e.reason === "stopping");

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const b = make({ keys: { load: async () => { await gate; return staticKeySource(KEY).load(); } } });
    const opening = b.rt.open();
    const closing = b.rt.close();
    release();
    await assert.rejects(opening, (e: unknown) => e instanceof RpcError && e.reason === "stopping");
    await closing;
    assert.equal(b.rt.isOpen(), false);
  });

  it("close() on a runtime that never opened is a no-op", T, async () => {
    const { rt, path } = make();
    await rt.close();
    assert.equal(existsSync(path), false);
  });
});
