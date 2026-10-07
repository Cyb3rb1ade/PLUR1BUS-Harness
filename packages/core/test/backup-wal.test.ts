// Regression tests for `admin.backup.snapshot` on a FRESH home with a database that is in active WAL use:
//  - B1: the staged copy must be a self-contained file (no `-wal`/`-shm`/`-journal`), otherwise the CLI's archive plan
//    fails with `manifest-invalid: unit "state/<db>.sqlite-shm" is not allowed`.
//  - B2: `node:sqlite`'s `backup()` could leave its promise pending until an unrelated event woke the loop (macOS), so
//    the reply came after the caller's 30 s timeout; every snapshot must now finish in seconds, call after call.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { CoreClient } from "@plur1bus/module-api";
import { connect } from "./helpers/connect.ts";
import { defaults } from "@plur1bus/config-schema";
import { validateResult } from "@plur1bus/rpc-schema";
import { copyDatabase, isSqliteSidecar, withLoopKeepalive } from "../src/backup-ops.ts";
import { createCore, type Core } from "../src/core.ts";
import { layout } from "../src/paths.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";
import { tempDir } from "./helpers/temp-dir.ts";

/** A brand-new home: nothing but a config, exactly what the first `plur1bus backup create` meets. */
function freshHome(): string {
  const home = tempDir("p1b-backup-wal-");
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}

/** Every file below `dir` (relative, `/`-joined). */
function listAll(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listAll(join(dir, e.name), rel)); else out.push(rel);
  }
  return out.sort();
}

