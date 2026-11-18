//! `session/store.ts`, the turn, message and event half: a turn is begun with its user message and `turn.started` in one
//! transaction, completed or failed with its event, and every message and event takes the next per-session sequence number
//! from the session row. Messages and events are append-only; nothing here updates or deletes one.
use super::overlay::active_path;
use super::store::{
    events_of, get_session_in, q_all, q_one, ranges, run, running_turn_in, s, to_message, to_turn,
    Env, SessionStore,
};
use super::types::*;
use super::SessionError;
use crate::approvals::js_json::J;
use plur1bus_store::rusqlite::types::Value;
use plur1bus_store::rusqlite::{params, params_from_iter, Connection};
use std::collections::HashSet;

/// `ACTIVE_TURN_SQL`: a partially discarded turn cannot contribute tool or skill state; its assistant-side tools belong
/// to that attempt too.
pub(crate) const ACTIVE_TURN_SQL: &str = "NOT EXISTS (
  SELECT 1 FROM messages tm JOIN path_rewinds r ON r.session_id=tm.session_id
  WHERE tm.turn_id=t.id AND tm.session_id=t.session_id AND
    ((r.undone_at IS NULL AND tm.seq BETWEEN r.hidden_from_seq AND r.hidden_to_seq)
      OR (r.undone_at IS NOT NULL AND tm.id=r.lesson_message_id)))";

fn last_seq(c: &Connection, column: &str, session_id: &str) -> Result<i64, SessionError> {
    q_one(
        c,
        &format!("SELECT {column} FROM sessions WHERE id = ?"),
        [session_id],
        |r| r.get::<_, i64>(0),
    )?
    .ok_or_else(|| {
        SessionError::not_found(&format!("session {session_id} not found"), Some("session"))
    })
}

/// `#insertMessage`: the next message seq, then the row. The id is drawn before the clock, as in TypeScript.
pub(crate) fn insert_message_in(
    env: &Env,
    c: &Connection,
    session_id: &str,
    turn_id: Option<&str>,
    role: MessageRole,
    text: &str,
    tokens: i64,
) -> Result<MessageRecord, SessionError> {
    let seq = last_seq(c, "last_message_seq", session_id)? + 1;
    let id = env.new_id("msg");
    let now = env.now();
    run(
        c,
        "UPDATE sessions SET last_message_seq = ? WHERE id = ?",
        params![seq, session_id],
    )?;
    run(
        c,
        "INSERT INTO messages (id, session_id, turn_id, seq, role, text, tokens, created_at) VALUES (?,?,?,?,?,?,?,?)",
        params![id, session_id, turn_id, seq, role.as_str(), text, tokens, now],
    )?;
    Ok(MessageRecord {
        id,
        session_id: session_id.to_owned(),
        turn_id: turn_id.map(str::to_owned),
        seq,
        role,
        text: text.to_owned(),
        tokens,
        created_at: now,
    })
}

/// `#insertEvent`: the next event seq, then the row; the payload is stored as `JSON.stringify` prints it.
pub(crate) fn insert_event_in(
    env: &Env,
    c: &Connection,
    session_id: &str,
    turn_id: Option<&str>,
    kind: &str,
    data: J,
) -> Result<EventRecord, SessionError> {
    let seq = last_seq(c, "last_event_seq", session_id)? + 1;
    let at = env.now();
    run(
        c,
        "UPDATE sessions SET last_event_seq = ? WHERE id = ?",
        params![seq, session_id],
    )?;
    run(
        c,
        "INSERT INTO events (session_id, seq, turn_id, type, data, at) VALUES (?,?,?,?,?,?)",
        params![session_id, seq, turn_id, kind, data.stringify(), at],
    )?;
    Ok(EventRecord {
        session_id: session_id.to_owned(),
        turn_id: turn_id.map(str::to_owned),
        seq,
        kind: kind.to_owned(),
        data,
        at,
    })
}

/// `{ ...base, ...extra }`: members of `extra` set in their enumeration order.
fn spread(mut base: J, extra: Option<&J>) -> J {
    if let Some(e) = extra {
        for (k, v) in e.members() {
            base.set(k, v.clone());
        }
    }
    base
}

