/** Actual HTTP cookie/CSRF -> Core plan -> native maintenance -> restarted Core; the Rust parent owns all processes. */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, access, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SOURCE_CATALOG } from "../../../core/src/import/types.ts";
import { createImportRecords } from "../../../core/src/import/maintenance-records.ts";
import { fingerprintImportTarget } from "../../../core/src/import/maintenance-worker.ts";
import { validateNotification } from "@plur1bus/rpc-schema";
import { connect, readRecordedPid, readRunToken, supervisorAddress, supervisorPidPath,
  supervisorTokenPath } from "@plur1bus/module-api";
import { createApiServer } from "../../src/server.ts";
import { createCoreLink } from "../../src/core-link.ts";
import { AccountStore } from "../../src/account-store.ts";
import { systemClock } from "../../src/clock.ts";
import { hashPassword } from "../../src/password.ts";
import { TotpService, totpCodeAt } from "../../src/totp.ts";
import { snapshot, diff } from "./import-maintenance-diagnostics.mjs";

const [home, sourceDir, mode = "complete"] = process.argv.slice(2);
if (
  !home ||
  !sourceDir ||
  !["complete", "abort", "rollback", "failure", "device"].includes(mode) ||
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS !== "1"
)
  throw new Error("native import fixture arguments and test gate required");
const deadline = Date.now() + 75_000,
  family = SOURCE_CATALOG[0].id,
  skillName = "http-native-proof";
const marker = "Actual HTTP maintenance imported this skill.";
const knowledgeMarker = "The Cobalt Cedar rotation window is Thursday after import validation.";
if (mode === "failure")
  assert.equal(process.env.PLUR1BUS_TEST_IMPORT_FAIL_AFTER_ENTITY, "1", "explicit gated entity-boundary seam required");
