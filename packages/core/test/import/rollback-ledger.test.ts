// core/import rollback.ts against hand-built import runs (docs/import.md §5.3 resumability, §5.5 rollback). The existing
// pipeline-batch4.test.ts drives rollback through a real import; here the run on disk is built by hand (helpers.ts), so every
// refusal reason, the containment checks and the failure behaviour can be exercised exactly and independently of the importer.
// Properties: a dry run writes nothing; apply restores the snapshot byte-exactly and leaves user files alone; a hostile manifest or
// ledger cannot make it touch anything outside the home; a failure in the middle never loses a file (everything it removed is
// backed up first) and a retry converges.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { _testFsAtomicHooks } from "../../src/import/fs-atomic.ts";
import { RUN_ID_RE, checkPathComponentsForSymlinks, rollbackImport, verifyAncestorContainment, type RollbackOptions } from "../../src/import/rollback.ts";
import { ImportError } from "../../src/import/types.ts";
import { buildRollbackFixture, rewriteManifest, sha256Hex, snapshotTree, useTempDirs, type RollbackFixture, type RollbackFixtureOptions } from "./helpers.ts";

const tmpDir = useTempDirs();
afterEach(() => { _testFsAtomicHooks.beforeRename = undefined; });
const posixOnly = process.platform === "win32" ? "POSIX symlinks" : undefined;
const NOW = () => new Date("2026-10-13T13:00:00.000Z");
const build = (o: RollbackFixtureOptions = {}) => buildRollbackFixture(tmpDir, o);
const run = (fx: RollbackFixture, o: Partial<RollbackOptions> = {}) => rollbackImport({ home: fx.home, reportPath: fx.reportPath, apply: false, sourceType: "openclaw", now: NOW, ...o });
const read = (file: string) => readFileSync(file, "utf8");
async function refusal(fn: () => Promise<unknown>): Promise<ImportError> {
  try { await fn(); } catch (e) { assert.ok(e instanceof ImportError, String(e)); return e; }
  assert.fail("expected an ImportError");
}
const SOUL = "agents/alpha/workspace/SOUL.md";
const typical = (): RollbackFixtureOptions => ({
  pre: { "config.json": "{\"v\":1}\n", [SOUL]: "soul before\n" },
  modified: { "config.json": "{\"v\":2}\n", [SOUL]: "soul after the import\n" },
  created: { "agents/beta/workspace/SOUL.md": "beta soul\n", "agents/alpha/workspace/NEW.md": "new\n" },
  userFiles: { "agents/alpha/workspace/mine.md": "written by the user\n" },
});

describe("RUN_ID_RE", () => {
  it("accepts 1-64 letters, digits, '_' and '-'", () => {
    for (const ok of ["a", "run-1", "RUN_2", "2026-10-13T12-00-00Z".replaceAll(":", "-"), "a".repeat(64), "0", "-", "_"]) assert.ok(RUN_ID_RE.test(ok), ok);
  });
  it("refuses everything else, including traversal, separators, spaces, dots, NUL, newline and 65 characters", () => {
    for (const bad of ["", "a".repeat(65), "..", "../x", "a/b", "a\\b", "a b", "a.b", "a\0b", "a\n", "\nabc", "é", "a:b", " a", "a "]) assert.ok(!RUN_ID_RE.test(bad), JSON.stringify(bad));
  });
});

describe("rollback dry run", () => {
  it("lists exactly what apply would do, sorted, and writes nothing (not even a lock file)", async () => {
    const fx = build(typical());
    const before = snapshotTree(fx.home);
    const r = await run(fx);
    assert.deepEqual(r.changes, [
      { path: "agents/alpha/workspace/NEW.md", change: "remove" },
      { path: SOUL, change: "revert" },
      { path: "agents/beta/workspace/SOUL.md", change: "remove" },
      { path: "config.json", change: "revert" },
    ]);
    assert.deepEqual([r.mode, r.status, r.movedAside, r.runId, r.sourceType, r.startedAt, r.finishedAt], ["dry-run", "planned", null, "run-1", "openclaw", "2026-10-13T13:00:00.000Z", undefined]);
    assert.deepEqual(snapshotTree(fx.home), before);
    assert.ok(!existsSync(path.join(fx.home, "state")), "a dry run takes no lock");
  });

  it("classifies pre-import files as unchanged, revert or restore", async () => {
    const fx = build({ pre: { "config.json": "c", "agents/a/workspace/same.md": "same", "agents/a/workspace/changed.md": "old", "agents/a/workspace/gone.md": "gone" }, modified: { "agents/a/workspace/changed.md": "new" }, deleted: ["agents/a/workspace/gone.md"] });
    const r = await run(fx);
    assert.deepEqual(r.changes.map((c) => [c.path, c.change]), [
      ["agents/a/workspace/changed.md", "revert"], ["agents/a/workspace/gone.md", "restore"], ["agents/a/workspace/same.md", "unchanged"], ["config.json", "unchanged"],
    ]);
  });

  it("reports the snapshot, the report path and the manifest hash it verified", async () => {
    const fx = build(typical());
    const r = await run(fx);
    assert.equal(r.reportPath, fx.reportPath);
    assert.deepEqual(r.snapshot, { path: fx.snapDir, existed: true, manifestSha256: sha256Hex(read(fx.manifestPath)) });
  });

  it("snapshot.existed is false when neither a config nor an agents directory existed before the import", async () => {
    const fx = build({ created: { "agents/alpha/workspace/SOUL.md": "s" } });
    assert.equal((await run(fx)).snapshot.existed, false);
  });
});

