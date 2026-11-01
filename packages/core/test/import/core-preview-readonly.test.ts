/** Mounted Core source discovery, planning and successful preflight preserve every target mutation root. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import type { AdminImportPlanResult, AdminImportPreflightResult, ImportDetection } from "@plur1bus/rpc-schema";
import { startFakeSupervisor } from "../../../module-api/test/helpers/fake-supervisor.ts";
import { createCore } from "../../src/core.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { E5, lanceStore } from "./fixtures.ts";
import { useTempDirs } from "./helpers.ts";
import { createImportRecords } from "../../src/import/maintenance-records.ts";
import type { SourceRecord } from "../../src/import/source-registry.ts";

const temp = useTempDirs();
const MUTATION_ROOTS = ["state", "agents", "skills", "extensions", "mcp", "modules", "channels", "data"];
const OWNER = { kind: "person" as const, role: "owner" as const, userId: "local-owner" };

/** Independent byte inventory, including unlisted files and empty directories; only the OS-owned Core lock is omitted. */
function targetBytes(home: string): string[] {
  const entries: string[] = [];
  const walk = (path: string, relative: string): void => {
    if (/^state\/core\.lock(?:-(?:journal|wal|shm))?$/.test(relative)) return;
    if (!existsSync(path)) { entries.push(relative + ":missing"); return; }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) entries.push(relative + ":link:" + readlinkSync(path));
    else if (stat.isDirectory()) {
      entries.push(relative + ":directory");
      for (const name of readdirSync(path).sort()) walk(join(path, name), relative + "/" + name);
    } else {
      entries.push(relative + ":" + stat.size + ":" + createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  };
  for (const root of MUTATION_ROOTS) walk(join(home, root), root);
  return entries;
}

async function sourceFixture(family: "openclaw" | "hermes") {
  const source = temp();
  const workspace = family === "openclaw" ? join(source, "workspace") : source;
  const memory = family === "openclaw" ? workspace : join(workspace, "memories");
  mkdirSync(memory, { recursive: true });
  const skill = join(workspace, "skills", "preview-only");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: preview-only\ndescription: Import preview fixture\n---\nPrivate source skill body.\n");
  writeFileSync(join(workspace, "SOUL.md"), "Private source persona for a new agent.\n");
  writeFileSync(join(memory, "MEMORY.md"), "The first curated source fact is substantive.\n§\nThe second curated source fact is distinct.\n");
  if (family === "openclaw") {
    const base = join(source, "memory", "lancedb-namespaced");
    await lanceStore(join(base, "foreign"), 384, 2, { agentId: "foreign", scope: "agent-private", status: "active" }, () => 0);
    writeFileSync(join(base, "_schema.json"), '{"schemaVersion":"1"}');
    writeFileSync(join(source, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
      agents: { list: [{ id: "foreign", workspace: "./workspace" }] }, plugins: { entries: {
        "memory-lancedb-namespaced": { enabled: true, config: { embedding: { provider: "local-transformers",
          local: { model: E5, dimensions: 384 } } } } } } }));
  } else writeFileSync(join(source, "config.yaml"), "_config_version: 45\n");
  return source;
}

