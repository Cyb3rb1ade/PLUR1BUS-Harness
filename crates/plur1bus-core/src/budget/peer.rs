//! `budget/peer.ts`: content-free, persistent reservations for outbound A2A traffic, kept in the budget database so that a
//! reconnect or restart cannot reset a turn's peer limits. A call reserves its token bound before it goes out
//! ([`PeerCallBudget::reserve`]), settles what the peer accepted ([`PeerCallBudget::finish`]) and is refunded only when it is
//! proven not to have reached the wire ([`PeerCallBudget::cancel`]).
//!
//! Two tables beside the ledger, created on open like the TypeScript constructor does (an additive extension: no change to
//! `usage_event` or to its schema version). Per-call rows are dropped after 30 days; their sums move into
//! `a2a_peer_turn_total` first, so a replay cannot reset a turn's ceilings, and an orphaned reservation keeps its whole bound.
use super::store::{self, OpenOptions};
use super::{count, input, BudgetError, Clock, IdSource};
use plur1bus_store::rusqlite::{params, Connection, OptionalExtension};
use plur1bus_store::Store;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

const CALL_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// The two tables, as the TypeScript constructor creates them.
const PEER_TABLES: &str = r#"CREATE TABLE IF NOT EXISTS a2a_peer_call (
      id TEXT PRIMARY KEY, person TEXT NOT NULL, agent TEXT NOT NULL,
      session TEXT NOT NULL, turn TEXT NOT NULL, peer TEXT NOT NULL,
      tokens INTEGER NOT NULL CHECK(tokens >= 0), capacity INTEGER NOT NULL CHECK(capacity >= tokens),
      state TEXT NOT NULL CHECK(state IN ('reserved','spent','cancelled')), ts INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS a2a_peer_call_turn ON a2a_peer_call(person,session,turn);
    CREATE INDEX IF NOT EXISTS a2a_peer_call_ts ON a2a_peer_call(ts);
    CREATE TABLE IF NOT EXISTS a2a_peer_turn_total (
      person TEXT NOT NULL, session TEXT NOT NULL, turn TEXT NOT NULL, peer TEXT NOT NULL,
      calls INTEGER NOT NULL CHECK(calls >= 0), tokens INTEGER NOT NULL CHECK(tokens >= 0),
      PRIMARY KEY(person,session,turn,peer)
    );"#;

/// `PeerBudgetIdentity`: five identifiers, none empty, none longer than 512 UTF-16 units.
#[derive(Clone, Copy, Debug)]
pub struct PeerBudgetIdentity<'a> {
    /// The person.
    pub person: &'a str,
    /// The agent.
    pub agent: &'a str,
    /// The session.
    pub session: &'a str,
    /// The turn.
    pub turn: &'a str,
    /// The peer.
    pub peer: &'a str,
}

/// `PeerBudgetLimits`.
#[derive(Clone, Copy, Debug)]
pub struct PeerBudgetLimits {
    /// Calls to one peer in a turn.
    pub peer_calls: i64,
    /// Calls to all peers in a turn.
    pub turn_calls: i64,
    /// Tokens to one peer in a turn.
    pub peer_tokens: i64,
    /// Tokens to all peers in a turn.
    pub turn_tokens: i64,
}

/// `PeerBudgetDecision`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PeerBudgetDecision {
    /// Reserved; the id to finish or cancel.
    Allow(String),
    /// Over a ceiling; nothing was reserved.
    Refuse,
}

fn invalid() -> BudgetError {
    input("invalid peer budget input")
}

fn valid_text(v: &str) -> bool {
    !v.is_empty() && v.encode_utf16().count() <= 512
}

/// `PeerCallBudget`.
pub struct PeerCallBudget {
    store: Mutex<Store>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn IdSource>,
}

/// Drops per-call metadata after 30 days; the durable totals keep a replay from resetting a turn's ceilings.
fn compact(conn: &Connection, now: i64) -> Result<(), BudgetError> {
    let cutoff = now - CALL_RETENTION_MS;
    conn.execute(
        "INSERT INTO a2a_peer_turn_total(person,session,turn,peer,calls,tokens)
      SELECT person,session,turn,peer,COUNT(*),SUM(tokens) FROM a2a_peer_call
      WHERE ts<? AND state<>'cancelled' GROUP BY person,session,turn,peer
      ON CONFLICT(person,session,turn,peer) DO UPDATE SET
        calls=calls+excluded.calls,tokens=tokens+excluded.tokens",
        [cutoff],
    )?;
    // An orphan reservation retains its entire bound. No successful wire call can be refunded by aging out.
    conn.execute("DELETE FROM a2a_peer_call WHERE ts<?", [cutoff])?;
    Ok(())
}

