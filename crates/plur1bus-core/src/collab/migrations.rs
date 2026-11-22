//! `collab/migrations.ts`: the versioned migrations of `collab.sqlite`. The texts are the TypeScript texts byte for byte
//! (generated from `MIGRATIONS`; `scripts/parity/export-collab.ts` records them and the replay compares), since SQLite keeps a
//! `CREATE` statement as written and the `sqlite_master` of a file made here must equal one made there.
//!
//! Step 9 is `team/migration.ts`: it widens `project_members.role` and creates the team tables. The team shell is not ported
//! (it has no specification yet), but every file the TypeScript core has written reaches this step, so the tables are part of
//! the schema and stay empty here.
//!
//! A file written by a newer core is refused and left as it was; `plur1bus_store::Store::open_owner` with
//! `plur1bus_store::Schema::Steps` does the TypeScript `migrate()`: one `BEGIN IMMEDIATE` transaction per missing step,
//! `PRAGMA user_version = n` inside it, a failed step rolled back and reported as `migration-failed`.

/// `SCHEMA_VERSION = MIGRATIONS.length`.
pub const SCHEMA_VERSION: u32 = 9;

/// `MIGRATIONS`: entry `v - 1` takes the schema to version `v`; append only.
pub const MIGRATIONS: &[&str] = &[
    r##"
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
  "##,
    r##"
  CREATE TABLE project_boards (
    project_id TEXT PRIMARY KEY REFERENCES projects(id),
    data TEXT NOT NULL CHECK(json_valid(data))
  );
  CREATE TRIGGER project_board_defaults AFTER INSERT ON projects BEGIN
    INSERT INTO project_boards(project_id, data) VALUES (new.id, json_object(
      'columns', json_array(
        json_object('id',new.id || ':backlog','title',NULL,'titleKey','project.board.backlog','position',0,'wipLimit',NULL),
        json_object('id',new.id || ':in-progress','title',NULL,'titleKey','project.board.inProgress','position',1,'wipLimit',NULL),
        json_object('id',new.id || ':review','title',NULL,'titleKey','project.board.review','position',2,'wipLimit',NULL),
        json_object('id',new.id || ':done','title',NULL,'titleKey','project.board.done','position',3,'wipLimit',NULL)),
      'cards',json_array(),'activity',json_array(),'comments',json_array()));
  END;
  INSERT INTO project_boards(project_id, data)
    SELECT id, json_object('columns',json_array(
      json_object('id',id || ':backlog','title',NULL,'titleKey','project.board.backlog','position',0,'wipLimit',NULL),
      json_object('id',id || ':in-progress','title',NULL,'titleKey','project.board.inProgress','position',1,'wipLimit',NULL),
      json_object('id',id || ':review','title',NULL,'titleKey','project.board.review','position',2,'wipLimit',NULL),
      json_object('id',id || ':done','title',NULL,'titleKey','project.board.done','position',3,'wipLimit',NULL)),
      'cards',json_array(),'activity',json_array(),'comments',json_array()) FROM projects;
  "##,
    r##"ALTER TABLE spans ADD COLUMN session_id TEXT;"##,
    r##"ALTER TABLE spans ADD COLUMN target_kind TEXT; ALTER TABLE tasks ADD COLUMN target_kind TEXT;"##,
    r##"ALTER TABLE spans ADD COLUMN origin TEXT; ALTER TABLE tasks ADD COLUMN origin TEXT;"##,
    r##"ALTER TABLE projects ADD COLUMN repo_path TEXT; ALTER TABLE projects ADD COLUMN base_branch TEXT;"##,
    r##"CREATE TABLE project_worktrees (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    card_id TEXT,
    branch TEXT NOT NULL,
    path TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    removed_at INTEGER
  );
  CREATE UNIQUE INDEX idx_project_worktrees_live ON project_worktrees(project_id, ifnull(card_id, '')) WHERE removed_at IS NULL;"##,
    r##"ALTER TABLE project_worktrees ADD COLUMN git_dir TEXT;
   ALTER TABLE project_worktrees ADD COLUMN common_git_dir TEXT;
   ALTER TABLE project_worktrees ADD COLUMN device TEXT;
   ALTER TABLE project_worktrees ADD COLUMN inode TEXT;"##,
    r##"
ALTER TABLE project_members RENAME TO old_project_members;
CREATE TABLE project_members (
 project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('member','lead','worker','reviewer')), added_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,user_id)
);
INSERT INTO project_members SELECT * FROM old_project_members;
DROP TABLE old_project_members;
CREATE TABLE team_runs (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), lead_agent TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('team','best-of-n')), state TEXT NOT NULL,
 state_json TEXT CHECK(state_json IS NULL OR json_valid(state_json)),
 state_version INTEGER NOT NULL DEFAULT 0, objective TEXT NOT NULL, card_id TEXT,
 plan_json TEXT CHECK(plan_json IS NULL OR json_valid(plan_json)), plan_hash TEXT,
 composition_hash TEXT NOT NULL, check_hash TEXT, check_json TEXT CHECK(check_json IS NULL OR json_valid(check_json)),
 policy_json TEXT NOT NULL CHECK(json_valid(policy_json)), approval_scope TEXT, approved_by TEXT,
 approval_json TEXT CHECK(approval_json IS NULL OR json_valid(approval_json)),
 target_branch TEXT NOT NULL, token_budget INTEGER NOT NULL, wall_budget_ms INTEGER NOT NULL,
 writers_max INTEGER NOT NULL, route_decision_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX team_runs_project ON team_runs(project_id,created_at,id);
