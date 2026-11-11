import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StoreCopy, createStoreAtVersion } from "./store-roundtrip.ts";
import { MIGRATIONS, SCHEMA_VERSION, migrate } from "../../packages/core/src/session/migrations.ts";
import { tempDir } from "../../packages/core/test/helpers/temp-dir.ts";

// P4-02, parity mode B: the TypeScript side of the store round trip (TS writes, Rust reads and writes, TS reads again).
// Rust uses the same helper through the files it leaves behind; these tests prove the helper on a real core schema.

describe("store round-trip helper (mode B)", () => {
  it("builds the session store at every schema version with the matching user_version", () => {
    const dir = tempDir("p1b-store-");
    assert.ok(SCHEMA_VERSION >= 9, "the session store is at v9 or later");
    for (let v = 1; v <= SCHEMA_VERSION; v++) {
      const path = join(dir, `session-v${v}.sqlite`);
      createStoreAtVersion({ path, migrations: MIGRATIONS, version: v, migrate });
      const copy = StoreCopy.open(path);
      try {
        assert.equal(copy.userVersion(), v);
        const c = copy.check();
        assert.deepEqual({ userVersion: c.userVersion, integrity: c.integrity, foreignKeyViolations: c.foreignKeyViolations }, { userVersion: v, integrity: "ok", foreignKeyViolations: 0 });
      } finally { copy.dispose(); }
    }
  });

  it("works on a copy: writes never reach the source, and a WAL that was not checkpointed is part of the copy", () => {
    const dir = tempDir("p1b-store-");
    const path = join(dir, "s.sqlite");
    const src = new DatabaseSync(path);
    src.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER); PRAGMA user_version = 3;");
    src.prepare("INSERT INTO t VALUES (?, ?)").run("a", 1);
    assert.ok(existsSync(`${path}-wal`), "the row sits in the WAL");
    const copy = StoreCopy.open(path); // source still open: the copy takes db and WAL together
    try {
      assert.deepEqual(copy.read("SELECT k, v FROM t ORDER BY k"), [{ k: "a", v: 1 }]);
      assert.equal(copy.write("INSERT INTO t VALUES (?, ?)", "b", 2), 1);
      assert.deepEqual(copy.read("SELECT k FROM t ORDER BY k").map((r) => r.k), ["a", "b"]);
      assert.deepEqual(src.prepare("SELECT k FROM t ORDER BY k").all().map((r) => r.k), ["a"], "the source is untouched");
      assert.equal(copy.userVersion(), 3);
      assert.notEqual(copy.path, path);
    } finally { copy.dispose(); src.close(); }
  });

  it("checks user_version per schema version and says what it found", () => {
    const dir = tempDir("p1b-store-");
    const path = join(dir, "s.sqlite");
    createStoreAtVersion({ path, migrations: MIGRATIONS, version: 2, migrate });
    const copy = StoreCopy.open(path);
    try {
      copy.assertUserVersion(2);
      assert.throws(() => copy.assertUserVersion(9), /user_version is 2, expected 9/);
    } finally { copy.dispose(); }
  });

  it("migrates a copy of an old store to the current version with the core's own migrate()", () => {
    const dir = tempDir("p1b-store-");
    const path = join(dir, "s.sqlite");
    createStoreAtVersion({ path, migrations: MIGRATIONS, version: 1, migrate });
    const copy = StoreCopy.open(path);
    try {
      copy.assertUserVersion(1);
      copy.migrateWith(migrate);
      copy.assertUserVersion(SCHEMA_VERSION);
      assert.equal(copy.check().integrity, "ok");
      assert.equal(new DatabaseSync(path, { readOnly: true }).prepare("PRAGMA user_version").get()!.user_version, 1, "the source stays at v1");
    } finally { copy.dispose(); }
  });

  it("reports foreign-key violations and refuses a source that is not there or not a database", () => {
    const dir = tempDir("p1b-store-");
    const path = join(dir, "fk.sqlite");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = OFF; CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (pid INTEGER REFERENCES p(id)); INSERT INTO c VALUES (7);");
    db.close();
    const copy = StoreCopy.open(path);
    try { assert.equal(copy.check().foreignKeyViolations, 1); } finally { copy.dispose(); }
    assert.throws(() => StoreCopy.open(join(dir, "missing.sqlite")), /store not found/);
    const junk = join(dir, "junk.sqlite");
    writeFileSync(junk, "this is not a sqlite database, only text padding to be longer than a header");
    const bad = StoreCopy.open(junk);
    try { assert.throws(() => bad.check(), /not a database|file is not/i); } finally { bad.dispose(); }
  });
});