describe("rollback apply", () => {
  it("restores the snapshot byte-exactly, removes what the import created, keeps user files, and backs up everything it replaced or removed", async () => {
    const fx = build(typical());
    const r = await run(fx, { apply: true });
    assert.deepEqual([r.status, r.mode, r.movedAside, r.finishedAt], ["completed", "apply", path.join(fx.runDir, "rolled-back", "replaced"), "2026-10-13T13:00:00.000Z"]);
    assert.equal(read(fx.abs("config.json")), "{\"v\":1}\n");
    assert.equal(read(fx.abs(SOUL)), "soul before\n");
    assert.equal(read(fx.abs("agents/alpha/workspace/mine.md")), "written by the user\n");
    assert.ok(!existsSync(fx.abs("agents/beta")), "the agent the import created is gone with its empty directories");
    assert.ok(!existsSync(fx.abs("agents/alpha/workspace/NEW.md")));
    const backup = (rel: string) => read(path.join(fx.runDir, "rolled-back", "replaced", rel));
    assert.equal(backup("config.json"), "{\"v\":2}\n");
    assert.equal(backup(SOUL), "soul after the import\n");
    assert.equal(backup("agents/beta/workspace/SOUL.md"), "beta soul\n");
    assert.equal(backup("agents/alpha/workspace/NEW.md"), "new\n");
    assert.deepEqual(JSON.parse(read(path.join(fx.runDir, "rolled-back", "status.json"))), { runId: "run-1", sourceType: "openclaw", rolledBackAt: "2026-10-13T13:00:00.000Z", changesCount: 4 });
  });

  it("a file the import deleted comes back from the snapshot", async () => {
    const fx = build({ pre: { "config.json": "{}", [SOUL]: "precious" }, deleted: [SOUL] });
    await run(fx, { apply: true });
    assert.equal(read(fx.abs(SOUL)), "precious");
  });

  it("when no config existed before, the config the import wrote is backed up and removed", async () => {
    const fx = build({ created: { "config.json": "{\"new\":true}" }, agentsExisted: false });
    writeFileSync(fx.abs("config.json"), "{\"new\":true}");
    const r = await run(fx, { apply: true });
    assert.ok(r.changes.some((c) => c.path === "config.json" && c.change === "remove"));
    assert.ok(!existsSync(fx.abs("config.json")));
    assert.equal(read(path.join(fx.runDir, "rolled-back", "replaced", "config.json")), "{\"new\":true}");
  });

  it("the agents directory is removed only when it did not exist before and is empty afterwards", async () => {
    const without = build({ created: { "agents/alpha/workspace/SOUL.md": "s" }, agentsExisted: false });
    await run(without, { apply: true });
    assert.ok(!existsSync(without.abs("agents")));
    const withUser = build({ created: { "agents/alpha/workspace/SOUL.md": "s" }, agentsExisted: false, userFiles: { "agents/alpha/workspace/mine.md": "u" } });
    await run(withUser, { apply: true });
    assert.equal(read(withUser.abs("agents/alpha/workspace/mine.md")), "u");
    const existed = build({ pre: { "agents/other/workspace/x.md": "x" }, created: { "agents/alpha/workspace/SOUL.md": "s" } });
    await run(existed, { apply: true });
    assert.ok(existsSync(existed.abs("agents")) && !existsSync(existed.abs("agents/alpha")));
  });

  it("a second apply, and a dry run after it, are refused as already-rolled-back", async () => {
    const fx = build(typical());
    await run(fx, { apply: true });
    assert.equal((await refusal(() => run(fx, { apply: true }))).reason, "already-rolled-back");
    assert.equal((await refusal(() => run(fx))).reason, "already-rolled-back");
  });

  it("is idempotent on a home that already equals the snapshot: nothing to change, completes", async () => {
    const fx = build({ pre: { "config.json": "{}", [SOUL]: "s" } });
    const r = await run(fx, { apply: true });
    assert.deepEqual(r.changes.map((c) => c.change), ["unchanged", "unchanged"]);
    assert.equal(r.status, "completed");
  });

  it("a created file the user changed afterwards is kept (backed up, reported kept-modified) unless force; force removes it after the backup", async () => {
    const make = () => { const fx = build({ pre: { "config.json": "{}" }, created: { "agents/alpha/workspace/NEW.md": "as imported" } }); writeFileSync(fx.abs("agents/alpha/workspace/NEW.md"), "edited by the user"); return fx; };
    const kept = make();
    const r = await run(kept, { apply: true });
    assert.deepEqual(r.changes.filter((c) => c.path.endsWith("NEW.md")), [{ path: "agents/alpha/workspace/NEW.md", change: "kept-modified" }]);
    assert.equal(read(kept.abs("agents/alpha/workspace/NEW.md")), "edited by the user");
    assert.equal(read(path.join(kept.runDir, "rolled-back", "replaced", "agents/alpha/workspace/NEW.md")), "edited by the user");
    const forced = make();
    const f = await run(forced, { apply: true, force: true });
    assert.deepEqual(f.changes.filter((c) => c.path.endsWith("NEW.md")), [{ path: "agents/alpha/workspace/NEW.md", change: "remove" }]);
    assert.ok(!existsSync(forced.abs("agents/alpha/workspace/NEW.md")));
    assert.equal(read(path.join(forced.runDir, "rolled-back", "replaced", "agents/alpha/workspace/NEW.md")), "edited by the user");
  });

  it("a created file whose ledger entry has no hash is treated as modified (fail safe): kept, unless force", async () => {
    const fx = build({ pre: { "config.json": "{}" }, created: { "agents/alpha/workspace/NEW.md": "x" } });
    writeFileSync(fx.ledgerPath, JSON.stringify({ ts: "t", runId: "run-1", entity: "file", idempotencyKey: "file:t:NEW", action: "created", targetRef: "agents/alpha/workspace/NEW.md", sha256: null }) + "\n");
    assert.equal((await run(fx, { apply: true })).changes.find((c) => c.path.endsWith("NEW.md"))?.change, "kept-modified");
    assert.ok(existsSync(fx.abs("agents/alpha/workspace/NEW.md")));
  });

  it("files a rename conflict created (ledger action 'rename') are removed like created ones; Windows separators in targetRef are understood", async () => {
    const fx = build({ pre: { "config.json": "{}" }, created: { "agents/alpha/workspace/SOUL.imported-1.md": "renamed copy", "agents/alpha/workspace/B.md": "b" } });
    const lines = [
      { ts: "t", runId: "run-1", entity: "file", idempotencyKey: "k1", action: "rename", targetRef: "agents/alpha/workspace/SOUL.imported-1.md", sha256: sha256Hex("renamed copy") },
      { ts: "t", runId: "run-1", entity: "file", idempotencyKey: "k2", action: "created", targetRef: "agents\\alpha\\workspace\\B.md", sha256: sha256Hex("b") },
    ];
    writeFileSync(fx.ledgerPath, lines.map((l) => JSON.stringify(l) + "\n").join(""));
    await run(fx, { apply: true });
    assert.ok(!existsSync(fx.abs("agents/alpha/workspace/SOUL.imported-1.md")) && !existsSync(fx.abs("agents/alpha/workspace/B.md")));
  });

  it("files that are in neither the snapshot nor the ledger survive, whatever their name", async () => {
    const fx = build({ pre: { "config.json": "{}" }, userFiles: { "agents/alpha/workspace/mine.md": "m", "agents/zeta/workspace/SOUL.md": "z", "agents/alpha/.hidden": "h" } });
    await run(fx, { apply: true });
    for (const rel of ["agents/alpha/workspace/mine.md", "agents/zeta/workspace/SOUL.md", "agents/alpha/.hidden"]) assert.ok(existsSync(fx.abs(rel)), rel);
  });

  it("sourceType in the report must match; a report without one is accepted", async () => {
    const fx = build(typical());
    assert.equal((await refusal(() => run(fx, { sourceType: "hermes" }))).reason, "source-mismatch");
    const report = JSON.parse(read(fx.reportPath)); delete report.sourceType; writeFileSync(fx.reportPath, JSON.stringify(report));
    assert.equal((await run(fx, { sourceType: "hermes" })).status, "planned");
  });

  it("the report's importId (docs/import.md §5.7) is read when there is no runId", async () => {
    const fx = build(typical());
    const report = JSON.parse(read(fx.reportPath)); report.importId = report.runId; delete report.runId; writeFileSync(fx.reportPath, JSON.stringify(report));
    assert.equal((await run(fx)).runId, "run-1");
  });
});

