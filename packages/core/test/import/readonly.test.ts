import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { closeSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { ImportError } from "../../src/import/types.ts";
import { join } from "node:path";
import { copyFileBounded, envKeyNames, isSecretFileName, isTornReadError, loadLanceDb, openSqliteReadOnly, readBounded, wrapImmutableDb } from "../../src/import/readonly.ts";
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
      (e: unknown) => {
        assert.ok(e instanceof ImportError && e.code === "E_SOURCE_BUSY" && e.reason === "source-busy");
        assert.match(e.message, /\(sqlite errcode \d+\)/);
        return true;
      },
      "immutable query failure must be converted to typed E_SOURCE_BUSY with numeric errcode"
    );
    h.close();
  });

  it("isTornReadError classifies only primary SQLite error codes 5, 6, 10, 11, 26 as torn reads", () => {
    // Primary codes
    assert.equal(isTornReadError({ errcode: 5 }), true); // SQLITE_BUSY
    assert.equal(isTornReadError({ errcode: 6 }), true); // SQLITE_LOCKED
    assert.equal(isTornReadError({ errcode: 10 }), true); // SQLITE_IOERR
    assert.equal(isTornReadError({ errcode: 11 }), true); // SQLITE_CORRUPT
    assert.equal(isTornReadError({ errcode: 26 }), true); // SQLITE_NOTADB

    // Extended codes (errcode & 0xff matches primary)
    assert.equal(isTornReadError({ errcode: 522 }), true); // 10 | (2 << 8) = SQLITE_IOERR_SHORT_READ
    assert.equal(isTornReadError({ errcode: 267 }), true); // 11 | (1 << 8) = SQLITE_CORRUPT_VTAB

    // Non-torn codes must return false
    assert.equal(isTornReadError({ errcode: 1 }), false); // SQLITE_ERROR (syntax, no such table, etc.)
    assert.equal(isTornReadError({ errcode: 19 }), false); // SQLITE_CONSTRAINT
    assert.equal(isTornReadError({ errcode: 8 }), false); // SQLITE_READONLY
    assert.equal(isTornReadError({ code: "ERR_SQLITE_ERROR" }), false); // No errcode
    assert.equal(isTornReadError(null), false);
    assert.equal(isTornReadError(new Error("corrupt")), false); // String matching is removed
  });

  it("wrapImmutableDb translates torn read errcodes and passes other errors unchanged", () => {
    const mockDb = {
      prepare(sql: string) {
        if (sql === "torn_11") {
          const err = new Error("database disk image is malformed");
          (err as any).code = "ERR_SQLITE_ERROR";
          (err as any).errcode = 11;
          throw err;
        }
        if (sql === "torn_5") {
          const err = new Error("database is locked");
          (err as any).code = "ERR_SQLITE_ERROR";
          (err as any).errcode = 5;
          throw err;
        }
        if (sql === "torn_26") {
          const err = new Error("file is not a database");
          (err as any).code = "ERR_SQLITE_ERROR";
          (err as any).errcode = 26;
          throw err;
        }
        if (sql === "syntax_err") {
          const err = new Error('near "FROM": syntax error');
          (err as any).code = "ERR_SQLITE_ERROR";
          (err as any).errcode = 1;
          throw err;
        }
        return {
          all() { return []; },
          get() { return null; },
          iterate() {
            let called = false;
            return {
              next() {
                if (!called) {
                  called = true;
                  const err = new Error("disk I/O error");
                  (err as any).code = "ERR_SQLITE_ERROR";
                  (err as any).errcode = 10;
                  throw err;
                }
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
      exec(sql: string) {
        if (sql === "torn_exec") {
          const err = new Error("database table is locked");
          (err as any).code = "ERR_SQLITE_ERROR";
          (err as any).errcode = 6;
          throw err;
        }
      },
    } as any;

    const wrapped = wrapImmutableDb(mockDb, "/mock/test.db");

    // errcode 11 -> E_SOURCE_BUSY with numeric errcode
    assert.throws(
      () => wrapped.prepare("torn_11"),
      (e: unknown) => {
        assert.ok(e instanceof ImportError);
        assert.equal(e.code, "E_SOURCE_BUSY");
        assert.equal(e.reason, "source-busy");
        assert.ok(e.message.includes("(sqlite errcode 11)"));
        return true;
      }
    );

    // errcode 5 -> E_SOURCE_BUSY with numeric errcode
    assert.throws(
      () => wrapped.prepare("torn_5"),
      (e: unknown) => e instanceof ImportError && e.code === "E_SOURCE_BUSY" && e.message.includes("(sqlite errcode 5)")
    );

    // errcode 26 -> E_SOURCE_BUSY with numeric errcode
    assert.throws(
      () => wrapped.prepare("torn_26"),
      (e: unknown) => e instanceof ImportError && e.code === "E_SOURCE_BUSY" && e.message.includes("(sqlite errcode 26)")
    );

    // errcode 6 in exec -> E_SOURCE_BUSY with numeric errcode
    assert.throws(
      () => wrapped.exec("torn_exec"),
      (e: unknown) => e instanceof ImportError && e.code === "E_SOURCE_BUSY" && e.message.includes("(sqlite errcode 6)")
    );

    // iterator next() with errcode 10 -> E_SOURCE_BUSY
    const stmt = wrapped.prepare("valid");
    const iter = stmt.iterate();
    assert.throws(
      () => iter.next(),
      (e: unknown) => e instanceof ImportError && e.code === "E_SOURCE_BUSY" && e.message.includes("(sqlite errcode 10)")
    );

    // syntax error (errcode 1) passes through unchanged as raw SQLite error
    assert.throws(
      () => wrapped.prepare("syntax_err"),
      (e: unknown) => !(e instanceof ImportError) && (e as any).errcode === 1 && (e as any).code === "ERR_SQLITE_ERROR"
    );
  });

  it("openSqliteReadOnly on immutable fallback passes syntax and missing table errors through unchanged", () => {
    const d = tempDir("p1b-imp-");
    const p = join(d, "immutable_pass_through.db");
    const writer = new DatabaseSync(p);
    writer.exec("CREATE TABLE t(x);");
    writer.close();

    // Open directly with maxCopyBytes: 0 to force immutable
    const h = openSqliteReadOnly(p, { maxCopyBytes: 0 });
    assert.equal(h.mode, "immutable");

    // Missing table error passes through as original ERR_SQLITE_ERROR, NOT E_SOURCE_BUSY
    assert.throws(
      () => h.db.prepare("SELECT * FROM no_such_table").all(),
      (e: unknown) => {
        assert.ok(!(e instanceof ImportError), "must not be converted to ImportError");
        const err = e as { code?: string; errcode?: number; message?: string };
        assert.equal(err.code, "ERR_SQLITE_ERROR");
        assert.equal(err.errcode, 1);
        assert.match(err.message ?? "", /no such table: no_such_table/);
        return true;
      }
    );

    // Syntax error passes through as original ERR_SQLITE_ERROR, NOT E_SOURCE_BUSY
    assert.throws(
      () => h.db.prepare("SELECT FROM").all(),
      (e: unknown) => {
        assert.ok(!(e instanceof ImportError), "must not be converted to ImportError");
        const err = e as { code?: string; errcode?: number; message?: string };
        assert.equal(err.code, "ERR_SQLITE_ERROR");
        assert.equal(err.errcode, 1);
        assert.match(err.message ?? "", /syntax error/);
        return true;
      }
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
