//! `session/store.ts`, the rest: prompt and skill-catalogue snapshots, restored skill events, tool offers, model profile,
//! worktree bindings, the rewind overlay rows, turn checkpoints, token calibration and message usage, tool visibility and
//! pruning counters, summaries. All view overlays and counters: transcript messages and events are never rewritten here.
use super::overlay::{active_path, failed_edit_cycles, hidden_digest, RewindRange};
use super::store::{
    canonical_tool_names_ok, events_of, get_session_in, q_all, q_one, run, running_turn_in, s,
    to_message, to_turn, Env, RewindToken, SessionStore, MAX_SESSION_TOOL_OFFERS,
};
use super::store_turns::{
    context_messages_in, context_tool_events_in, insert_event_in, insert_message_in,
    ACTIVE_TURN_SQL,
};
use super::types::*;
use super::SessionError;
use crate::approvals::js_json::J;
use crate::js::{js_trim, utf16_len};
use plur1bus_store::rusqlite::{params, Connection, Row};
use std::collections::HashSet;

const MAX_RESTORED_SKILLS: i64 = 4096;
const MAX_RESTORED_SKILL_OUTPUT_BYTES: i64 = 512 * 1024;
const MAX_RESTORED_SKILL_TEXT_BYTES: i64 = 64 * 1024;

/// `SKILL_EVENTS_SQL`, with `@ACTIVE@` where TypeScript interpolates `ACTIVE_TURN_SQL`. Deduplication happens before the
/// distinct-skill bound: repeated loads cannot evict another skill's older pair.
const SKILL_EVENTS_SQL: &str = "
  WITH calls AS (
    SELECT e.*,json_extract(e.data,'$.id') AS call_id,json_extract(e.data,'$.args.name') AS skill_name
    FROM events e JOIN turns t ON t.id=e.turn_id AND t.session_id=e.session_id
    WHERE e.session_id=? AND t.state='completed' AND e.type='tool.call' AND @ACTIVE@
      AND json_extract(e.data,'$.name')='skill.load' AND json_type(e.data,'$.id')='text'
      AND json_type(e.data,'$.args.name')='text'
  ), result_events AS MATERIALIZED (
    SELECT e.*,json_extract(e.data,'$.id') AS result_id
    FROM events e JOIN turns t ON t.id=e.turn_id AND t.session_id=e.session_id
    WHERE e.session_id=? AND t.state='completed' AND e.type='tool.result' AND @ACTIVE@
      AND json_extract(e.data,'$.isError') IS NOT 1
  ), outputs AS (
    SELECT e.*,c.seq AS call_seq,c.data AS call_data,c.skill_name,
      CASE WHEN json_type(e.data,'$.output')='text'
        AND length(CAST(json_extract(e.data,'$.output') AS BLOB))<=?
        AND json_valid(json_extract(e.data,'$.output')) THEN json_extract(e.data,'$.output') ELSE '{}' END AS result
    FROM result_events e JOIN calls c ON c.turn_id=e.turn_id AND c.session_id=e.session_id AND e.seq>c.seq
      AND e.result_id=c.call_id
  ), ranked AS (
    SELECT *,row_number() OVER(PARTITION BY skill_name ORDER BY seq DESC,call_seq DESC) AS rank
    FROM outputs WHERE json_type(result,'$.isError')='false'
      AND (json_type(result,'$.truncated') IS NULL OR json_type(result,'$.truncated')='false')
      AND (json_type(result,'$.tool') IS NULL OR json_extract(result,'$.tool')='skill.load')
      AND json_type(result,'$.value.text')='text' AND json_extract(result,'$.value.name')=skill_name
      AND length(CAST(json_extract(result,'$.value.text') AS BLOB))<=?
      AND json_type(result,'$.value.files')='array' AND json_array_length(result,'$.value.files')<=1024
      AND NOT EXISTS (SELECT 1 FROM json_each(result,'$.value.files')
        WHERE type!='text' OR length(CAST(value AS BLOB))>16384)
  ), latest AS (SELECT * FROM ranked WHERE rank=1 ORDER BY seq DESC LIMIT ?), selected AS (
    SELECT e.* FROM events e JOIN turns t ON t.id=e.turn_id AND t.session_id=e.session_id
    WHERE e.session_id=? AND t.state='completed' AND e.type='skills.selected' AND @ACTIVE@
    ORDER BY e.seq DESC LIMIT 1
  )
  SELECT session_id,turn_id,call_seq AS seq,'tool.call' AS type,call_data AS data,at FROM latest
  UNION ALL SELECT session_id,turn_id,seq,'tool.result',data,at FROM latest
  UNION ALL SELECT session_id,turn_id,seq,type,data,at FROM selected ORDER BY seq";

fn to_rewind(r: &Row<'_>) -> plur1bus_store::rusqlite::Result<RewindRecord> {
    Ok(RewindRecord {
        id: s(r, "id")?,
        session_id: s(r, "session_id")?,
        parent_seq: r.get("parent_seq")?,
        hidden_from_seq: r.get("hidden_from_seq")?,
        hidden_to_seq: r.get("hidden_to_seq")?,
        lesson_message_id: r.get("lesson_message_id")?,
        hidden_digest: s(r, "hidden_digest")?,
        trigger: RewindTrigger::parse(&s(r, "trigger")?).unwrap_or(RewindTrigger::User),
        actor: s(r, "actor")?,
        created_at: r.get("created_at")?,
        undone_at: r.get("undone_at")?,
    })
}

fn to_summary(r: &Row<'_>) -> plur1bus_store::rusqlite::Result<SummaryRecord> {
    Ok(SummaryRecord {
        id: s(r, "id")?,
        session_id: s(r, "session_id")?,
        from_seq: r.get("from_seq")?,
        to_seq: r.get("to_seq")?,
        text: s(r, "text")?,
        tokens: r.get("tokens")?,
        tier: r.get("tier")?,
        state: SummaryState::parse(&s(r, "state")?).unwrap_or(SummaryState::Superseded),
        created_at: r.get("created_at")?,
    })
}