describe("rollback refusals (E_ROLLBACK_INVALID)", () => {
  const code = async (fx: RollbackFixture, o: Partial<RollbackOptions> = {}) => { const e = await refusal(() => run(fx, o)); assert.equal(e.code, "E_ROLLBACK_INVALID", e.message); return e.reason; };
  const editReport = (fx: RollbackFixture, f: (r: Record<string, unknown>) => void) => { const r = JSON.parse(read(fx.reportPath)); f(r); writeFileSync(fx.reportPath, JSON.stringify(r)); };

  it("report: unreadable, not JSON, no run id, a bad run id, not an apply report", async () => {
    const missing = build(typical()); rmSync(missing.reportPath);
    assert.equal(await code(missing), "report-unreadable");
    const notJson = build(typical()); writeFileSync(notJson.reportPath, "{ not json");
    assert.equal(await code(notJson), "report-unreadable");
    for (const runId of [undefined, null, 5, "", "../x", "a/b", "a".repeat(65)]) {
      const fx = build(typical()); editReport(fx, (r) => { if (runId === undefined) delete r["runId"]; else r["runId"] = runId; });
      assert.equal(await code(fx), "run-id-invalid", JSON.stringify(runId));
    }
    for (const mode of ["dry-run", undefined, "apply "]) {
      const fx = build(typical()); editReport(fx, (r) => { if (mode === undefined) delete r["mode"]; else r["mode"] = mode; });
      assert.equal(await code(fx), "not-an-apply-report", String(mode));
    }
  });

  it("a report that names a different run than the directory it sits in is refused (report-missing / report-outside-home)", async () => {
    const fx = build(typical());
    editReport(fx, (r) => { r["runId"] = "other-run"; });
    assert.equal(await code(fx), "report-missing", "no imports/other-run/report.json");
    const copy = build(typical());
    const elsewhere = path.join(tmpDir(), "report.json");
    writeFileSync(elsewhere, read(copy.reportPath));
    assert.equal(await code(copy, { reportPath: elsewhere }), "report-outside-home");
  });

  it("snapshot: directory missing, manifest missing, manifest hash different from the report's, hash absent in the report", async () => {
    const noSnap = build(typical()); rmSync(noSnap.snapDir, { recursive: true });
    assert.equal(await code(noSnap), "snapshot-missing");
    const noManifest = build(typical()); rmSync(noManifest.manifestPath);
    assert.equal(await code(noManifest), "snapshot-invalid");
    const tampered = build(typical()); writeFileSync(tampered.manifestPath, read(tampered.manifestPath) + " ");
    assert.equal(await code(tampered), "snapshot-corrupt");
    const unsigned = build(typical()); editReport(unsigned, (r) => { delete (r["snapshot"] as Record<string, unknown>)["manifestSha256"]; });
    assert.equal(await code(unsigned), "snapshot-corrupt");
    const noSnapshotField = build(typical()); editReport(noSnapshotField, (r) => { delete r["snapshot"]; });
    assert.equal(await code(noSnapshotField), "snapshot-corrupt");
  });

  it("manifest content: not JSON, wrong schema, wrong run id, no files map, a snapshot file missing or altered", async () => {
    const notJson = build(typical());
    writeFileSync(notJson.manifestPath, "not json"); editReport(notJson, (r) => { (r["snapshot"] as Record<string, unknown>)["manifestSha256"] = sha256Hex("not json"); });
    assert.equal(await code(notJson), "snapshot-corrupt");
    const cases: [string, (m: Record<string, unknown>) => void][] = [
      ["schema", (m) => { m["schema"] = "import.snapshot/2"; }], ["run id", (m) => { m["runId"] = "other"; }], ["no files", (m) => { delete m["files"]; }], ["files not an object", (m) => { m["files"] = "x"; }],
    ];
    for (const [title, mutate] of cases) { const fx = build(typical()); rewriteManifest(fx, mutate); assert.equal(await code(fx), "snapshot-corrupt", title); }
    const missingFile = build(typical()); rmSync(path.join(missingFile.snapDir, "config.json"));
    assert.equal(await code(missingFile), "snapshot-corrupt");
    const altered = build(typical()); writeFileSync(path.join(altered.snapDir, "config.json"), "{\"v\":99}");
    assert.equal(await code(altered), "snapshot-corrupt");
  });

  it("a hostile manifest key is refused as snapshot-invalid before any file is looked at: traversal, absolute, drive letter, '.' and empty segments, outside the allowed targets", async () => {
    const keys = ["../evil.md", "agents/../../evil.md", "agents/a/../../../evil.md", "/etc/passwd", "\\windows\\x", "C:\\x", "c:x", "./config.json", "agents/./a.md", "agents//a.md", "agents/a/", "agents/", "agents", "", "state/core.lock", "imports/run-1/report.json", "config.json/../x", "AGENTS/a.md", "other.json", "agents\\..\\x"];
    for (const key of keys) {
      const fx = build({ pre: { "config.json": "{}" } });
      rewriteManifest(fx, (m) => { (m["files"] as Record<string, unknown>)[key] = { sha256: sha256Hex("x"), size: 1 }; });
      const reason = await code(fx);
      assert.equal(reason, "snapshot-invalid", JSON.stringify(key));
    }
  });

  it("a hostile manifest key never lets a file outside the home change, even when the attacker supplies a matching snapshot file", async () => {
    const outside = tmpDir();
    writeFileSync(path.join(outside, "victim.txt"), "victim");
    const fx = build({ pre: { "config.json": "{}" } });
    const rel = path.relative(fx.snapDir, path.join(outside, "victim.txt"));
    writeFileSync(path.join(outside, "evil-source"), "evil");
    rewriteManifest(fx, (m) => { (m["files"] as Record<string, unknown>)[rel] = { sha256: sha256Hex("evil"), size: 4 }; });
    await refusal(() => run(fx, { apply: true }));
    assert.equal(read(path.join(outside, "victim.txt")), "victim");
  });

  it("ledger: missing, a corrupt line, an entry without key or entity are refused as ledger-corrupt", async () => {
    const missing = build(typical()); rmSync(missing.ledgerPath);
    assert.equal(await code(missing), "ledger-corrupt");
    for (const bad of ["{broken", JSON.stringify({ entity: "file" }), JSON.stringify({ idempotencyKey: "k" }), "null", "[]", "\"x\""]) {
      const fx = build(typical());
      writeFileSync(fx.ledgerPath, read(fx.ledgerPath) + bad + "\n");
      assert.equal(await code(fx), "ledger-corrupt", bad);
    }
  });

  it("ledger: a torn line that the ledger itself repaired (followed by the repair marker) is tolerated, an unrepaired one in the middle is not", async () => {
    const fx = build(typical());
    const marker = JSON.stringify({ ts: "t", runId: "run-1", entity: "system", idempotencyKey: "repair:torn-line", action: "repaired" });
    writeFileSync(fx.ledgerPath, read(fx.ledgerPath) + "{\"ts\":\"t\",\"torn\n" + marker + "\n");
    assert.equal((await run(fx)).status, "planned");
    const unrepaired = build(typical());
    writeFileSync(unrepaired.ledgerPath, "{\"torn\n" + read(unrepaired.ledgerPath));
    assert.equal(await code(unrepaired), "ledger-corrupt");
  });

  it("force does not bypass any validation", async () => {
    const fx = build(typical());
    writeFileSync(path.join(fx.snapDir, "config.json"), "tampered");
    assert.equal(await code(fx, { apply: true, force: true }), "snapshot-corrupt");
    assert.equal(read(fx.abs("config.json")), "{\"v\":2}\n", "nothing was touched");
  });

  it("a refused apply changes nothing in the home (only the lock directory may appear)", async () => {
    const fx = build(typical());
    rmSync(fx.ledgerPath);
    const before = snapshotTree(fx.home);
    await refusal(() => run(fx, { apply: true }));
    const after = snapshotTree(fx.home).filter((x) => !x.startsWith("state"));
    assert.deepEqual(after, before);
  });
});

