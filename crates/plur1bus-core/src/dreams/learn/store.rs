//! Private SQLite ledger and resumable payloads for learning.

use std::path::Path;

use super::{digest, target_hash, target_valid, Target, Window};
use crate::collab::{CollabError, CollabErrorCode as C};
use crate::private_store;
use crate::toolcall::json::{parse, V};
use plur1bus_store::rusqlite::{
    self, params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior,
};
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreSpec};
use serde::{Deserialize, Serialize};

type R<T> = Result<T, CollabError>;

/// Content-free run metadata, kept separately from resumable model output.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    /// Stable identifier of this target and window.
    pub id: String,
    /// Private target identity.
    pub target: Target,
    /// Immutable evidence window.
    pub window: Window,
    /// References to admitted sessions.
    pub session_ids: Vec<String>,
    /// Hash of the admitted evidence.
    pub digest: String,
    /// When the run first began.
    pub started_at: i64,
    /// When the latest attempt ended.
    pub finished_at: Option<i64>,
    /// Current disposition.
    pub outcome: Option<Outcome>,
    /// Diagnostic reason from the learning vocabulary.
    pub reason: Option<String>,
    /// Conservative model budget spent before or during attempts.
    pub tokens: i64,
    /// Number of published findings.
    pub findings: usize,
    /// Whether the caller capped the eligible selection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    /// Number of eligible sessions left unloaded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub omitted_sessions: Option<usize>,
}

/// Stable disposition of a learning attempt.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// Findings were published or the completed selection produced none.
    Completed,
    /// An admission gate rejected the attempt.
    Skipped,
    /// The source, model or structured output failed.
    Failed,
    /// Evidence exceeded the bounded transcript size.
    Deferred,
}

/// Privacy reconciliation through trusted current registries.
pub trait Reconcile {
    /// Is the destination still authorized?
    fn target(&self, target: &Target) -> bool;
    /// Is the referenced session still visible?
    fn session(&self, target: &Target, id: &str) -> bool;
    /// Is the exact evidence reference still available?
    fn evidence(&self, target: &Target, evidence: &V) -> bool;
}

/// Aggregate health summary without run or finding payload.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    /// On-disk schema version.
    pub schema: i64,
    /// SQLite reports consistent b-trees.
    pub integrity: bool,
    /// Findings awaiting a human decision.
    pub pending: i64,
    /// Procedural findings waiting for the skill bridge.
    pub waiting_h3: i64,
    /// Number of target breakers currently hit.
    pub breakers: i64,
}

#[path = "store_migrations.rs"]
mod migrations;

#[path = "store_attempts.rs"]
mod attempts;

#[path = "store_findings.rs"]
mod findings;
pub use findings::{Decision, Observation, Signal};

const DAY: i64 = 86_400_000;
const SIZE: usize = 262_144;
const FAILURE_CAP: i64 = 3;
pub(super) const PROMPT_VERSION: &str = "learn-2";

/// Learning store owned only by the trusted library host.
pub struct LearnStore {
    db: Store,
}

fn storage(message: &'static str) -> CollabError {
    CollabError::new(C::Storage, message)
}

fn invalid(message: &'static str) -> CollabError {
    CollabError::new(C::Invalid, message)
}

fn denied() -> CollabError {
    CollabError::with_reason(C::Unauthorized, "learning rights changed", "rights-changed")
}