pub(crate) fn harness_command_turns_in(
    c: &Connection,
    session_id: &str,
) -> Result<HashSet<String>, SessionError> {
    Ok(q_all(
        c,
        "SELECT DISTINCT turn_id FROM events WHERE session_id=? AND turn_id IS NOT NULL
      AND type IN ('turn.started','turn.completed','turn.failed')
      AND json_extract(data,'$.provider')='harness-command'",
        [session_id],
        |r| r.get::<_, String>(0),
    )?
    .into_iter()
    .collect())
}

/// `contextMessages`: the active history after an optional exclusive boundary; no pagination can truncate a rewind digest.
pub(crate) fn context_messages_in(
    c: &Connection,
    session_id: &str,
    after_seq: Option<i64>,
) -> Result<Vec<MessageRecord>, SessionError> {
    // M6: scan command provenance once, never once per message on every session's prompt path.
    let commands = harness_command_turns_in(c, session_id)?;
    let rows = q_all(
        c,
        "SELECT * FROM messages WHERE session_id=? AND seq>? ORDER BY seq",
        params![session_id, after_seq.unwrap_or(0)],
        to_message,
    )?;
    let messages: Vec<MessageRecord> = rows
        .into_iter()
        .filter(|m| m.turn_id.as_deref().is_none_or(|t| !commands.contains(t)))
        .collect();
    let rewinds = super::store_misc::rewinds_in(c, session_id)?;
    Ok(active_path(&messages, &ranges(&rewinds)))
}

impl SessionStore {
    /// `beginTurn`: atomically records the user's message, the running turn and `turn.started`. One running turn per
    /// session; an archived session, a reserved rewind or a running turn refuses.
    pub fn begin_turn(
        &mut self,
        session_id: &str,
        text: &str,
        tokens: i64,
        options: &BeginOptions,
    ) -> Result<BegunTurn, SessionError> {
        self.tx(|env, c| {
            let sess = get_session_in(c, session_id)?.ok_or_else(|| {
                SessionError::not_found(&format!("session {session_id} not found"), Some("session"))
            })?;
            if sess.archived_at.is_some() {
                return Err(SessionError::conflict(&format!("session {session_id} is archived"), "archived"));
            }
            if env.reservations.contains_key(session_id) {
                return Err(SessionError::conflict(
                    "file rewind is awaiting or applying approval",
                    "rewind-in-progress",
                ));
            }
            if running_turn_in(c, session_id)?.is_some() {
                return Err(SessionError::conflict(
                    &format!("session {session_id} already has a running turn"),
                    "turn-in-progress",
                ));
            }
            let now = env.now();
            let turn_id = env.new_id("trn");
            let seq = sess.turn_count + 1;
            run(
                c,
                "INSERT INTO turns (id, session_id, seq, state, started_at, incognito) VALUES (?,?,?,?,?,?)",
                params![turn_id, session_id, seq, "running", now, i64::from(sess.memory_mode == MemoryMode::Incognito)],
            )?;
            run(
                c,
                "UPDATE sessions SET turn_count = ?, last_turn_at = ?, updated_at = ? WHERE id = ?",
                params![seq, now, now, session_id],
            )?;
            let message = insert_message_in(env, c, session_id, Some(&turn_id), MessageRole::User, text, tokens)?;
            let mut data = J::obj([
                ("turnId", J::s(&turn_id)),
                ("turnSeq", J::Num(seq as f64)),
                ("messageId", J::s(&message.id)),
            ]);
            if options.harness_command {
                data.set("provider", J::s("harness-command"));
            }
            if let Some(origin) = &options.channel_origin {
                data.set("channelOrigin", origin.clone());
            }
            let event = insert_event_in(env, c, session_id, Some(&turn_id), "turn.started", data)?;
            let turn = q_one(c, "SELECT * FROM turns WHERE id = ?", [turn_id.as_str()], to_turn)?
                .ok_or_else(|| SessionError::not_found("turn not found", Some("turn")))?;
            Ok(BegunTurn { turn, message, event })
        })
    }