fn to_checkpoint(r: &Row<'_>) -> plur1bus_store::rusqlite::Result<StoredCheckpoint> {
    Ok(StoredCheckpoint {
        session_id: s(r, "session_id")?,
        turn_id: s(r, "turn_id")?,
        project_id: s(r, "project_id")?,
        card_id: s(r, "card_id")?,
        root: s(r, "root")?,
        common_git_dir: s(r, "common_git_dir")?,
        ref_name: s(r, "ref")?,
        tree: s(r, "tree")?,
        commit_id: s(r, "commit_id")?,
    })
}

pub(crate) fn rewinds_in(
    c: &Connection,
    session_id: &str,
) -> Result<Vec<RewindRecord>, SessionError> {
    q_all(
        c,
        "SELECT * FROM path_rewinds WHERE session_id=? ORDER BY rowid",
        [session_id],
        to_rewind,
    )
}

fn set_visibility_in(
    c: &Connection,
    session_id: &str,
    reference: &str,
    hidden: bool,
    reason: &str,
    detail: Option<&PruneDetail>,
) -> Result<(), SessionError> {
    run(
        c,
        "INSERT INTO tool_visibility(session_id,ref,hidden,reason) VALUES (?,?,?,?) ON CONFLICT(session_id,ref) DO UPDATE SET hidden=excluded.hidden,reason=excluded.reason",
        params![session_id, reference, i64::from(hidden), reason],
    )?;
    if let Some(d) = detail {
        run(
            c,
            "UPDATE tool_visibility SET mode=?,confidence=?,tokens_saved=? WHERE session_id=? AND ref=?",
            params![if d.truncate { "truncate" } else { "drop" }, d.confidence, d.tokens_saved, session_id, reference],
        )?;
    }
    Ok(())
}

fn add_summary_in(
    env: &Env,
    c: &Connection,
    n: &NewSummary,
) -> Result<SummaryRecord, SessionError> {
    let id = env.new_id("sum");
    let created_at = env.now();
    run(
        c,
        "INSERT INTO summaries (id, session_id, from_seq, to_seq, text, tokens, tier, state, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        params![id, n.session_id, n.from_seq, n.to_seq, n.text, n.tokens, n.tier, n.state.as_str(), created_at],
    )?;
    Ok(SummaryRecord {
        id,
        session_id: n.session_id.clone(),
        from_seq: n.from_seq,
        to_seq: n.to_seq,
        text: n.text.clone(),
        tokens: n.tokens,
        tier: n.tier,
        state: n.state,
        created_at,
    })
}

fn rewind_idle_in(
    env: &Env,
    c: &Connection,
    session_id: &str,
    command_turn_id: Option<&str>,
    reservation: Option<RewindToken>,
) -> Result<(), SessionError> {
    let session = get_session_in(c, session_id)?
        .ok_or_else(|| SessionError::not_found("session not found", Some("session")))?;
    if session.archived_at.is_some() {
        return Err(SessionError::conflict("session is archived", "archived"));
    }
    if env.rewind_blocked(session_id, reservation) {
        return Err(SessionError::conflict(
            "file rewind is awaiting or applying approval",
            "rewind-in-progress",
        ));
    }
    if let Some(running) = running_turn_in(c, session_id)? {
        if Some(running.id.as_str()) != command_turn_id {
            return Err(SessionError::conflict(
                "rewind requires an idle session",
                "turn-running",
            ));
        }
    }
    Ok(())
}

fn last_event_seq_in(c: &Connection, session_id: &str) -> Result<Option<i64>, SessionError> {
    q_one(
        c,
        "SELECT last_event_seq FROM sessions WHERE id = ?",
        [session_id],
        |r| r.get::<_, i64>(0),
    )
}

fn plan_rewind_in(
    env: &Env,
    c: &Connection,
    session_id: &str,
    target: RewindTarget,
    command_turn_id: Option<&str>,
    reservation: Option<RewindToken>,
) -> Result<RewindPlan, SessionError> {
    rewind_idle_in(env, c, session_id, command_turn_id, reservation)?;
    let active: Vec<MessageRecord> = context_messages_in(c, session_id, None)?
        .into_iter()
        .filter(|m| command_turn_id.is_none_or(|t| m.turn_id.as_deref() != Some(t)))
        .collect();
    let parent_seq = match target {
        RewindTarget::Last => {
            let newest = active.iter().rev().find(|m| m.turn_id.is_some());
            let first = newest.and_then(|n| active.iter().find(|m| m.turn_id == n.turn_id));
            match first {
                Some(f) => active
                    .iter()
                    .rev()
                    .find(|m| m.seq < f.seq)
                    .map_or(0, |m| m.seq),
                None => -1,
            }
        }
        RewindTarget::Seq(n) => n,
    };
    if parent_seq < 0 || (parent_seq != 0 && !active.iter().any(|m| m.seq == parent_seq)) {
        return Err(SessionError::invalid(
            "rewind target must be on the active path",
            "rewind-target",
        ));
    }
    // Cover earlier hidden attempts too: undoing an older overlay must not pierce this newer boundary.
    let from = parent_seq + 1;
    let Some(to) = active.last().map(|m| m.seq) else {
        return Err(SessionError::invalid(
            "rewind range is empty",
            "rewind-empty",
        ));
    };
    if from > to {
        return Err(SessionError::invalid(
            "rewind range is empty",
            "rewind-empty",
        ));
    }
    let messages = q_all(
        c,
        "SELECT * FROM messages WHERE session_id=? AND seq BETWEEN ? AND ? ORDER BY seq",
        params![session_id, from, to],
        to_message,
    )?;
    Ok(RewindPlan {
        parent_seq,
        hidden_from_seq: from,
        hidden_to_seq: to,
        messages,
        event_seq: last_event_seq_in(c, session_id)?.unwrap_or(0),
    })
}

