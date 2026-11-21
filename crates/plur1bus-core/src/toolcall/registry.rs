//! The persistent capability registry (`toolcall/sqlite-registry.ts`): `state/capabilities.sqlite`, the store behind
//! the live index. It keeps every registered entry as its JSON text, a full-text index over the entries' search text,
//! per-agent usage counters (in total and per hour, for decay), a hash per entry, and at most one local embedding vector
//! per entry.
//!
//! The file is the TypeScript core's file: the same tables with the same schema text, no `user_version` (the tables are
//! created in place on every open), write-ahead logging, `synchronous = NORMAL`. The entry text is
//! `JSON.stringify(entry)` in the entry's own member order, a vector is `JSON.stringify(number[])`, and the hash is the
//! SHA-256 of the entry's canonical JSON; a file one side wrote is read and continued by the other
//! (`fixtures/parity/capabilities/registry.json`, and mode B in `tests/toolcall_mode_b.rs`).
use super::capabilities::{word_runs, CapabilityEntry, CapabilityStats};
use super::json::{parse, V};
use super::math::js_pow2;
use super::validation::Thrown;
use crate::budget::Clock;
use plur1bus_store::rusqlite::{params, Connection, OptionalExtension};
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreSpec, Synchronous};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

/// What the constructor runs, statement for statement the TypeScript text: SQLite keeps a `CREATE` statement as written,
/// and `sqlite_master` of a file made here must equal one made there.
pub const TABLES: &str = "CREATE TABLE IF NOT EXISTS capability_index (id TEXT PRIMARY KEY, version TEXT NOT NULL, entry TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capability_stats (id TEXT NOT NULL, agent TEXT NOT NULL, offered INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, searched INTEGER NOT NULL DEFAULT 0, succeeded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (id, agent));
      CREATE TABLE IF NOT EXISTS capability_usage (id TEXT NOT NULL, agent TEXT NOT NULL, bucket INTEGER NOT NULL, offered INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, searched INTEGER NOT NULL DEFAULT 0, succeeded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(id,agent,bucket));
      CREATE TABLE IF NOT EXISTS capability_hashes (id TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS capability_fts USING fts5(id UNINDEXED, text);
      CREATE TABLE IF NOT EXISTS capability_vectors (id TEXT PRIMARY KEY, hash TEXT NOT NULL, model TEXT NOT NULL, vector TEXT NOT NULL);";

/// Why the registry refused or failed.
#[derive(Debug)]
pub enum RegistryError {
    /// A refusal with TypeScript's message (an invalid entry, an unknown statistic, a bad limit, a row that is not JSON).
    Refused(Thrown),
    /// SQLite's error.
    Store(String),
}

impl From<Thrown> for RegistryError {
    fn from(e: Thrown) -> Self {
        RegistryError::Refused(e)
    }
}

impl From<plur1bus_store::rusqlite::Error> for RegistryError {
    fn from(e: plur1bus_store::rusqlite::Error) -> Self {
        RegistryError::Store(e.to_string())
    }
}

impl From<plur1bus_store::StoreError> for RegistryError {
    fn from(e: plur1bus_store::StoreError) -> Self {
        RegistryError::Store(e.to_string())
    }
}

/// What a subscriber is told (`RegistrationPort.subscribe`).
#[derive(Clone, Debug)]
pub enum RegistryEvent {
    /// An entry was registered or changed.
    Upsert(CapabilityEntry),
    /// An entry was removed.
    Remove(String),
}

/// A subscriber.
pub type Subscriber = Box<dyn FnMut(&RegistryEvent)>;

/// `SqliteCapabilityRegistry`. The owner chooses the file; no path and no timer is implicit.
pub struct SqliteCapabilityRegistry {
    db: Store,
    clock: Arc<dyn Clock>,
    subscribers: Vec<(u64, Subscriber)>,
    next_subscriber: u64,
}

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: f64 = 86_400_000.0;

/// `canonicalJson` of the dispatcher: members sorted by code unit at every depth, no white space.
fn canonical_json(v: &V, out: &mut String) {
    match v {
        V::Arr(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical_json(x, out);
            }
            out.push(']');
        }
        V::Obj(o) => {
            let mut members: Vec<_> = o.entries().iter().collect();
            members.sort_by(|a, b| a.0.cmp(&b.0));
            out.push('{');
            for (i, (k, x)) in members.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&V::Str(k.clone()).stringify());
                out.push(':');
                canonical_json(x, out);
            }
            out.push('}');
        }
        other => out.push_str(&other.stringify()),
    }
}

/// `a !== b` for two members that may be absent.
fn differs(a: Option<&V>, b: Option<&V>) -> bool {
    match (a, b) {
        (None, None) | (Some(V::Null), Some(V::Null)) => false,
        (Some(V::Bool(x)), Some(V::Bool(y))) => x != y,
        (Some(V::Num(x)), Some(V::Num(y))) => x != y,
        (Some(V::Str(x)), Some(V::Str(y))) => x != y,
        _ => true,
    }
}

