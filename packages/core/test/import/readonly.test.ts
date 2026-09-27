import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
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
