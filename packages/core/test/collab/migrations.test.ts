import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SCHEMA_VERSION, migrate } from "../../src/collab/migrations.ts";
import { CollabStore } from "../../src/collab/store.ts";
import { tempDir } from "../helpers/temp-dir.ts";

test("a persisted A2A v5 store upgrades repo/worktree metadata without losing origin rows", (t) => {
  const path = join(tempDir("collab-v5-upgrade-"), "collab.sqlite");
  const old = new DatabaseSync(path);
  try {
    migrate(old, MIGRATIONS.slice(0, 4));
    // Frozen A2A v5 schema, independent of the candidate's v5 entry.
    old.exec("ALTER TABLE spans ADD COLUMN origin TEXT; ALTER TABLE tasks ADD COLUMN origin TEXT; PRAGMA user_version = 5;");
    old.prepare("INSERT INTO projects(id,name,owner,settings,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("project", "Existing project", "owner", "{}", 1, 1);
    old.prepare("INSERT INTO traces(trace_id,project_id,root_agent,root_span_id,created_at,status) VALUES(?,?,?,?,?,?)")
      .run("trace", "project", "agent", "span", 1, "succeeded");
    old.prepare("INSERT INTO spans(span_id,trace_id,agent_id,kind,started_at,status,origin) VALUES(?,?,?,?,?,?,?)")
      .run("span", "trace", "agent", "consult", 1, "succeeded", "a2a");
    old.prepare("INSERT INTO tasks(id,project_id,trace_id,span_id,from_agent,to_agent,kind,status,task,path,created_at,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("task", "project", "trace", "span", "agent", "peer", "consult", "succeeded", "Existing task", "[]", 1, "mcp");
  } finally { old.close(); }

  // Exercise the production store-open migration, including a second reopen.
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = new CollabStore({ path });
    try { assert.equal(store.getProject("project")?.name, "Existing project"); }
    finally { store.close(); }
  }
  const upgraded = new DatabaseSync(path);
  const fresh = new DatabaseSync(":memory:");
  t.after(() => { upgraded.close(); fresh.close(); });
  const columns = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
  for (const column of ["repo_path", "base_branch"]) assert.ok(columns(upgraded, "projects").includes(column), `missing ${column} after v5 upgrade`);
  for (const column of ["git_dir", "common_git_dir", "device", "inode"]) assert.ok(columns(upgraded, "project_worktrees").includes(column), `missing ${column} after v5 upgrade`);
  assert.equal((upgraded.prepare("SELECT origin FROM spans WHERE span_id = ?").get("span") as { origin: string }).origin, "a2a");
  assert.equal((upgraded.prepare("SELECT origin FROM tasks WHERE id = ?").get("task") as { origin: string }).origin, "mcp");
  assert.equal((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
  assert.equal(migrate(upgraded), SCHEMA_VERSION, "reapplying migrations is idempotent");
  migrate(fresh);
  const schema = (db: DatabaseSync) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  assert.deepEqual(schema(upgraded), schema(fresh), "upgrading v5 and a fresh store produce the same schema");
});
