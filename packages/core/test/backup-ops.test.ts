import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { CoreClient } from "@plur1bus/module-api";
import { connect } from "./helpers/connect.ts";
import { defaults } from "@plur1bus/config-schema";
import { validateResult } from "@plur1bus/rpc-schema";
import { createCore, type Core } from "../src/core.ts";
import { layout } from "../src/paths.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";
import { tempDir } from "./helpers/temp-dir.ts";

function newHome(): string {
  const home = tempDir("p1b-backup-");
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("admin.backup.snapshot (in-process core)", () => {
  const home = newHome(); const l = layout(home);
  let core: Core; let c: CoreClient;
  before(async () => {
    // A harness-owned SQLite database under state/ (none exists in production yet; the mechanism is what is tested).
    mkdirSync(l.state, { recursive: true });
    const db = new DatabaseSync(join(l.state, "fixture.sqlite"));
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(k TEXT PRIMARY KEY, v TEXT); INSERT INTO t VALUES('a','1'),('b','2');");
    db.close();
    core = createCore({ home, testInternals: flatTestInternals() });
    try {
      await core.start();
      c = await connect({ address: core.address, token: core.token });
    } catch (e) {
      // A setup that fails halfway must not leave a running core behind (it would hold the run keeping the process alive).
      await core.stop({ budgetMs: 5000 }).catch(() => {});
      throw e;
    }
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); });

  it("stages the store, the memory state and the SQLite databases with digests that match the files", async () => {
    const r = await c.call<any>("admin.backup.snapshot", { label: "t1" });
    assert.deepEqual(validateResult("admin.backup.snapshot", r), { ok: true }, JSON.stringify(r));
    assert.match(r.id, /^plur1bus-.*-t1$/);
    assert.ok(r.dir.startsWith(join(l.state, "backup-staging")), r.dir);
    assert.equal(r.storeTarget, "state/lancedb");
    assert.equal(r.engine.contract.split(".")[0], "1");
    assert.ok(r.files.some((f: any) => f.path.startsWith("store/")), JSON.stringify(r.files.map((f: any) => f.path)));
    for (const f of r.files) assert.equal(sha(join(r.dir, ...f.path.split("/"))), f.sha256, f.path);
    const sq = r.files.find((f: any) => f.path === "sqlite/fixture.sqlite");
    assert.ok(sq, "the SQLite database is part of the snapshot");
    const copy = new DatabaseSync(join(r.dir, "sqlite", "fixture.sqlite"), { readOnly: true });
    assert.deepEqual(copy.prepare("SELECT k, v FROM t ORDER BY k").all().map((x) => ({ ...x })), [{ k: "a", v: "1" }, { k: "b", v: "2" }]);
    copy.close();
    assert.ok(!r.files.some((f: any) => /core\.lock|backup-staging/.test(f.path)), "the lock and the staging area are never copied");
  });

  it("is private: the staging root is 0700 on POSIX and holds nothing from run/", async () => {
    const r = await c.call<any>("admin.backup.snapshot", {});
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      assert.equal(statSync(join(l.state, "backup-staging")).mode & 0o077, 0);
    }
    assert.ok(!existsSync(join(r.dir, "run")));
    assert.ok(!r.files.some((f: any) => /token/.test(f.path)));
  });

  it("refuses an invalid label with E_INVALID_PARAMS and unknown params with E_INVALID_PARAMS", async () => {
    await assert.rejects(c.call("admin.backup.snapshot", { label: "" }), (e: any) => e.error === "E_INVALID_PARAMS");
    await assert.rejects(c.call("admin.backup.snapshot", { dir: "/tmp/x" }), (e: any) => e.error === "E_INVALID_PARAMS");
  });
});

describe("admin.backup.snapshot with a store outside the home", () => {
  it("refuses with E_STORAGE reason=store-outside-home", async () => {
    const home = newHome(); const l = layout(home); const outside = tempDir("p1b-store-");
    const cfg = JSON.parse(readFileSync(l.configPath, "utf8")); cfg.engine.baseDbPathOverride = outside;
    writeFileSync(l.configPath, JSON.stringify(cfg));
    const core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    let c: CoreClient | undefined;
    try {
      c = await connect({ address: core.address, token: core.token });
      await assert.rejects(c.call("admin.backup.snapshot", {}), (e: any) => e.error === "E_STORAGE" && e.reason === "store-outside-home");
    } finally { await c?.close(); await core.stop({ budgetMs: 5000 }); }
  });
});
