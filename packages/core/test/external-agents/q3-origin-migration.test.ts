import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MIGRATIONS, migrate } from "../../src/session/migrations.ts";
import { SessionStore } from "../../src/session/store.ts";
import { tempDir } from "../helpers/temp-dir.ts";

test("a seeded v8 session upgrades to shared v9 with immutable internal and protocol origins", () => {
  const path = join(tempDir("q3-origin-v8-"), "sessions.sqlite");
  const old = new DatabaseSync(path);
  migrate(old, MIGRATIONS.slice(0, 8));
  old.prepare("INSERT INTO sessions(id,kind,agent_id,owner,scope,title,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("ses_v8", "direct", "worker", "owner", "workspace", "Preserved title", 1, 1);
  old.close();
  const sessions = new SessionStore({ path });
  assert.equal(sessions.getSession("ses_v8")?.title, "Preserved title");
  assert.equal(sessions.getSession("ses_v8")?.origin, undefined);
  const created = ["mcp", "a2a", "acp-agent"].map(origin => sessions.createSession({ kind: "acp", agentId: "worker", owner: "owner", origin: origin as "mcp" | "a2a" | "acp-agent" }));
  sessions.close();
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 9);
    assert.equal(db.prepare("SELECT origin FROM sessions WHERE id='ses_v8'").get()!.origin, null);
    assert.throws(() => db.prepare("UPDATE sessions SET origin='acp-agent' WHERE id='ses_v8'").run(), /immutable/);
    for (const row of created) {
      assert.equal(db.prepare("SELECT origin FROM sessions WHERE id=?").get(row.id)!.origin, row.origin);
      assert.throws(() => db.prepare("UPDATE sessions SET origin=NULL WHERE id=?").run(row.id), /immutable/);
    }
  } finally { db.close(); }
});
