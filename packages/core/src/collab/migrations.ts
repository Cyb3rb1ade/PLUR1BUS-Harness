import type { DatabaseSync } from "node:sqlite";
import { CollabError } from "./errors.ts";

export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner TEXT NOT NULL,
    settings TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE INDEX idx_projects_owner ON projects(owner, archived_at);

  CREATE TABLE project_members (
    project_id TEXT NOT NULL REFERENCES projects(id),
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('member','lead')),
    added_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id)
  );

  CREATE TABLE project_agents (
    project_id TEXT NOT NULL REFERENCES projects(id),
    agent_id TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, agent_id)
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    trace_id TEXT NOT NULL,
    span_id TEXT NOT NULL,
    parent_task_id TEXT,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('consult','delegate')),
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    task TEXT NOT NULL,
    acceptance TEXT NOT NULL DEFAULT '',
    result_capped TEXT,
    truncated INTEGER NOT NULL DEFAULT 0,
    result_artifact_id TEXT,
    error TEXT,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER
  );
  CREATE INDEX idx_tasks_trace ON tasks(trace_id);
  CREATE INDEX idx_tasks_project ON tasks(project_id, created_at);

  CREATE TABLE traces (
    trace_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    root_agent TEXT NOT NULL,
    root_span_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL
  );
  CREATE INDEX idx_traces_project ON traces(project_id, created_at);

  CREATE TABLE spans (
    span_id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL REFERENCES traces(trace_id),
    parent_span_id TEXT,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('consult','delegate','guardrail')),
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_estimate INTEGER,
    input_preview TEXT NOT NULL DEFAULT '',
    output_preview TEXT NOT NULL DEFAULT '',
    error TEXT,
    guardrail TEXT
  );
  CREATE INDEX idx_spans_trace ON spans(trace_id, started_at);

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    body TEXT NOT NULL,
    content_type TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE repeats (
    key TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db: DatabaseSync, migrations: readonly string[] = MIGRATIONS): number {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current > migrations.length) {
    throw new CollabError("storage", `collab store schema v${current} is newer than this core supports (v${migrations.length})`, { reason: "schema-too-new" });
  }
  for (let v = current; v < migrations.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw new CollabError("storage", `collab store migration to v${v + 1} failed: ${e instanceof Error ? e.message : String(e)}`, { reason: "migration-failed" });
    }
  }
  return migrations.length;
}