fn rewind_proposal_in(
    c: &Connection,
    session_id: &str,
) -> Result<Option<RewindProposal>, SessionError> {
    let row = q_one(
        c,
        "SELECT data FROM events WHERE session_id=?
      AND type IN ('session.rewind.proposed','session.rewind','session.rewind.undone') ORDER BY seq DESC LIMIT 1",
        [session_id],
        |r| r.get::<_, String>(0),
    )?;
    let Some(text) = row else { return Ok(None) };
    let data = J::parse(&text).ok_or_else(|| {
        SessionError::new(
            super::ErrorCode::Storage,
            "event payload is unreadable",
            Some("event-data"),
        )
    })?;
    let cycles = failed_edit_cycles(&context_tool_events_in(c, session_id)?);
    let last_check = data.get("lastCheckSeq").and_then(J::as_f64);
    if last_check != Some(cycles.last_check_seq as f64)
        || cycles.failed_cycles < 3
        || cycles.pending_edit
    {
        return Ok(None);
    }
    let int = |key: &str| data.get(key).and_then(J::as_f64).map(|v| v as i64);
    Ok(
        match (
            int("parentSeq"),
            int("failedCycles"),
            int("lastCheckSeq"),
            data.get("agentId").and_then(J::as_str),
        ) {
            (Some(parent_seq), Some(failed_cycles), Some(last_check_seq), Some(agent)) => {
                Some(RewindProposal {
                    parent_seq,
                    failed_cycles,
                    last_check_seq,
                    agent_id: agent.to_owned(),
                })
            }
            _ => None,
        },
    )
}

/// The audit callback of a rewind: it sees ids and digests only and may refuse (the rewind then rolls back).
pub type AuditFn<'a> = &'a mut dyn FnMut(&RewindAuditEvent) -> Result<(), String>;

/// `RewindInput`: trusted internal input. The RPC and transcript-command boundaries separately require a person.
pub struct RewindInput<'a> {
    /// The target message seq or the newest whole turn.
    pub to: RewindTarget,
    /// The lesson, 1..=1600 UTF-16 units after trimming.
    pub lesson: String,
    /// Who asked.
    pub actor: String,
    /// User or agent.
    pub trigger: RewindTrigger,
    /// The event seq the plan was made at; a different one is stale.
    pub expected_event_seq: Option<i64>,
    /// Audit runs before the overlay commits; failure rolls back every store change. No transcript text crosses it.
    pub audit: Option<AuditFn<'a>>,
    /// Only the admitted transcript command itself may be running; never accepted from RPC params.
    pub command_turn_id: Option<String>,
    /// The caller's own reservation.
    pub reservation: Option<RewindToken>,
}

impl SessionStore {
    /// `freezePromptSnapshot`: incognito turns keep no separate persisted prompt snapshot; a remembered session freezes
    /// exactly once (the first memory text stays).
    pub fn freeze_prompt_snapshot(
        &mut self,
        session_id: &str,
        memory: &str,
    ) -> Result<String, SessionError> {
        self.freeze("prompt_snapshots", "memory", session_id, memory)
    }

    /// `freezeSkillCatalogue`: remembered sessions retain the first authored catalogue across restarts; incognito uses
    /// its current bytes.
    pub fn freeze_skill_catalogue(
        &mut self,
        session_id: &str,
        catalogue: &str,
    ) -> Result<String, SessionError> {
        self.freeze(
            "skill_catalogue_snapshots",
            "catalogue",
            session_id,
            catalogue,
        )
    }

    fn freeze(
        &mut self,
        table: &str,
        column: &str,
        session_id: &str,
        value: &str,
    ) -> Result<String, SessionError> {
        let session = self
            .get_session(session_id)?
            .ok_or_else(|| SessionError::not_found("session not found", None))?;
        if session.memory_mode == MemoryMode::Incognito {
            return Ok(value.to_owned());
        }
        self.tx(|_, c| {
            run(
                c,
                &format!("INSERT OR IGNORE INTO {table}(session_id,{column}) VALUES (?,?)"),
                params![session_id, value],
            )
        })?;
        q_one(
            self.conn(),
            &format!("SELECT {column} FROM {table} WHERE session_id=?"),
            [session_id],
            |r| r.get::<_, String>(0),
        )?
        .ok_or_else(|| SessionError::not_found("session not found", None))
    }

    /// `skillEvents`: completed skill state only, the latest successful pairs deduplicated before the 4096
    /// distinct-skill bound.
    pub fn skill_events(&self, session_id: &str) -> Result<Vec<EventRecord>, SessionError> {
        let sql = SKILL_EVENTS_SQL.replace("@ACTIVE@", ACTIVE_TURN_SQL);
        events_of(
            self.conn(),
            &sql,
            params![
                session_id,
                session_id,
                MAX_RESTORED_SKILL_OUTPUT_BYTES,
                MAX_RESTORED_SKILL_TEXT_BYTES,
                MAX_RESTORED_SKILLS,
                session_id
            ],
        )
    }

    /// `toolOffers`: the admission order is stable; only names are retained. Incognito services keep this table in RAM.
    pub fn tool_offers(&self, session_id: &str) -> Result<Vec<String>, SessionError> {
        tool_offers_in(self.conn(), session_id)
    }

