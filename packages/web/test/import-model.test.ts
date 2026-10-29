/** Source modes and preflight consent cannot silently widen an import request. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRequest,
  sourceRequest,
  terminalRun,
  importProgress,
  type SourceInput,
} from "../src/pages/import/model.ts";

const input: SourceInput = {
  family: "fixture",
  mode: "auto",
  path: "",
  profile: "",
  distro: "",
  stopped: false,
  probeStopped: false,
  connectionId: "",
  snapshotId: "",
};
test("source selection keeps detected, host, WSL, SSH and snapshot authority distinct", () => {
  assert.deepEqual(sourceRequest(input, false), { kind: "auto", family: "fixture" });
  assert.throws(() => sourceRequest({ ...input, mode: "path", path: "/private/source" }, false));
  assert.deepEqual(sourceRequest({ ...input, mode: "path", path: "/local/source", profile: "work" }, true), {
    kind: "path",
    family: "fixture",
    path: "/local/source",
    profile: "work",
  });
  assert.throws(() =>
    sourceRequest({ ...input, mode: "wsl", path: "/source", distro: "Fixture", stopped: true }, true),
  );
  assert.deepEqual(
    sourceRequest(
      { ...input, mode: "wsl", path: "/source", distro: "Fixture", stopped: true, probeStopped: true },
      true,
    ),
    { kind: "wsl", family: "fixture", path: "/source", distro: "Fixture", probeStopped: true },
  );
  assert.deepEqual(sourceRequest({ ...input, mode: "snapshot", snapshotId: "S".repeat(43) }, false), {
    kind: "snapshot",
    family: "fixture",
    snapshotId: "S".repeat(43),
  });
  assert.deepEqual(sourceRequest({ ...input, mode: "ssh", connectionId: "ssh-fixture", path: "/source" }, false), {
    kind: "ssh",
    family: "fixture",
    connectionId: "ssh-fixture",
    path: "/source",
  });
});
test("apply needs a fresh matching preflight and explicit downtime acceptance; it never invents a force option", () => {
  const plan = { planId: "plan", runId: "run" },
    preflight = { planId: "plan", runId: "run", ok: true, preflightId: "ticket", expiresAt: "2099-01-01T00:00:00Z" };
  assert.throws(() => applyRequest(plan, preflight, false));
  assert.throws(() => applyRequest(plan, { ...preflight, ok: false }, true));
  assert.throws(() => applyRequest(plan, { ...preflight, runId: "another" }, true));
  assert.throws(() => applyRequest(plan, { ...preflight, expiresAt: "2000-01-01T00:00:00Z" }, true));
  assert.deepEqual(applyRequest(plan, preflight, true), { planId: "plan", preflightId: "ticket" });
  assert.deepEqual(applyRequest(plan, preflight, true, true), { planId: "plan", preflightId: "ticket", resume: true });
  assert.equal(terminalRun("rolling-back"), false);
  assert.equal(terminalRun("aborted"), true);
});

test("progress metadata cannot switch runs or carry arbitrary source fields", () => {
  const progress = { runId: "owned", phase: "apply", completed: 2, total: 10 };
  assert.deepEqual(importProgress(JSON.stringify(progress), "owned"), progress);
  for (const value of [
    { ...progress, runId: "foreign" },
    { ...progress, sourcePath: "/host/private" },
    { ...progress, completed: -1 },
    { ...progress, phase: "arbitrary" },
  ])
    assert.equal(importProgress(JSON.stringify(value), "owned"), undefined);
  assert.equal(importProgress("x".repeat(4097), "owned"), undefined);
});

test("broad source discovery is explicit and keeps normal source inspection separate", async () => {
  const { sourceDetectionRequest } = await import("../src/pages/import/model.ts");
  const source = {
    family: "source",
    mode: "ssh" as const,
    path: "/",
    profile: "",
    distro: "",
    stopped: false,
    probeStopped: false,
    connectionId: "configured",
    snapshotId: "",
  };
  assert.deepEqual(sourceDetectionRequest(source, false, true), {
    discover: true,
    source: { kind: "ssh", family: "source", connectionId: "configured", path: "/" },
  });
  assert.deepEqual(sourceDetectionRequest(source, false), {
    source: { kind: "ssh", family: "source", connectionId: "configured", path: "/" },
  });
  for (const mode of ["snapshot", "auto"] as const)
    assert.throws(() => sourceDetectionRequest({ ...source, mode }, false, true));
  assert.throws(() => sourceDetectionRequest({ ...source, mode: "path" }, false, true));
});

test("abort responses preserve an explicit refusal and cannot target another run or invent pending state", async () => {
  const { importAbortResult } = await import("../src/pages/import/model.ts");
  for (const accepted of [false, true]) {
    const result = { runId: "owned", accepted, state: "restarting-core" as const };
    assert.deepEqual(importAbortResult(result, "owned"), result);
  }
  for (const result of [
    { runId: "other", accepted: true, state: "applying" },
    { runId: "owned", accepted: "false", state: "applying" },
    { runId: "owned", accepted: true, state: "made-up" },
    { runId: "owned", accepted: true, state: "applying", pending: true },
  ])
    assert.throws(() => importAbortResult(result, "owned"));
});
