/** Actual import-bin child: private host controls, real source copy, full cold recovery and bounded public metadata. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { defaults, validate } from "@plur1bus/config-schema";
import { createSnapshot } from "../../src/import/snapshot.ts";
import { createImportRecords } from "../../src/import/maintenance-records.ts";
import { fingerprintImportTarget } from "../../src/import/maintenance-worker.ts";
import { useTempDirs } from "./helpers.ts";
import { createSourceRegistry } from "../../src/import/source-registry.ts";

const temp = useTempDirs();
const ID = "s".repeat(43);

async function fixture(coldFiles = 0) {
  const home = temp();
  const source = temp();
  const workspace = join(source, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "SOUL.md"), "imported persona from actual worker child");
  mkdirSync(join(workspace, "skills", "useful"), { recursive: true });
  writeFileSync(join(workspace, "skills", "useful", "SKILL.md"), "---\nname: useful\ndescription: useful\n---\nactual imported skill");
  writeFileSync(join(source, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
    agents: { list: [{ id: "alpha", workspace }] } }));
  mkdirSync(join(home, "state"));
  writeFileSync(join(home, "state", "prior-data"), "previous target data");
  for (let index = 0; index < coldFiles; index++) {
    writeFileSync(join(home, "state", `cold-${index}`), `baseline-${index}`);
  }
  writeFileSync(join(home, "config.json"), JSON.stringify(defaults()) + "\n");
  const snapshot = await createSnapshot({ home, sourceType: "openclaw", sourceRoot: source,
    stagingDir: join(home, "import", ID, "snapshot") });
  const manifest = readFileSync(join(snapshot.stagingDir, "snapshot.json"));
  const sourceSha256 = createHash("sha256").update(manifest).digest("hex");
  const roots = [{ id: "state", path: join(home, "state"), kind: "directory" as const, preserve: ["core.lock", "api"] },
    { id: "agents", path: join(home, "agents"), kind: "directory" as const },
    { id: "skills", path: join(home, "skills"), kind: "directory" as const }];
  const targetSha256 = await fingerprintImportTarget(home, roots);
  const plan = await createImportRecords(home).putPlan({ ownerId: "owner", sourceId: "67862ffb-45b8-4485-8f9b-7acfde923dee",
    snapshotId: ID, sourceType: "openclaw", sourceSha256, configRevision: "rev-1", options: { onConflict: "skip" },
    roots, importBytes: 1000, coldBytes: 1000, entities: 1, unresolvedConflicts: 0 });
  return { home, source, plan, targetSha256 };
}

async function run(options: Awaited<ReturnType<typeof fixture>>, denyConfig = false,
  control: { mode?: "apply" | "recover"; attempt?: number; killAtSnapshot?: boolean; failAfterEntity?: boolean;
    failWithoutInternals?: boolean } = {}) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--conditions=source",
    fileURLToPath(new URL("../../src/import-bin.ts", import.meta.url)), "--supervised"],
  { stdio: ["pipe", "pipe", "pipe"], ...(control.failAfterEntity ? {
    env: { ...process.env, PLUR1BUS_ALLOW_TEST_INTERNALS: control.failWithoutInternals ? "0" : "1",
      PLUR1BUS_TEST_IMPORT_FAIL_AFTER_ENTITY: "1" },
  } : {}) });
  const envelopes: Record<string, unknown>[] = [];
  child.stdin.on("error", () => {});
  let pending = "";
  let stderr = "";
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code));
  });
  child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
  child.stdout.setEncoding("utf8").on("data", text => {
    pending += text;
    for (;;) {
      const at = pending.indexOf("\n");
      if (at < 0) break;
      const raw = pending.slice(0, at);
      pending = pending.slice(at + 1);
      assert.ok(Buffer.byteLength(raw) < 65_536);
      const envelope = JSON.parse(raw) as Record<string, unknown>;
      envelopes.push(envelope);
      if (control.killAtSnapshot && envelope.type === "progress" && envelope.phase === "snapshot") {
        child.kill("SIGKILL");
        continue;
      }
      if (envelope.type !== "request") continue;
      const response = { v: 1, type: "response", runId: options.plan.record.runId, id: envelope.id };
      const params = envelope.params as Record<string, unknown>;
      if (envelope.method === "config.get") {
        child.stdin.write(JSON.stringify({ ...response, ok: true, result: {
          key: null, value: JSON.parse(readFileSync(join(options.home, "config.json"), "utf8")), revision: "rev-1",
        } }) + "\n");
      } else if (envelope.method === "config.set") {
        if (denyConfig) {
          child.stdin.write(JSON.stringify({ ...response, ok: false,
            error: { code: "E_CONFIG_INVALID", reason: "config-invalid" } }) + "\n");
        } else {
          const config = JSON.parse(readFileSync(join(options.home, "config.json"), "utf8"));
          for (const change of params.changes as { key: string; value: unknown }[]) {
            assert.ok(change.key.startsWith("agents."));
            config.agents[change.key.slice(7)] = change.value;
          }
          assert.equal(validate(config).ok, true);
          if (!params.dryRun) writeFileSync(join(options.home, "config.json"), JSON.stringify(config));
          child.stdin.write(JSON.stringify({ ...response, ok: true, result: { revision: "rev-2" } }) + "\n");
        }
      } else if (envelope.method === "config.restore") {
        const bytes = readFileSync(join(options.home, "imports", options.plan.record.runId, "cold-snapshot", "config.json"));
        assert.equal(createHash("sha256").update(bytes).digest("hex"), params.sha256);
        writeFileSync(join(options.home, "config.json"), bytes);
        child.stdin.write(JSON.stringify({ ...response, ok: true, result: { revision: "restored" } }) + "\n");
      } else {
        assert.fail("unexpected private host method");
      }
    }
  });
  child.stdin.write(JSON.stringify({ v: 1, runId: options.plan.record.runId, mode: control.mode ?? "apply", home: options.home,
    plan: { id: options.plan.record.id, sha256: options.plan.sha256 }, ownerId: "owner", attempt: control.attempt ?? 1,
    targetSha256: options.targetSha256 }) + "\n");
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  try {
    const code = await closed;
    return { code, envelopes, stderr };
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    child.kill();
  }
}

describe("actual supervised import entry", () => {
  it("applies a sealed source through private Supervisor controls and emits report metadata plus progress", async () => {
    const options = await fixture();
    const result = await run(options);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.envelopes.some(item => item.type === "progress"), true);
    const final = result.envelopes.find(item => item.type === "result");
    assert.equal(final?.ok, true);
    assert.equal((final?.report as { schema: string }).schema, "import.openclaw/1");
    assert.equal(readFileSync(join(options.home, "agents", "alpha", "workspace", "SOUL.md"), "utf8"),
      "imported persona from actual worker child");
    assert.match(readFileSync(join(options.home, "skills", "useful", "SKILL.md"), "utf8"), /actual imported skill/);
    const index = JSON.parse(readFileSync(join(options.home, "skills", "index.json"), "utf8"));
    assert.equal(index.skills[0].enabled, false);
    assert.equal(existsSync(join(options.home, "imports", options.plan.record.runId, "skills", "report.json")), true);
    assert.equal(JSON.parse(readFileSync(join(options.home, "imports", options.plan.record.runId, "report.json"),
      "utf8")).schema, "import.openclaw/1");
    assert.equal(JSON.stringify(result.envelopes).includes("imported persona from actual worker child"), false);
  });

  it("automatically restores actual importer writes when the Supervisor refuses the final config transaction", async () => {
    const options = await fixture();
    const before = readFileSync(join(options.home, "config.json"));
    const result = await run(options, true);
    const final = result.envelopes.find(item => item.type === "result");
    assert.equal(final?.ok, false, result.stderr);
    assert.equal(final?.restored, true);
    assert.equal(result.code, 1);
    assert.equal(existsSync(join(options.home, "agents")), false);
    assert.deepEqual(readFileSync(join(options.home, "config.json")), before);
    assert.equal(readFileSync(join(options.home, "state", "prior-data"), "utf8"), "previous target data");
  });

  it("restores a real partial entity failure without exposing a caller-selected failure hook", async () => {
    const options = await fixture();
    const before = readFileSync(join(options.home, "config.json"));
    const result = await run(options, false, { failAfterEntity: true });
    assert.ok(result.envelopes.some(event => event.type === "progress" && event.entity === "agent" && event.completed === 1));
    const final = result.envelopes.find(event => event.type === "result");
    assert.equal(result.code, 1);
    assert.equal(final?.restored, true);
    assert.equal(existsSync(join(options.home, "agents")), false);
    assert.equal(existsSync(join(options.home, "skills")), false);
    assert.deepEqual(readFileSync(join(options.home, "config.json")), before);
    assert.equal(readFileSync(join(options.home, "state", "prior-data"), "utf8"), "previous target data");
    const journal = JSON.parse(readFileSync(join(options.home, "imports", options.plan.record.runId, "maintenance.json"), "utf8"));
    assert.equal(journal.phase, "restored");
  });

  it("applies sealed external mappings in the actual child without reopening the original mapped directory", async () => {
    const options = await fixture();
    const external = temp();
    writeFileSync(join(external, "SOUL.md"), "frozen external persona from supervised worker");
    const sources = createSourceRegistry({ home: options.home });
    const owner = { userId: "owner", kind: "person" as const, role: "owner" as const };
    const detected = await sources.detect({ kind: "path", family: "openclaw", path: options.source }, owner);
    const mapped = await sources.map(detected.sourceId, [{ from: join(options.source, "workspace"), to: external }], owner);
    const { schema: _schema, id: _id, runId: _runId, createdAt: _created, expiresAt: _expiry, ...old } = options.plan.record;
    options.plan = await createImportRecords(options.home).putPlan({ ...old, sourceId: mapped.source.record.id,
      snapshotId: mapped.source.record.snapshotId, sourceSha256: mapped.source.record.sourceSha256,
      options: { onConflict: "skip", maps: mapped.maps } });
    writeFileSync(join(external, "SOUL.md"), "changed original external persona");
    const result = await run(options);
    assert.equal(result.code, 0, JSON.stringify(result.envelopes));
    assert.equal(readFileSync(join(options.home, "agents", "alpha", "workspace", "SOUL.md"), "utf8"),
      "frozen external persona from supervised worker");
  });

  it("ignores the fixed failure seam unless the test-internals gate is also enabled", async () => {
    const options = await fixture();
    const result = await run(options, false, { failAfterEntity: true, failWithoutInternals: true });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.envelopes.find(event => event.type === "result")?.ok, true);
  });

  it("recovers a killed real worker during cold preparation and resumes with the native attempt increment", async () => {
    const options = await fixture(512);
    const killed = await run(options, false, { killAtSnapshot: true });
    assert.equal(killed.code, null);
    const journal = join(options.home, "imports", options.plan.record.runId, "maintenance.json");
    const interrupted = JSON.parse(readFileSync(journal, "utf8"));
    assert.equal(interrupted.phase, "snapshotting");
    assert.equal(interrupted.snapshotSha256, undefined);
    const recovered = await run(options, false, { mode: "recover" });
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(recovered.envelopes.find(item => item.type === "result")?.restored, true);
    assert.equal(JSON.parse(readFileSync(journal, "utf8")).phase, "prepared");
    const resumed = await run(options, false, { attempt: 2 });
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.envelopes.find(item => item.type === "result")?.ok, true);
    assert.equal(JSON.parse(readFileSync(journal, "utf8")).attempt, 2);
    assert.equal(readFileSync(join(options.home, "state", "cold-511"), "utf8"), "baseline-511");
  });
});