describe("copyDatabase", () => {
  it("copies a WAL database with its un-checkpointed rows into one self-contained file", async () => {
    const dir = tempDir("p1b-copydb-");
    const src = join(dir, "live.sqlite");
    const writer = new DatabaseSync(src);
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(n INTEGER)");
    for (let i = 0; i < 200; i++) writer.prepare("INSERT INTO t VALUES(?)").run(i);
    assert.ok(existsSync(`${src}-wal`), "precondition: the rows are in the WAL");
    try {
      const dest = join(dir, "copy.sqlite");
      await copyDatabase(src, dest);
      assert.deepEqual(readdirSync(dir).filter(isSqliteSidecar).filter((n) => n.startsWith("copy")), [], "no sidecar next to the copy");
      const c = new DatabaseSync(dest, { readOnly: true });
      assert.equal((c.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
      assert.equal((c.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "delete");
      assert.equal((c.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n, 200, "the WAL rows are in the copy");
      c.close();
      assert.deepEqual(readdirSync(dir).filter(isSqliteSidecar).filter((n) => n.startsWith("copy")), [], "reading the copy leaves no sidecar either");
      writer.prepare("INSERT INTO t VALUES(1000)").run(); // the live database is untouched and still writable
    } finally { writer.close(); }
  });

  it("removes a stale sidecar left at the destination", async () => {
    const dir = tempDir("p1b-copydb-stale-");
    const src = join(dir, "a.sqlite");
    const db = new DatabaseSync(src); db.exec("CREATE TABLE t(n)"); db.close();
    const dest = join(dir, "b.sqlite");
    writeFileSync(`${dest}-shm`, "stale"); writeFileSync(`${dest}-journal`, "stale");
    await copyDatabase(src, dest);
    assert.deepEqual(listAll(dir), ["a.sqlite", "b.sqlite"]);
  });

  it("refuses a source that is not a database", async () => {
    const dir = tempDir("p1b-copydb-bad-");
    writeFileSync(join(dir, "x.sqlite"), "this is not sqlite".repeat(100));
    await assert.rejects(copyDatabase(join(dir, "x.sqlite"), join(dir, "y.sqlite")));
  });
});

describe("withLoopKeepalive", () => {
  it("returns the value, passes errors through and leaves no timer behind", async () => {
    assert.equal(await withLoopKeepalive(async () => 7), 7);
    await assert.rejects(withLoopKeepalive(async () => { throw new Error("boom"); }), /boom/);
    // A leaked interval would keep the test process alive; the runner only exits if both calls cleared theirs.
  });
});

describe("admin.backup.snapshot on a fresh home with an active WAL database", () => {
  const home = freshHome(); const l = layout(home);
  let core: Core; let c: CoreClient; let writer: DatabaseSync;
  const ROWS = 300;
  before(async () => {
    mkdirSync(l.state, { recursive: true });
    writer = new DatabaseSync(join(l.state, "budget.sqlite"));
    // Autocheckpoint off and the connection kept open: every row lives only in `budget.sqlite-wal` while we snapshot.
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE spend(id INTEGER PRIMARY KEY, cents INTEGER)");
    for (let i = 1; i <= ROWS; i++) writer.prepare("INSERT INTO spend(cents) VALUES(?)").run(i);
    core = createCore({ home, testInternals: flatTestInternals() });
    try {
      await core.start();
      c = await connect({ address: core.address, token: core.token });
    } catch (e) {
      await core.stop({ budgetMs: 5000 }).catch(() => {});
      writer.close();
      throw e;
    }
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); writer?.close(); });

  it("stages every database as one self-contained file: no -wal/-shm/-journal in the files or on disk", async () => {
    assert.ok(existsSync(join(l.state, "budget.sqlite-wal")), "precondition: the live database has an active WAL");
    const r = await c.call<any>("admin.backup.snapshot", { label: "wal" });
    assert.deepEqual(validateResult("admin.backup.snapshot", r), { ok: true }, JSON.stringify(r));
    const paths: string[] = r.files.map((f: any) => f.path);
    assert.ok(paths.includes("sqlite/budget.sqlite"), JSON.stringify(paths));
    assert.deepEqual(paths.filter(isSqliteSidecar), [], "no sidecar in the reported files");
    assert.deepEqual(listAll(r.dir).filter(isSqliteSidecar), [], "no sidecar in the staging directory");
  });

  it("the staged copy has the WAL rows and passes an integrity check; as restored it opens, accepts writes and goes back to WAL", async () => {
    const r = await c.call<any>("admin.backup.snapshot", { label: "restore-check" });
    const staged = join(r.dir, "sqlite", "budget.sqlite");
    const ro = new DatabaseSync(staged, { readOnly: true });
    assert.equal((ro.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    assert.equal((ro.prepare("SELECT count(*) AS n FROM spend").get() as { n: number }).n, ROWS);
    assert.equal((ro.prepare("SELECT sum(cents) AS s FROM spend").get() as { s: number }).s, (ROWS * (ROWS + 1)) / 2);
    ro.close();
    // What `backup restore` does with it: the file takes the place of the live one in a home nobody has open.
    const restoredDir = tempDir("p1b-restored-");
    const restored = join(restoredDir, "budget.sqlite");
    copyFileSync(staged, restored);
    const db = new DatabaseSync(restored);
    try {
      assert.equal((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
      db.exec("PRAGMA journal_mode=WAL"); // the engine does this on open
      db.prepare("INSERT INTO spend(cents) VALUES(1)").run();
      assert.equal((db.prepare("SELECT count(*) AS n FROM spend").get() as { n: number }).n, ROWS + 1);
    } finally { db.close(); }
  });

  it("answers call after call without stalling (the macOS loop-wake-up stall made single calls take up to 30 s)", async () => {
    const took: number[] = [];
    for (let i = 0; i < 8; i++) {
      const t = Date.now();
      const r = await c.call<any>("admin.backup.snapshot", { label: `n${i}` });
      took.push(Date.now() - t);
      assert.ok(r.files.some((f: any) => f.path === "sqlite/budget.sqlite"));
      assert.deepEqual(listAll(r.dir).filter(isSqliteSidecar), []);
    }
    assert.ok(Math.max(...took) < 10_000, `slowest snapshot ${Math.max(...took)} ms (all: ${took.join(", ")})`);
  });

  it("leaves the live database alone: still WAL, still writable, nothing locked", () => {
    assert.equal((writer.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    writer.prepare("INSERT INTO spend(cents) VALUES(5)").run();
    const ro = new DatabaseSync(join(l.state, "budget.sqlite"), { readOnly: true });
    assert.equal((ro.prepare("SELECT count(*) AS n FROM spend").get() as { n: number }).n, ROWS + 1);
    ro.close();
  });
});