    /// `rememberToolOffers`: records a pending union for the next turn boundary, retaining the earliest 128 distinct
    /// canonical names. One bad name refuses the whole batch before anything is written.
    pub fn remember_tool_offers(
        &mut self,
        session_id: &str,
        names: &[&str],
    ) -> Result<(), SessionError> {
        if get_session_in(self.conn(), session_id)?.is_none() {
            return Err(SessionError::not_found("session not found", None));
        }
        if !canonical_tool_names_ok(names) {
            return Err(SessionError::invalid(
                "tool offers require canonical registered tool names",
                "tool-name",
            ));
        }
        self.tx(|_, c| {
            let previous = tool_offers_in(c, session_id)?;
            let mut known: HashSet<String> = previous.iter().cloned().collect();
            let mut ordinal = previous.len();
            for name in names {
                if known.contains(*name) {
                    continue;
                }
                if ordinal >= MAX_SESSION_TOOL_OFFERS {
                    break;
                }
                run(
                    c,
                    "INSERT INTO session_tool_offers(session_id,name,ordinal) VALUES (?,?,?)",
                    params![session_id, name, ordinal as i64],
                )?;
                ordinal += 1;
                known.insert((*name).to_owned());
            }
            Ok(())
        })
    }

    /// `modelProfile`: the profile and its revision (0 and `None` before the first switch).
    pub fn model_profile(&self, session_id: &str) -> Result<(Option<String>, i64), SessionError> {
        Ok(q_one(
            self.conn(),
            "SELECT profile,revision FROM session_model_profiles WHERE session_id=?",
            [session_id],
            |r| Ok((Some(s(r, "profile")?), r.get::<_, i64>("revision")?)),
        )?
        .unwrap_or((None, 0)))
    }

    /// `modelReasoning`: the chat's reasoning choice beside its profile; `None` = provider default.
    pub fn model_reasoning(&self, session_id: &str) -> Result<Option<String>, SessionError> {
        model_reasoning_in(self.conn(), session_id)
    }

    /// `setModelProfile`: an atomic compare-and-swap; an in-flight turn or a stale preview cannot change model routing.
    #[allow(clippy::too_many_arguments)]
    pub fn set_model_profile(
        &mut self,
        session_id: &str,
        profile: &str,
        expected_revision: i64,
        reasoning: &ReasoningChange,
        person: Option<&str>,
        details: Option<&ModelDetails>,
    ) -> Result<i64, SessionError> {
        self.tx(|env, c| {
            let session = get_session_in(c, session_id)?;
            let busy = match &session {
                Some(s) => s.kind != SessionKind::Direct || s.archived_at.is_some() || running_turn_in(c, session_id)?.is_some(),
                None => true,
            };
            let Some(session) = session.filter(|_| !busy) else {
                return Err(SessionError::conflict("model switch requires an idle direct session", "session-busy"));
            };
            let current = q_one(
                c,
                "SELECT profile,revision FROM session_model_profiles WHERE session_id=?",
                [session_id],
                |r| r.get::<_, i64>("revision"),
            )?
            .unwrap_or(0);
            if current != expected_revision {
                return Err(SessionError::conflict("model switch preview is stale", "stale-model-preview"));
            }
            let revision = current + 1;
            let next_reasoning = match reasoning {
                ReasoningChange::Keep => model_reasoning_in(c, session_id)?,
                ReasoningChange::Clear => None,
                ReasoningChange::Set(r) => Some(r.clone()),
            };
            run(
                c,
                "INSERT INTO session_model_profiles(session_id,profile,revision,reasoning) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET profile=excluded.profile,revision=excluded.revision,reasoning=excluded.reasoning",
                params![session_id, profile, revision, next_reasoning],
            )?;
            let after_message_seq = q_one(c, "SELECT last_message_seq FROM sessions WHERE id = ?", [session_id], |r| {
                r.get::<_, i64>(0)
            })?
            .unwrap_or(0);
            let mut data = J::obj([
                ("profile", J::s(profile)),
                ("model", J::s(details.map_or(profile, |d| d.model.as_str()))),
            ]);
            if let Some(name) = details.and_then(|d| d.display_name.as_deref()).filter(|v| !v.is_empty()) {
                data.set("displayName", J::s(name));
            }
            if let Some(eff) = details.and_then(|d| d.effective_reasoning.as_deref()).filter(|v| !v.is_empty()) {
                data.set("effectiveReasoning", J::s(eff));
            }
            data.set("reasoning", J::s(next_reasoning.as_deref().unwrap_or("default")));
            data.set("person", J::s(person.unwrap_or(&session.owner)));
            data.set("revision", J::Num(revision as f64));
            data.set("afterMessageSeq", J::Num(after_message_seq as f64));
            insert_event_in(env, c, session_id, None, "session.model.changed", data)?;
            Ok(revision)
        })
    }

    /// `modelChanges`: session-scoped changes, independent of turn delta volume; the latest 2000 notes accompany history.
    pub fn model_changes(&self, session_id: &str) -> Result<Vec<EventRecord>, SessionError> {
        events_of(
            self.conn(),
            "SELECT * FROM (SELECT * FROM events WHERE session_id = ? AND type = 'session.model.changed' ORDER BY seq DESC LIMIT 2000) ORDER BY seq",
            [session_id],
        )
    }

    /// `worktree`: immutable CLI-1 worktree metadata.
    pub fn worktree(&self, session_id: &str) -> Result<Option<WorktreeBinding>, SessionError> {
        worktree_in(self.conn(), session_id)
    }

    /// `bindWorktree`: bind once or confirm exactly the same binding; this never grants filesystem access.
    pub fn bind_worktree(
        &mut self,
        session_id: &str,
        root: &str,
        project_id: Option<&str>,
        card_id: Option<&str>,
        created_by: &str,
    ) -> Result<(), SessionError> {
        self.tx(|env, c| {
            let session = get_session_in(c, session_id)?
                .ok_or_else(|| SessionError::not_found("session not found", None))?;
            if session.archived_at.is_some() || running_turn_in(c, &session.id)?.is_some() {
                return Err(SessionError::new(
                    super::ErrorCode::Conflict,
                    "worktree binding requires an idle active session",
                    None,
                ));
            }
            if let Some(old) = worktree_in(c, &session.id)? {
                if old.root != root
                    || old.project_id.as_deref() != project_id
                    || old.card_id.as_deref() != card_id
                    || old.created_by != created_by
                {
                    return Err(SessionError::new(
                        super::ErrorCode::Immutable,
                        "worktree binding is immutable",
                        None,
                    ));
                }
                return Ok(());
            }
            run(
                c,
                "INSERT INTO session_worktrees(session_id,root,project_id,card_id,created_by,created_at) VALUES (?,?,?,?,?,?)",
                params![session.id, root, project_id, card_id, created_by, env.now()],
            )
        })
    }

