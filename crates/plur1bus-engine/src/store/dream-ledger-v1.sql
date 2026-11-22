
  CREATE TABLE dream_run (
    run_id           TEXT PRIMARY KEY,
    agent_id         TEXT NOT NULL,
    phase            TEXT NOT NULL CHECK (phase IN ('light','rem','deep')),
    job_id           TEXT NOT NULL,
    partition        TEXT,
    idempotency_key  TEXT NOT NULL,
    trigger          TEXT NOT NULL CHECK (trigger IN ('cron','importance','manual','catchup')),
    scheduled_for    INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER,
    outcome          TEXT CHECK (outcome IN ('completed','skipped','failed','aborted')),
    reason           TEXT,
    counts_json      TEXT NOT NULL DEFAULT '{}',
    tokens_in INTEGER, tokens_out INTEGER, cost_micros INTEGER,
    log_path         TEXT, error_json TEXT,
    UNIQUE (idempotency_key)
  );
  CREATE INDEX dream_run_agent_phase_started ON dream_run(agent_id, phase, started_at DESC);

  CREATE TABLE dream_schedule (
    agent_id TEXT NOT NULL, phase TEXT NOT NULL,
    cron TEXT NOT NULL, timezone TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    stagger_offset_s INTEGER NOT NULL DEFAULT 0,
    next_run_at INTEGER, last_run_id TEXT,
    breaker_state TEXT NOT NULL DEFAULT 'closed', breaker_until INTEGER, breaker_reason TEXT,
    -- RULING: the importance trigger and the transcript digest need per-agent signal state that must survive a restart;
    -- four columns here instead of a fourth table.
    importance_acc REAL NOT NULL DEFAULT 0, captures_acc INTEGER NOT NULL DEFAULT 0,
    capture_seq INTEGER NOT NULL DEFAULT 0, last_capture_at INTEGER,
    PRIMARY KEY (agent_id, phase)
  );

  CREATE TABLE dream_candidate (
    candidate_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
    -- RULING: NOT NULL, because UNIQUE treats NULLs as distinct and a NULL partition would defeat the dedupe.
    partition TEXT NOT NULL DEFAULT 'agent-private',
    content_hash TEXT NOT NULL,
    source_run_id TEXT NOT NULL, first_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    recalls INTEGER NOT NULL DEFAULT 0, unique_queries INTEGER NOT NULL DEFAULT 0,
    score REAL, state TEXT NOT NULL,
    decision_json TEXT,
    UNIQUE (agent_id, partition, content_hash)
  );

  CREATE TABLE dream_import (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    runs INTEGER NOT NULL, schedules INTEGER NOT NULL, candidates INTEGER NOT NULL
  );