fn rows<T>(
    conn: &Connection,
    query: &str,
    args: impl rusqlite::Params,
    read: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> R<Vec<T>> {
    let mut statement = conn.prepare(query)?;
    let items = statement
        .query_map(args, read)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(items)
}

fn encode(run: &Run) -> R<String> {
    serde_json::to_string(run).map_err(|_| invalid("invalid learning run"))
}

fn decode(row: &Row<'_>) -> rusqlite::Result<Run> {
    let text: String = row.get(0)?;
    serde_json::from_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn read_payload_on(conn: &Connection, run: &str, key: &str) -> R<Option<V>> {
    let payload: Option<String> = conn
        .query_row(
            "SELECT payload FROM learn_payload WHERE run_id=? AND key=?",
            params![run, key],
            |row| row.get(0),
        )
        .optional()?;
    payload
        .map(|raw| parse(&raw).ok_or_else(|| storage("invalid learning payload")))
        .transpose()
}

fn put_payload(conn: &Connection, run: &str, key: &str, text: &str) -> R<()> {
    conn.execute("INSERT INTO learn_payload VALUES(?,?,?) ON CONFLICT(run_id,key) DO UPDATE SET payload=excluded.payload",
        params![run,key,text])?;
    Ok(())
}

fn update_metadata(conn: &Connection, run: &Run) -> R<()> {
    conn.execute(
        "UPDATE learn_run SET metadata=? WHERE id=?",
        params![encode(run)?, run.id],
    )?;
    Ok(())
}

fn is_terminal(run: &Run) -> bool {
    run.outcome == Some(Outcome::Completed)
        || matches!(
            run.reason.as_deref(),
            Some(
                "rights-changed"
                    | "disabled"
                    | "invalid-output"
                    | "no-sessions"
                    | "breaker-open"
                    | "local-only"
                    | "no-model"
            )
        )
}

fn win_valid(window: Window) -> bool {
    window.from >= 0 && window.to > window.from && window.to <= super::SAFE_INTEGER
}

fn checkpoint_key(key: &str) -> bool {
    !key.is_empty()
        && key.encode_utf16().count() <= 256
        && !key.starts_with("finding:")
        && !key.starts_with("runner:")
        && !key.chars().any(char::is_control)
}

fn find_run(conn: &Connection, id: &str) -> R<Option<Run>> {
    Ok(conn
        .query_row("SELECT metadata FROM learn_run WHERE id=?", [id], decode)
        .optional()?)
}

fn is_invalidated(conn: &Connection, id: &str) -> R<bool> {
    Ok(conn
        .query_row(
            "SELECT invalidated=1 FROM learn_run WHERE id=?",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(false))
}

fn active_run(conn: &Connection, run: &Run) -> R<Run> {
    let previous = find_run(conn, &run.id)?
        .ok_or_else(|| CollabError::new(C::NotFound, "learning run is missing"))?;
    if previous.target != run.target
        || previous.window != run.window
        || previous.started_at != run.started_at
    {
        return Err(denied());
    }
    if previous.outcome.is_some() {
        return Err(CollabError::new(
            C::Conflict,
            "learning run is already closed",
        ));
    }
    Ok(previous)
}

fn drop_checkpoints(conn: &Connection, run: &str) -> R<usize> {
    Ok(conn.execute(
        "DELETE FROM learn_payload WHERE run_id=? AND key NOT LIKE 'finding:%'",
        [run],
    )?)
}

fn protect(path: &Path, mode: u32) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).is_ok()
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        false
    }
}

impl LearnStore {
    /// Open an in-memory or private file store.
    pub fn open(path: &Path) -> R<Self> {
        Self::open_with_permissions(path, &protect)
    }

    /// Open with an owner-only permission port; mode is 0700 for directory and 0600 for database.
    pub fn open_with_permissions(path: &Path, secure: &dyn Fn(&Path, u32) -> bool) -> R<Self> {
        let memory = path == Path::new(":memory:");
        let directory = if memory {
            None
        } else {
            let dir = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .ok_or_else(|| invalid("learning database requires a private parent directory"))?;
            private_store::prepare(path)
                .map_err(|_| storage("cannot prepare learning database"))?;
            Some(dir)
        };
        let db = Store::open_owner_before_configure(
            path,
            &OwnerSpec {
                store: StoreSpec {
                    pragmas: &["PRAGMA secure_delete=ON"],
                    ..StoreSpec::new("learn", migrations::VERSION)
                },
                journal: if memory {
                    Journal::Unchanged
                } else {
                    Journal::Wal
                },
                schema: Schema::Unversioned,
                create: true,
            },
            |conn| -> R<()> {
                migrations::checked_version(conn)?;
                if directory.is_some_and(|dir| !secure(dir, 0o700) || !secure(path, 0o600)) {
                    return Err(storage("cannot protect learning database"));
                }
                Ok(())
            },
        )?;
        migrations::apply(db.conn())?;
        Ok(Self { db })
    }

