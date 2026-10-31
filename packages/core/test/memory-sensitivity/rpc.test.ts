import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemorySensitivityStore } from "../../src/memory-sensitivity/store.ts";
import { MemorySensitivityService } from "../../src/memory-sensitivity/service.ts";
import { buildMemorySensitivityMethods } from "../../src/memory-sensitivity/rpc.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { RpcError } from "../../src/rpc/errors.ts";

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

  it("verifies card existence and ownership via engine.memory.show when configured", async () => {
    const memoryOpError = (code: string, message: string) => {
      const err = new Error(message);
      err.name = "MemoryOpError";
      (err as any).code = code;
      return err;
    };

    const cards = new Map<string, { id: string; ownerUserId: string }>([
      ["card-1", { id: "card-1", ownerUserId: "user-alice" }],
    ]);

    const mockEngine = {
      memory: {
        show: async (id: string, principal: any) => {
          const card = cards.get(id);
          if (!card) throw memoryOpError("not-found", "memory not found");
          if (principal?.userId && card.ownerUserId !== principal.userId) {
            throw memoryOpError("denied", "access denied to memory card");
          }
          return { id: card.id, text: "secret content", scope: "user" };
        },
      },
    };

    const auditSink = memoryAuditSink();
    const clock = () => 1700000000000;
    const guardedHandlers = buildMemorySensitivityMethods({
      service,
      engine: mockEngine as any,
      audit: auditSink,
      clock,
    });

    const aliceCtx = { principal: { userId: "user-alice", role: "member" } } as any;
    const bobCtx = { principal: { userId: "user-bob", role: "member" } } as any;

    // Non-existent card rejects with E_NOT_FOUND
    await assert.rejects(
      guardedHandlers["memory.sensitivity.get"]!({ id: "missing-card" }, aliceCtx),
      (err: any) => err.error === "E_NOT_FOUND" && err.reason === "not-found",
    );
    await assert.rejects(
      guardedHandlers["memory.sensitivity.set"]!({ id: "missing-card", categories: ["financial"] }, aliceCtx),
      (err: any) => err.error === "E_NOT_FOUND" && err.reason === "not-found",
    );
    await assert.rejects(
      guardedHandlers["memory.sensitivity.clear"]!({ id: "missing-card" }, aliceCtx),
      (err: any) => err.error === "E_NOT_FOUND" && err.reason === "not-found",
    );

    // Card owned by alice: bob is rejected with E_DENIED
    await assert.rejects(
      guardedHandlers["memory.sensitivity.get"]!({ id: "card-1" }, bobCtx),
      (err: any) => err.error === "E_DENIED" && err.reason === "denied",
    );
    await assert.rejects(
      guardedHandlers["memory.sensitivity.set"]!({ id: "card-1", categories: ["health"] }, bobCtx),
      (err: any) => err.error === "E_DENIED" && err.reason === "denied",
    );
    await assert.rejects(
      guardedHandlers["memory.sensitivity.clear"]!({ id: "card-1" }, bobCtx),
      (err: any) => err.error === "E_DENIED" && err.reason === "denied",
    );

    // Alice is authorized
    const getRes = (await guardedHandlers["memory.sensitivity.get"]!({ id: "card-1" }, aliceCtx)) as any;
    assert.deepEqual(getRes, { id: "card-1", categories: [] });

    const setRes = (await guardedHandlers["memory.sensitivity.set"]!(
      { id: "card-1", categories: ["personal", "financial"] },
      aliceCtx,
    )) as any;
    assert.equal(setRes.id, "card-1");
    assert.deepEqual(setRes.categories, ["financial", "personal"]);

    // Audit record for set
    assert.equal(auditSink.events.length, 1);
    const event0 = auditSink.events[0]!;
    assert.equal(event0.action, "memory.sensitivity.set");
    assert.equal(event0.target, "card-1");
    assert.equal(event0.actor.user, "user-alice");
    assert.equal(event0.at, 1700000000000);
    assert.deepEqual(event0.detail, {
      categories: ["financial", "personal"],
      source: "manual",
    });

    // Clear and verify audit record
    const clearRes = (await guardedHandlers["memory.sensitivity.clear"]!(
      { id: "card-1", category: "financial" },
      aliceCtx,
    )) as any;
    assert.equal(clearRes.cleared, true);
    assert.deepEqual(clearRes.remaining, ["personal"]);

    assert.equal(auditSink.events.length, 2);
    const event1 = auditSink.events[1]!;
    assert.equal(event1.action, "memory.sensitivity.clear");
    assert.equal(event1.target, "card-1");
    assert.equal(event1.actor.user, "user-alice");
    assert.equal(event1.at, 1700000000000);
    assert.deepEqual(event1.detail, {
      cleared: true,
      remaining: ["personal"],
      category: "financial",
    });
  });
});
