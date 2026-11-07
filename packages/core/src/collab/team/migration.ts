/** Collab migration 9: durable data only; team_actions is the PT-4b transactional outbox. */
export const TEAM_MIGRATION = `
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
`;