fn refuse(message: &str) -> RegistryError {
    RegistryError::Refused(Thrown::error(message))
}

fn read_entry(text: &str) -> Result<V, RegistryError> {
    parse(text).ok_or_else(|| RegistryError::Refused(Thrown::syntax()))
}

/// The column of an event; only the four names are statistics, whatever else a caller passes.
fn column(event: &str) -> Option<&'static str> {
    match event {
        "offered" => Some("offered"),
        "used" => Some("used"),
        "foundBySearch" => Some("searched"),
        "succeeded" => Some("succeeded"),
        _ => None,
    }
}

impl SqliteCapabilityRegistry {
    /// Opens (and creates) the registry at `path`: write-ahead logging and `synchronous = NORMAL` (a turn's first view
    /// of an agent registers every tool in a transaction of its own; with the rollback journal each commit waited for
    /// the disk), the tables, and the search rows of entries an older registry left without them.
    pub fn open(path: &Path, clock: Arc<dyn Clock>) -> Result<Self, RegistryError> {
        let owner = OwnerSpec {
            store: StoreSpec {
                synchronous: Synchronous::Normal,
                ..StoreSpec::new("capabilities", 0)
            },
            journal: Journal::Wal,
            schema: Schema::Unversioned,
            create: true,
        };
        let db = Store::open_owner(path, &owner)?;
        db.conn().execute_batch(TABLES)?;
        let registry = SqliteCapabilityRegistry {
            db,
            clock,
            subscribers: Vec::new(),
            next_subscriber: 0,
        };
        for entry in registry.snapshot()? {
            Self::write_search(registry.db.conn(), &entry)?;
        }
        Ok(registry)
    }

    /// `subscribe`: `subscriber` is told of every change from now on; the number unsubscribes it.
    pub fn subscribe(&mut self, subscriber: Subscriber) -> u64 {
        self.next_subscriber += 1;
        self.subscribers.push((self.next_subscriber, subscriber));
        self.next_subscriber
    }

    /// Ends a subscription.
    pub fn unsubscribe(&mut self, id: u64) {
        self.subscribers.retain(|(n, _)| *n != id);
    }

    fn tell(&mut self, event: &RegistryEvent) {
        for (_, subscriber) in &mut self.subscribers {
            subscriber(event);
        }
    }

    /// `snapshot`: every entry, ordered by id, as the object that was stored.
    pub fn snapshot(&self) -> Result<Vec<V>, RegistryError> {
        let mut statement = self
            .db
            .conn()
            .prepare("SELECT entry FROM capability_index ORDER BY id")?;
        let texts: Vec<String> = statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        texts.iter().map(|text| read_entry(text)).collect()
    }

    /// `upsert`: validates as the library index does, then writes entry, search text and hash in one transaction. An
    /// entry whose text did not change writes nothing and tells nobody; a new version forgets the old one's statistics.
    pub fn upsert(&mut self, entry: &V) -> Result<(), RegistryError> {
        let checked = CapabilityEntry::new(entry)?;
        let (id, text) = (checked.id(), checked.text());
        let old: Option<String> = self
            .db
            .conn()
            .query_row(
                "SELECT entry FROM capability_index WHERE id = ?",
                [&id],
                |row| row.get(0),
            )
            .optional()?;
        if old.as_deref() == Some(text.as_str()) {
            return Ok(());
        }
        self.db.write_with(|tx| -> Result<(), RegistryError> {
            tx.execute(
                "INSERT INTO capability_index (id,version,entry) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,entry=excluded.entry",
                params![id, checked.version(), text],
            )?;
            if let Some(old) = &old {
                if differs(read_entry(old)?.get("version"), entry.get("version")) {
                    for table in ["capability_stats", "capability_usage"] {
                        tx.execute(&format!("DELETE FROM {table} WHERE id=?"), [&id])?;
                    }
                }
            }
            Self::write_search(tx, entry)
        })?;
        self.tell(&RegistryEvent::Upsert(checked));
        Ok(())
    }

    /// `remove`: the entry and everything kept about it.
    pub fn remove(&mut self, id: &str) -> Result<(), RegistryError> {
        let conn = self.db.conn();
        let removed = conn.execute("DELETE FROM capability_index WHERE id = ?", [id])?;
        conn.execute("DELETE FROM capability_fts WHERE id=?", [id])?;
        for table in [
            "capability_hashes",
            "capability_vectors",
            "capability_stats",
            "capability_usage",
        ] {
            conn.execute(&format!("DELETE FROM {table} WHERE id=?"), [id])?;
        }
        if removed > 0 {
            self.tell(&RegistryEvent::Remove(id.to_owned()));
        }
        Ok(())
    }