    /// `rewinds`: the overlay metadata for transcript readers, ordered by the append-only lesson sequence.
    pub fn rewinds(&self, session_id: &str) -> Result<Vec<RewindRecord>, SessionError> {
        rewinds_in(self.conn(), session_id)
    }

    /// `summaryRewinds`: summary coverage must exclude discarded branches and the message of every now-obsolete lesson.
    pub fn summary_rewinds(&self, session_id: &str) -> Result<Vec<RewindRange>, SessionError> {
        let rows = q_all(
            self.conn(),
            "SELECT r.*,m.seq AS lesson_seq FROM path_rewinds r
      LEFT JOIN messages m ON m.id=r.lesson_message_id WHERE r.session_id=?",
            [session_id],
            |r| {
                Ok((
                    r.get::<_, i64>("hidden_from_seq")?,
                    r.get::<_, i64>("hidden_to_seq")?,
                    r.get::<_, Option<i64>>("undone_at")?,
                    r.get::<_, Option<i64>>("lesson_seq")?,
                ))
            },
        )?;
        Ok(rows
            .into_iter()
            .filter_map(|(from, to, undone, lesson_seq)| {
                if undone.is_none() {
                    Some(RewindRange {
                        hidden_from_seq: from,
                        hidden_to_seq: to,
                        undone_at: None,
                        lesson_message_id: None,
                    })
                } else {
                    lesson_seq.map(|seq| RewindRange {
                        hidden_from_seq: seq,
                        hidden_to_seq: seq,
                        undone_at: None,
                        lesson_message_id: None,
                    })
                }
            })
            .collect())
    }

