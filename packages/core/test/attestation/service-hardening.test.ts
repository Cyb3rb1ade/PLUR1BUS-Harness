import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHelper } from "./fixtures/pinned-fake.ts";
import { scriptedHelper } from "./fixtures/scripted-pinned.ts";
import { createAttestationService, MAX_ATTEST_TTL_MS } from "../../src/attestation/index.ts";
import type { PolicyAuditAction, PolicyAuditFields } from "../../src/policy/audit.ts";

const HASH = "ab".padEnd(64, "0");
const T = { timeout: 20_000 };
const ask = (extra: Partial<{ actionHash: string; ttlMs: number }> = {}) => ({ actionHash: HASH, text: "Allow agent bernd to run shell.exec for this session", person: "christian", ...extra });
/** The reply a well-behaved helper gives; `at` is stamped now, so it sits inside the core's window for an injected clock at now. */
const good = (over: Record<string, unknown> = {}) => ({ v: 1, ok: true, method: "scripted", at: Date.now(), nonce: "$nonce", actionHash: "$hash", ...over });
const recorder = (throwOn?: PolicyAuditAction) => {
  const audit: { action: PolicyAuditAction; fields: PolicyAuditFields }[] = [];
  return { audit, record: { record: (action: PolicyAuditAction, fields: PolicyAuditFields) => { if (action === throwOn) throw new Error("audit sink full"); audit.push({ action, fields }); } } };
};
/** Whether `pid` is gone. Each loop turn yields to the event loop, which is where the parent reaps a killed child. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 2000; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return false;
}
const posix = { skip: process.platform === "win32" };

describe("attestation service: request and result recording", () => {
  it("never shows a dialog when the request cannot be recorded first", T, async () => {
    const log = join(mkdtempSync(join(tmpdir(), "att-h-")), "req.log");
    const svc = createAttestationService({ helper: fakeHelper("log", log), audit: recorder("attestation.requested").record });
    assert.deepEqual(await svc.attest(ask()), { ok: false, reason: "failed" });
    assert.equal(existsSync(log), false, "the helper must not run for an unrecorded request");
  });

  it("still returns the outcome when the result cannot be recorded", T, async () => {
    const svc = createAttestationService({ helper: fakeHelper("ok"), audit: recorder("attestation.result").record });
    const r = await svc.attest(ask());
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.method, "fake-biometric");
  });

  it("records the request and the result without the confirmation text", T, async () => {
    const { audit, record } = recorder();
    const svc = createAttestationService({ helper: fakeHelper("ok"), audit: record });
    await svc.attest(ask());
    assert.equal(audit.length, 2);
    assert.ok(!JSON.stringify(audit).includes("Allow agent bernd"), "the prompt text is not audited");
    assert.equal(audit[1]!.fields.method, "fake-biometric");
  });
});

describe("attestation service: lifetime", () => {
  it("raises a zero or negative lifetime to the 1 ms floor, so no helper can answer in time", T, async () => {
    for (const ttlMs of [0, -5_000]) {
      assert.deepEqual(await createAttestationService({ helper: fakeHelper("ok") }).attest(ask({ ttlMs })), { ok: false, reason: "timeout" }, String(ttlMs));
    }
  });

  it("gives a request without a lifetime the 60 s default", T, async () => {
    const log = join(mkdtempSync(join(tmpdir(), "att-l-")), "req.log");
    await createAttestationService({ helper: fakeHelper("log", log) }).attest(ask());
    assert.equal(JSON.parse(readFileSync(log, "utf8").trim()).ttlMs, MAX_ATTEST_TTL_MS);
  });

  it("clamps the service default to the 60 s ceiling as well", T, async () => {
    const log = join(mkdtempSync(join(tmpdir(), "att-l-")), "req.log");
    const svc = createAttestationService({ helper: fakeHelper("log", log), ttlMs: 10 * 60_000 });
    await svc.attest(ask());
    assert.equal(JSON.parse(readFileSync(log, "utf8").trim()).ttlMs, MAX_ATTEST_TTL_MS);
  });

  it("kills a hung helper at its deadline, so the process is gone afterwards", T, async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "att-pid-")), "pid");
    const svc = createAttestationService({ helper: scriptedHelper({ $hang: true }, { ATTEST_PID_FILE: pidFile }), ttlMs: 3_000 });
    assert.deepEqual(await svc.attest(ask()), { ok: false, reason: "timeout" });
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.equal(await gone(pid), true, `helper ${pid} still running after its deadline`);
  });
});

describe("attestation service: clock window", () => {
  const T0 = Date.now();
  const at = T0 + 100; // what the helper stamps; the core's clock is what moves
  const withClock = (now: number) => createAttestationService({ helper: scriptedHelper(good({ at })), now: () => now });

  it("accepts a confirmation whose time is within the 2 s skew of the core's clock", T, async () => {
    assert.equal((await withClock(T0 - 1_000).attest(ask())).ok, true, "core one second behind");
    assert.equal((await withClock(T0 + 1_000).attest(ask())).ok, true, "core one second ahead");
  });

  it("refuses a confirmation stamped further than the skew before or after the attempt", T, async () => {
    assert.deepEqual(await withClock(T0 - 5_000).attest(ask()), { ok: false, reason: "mismatch" }, "core five seconds behind");
    assert.deepEqual(await withClock(T0 + 5_000).attest(ask()), { ok: false, reason: "mismatch" }, "core five seconds ahead");
  });
});

describe("attestation service: malformed replies", () => {
  const run = (reply: Record<string, unknown>) => createAttestationService({ helper: scriptedHelper(reply) }).attest(ask());

  it("refuses a reply without its nonce, or without its action hash, or without its time", T, async () => {
    assert.deepEqual(await run(good({ $omit: ["nonce"] })), { ok: false, reason: "mismatch" });
    assert.deepEqual(await run(good({ $omit: ["actionHash"] })), { ok: false, reason: "mismatch" });
    assert.deepEqual(await run(good({ $omit: ["at"] })), { ok: false, reason: "mismatch" });
  });

  it("fails a reply of another protocol version, or one with no version at all", T, async () => {
    assert.deepEqual(await run(good({ v: 2 })), { ok: false, reason: "failed" });
    assert.deepEqual(await run({}), { ok: false, reason: "failed" });
  });

  it("fails a confirmation whose method label is not a short slug", T, async () => {
    for (const method of ["Fake Biometric", "x".repeat(40), "-leading", ""]) {
      assert.deepEqual(await run(good({ method })), { ok: false, reason: "failed" }, JSON.stringify(method));
    }
  });

  it("maps the helper's own reasons: timeout stays timeout, an unknown reason is a failure", T, async () => {
    assert.deepEqual(await run({ v: 1, ok: false, reason: "timeout", nonce: "$nonce" }), { ok: false, reason: "timeout" });
    assert.deepEqual(await run({ v: 1, ok: false, reason: "something-new", nonce: "$nonce" }), { ok: false, reason: "failed" });
  });
});

describe("attestation helper pinning, seen through attest()", () => {
  it("is unavailable for a helper that is group- or world-writable, or in an open directory, or a link", posix, async () => {
    const dir = mkdtempSync(join(tmpdir(), "att-pin-"));
    const loose = join(dir, "loose");
    writeFileSync(loose, "#!/bin/sh\n");
    chmodSync(loose, 0o775);
    const open = mkdtempSync(join(tmpdir(), "att-open-"));
    const openHelper = join(open, "helper");
    writeFileSync(openHelper, "#!/bin/sh\n");
    chmodSync(openHelper, 0o755);
    chmodSync(open, 0o777);
    const link = join(dir, "link");
    symlinkSync(fakeHelper("ok").path, link);
    for (const path of [loose, openHelper, link]) {
      const svc = createAttestationService({ helper: { path } });
      assert.deepEqual(await svc.attest(ask()), { ok: false, reason: "unavailable" }, path);
      assert.deepEqual(await svc.probe(), { available: false, reason: "unavailable" }, path);
    }
  });

  it("probe is unavailable when the helper reports a method label that is not a slug", T, async () => {
    const svc = createAttestationService({ helper: scriptedHelper({ $probe: { v: 1, available: true, method: "Not A Slug" } }) });
    assert.deepEqual(await svc.probe(), { available: false, reason: "unavailable" });
  });
});