    /// `completeTurn`: the assistant message, the state change and `turn.completed`; `None` when the turn is unknown or
    /// not running.
    pub fn complete_turn(
        &mut self,
        turn_id: &str,
        text: &str,
        tokens: i64,
        data: Option<&J>,
    ) -> Result<Option<CompletedTurn>, SessionError> {
        self.tx(|env, c| {
            let Some(t) = q_one(c, "SELECT * FROM turns WHERE id = ?", [turn_id], to_turn)? else {
                return Ok(None);
            };
            if t.state != TurnState::Running {
                return Ok(None);
            }
            let now = env.now();
            let message = insert_message_in(
                env,
                c,
                &t.session_id,
                Some(turn_id),
                MessageRole::Assistant,
                text,
                tokens,
            )?;
            run(
                c,
                "UPDATE turns SET state = 'completed', ended_at = ? WHERE id = ?",
                params![now, turn_id],
            )?;
            run(
                c,
                "UPDATE sessions SET updated_at = ? WHERE id = ?",
                params![now, t.session_id],
            )?;
            let payload = spread(
                J::obj([("turnId", J::s(turn_id)), ("messageId", J::s(&message.id))]),
                data,
            );
            let event = insert_event_in(
                env,
                c,
                &t.session_id,
                Some(turn_id),
                "turn.completed",
                payload,
            )?;
            Ok(Some(CompletedTurn { message, event }))
        })
    }

    /// `failTurn`: marks a running turn failed and emits `turn.failed`; `None` when it was not running (idempotent).
    pub fn fail_turn(
        &mut self,
        turn_id: &str,
        error: &str,
        data: Option<&J>,
    ) -> Result<Option<EventRecord>, SessionError> {
        self.tx(|env, c| {
            let Some(t) = q_one(c, "SELECT * FROM turns WHERE id = ?", [turn_id], to_turn)? else {
                return Ok(None);
            };
            if t.state != TurnState::Running {
                return Ok(None);
            }
            let now = env.now();
            run(
                c,
                "UPDATE turns SET state = 'failed', ended_at = ?, error = ? WHERE id = ?",
                params![now, error, turn_id],
            )?;
            run(
                c,
                "UPDATE sessions SET updated_at = ? WHERE id = ?",
                params![now, t.session_id],
            )?;
            let payload = spread(
                J::obj([("turnId", J::s(turn_id)), ("error", J::s(error))]),
                data,
            );
            Ok(Some(insert_event_in(
                env,
                c,
                &t.session_id,
                Some(turn_id),
                "turn.failed",
                payload,
            )?))
        })
    }

    /// `recoverRunningTurns` (crash recovery, acceptance 7): every turn still `running` when the core starts was cut off.
    pub fn recover_running_turns(&mut self) -> Result<Vec<EventRecord>, SessionError> {
        let ids = q_all(
            self.conn(),
            "SELECT id FROM turns WHERE state = 'running' ORDER BY started_at, id",
            [],
            |r| r.get::<_, String>(0),
        )?;
        let mut out = Vec::new();
        let data = J::obj([("recovered", J::Bool(true))]);
        for id in ids {
            if let Some(e) = self.fail_turn(&id, "core-restarted", Some(&data))? {
                out.push(e);
            }
        }
        Ok(out)
    }

    /// `lastEventSeq`: the newest event seq of a session (0 when it has none), `None` for an unknown session.
    pub fn last_event_seq(&self, session_id: &str) -> Result<Option<i64>, SessionError> {
        q_one(
            self.conn(),
            "SELECT last_event_seq FROM sessions WHERE id = ?",
            [session_id],
            |r| r.get::<_, i64>(0),
        )
    }

    /// `runningTurn`.
    pub fn running_turn(&self, session_id: &str) -> Result<Option<TurnRecord>, SessionError> {
        running_turn_in(self.conn(), session_id)
    }

    /// `getTurn`.
    pub fn get_turn(&self, id: &str) -> Result<Option<TurnRecord>, SessionError> {
        q_one(
            self.conn(),
            "SELECT * FROM turns WHERE id = ?",
            [id],
            to_turn,
        )
    }

    /// `listTurns`.
    pub fn list_turns(&self, session_id: &str) -> Result<Vec<TurnRecord>, SessionError> {
        q_all(
            self.conn(),
            "SELECT * FROM turns WHERE session_id = ? ORDER BY seq",
            [session_id],
            to_turn,
        )
    }

