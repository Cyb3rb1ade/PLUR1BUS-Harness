import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { defaults } from "@plur1bus/config-schema";
import { connect, engineRunFiles, engineAddress } from "@plur1bus/module-api";
import { createCore } from "../../packages/core/src/core.ts";
import { flatTestInternals } from "../../packages/core/test/helpers/flat-embedder.ts";
import { LOCAL_OWNER } from "../../packages/core/src/rbac/guard.ts";
import type { Principal } from "../../packages/core/src/rbac/types.ts";
import { deriveUserPrincipal } from "../../packages/core/src/identity/principals.ts";
import { BIN, coreEnv, engineBin, ENGINE_IMPL, home, waitFor } from "./helpers.ts";

test("Rust background jobs admit the CLI owner and each consenting person in separate partitions", { skip: ENGINE_IMPL !== "rust" }, async t => {
  const root = realpathSync(home({ modelCache: false }));
  const cfg = defaults();
  cfg.agents.alpha = {};
  cfg.engine = { implementation: "rust", duplicateThreshold: 1.01, reranker: { enabled: false } };
  writeFileSync(join(root, "config.json"), JSON.stringify(cfg));
  const engine = spawn(engineBin(), ["serve", "--home", root, "--test-internals", "flat-embedder"], {
    env: coreEnv(), stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<void>(resolve => engine.once("exit", () => resolve()));
  let closeCore: (() => Promise<void>) | undefined;
  t.after(async () => {
    try { await closeCore?.(); }
    finally { engine.kill("SIGTERM"); await exited; rmSync(root, { recursive: true, force: true }); }
  });
  engine.stdout.setEncoding("utf8");
  let startup = "";
  engine.stdout.on("data", data => { startup += data; });
  await waitFor("Rust Engine readiness", () => {
    assert.equal(engine.exitCode, null, startup);
    return startup.includes('"ready":true');
  }, 20_000);
  let who: Principal = LOCAL_OWNER;
  const core = createCore({ home: root, testInternals: flatTestInternals(), rbac: { resolve: () => who },
    attestation: { attester: {
      probe: async () => ({ available: true, method: "fixture" }),
      attest: async () => ({ ok: true, method: "fixture", at: Date.now() }),
    } }, dreams: { scheduler: false }, discovery: { scheduler: false } });
  let local: Awaited<ReturnType<typeof connect>> | undefined;
  let native: Awaited<ReturnType<typeof connect>> | undefined;
  let authority: Awaited<ReturnType<typeof connect>> | undefined;
  closeCore = async () => { await authority?.close(); await local?.close(); await native?.close(); await core.stop(); };
  await core.start();
  local = await connect({ address: core.address, token: core.token, expectedServerPid: process.pid });
  const files = engineRunFiles(root);
  const token = readFileSync(files.token, "utf8").trim();
  authority = await connect({ address: core.address, token, expectedServerPid: process.pid,
    engine: { clientId: "plur1bus-engine", token } });
  native = await connect({ endpoint: "engine", clientId: "core-fixture", address: engineAddress(root), token, expectedServerPid: engine.pid! });
  const agentId = "alpha";
  const caller = { channel: "cli", accountId: "fixture", userId: "request-label-not-the-owner" };
  const owner = deriveUserPrincipal(LOCAL_OWNER.userId);
  const principals = async (job: string) => (await authority!.call<any>("host.jobs.authorities", { agentId, job, dryRun: false })).principals.map((p: any) => p.user);
  await local.call("agent.open", { agentId });
  assert.deepEqual(await principals("embedding-drain"), [owner]);

  // The usual local CLI path creates a capture owned by the automatically admitted principal.
  const capture = await promisify(execFile)(BIN, ["--json", "--home", root, "memory", "add", "--agent", agentId,
    "--session", "alpha-owner", "Please remember my private Falcon launch is on a Wednesday."], { env: coreEnv(), timeout: 30_000 });
  const added = JSON.parse(capture.stdout);
  assert.ok(added.stored >= 1, capture.stdout);
  const ownerRun = await native.call<any>("engine.jobs.run", { agentId, job: "embedding-drain", dueId: "before-consent" });
  assert.equal(ownerRun.outcome, "completed", JSON.stringify(ownerRun));

  const member = await local.call<any>("identity.human.create", { caller, displayName: "Maintenance member" });
  await local.call("user.role.set", { userId: member.id, role: "member" });
  await local.call("agent.rights.set", { agentId, userId: member.id, right: "use" });
  who = { kind: "person", userId: member.id, role: "member" };
  assert.equal((await local.call<any>("jobs.list", { kind: "user" })).backgroundWork[0].state, "never-issued");
  const consent = { capability: "memory.jobs.run", agent: agentId, jobId: "engine:*", scope: "always" };
  await assert.rejects(local.call("grant.create", consent), (e: any) => e.reason === "surface-untrusted");
  await assert.rejects(local.call("grant.create", { ...consent, capability: "fs.write", attest: true }), (e: any) => e.error === "E_DENIED");
  const grant = await local.call<any>("grant.create", { ...consent, attest: true });
  assert.equal(grant.person, member.id);
  assert.equal(grant.surface, 2);
  assert.equal((await local.call<any>("grant.list", { capability: "memory.jobs.run", agent: agentId })).grants[0].id, grant.id);
  assert.equal((await local.call<any>("jobs.list", { kind: "user" })).backgroundWork[0].state, "active");
  assert.deepEqual(await principals("embedding-drain"), [owner, deriveUserPrincipal(member.id)]);
  assert.deepEqual(await principals("light-dream"), [owner]);
  await assert.rejects(local.call("dreams.diary", { agentId }), (e: any) => e.reason === "agent-owner-required");
  const due = { agentId, job: "embedding-drain", dueId: "both-persons" };
  const both = await native.call<any>("engine.jobs.run", due);
  assert.equal(both.outcome, "completed", JSON.stringify(both));
  const retry = await native.call<any>("engine.jobs.run", due);
  assert.equal(retry.runId, both.runId);
  const ledger = readFileSync(join(root, "state", "lancedb", "_jobs", agentId, "ledger.jsonl"), "utf8");
  for (const identity of [owner, LOCAL_OWNER.userId, member.id, deriveUserPrincipal(member.id), root]) assert.ok(!ledger.includes(identity));
  await local.call("grant.revoke", { id: grant.id });
  assert.deepEqual(await principals("embedding-drain"), [owner]);
  assert.equal((await local.call<any>("jobs.list", { kind: "user" })).backgroundWork[0].state, "revoked");
  const after = await native.call<any>("engine.jobs.run", { ...due, dueId: "after-revoke" });
  assert.equal(after.outcome, "completed", JSON.stringify(after));
});
