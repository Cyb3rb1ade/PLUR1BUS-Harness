/** Actual HTTP planning/resume and crash recovery; the Rust parent owns native processes and crash signals. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { SOURCE_CATALOG } from "../../../core/src/import/types.ts";
import { createImportRecords } from "../../../core/src/import/maintenance-records.ts";
import { fingerprintImportTarget } from "../../../core/src/import/maintenance-worker.ts";
import { createApiServer } from "../../src/server.ts";
import { createCoreLink } from "../../src/core-link.ts";
import { snapshot, diff } from "./import-maintenance-diagnostics.mjs";

const [home, source, mode] = process.argv.slice(2);
assert.ok(home && source && ["resume", "crash"].includes(mode));
assert.equal(process.env.PLUR1BUS_ALLOW_TEST_INTERNALS, "1");
const deadline = Date.now() + 150_000;
const family = SOURCE_CATALOG[0].id;
const skill = "native-recovery-proof";
const marker = "A sealed source completes only after an explicit fresh resume.";
const commands = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const exists = async path => {
  try { await access(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
};
const readJournal = runId => readFile(join(home, "imports", runId, "maintenance.json"), "utf8").then(JSON.parse);
const coreMissing = async () => !await exists(join(home, "run", "api-delegation.token"));
const within = () => {
  assert.ok(Date.now() < deadline, "actual native recovery remains bounded");
};
async function command(expected) {
  const next = await Promise.race([commands.next(), delay(Math.max(1, deadline - Date.now()), undefined, { ref: false })
    .then(() => { throw Error("native parent recovery handshake expired"); })]);
  assert.equal(next.done, false);
  assert.ok(next.value.length <= 256);
  assert.deepEqual(JSON.parse(next.value), { type: expected });
}
async function copiedBaseline(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && await copiedBaseline(path)) return true;
    if (entry.isFile() && entry.name === "probe-0000.bin" && (await lstat(path)).size > 0) return true;
  }
  return false;
}

await mkdir(join(source, "workspace", "skills", skill), { recursive: true });
await writeFile(join(source, `${family}.json`), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
  agents: { defaults: { workspace: "./workspace" } } }));
await writeFile(join(source, "workspace", "skills", skill, "SKILL.md"),
  `---\nname: ${skill}\ndescription: Native recovery proof\n---\n${marker}\n`);
const baseline = join(home, "skills", "retained-recovery-baseline");
await mkdir(baseline, { recursive: true });
const bytes = Buffer.alloc(512 * 1024, 0x63);
for (let index = 0; index < 256; index++) {
  await writeFile(join(baseline, `probe-${String(index).padStart(4, "0")}.bin`), bytes);
}

const link = createCoreLink(home);
const ownerToken = randomBytes(32).toString("hex");
const api = createApiServer({ home, core: link, ownerToken,
  resolveBootstrap: async () => (await link.serviceCall("admin.api.person.resolve", { userId: "local-owner" })).person });
const { url } = await api.listen();
let rpcId = 0;
const request = (path, options = {}) => fetch(url + path, { ...options,
  headers: { connection: "close", ...options.headers },
  signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))) });
async function login() {
  const response = await request("/api/v1/session", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ownerToken }) });
  assert.equal(response.status, 200, "fresh actual Owner session");
  await response.arrayBuffer();
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return cookie;
}
async function reply(cookie, method, params = {}) {
  const csrf = await request("/api/v1/csrf", { headers: { cookie } });
  const token = await csrf.json();
  if (csrf.status !== 200) return { status: csrf.status, body: token };
  const response = await request("/rpc", { method: "POST", headers: { cookie, "content-type": "application/json",
    "x-csrf-token": token.token }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  return { status: response.status, body: await response.json() };
}
async function rpc(cookie, method, params = {}) {
  const result = await reply(cookie, method, params);
  if (result.status === 503 && result.body.error === "E_CORE_UNAVAILABLE") return undefined;
  assert.equal(result.status, 200, `actual HTTP ${method} transport`);
  assert.ok(result.body.result !== undefined && !result.body.error,
    `${method}: ${result.body.error?.data?.error ?? "missing result"}`);
  return result.body.result;
}
async function terminal(cookie, runId) {
  while (true) {
    within();
    const status = await rpc(cookie, "admin.import.status", { runId });
    if (status && ["aborted", "failed", "completed"].includes(status.run.state)) return status.run;
    await delay(750);
  }
}
async function liveOwner() {
  while (true) {
    within();
    if (!await coreMissing()) {
      try { return await login(); }
      catch { /* Native readiness precedes the final Core release by a bounded transition. */ }
    }
    await delay(750);
  }
}

