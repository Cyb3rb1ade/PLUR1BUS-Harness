import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { ImportError } from "../../src/import/types.ts";
import { join } from "node:path";
import { envKeyNames, isSecretFileName, loadLanceDb, openSqliteReadOnly, readBounded } from "../../src/import/readonly.ts";
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
      db.exec("INSERT INTO t VALUES (0)"); process.send("ready");
      const end = Date.now() + 1500; let i = 1; while (Date.now() < end) { db.exec("INSERT INTO t VALUES (" + (i++) + ")"); if (i % 200 === 0) db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } db.close();`], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const ready = new Promise<boolean>((resolve) => {
      child.once("message", (message) => resolve(message === "ready"));
      child.once("error", () => resolve(false));
      child.once("exit", () => resolve(false));
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
    });
    const watchdog = setTimeout(() => child.kill(), 5000);
    try {
      assert.equal(await ready, true, "writer started");
      for (let k = 0; k < 15; k++) {
        let h: ReturnType<typeof openSqliteReadOnly> | null = null;
        try {
          h = openSqliteReadOnly(p, { sleep: () => {}, onBusy: "throw" });
        } catch (e) {
          assert.ok(e instanceof ImportError);
          assert.equal(e.code, "E_SOURCE_BUSY");
          assert.equal(e.reason, "source-busy");
        }
        if (h) {
          try {
            assert.equal(h.mode, "copy");
            assert.ok((h.db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n >= 0);
          } finally { h.close(); }
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.deepEqual(await exited, { code: 0, signal: null }, "writer exited cleanly");
      const h = openSqliteReadOnly(p, { onBusy: "throw" });
      try {
        assert.equal(h.mode, "copy");
        assert.ok((h.db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n > 0, "the stopped writer's rows are readable");
      } finally { h.close(); }
      assert.deepEqual(readdirSync(d).filter((n) => !["busy.db", "busy.db-wal", "busy.db-shm"].includes(n)), [], "nothing but the writer's own files");
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
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