describe("rollback containment: symlinks and hostile ledger entries", () => {
  it("a symlinked agent directory in the home is refused as unsafe-symlink and the link's target is untouched", { skip: posixOnly }, async () => {
    const outside = tmpDir();
    mkdirSync(path.join(outside, "workspace"), { recursive: true });
    writeFileSync(path.join(outside, "workspace", "SOUL.md"), "outside soul");
    const fx = build({ pre: { "config.json": "{}" } });
    mkdirSync(fx.abs("agents"), { recursive: true });
    symlinkSync(outside, fx.abs("agents/alpha"));
    // the import "created" a file through that link
    writeFileSync(fx.ledgerPath, JSON.stringify({ ts: "t", runId: "run-1", entity: "file", idempotencyKey: "k", action: "created", targetRef: SOUL, sha256: sha256Hex("outside soul") }) + "\n");
    const e = await refusal(() => run(fx, { apply: true }));
    assert.equal(e.reason, "unsafe-symlink");
    assert.equal(read(path.join(outside, "workspace", "SOUL.md")), "outside soul");
  });

  it("a symlink at a restore target is refused, not followed or replaced: unsafe-symlink when it stays inside the home, a containment refusal when it leads outside", { skip: posixOnly }, async () => {
    const outside = tmpDir();
    writeFileSync(path.join(outside, "target"), "outside");
    const leadsOut = build({ pre: { "config.json": "{\"v\":1}" } });
    rmSync(leadsOut.abs("config.json"));
    symlinkSync(path.join(outside, "target"), leadsOut.abs("config.json"));
    const e = await refusal(() => run(leadsOut, { apply: true }));
    assert.equal(e.code, "E_ROLLBACK_INVALID");
    assert.ok(["unsafe-symlink", "snapshot-invalid"].includes(e.reason), e.reason);
    assert.equal(read(path.join(outside, "target")), "outside");
    const staysIn = build({ pre: { "config.json": "{\"v\":1}" } });
    writeFileSync(staysIn.abs("elsewhere.json"), "inside");
    rmSync(staysIn.abs("config.json"));
    symlinkSync(staysIn.abs("elsewhere.json"), staysIn.abs("config.json"));
    assert.equal((await refusal(() => run(staysIn, { apply: true }))).reason, "unsafe-symlink");
    assert.equal(read(staysIn.abs("elsewhere.json")), "inside");
  });

  it("a ledger entry that points above the home is refused and the victim file survives", async () => {
    const base = tmpDir();
    const fx = buildRollbackFixture(() => { const h = path.join(base, "home"); mkdirSync(h); return h; }, { pre: { "config.json": "{}" } });
    writeFileSync(path.join(base, "victim.txt"), "victim");
    writeFileSync(fx.ledgerPath, JSON.stringify({ ts: "t", runId: "run-1", entity: "file", idempotencyKey: "k", action: "created", targetRef: "../victim.txt", sha256: sha256Hex("victim") }) + "\n");
    const e = await refusal(() => run(fx, { apply: true }));
    assert.equal(e.code, "E_ROLLBACK_INVALID");
    assert.equal(read(path.join(base, "victim.txt")), "victim");
  });

  it("a ledger entry with an absolute targetRef is read relative to the home and never removes the absolute path", async () => {
    const outside = tmpDir();
    writeFileSync(path.join(outside, "victim.txt"), "victim");
    const fx = build({ pre: { "config.json": "{}" } });
    writeFileSync(fx.ledgerPath, JSON.stringify({ ts: "t", runId: "run-1", entity: "file", idempotencyKey: "k", action: "created", targetRef: path.join(outside, "victim.txt"), sha256: sha256Hex("victim") }) + "\n");
    await run(fx, { apply: true }).catch(() => undefined);
    assert.equal(read(path.join(outside, "victim.txt")), "victim");
  });

  it("only files under agents/ can be removed, whatever the ledger claims: config.json, state/ and imports/ entries in the ledger do not delete anything", async () => {
    const fx = build({ pre: { "config.json": "{\"v\":1}" }, modified: { "config.json": "{\"v\":2}" } });
    mkdirSync(fx.abs("other"), { recursive: true }); writeFileSync(fx.abs("other/keep.txt"), "keep");
    writeFileSync(fx.ledgerPath, ["other/keep.txt", "imports/run-1/report.json", "state/core.lock"].map((t) => JSON.stringify({ ts: "t", runId: "run-1", entity: "file", idempotencyKey: `k:${t}`, action: "created", targetRef: t, sha256: sha256Hex("keep") }) + "\n").join(""));
    await run(fx, { apply: true });
    assert.equal(read(fx.abs("other/keep.txt")), "keep");
    assert.ok(existsSync(fx.reportPath));
  });

  describe("checkPathComponentsForSymlinks", () => {
    it("passes for plain and not-yet-existing paths, throws unsafe-symlink for a link at any component (and for the leaf)", { skip: posixOnly }, () => {
      const home = tmpDir(); const outside = tmpDir();
      mkdirSync(path.join(home, "a", "b"), { recursive: true });
      writeFileSync(path.join(home, "a", "b", "f"), "f");
      symlinkSync(outside, path.join(home, "a", "link"));
      symlinkSync(path.join(home, "a", "b", "f"), path.join(home, "a", "filelink"));
      assert.doesNotThrow(() => checkPathComponentsForSymlinks(home, "a/b/f"));
      assert.doesNotThrow(() => checkPathComponentsForSymlinks(home, "a/b/not/yet/there"));
      assert.doesNotThrow(() => checkPathComponentsForSymlinks(home, ""));
      for (const rel of ["a/link", "a/link/x", "a/link/deeper/x", "a/filelink"]) {
        assert.throws(() => checkPathComponentsForSymlinks(home, rel), (e: unknown) => e instanceof ImportError && e.reason === "unsafe-symlink" && e.code === "E_ROLLBACK_INVALID", rel);
      }
    });
    it("accepts both separators and ignores empty segments", () => {
      const home = tmpDir();
      mkdirSync(path.join(home, "a", "b"), { recursive: true });
      assert.doesNotThrow(() => checkPathComponentsForSymlinks(home, "a\\b"));
      assert.doesNotThrow(() => checkPathComponentsForSymlinks(home, "a//b/"));
    });
    it("characterization: Ist-Verhalten, nicht spezifiziert - the home directory itself may be (inside) a symlink: only components below it are inspected", { skip: posixOnly }, () => {
      const real = tmpDir(); const base = tmpDir();
      mkdirSync(path.join(real, "a"));
      symlinkSync(real, path.join(base, "homelink"));
      assert.doesNotThrow(() => checkPathComponentsForSymlinks(path.join(base, "homelink"), "a"));
    });
  });

  describe("verifyAncestorContainment", () => {
    it("passes for paths below the home, existing or not", () => {
      const home = tmpDir();
      mkdirSync(path.join(home, "a"));
      for (const p of [home, path.join(home, "a"), path.join(home, "a", "b", "c"), path.join(home, "new", "deep", "file")]) assert.doesNotThrow(() => verifyAncestorContainment(home, p), p);
    });
    it("refuses paths outside the home, including a name-prefix sibling and '..' escapes, as snapshot-invalid", () => {
      const base = tmpDir();
      const home = path.join(base, "home"); mkdirSync(home); mkdirSync(path.join(base, "home-evil"));
      for (const p of [base, path.join(base, "home-evil"), path.join(base, "home-evil", "x"), path.join(home, "..", "x"), path.join(home, "a", "..", "..", "x"), path.parse(base).root]) {
        assert.throws(() => verifyAncestorContainment(home, p), (e: unknown) => e instanceof ImportError && e.reason === "snapshot-invalid" && /escapes home/.test(e.message), p);
      }
    });
    it("the deepest existing ancestor decides: a symlinked directory that leads outside refuses a path below it that does not exist yet", { skip: posixOnly }, () => {
      const home = tmpDir(); const outside = tmpDir();
      symlinkSync(outside, path.join(home, "link"));
      assert.throws(() => verifyAncestorContainment(home, path.join(home, "link", "new", "file")), { reason: "snapshot-invalid" });
      mkdirSync(path.join(home, "real"));
      symlinkSync(path.join(home, "real"), path.join(home, "inside-link"));
      assert.doesNotThrow(() => verifyAncestorContainment(home, path.join(home, "inside-link", "new")));
    });
  });
});