    /// `recordCheckpoint`: records the immutable object/ref intent before the ref is published, so an interrupted write
    /// stays discoverable for cleanup.
    pub fn record_checkpoint(&mut self, cp: &StoredCheckpoint) -> Result<(), SessionError> {
        self.tx(|env, c| {
            let turn = q_one(c, "SELECT * FROM turns WHERE id = ?", [cp.turn_id.as_str()], to_turn)?;
            let session = get_session_in(c, &cp.session_id)?;
            let ok = match (&session, &turn) {
                (Some(s), Some(t)) => s.archived_at.is_none() && t.session_id == cp.session_id && t.state == TurnState::Running,
                _ => false,
            };
            let (true, Some(turn)) = (ok, turn) else {
                return Err(SessionError::conflict("checkpoint turn is not running in the session", "rewind-checkpoint"));
            };
            run(
                c,
                "INSERT INTO session_checkpoints(session_id,turn_id,turn_seq,project_id,card_id,root,common_git_dir,ref,tree,commit_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    cp.session_id, cp.turn_id, turn.seq, cp.project_id, cp.card_id, cp.root, cp.common_git_dir,
                    cp.ref_name, cp.tree, cp.commit_id, env.now()
                ],
            )
        })
    }

    /// `checkpoint`: native restore checks these stored identities before asking a person, and again before restoring.
    pub fn checkpoint(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<Option<StoredCheckpoint>, SessionError> {
        q_one(
            self.conn(),
            "SELECT * FROM session_checkpoints WHERE session_id=? AND turn_id=?",
            params![session_id, turn_id],
            to_checkpoint,
        )
    }

    /// `hasCheckpoints`.
    pub fn has_checkpoints(&self) -> Result<bool, SessionError> {
        Ok(q_one(
            self.conn(),
            "SELECT 1 FROM session_checkpoints LIMIT 1",
            [],
            |r| r.get::<_, i64>(0),
        )?
        .is_some())
    }

    /// `checkpoints`: all, or one session's (in table order, as TypeScript reads them).
    pub fn checkpoints(
        &self,
        session_id: Option<&str>,
    ) -> Result<Vec<(StoredCheckpoint, i64)>, SessionError> {
        let map = |r: &Row<'_>| Ok((to_checkpoint(r)?, r.get::<_, i64>("turn_seq")?));
        match session_id {
            None => q_all(
                self.conn(),
                "SELECT c.* FROM session_checkpoints c",
                [],
                map,
            ),
            Some(id) => q_all(
                self.conn(),
                "SELECT c.* FROM session_checkpoints c WHERE c.session_id=?",
                [id],
                map,
            ),
        }
    }

    /// `latestTurnSeq`.
    pub fn latest_turn_seq(&self, session_id: &str) -> Result<i64, SessionError> {
        Ok(q_one(
            self.conn(),
            "SELECT MAX(seq) AS seq FROM turns WHERE session_id=?",
            [session_id],
            |r| r.get::<_, Option<i64>>(0),
        )?
        .flatten()
        .unwrap_or(0))
    }

    /// `forgetCheckpoint`: private snapshot bookkeeping only; messages, events and rewind overlays are never deleted here.
    pub fn forget_checkpoint(&mut self, cp: &StoredCheckpoint) -> Result<(), SessionError> {
        self.tx(|_, c| {
            run(
                c,
                "DELETE FROM session_checkpoints WHERE session_id=? AND turn_id=? AND commit_id=?",
                params![cp.session_id, cp.turn_id, cp.commit_id],
            )
        })
    }

    /// `rewindProposal`: the newest still-unapplied proposal; one-click confirmation remains a human rewind call.
    pub fn rewind_proposal(
        &self,
        session_id: &str,
    ) -> Result<Option<RewindProposal>, SessionError> {
        rewind_proposal_in(self.conn(), session_id)
    }

    /// `proposeRewind`: appends at most one proposal per observed check; neither a proposal nor an agent message is human
    /// approval.
    pub fn propose_rewind(
        &mut self,
        session_id: &str,
        p: &RewindProposal,
    ) -> Result<Option<EventRecord>, SessionError> {
        self.tx(|env, c| {
            rewind_idle_in(env, c, session_id, None, None)?;
            if rewind_proposal_in(c, session_id)?
                .is_some_and(|x| x.last_check_seq == p.last_check_seq)
            {
                return Ok(None);
            }
            let data = J::obj([
                ("parentSeq", J::Num(p.parent_seq as f64)),
                ("failedCycles", J::Num(p.failed_cycles as f64)),
                ("lastCheckSeq", J::Num(p.last_check_seq as f64)),
                ("agentId", J::s(&p.agent_id)),
            ]);
            Ok(Some(insert_event_in(
                env,
                c,
                session_id,
                None,
                "session.rewind.proposed",
                data,
            )?))
        })
    }

    /// `planRewind`: reads and validates an idle rewind target before asynchronous distillation. The commit rechecks the
    /// event revision.
    pub fn plan_rewind(
        &self,
        session_id: &str,
        target: RewindTarget,
        command_turn_id: Option<&str>,
        reservation: Option<RewindToken>,
    ) -> Result<RewindPlan, SessionError> {
        plan_rewind_in(
            &self.env,
            self.conn(),
            session_id,
            target,
            command_turn_id,
            reservation,
        )
    }

    /// `rewindPath`: appends an audited overlay and its harness note in one transaction. Original messages and events
    /// remain byte-identical.
    pub fn rewind_path(
        &mut self,
        session_id: &str,
        mut input: RewindInput<'_>,
    ) -> Result<RewindRecord, SessionError> {
        let lesson_len = utf16_len(&input.lesson);
        if input.actor.is_empty() || js_trim(&input.lesson).is_empty() || lesson_len > 1600 {
            return Err(SessionError::invalid(
                "rewind needs an actor and a lesson of at most 400 estimated tokens",
                "rewind-lesson",
            ));
        }
        self.tx(|env, c| {
            let plan = plan_rewind_in(env, c, session_id, input.to, input.command_turn_id.as_deref(), input.reservation)?;
            if input.expected_event_seq.is_some_and(|e| e != plan.event_seq) {
                return Err(SessionError::conflict(
                    "session changed during rewind; retry on the current path",
                    "rewind-stale",
                ));
            }
            let id = env.new_id("rew");
            let at = env.now();
            let digest = hidden_digest(&plan.messages);
            let detail = J::obj([
                ("sessionId", J::s(session_id)),
                ("rewindId", J::s(&id)),
                ("parentSeq", J::Num(plan.parent_seq as f64)),
                ("hiddenFrom", J::Num(plan.hidden_from_seq as f64)),
                ("hiddenTo", J::Num(plan.hidden_to_seq as f64)),
                ("trigger", J::s(input.trigger.as_str())),
                ("actor", J::s(&input.actor)),
                ("hiddenDigest", J::s(&digest)),
            ]);
            if let Some(audit) = input.audit.as_mut() {
                audit(&RewindAuditEvent { action: "session.rewind", detail: detail.clone() })
                    .map_err(|m| SessionError::from_message(&m))?;
            }
            let lesson = insert_message_in(
                env,
                c,
                session_id,
                None,
                MessageRole::System,
                &input.lesson,
                (lesson_len as i64 + 3) / 4,
            )?;
            run(
                c,
                "INSERT INTO path_rewinds(id,session_id,parent_seq,hidden_from_seq,hidden_to_seq,lesson_message_id,
        hidden_digest,trigger,actor,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                params![
                    id, session_id, plan.parent_seq, plan.hidden_from_seq, plan.hidden_to_seq, lesson.id, digest,
                    input.trigger.as_str(), input.actor, at
                ],
            )?;
            run(c, "UPDATE sessions SET updated_at=? WHERE id=?", params![at, session_id])?;
            let mut event = detail;
            event.set("lessonMessageId", J::s(&lesson.id));
            insert_event_in(env, c, session_id, None, "session.rewind", event)?;
            q_one(c, "SELECT * FROM path_rewinds WHERE id=?", [id.as_str()], to_rewind)?
                .ok_or_else(|| SessionError::not_found("rewind not found", Some("rewind")))
        })
    }

    /// `undoRewind`: lifts an overlay and its lesson without deleting either. A second undo is idempotent.
    pub fn undo_rewind(
        &mut self,
        session_id: &str,
        rewind_id: &str,
        actor: &str,
        mut audit: Option<AuditFn<'_>>,
        command_turn_id: Option<&str>,
    ) -> Result<RewindRecord, SessionError> {
        self.tx(|env, c| {
            rewind_idle_in(env, c, session_id, command_turn_id, None)?;
            let row = q_one(
                c,
                "SELECT * FROM path_rewinds WHERE session_id=? AND id=?",
                params![session_id, rewind_id],
                to_rewind,
            )?
            .ok_or_else(|| SessionError::not_found("rewind not found", Some("rewind")))?;
            if actor.is_empty() {
                return Err(SessionError::invalid("undo needs an actor", "rewind-actor"));
            }
            if row.undone_at.is_some() {
                return Ok(row);
            }
            let detail = J::obj([
                ("sessionId", J::s(session_id)),
                ("rewindId", J::s(rewind_id)),
                ("actor", J::s(actor)),
                ("hiddenDigest", J::s(&row.hidden_digest)),
            ]);
            if let Some(audit) = audit.as_mut() {
                audit(&RewindAuditEvent {
                    action: "session.rewind.undone",
                    detail: detail.clone(),
                })
                .map_err(|m| SessionError::from_message(&m))?;
            }
            let at = env.now();
            run(
                c,
                "UPDATE path_rewinds SET undone_at=? WHERE id=?",
                params![at, rewind_id],
            )?;
            run(
                c,
                "UPDATE sessions SET updated_at=? WHERE id=?",
                params![at, session_id],
            )?;
            insert_event_in(env, c, session_id, None, "session.rewind.undone", detail)?;
            Ok(RewindRecord {
                undone_at: Some(at),
                ..row
            })
        })
    }

    /// `reserveRewind`: reserves an idle path while a destructive file restore awaits approval; no database transaction
    /// spans the wait. Release with [`SessionStore::release_rewind`].
    pub fn reserve_rewind(
        &mut self,
        session_id: &str,
        command_turn_id: Option<&str>,
    ) -> Result<RewindToken, SessionError> {
        let file = self.tx(|env, conn| {
            rewind_idle_in(env, conn, session_id, command_turn_id, None)?;
            env.lock_rewind(session_id, true)
        })?;
        let token = self.next_token();
        self.env
            .reservations
            .insert(session_id.to_owned(), (token, file));
        Ok(token)
    }

    /// The `release` of `reserveRewind`: only the holder's own token releases.
    pub fn release_rewind(&mut self, session_id: &str, token: RewindToken) {
        if self
            .env
            .reservations
            .get(session_id)
            .is_some_and(|(owner, _)| *owner == token)
        {
            self.env.reservations.remove(session_id);
        }
    }

    /// `rewindReserved`: background model work must not change the path while approved file restoration is pending.
    pub fn rewind_reserved(&self, session_id: &str) -> bool {
        self.env.rewind_blocked(session_id, None)
    }

    /// `tokenCalibration`: the model's factor, if one was observed.
    pub fn token_calibration(&self, model: &str) -> Result<Option<f64>, SessionError> {
        q_one(
            self.conn(),
            "SELECT factor FROM token_calibration WHERE model=?",
            [model],
            |r| r.get::<_, f64>(0),
        )
    }

    /// `tokenFactor`: the factor, 1 when none.
    pub fn token_factor(&self, model: &str) -> Result<f64, SessionError> {
        Ok(self.token_calibration(model)?.unwrap_or(1.0))
    }

    /// `setTokenFactor`.
    pub fn set_token_factor(&mut self, model: &str, factor: f64) -> Result<(), SessionError> {
        self.tx(|_, c| {
            run(
                c,
                "INSERT INTO token_calibration(model,factor) VALUES (?,?) ON CONFLICT(model) DO UPDATE SET factor=excluded.factor",
                params![model, factor],
            )
        })
    }

    /// `recordMessageUsage`.
    pub fn record_message_usage(
        &mut self,
        id: &str,
        model: &str,
        tokens: i64,
    ) -> Result<(), SessionError> {
        self.tx(|_, c| {
            run(
                c,
                "INSERT OR REPLACE INTO message_usage(message_id,model,tokens) VALUES (?,?,?)",
                params![id, model, tokens],
            )
        })
    }

    /// `messageUsage`: the measured count for this message, model and exact text.
    pub fn message_usage(
        &self,
        id: &str,
        model: &str,
        text: &str,
    ) -> Result<Option<i64>, SessionError> {
        q_one(
            self.conn(),
            "SELECT u.tokens FROM message_usage u JOIN messages m ON m.id=u.message_id WHERE message_id=? AND model=? AND m.text=?",
            params![id, model, text],
            |r| r.get::<_, i64>(0),
        )
    }

    /// `toolVisibility`.
    pub fn tool_visibility(&self, session_id: &str) -> Result<Vec<ToolVisibility>, SessionError> {
        q_all(
            self.conn(),
            "SELECT ref,hidden,reason,mode FROM tool_visibility WHERE session_id=? ORDER BY ref",
            [session_id],
            |r| {
                Ok(ToolVisibility {
                    reference: s(r, "ref")?,
                    hidden: r.get::<_, i64>("hidden")? == 1,
                    reason: s(r, "reason")?,
                    truncate: s(r, "mode")? == "truncate",
                })
            },
        )
    }

    /// `setToolVisibility`.
    pub fn set_tool_visibility(
        &mut self,
        session_id: &str,
        reference: &str,
        hidden: bool,
        reason: &str,
        detail: Option<&PruneDetail>,
    ) -> Result<(), SessionError> {
        self.tx(|_, c| set_visibility_in(c, session_id, reference, hidden, reason, detail))
    }

    /// `latestAssistantContext`: administrative transcript replies are not semantic references to original tool output.
    pub fn latest_assistant_context(&self, session_id: &str) -> Result<String, SessionError> {
        Ok(context_messages_in(self.conn(), session_id, None)?
            .into_iter()
            .rev()
            .find(|m| m.role == MessageRole::Assistant)
            .map_or_else(String::new, |m| m.text))
    }

    /// `pruneExplanation`.
    pub fn prune_explanation(
        &self,
        session_id: &str,
    ) -> Result<Vec<PruneExplanation>, SessionError> {
        q_all(
            self.conn(),
            "SELECT ref,hidden,mode,confidence,tokens_saved FROM tool_visibility WHERE session_id=? ORDER BY ref",
            [session_id],
            |r| {
                Ok(PruneExplanation {
                    reference: s(r, "ref")?,
                    hidden: r.get::<_, i64>("hidden")? == 1,
                    verdict: s(r, "mode")?,
                    confidence: r.get("confidence")?,
                    tokens_saved: r.get("tokens_saved")?,
                })
            },
        )
    }

    /// `recordToolRefetch`.
    pub fn record_tool_refetch(
        &mut self,
        session_id: &str,
        reference: &str,
    ) -> Result<(), SessionError> {
        self.tx(|_, c| {
            run(
                c,
                "UPDATE tool_visibility SET refetches=refetches+1 WHERE session_id=? AND ref=?",
                params![session_id, reference],
            )
        })
    }

    /// `pruneMetrics`.
    pub fn prune_metrics(&self, session_id: &str) -> Result<PruneMetrics, SessionError> {
        let (pruned, saved, refetches) = q_one(
            self.conn(),
            "SELECT COUNT(*) AS pruned,COALESCE(SUM(tokens_saved),0) AS saved,COALESCE(SUM(refetches),0) AS refetches FROM tool_visibility WHERE session_id=?",
            [session_id],
            |r| Ok((r.get::<_, i64>("pruned")?, r.get::<_, i64>("saved")?, r.get::<_, i64>("refetches")?)),
        )?
        .unwrap_or((0, 0, 0));
        Ok(PruneMetrics {
            pruned,
            tokens_saved: saved,
            refetches,
            refetch_rate: if pruned != 0 {
                refetches as f64 / pruned as f64
            } else {
                0.0
            },
        })
    }

    /// `setToolVisibilities`: all changes in one transaction; a pruning change that names a turn also appends
    /// `compaction.prune`, and the turn must be a completed turn of this session.
    pub fn set_tool_visibilities(
        &mut self,
        session_id: &str,
        changes: &[VisibilityChange],
    ) -> Result<(), SessionError> {
        self.tx(|env, c| {
            for change in changes {
                set_visibility_in(
                    c,
                    session_id,
                    &change.reference,
                    change.hidden,
                    &change.reason,
                    change.detail.as_ref(),
                )?;
                if let (Some(detail), Some(turn_id)) = (&change.detail, &change.turn_id) {
                    let turn = q_one(
                        c,
                        "SELECT session_id,state FROM turns WHERE id=?",
                        [turn_id.as_str()],
                        |r| Ok((s(r, "session_id")?, s(r, "state")?)),
                    )?;
                    if !turn.is_some_and(|t| t.0 == session_id && t.1 == "completed") {
                        return Err(SessionError::conflict(
                            "pruning turn is not completed",
                            "turn-not-running",
                        ));
                    }
                    let data = J::obj([
                        ("ref", J::s(&change.reference)),
                        (
                            "mode",
                            J::s(if detail.truncate { "truncate" } else { "drop" }),
                        ),
                        ("confidence", J::Num(detail.confidence)),
                        ("tokensSaved", J::Num(detail.tokens_saved as f64)),
                    ]);
                    insert_event_in(env, c, session_id, Some(turn_id), "compaction.prune", data)?;
                }
            }
            Ok(())
        })
    }

    /// `addSummary`.
    pub fn add_summary(&mut self, n: &NewSummary) -> Result<SummaryRecord, SessionError> {
        self.tx(|env, c| add_summary_in(env, c, n))
    }

    /// `listSummaries`: by covered range, then tier.
    pub fn list_summaries(
        &self,
        session_id: &str,
        state: Option<SummaryState>,
    ) -> Result<Vec<SummaryRecord>, SessionError> {
        match state {
            Some(st) => q_all(
                self.conn(),
                "SELECT * FROM summaries WHERE session_id = ? AND state = ? ORDER BY from_seq, tier",
                params![session_id, st.as_str()],
                to_summary,
            ),
            None => q_all(
                self.conn(),
                "SELECT * FROM summaries WHERE session_id = ? ORDER BY from_seq, tier",
                [session_id],
                to_summary,
            ),
        }
    }

    /// `setSummaryState`.
    pub fn set_summary_state(&mut self, id: &str, state: SummaryState) -> Result<(), SessionError> {
        self.tx(|_, c| {
            run(
                c,
                "UPDATE summaries SET state = ? WHERE id = ?",
                params![state.as_str(), id],
            )
        })
    }

    /// `replaceSummaries`: swaps a set of summaries for one that replaces them (tiered re-summarisation), atomically.
    pub fn replace_summaries(
        &mut self,
        supersede: &[String],
        next: &NewSummary,
    ) -> Result<SummaryRecord, SessionError> {
        self.tx(|env, c| {
            for id in supersede {
                run(
                    c,
                    "UPDATE summaries SET state = ? WHERE id = ?",
                    params![SummaryState::Superseded.as_str(), id],
                )?;
            }
            add_summary_in(env, c, next)
        })
    }

    /// `activePath` over the active context for callers that hold their own messages (K5b).
    pub fn active_messages(
        &self,
        session_id: &str,
        messages: &[MessageRecord],
    ) -> Result<Vec<MessageRecord>, SessionError> {
        let rewinds = rewinds_in(self.conn(), session_id)?;
        Ok(active_path(messages, &super::store::ranges(&rewinds)))
    }
}