try {
  const cookie = await login();
  const detected = await rpc(cookie, "admin.import.detect", { source: { family, kind: "path", path: source } });
  assert.equal(detected.counts.skills, 1);
  const plan = await rpc(cookie, "admin.import.plan", { sourceId: detected.sourceId,
    options: { onConflict: "skip", migrateSecrets: false, agentIds: detected.agents.map(agent => agent.id) } });
  const records = createImportRecords(home);
  const immutable = await records.readPlan(plan.planId, "local-owner", plan.planSha256);
  const before = await fingerprintImportTarget(home, immutable.record.roots);
  const rootsBefore = await snapshot(immutable.record.roots);
  const assertBaseline = async () => {
    const after = await fingerprintImportTarget(home, immutable.record.roots);
    if (after !== before) emit({ phase: "baseline-diff", changes: diff(rootsBefore, await snapshot(immutable.record.roots)) });
    assert.equal(after, before, "every mutable root retains its complete logical baseline");
  };
  const first = await rpc(cookie, "admin.import.preflight", { planId: plan.planId, operation: "apply" });
  assert.equal(first.ok, true, "initial actual Core preflight");
  const started = await rpc(cookie, "admin.import.apply", { planId: plan.planId, preflightId: first.preflightId });
  assert.equal(started.runId, plan.runId);
  const pending = join(home, "imports", plan.runId, ".cold-snapshot.pending");
  while (!await copiedBaseline(pending)) { within(); await delay(10); }
  assert.equal(await coreMissing(), true, "real cold-copy work owns the target with Core stopped");
  assert.equal((await readJournal(plan.runId)).phase, "snapshotting");

  if (mode === "resume") {
    assert.equal((await rpc(cookie, "admin.import.abort", { runId: plan.runId })).accepted, true);
    const aborted = await terminal(cookie, plan.runId);
    assert.equal(aborted.state, "aborted");
    assert.equal(aborted.attempt, 1);
    assert.equal(aborted.restored, true);
    assert.equal(aborted.resumable, true);
    await assertBaseline();
    const fresh = await liveOwner();
    const check = await rpc(fresh, "admin.import.preflight", { planId: plan.planId, operation: "apply" });
    if (!check?.ok) emit({ phase: "resume-preflight", issues: check?.issues });
    assert.equal(check.ok, true, "the same immutable plan obtains a fresh live-Core preflight");
    assert.notEqual(check.preflightId, first.preflightId);
    const resumed = await rpc(fresh, "admin.import.apply", { planId: plan.planId,
      preflightId: check.preflightId, resume: true });
    assert.equal(resumed.runId, plan.runId);
    const completed = await terminal(fresh, plan.runId);
    assert.equal(completed.state, "completed");
    assert.equal(completed.attempt, 2);
    const journal = await readJournal(plan.runId);
    assert.equal(journal.attempt, 2);
    assert.equal(journal.phase, "committed");
    assert.ok(journal.history.some(entry => entry.attempt === 1 && entry.reason === "aborted"));
    assert.equal((await records.readPlan(plan.planId, "local-owner", plan.planSha256)).sha256, immutable.sha256);
    assert.ok((await readFile(join(home, "skills", skill, "SKILL.md"), "utf8")).includes(marker));
    assert.equal((await rpc(fresh, "ext.show", { name: skill })).item.enabled, false);
    emit({ phase: "complete", proofs: { aborted: true, baselineExact: true, freshPreflight: true,
      samePlan: true, attemptTwo: true, importedDisabledSkill: true } });
  } else {
    emit({ phase: "dirty-cold-copy", runId: plan.runId });
    await command("recovering");
    const foreign = await reply(cookie, "admin.import.status", { runId: plan.runId });
    assert.notEqual(foreign.status, 200, "the restarted supervisor grants no offline authority to the old API proof");
    while (await coreMissing()) { within(); await delay(10); }
    const journal = await readJournal(plan.runId);
    assert.equal(journal.phase, "prepared");
    assert.equal(journal.history.at(-1).reason, "recovered", "recovery completes before Core exposes its credential");
    await command("recovered");
    await assertBaseline();
    assert.equal(await exists(join(home, "skills", skill)), false);
    const fresh = await liveOwner();
    const status = await rpc(fresh, "admin.import.status", { runId: plan.runId });
    assert.equal(status.run.restored, true);
    emit({ phase: "complete", proofs: { dirtyColdCopy: true, oldProofDenied: true, recoveredBeforeCore: true,
      nativeOfflineStatus: true, baselineExact: true, freshApi: true } });
  }
} finally {
  await api.close();
  await link.close();
  await commands.return?.();
}
