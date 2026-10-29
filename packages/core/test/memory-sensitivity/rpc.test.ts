import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemorySensitivityStore } from "../../src/memory-sensitivity/store.ts";
import { MemorySensitivityService } from "../../src/memory-sensitivity/service.ts";
import { buildMemorySensitivityMethods } from "../../src/memory-sensitivity/rpc.ts";

describe("memory sensitivity RPC methods", () => {
  let tmpDir: string;
  let store: MemorySensitivityStore;
  let service: MemorySensitivityService;
  let handlers: ReturnType<typeof buildMemorySensitivityMethods>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-mem-sens-rpc-"));
    store = new MemorySensitivityStore({ path: join(tmpDir, "sens.sqlite") });
    service = new MemorySensitivityService({ store });
    handlers = buildMemorySensitivityMethods({ service });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("memory.sensitivity.get returns empty categories when no record exists", async () => {
    const res = await handlers["memory.sensitivity.get"]!({ id: "non-existent" }, {} as any);
    assert.deepEqual(res, { id: "non-existent", categories: [] });
  });

  it("memory.sensitivity.set validates parameters and stores sensitivity", async () => {
    await assert.rejects(
      handlers["memory.sensitivity.set"]!({ id: "" }, {} as any),
      (err: any) => err.error === "E_INVALID_PARAMS",
    );
    await assert.rejects(
      handlers["memory.sensitivity.set"]!({ id: "c1", categories: [] }, {} as any),
      (err: any) => err.error === "E_INVALID_PARAMS",
    );
    await assert.rejects(
      handlers["memory.sensitivity.set"]!({ id: "c1", categories: ["invalid-cat"] }, {} as any),
      (err: any) => err.error === "E_INVALID_PARAMS" && err.reason === "unknown-category",
    );

    const setRes = (await handlers["memory.sensitivity.set"]!(
      { id: "c1", categories: ["health", "financial"] },
      {} as any,
    )) as any;
    assert.equal(setRes.id, "c1");
    assert.deepEqual(setRes.categories, ["financial", "health"]);
    assert.equal(setRes.updated, true);

    const getRes = (await handlers["memory.sensitivity.get"]!({ id: "c1" }, {} as any)) as any;
    assert.equal(getRes.id, "c1");
    assert.deepEqual(getRes.categories, ["financial", "health"]);
    assert.equal(getRes.source, "manual");
  });

  it("memory.sensitivity.clear removes single category or all", async () => {
    await handlers["memory.sensitivity.set"]!({ id: "c2", categories: ["health", "credential"] }, {} as any);

    const clearOne = (await handlers["memory.sensitivity.clear"]!({ id: "c2", category: "health" }, {} as any)) as any;
    assert.equal(clearOne.cleared, true);
    assert.deepEqual(clearOne.remaining, ["credential"]);

    const clearAll = (await handlers["memory.sensitivity.clear"]!({ id: "c2" }, {} as any)) as any;
    assert.equal(clearAll.cleared, true);
    assert.deepEqual(clearAll.remaining, []);

    const getRes = (await handlers["memory.sensitivity.get"]!({ id: "c2" }, {} as any)) as any;
    assert.deepEqual(getRes, { id: "c2", categories: [] });
  });
});