fn tool_offers_in(c: &Connection, session_id: &str) -> Result<Vec<String>, SessionError> {
    if get_session_in(c, session_id)?.is_none() {
        return Err(SessionError::not_found("session not found", None));
    }
    q_all(
        c,
        "SELECT name FROM session_tool_offers WHERE session_id=? ORDER BY ordinal",
        [session_id],
        |r| r.get::<_, String>(0),
    )
}

fn model_reasoning_in(c: &Connection, session_id: &str) -> Result<Option<String>, SessionError> {
    Ok(q_one(
        c,
        "SELECT reasoning FROM session_model_profiles WHERE session_id=?",
        [session_id],
        |r| r.get::<_, Option<String>>(0),
    )?
    .flatten())
}

fn worktree_in(c: &Connection, session_id: &str) -> Result<Option<WorktreeBinding>, SessionError> {
    q_one(
        c,
        "SELECT * FROM session_worktrees WHERE session_id=?",
        [session_id],
        |r| {
            Ok(WorktreeBinding {
                session_id: session_id.to_owned(),
                root: s(r, "root")?,
                project_id: r.get("project_id")?,
                card_id: r.get("card_id")?,
                created_by: s(r, "created_by")?,
                created_at: r.get("created_at")?,
            })
        },
    )
}
