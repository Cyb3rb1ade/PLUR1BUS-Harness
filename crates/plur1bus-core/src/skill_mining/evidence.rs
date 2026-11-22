//! Minimal successful tool execution evidence, separate from transcript content.

use super::{open_ledger, text_id, tool_name, tool_version, Scope, R};
use crate::collab::{CollabError, CollabErrorCode};
use plur1bus_store::rusqlite::params;
use plur1bus_store::Store as SqliteStore;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Opaque identity of one dispatcher execution.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    /// Stored owner identity.
    pub owner: String,
    /// Agent under whose authority the tool ran.
    pub agent_id: String,
    /// Session that requested this execution.
    pub session_id: String,
    /// Turn that requested this execution.
    pub turn_id: String,
    /// Exact invocation identity.
    pub call_id: String,
    /// Registered tool.
    pub tool: String,
    /// Immutable version of that tool.
    pub version: String,
    /// Dispatcher-confirmed outcome.
    pub success: bool,
}

/// Evidence result for a specific tool invocation under its original scope.
pub trait Proof {
    /// Whether this call succeeded under the exact owner, agent, turn and tool version.
    fn verified(&self, scope: &Scope, proof: &Execution) -> R<bool>;
}

const DDL: &str = "CREATE TABLE IF NOT EXISTS mining_executions(owner TEXT NOT NULL, agent TEXT NOT NULL, session TEXT NOT NULL, turn TEXT NOT NULL, call TEXT NOT NULL, tool TEXT NOT NULL, version TEXT NOT NULL, success INTEGER NOT NULL, PRIMARY KEY(session,turn,call))";

/// SQLite evidence ledger owned by the trusted dispatcher.
pub struct Store {
    db: SqliteStore,
}

fn valid(e: &Execution) -> bool {
    [&e.owner, &e.agent_id, &e.session_id, &e.turn_id, &e.call_id]
        .into_iter()
        .all(|v| text_id(v, 256))
        && tool_name(&e.tool)
        && tool_version(&e.version)
}

impl Store {
    #[cfg(test)]
    pub(crate) fn into_test_store(self) -> SqliteStore {
        self.db
    }

    /// Open the private workflow evidence ledger.
    pub fn open(path: &Path) -> R<Self> {
        Self::open_file(path, None)
    }

    /// Open using the host's owner-only file check.
    pub fn open_with_permissions(path: &Path, secure: &dyn Fn(&Path) -> bool) -> R<Self> {
        Self::open_file(path, Some(secure))
    }

    fn open_file(path: &Path, secure: Option<&dyn Fn(&Path) -> bool>) -> R<Self> {
        Ok(Self {
            db: open_ledger(path, "workflow evidence", DDL, secure)?,
        })
    }

    /// Persist a finalized dispatcher result, without arguments or content.
    pub fn record(&self, e: &Execution) -> R<()> {
        if !valid(e) {
            return Err(CollabError::new(
                CollabErrorCode::Invalid,
                "invalid dispatcher evidence",
            ));
        }
        let tx = plur1bus_store::begin_immediate(self.db.conn())?;
        let changed=tx.execute("INSERT OR IGNORE INTO mining_executions(owner,agent,session,turn,call,tool,version,success)
            VALUES(?,?,?,?,?,?,?,?)",params![e.owner,e.agent_id,e.session_id,e.turn_id,e.call_id,e.tool,e.version,e.success])?;
        if changed == 0 {
            let same:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM mining_executions WHERE owner=? AND agent=? AND session=?
                AND turn=? AND call=? AND tool=? AND version=? AND success=?)",
                params![e.owner,e.agent_id,e.session_id,e.turn_id,e.call_id,e.tool,e.version,e.success],|row|row.get(0))?;
            if !same {
                return Err(CollabError::with_reason(
                    CollabErrorCode::Conflict,
                    "dispatcher evidence is already finalized",
                    "evidence-changed",
                ));
            }
        }
        tx.commit()?;
        Ok(())
    }
}

impl Proof for Store {
    fn verified(&self, scope: &Scope, e: &Execution) -> R<bool> {
        if !valid(e)
            || !super::valid_scope(scope)
            || e.owner != scope.owner
            || e.agent_id != scope.agent_id
        {
            return Ok(false);
        }
        Ok(self.db.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM mining_executions WHERE owner=? AND agent=? AND session=?
            AND turn=? AND call=? AND tool=? AND version=? AND success=1)",
            params![
                scope.owner,
                scope.agent_id,
                e.session_id,
                e.turn_id,
                e.call_id,
                e.tool,
                e.version
            ],
            |row| row.get(0),
        )?)
    }
}

#[cfg(test)]
#[path = "evidence_vectors.rs"]
mod vectors;