    /// `learningToolErrors` (LP7): deliberately projects only trusted metadata; never selects event data, output or
    /// messages. The limit is capped at 4001 (one more than the caller's cap exposes overflow).
    pub fn learning_tool_errors(
        &self,
        owner: &str,
        from: i64,
        to: i64,
        limit: i64,
    ) -> Result<Vec<LearningToolError>, SessionError> {
        let rows = q_all(
            self.conn(),
            "SELECT e.session_id,e.turn_id,e.seq,e.at,json_extract(e.data,'$.learnTool') AS metadata
      FROM events e JOIN turns t ON t.id=e.turn_id JOIN sessions s ON s.id=e.session_id
      WHERE s.owner=? AND s.memory_mode='remember' AND t.incognito=0 AND t.state IN ('completed','failed')
      AND t.ended_at>=? AND t.ended_at<? AND e.type='tool.result' AND json_extract(e.data,'$.learnTool.version')=1
      ORDER BY t.ended_at DESC,e.session_id,e.seq LIMIT ?",
            params![owner, from, to, limit.min(4001)],
            |r| {
                Ok((
                    s(r, "session_id")?,
                    s(r, "turn_id")?,
                    r.get::<_, i64>("seq")?,
                    r.get::<_, i64>("at")?,
                    s(r, "metadata")?,
                ))
            },
        )?;
        rows.into_iter()
            .map(|(session_id, turn_id, seq, at, metadata)| {
                let metadata = J::parse(&metadata).ok_or_else(|| {
                    SessionError::new(
                        super::ErrorCode::Storage,
                        "event payload is unreadable",
                        Some("event-data"),
                    )
                })?;
                Ok(LearningToolError {
                    session_id,
                    turn_id,
                    seq,
                    at,
                    metadata,
                })
            })
            .collect()
    }

    /// `learningTranscript`: reads the completed-turn window before imposing content caps; one extra row exposes overflow.
    pub fn learning_transcript(
        &self,
        session_id: &str,
        from: i64,
        to: i64,
        max_messages: i64,
        max_events: i64,
        turn_ids: Option<&[String]>,
    ) -> Result<LearningTranscript, SessionError> {
        let mut predicate =
            "t.session_id=? AND t.state='completed' AND t.incognito=0 AND t.ended_at>=? AND t.ended_at<?".to_owned();
        let mut args: Vec<Value> = vec![
            Value::Text(session_id.to_owned()),
            Value::Integer(from),
            Value::Integer(to),
        ];
        if let Some(ids) = turn_ids {
            if ids.is_empty() || ids.len() > 100 {
                return Ok(LearningTranscript {
                    messages: Vec::new(),
                    events: Vec::new(),
                });
            }
            predicate.push_str(&format!(
                " AND t.id IN ({})",
                vec!["?"; ids.len()].join(",")
            ));
            args.extend(ids.iter().map(|i| Value::Text(i.clone())));
        }
        let mut m_args = args.clone();
        m_args.push(Value::Integer(max_messages + 1));
        let messages = q_all(
            self.conn(),
            &format!(
                "SELECT m.* FROM messages m JOIN turns t ON t.id=m.turn_id
      WHERE {predicate} AND m.session_id=t.session_id AND NOT EXISTS
      (SELECT 1 FROM path_rewinds r WHERE r.session_id=m.session_id AND
       ((r.undone_at IS NULL AND m.seq BETWEEN r.hidden_from_seq AND r.hidden_to_seq)
        OR (r.undone_at IS NOT NULL AND m.id=r.lesson_message_id)))
      ORDER BY m.seq LIMIT ?"
            ),
            params_from_iter(m_args.iter()),
            to_message,
        )?;
        let mut e_args = args;
        e_args.push(Value::Integer(max_events + 1));
        let events = events_of(
            self.conn(),
            &format!(
                "SELECT e.* FROM events e JOIN turns t ON t.id=e.turn_id
      WHERE {predicate} AND e.session_id=t.session_id ORDER BY e.seq LIMIT ?"
            ),
            params_from_iter(e_args.iter()),
        )?;
        Ok(LearningTranscript { messages, events })
    }