describe("rollback failure in the middle (injected between write and rename)", () => {
  const strays = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.name.includes(".tmp.")) out.push(f); if (e.isDirectory()) walk(f); } };
    walk(dir);
    return out;
  };

  it("at every possible failure point: no file is half-written or lost, no temp file stays, nothing removed is unsaved, and a retry converges to the snapshot", async () => {
    const opts = typical();
    let failPoints = 0;
    for (let k = 1; k <= 40; k++) {
      const fx = build(opts);
      let writes = 0; let fired = false;
      _testFsAtomicHooks.beforeRename = () => { writes++; if (writes === k) { fired = true; throw new Error(`injected failure at write ${k}`); } };
      let failed: unknown;
      try { await run(fx, { apply: true }); } catch (e) { failed = e; }
      _testFsAtomicHooks.beforeRename = undefined;
      if (!fired) { assert.equal(failed, undefined, `k=${k}: no failure injected, so the rollback must have completed`); break; }
      failPoints++;
      const ctx = `failure at atomic write ${k}`;
      assert.match(String((failed as Error).message), /injected failure/, ctx);
      // (a) every pre-import file holds its snapshot or its post-import content, nothing else
      assert.ok(["{\"v\":1}\n", "{\"v\":2}\n"].includes(read(fx.abs("config.json"))), `${ctx}: config.json`);
      assert.ok(["soul before\n", "soul after the import\n"].includes(read(fx.abs(SOUL))), `${ctx}: SOUL.md`);
      // (b) no temp file left behind anywhere
      assert.deepEqual(strays(fx.home), [], ctx);
      // (c) a created file that is gone has been backed up with its exact content
      for (const [rel, content] of Object.entries(fx.created)) {
        if (!existsSync(fx.abs(rel))) assert.equal(read(path.join(fx.runDir, "rolled-back", "replaced", rel)), content, `${ctx}: ${rel} is gone without a backup`);
        else assert.equal(read(fx.abs(rel)), content, `${ctx}: ${rel} changed`);
      }
      assert.equal(read(fx.abs("agents/alpha/workspace/mine.md")), "written by the user\n", `${ctx}: user file`);
      // (d) a failed run is not recorded as done, and a retry completes with the snapshot state
      assert.ok(!existsSync(path.join(fx.runDir, "rolled-back", "status.json")), ctx);
      const retry = await run(fx, { apply: true });
      assert.equal(retry.status, "completed", ctx);
      assert.equal(read(fx.abs("config.json")), "{\"v\":1}\n", ctx);
      assert.equal(read(fx.abs(SOUL)), "soul before\n", ctx);
      for (const rel of Object.keys(fx.created)) assert.ok(!existsSync(fx.abs(rel)), `${ctx}: ${rel} after retry`);
      assert.equal(read(fx.abs("agents/alpha/workspace/mine.md")), "written by the user\n", ctx);
      assert.deepEqual(strays(fx.home), [], ctx);
    }
    assert.ok(failPoints >= 6, `the scenario has at least six atomic writes (backups and restores); saw ${failPoints}`);
  });

  it("a failure while restoring a deleted file leaves the home as it was for that file and the retry restores it", async () => {
    const fx = build({ pre: { "config.json": "{}", [SOUL]: "precious" }, deleted: [SOUL] });
    _testFsAtomicHooks.beforeRename = () => { throw new Error("injected"); };
    await assert.rejects(() => run(fx, { apply: true }), /injected/);
    _testFsAtomicHooks.beforeRename = undefined;
    assert.ok(!existsSync(fx.abs(SOUL)));
    assert.deepEqual(strays(fx.home), []);
    await run(fx, { apply: true });
    assert.equal(read(fx.abs(SOUL)), "precious");
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - after a failed attempt the retry's status.json counts only the changes of the retry", async () => {
    const fx = build(typical());
    let n = 0;
    _testFsAtomicHooks.beforeRename = () => { if (++n === 4) throw new Error("injected"); };
    await assert.rejects(() => run(fx, { apply: true }), /injected/);
    _testFsAtomicHooks.beforeRename = undefined;
    const retry = await run(fx, { apply: true });
    const status = JSON.parse(read(path.join(fx.runDir, "rolled-back", "status.json"))) as { changesCount: number };
    assert.equal(status.changesCount, retry.changes.length);
    assert.ok(retry.changes.length < 4, `the first attempt had already done part of the four changes (retry planned ${retry.changes.length})`);
  });
});