const CASES: readonly { family: "openclaw" | "hermes"; malformed?: string }[] = [
  { family: "openclaw" }, { family: "hermes" },
  { family: "hermes", malformed: "platforms/pairing/telegram-approved.json" },
  { family: "hermes", malformed: "cron/jobs.json" },
];
for (const { family, malformed } of CASES) {
  it(malformed ? `mounted Core refuses malformed ${malformed} before issuing any preflight ticket or changing targets`
    : `mounted Core ${family} detection, planning and successful preflight leave target bytes unchanged`, { timeout: 60_000 }, async () => {
    const home = temp();
    const source = await sourceFixture(family);
    if (malformed) {
      mkdirSync(join(source, malformed, ".."), { recursive: true });
      writeFileSync(join(source, malformed), "{ malformed private-pairing-or-cron-canary");
    }
    const cfg = defaults();
    cfg.agents.resident = {};
    cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
      merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
      temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false } };
    const configBytes = Buffer.from(JSON.stringify(cfg, null, 2) + "\n");
    writeFileSync(join(home, "config.json"), configBytes);
    const supervisor = await startFakeSupervisor({ home, config: cfg as unknown as Record<string, unknown> });
    const previous = process.env.PLUR1BUS_ALLOW_TEST_INTERNALS;
    process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1";
    const core = createCore({ home, supervisorConfig: { attempts: 1 }, testInternals: flatTestInternals(),
      discovery: { scheduler: false }, dreams: { scheduler: false }, rbac: { resolve: () => OWNER } });
    let client: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      await core.start();
      client = await connect({ address: core.address, token: core.token });
      const deadline = Date.now() + 10_000;
      while (!core.status().engine?.ready) {
        assert.ok(Date.now() < deadline, "actual Engine and startup read pools finish warming before the baseline");
        await client.call("core.status", {});
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      // Complete lazy schedule initialization before startup 1staid reads dreams.status.
      await client.call("dreams.status", {});
      let baseline = targetBytes(home), stable = 0;
      while (stable < 4) {
        assert.ok(Date.now() < deadline, "disabled background tasks settle before the target baseline");
        await new Promise(resolve => setTimeout(resolve, 50));
        const next = targetBytes(home);
        stable = JSON.stringify(next) === JSON.stringify(baseline) ? stable + 1 : 0;
        baseline = next;
      }
      assert.ok(supervisor.watches.length > 0, "the production Core actually used Supervisor config.watch");
      const unchanged = () => {
        assert.deepEqual(readFileSync(join(home, "config.json")), configBytes, "raw config.json is unchanged");
        assert.deepEqual(targetBytes(home), baseline, "all target mutation roots are byte-identical");
      };
      const detected = await client.call<ImportDetection>("admin.import.detect", {
        source: { kind: "path", family, path: source },
      });
      assert.equal(detected.agents.length, 1);
      assert.equal(detected.agents[0]?.hasPersona, true);
      assert.equal(detected.counts.skills, 1);
      unchanged();
      if (malformed) {
        // Existing immutable plans must also be revalidated after upgrading a Core that previously admitted this source.
        const captured = JSON.parse(readFileSync(join(home, "imports", "sources", detected.sourceId + ".json"), "utf8")) as SourceRecord;
        const { record: prior } = await createImportRecords(home).putPlan({ ownerId: OWNER.userId, sourceId: captured.id,
          snapshotId: captured.snapshotId, sourceType: captured.sourceType, sourceSha256: captured.sourceSha256,
          configRevision: supervisor.revision, options: { onConflict: "replace" }, importBytes: 0, coldBytes: 0,
          entities: 1, unresolvedConflicts: 0, roots: MUTATION_ROOTS.map(id => ({ id, path: join(home, id),
            kind: "directory" as const, ...(id === "state" ? { preserve: ["core.lock", "api", "secrets"] } : {}) })) });
        const refused = await client.call<AdminImportPreflightResult>("admin.import.preflight", { planId: prior.id });
        assert.equal(refused.ok, false, "the live preflight must parse every deferred file the stopped worker reads");
        assert.ok(refused.issues.some(issue => issue.reason === "source-parse-failed"));
        assert.equal(refused.preflightId, undefined);
        const tickets = join(home, "imports", "preflight");
        assert.deepEqual(existsSync(tickets) ? readdirSync(tickets) : [], []);
        await assert.rejects(client.call("admin.import.plan", { sourceId: detected.sourceId }),
          (error: { error?: string; reason?: string }) => error.error === "E_INVALID_PARAMS" && error.reason === "entity-failed");
        unchanged();
        assert.deepEqual(supervisor.runtimeSets, []);
        assert.equal(readFileSync(join(home, "logs", "audit.log"), "utf8").includes("private-pairing-or-cron-canary"), false);
        return;
      }
      const plan = await client.call<AdminImportPlanResult>("admin.import.plan", { sourceId: detected.sourceId,
        options: { onConflict: "replace", ...(family === "openclaw" ? { adoptStoreId: "agent:foreign" } : {}) } });
      assert.equal(plan.counts.agents, 1);
      assert.ok(plan.counts.memories >= 2, "the mounted preview parsed substantive curated cards");
      if (family === "openclaw") assert.equal(plan.counts.stores, 1, "the mounted preview actually verified a foreign store copy");
      unchanged();
      const preflight = await client.call<AdminImportPreflightResult>("admin.import.preflight", { planId: plan.planId });
      assert.equal(preflight.ok, true, JSON.stringify(preflight.issues));
      assert.ok(preflight.preflightId, "successful preflight persists its metadata ticket");
      unchanged();
      assert.ok(supervisor.sets.length >= 2, "both plan and preflight validated actual new-agent config changes");
      assert.ok(supervisor.sets.every(params => (params as { dryRun?: boolean }).dryRun === true),
        "every Supervisor config.set request is explicitly dry-run");
      assert.deepEqual(supervisor.runtimeSets, [], "read-only planning has no private maintenance config write");
      const audit = readFileSync(join(home, "logs", "audit.log"), "utf8");
      for (const method of ["import.detect", "import.plan", "import.preflight"]) assert.ok(audit.includes(method));
      assert.equal(audit.includes("Private source"), false);
    } finally {
      await client?.close();
      await core.stop();
      await supervisor.close();
      if (previous === undefined) delete process.env.PLUR1BUS_ALLOW_TEST_INTERNALS;
      else process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = previous;
    }
  });
}
