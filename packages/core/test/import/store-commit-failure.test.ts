// commitStoreAdopt (importers/hermes-stores.ts, docs/import.md §5.2/§5.5): the swap of a verified staged store into
// state/lancedb is two renames when a store is replaced (live store aside, staged copy in). A failure of either rename
// must never leave the harness without its store: the live store is put back at once. Only if even that fails (the
// process dies, the lock persists) does the moved-aside store stay in imports/<run>/replaced/lancedb with state/lancedb
// missing; rollback.test.ts-style recovery of that state is covered in rollback-ledger.test.ts. The rename is injected,
// so no platform lock is needed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { layout } from "../../src/paths.ts";
import { ImportLedger } from "../../src/import/ledger.ts";
import { commitStoreAdopt, type PreparedStoreAdopt } from "../../src/import/importers/hermes-stores.ts";
import { useTempDirs } from "./helpers.ts";

const tmpDir = useTempDirs();
const put = (file: string, content: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); };
const read = (file: string) => readFileSync(file, "utf8");

function setup(opts: { liveStore: boolean }) {
  const home = tmpDir();
  const l = layout(home);
  const runDir = path.join(home, "imports", "run-1");
  const replacedBackupDir = path.join(runDir, "replaced");
  const stagingDir = `${l.lancedb}.adopt-run-1`;
  if (opts.liveStore) put(path.join(l.lancedb, "marker.txt"), "live store");
  put(path.join(stagingDir, "marker.txt"), "adopted store");
  const prepared: PreparedStoreAdopt = {
    report: { attempted: true, sourcePath: "/src/store", targetPath: l.lancedb, verdict: "ok", action: "preview-ok" },
    resolvedSource: "/src/store",
    stagingDir,
    replacesExisting: opts.liveStore,
  };
  const ledger = new ImportLedger(path.join(runDir, "ledger.jsonl"), "run-1");
  const storeEntries = () => ledger.entries().filter((e) => e.entity === "store");
  return { l, prepared, ledger, replacedBackupDir, stagingDir, storeEntries };
}

/** A rename that fails on the n-th call (1-based) and, with `alsoRestore`, on every call after it. */
function failingRename(failOn: number, alsoRestore = false) {
  let calls = 0;
  return (from: string, to: string) => {
    calls += 1;
    if (calls === failOn || (alsoRestore && calls > failOn)) throw Object.assign(new Error(`injected rename failure #${calls}`), { code: "EBUSY" });
    renameSync(from, to);
  };
}

describe("commitStoreAdopt: failure of a rename", () => {
  it("a failing second rename (staged copy into place) puts the live store back and records no take-over", () => {
    const s = setup({ liveStore: true });
    assert.throws(() => commitStoreAdopt(s.prepared, { l: s.l, ledger: s.ledger, replacedBackupDir: s.replacedBackupDir, rename: failingRename(2) }), /injected rename failure #2/);
    assert.equal(read(path.join(s.l.lancedb, "marker.txt")), "live store", "the harness keeps its store");
    assert.ok(!existsSync(path.join(s.replacedBackupDir, "lancedb")), "nothing is left moved aside");
    assert.deepEqual(s.storeEntries(), [], "no 'replace' entry for a swap that did not happen");
    assert.equal(s.prepared.stagingDir, s.stagingDir, "the staged copy stays registered so the caller's abort removes it");
    assert.equal(read(path.join(s.stagingDir, "marker.txt")), "adopted store");
  });

  it("a failing first rename (live store aside) leaves everything where it was", () => {
    const s = setup({ liveStore: true });
    assert.throws(() => commitStoreAdopt(s.prepared, { l: s.l, ledger: s.ledger, replacedBackupDir: s.replacedBackupDir, rename: failingRename(1) }), /injected rename failure #1/);
    assert.equal(read(path.join(s.l.lancedb, "marker.txt")), "live store");
    assert.ok(!existsSync(path.join(s.replacedBackupDir, "lancedb")));
    assert.deepEqual(s.storeEntries(), []);
  });

  it("when even the put-back fails, the moved-aside store is still in replaced/lancedb for rollback to find", () => {
    const s = setup({ liveStore: true });
    assert.throws(() => commitStoreAdopt(s.prepared, { l: s.l, ledger: s.ledger, replacedBackupDir: s.replacedBackupDir, rename: failingRename(2, true) }), /injected rename failure #2/);
    assert.ok(!existsSync(s.l.lancedb));
    assert.equal(read(path.join(s.replacedBackupDir, "lancedb", "marker.txt")), "live store");
  });

  it("a failing rename of a first-time adoption (no live store) records nothing and leaves no store", () => {
    const s = setup({ liveStore: false });
    assert.throws(() => commitStoreAdopt(s.prepared, { l: s.l, ledger: s.ledger, replacedBackupDir: s.replacedBackupDir, rename: failingRename(1) }), /injected rename failure #1/);
    assert.ok(!existsSync(s.l.lancedb));
    assert.deepEqual(s.storeEntries(), []);
  });
});

describe("commitStoreAdopt: success keeps working", () => {
  it("replace: the live store is backed up, the staged copy is in place, the ledger records 'replace'", () => {
    const s = setup({ liveStore: true });
    const report = commitStoreAdopt(s.prepared, { l: s.l, ledger: s.ledger, replacedBackupDir: s.replacedBackupDir });
    assert.equal(report.action, "taken-over");
    assert.equal(read(path.join(s.l.lancedb, "marker.txt")), "adopted store");
    assert.equal(read(path.join(s.replacedBackupDir, "lancedb", "marker.txt")), "live store");
    assert.deepEqual(s.storeEntries().map((e) => [e.action, e.targetRef]), [["replace", "state/lancedb"]]);
    assert.equal(s.prepared.stagingDir, undefined);
  });

  it("first-time adoption: the staged copy is in place, the ledger records 'adopted'", () => {
    const s = setup({ liveStore: false });
    commitStoreAdopt(s.prepared, { l: s.l, ledger: s.ledger, replacedBackupDir: s.replacedBackupDir });
    assert.equal(read(path.join(s.l.lancedb, "marker.txt")), "adopted store");
    assert.deepEqual(s.storeEntries().map((e) => e.action), ["adopted"]);
  });
});
