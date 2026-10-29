/** A supervised importer must restore Engine writes, not only the legacy config/agent snapshot. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { useTempDirs } from "./helpers.ts";
import { DatabaseSync } from "node:sqlite";

const temp = useTempDirs();
const RUN = "cf1f187b-a9b9-4217-bb5e-303c25497a6e";
const config = Buffer.from('{"schemaVersion":1,"agents":{}}\n');

async function factory() {
  const module = await import("../../src/import/maintenance-snapshot.ts").catch(() => undefined);
  assert.equal(typeof module?.createColdSnapshot, "function", "maintenance needs a complete cold target backup");
  return module!;
}

function fixture(home: string) {
  const state = join(home, "state");
  mkdirSync(join(state, "lancedb"), { recursive: true });
  writeFileSync(join(state, "lancedb", "cards"), "baseline cards");
  writeFileSync(join(state, "core.lock"), "lock identity");
  writeFileSync(join(state, "api.db"), "API state");
  mkdirSync(join(state, "audit"));
  writeFileSync(join(state, "audit", "events"), "audit before");
  return [{ id: "state", path: state, kind: "directory" as const,
    preserve: ["core.lock", "api.db", "api.db-wal", "api.db-shm", "audit"] }];
}

describe("cold import maintenance snapshots", () => {
  it("restores added, modified and removed Engine files while retaining current audit, API and lock state", async () => {
    const api = await factory();
    const home = temp();
    const roots = fixture(home);
    const snapshot = await api.createColdSnapshot({ home, runId: RUN, roots, config });
    writeFileSync(join(home, "state", "lancedb", "cards"), "new imported cards");
    writeFileSync(join(home, "state", "lancedb", "new-fragment"), "new fragment");
    writeFileSync(join(home, "state", "api.db"), "API after");
    writeFileSync(join(home, "state", "audit", "events"), "audit after");
    writeFileSync(join(home, "state", "core.lock"), "same live lock");
    let restoredConfig: string | null | undefined;
    await api.restoreColdSnapshot({ home, runId: RUN, roots, sha256: snapshot.sha256,
      restoreConfig: async sha256 => { restoredConfig = sha256; } });
    assert.equal(readFileSync(join(home, "state", "lancedb", "cards"), "utf8"), "baseline cards");
    assert.equal(existsSync(join(home, "state", "lancedb", "new-fragment")), false);
    assert.equal(readFileSync(join(home, "state", "api.db"), "utf8"), "API after");
    assert.equal(readFileSync(join(home, "state", "audit", "events"), "utf8"), "audit after");
    assert.equal(readFileSync(join(home, "state", "core.lock"), "utf8"), "same live lock");
    const manifest = JSON.parse(readFileSync(join(home, "imports", RUN, "cold-snapshot", "manifest.json"), "utf8"));
    assert.equal(restoredConfig, manifest.config.sha256);
    assert.deepEqual(readFileSync(join(home, "imports", RUN, "cold-snapshot", "config.json")), config);
  });

  it("covers an explicit external store and restores absence for newly created mutation roots", async () => {
    const api = await factory();
    const home = temp();
    const external = temp();
    writeFileSync(join(external, "manifest"), "old external generation");
    const roots = [{ id: "store", path: external, kind: "directory" as const },
      { id: "agents", path: join(home, "agents"), kind: "directory" as const }];
    const snapshot = await api.createColdSnapshot({ home, runId: RUN, roots, config: null });
    writeFileSync(join(external, "manifest"), "imported generation");
    mkdirSync(join(home, "agents"));
    writeFileSync(join(home, "agents", "new-agent"), "imported persona");
    let absent = false;
    await api.restoreColdSnapshot({ home, runId: RUN, roots, sha256: snapshot.sha256,
      restoreConfig: async sha256 => { absent = sha256 === null; } });
    assert.equal(readFileSync(join(external, "manifest"), "utf8"), "old external generation");
    assert.equal(existsSync(join(home, "agents")), false);
    assert.equal(absent, true);
  });

  it("verifies every backup and mutation-root binding before removing or rewriting any target", async () => {
    const api = await factory();
    const home = temp();
    const roots = fixture(home);
    const snapshot = await api.createColdSnapshot({ home, runId: RUN, roots, config });
    writeFileSync(join(home, "state", "lancedb", "cards"), "later target");
    const backup = join(home, "imports", RUN, "cold-snapshot", "roots", "state", "lancedb", "cards");
    writeFileSync(backup, "tampered backup");
    let calls = 0;
    await assert.rejects(api.restoreColdSnapshot({ home, runId: RUN, roots, sha256: snapshot.sha256,
      restoreConfig: async () => { calls++; } }));
    assert.equal(readFileSync(join(home, "state", "lancedb", "cards"), "utf8"), "later target");
    assert.equal(calls, 0);
    await assert.rejects(api.restoreColdSnapshot({ home, runId: RUN,
      roots: [{ ...roots[0]!, path: temp() }], sha256: snapshot.sha256, restoreConfig: async () => {} }));
  });

  it("retries restoration after a host config failure and always reuses the original resume baseline", async () => {
    const api = await factory();
    const home = temp();
    const roots = fixture(home);
    const snapshot = await api.createColdSnapshot({ home, runId: RUN, roots, config });
    writeFileSync(join(home, "state", "lancedb", "cards"), "failed partial import");
    const reused = await api.createColdSnapshot({ home, runId: RUN, roots, config: Buffer.from("different config") });
    assert.equal(reused.sha256, snapshot.sha256);
    await assert.rejects(api.restoreColdSnapshot({ home, runId: RUN, roots, sha256: snapshot.sha256,
      restoreConfig: async () => { throw new Error("host unavailable"); } }));
    await api.restoreColdSnapshot({ home, runId: RUN, roots, sha256: snapshot.sha256, restoreConfig: async () => {} });
    assert.equal(readFileSync(join(home, "state", "lancedb", "cards"), "utf8"), "baseline cards");
  });

  it("fingerprints semantic target changes without treating preserved API and audit writes as user conflicts", async () => {
    const api = await factory();
    const home = temp();
    const roots = fixture(home);
    const before = await api.fingerprintMutationRoots(roots);
    writeFileSync(join(home, "state", "api.db"), "new login");
    assert.equal(await api.fingerprintMutationRoots(roots), before);
    writeFileSync(join(home, "state", "lancedb", "cards"), "new user memory");
    assert.notEqual(await api.fingerprintMutationRoots(roots), before);
  });

  it("keeps SQLite logical identity across a real WAL checkpoint on close and still detects new rows", async () => {
    const api = await factory();
    const home = temp();
    const roots = fixture(home);
    const file = join(home, "state", "history.sqlite");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE memories(id INTEGER PRIMARY KEY, body TEXT);"
      + "INSERT INTO memories VALUES(1,'baseline memory')");
    const live = await api.fingerprintMutationRoots(roots);
    db.close();
    assert.equal(await api.fingerprintMutationRoots(roots), live,
      "closing SQLite must not look like user work between preflight and the cold worker");
    const changed = new DatabaseSync(file);
    changed.exec("INSERT INTO memories VALUES(2,'later user memory')");
    changed.close();
    assert.notEqual(await api.fingerprintMutationRoots(roots), live);
  });

  it("refuses linked target or backup segments and an exhausted space budget without altering live data", async () => {
    const api = await factory();
    const home = temp();
    const roots = fixture(home);
    const outside = temp();
    writeFileSync(join(outside, "untouched"), "outside");
    symlinkSync(outside, join(home, "state", "lancedb", "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(api.createColdSnapshot({ home, runId: RUN, roots, config }));
    rmSync(join(home, "state", "lancedb", "linked"));
    await assert.rejects(api.createColdSnapshot({ home, runId: RUN, roots, config, maxBytes: 1 }));
    assert.equal(readFileSync(join(home, "state", "lancedb", "cards"), "utf8"), "baseline cards");
    assert.equal(readFileSync(join(outside, "untouched"), "utf8"), "outside");
  });
});