    fn transaction(&self) -> R<Transaction<'_>> {
        Ok(Transaction::new_unchecked(
            self.db.conn(),
            TransactionBehavior::Immediate,
        )?)
    }

    /// Checkpoint and compact the WAL through SQLite.
    pub fn compact(&self) -> R<()> {
        self.db
            .conn()
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
    }

    /// Find or initialize the durable target and window ledger.
    pub fn begin(&self, target: &Target, window: Window, now: i64) -> R<Run> {
        if !target_valid(target) || !win_valid(window) || !(0..=super::SAFE_INTEGER).contains(&now)
        {
            return Err(denied());
        }
        let hash = target_hash(target);
        let tx = self.transaction()?;
        let previous = tx.query_row("SELECT metadata FROM learn_run WHERE target_hash=? AND window_from=? AND window_to=?",
            params![hash,window.from,window.to], decode).optional()?;
        let run = if let Some(previous) = previous {
            previous
        } else {
            let id = digest(&V::Arr(vec![
                V::s(&hash),
                V::Num(window.from as f64),
                V::Num(window.to as f64),
                V::s(PROMPT_VERSION),
            ]));
            let run = Run {
                id,
                target: target.clone(),
                window,
                session_ids: Vec::new(),
                digest: String::new(),
                started_at: now,
                finished_at: None,
                outcome: None,
                reason: None,
                tokens: 0,
                findings: 0,
                truncated: None,
                omitted_sessions: None,
            };
            tx.execute("INSERT INTO learn_run(id,target_hash,window_from,window_to,metadata,owner) VALUES(?,?,?,?,?,?)",
                params![run.id,hash,window.from,window.to,encode(&run)?,target.owner])?;
            run
        };
        tx.commit()?;
        Ok(run)
    }

    /// Get the latest run metadata by id.
    pub fn get(&self, id: &str) -> R<Option<Run>> {
        find_run(self.db.conn(), id)
    }

    /// List bounded run projections for one owner.
    pub fn runs(&self, owner: &str, target: Option<&Target>) -> R<Vec<Run>> {
        if target.is_some_and(|target| target.owner != owner) {
            return Err(denied());
        }
        rows(
            self.db.conn(),
            "SELECT metadata FROM learn_run WHERE owner=?1 AND (?2 IS NULL OR target_hash=?2)
            ORDER BY window_to DESC LIMIT 1000",
            params![owner, target.map(target_hash)],
            decode,
        )
    }

    /// Save selection and budget progress for an open run.
    pub fn save(&self, run: &Run) -> R<()> {
        let tx = self.transaction()?;
        let previous = active_run(&tx, run)?;
        if is_invalidated(&tx, &run.id)? {
            return Err(denied());
        }
        if run.outcome.is_some()
            || run.finished_at.is_some()
            || run.reason.is_some()
            || run.findings != previous.findings
            || !(previous.tokens..=super::SAFE_INTEGER).contains(&run.tokens)
            || run.session_ids.len() > super::SESSIONS
            || (!previous.digest.is_empty()
                && (previous.digest != run.digest || previous.session_ids != run.session_ids))
        {
            return Err(invalid("invalid learning progress"));
        }
        update_metadata(&tx, run)?;
        tx.commit()?;
        Ok(())
    }

    /// Retrieve a private, live checkpoint for the runner.
    pub fn payload(&self, run: &str, key: &str) -> R<Option<V>> {
        if !checkpoint_key(key) {
            return Err(invalid("invalid learning checkpoint key"));
        }
        let query = "SELECT p.payload FROM learn_payload p JOIN learn_run r ON r.id=p.run_id
            WHERE p.run_id=? AND p.key=? AND r.invalidated=0";
        let payload: Option<String> = self
            .db
            .conn()
            .query_row(query, params![run, key], |row| row.get(0))
            .optional()?;
        payload
            .map(|raw| parse(&raw).ok_or_else(|| storage("invalid learning payload")))
            .transpose()
    }

    /// Persist a resumable checkpoint and its step together.
    pub fn checkpoint(&self, run: &str, key: &str, value: &V) -> R<()> {
        let text = value.stringify();
        if !checkpoint_key(key) || text.len() > SIZE {
            return Err(invalid("invalid learning checkpoint"));
        }
        let tx = self.transaction()?;
        let live = find_run(&tx, run)?
            .ok_or_else(|| CollabError::new(C::NotFound, "learning run is missing"))?;
        if live.outcome.is_some() || is_invalidated(&tx, run)? {
            return Err(denied());
        }
        put_payload(&tx, run, key, &text)?;
        tx.execute("INSERT INTO learn_step VALUES(?,?,'completed') ON CONFLICT(run_id,step) DO UPDATE SET state='completed'",
            params![run,key])?;
        tx.commit()?;
        Ok(())
    }

    /// Close the latest attempt and retire payload when terminal.
    pub fn finish(&self, run: &Run, outcome: Outcome, reason: Option<&str>, at: i64) -> R<Run> {
        let tx = self.transaction()?;
        let closed = finish_on(&tx, run, outcome, reason, at)?;
        tx.commit()?;
        Ok(closed)
    }

    /// True when source or target access was invalidated.
    pub fn invalidated(&self, run: &str) -> R<bool> {
        is_invalidated(self.db.conn(), run)
    }

    /// Close expired checkpoints and withdraw denied evidence.
    pub fn reconcile(&self, at: i64, checkpoint_days: i64, rights: &dyn Reconcile) -> R<()> {
        if at < 0 || !(0..=365).contains(&checkpoint_days) {
            return Err(invalid("invalid learning reconciliation window"));
        }
        let tx = self.transaction()?;
        let cutoff = at.saturating_sub(checkpoint_days * DAY);
        for mut run in rows(&tx, "SELECT metadata FROM learn_run", [], decode)? {
            let retained = rights.target(&run.target)
                && run
                    .session_ids
                    .iter()
                    .all(|id| rights.session(&run.target, id));
            if !retained {
                tx.execute("UPDATE learn_run SET invalidated=1 WHERE id=?", [&run.id])?;
                run.session_ids.clear();
                update_metadata(&tx, &run)?;
            }
            if !retained || run.started_at <= cutoff || is_terminal(&run) {
                drop_checkpoints(&tx, &run.id)?;
            }
        }
        findings::reconcile(&tx, at, rights)?;
        tx.commit()?;
        self.compact()
    }

    /// Compare the target's current UTC day against the failure limit.
    pub fn breaker_open(&self, target: &Target, at: i64) -> R<bool> {
        let start = at.div_euclid(DAY) * DAY;
        let count: i64 = self.db.conn().query_row(
            "SELECT count(*) FROM learn_failure f JOIN learn_run r ON r.id=f.run_id WHERE r.owner=? AND r.target_hash=? AND f.at>=? AND f.at<=?",
            params![target.owner,target_hash(target),start,at], |row| row.get(0))?;
        Ok(count >= FAILURE_CAP)
    }

    /// Summarize integrity, pending counts and open breakers.
    pub fn health(&self, at: i64) -> R<Health> {
        let cx = self.db.conn();
        let schema = cx.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let quick = rows(cx, "PRAGMA quick_check", [], |row| row.get::<_, String>(0))?;
        let (pending, waiting_h3) = cx.query_row(
            "SELECT coalesce(sum(state='pending'),0),coalesce(sum(state='waiting-h3'),0) FROM learn_finding", [],
            |row| Ok((row.get(0)?,row.get(1)?)))?;
        let breakers = cx.query_row("SELECT count(*) FROM (SELECT r.target_hash FROM learn_failure f
            JOIN learn_run r ON r.id=f.run_id WHERE f.at>=? AND f.at<=? GROUP BY r.target_hash HAVING count(*)>=?)",
            params![at.div_euclid(DAY)*DAY,at,FAILURE_CAP], |row| row.get(0))?;
        Ok(Health {
            schema,
            integrity: quick.iter().all(|s| s == "ok"),
            pending,
            waiting_h3,
            breakers,
        })
    }
}

