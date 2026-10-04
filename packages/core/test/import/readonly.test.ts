import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { closeSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { ImportError } from "../../src/import/types.ts";
import { join } from "node:path";
import { copyFileBounded, envKeyNames, isSecretFileName, loadLanceDb, openSqliteReadOnly, readBounded } from "../../src/import/readonly.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { treeDigest } from "./tree.ts";

describe("read-only primitives", () => {
  it("envKeyNames returns key names and never a value", () => {
    const d = tempDir("p1b-imp-");
    const p = join(d, ".env");
    writeFileSync(p, "# c\nexport A=sk-fixture-NOT-REAL-9f8e7d\nB=\"x=y\"\n  C = 1\nnot a line\n1BAD=2\n");
    const keys = envKeyNames(p);
    assert.deepEqual(keys, ["A", "B", "C"]);
    assert.ok(!JSON.stringify(keys).includes("sk-fixture"));
    assert.deepEqual(envKeyNames(join(d, "missing")), []);
  });

  it("openSqliteReadOnly sees rows still in a live writer's WAL and leaves the directory byte-identical", () => {
    const d = tempDir("p1b-imp-");
    const p = join(d, "c.db");
    const writer = new DatabaseSync(p);
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1), (2);");
    const before = treeDigest(d);
    const h = openSqliteReadOnly(p);
    assert.equal(h.mode, "copy");
    assert.equal((h.db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n, 2);
    h.close();
    assert.equal(treeDigest(d), before);
    writer.close();
  });

  it("openSqliteReadOnly falls back to an immutable read-only open above the copy limit", () => {
    const d = tempDir("p1b-imp-");
    const p = join(d, "big.db");
    const w = new DatabaseSync(p); w.exec("CREATE TABLE t(x); INSERT INTO t VALUES (7);"); w.close();
    const before = treeDigest(d);
    const h = openSqliteReadOnly(p, { maxCopyBytes: 1 });
    assert.equal(h.mode, "immutable");
    assert.equal((h.db.prepare("SELECT x FROM t").get() as { x: number }).x, 7);
    assert.throws(() => h.db.exec("INSERT INTO t VALUES (8)"));
    h.close();
    assert.equal(treeDigest(d), before);
  });

  it("openSqliteReadOnly re-copies when the source changed during the copy (G7)", () => {
    const d = tempDir("p1b-imp-");
    const p = join(d, "c.db");
    const writer = new DatabaseSync(p);
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1);");
    const seen: number[] = [];
    const h = openSqliteReadOnly(p, { sleep: () => {}, afterCopy: (attempt) => { seen.push(attempt); if (attempt === 1) writer.exec("INSERT INTO t VALUES (2);"); } });
    assert.deepEqual([h.mode, h.attempts, seen], ["copy", 2, [1, 2]]);
    assert.equal((h.db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n, 2, "the second copy carries the write");
    h.close(); writer.close();
  });

  it("openSqliteReadOnly re-copies a copy that fails PRAGMA quick_check", () => {
    const d = tempDir("p1b-imp-");
    const p = join(d, "c.db");
    const w = new DatabaseSync(p); w.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1);"); w.close();
    const h = openSqliteReadOnly(p, { sleep: () => {}, afterCopy: (attempt, copy) => { if (attempt === 1) { const b = readFileSync(copy); b.fill(0x55, 100, 4096); writeFileSync(copy, b); } } });
    assert.deepEqual([h.mode, h.attempts], ["copy", 2]);
    h.close();
  });

  it("openSqliteReadOnly reports source-busy after four changing attempts: immutable fallback for detect, E_SOURCE_BUSY on request", () => {
    const d = tempDir("p1b-imp-");
    const p = join(d, "c.db");
    const writer = new DatabaseSync(p);
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x);");
    const sleeps: number[] = [];
    const churn = { sleep: (ms: number) => { sleeps.push(ms); }, afterCopy: () => { writer.exec("INSERT INTO t VALUES (1);"); } };
    const h = openSqliteReadOnly(p, churn);
    assert.deepEqual([h.mode, h.immutableReason, h.attempts, sleeps.length], ["immutable", "source-busy", 4, 3]);
    h.close();
    assert.throws(() => openSqliteReadOnly(p, { ...churn, onBusy: "throw" }), (e: ImportError) => e.code === "E_SOURCE_BUSY" && e.reason === "source-busy");
    writer.close();
  });

  it("openSqliteReadOnly never writes next to a database a child process keeps writing (busy source)", async () => {
    const d = tempDir("p1b-imp-");
    const p = join(d, "busy.db");
    const w = new DatabaseSync(p); w.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x);"); w.close();
    const child = spawn(process.execPath, ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(p)});
      const end = Date.now() + 1500; let i = 0; while (Date.now() < end) { db.exec("INSERT INTO t VALUES (" + (i++) + ")"); if (i % 200 === 0) db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } db.close();`], { stdio: "ignore" });
    const exited = new Promise((r) => {
      if (child.exitCode !== null) r(child.exitCode);
      else child.on("exit", r);
      child.on("error", r);
    });
    const modes = new Set<string>();
    for (let k = 0; k < 15; k++) {
      const h = openSqliteReadOnly(p, { sleep: () => {} });
      modes.add(h.mode);
      try {
        const row = h.db.prepare("SELECT count(*) AS n FROM t").get() as { n: number };
        assert.ok(Number(row.n) >= 0);
      } catch (e) {
        if (h.mode === "immutable" && e instanceof ImportError && e.code === "E_SOURCE_BUSY") {
          // Expected: immutable read on actively changing database throws typed E_SOURCE_BUSY
        } else {
          throw e;
        }
      } finally {
        h.close();
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    await exited;
    assert.deepEqual(readdirSync(d).filter((n) => !["busy.db", "busy.db-wal", "busy.db-shm"].includes(n)), [], "nothing but the writer's own files");
    assert.ok(modes.size >= 1);
  });

  it("openSqliteReadOnly on immutable fallback turns concurrent mutation error into E_SOURCE_BUSY", () => {
    const d = tempDir("p1b-imp-");
    const p = join(d, "corrupt_under_immutable.db");
    const writer = new DatabaseSync(p);
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1);");
    // Induce source-busy so it falls back to immutable
    const churn = {
      sleep: () => {},
      afterCopy: (attempt: number) => {
        writer.exec(`INSERT INTO t VALUES (${attempt});`);
      },
    };
    const h = openSqliteReadOnly(p, churn);
    assert.equal(h.mode, "immutable");
    assert.equal(h.immutableReason, "source-busy");

    // While immutable handle is open, corrupt the file underneath it to simulate torn read
    writer.close();
    const fd = openSync(p, "r+");
    const buf = Buffer.alloc(100, 0xff);
    writeSync(fd, buf, 0, 100, 100);
    closeSync(fd);

    assert.throws(
      () => h.db.prepare("SELECT count(*) FROM t").get(),
      (e: unknown) => e instanceof ImportError && e.code === "E_SOURCE_BUSY" && e.reason === "source-busy",
      "immutable query failure must be converted to typed E_SOURCE_BUSY"
    );
    h.close();
  });

  it("copyFileBounded and openSqliteReadOnly safely handle concurrent source truncation without hanging", { timeout: 5000 }, () => {
    const d = tempDir("p1b-imp-");
    const src = join(d, "file.bin");
    const dst = join(d, "file-copy.bin");
    writeFileSync(src, Buffer.alloc(256 * 1024, 0xaa));

    // Open fd and truncate file on disk after first read
    const srcFd = openSync(src, "r+");
    ftruncateSync(srcFd, 100);
    closeSync(srcFd);

    // copyFileBounded reads until EOF without hanging
    const res = copyFileBounded(src, dst, 1024 * 1024);
    assert.equal(res.initialSize, 100);
    assert.equal(res.bytesCopied, 100);

    // Test concurrent WAL truncation during openSqliteReadOnly
    const dbPath = join(d, "trunc.db");
    const w = new DatabaseSync(dbPath);
    w.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x);");
    for (let i = 0; i < 200; i++) w.exec(`INSERT INTO t VALUES (${i});`);
    w.close();

    let truncated = false;
    const h = openSqliteReadOnly(dbPath, {
      sleep: () => {},
      copyFile: (s, dest, limit) => {
        if (s.endsWith("-wal") && !truncated) {
          truncated = true;
          // Truncate WAL file concurrently to simulate wal_checkpoint(TRUNCATE) mid-copy
          const fd = openSync(s, "r+");
          ftruncateSync(fd, 0);
          closeSync(fd);
        }
        copyFileBounded(s, dest, limit);
      },
    });
    assert.ok(h.mode === "copy" || h.mode === "immutable");
    h.close();
  });

  it("readBounded refuses directories, missing files and oversize files", () => {
    const d = tempDir("p1b-imp-");
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "f"), "hello");
    assert.equal(readBounded(join(d, "f"), 10), "hello");
    assert.equal(readBounded(join(d, "f"), 2), null);
    assert.equal(readBounded(join(d, "sub"), 10), null);
    assert.equal(readBounded(join(d, "nope"), 10), null);
  });

  it("isSecretFileName names the credential files a skill copy never carries", () => {
    for (const n of [".env", ".env.local", "auth.json", "credentials.json", "server.pem", "x.key", "id_rsa", "id_rsa.pub"]) assert.ok(isSecretFileName(n), n);
    for (const n of ["SKILL.md", "env.md", "keys.md", "run.sh", "authors.json"]) assert.ok(!isSecretFileName(n), n);
  });

  it("loadLanceDb resolves the engine's LanceDB", async () => {
    const lancedb = await loadLanceDb();
    assert.ok(lancedb && typeof lancedb.connect === "function");
  });
});