impl PeerCallBudget {
    /// `new PeerCallBudget({ path, now })`.
    pub fn open(
        path: &Path,
        clock: Arc<dyn Clock>,
        ids: Arc<dyn IdSource>,
    ) -> Result<Self, BudgetError> {
        let mut store = store::open(path, &OpenOptions::default())?;
        store.conn().execute_batch(PEER_TABLES)?;
        let now = clock.now();
        store.write_with(|tx| compact(tx, now))?;
        Ok(Self {
            store: Mutex::new(store),
            clock,
            ids,
        })
    }

    fn lock(&self) -> MutexGuard<'_, Store> {
        self.store
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `reserve`: refuses (without reserving) when any of the four ceilings would be passed.
    pub fn reserve(
        &self,
        who: &PeerBudgetIdentity<'_>,
        tokens: i64,
        limits: &PeerBudgetLimits,
    ) -> Result<PeerBudgetDecision, BudgetError> {
        let texts = [who.person, who.agent, who.session, who.turn, who.peer];
        if !texts.iter().all(|t| valid_text(t))
            || count("tokens", tokens).is_err()
            || [
                limits.peer_calls,
                limits.turn_calls,
                limits.peer_tokens,
                limits.turn_tokens,
            ]
            .iter()
            .any(|v| count("limit", *v).is_err())
        {
            return Err(invalid());
        }
        let now = self.clock.now();
        self.lock().write_with(|tx| {
            compact(tx, now)?;
            let mut st = tx.prepare(
                "SELECT peer,SUM(calls) AS calls,SUM(tokens) AS tokens FROM (
        SELECT peer,COUNT(*) AS calls,SUM(tokens) AS tokens FROM a2a_peer_call
        WHERE person=? AND session=? AND turn=? AND state<>'cancelled' GROUP BY peer
        UNION ALL SELECT peer,calls,tokens FROM a2a_peer_turn_total WHERE person=? AND session=? AND turn=?
      ) GROUP BY peer",
            )?;
            let rows: Vec<(String, i64, i64)> = st
                .query_map(
                    params![who.person, who.session, who.turn, who.person, who.session, who.turn],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?
                .collect::<Result<_, _>>()?;
            drop(st);
            let peer = rows.iter().find(|r| r.0 == who.peer);
            let (peer_calls, peer_tokens) = peer.map_or((0, 0), |p| (p.1, p.2));
            let turn_calls: i64 = rows.iter().map(|r| r.1).sum();
            let turn_tokens: i64 = rows.iter().map(|r| r.2).sum();
            if peer_calls >= limits.peer_calls
                || turn_calls >= limits.turn_calls
                || peer_tokens + tokens > limits.peer_tokens
                || turn_tokens + tokens > limits.turn_tokens
            {
                return Ok(PeerBudgetDecision::Refuse);
            }
            let id = self.ids.next_id();
            tx.execute(
                "INSERT INTO a2a_peer_call VALUES(?,?,?,?,?,?,?,?,?,?)",
                params![id, who.person, who.agent, who.session, who.turn, who.peer, tokens, tokens, "reserved", now],
            )?;
            Ok::<_, BudgetError>(PeerBudgetDecision::Allow(id))
        })
    }

    /// `finish`: settles the tokens the peer accepted, at most what was reserved; settling again with the same count is a no-op.
    pub fn finish(&self, id: &str, tokens: i64) -> Result<(), BudgetError> {
        count("tokens", tokens).map_err(|_| invalid())?;
        self.lock().write_with(|tx| {
            let row: Option<(i64, i64, String)> = tx
                .query_row("SELECT capacity,tokens,state FROM a2a_peer_call WHERE id=?", [id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .optional()?;
            match row {
                Some((capacity, spent, state))
                    if tokens <= capacity && state != "cancelled" && !(state == "spent" && tokens != spent) =>
                {
                    tx.execute("UPDATE a2a_peer_call SET tokens=?,state='spent' WHERE id=? AND state='reserved'", params![tokens, id])?;
                    Ok(())
                }
                _ => Err(invalid()),
            }
        })
    }

    /// `cancel`: only for a request proved not to have reached the wire.
    pub fn cancel(&self, id: &str) -> Result<(), BudgetError> {
        self.lock().write_with(|tx| {
            tx.execute(
                "UPDATE a2a_peer_call SET state='cancelled' WHERE id=? AND state='reserved'",
                [id],
            )?;
            Ok::<_, BudgetError>(())
        })
    }
}
