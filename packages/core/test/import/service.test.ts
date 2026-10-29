/** The live Core prepares immutable plans and tickets without stopping Core or exposing imported content. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, posix, relative, sep } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { defaults } from "@plur1bus/config-schema";
import { validateResult } from "@plur1bus/rpc-schema";
import { useTempDirs } from "./helpers.ts";
import { createSourceRegistry } from "../../src/import/source-registry.ts";
import { createImportSourceSecrets } from "../../src/import/source-secrets.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { createImportRecords } from "../../src/import/maintenance-records.ts";
import { importOpenclaw } from "../../src/import/importers/openclaw.ts";
import { resolveImportOptions } from "../../src/import/plan-options.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { openMaintenanceJournal } from "../../src/import/maintenance-journal.ts";
import { fingerprintImportTarget } from "../../src/import/maintenance-worker.ts";
import { createLocalFs } from "@plur1bus/remote-fs";
import type { SourceRegistryOptions } from "../../src/import/source-registry.ts";

const temp = useTempDirs();
const OWNER: Principal = { kind: "person", role: "owner", userId: "owner" };
const ADMIN: Principal = { kind: "person", role: "admin", userId: "admin" };
const MARKER = "fixture-source-private-persona-and-api-token";

async function fixture(now: () => number = Date.now,
  ssh?: (root: string) => NonNullable<SourceRegistryOptions["ssh"]>) {
  const module = await import("../../src/import/service.ts").catch(() => undefined);
  assert.equal(typeof module?.createImportService, "function", "the actual Core needs import planning handlers");
  const home = temp();
  const source = temp();
  const cfg = defaults();
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
  mkdirSync(join(home, "state"));
  mkdirSync(join(source, "workspace"));
  writeFileSync(join(source, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
    agents: { defaults: { workspace: "./workspace" } } }));
  writeFileSync(join(source, "workspace", "SOUL.md"), MARKER);
  writeFileSync(join(source, ".env"), `OPENAI_API_KEY=${MARKER}\n`);
  const sources = createSourceRegistry({ home, now, ...(ssh ? { ssh: ssh(source) } : {}) });
  const sourceSecrets = createImportSourceSecrets();
  const changes: { dryRun: boolean }[] = [];
  const audit = memoryAuditSink();
  let revision = "rev";
  const service = module!.createImportService({ home, sources, sourceSecrets, now,
    audit,
    config: { get: async () => ({ config: cfg, revision }), set: async params => {
      changes.push(params);
      return { revision: "rev" };
    } },
    target: async () => ({ roots: [{ id: "state", path: join(home, "state"), kind: "directory" as const,
      preserve: ["core.lock"] }], coldBytes: 4096, availableBytes: 1024 ** 3, writable: true,
    foreignLock: false, completeCoverage: true, exclusiveWriter: true }),
    store: async () => ({ supported: true }), model: async () => ({ present: true, licenceAccepted: true }),
    secrets: { status: async () => ({ backend: "file" as const, degraded: true, keyring: { available: false },
      file: { enabled: true, available: true }, count: 0, activeLeases: 0, secrets: [] }) },
  });
  return { home, source, changes, service, sourceSecrets, sources, audit, cfg, setRevision: (value: string) => { revision = value; } };
}

describe("live Core import service", () => {
  it("persists an Owner-bound plan and source-secret ticket with no target mutation or public values", async () => {
    const f = await fixture();
    try {
      const detected = await f.service.detect({ kind: "path", family: "openclaw", path: f.source }, OWNER);
      const plan = await f.service.plan({ sourceId: detected.sourceId, options: { migrateSecrets: true } }, OWNER);
      assert.equal(validateResult("admin.import.plan", plan).ok, true);
      const preflight = await f.service.preflight({ planId: plan.planId }, OWNER);
      assert.equal(preflight.ok, true, JSON.stringify(preflight.issues));
      assert.equal(validateResult("admin.import.preflight", preflight).ok, true);
      assert.ok(f.changes.every(change => change.dryRun));
      assert.equal(existsSync(join(f.home, "agents")), false);
      assert.ok(!JSON.stringify({ detected, plan, preflight }).includes(MARKER));
      rmSync(join(f.home, "imports", "preflight", preflight.preflightId! + ".json"));
      const binding = await f.service.binding(plan.planId, preflight.preflightId!);
      assert.equal(binding?.ownerId, OWNER.userId);
      const lease = f.sourceSecrets.take(binding!);
      assert.equal([...lease.entries()][0]![1].toString(), MARKER);
      lease.release();
      await assert.rejects(f.service.plan({ sourceId: detected.sourceId }, ADMIN));
    } finally { f.service.close(); }
  });

  it("denies remote Admin free paths, agent principals, and secret migration before opening a source", async () => {
    const f = await fixture();
    try {
      await assert.rejects(f.service.detect({ kind: "path", family: "openclaw", path: f.source }, ADMIN));
      await assert.rejects(f.service.detect({ kind: "path", family: "openclaw", path: f.source },
        { ...OWNER, kind: "agent" }));
      const source = await f.service.detect({ kind: "path", family: "openclaw", path: f.source }, ADMIN, undefined, true);
      await assert.rejects(f.service.plan({ sourceId: source.sourceId, options: { migrateSecrets: true } }, ADMIN));
      assert.equal(existsSync(join(f.home, "imports", "plans")), false);
    } finally { f.service.close(); }
  });

  it("imports actual skills live, disabled by default, and returns only bounded metadata", async () => {
    const f = await fixture();
    try {
      mkdirSync(join(f.source, "workspace", "skills", "useful"), { recursive: true });
      writeFileSync(join(f.source, "workspace", "skills", "useful", "SKILL.md"), "---\nname: useful\ndescription: useful\n---\n" + MARKER);
      const source = await f.service.detect({ kind: "path", family: "openclaw", path: f.source }, OWNER);
      const preview = await f.service.skills({ sourceId: source.sourceId }, OWNER);
      assert.equal(preview.mode, "dry-run");
      assert.equal(existsSync(join(f.home, "skills")), false);
      const applied = await f.service.skills({ sourceId: source.sourceId, apply: true }, OWNER);
      assert.equal(validateResult("admin.import.skills", applied).ok, true);
      assert.equal(applied.counts.imported, 1);
      assert.equal(applied.skills[0]?.enabled, false);
      assert.match(applied.runId, /^[a-f0-9-]{36}$/);
      assert.ok(readFileSync(join(f.home, "skills", "useful", "SKILL.md"), "utf8").includes(MARKER));
      assert.ok(!JSON.stringify(applied).includes(MARKER));
      assert.equal(f.changes.length, 0);
    } finally { f.service.close(); }
  });

  it("offers every known family candidate and permits a remote Admin only the exact discovered descriptor", async () => {
    const f = await fixture();
    try {
      mkdirSync(join(f.source, ".hermes"));
      writeFileSync(join(f.source, ".hermes", "config.yaml"), "_config_version: 45\n");
      const discovery = await f.service.discover({ kind: "path", family: "openclaw", path: f.source }, ADMIN,
        undefined, true);
      assert.equal(discovery.discovery, true);
      assert.equal(discovery.candidates.length, 2);
      assert.deepEqual(validateResult("admin.import.detect", discovery), { ok: true });
      const approved = discovery.candidates.find(candidate => candidate.source.family === "openclaw")!;
      const selected = await f.service.detect(approved.source, ADMIN);
      assert.equal(selected.sourceType, "openclaw");
      await assert.rejects(f.service.detect({ ...approved.source, path: temp() } as never, ADMIN));
      await assert.rejects(f.service.detect(approved.source, { ...ADMIN, userId: "another-admin" }));
    } finally { f.service.close(); }
  });

  it("allows remote Admin SSH discovery only at configured roots and reading only exact discovered choices", async () => {
    let opened = 0;
    const f = await fixture(Date.now, root => ({
      listConnections: async () => ({ connections: [{ id: "host", roots: ["/configured"] }] }),
      open: async (_id, authority) => {
        assert.equal(authority, "/configured"); opened++;
        const fs = await createLocalFs({ root });
        const canonical = await fs.realpath(".");
        const local = (path: string) => join(canonical, ...posix.relative("/configured", path).split("/"));
        return { close: async () => {}, fs: {
          stat: path => fs.stat(local(path)), lstat: path => fs.lstat(local(path)),
          readdir: path => fs.readdir(local(path)), readFile: (path, max) => fs.readFile(local(path), max),
          realpath: async path => posix.join("/configured", relative(canonical, await fs.realpath(local(path))).split(sep).join("/")),
          readlink: path => fs.readlink(local(path)),
        } };
      },
    }));
    const hidden = join(f.source, "unrelated", "deep");
    mkdirSync(join(hidden, "workspace"), { recursive: true });
    writeFileSync(join(hidden, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
      agents: { defaults: { workspace: "./workspace" } } }));
    const choice = { kind: "ssh" as const, family: "openclaw", connectionId: "host", path: "/configured/unrelated/deep" };
    try {
      await assert.rejects(f.service.detect(choice, ADMIN));
      await assert.rejects(f.service.discover(choice, ADMIN));
      assert.equal(opened, 0, "arbitrary nested paths are rejected before any SSH opening");
      const discovery = await f.service.discover({ ...choice, path: "/configured" }, ADMIN);
      assert.equal(opened, 1);
      assert.equal(discovery.candidates.length, 1, "bounded discovery never scans the unrelated nested source");
      await f.service.detect(discovery.candidates[0]!.source, ADMIN);
      assert.equal(opened, 2);
      await assert.rejects(f.service.detect(discovery.candidates[0]!.source, { ...ADMIN, userId: "another-admin" }));
      assert.equal(opened, 2);
      await f.service.detect(choice, OWNER);
      await f.service.detect(choice, ADMIN, undefined, true);
      assert.equal(opened, 4, "Owner and trusted local Admin additional paths retain their authorized behavior");
    } finally { f.service.close(); }
  });

  it("seals explicitly authorized external maps before planning and imports their frozen bytes without reopening them", async () => {
    const f = await fixture();
    const external = temp();
    writeFileSync(join(external, "SOUL.md"), "selected external persona");
    writeFileSync(join(external, ".env"), `OPENAI_API_KEY=${MARKER}\n`);
    writeFileSync(join(f.source, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
      agents: { list: [{ id: "mapped", workspace: "/foreign/workspace" }] } }));
    try {
      const detected = await f.service.detect({ kind: "path", family: "openclaw", path: f.source }, OWNER);
      const planned = await f.service.plan({ sourceId: detected.sourceId,
        options: { maps: [{ from: "/foreign/workspace", to: external }] } }, OWNER);
      assert.notEqual(planned.sourceSha256, detected.sourceSha256);
      const { record } = await createImportRecords(f.home).readPlan(planned.planId, OWNER.userId, planned.planSha256);
      const captured = await f.sources.get(record.sourceId, OWNER);
      assert.ok(!JSON.stringify(captured.metadata).includes(MARKER));
      assert.ok(captured.metadata.omittedCredentials?.some(path => path.endsWith("/.env")));
      writeFileSync(join(external, "SOUL.md"), "changed after plan; must never enter target");
      const report = await importOpenclaw({ home: f.home, source: captured.root, reader: captured.reader, apply: true,
        ...resolveImportOptions(captured, record.options) });
      assert.equal(report.errors.length, 0);
      assert.equal(readFileSync(join(f.home, "agents", "mapped", "workspace", "SOUL.md"), "utf8"), "selected external persona");
    } finally { f.service.close(); }
  });

  it("allows a remote Admin only an owner-bound discovered store mapping and seals its exact bytes", async () => {
    const f = await fixture();
    const store = join(f.source, ".plur1bus", "state", "lancedb");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "SOUL.md"), "discovered store fixture");
    writeFileSync(join(f.source, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
      agents: { list: [{ id: "mapped", workspace: "/foreign/workspace" }] } }));
    try {
      const discovery = await f.service.discover({ kind: "path", family: "openclaw", path: f.source }, ADMIN, undefined, true);
      const detected = await f.service.detect(discovery.candidates[0]!.source, ADMIN);
      const to = `store:${discovery.stores![0]!.id}`;
      const planned = await f.service.plan({ sourceId: detected.sourceId,
        options: { maps: [{ from: "/foreign/workspace", to }] } }, ADMIN);
      const { record } = await createImportRecords(f.home).readPlan(planned.planId, ADMIN.userId, planned.planSha256);
      assert.ok(record.options.maps?.every(mapping => mapping.to.startsWith(join(f.home, "import"))));
      assert.ok(!JSON.stringify(record.options).includes("store:"));
      await assert.rejects(f.service.plan({ sourceId: detected.sourceId,
        options: { maps: [{ from: "/foreign/workspace", to: store }] } }, ADMIN));
    } finally { f.service.close(); }
  });

  it("reopens an expired source only through its immutable owner-bound plan for a fresh resume preflight", async () => {
    let now = Date.now();
    const f = await fixture(() => now);
    try {
      const detected = await f.service.detect({ kind: "path", family: "openclaw", path: f.source }, OWNER);
      const planned = await f.service.plan({ sourceId: detected.sourceId }, OWNER);
      const file = join(f.home, "imports", "sources", detected.sourceId + ".json");
      const saved = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({ ...saved, expiresAt: new Date(now + 60_000).toISOString() }));
      now += 60 * 60 * 1000;
      await assert.rejects(f.sources.get(detected.sourceId, OWNER));
      const preflight = await f.service.preflight({ planId: planned.planId }, OWNER);
      assert.equal(preflight.ok, true, JSON.stringify(preflight.issues));
      await assert.rejects(f.service.plan({ sourceId: detected.sourceId }, OWNER));
      await assert.rejects(f.service.preflight({ planId: planned.planId }, ADMIN));
    } finally { f.service.close(); }
  });

  it("admits fresh rollback after the import changed configuration and still refuses later target changes", async () => {
    const f = await fixture();
    try {
      const detected = await f.service.detect({ kind: "path", family: "openclaw", path: f.source }, OWNER);
      const planned = await f.service.plan({ sourceId: detected.sourceId }, OWNER);
      const { record } = await createImportRecords(f.home).readPlan(planned.planId, OWNER.userId);
      f.cfg.agents.main = {};
      writeFileSync(join(f.home, "config.json"), JSON.stringify(f.cfg));
      f.setRevision("after-import");
      const journal = openMaintenanceJournal(f.home, planned.runId);
      journal.advance("snapshotting"); journal.advance("snapshot-complete", { snapshotSha256: "a".repeat(64) });
      journal.advance("applying");
      journal.advance("committed", { targetSha256: await fingerprintImportTarget(f.home, record.roots) });
      assert.equal((await f.service.preflight({ planId: planned.planId }, OWNER)).ok, false, "apply still checks original config revision");
      const rollback = await f.service.preflight({ planId: planned.planId, operation: "rollback" }, OWNER);
      assert.equal(rollback.ok, true, JSON.stringify(rollback.issues));
      writeFileSync(join(f.home, "state", "later-user-change"), "retain this later work");
      const changed = await f.service.preflight({ planId: planned.planId, operation: "rollback" }, OWNER);
      assert.equal(changed.ok, false);
      assert.ok(changed.issues.some(issue => issue.reason === "target-changed"));
    } finally { f.service.close(); }
  });

  it("audits live import admission, plan IDs, preflight and denied authority without source paths or content", async () => {
    const f = await fixture();
    const { buildImportMethods } = await import("../../src/import/service.ts");
    let who: Principal = OWNER;
    const methods = buildImportMethods(f.service, () => who);
    const context = { requestId: "r", connectionId: "c", signal: new AbortController().signal };
    try {
      const detected = await methods["admin.import.detect"]!({ source: {
        kind: "path", family: "openclaw", path: f.source,
      } }, context) as { sourceId: string };
      const plan = await methods["admin.import.plan"]!({ sourceId: detected.sourceId }, context) as { planId: string; runId: string };
      await methods["admin.import.preflight"]!({ planId: plan.planId }, context);
      who = { ...OWNER, kind: "agent" };
      await assert.rejects(methods["admin.import.detect"]!({ source: { kind: "path", family: "openclaw", path: f.source } }, context));
      const events = JSON.stringify(f.audit.events);
      assert.ok(events.includes("import.detect") && events.includes("import.plan") && events.includes("import.preflight"));
      assert.ok(events.includes(plan.runId) && events.includes("denied"));
      assert.ok(!events.includes(MARKER) && !events.includes(f.source));
    } finally { f.service.close(); }
  });
});
