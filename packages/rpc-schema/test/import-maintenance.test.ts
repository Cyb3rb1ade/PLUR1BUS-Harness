import test from "node:test";
import assert from "node:assert/strict";
import { METHODS_BY_SERVER, validateNotification, validateParams, validateResult } from "../src/index.ts";

const id = "00000000-0000-4000-8000-000000000001";
const digest = "a".repeat(64);

test("import detects only closed source descriptors without supplied authority", () => {
  const source = { kind: "snapshot", family: "fixture", snapshotId: "A".repeat(43) };
  assert.equal(validateParams("admin.import.detect", { source }).ok, true);
  for (const extra of [{ path: "/host" }, { ownerId: "owner" }, { privateKey: "synthetic" }]) {
    assert.equal(validateParams("admin.import.detect", { source: { ...source, ...extra } }).ok, false);
  }
  assert.equal(validateParams("admin.import.detect", { source: { ...source, snapshotId: "../outside" } }).ok, false);
});

test("preflight and maintenance operations bind immutable IDs with no override channels", () => {
  assert.equal(validateParams("admin.import.preflight", { planId: id, operation: "rollback" }).ok, true);
  assert.equal(validateParams("admin.import.apply", { planId: id, preflightId: id, resume: true }).ok, true);
  assert.equal(validateParams("admin.import.rollback", { runId: id, preflightId: id }).ok, true);
  assert.equal(validateParams("admin.import.apply", { planId: id, preflightId: id, migrateSecrets: true }).ok, false);
  assert.equal(validateParams("admin.import.rollback", { runId: id, preflightId: id, force: true }).ok, false);
  assert.equal(validateParams("admin.import.runs", { limit: 101 }).ok, false);
  for (const method of ["apply", "status", "abort", "runs", "rollback"]) {
    assert.equal(METHODS_BY_SERVER.supervisor.includes(`admin.import.${method}`), true);
  }
  assert.equal(METHODS_BY_SERVER.core.includes("admin.import.skills"), true);
});

test("progress and run results cannot project source paths or secrets", () => {
  const progress = { runId: id, phase: "apply", completed: 2, total: 3, entity: "memory" };
  assert.equal(validateNotification("import.progress", progress).ok, true);
  assert.equal(validateNotification("import.progress", { ...progress, path: "/private/source" }).ok, false);
  const run = { runId: id, planId: id, sourceType: "fixture", state: "completed", attempt: 1,
    createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z",
    restored: false, resumable: false, rollbackAvailable: true,
    report: { schema: "import.report/1", sha256: digest, bytes: 10 } };
  assert.equal(validateResult("admin.import.status", { run }).ok, true);
  assert.equal(validateResult("admin.import.status", { run: { ...run, config: { token: "synthetic" } } }).ok, false);
});

test("SSH setup admits public identity and probe metadata without key values", () => {
  assert.equal(validateParams("admin.import.ssh.key.generate", {}).ok, true);
  assert.equal(validateParams("admin.import.ssh.key.generate", { privateKey: "synthetic" }).ok, false);
  const connection = { id: "source", host: "source.invalid", user: "reader", roots: ["/home/reader"] };
  assert.equal(validateParams("admin.import.ssh.connections.set", { connection }).ok, true);
  assert.equal(validateParams("admin.import.ssh.connections.set", { connection: { ...connection, privateKey: "synthetic" } }).ok, false);
  const trust = { connectionId: "source", probeId: "A".repeat(43), hostKeySha256: `SHA256:${"A".repeat(43)}` };
  assert.equal(validateParams("admin.import.ssh.hostKey.trust", trust).ok, true);
  assert.equal(validateParams("admin.import.ssh.hostKey.trust", { ...trust, trustAny: true }).ok, false);
  assert.equal(validateResult("admin.import.ssh.key.status", { configured: false }).ok, true);
  assert.equal(validateResult("admin.import.ssh.key.status", { configured: true, privateKey: "synthetic" }).ok, false);
});
