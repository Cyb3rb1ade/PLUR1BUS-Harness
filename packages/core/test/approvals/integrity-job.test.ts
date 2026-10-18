import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApprovalsIntegrityJob, armApprovalsIntegrity, APPROVALS_INTEGRITY_JOB_SPEC } from "../../src/approvals/integrity-job.ts";
import type { VerifyResult } from "../../src/approvals/chain.ts";
import { setup, useTempDirs } from "../system-jobs/helpers.ts";
import { FakeClock } from "./helpers.ts";
import { loadDecisionSigner } from "../../src/approvals/signing.ts";
import { secretStoreSigningKeySource } from "../../src/approvals/keys.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { BINDING, dbFile, openChain, raw } from "./helpers.ts";

const T = { timeout: 15_000 };
const dirs = useTempDirs("p1b-apr-integrity-");
const DAY = 86_400_000;

describe("approvals.integrity system job (D109 §9.7)", () => {
  it("is a daily singleton system job named approvals.integrity", T, () => {
    assert.equal(APPROVALS_INTEGRITY_JOB_SPEC.name, "approvals.integrity");
    assert.equal(APPROVALS_INTEGRITY_JOB_SPEC.needsLlm, false);
    assert.equal(APPROVALS_INTEGRITY_JOB_SPEC.singleton, true);
    assert.equal(APPROVALS_INTEGRITY_JOB_SPEC.schedule.every, DAY);
  });

  it("completes when the chain is unsigned (legacy)", T, async () => {
    const s = setup(dirs);
    const clock = new FakeClock();
    const { chain } = openChain(dbFile(), { clock });
    chain.append("note", "r1", { i: 1 });
    const job = createApprovalsIntegrityJob({ verify: () => chain.verify(), clock: s.clock });
    s.jobs.register(job);
    const { record, detail } = await s.jobs.run("approvals.integrity", {}, { trigger: "harness" });
    assert.equal(record.outcome, "completed");
    const d = detail as VerifyResult;
    assert.equal(d.ok, true);
    assert.equal(d.signatures.report, "unsigned (legacy)");
  });

  it("fails when a signed decision was manipulated", T, async () => {
    const s = setup(dirs);
    const secrets = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink() });
    const signer = await loadDecisionSigner(secretStoreSigningKeySource(secrets));
    const path = dbFile();
    const clock = new FakeClock();
    const opened = openChain(path, { clock });
    opened.chain.setSigner(signer);
    opened.chain.append("approval.requested", "apr_j", { bound: BINDING, capability: "fs.read", expiresAt: clock.now() + 60_000 }, "nonce1");
    opened.chain.append("approval.decided", "apr_j", { decision: "approve", person: "christian", surface: 2, delegable: false, bound: BINDING }, "nonce1");
    const db = raw(path);
    db.prepare("UPDATE approval_signatures SET signature = ? WHERE seq = 2").run("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    db.close();
    const job = createApprovalsIntegrityJob({ verify: () => opened.chain.verify(), clock: s.clock });
    s.jobs.register(job);
    const { record } = await s.jobs.run("approvals.integrity", {}, { trigger: "cron" });
    assert.equal(record.outcome, "failed");
    assert.equal(record.reason, "signature-mismatch");
  });

  it("schedules the next run a day later (FakeClock, no sleep)", T, async () => {
    const s = setup(dirs);
    const { chain } = openChain(dbFile(), { clock: new FakeClock() });
    const job = createApprovalsIntegrityJob({ verify: () => chain.verify(), clock: s.clock, rng: () => 0.5 });
    s.jobs.register(job);
    assert.equal(s.jobs.list()[0]!.nextRunAt, s.clock.now());
    await s.jobs.run("approvals.integrity", {}, { trigger: "harness" });
    assert.equal(s.jobs.list()[0]!.nextRunAt, s.clock.now() + DAY);
    s.clock.advance(DAY);
    assert.equal(s.jobs.list()[0]!.nextRunAt, s.clock.now());
  });

  it("nextRunAt jitters like discovery nextRegularAt", T, async () => {
    const { chain } = openChain(dbFile(), { clock: new FakeClock() });
    const s0 = setup(dirs);
    s0.jobs.register(createApprovalsIntegrityJob({ verify: () => chain.verify(), clock: s0.clock, rng: () => 0 }));
    await s0.jobs.run("approvals.integrity", {}, { trigger: "harness" });
    assert.equal(s0.jobs.list()[0]!.nextRunAt, s0.clock.now() + DAY * 0.9);
    const s1 = setup(dirs);
    s1.jobs.register(createApprovalsIntegrityJob({ verify: () => chain.verify(), clock: s1.clock, rng: () => 1 }));
    await s1.jobs.run("approvals.integrity", {}, { trigger: "harness" });
    assert.equal(s1.jobs.list()[0]!.nextRunAt, s1.clock.now() + DAY * 1.1);
  });

  it("a daily ticker fires the job again after a day (FakeClock, no sleep)", T, async () => {
    const s = setup(dirs);
    const { chain } = openChain(dbFile(), { clock: new FakeClock() });
    const job = createApprovalsIntegrityJob({ verify: () => chain.verify(), clock: s.clock, rng: () => 0.5 });
    s.jobs.register(job);
    await s.jobs.run("approvals.integrity", {}, { trigger: "harness" });
    const arm = armApprovalsIntegrity(s.jobs, s.clock);
    await s.clock.advance(DAY);
    const hist = s.jobs.history({ job: "approvals.integrity" });
    assert.equal(hist.length, 2);
    assert.equal(hist.map((h) => h.trigger).sort().join(","), "cron,harness");
    arm.cancel();
  });

  it("deferFirstRun: no row at start, the first cron run comes a day later (no ledger noise for an absent store)", T, async () => {
    const s = setup(dirs);
    const job = createApprovalsIntegrityJob({ verify: () => ({ ok: true } as unknown as VerifyResult), clock: s.clock, rng: () => 0.5, deferFirstRun: true });
    s.jobs.register(job);
    assert.equal(job.nextRunAt(), s.clock.now() + DAY);
    const arm = armApprovalsIntegrity(s.jobs, s.clock);
    await s.clock.advance(DAY - 1);
    assert.equal(s.jobs.history({ job: "approvals.integrity" }).length, 0);
    await s.clock.advance(1);
    assert.equal(s.jobs.history({ job: "approvals.integrity" }).length, 1);
    arm.cancel();
  });

  it("onOk runs after a successful verify", T, async () => {
    const s = setup(dirs);
    const { chain } = openChain(dbFile(), { clock: new FakeClock() });
    let n = 0;
    const job = createApprovalsIntegrityJob({ verify: () => chain.verify(), clock: s.clock, onOk: () => { n++; } });
    s.jobs.register(job);
    await s.jobs.run("approvals.integrity", {}, { trigger: "harness" });
    assert.equal(n, 1);
  });
});