fn finish_on(
    conn: &Connection,
    run: &Run,
    outcome: Outcome,
    reason: Option<&str>,
    at: i64,
) -> R<Run> {
    let mut closed = active_run(conn, run)?;
    if is_invalidated(conn, &run.id)?
        && !(outcome == Outcome::Skipped && reason == Some("rights-changed"))
    {
        return Err(denied());
    }
    if !(closed.started_at..=super::SAFE_INTEGER).contains(&at)
        || (outcome == Outcome::Completed) != reason.is_none()
        || reason.is_some_and(|r| {
            !matches!(
                r,
                "transcript-cap"
                    | "disabled"
                    | "no-sessions"
                    | "budget"
                    | "breaker-open"
                    | "no-model"
                    | "local-only"
                    | "source-unavailable"
                    | "invalid-output"
                    | "provider-failed"
                    | "rights-changed"
                    | "interrupted"
            )
        })
    {
        return Err(invalid("invalid learning disposition"));
    }
    closed.outcome = Some(outcome);
    closed.reason = reason.map(str::to_owned);
    closed.finished_at = Some(at);
    update_metadata(conn, &closed)?;
    if is_terminal(&closed) {
        drop_checkpoints(conn, &closed.id)?;
    }
    if outcome == Outcome::Failed {
        conn.execute(
            "INSERT INTO learn_failure VALUES(?,?)",
            params![closed.id, at],
        )?;
    }
    Ok(closed)
}

#[cfg(test)]
#[path = "store_vectors.rs"]
mod vectors;