CREATE TABLE team_members (
 run_id TEXT NOT NULL REFERENCES team_runs(id), member_id TEXT NOT NULL, kind TEXT NOT NULL,
 role TEXT NOT NULL, model TEXT NOT NULL, agent_id TEXT, peer_id TEXT, disclosure TEXT NOT NULL CHECK(json_valid(disclosure)),
 PRIMARY KEY(run_id,member_id)
);
CREATE TABLE team_sections (
 run_id TEXT NOT NULL REFERENCES team_runs(id), id TEXT NOT NULL, section_index INTEGER NOT NULL, title TEXT NOT NULL,
 goals_json TEXT NOT NULL CHECK(json_valid(goals_json)), branch TEXT, auto INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'open', token_budget INTEGER NOT NULL, wall_budget_ms INTEGER NOT NULL,
 summary_json TEXT CHECK(summary_json IS NULL OR json_valid(summary_json)), merge_sha TEXT,
 PRIMARY KEY(run_id,id), UNIQUE(run_id,section_index)
);
CREATE TABLE team_packages (
 run_id TEXT NOT NULL REFERENCES team_runs(id), id TEXT NOT NULL, section_id TEXT NOT NULL, card_id TEXT,
 key TEXT NOT NULL, task_class TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'planned', writer_member TEXT NOT NULL,
 worker_kind TEXT NOT NULL, sync_mode TEXT NOT NULL, base_ref TEXT, branch TEXT, merge_position INTEGER NOT NULL,
 round INTEGER NOT NULL DEFAULT 0, token_alloc INTEGER NOT NULL, wall_budget_ms INTEGER NOT NULL, deadline_at INTEGER,
 last_tree_hash TEXT, decision_json TEXT, writer_epoch INTEGER NOT NULL DEFAULT 0, hold_reason TEXT, hold_since INTEGER,
 next_poll_at INTEGER, handover_at INTEGER, plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
 PRIMARY KEY(run_id,id), FOREIGN KEY(run_id,section_id) REFERENCES team_sections(run_id,id),
 FOREIGN KEY(run_id,writer_member) REFERENCES team_members(run_id,member_id)
);
CREATE TABLE team_package_deps (
 run_id TEXT NOT NULL, package_id TEXT NOT NULL, depends_on TEXT NOT NULL, kind TEXT NOT NULL,
 carries_json TEXT NOT NULL CHECK(json_valid(carries_json)), reason TEXT,
 PRIMARY KEY(run_id,package_id,depends_on), FOREIGN KEY(run_id,package_id) REFERENCES team_packages(run_id,id),
 FOREIGN KEY(run_id,depends_on) REFERENCES team_packages(run_id,id)
);
CREATE TABLE team_ownership (
 run_id TEXT NOT NULL, package_id TEXT NOT NULL, glob TEXT NOT NULL, mode TEXT NOT NULL,
 person_review INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(run_id,package_id,glob,mode),
 FOREIGN KEY(run_id,package_id) REFERENCES team_packages(run_id,id)
);
CREATE TABLE team_rounds (
 run_id TEXT NOT NULL, package_id TEXT NOT NULL, round INTEGER NOT NULL, kind TEXT NOT NULL, agent TEXT,
 tree_hash TEXT, verdict TEXT, findings_json TEXT, finding_hashes TEXT, artifact_hash TEXT,
 tokens INTEGER NOT NULL DEFAULT 0, started_at INTEGER, ended_at INTEGER,
 PRIMARY KEY(run_id,package_id,round,kind), FOREIGN KEY(run_id,package_id) REFERENCES team_packages(run_id,id)
);
CREATE TABLE team_merge_queue (
 run_id TEXT NOT NULL REFERENCES team_runs(id), kind TEXT NOT NULL, item_id TEXT NOT NULL, position INTEGER NOT NULL,
 sink TEXT NOT NULL, state TEXT NOT NULL, target_ref TEXT, approved_tree_hash TEXT, approval_id TEXT,
 pr_number INTEGER, merge_sha TEXT, reason TEXT, PRIMARY KEY(run_id,kind,item_id)
);
CREATE TABLE team_messages (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES team_runs(id), thread_id TEXT, from_member TEXT NOT NULL,
 to_member TEXT, body TEXT NOT NULL, tokens INTEGER NOT NULL, content_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('delivered','refused')), reason TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE team_events (
 run_id TEXT NOT NULL REFERENCES team_runs(id), seq INTEGER NOT NULL, event_json TEXT NOT NULL CHECK(json_valid(event_json)),
 idempotency_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','applied','done','failed')),
 created_at INTEGER NOT NULL, PRIMARY KEY(run_id,seq), UNIQUE(run_id,idempotency_key)
);
CREATE TABLE team_actions (
 run_id TEXT NOT NULL REFERENCES team_runs(id), seq INTEGER NOT NULL, action_json TEXT NOT NULL CHECK(json_valid(action_json)),
 idempotency_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','applied','done','failed')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(run_id,seq), UNIQUE(run_id,idempotency_key)
);
CREATE INDEX team_action_outbox ON team_actions(state,run_id,seq);
"##,
];