await mkdir(join(sourceDir, "workspace", "skills", skillName), { recursive: true });
await writeFile(
  join(sourceDir, `${family}.json`),
  JSON.stringify({
    meta: { lastTouchedVersion: "2026.9.5" },
    agents: { defaults: { workspace: "./workspace" } },
  }),
);
const baselineDir = join(home, "skills", "retained-http-baseline");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function baselineFingerprint() {
  const files = [];
  for (const name of (await readdir(baselineDir)).sort()) {
    const bytes = await readFile(join(baselineDir, name));
    files.push([name, bytes.length, sha256(bytes)]);
  }
  return sha256(JSON.stringify(files));
}
let baselineBefore, configBefore;
if (["abort", "rollback", "failure"].includes(mode)) {
  await mkdir(baselineDir, { recursive: true });
  // Real bounded copy work makes the cancellation window observable; no fake Core, timing seam or request flood.
  const copying = mode === "abort" || mode === "failure";
  const bytes = Buffer.alloc(copying ? 512 * 1024 : 8192, 0x73);
  for (let index = 0; index < (copying ? 256 : 2); index++)
    await writeFile(join(baselineDir, `probe-${String(index).padStart(4, "0")}.bin`), bytes);
  baselineBefore = await baselineFingerprint();
  configBefore = sha256(await readFile(join(home, "config.json")));
}
await writeFile(
  join(sourceDir, "workspace", "skills", skillName, "SKILL.md"),
  `---\nname: ${skillName}\ndescription: Actual HTTP import fixture\n---\n${marker}\n`,
);
await writeFile(join(sourceDir, "workspace", "MEMORY.md"), `# Cobalt Cedar rotation\n\n${knowledgeMarker}\n`);
if (mode === "failure") {
  const roster = ["first-source", "second-source"].map((id) => ({ id, workspace: `./workspace-${id}` }));
  await writeFile(
    join(sourceDir, `${family}.json`),
    JSON.stringify({
      meta: { lastTouchedVersion: "2026.9.5" },
      agents: { list: roster },
    }),
  );
  for (const agent of roster) {
    const workspace = join(sourceDir, agent.workspace);
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "SOUL.md"),
      `# Imported persona\n${agent.id} completes before the injected failure.\n`,
    );
    await writeFile(
      join(workspace, "MEMORY.md"),
      `# Curated memory\nOnly ${agent.id} may import this source knowledge.\n`,
    );
  }
  await mkdir(join(sourceDir, "skills", skillName), { recursive: true });
  await writeFile(
    join(sourceDir, "skills", skillName, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Failure fixture skill\n---\n${marker}\n`,
  );
}

const link = createCoreLink(home),
  ownerToken = randomBytes(32).toString("hex");
const proofClock = systemClock;
const devicePassword = "synthetic-native-import-password";
let accounts, totpSecret;
if (mode === "device") {
  accounts = new AccountStore({
    path: ":memory:",
    now: () => proofClock.now(),
    resolve: async (userId) => (await link.serviceCall("admin.api.person.resolve", { userId })).person,
  });
  await accounts.createPending("local-owner", "native-proof", await hashPassword(devicePassword));
  await accounts.activate("local-owner");
  const factor = new TotpService({ store: accounts.totp, clock: proofClock, issuer: "native import fixture" });
  const setup = await factor.begin("local-owner", "native-proof");
  totpSecret = setup.secret;
  assert.equal((await factor.confirm("local-owner", totpCodeAt(totpSecret, proofClock.now()))).ok, true);
}
const api = createApiServer({
  home,
  core: link,
  ownerToken,
  ...(accounts
    ? { accounts, users: accounts, totp: accounts.totp, clock: proofClock, requireSecondFactor: "always" }
    : {}),
  // Every request joins real current Core authority. The offline path must therefore use the actual run-bound context.
  resolveBootstrap: async () => (await link.serviceCall("admin.api.person.resolve", { userId: "local-owner" })).person,
});
const { url } = await api.listen();
const streams = new Set();
const diagnosticAbort = new AbortController();
let rpcId = 0;
const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
const coreMissing = async () => !(await exists(join(home, "run", "api-delegation.token")));
const request = (path, options = {}) =>
  fetch(url + path, {
    ...options,
    headers: { connection: "close", ...options.headers },
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
      : AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))),
  });
async function login() {
  const response = await request("/api/v1/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ownerToken }),
  });
  assert.equal(response.status, 200, "real owner login");
  await response.arrayBuffer();
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie, "the API issued an opaque session cookie");
  return cookie;
}
async function nativeMfaLogin() {
  const post = async (path, body, headers = {}) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await request(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      if (response.status !== 429) return { response, body: value };
      const seconds = Number(response.headers.get("retry-after"));
      assert.ok(Number.isFinite(seconds) && seconds > 0 && seconds <= 30, "bounded actual Retry-After");
      assert.ok(Date.now() + seconds * 1000 < deadline, "enrollment retry respects the overall fixture deadline");
      await delay(seconds * 1000 + 20); // real wall time refills the production budget; no injected limit or clock advance
    }
    throw new Error("native enrollment exceeded the bounded rate retry count");
  };
  const password = await post("/api/v1/session", { username: "native-proof", password: devicePassword });
  assert.equal(
    password.body.schema,
    "session.challenge/1",
    "ordinary password login requires the actual enrolled factor",
  );
  const factor = await post("/api/v1/session/totp", {
    challenge: password.body.challenge,
    // Enrollment consumed this window; the normal verifier also accepts the next window once.
    code: totpCodeAt(totpSecret, proofClock.now() + 30_000),
  });
  assert.equal(factor.response.status, 200);
  const browser = factor.response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(browser);
  const grant = await link.call("device.pair", { kind: "desktop", imports: true });
  const paired = await post("/api/v1/desktop/pair", {
    code: grant.code,
    kind: "desktop",
    name: "Native import proof",
    publicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  });
  assert.equal(paired.response.status, 200);
  const bearer = { authorization: `Bearer ${paired.body.token}` };
  const challenge = await post("/api/v1/desktop/step-up/start", { purpose: "imports" }, bearer);
  assert.equal(challenge.response.status, 200);
  const approved = await post(
    "/api/v1/desktop/step-up/decision",
    { userCode: challenge.body.userCode, decision: "approve" },
    { cookie: browser, "x-csrf-token": await csrfToken(browser) },
  );
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.proofToken, undefined);
  const proof = await post("/api/v1/desktop/step-up/poll", { challengeId: challenge.body.challengeId }, bearer);
  assert.equal(proof.body.state, "approved");
  const ticket = await post(
    "/api/v1/desktop/redeem",
    { token: paired.body.token, origin: url },
    { "x-plur1bus-desktop-step-up": proof.body.proofToken },
  );
  assert.equal(ticket.response.status, 200);
  const redeemed = await post(
    "/api/v1/desktop/ticket",
    { ticket: ticket.body.ticket, deviceId: ticket.body.deviceId },
    { origin: url },
  );
  assert.equal(redeemed.response.status, 200);
  const cookie = redeemed.response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return { cookie, otherCookie: browser };
}
async function csrfToken(cookie) {
  const csrf = await request("/api/v1/csrf", { headers: { cookie } });
  const value = await csrf.json();
  if (csrf.status === 503 && value.error === "E_CORE_UNAVAILABLE")
    throw Object.assign(new Error("Core restart transition"), { transientCore: true });
  assert.equal(csrf.status, 200, "one-use CSRF remains available only for the initiating session");
  return value.token;
}
async function rpcResponse(cookie, method, params = {}, suppliedCsrf) {
  const token = suppliedCsrf ?? (await csrfToken(cookie));
  const response = await request("/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json", ...(token ? { "x-csrf-token": token } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = await response.json();
  return { status: response.status, body };
}
async function rpc(cookie, method, params = {}) {
  const reply = await rpcResponse(cookie, method, params);
  if (reply.status === 503 && reply.body.error === "E_CORE_UNAVAILABLE")
    throw Object.assign(new Error("Core restart transition"), { transientCore: true });
  assert.equal(
    reply.status,
    200,
    `real HTTP ${method} transport (${reply.body.error ?? "no error"}/${reply.body.reason ?? "no reason"})`,
  );
  assert.ok(
    !reply.body.error && reply.body.result !== undefined,
    `real ${method} succeeds (${reply.body.error?.data?.error ?? "no error"})`,
  );
  return reply.body.result;
}
async function progress(cookie, runId, onProgress = async () => {}) {
  const abort = new AbortController();
  streams.add(abort);
  const response = await request("/events", { headers: { cookie }, signal: abort.signal });
  assert.equal(response.status, 200, "a fresh initiating-cookie progress connection authenticates during maintenance");
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  let observed = false,
    appliedEntity = false;
  const pump = (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        assert.ok(pending.length <= 65_536, "bounded SSE metadata");
        let end;
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (!frame.split("\n").includes("event: import.progress")) continue;
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          const value = JSON.parse(data);
          assert.ok(
            validateNotification("import.progress", value).ok && value.runId === runId,
            "same-run schema-valid progress",
          );
          observed = true;
          if (value.phase === "apply" && value.completed >= 1) appliedEntity = true;
          await onProgress(value);
        }
      }
    } catch (error) {
      if (!abort.signal.aborted && error.name !== "TypeError") throw error;
    }
  })();
  return { close: () => abort.abort(), done: pump, observed: () => observed, appliedEntity: () => appliedEntity };
}

async function firstBaselineCopy(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && (await firstBaselineCopy(path))) return true;
    if (entry.name === "probe-0000.bin" && entry.isFile() && (await lstat(path)).size > 0) return true;
  }
  return false;
}

async function secondApplyBusy(params) {
  const pid = readRecordedPid(supervisorPidPath(home));
  assert.ok(pid, "the actual native supervisor identity is available");
  const client = await connect({ address: supervisorAddress(home), endpoint: "supervisor",
    token: readRunToken(home, supervisorTokenPath(home)), expectedServerPid: pid,
    connectTimeoutMs: 1000, callTimeoutMs: 5000 });
  try {
    await assert.rejects(client.call("admin.import.apply", params), error => {
      assert.equal(error.error, "E_CONFLICT", "a second actual apply cannot enter the active maintenance job");
      assert.equal(error.reason, "busy", "active admission wins before reusing a claimed ticket");
      return true;
    });
  } finally { await client.close(); }
}

async function waitForRun(cookie, otherCookie, otherCsrf, runId, abortDuringSnapshot = false, secondApply) {
  let offlineStatus = false,
    secondImportBusy = false,
    isolated = false,
    stream,
    run,
    abortTask;
  const onProgress = async (value) => {
    if (!abortDuringSnapshot || value.phase !== "snapshot" || abortTask) return;
    abortTask = (async () => {
      const pending = join(home, "imports", runId, ".cold-snapshot.pending");
      const until = Math.min(deadline, Date.now() + 10_000);
      while (!(await firstBaselineCopy(pending))) {
        assert.ok(Date.now() < until, "actual Node cold copy must be observed before cancellation");
        await delay(10); // private filesystem observation only; HTTP retains normal GUI-scale polling
      }
      assert.equal(await coreMissing(), true, "cancellation occurs during the genuine stopped-Core cold-copy phase");
      if (secondApply) {
        // LocalOwner is the actual native authority here; HTTP downtime fallback stays limited to status and abort.
        await secondApplyBusy(secondApply);
        secondImportBusy = true;
      }
      const cancelled = await rpc(cookie, "admin.import.abort", { runId });
      assert.equal(cancelled.accepted, true);
    })();
    await abortTask;
  };
  while (Date.now() < deadline) {
    const absent = await coreMissing();
    let current;
    try {
      current = await rpc(cookie, "admin.import.status", { runId });
    } catch (error) {
      if (error.transientCore !== true) throw error;
      await delay(750); // normal GUI polling survives the fresh-credential/Core-listener restart gap
      continue;
    }
    assert.equal(current.run.runId, runId);
    run = current.run;
    if (absent && (await coreMissing())) {
      offlineStatus = true;
      if (!stream) stream = await progress(cookie, runId, onProgress);
      if (!isolated) {
        const foreign = await rpcResponse(otherCookie, "admin.import.status", { runId }, otherCsrf);
        if (await coreMissing()) {
          assert.notEqual(foreign.status, 200, "another cookie of the same person gains no offline authority");
          isolated = true;
        }
      }
    }
    if (["completed", "failed", "aborted"].includes(run.state)) break;
    await delay(750);
  }
  stream?.close();
  await stream?.done;
  await abortTask;
  assert.equal(offlineStatus, true, "real status succeeded while the Core credential file was absent");
  if (abortDuringSnapshot) assert.ok(abortTask, "the actual cold-copy checkpoint caused cancellation");
  return {
    run,
    secondImportBusy,
    offlineStatus,
    otherCookieDenied: isolated,
    progress: stream?.observed() ?? false,
    appliedEntity: stream?.appliedEntity() ?? false,
  };
}

async function committedTarget(roots, runId) {
  while (Date.now() < deadline && !diagnosticAbort.signal.aborted) {
    let journal;
    try {
      journal = JSON.parse(await readFile(join(home, "imports", runId, "maintenance.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (journal?.phase === "committed") {
      return {
        expected: journal.targetSha256,
        fingerprint: await fingerprintImportTarget(home, roots),
        configSha256: sha256(await readFile(join(home, "config.json"))),
        roots: await snapshot(roots),
      };
    }
    await delay(10);
  }
  return undefined;
}

try {
  const { cookie, otherCookie } =
    mode === "device" ? await nativeMfaLogin() : { cookie: await login(), otherCookie: await login() };
  const verificationCookie = mode === "device" ? otherCookie : cookie; // normal Owner reads do not widen native purpose scopes
  const otherCsrf = await csrfToken(otherCookie); // valid before downtime; denial must concern authority, not missing CSRF
  const before = await rpc(verificationCookie, "core.status");
  const detected = await rpc(cookie, "admin.import.detect", { source: { family, kind: "path", path: sourceDir } });
  assert.ok(
    !detected.discovery && detected.counts.skills === 1,
    "real source inspection finds exactly the fixture skill",
  );
  const plan = await rpc(cookie, "admin.import.plan", {
    sourceId: detected.sourceId,
    options: { onConflict: "skip", migrateSecrets: false, agentIds: detected.agents.map((agent) => agent.id) },
  });
  const preflight = await rpc(cookie, "admin.import.preflight", { planId: plan.planId, operation: "apply" });
  assert.equal(preflight.ok, true, "real live-Core preflight");
  const immutablePlan = (await createImportRecords(home).readPlan(plan.planId, "local-owner", plan.planSha256)).record;
  const targetBefore = ["complete", "device"].includes(mode)
    ? undefined
    : await fingerprintImportTarget(home, immutablePlan.roots);
  const rootsBefore = ["complete", "device"].includes(mode) ? undefined : await snapshot(immutablePlan.roots);
  const assertRestoredRoots = async () => {
    const current = await fingerprintImportTarget(home, immutablePlan.roots);
    if (current !== targetBefore)
      process.stderr.write(
        JSON.stringify({
          diagnostic: "mutable-root-diff",
          changes: await diff(rootsBefore, await snapshot(immutablePlan.roots)),
        }) + "\n",
      );
    assert.equal(current, targetBefore, "all mutable roots retain their original logical baseline");
  };
  const committed =
    mode === "rollback"
      ? committedTarget(immutablePlan.roots, plan.runId).catch((error) => ({ error: error.name }))
      : undefined;
  const started = await rpc(cookie, "admin.import.apply", { planId: plan.planId, preflightId: preflight.preflightId });
  assert.equal(started.runId, plan.runId);
  const finished = await waitForRun(cookie, otherCookie, otherCsrf, started.runId, mode === "abort",
    mode === "abort" ? { planId: plan.planId, preflightId: preflight.preflightId } : undefined);
  assert.equal(
    finished.run?.state,
    mode === "abort" ? "aborted" : mode === "failure" ? "failed" : "completed",
    `native maintenance reaches its expected terminal state: ${JSON.stringify(finished.run)}`,
  );
  const after = await rpc(verificationCookie, "core.status");
  assert.ok(
    Number.isInteger(before.pid) && Number.isInteger(after.pid) && before.pid !== after.pid,
    "actual Core process restarted",
  );
  let summary;
  if (mode === "abort" || mode === "failure") {
    assert.equal(finished.run.restored, true);
    assert.equal(await exists(join(home, "skills", skillName)), false, "cancelled import creates no skill");
    assert.equal(await baselineFingerprint(), baselineBefore);
    assert.equal(sha256(await readFile(join(home, "config.json"))), configBefore);
    await assertRestoredRoots();
    summary = {
      aborted: true,
      restored: true,
      baselineExact: true,
      offlineAbort: true,
      offlineStatus: true,
      coreRestarted: true,
      secondImportBusy: finished.secondImportBusy,
    };
    if (mode === "failure") {
      assert.equal(finished.appliedEntity, true, "actual worker checkpoint proves one entity completed before failure");
      for (const id of ["first-source", "second-source"])
        assert.equal(
          await exists(join(home, "agents", id)),
          false,
          "restoration removes imported persona and knowledge",
        );
      summary = {
        failed: true,
        restored: true,
        baselineExact: true,
        entityAppliedThenUndone: true,
        offlineStatus: true,
        coreRestarted: true,
      };
    }
  } else {
    assert.ok(
      (await readFile(join(home, "skills", skillName, "SKILL.md"), "utf8")).includes(marker),
      "actual skill bytes were imported",
    );
    const shown = await rpc(verificationCookie, "ext.show", { name: skillName });
    assert.equal(shown.item.enabled, false, "source skills import disabled");
    if (mode === "complete" || mode === "device") {
      // Recall persists usage counters; the rollback case must preflight before unrelated post-import mutations.
      // The normal CLI Core transport owns CallerIdentity; this stays outside the human HTTP allowlist.
      const recalled = await link.call("memory.recall", {
        caller: { channel: "cli", accountId: "fixture", userId: "owner" },
        agentId: "main",
        query: "Cobalt Cedar rotation Thursday import validation",
        joined: true,
        budget: { softMs: 15_000, hardMs: 20_000, capChars: 12_000 },
      });
      assert.equal(recalled.degraded, null, "actual post-restart Engine recall is healthy");
      assert.ok(
        recalled.blocks.some((block) => block.text.includes(knowledgeMarker)),
        "actual recall finds imported curated knowledge",
      );
    }
    summary = {
      imported: true,
      coreRestarted: true,
      offlineStatus: true,
      disabledSkill: true,
      ...(["complete", "device"].includes(mode) ? { memoryRecall: true } : {}),
      ...(mode === "device" ? { deviceMfa: true } : {}),
      ...(finished.otherCookieDenied ? { otherCookieDenied: true } : {}),
      ...(finished.progress ? { progress: true } : {}),
    };
    if (mode === "rollback") {
      const rollbackCheck = await rpc(cookie, "admin.import.preflight", { planId: plan.planId, operation: "rollback" });
      if (!rollbackCheck.ok) {
        const baseline = await committed;
        process.stderr.write(
          JSON.stringify({
            diagnostic: "rollback-preflight",
            issues: rollbackCheck.issues.map((issue) => ({ code: issue.code, reason: issue.reason })),
            committedSha256: baseline?.expected,
            observedCommittedSha256: baseline?.fingerprint,
            currentSha256: await fingerprintImportTarget(home, immutablePlan.roots),
            committedConfigSha256: baseline?.configSha256,
            currentConfigSha256: sha256(await readFile(join(home, "config.json"))),
            ...(baseline?.roots ? { changes: diff(baseline.roots, await snapshot(immutablePlan.roots)) } : {}),
          }) + "\n",
        );
      }
      assert.equal(rollbackCheck.ok, true, "manual rollback uses a fresh live-Core preflight");
      const validOtherCsrf = await csrfToken(otherCookie);
      await rpc(cookie, "admin.import.rollback", { runId: started.runId, preflightId: rollbackCheck.preflightId });
      const rollback = await waitForRun(cookie, otherCookie, validOtherCsrf, started.runId);
      assert.equal(rollback.run.state, "completed", `native rollback terminal state: ${JSON.stringify(rollback.run)}`);
      assert.equal(rollback.run.restored, true);
      const restored = await rpc(cookie, "core.status");
      assert.notEqual(restored.pid, after.pid, "manual rollback genuinely restarts the Core again");
      assert.equal(await exists(join(home, "skills", skillName)), false, "manual rollback removes the imported skill");
      assert.equal(await baselineFingerprint(), baselineBefore);
      assert.equal(sha256(await readFile(join(home, "config.json"))), configBefore);
      await assertRestoredRoots();
      summary = { ...summary, rollback: true, restored: true, baselineExact: true, importedSkillRemoved: true };
    }
  }
  process.stdout.write(JSON.stringify(summary) + "\n");
} finally {
  diagnosticAbort.abort();
  for (const stream of streams) stream.abort();
  await api.close();
  await link.close();
  accounts?.close();
}
