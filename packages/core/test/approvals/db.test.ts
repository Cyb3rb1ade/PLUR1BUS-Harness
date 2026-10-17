import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempDir } from "../helpers/temp-dir.ts";
import { APPROVALS_SCHEMA_VERSION, ApprovalsDbError, approvalsDbPath, openApprovalsDb } from "../../src/approvals/db.ts";
import { layout } from "../../src/paths.ts";

const T = { timeout: 15_000 };
const tables = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
const version = (db: DatabaseSync) => Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);

describe("approvals db: path and migration (D109 §6)", () => {
  it("the file lives under state/ of the harness layout", T, () => {
    const home = tempDir("p1b-apr-");
    assert.equal(approvalsDbPath(home), join(layout(home).state, "approvals.sqlite"));
  });

  it("empty file migrates to v3 with grants, approvals, approval_chain and approval_signatures", T, () => {
    const p = join(tempDir("p1b-apr-"), "state", "approvals.sqlite");
    const db = openApprovalsDb({ path: p });
    assert.equal(APPROVALS_SCHEMA_VERSION, 3);
    assert.equal(version(db), 3);
    for (const t of ["grants", "approvals", "approval_chain", "approval_signatures"]) assert.ok(tables(db).includes(t), t);
    db.close();
  });

  it("a v1 file gains grants.attested_via (NULL for every existing row) and keeps its rows", T, () => {
    const p = join(tempDir("p1b-apr-"), "state", "approvals.sqlite");
    const a = openApprovalsDb({ path: p });
    a.exec("INSERT INTO grants (id, person, agent, capability, match_kind, duration, created_by, created_at, surface, def_hash, chain_seq) VALUES ('g1','p','a','fs.read','capability','always','p',1,3,'h',1)");
    a.exec("ALTER TABLE grants DROP COLUMN attested_via; DROP TABLE IF EXISTS approval_signatures; PRAGMA user_version = 1");
    a.close();
    const b = openApprovalsDb({ path: p });
    assert.equal(version(b), 3);
    assert.deepEqual(b.prepare("SELECT id, attested_via FROM grants").all().map((r) => ({ ...r })), [{ id: "g1", attested_via: null }]);
    b.close();
  });

  it("a v2 file gains approval_signatures and keeps its chain rows", T, () => {
    const p = join(tempDir("p1b-apr-"), "state", "approvals.sqlite");
    const a = openApprovalsDb({ path: p });
    a.prepare("INSERT INTO approval_chain (seq, ts, kind, ref_id, nonce, payload, prev_mac, mac) VALUES (1, 1, 'k', 'r', NULL, '{}', 'p', 'm')").run();
    a.exec("DROP TABLE IF EXISTS approval_signatures; PRAGMA user_version = 2");
    a.close();
    const b = openApprovalsDb({ path: p });
    assert.equal(version(b), 3);
    assert.ok(tables(b).includes("approval_signatures"));
    assert.equal((b.prepare("SELECT COUNT(*) AS n FROM approval_chain").get() as { n: number }).n, 1);
    assert.equal((b.prepare("SELECT COUNT(*) AS n FROM approval_signatures").get() as { n: number }).n, 0);
    b.close();
  });

  it("the file is owner-only on POSIX", { ...T, skip: process.platform === "win32" }, () => {
    const p = join(tempDir("p1b-apr-"), "state", "approvals.sqlite");
    openApprovalsDb({ path: p }).close();
    assert.equal(statSync(p).mode & 0o077, 0);
  });

  it("opening again is idempotent and keeps rows", T, () => {
    const p = join(tempDir("p1b-apr-"), "state", "approvals.sqlite");
    const a = openApprovalsDb({ path: p });
    a.prepare("INSERT INTO approval_chain (seq, ts, kind, ref_id, nonce, payload, prev_mac, mac) VALUES (1, 1, 'k', 'r', NULL, '{}', 'p', 'm')").run();
    a.close();
    const b = openApprovalsDb({ path: p });
    const c = openApprovalsDb({ path: p });
    assert.equal(version(b), 3);
    assert.equal((b.prepare("SELECT COUNT(*) AS n FROM approval_chain").get() as { n: number }).n, 1);
    b.close(); c.close();
  });

  it("an unknown higher version is a clear typed error and the file is left alone", T, () => {
    const p = join(tempDir("p1b-apr-"), "state", "approvals.sqlite");
    openApprovalsDb({ path: p }).close();
    const raw = new DatabaseSync(p);
    raw.exec("PRAGMA user_version = 7");
    raw.close();
    assert.throws(() => openApprovalsDb({ path: p }), (e: unknown) => {
      assert.ok(e instanceof ApprovalsDbError);
      assert.equal(e.code, "newer-schema");
      assert.match(e.message, /schema 7 is newer than this core's 3/);
      return true;
    });
    const again = new DatabaseSync(p);
    assert.equal(version(again), 7);
    again.close();
  });

  it("constraints reject an invalid duration and an invalid surface", T, () => {
    const p = join(tempDir("p1b-apr-"), "state", "approvals.sqlite");
    const db = openApprovalsDb({ path: p });
    const ins = (duration: string, surface: number) => db.prepare(
      "INSERT INTO grants (id, person, agent, capability, match_kind, duration, created_by, created_at, surface, def_hash, chain_seq) VALUES ('g', 'p', 'a', 'fs.read', 'capability', ?, 'p', 1, ?, 'h', 1)",
    ).run(duration, surface);
    assert.throws(() => ins("forever", 3));
    assert.throws(() => ins("always", 9));
    ins("always", 3);
    db.close();
  });
});