describe("rollback: memory and store accounting (read from the ledger)", () => {
  const withLedger = (extra: object[]) => {
    const fx = build({ pre: { "config.json": "{}" } });
    writeFileSync(fx.ledgerPath, extra.map((l) => JSON.stringify({ ts: "t", runId: "run-1", ...l }) + "\n").join(""));
    return fx;
  };
  it("memory entries are summed from details.created, else details.count, else 1, and reported as not reverted", async () => {
    const fx = withLedger([
      { entity: "memory", idempotencyKey: "m1", action: "created", details: { created: 4 } },
      { entity: "memory", idempotencyKey: "m2", action: "created", details: { count: 3 } },
      { entity: "memory", idempotencyKey: "m3", action: "created" },
    ]);
    const r = await run(fx);
    assert.deepEqual([r.memoryCardsNotReverted, r.memoryUndoStatus], [8, "not-reverted (engine has no undo)"]);
  });
  it("no memory entries: the fields are absent", async () => {
    const r = await run(withLedger([]));
    assert.deepEqual([r.memoryCardsNotReverted, r.memoryUndoStatus, r.storeUndoStatus], [undefined, undefined, undefined]);
  });
  it("an adopted store is planned for removal when it is there; a replaced store is restored only when its backup exists, else reported not-reverted", async () => {
    const adopted = withLedger([{ entity: "store", idempotencyKey: "s", action: "adopted" }]);
    assert.equal((await run(adopted)).storeUndoStatus, undefined, "nothing at state/lancedb: nothing to remove");
    mkdirSync(adopted.abs("state/lancedb"), { recursive: true });
    const r1 = await run(adopted);
    assert.deepEqual([r1.storeUndoStatus, r1.changes.find((c) => c.path === "state/lancedb")?.change], ["removed", "remove"]);
    const replacedNoBackup = withLedger([{ entity: "store", idempotencyKey: "s", action: "replace" }]);
    assert.equal((await run(replacedNoBackup)).storeUndoStatus, "not-reverted");
    const replaced = withLedger([{ entity: "store", idempotencyKey: "s", action: "replace" }]);
    mkdirSync(path.join(replaced.runDir, "replaced", "lancedb"), { recursive: true });
    const r2 = await run(replaced);
    assert.deepEqual([r2.storeUndoStatus, r2.changes.find((c) => c.path === "state/lancedb")?.change], ["restored", "restore"]);
  });
  it("agent entries are accepted from the key or the targetRef; blank lines and repair markers are skipped", async () => {
    const fx = withLedger([{ entity: "agent", idempotencyKey: "agent:openclaw:alpha", action: "created" }, { entity: "agent", idempotencyKey: "weird", action: "created", targetRef: "agents/zed" }]);
    writeFileSync(fx.ledgerPath, "\n   \n" + read(fx.ledgerPath) + JSON.stringify({ ts: "t", runId: "run-1", entity: "system", idempotencyKey: "repair:torn-line", action: "repaired" }) + "\n\n");
    assert.equal((await run(fx)).status, "planned");
  });
});