    /// `appendEvent`: one in-turn event (a delta, a tool placeholder). The turn must be running.
    pub fn append_event(
        &mut self,
        turn_id: &str,
        kind: EventType,
        data: J,
    ) -> Result<EventRecord, SessionError> {
        self.tx(|env, c| {
            let t = q_one(
                c,
                "SELECT session_id, state FROM turns WHERE id = ?",
                [turn_id],
                |r| Ok((s(r, "session_id")?, s(r, "state")?)),
            )?
            .ok_or_else(|| {
                SessionError::not_found(&format!("turn {turn_id} not found"), Some("turn"))
            })?;
            if t.1 != "running" {
                return Err(SessionError::conflict(
                    &format!("turn {turn_id} is not running"),
                    "turn-not-running",
                ));
            }
            insert_event_in(env, c, &t.0, Some(turn_id), kind.as_str(), data)
        })
    }

    /// `listEvents`: events after a seq, at most `limit` (1..=2000).
    pub fn list_events(
        &self,
        session_id: &str,
        after_seq: i64,
        limit: i64,
    ) -> Result<Vec<EventRecord>, SessionError> {
        events_of(
            self.conn(),
            "SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
            params![session_id, after_seq, limit.clamp(1, 2000)],
        )
    }

    /// `toolResult`: one session-scoped tool result for the human diff lookup, without loading the event history.
    pub fn tool_result(
        &self,
        session_id: &str,
        call_id: &str,
    ) -> Result<Option<String>, SessionError> {
        let row = q_one(
            self.conn(),
            "SELECT data FROM events WHERE session_id=? AND type='tool.result' AND json_extract(data,'$.id')=? ORDER BY seq DESC LIMIT 1",
            params![session_id, call_id],
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
        Ok(data.get("output").and_then(J::as_str).map(str::to_owned))
    }

    /// `listMessages`. Default: ascending, but a cut-off keeps the NEWEST `limit` messages (the readers want the tail of a
    /// long session); `keep_oldest` is the forward-paging reading (`chat.get`'s legacy order).
    pub fn list_messages(
        &self,
        session_id: &str,
        o: &MessageQuery,
    ) -> Result<Vec<MessageRecord>, SessionError> {
        let limit = o.limit.unwrap_or(10_000).clamp(1, 100_000);
        let before = o
            .before_seq
            .unwrap_or_else(super::store::default_message_before);
        let after = o.after_seq.unwrap_or(0);
        if o.keep_oldest {
            return q_all(
                self.conn(),
                "SELECT * FROM messages WHERE session_id=? AND seq<? AND seq>? ORDER BY seq LIMIT ?",
                params![session_id, before, after, limit],
                to_message,
            );
        }
        let mut rows = q_all(
            self.conn(),
            "SELECT * FROM messages WHERE session_id=? AND seq<? AND seq>? ORDER BY seq DESC LIMIT ?",
            params![session_id, before, after, limit],
            to_message,
        )?;
        rows.reverse();
        Ok(rows)
    }

    /// `harnessCommandTurns`: trusted command provenance for retained transcripts, failed and recovered commands included.
    pub fn harness_command_turns(&self, session_id: &str) -> Result<HashSet<String>, SessionError> {
        harness_command_turns_in(self.conn(), session_id)
    }

    /// `contextMessages`.
    pub fn context_messages(
        &self,
        session_id: &str,
        after_seq: Option<i64>,
    ) -> Result<Vec<MessageRecord>, SessionError> {
        context_messages_in(self.conn(), session_id, after_seq)
    }

    /// `toolEvents`: an internal read-only background scan; event pagination never drops older tool pairs.
    pub fn tool_events(&self, session_id: &str) -> Result<Vec<EventRecord>, SessionError> {
        events_of(
            self.conn(),
            "SELECT * FROM events WHERE session_id=? AND type IN ('tool.call','tool.result') ORDER BY seq",
            [session_id],
        )
    }

    /// `contextToolEvents`: prompt and background model readers may only consume tool events of wholly active turns.
    pub fn context_tool_events(&self, session_id: &str) -> Result<Vec<EventRecord>, SessionError> {
        context_tool_events_in(self.conn(), session_id)
    }
}

pub(crate) fn context_tool_events_in(
    c: &Connection,
    session_id: &str,
) -> Result<Vec<EventRecord>, SessionError> {
    events_of(
        c,
        &format!(
            "SELECT e.* FROM events e JOIN turns t ON t.id=e.turn_id AND t.session_id=e.session_id
      WHERE e.session_id=? AND e.type IN ('tool.call','tool.result') AND {ACTIVE_TURN_SQL} ORDER BY e.seq"
        ),
        [session_id],
    )
}
