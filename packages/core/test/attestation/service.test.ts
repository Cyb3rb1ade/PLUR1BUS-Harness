import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAttestationService, MAX_ATTEST_TTL_MS } from "../../src/attestation/index.ts";
import type { PolicyAuditAction, PolicyAuditFields } from "../../src/policy/audit.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-attest.mjs", import.meta.url));
const HASH = "ab".padEnd(64, "0");
const T = { timeout: 20_000 };

function rig(mode: string, arg?: string, o: { ttlMs?: number; nonces?: string[] } = {}) {
  const audit: { action: PolicyAuditAction; fields: PolicyAuditFields }[] = [];
  const nonces = [...(o.nonces ?? [])];
  const svc = createAttestationService({
    helper: { path: process.execPath, args: [FAKE, mode, ...(arg !== undefined ? [arg] : [])] },
    audit: { record: (action, fields) => { audit.push({ action, fields }); } },
    ...(o.ttlMs !== undefined ? { ttlMs: o.ttlMs } : {}),
    ...(nonces.length ? { newNonce: () => nonces.shift() ?? "n-fallback" } : {}),
  });
  return { svc, audit };
}
const ask = (extra: Partial<{ actionHash: string; ttlMs: number }> = {}) => ({ actionHash: HASH, text: "Allow agent bernd to run shell.exec for this session", person: "christian", ...extra });

describe("attestation service", () => {
  it("returns method and time when the helper confirms, and binds the request to nonce and action hash", T, async () => {
    const log = join(mkdtempSync(join(tmpdir(), "att-")), "req.log");
    const { svc } = rig("log", log, { nonces: ["n1"] });
    const r = await svc.attest(ask());
    assert.equal(r.ok, true);
    if (r.ok) { assert.equal(r.method, "fake-biometric"); assert.equal(typeof r.at, "number"); }
    const seen = JSON.parse(readFileSync(log, "utf8").trim());
    assert.equal(seen.nonce, "n1");
    assert.equal(seen.actionHash, HASH);
    assert.equal(seen.text, "Allow agent bernd to run shell.exec for this session");
    assert.ok(seen.ttlMs <= MAX_ATTEST_TTL_MS && seen.ttlMs > 0);
  });

  it("clamps the lifetime to 60 s whatever the caller asks for", T, async () => {
    const log = join(mkdtempSync(join(tmpdir(), "att-")), "req.log");
    const { svc } = rig("log", log);
    await svc.attest(ask({ ttlMs: 10 * 60_000 }));
    assert.equal(JSON.parse(readFileSync(log, "utf8").trim()).ttlMs, MAX_ATTEST_TTL_MS);
  });

  it("maps a cancelled dialog to cancelled", T, async () => {
    assert.deepEqual(await rig("cancel").svc.attest(ask()), { ok: false, reason: "cancelled" });
  });

  it("kills a helper that does not answer in time and reports timeout", T, async () => {
    const { svc } = rig("timeout", undefined, { ttlMs: 300 });
    const t0 = Date.now();
    assert.deepEqual(await svc.attest(ask()), { ok: false, reason: "timeout" });
    assert.ok(Date.now() - t0 < 5000);
  });

  it("refuses a reply that carries a nonce it never issued (mismatch)", T, async () => {
    const r = await rig("nonce", "forged", { nonces: ["n1"] }).svc.attest(ask());
    assert.deepEqual(r, { ok: false, reason: "mismatch" });
  });

  it("refuses the replay of a nonce that was already consumed", T, async () => {
    const svc = createAttestationService({ helper: { path: process.execPath, args: [FAKE, "nonce", "n1"] }, newNonce: (() => { const q = ["n1", "n2"]; return () => q.shift()!; })() });
    assert.equal((await svc.attest(ask())).ok, true); // n1 echoed for n1: fine, consumed now
    assert.deepEqual(await svc.attest(ask()), { ok: false, reason: "replay" }); // issued n2, helper replays n1
  });

  it("refuses a reply bound to another action hash", T, async () => {
    assert.deepEqual(await rig("hash", "cd".padEnd(64, "0")).svc.attest(ask()), { ok: false, reason: "mismatch" });
  });

  it("refuses a confirmation whose time is outside the attempt's window", T, async () => {
    assert.deepEqual(await rig("early").svc.attest(ask()), { ok: false, reason: "mismatch" });
  });

  it("reports unavailable when the helper says so, is missing, is relative, or crashes or garbles its answer", T, async () => {
    assert.deepEqual(await rig("unavailable").svc.attest(ask()), { ok: false, reason: "unavailable" });
    for (const path of ["relative/attest", join(tmpdir(), "no-such-attest-helper")]) {
      const svc = createAttestationService({ helper: { path } });
      assert.deepEqual(await svc.attest(ask()), { ok: false, reason: "unavailable" });
    }
    assert.deepEqual(await createAttestationService({ helper: null }).attest(ask()), { ok: false, reason: "unavailable" });
    assert.deepEqual(await rig("crash").svc.attest(ask()), { ok: false, reason: "failed" });
    assert.deepEqual(await rig("garbage").svc.attest(ask()), { ok: false, reason: "failed" });
  });

  it("a nonce is never reused across attempts", T, async () => {
    const log = join(mkdtempSync(join(tmpdir(), "att-")), "req.log");
    const { svc } = rig("log", log);
    await svc.attest(ask()); await svc.attest(ask());
    const [a, b] = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).nonce);
    assert.notEqual(a, b);
    assert.ok(String(a).length >= 32);
  });

  it("audits the request and the outcome of success, cancel and failure, without the nonce", T, async () => {
    for (const [mode, outcome] of [["ok", "confirmed"], ["cancel", "cancelled"], ["crash", "failed"]] as const) {
      const { svc, audit } = rig(mode, undefined, { nonces: ["secret-nonce-1"] });
      await svc.attest(ask());
      assert.deepEqual(audit.map((a) => a.action), ["attestation.requested", "attestation.result"], mode);
      assert.equal(audit[1]!.fields.attestationOutcome, outcome);
      assert.equal(audit[0]!.fields.actionHash, HASH);
      assert.ok(!JSON.stringify(audit).includes("secret-nonce-1"));
    }
  });

  it("probe: available with a method, or unavailable with a reason; never shows a dialog", T, async () => {
    assert.deepEqual(await rig("ok").svc.probe(), { available: true, method: "fake-biometric" });
    assert.deepEqual(await rig("unavailable").svc.probe(), { available: false, reason: "unavailable" });
    assert.deepEqual(await createAttestationService({ helper: null }).probe(), { available: false, reason: "unavailable" });
    assert.ok(existsSync(FAKE));
  });
});
