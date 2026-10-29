/** Failed preflight must report every independent refusal without requesting Core shutdown. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const HASH = "a".repeat(64);
const PLAN = "a273a7f8-c30b-45f4-b679-1ab450b1d9fc";
const RUN = "001a0053-1531-4baf-b280-6535a6c6c760";
const MARKER = "fixture-preflight-source-or-secret-must-not-leak";

async function factory() {
  const module = await import("../../src/import/maintenance-preflight.ts").catch(() => undefined);
  assert.equal(typeof module?.preflightImport, "function", "maintenance requires a live-Core preflight");
  return module!;
}

function plan() {
  return { planId: PLAN, runId: RUN, sourceSha256: HASH, unresolvedConflicts: 0, migrateSecrets: false,
    importBytes: 1000, coldBytes: 2000, entities: 10 };
}

function ports() {
  return {
    sourceFingerprint: async () => HASH,
    dryRun: async () => ({ readable: true, parsed: true, configValid: true }),
    storage: async () => ({ availableBytes: 1_000_000_000, writable: true, foreignLock: false,
      completeCoverage: true, exclusiveWriter: true }),
    store: async () => ({ supported: true }),
    model: async () => ({ present: true, licenceAccepted: true }),
    secrets: async () => ({ available: true }),
  };
}

describe("live Core import preflight", () => {
  it("collects source, conflict, parse, config, disk, lock, schema, model, licence and secret refusals", async () => {
    const api = await factory();
    const result = await api.preflightImport({ ...plan(), unresolvedConflicts: 2, migrateSecrets: true,
      reembed: { model: "chosen-model" } }, {
      ...ports(), sourceFingerprint: async () => "b".repeat(64),
      dryRun: async () => ({ readable: false, parsed: false, configValid: false }),
      storage: async () => ({ availableBytes: 0, writable: false, foreignLock: true,
        completeCoverage: false, exclusiveWriter: false }),
      store: async () => ({ supported: false }),
      model: async () => ({ present: false, licenceAccepted: false }),
      secrets: async () => ({ available: false }),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map(issue => issue.reason).sort(), ["source-changed", "unanswered-conflicts",
      "source-unreadable", "source-parse-failed", "config-invalid", "insufficient-disk", "target-permissions",
      "busy", "incomplete-rollback-coverage", "exclusive-writer-unproven", "store-schema-unsupported",
      "embedding-model-unavailable", "model-licence-required", "secret-store-unavailable"].sort());
    assert.equal(result.preflightId, undefined);
    assert.equal(result.automaticRollback, false);
  });

  it("returns a bounded downtime and space estimate only after all running-Core checks succeed", async () => {
    const api = await factory();
    const result = await api.preflightImport(plan(), ports());
    assert.equal(result.ok, true);
    assert.equal(result.automaticRollback, true);
    assert.deepEqual(result.issues, []);
    assert.ok(result.requiredBytes >= 64 * 1024 * 1024 + 3000);
    assert.ok(result.estimatedDowntimeMs > 0);
    assert.equal(result.planId, PLAN);
    assert.equal(result.runId, RUN);
  });

  it("does not invoke optional backends unless requested and replaces backend exceptions with fixed reasons", async () => {
    const api = await factory();
    const result = await api.preflightImport(plan(), { ...ports(),
      sourceFingerprint: async () => { throw new Error(MARKER); },
      model: async () => { assert.fail("no reembedding requested"); },
      secrets: async () => { assert.fail("no secrets requested"); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.issues[0]?.reason, "source-unreadable");
    assert.ok(!JSON.stringify(result).includes(MARKER));
  });

  it("refuses an estimated operation exceeding the native maintenance budget before issuing a ticket", async () => {
    const api = await factory();
    const result = await api.preflightImport({ ...plan(), entities: 200_000 }, ports());
    assert.equal(result.ok, false);
    assert.ok(result.estimatedDowntimeMs > 60 * 60 * 1000);
    assert.ok(result.issues.some(issue => issue.reason === "maintenance-time-limit"));
  });

  it("bounds a nonresponding preflight port and returns only fixed metadata", async () => {
    const api = await factory();
    const result = await Promise.race([
      api.preflightImport(plan(), { ...ports(), sourceFingerprint: () => new Promise(() => {}) }, { timeoutMs: 10 }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("preflight remained pending")), 250)),
    ]);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.reason === "source-unreadable"));
  });
});