    /// `record`: one more `offered`, `used`, `foundBySearch` or `succeeded` for a registered entry and an agent, in the
    /// total and in the current hour's bucket.
    pub fn record(&mut self, id: &str, agent: &str, event: &str) -> Result<(), RegistryError> {
        let column = column(event).ok_or_else(|| refuse("unknown capability statistic"))?;
        let conn = self.db.conn();
        let known: Option<String> = conn
            .query_row("SELECT id FROM capability_index WHERE id=?", [id], |row| {
                row.get(0)
            })
            .optional()?;
        if known.is_none() {
            return Err(refuse("unknown capability"));
        }
        conn.execute(
            &format!("INSERT INTO capability_stats(id,agent,{column}) VALUES(?,?,1) ON CONFLICT(id,agent) DO UPDATE SET {column}={column}+1"),
            params![id, agent],
        )?;
        let bucket = self.clock.now().div_euclid(HOUR_MS) * HOUR_MS;
        conn.execute(
            &format!("INSERT INTO capability_usage(id,agent,bucket,{column}) VALUES(?,?,?,1) ON CONFLICT(id,agent,bucket) DO UPDATE SET {column}={column}+1"),
            params![id, agent, bucket],
        )?;
        Ok(())
    }

    /// `weightedStats`: the hourly counters of every entry with this entry's name, kind and version (the same tool in
    /// another scope counts), each weighted by `2 ** (-age / half-life)`; for one agent or, with `None`, for all.
    pub fn weighted_stats(
        &self,
        id: &str,
        agent: Option<&str>,
        half_life_days: f64,
        now: Option<f64>,
    ) -> Result<CapabilityStats, RegistryError> {
        let now = now.unwrap_or(self.clock.now() as f64);
        if !half_life_days.is_finite() || half_life_days <= 0.0 || !now.is_finite() {
            return Err(refuse("invalid decay window"));
        }
        let mut sql = "SELECT u.bucket,u.offered,u.used,u.searched,u.succeeded FROM capability_usage u JOIN capability_index i ON i.id=u.id
      WHERE json_extract(i.entry, '$.name')=(SELECT json_extract(entry, '$.name') FROM capability_index WHERE id=?1)
      AND json_extract(i.entry, '$.kind')=(SELECT json_extract(entry, '$.kind') FROM capability_index WHERE id=?1)
      AND json_extract(i.entry, '$.version')=(SELECT json_extract(entry, '$.version') FROM capability_index WHERE id=?1)"
            .to_owned();
        if agent.is_some() {
            sql.push_str(" AND u.agent=?2");
        }
        let mut statement = self.db.conn().prepare(&sql)?;
        let read = |row: &plur1bus_store::rusqlite::Row<'_>| -> plur1bus_store::rusqlite::Result<[i64; 5]> {
            Ok([row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?])
        };
        let rows: Vec<[i64; 5]> = match agent {
            Some(agent) => statement
                .query_map(params![id, agent], read)?
                .collect::<Result<_, _>>()?,
            None => statement
                .query_map(params![id], read)?
                .collect::<Result<_, _>>()?,
        };
        let mut total = CapabilityStats::default();
        for [bucket, offered, used, searched, succeeded] in rows {
            let age = (now - bucket as f64).max(0.0);
            let weight = js_pow2(-age / (half_life_days * DAY_MS));
            total.offered += offered as f64 * weight;
            total.used += used as f64 * weight;
            total.found_by_search += searched as f64 * weight;
            total.succeeded += succeeded as f64 * weight;
        }
        Ok(total)
    }

    /// `agents`: every agent with an hourly counter, sorted.
    pub fn agents(&self) -> Result<Vec<String>, RegistryError> {
        let mut statement = self
            .db
            .conn()
            .prepare("SELECT DISTINCT agent FROM capability_usage ORDER BY agent")?;
        let agents = statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(agents)
    }

    /// `stats`: the total counters of one entry and one agent.
    pub fn stats(&self, id: &str, agent: &str) -> Result<CapabilityStats, RegistryError> {
        let row: Option<[i64; 4]> = self
            .db
            .conn()
            .query_row("SELECT offered,used,searched,succeeded FROM capability_stats WHERE id=? AND agent=?", params![id, agent], |row| {
                Ok([row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?])
            })
            .optional()?;
        let [offered, used, searched, succeeded] = row.unwrap_or_default();
        Ok(CapabilityStats {
            offered: offered as f64,
            used: used as f64,
            found_by_search: searched as f64,
            succeeded: succeeded as f64,
        })
    }

    /// Writes search text and hash of an entry unless its hash is already the stored one; a changed entry loses its
    /// vector, which was computed from the old text.
    fn write_search(conn: &Connection, entry: &V) -> Result<(), RegistryError> {
        let mut canonical = String::new();
        canonical_json(entry, &mut canonical);
        let hash: String = Sha256::digest(canonical.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let id = entry
            .get("id")
            .map(|id| id.to_js_string().lossy())
            .unwrap_or_default();
        if Self::hash_of(conn, &id)?.as_deref() == Some(hash.as_str()) {
            return Ok(());
        }
        let text: Vec<String> = ["name", "description", "category", "useWhen", "inputs"]
            .iter()
            .filter_map(|key| {
                entry
                    .get(key)
                    .filter(|v| v.truthy())
                    .map(|v| v.to_js_string().lossy())
            })
            .collect();
        conn.execute("DELETE FROM capability_fts WHERE id=?", [&id])?;
        conn.execute(
            "INSERT INTO capability_fts(id,text) VALUES(?,?)",
            params![id, text.join(" ")],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO capability_hashes(id,hash) VALUES(?,?)",
            params![id, hash],
        )?;
        conn.execute("DELETE FROM capability_vectors WHERE id=?", [&id])?;
        Ok(())
    }

    fn hash_of(conn: &Connection, id: &str) -> Result<Option<String>, RegistryError> {
        Ok(conn
            .query_row(
                "SELECT hash FROM capability_hashes WHERE id=?",
                [id],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// `hash`: the stored hash of an entry.
    pub fn hash(&self, id: &str) -> Result<Option<String>, RegistryError> {
        Self::hash_of(self.db.conn(), id)
    }

    /// `search`: the entries among `allowed` that the full-text index finds for the words of `query`, best first. Only
    /// bound literal terms reach the index: at most 64 word runs of the first 4096 code units, each quoted, joined by
    /// `OR`; no operator a caller writes is one.
    pub fn search(
        &self,
        query: &str,
        allowed: &HashSet<String>,
        limit: f64,
    ) -> Result<Vec<V>, RegistryError> {
        if !limit.is_finite() || limit.fract() != 0.0 || !(0.0..=128.0).contains(&limit) {
            return Err(refuse("search limit must be 0..128"));
        }
        let units: Vec<u16> = query.encode_utf16().take(4096).collect();
        let terms: Vec<String> = word_runs(&units)
            .into_iter()
            .take(64)
            .map(|term| format!("\"{term}\""))
            .collect();
        if terms.is_empty() || limit == 0.0 {
            return Ok(Vec::new());
        }
        let mut statement = self
            .db
            .conn()
            .prepare("SELECT i.id,i.entry FROM capability_fts f JOIN capability_index i ON i.id=f.id WHERE capability_fts MATCH ? ORDER BY bm25(capability_fts),i.id")?;
        let found: Vec<(String, String)> = statement
            .query_map([terms.join(" OR ")], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        found
            .iter()
            .filter(|(id, _)| allowed.contains(id))
            .take(limit as usize)
            .map(|(_, entry)| read_entry(entry))
            .collect()
    }

    /// `putVector`: stores the vector a local model computed for the entry as it is now. `false` when `hash` is not the
    /// entry's current hash (the entry changed while the vector was computed). The storage layer has no network client.
    pub fn put_vector(
        &mut self,
        id: &str,
        hash: &str,
        model: &str,
        vector: &[f64],
    ) -> Result<bool, RegistryError> {
        if model.is_empty()
            || vector.is_empty()
            || vector.len() > 16384
            || vector.iter().any(|v| !v.is_finite())
        {
            return Err(refuse("invalid local vector"));
        }
        if self.hash(id)?.as_deref() != Some(hash) {
            return Ok(false);
        }
        let text = V::Arr(vector.iter().map(|v| V::Num(*v)).collect()).stringify();
        self.db.conn().execute(
            "INSERT OR REPLACE INTO capability_vectors(id,hash,model,vector) VALUES(?,?,?,?)",
            params![id, hash, model, text],
        )?;
        Ok(true)
    }

    /// `vector`: the stored vector of an entry for `model`, if it was computed for the entry's current text.
    pub fn vector(&self, id: &str, model: &str) -> Result<Option<Vec<f64>>, RegistryError> {
        let hash = self.hash(id)?.unwrap_or_default();
        let text: Option<String> = self
            .db
            .conn()
            .query_row(
                "SELECT vector FROM capability_vectors WHERE id=? AND model=? AND hash=?",
                params![id, model, hash],
                |row| row.get(0),
            )
            .optional()?;
        let Some(text) = text else {
            return Ok(None);
        };
        let list = read_entry(&text)?;
        Ok(Some(
            list.as_arr()
                .unwrap_or(&[])
                .iter()
                .map(|n| n.as_f64().unwrap_or(f64::NAN))
                .collect(),
        ))
    }
}
