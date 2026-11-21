//! `InboxStore` (`inbox/store.ts`), statement by statement. Every mutation is one `BEGIN IMMEDIATE` transaction, so a crash
//! leaves the old or the new state.
use super::{
    Ids, InboxCounts, InboxDraft, InboxEntry, InboxError, InboxListQuery, InboxPage, InboxRef,
    Published, DEFAULT_MAX_AGE_MS, DEFAULT_MAX_ENTRIES, DEFAULT_PAGE, INBOX_KINDS,
    INBOX_SEVERITIES, MAX_IDS, MAX_PAGE,
};
use crate::budget::{Clock, IdSource, UuidIds};
use crate::delivery::policy::js_number_string;
use crate::js::json_stringify;
use crate::private_store;
use base64::Engine;
use plur1bus_store::rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreSpec, Synchronous};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

/// What the constructor runs after `PRAGMA busy_timeout=5000`: the TypeScript text byte for byte, because SQLite keeps a
/// `CREATE` statement as written and `sqlite_master` of a file made here must equal one made there.
pub const TABLES: &str = r#"      CREATE TABLE IF NOT EXISTS inbox_entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, dedupe_key TEXT NOT NULL,
        kind TEXT NOT NULL, severity TEXT NOT NULL, title_key TEXT NOT NULL, params TEXT NOT NULL, ref TEXT,
        created_at INTEGER NOT NULL, read_at INTEGER, dismissed_at INTEGER, UNIQUE(user_id, dedupe_key)) STRICT;
      CREATE TABLE IF NOT EXISTS inbox_cooldowns (
        user_id TEXT NOT NULL, cause TEXT NOT NULL, published_at INTEGER NOT NULL, entry_id TEXT NOT NULL,
        PRIMARY KEY(user_id, cause)) STRICT;
      CREATE INDEX IF NOT EXISTS inbox_by_user ON inbox_entries(user_id, seq DESC);"#;

/// `InboxStoreOptions`. `max_age_ms` and `max_entries` are JavaScript numbers: a fraction is refused like a number below one.
pub struct InboxStoreOptions {
    /// The database file.
    pub path: PathBuf,
    /// The clock.
    pub clock: Arc<dyn Clock>,
    /// Retention by age (default 90 days).
    pub max_age_ms: Option<f64>,
    /// Retention by count per person (default 1000).
    pub max_entries: Option<f64>,
    /// Entry ids (`idGen`, default `randomUUID`).
    pub ids: Option<Arc<dyn IdSource>>,
    /// The platform's owner-only hook; `None` applies mode 0600 on Unix and refuses elsewhere.
    pub secure_path: Option<crate::delivery::SecurePath>,
}

/// `Number.isInteger`.
fn is_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

/// `Number.isSafeInteger`.
fn is_safe_integer(x: f64) -> bool {
    is_integer(x) && x.abs() <= 9_007_199_254_740_991.0
}

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `/^[a-z][A-Za-z0-9._-]{0,95}$/`.
fn title_key_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 96
        && b[0].is_ascii_lowercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// `/^[A-Za-z][A-Za-z0-9_]{0,31}$/`.
fn param_key_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_alphabetic()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

fn validate(d: &InboxDraft) -> Result<(), InboxError> {
    if d.user_id.is_empty() || units(&d.user_id) > 128 {
        return Err(InboxError::invalid("userId is required"));
    }
    if !INBOX_KINDS.contains(&d.kind.as_str()) {
        return Err(InboxError::invalid("unknown inbox kind"));
    }
    if !INBOX_SEVERITIES.contains(&d.severity.as_str()) {
        return Err(InboxError::invalid("unknown inbox severity"));
    }
    if !title_key_ok(&d.title_key) {
        return Err(InboxError::invalid("titleKey must be an i18n key"));
    }
    if d.dedupe_key.is_empty() || units(&d.dedupe_key) > 200 {
        return Err(InboxError::invalid("dedupeKey is required"));
    }
    if let Some(p) = &d.params {
        if p.len() > 16 {
            return Err(InboxError::invalid("too many params"));
        }
        for (k, v) in p {
            let scalar = match v {
                Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
                Value::Bool(_) => true,
                Value::String(s) => units(s) <= 200,
                _ => false,
            };
            if !param_key_ok(k) || !scalar {
                return Err(InboxError::invalid("params hold short scalars only"));
            }
        }
    }
    if let Some(r) = &d.reference {
        if let Some(route) = &r.route {
            if !route.starts_with('/') || units(route) > 200 {
                return Err(InboxError::invalid("ref.route must be an app route"));
            }
        }
        if let Some(o) = &r.object_id {
            if o.is_empty() || units(o) > 128 {
                return Err(InboxError::invalid("ref.objectId is invalid"));
            }
        }
    }
    Ok(())
}

/// `JSON.stringify(params ?? {})` for the values `validate` lets through (booleans, finite numbers, strings).
fn params_json(p: Option<&Vec<(String, Value)>>) -> String {
    let body: Vec<String> = p
        .map(|p| {
            p.iter()
                .map(|(k, v)| {
                    let v = match v {
                        Value::Bool(b) => b.to_string(),
                        Value::Number(n) => js_number_string(n.as_f64().unwrap_or(0.0)),
                        Value::String(s) => json_stringify(s),
                        _ => "null".into(),
                    };
                    format!("{}:{v}", json_stringify(k))
                })
                .collect()
        })
        .unwrap_or_default();
    format!("{{{}}}", body.join(","))
}

/// `JSON.stringify(ref)`: `route` before `objectId`.
fn ref_json(r: &InboxRef) -> String {
    let mut parts = Vec::new();
    if let Some(v) = &r.route {
        parts.push(format!("\"route\":{}", json_stringify(v)));
    }
    if let Some(v) = &r.object_id {
        parts.push(format!("\"objectId\":{}", json_stringify(v)));
    }
    format!("{{{}}}", parts.join(","))
}

/// `idList`: one to 500 non-empty ids of up to 64 units, each once.
fn id_list(ids: Ids<'_>) -> Result<Vec<String>, InboxError> {
    let msg = format!("ids must be 1-{MAX_IDS} entry ids");
    let Ids::List(list) = ids else {
        return Err(InboxError::Invalid(msg));
    };
    if list.is_empty() || list.len() > MAX_IDS || list.iter().any(|i| i.is_empty() || units(i) > 64)
    {
        return Err(InboxError::Invalid(msg));
    }
    let mut out: Vec<String> = Vec::new();
    for i in list {
        if !out.contains(i) {
            out.push(i.clone());
        }
    }
    Ok(out)
}

fn encode_cursor(seq: i64) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(seq.to_string())
}

/// `decodeCursor`: Node decodes `Buffer.from(c, "base64url")` leniently, so a cursor is read the same way: both alphabets are
/// accepted, a character outside them is skipped, `=` ends the input and the bits left over after the last whole byte are
/// dropped. The decoded text must then be one to fifteen ASCII digits.
pub fn decode_cursor(c: &str) -> Result<i64, InboxError> {
    let mut bytes: Vec<u8> = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for ch in c.chars() {
        let v = match ch {
            'A'..='Z' => ch as u32 - 'A' as u32,
            'a'..='z' => ch as u32 - 'a' as u32 + 26,
            '0'..='9' => ch as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            _ => continue,
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push(((acc >> bits) & 0xff) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    if bytes.is_empty() || bytes.len() > 15 || !bytes.iter().all(u8::is_ascii_digit) {
        return Err(InboxError::Cursor);
    }
    std::str::from_utf8(&bytes)
        .ok()
        .and_then(|s| s.parse().ok())
        .ok_or(InboxError::Cursor)
}

fn entry_of(r: &plur1bus_store::rusqlite::Row<'_>) -> Result<(i64, InboxEntry), InboxError> {
    let params: String = r.get("params")?;
    let reference: Option<String> = r.get("ref")?;
    let bad = || InboxError::Store("an inbox row does not parse".into());
    Ok((
        r.get("seq")?,
        InboxEntry {
            id: r.get("id")?,
            kind: r.get("kind")?,
            severity: r.get("severity")?,
            title_key: r.get("title_key")?,
            params: serde_json::from_str(&params).map_err(|_| bad())?,
            reference: match reference {
                None => None,
                Some(t) => Some(serde_json::from_str(&t).map_err(|_| bad())?),
            },
            created_at: r.get("created_at")?,
            read_at: r.get("read_at")?,
            dismissed_at: r.get("dismissed_at")?,
        },
    ))
}

/// The durable inbox of every person.
pub struct InboxStore {
    db: Store,
    retention: (i64, i64),
    clock: Arc<dyn Clock>,
    ids: Arc<dyn IdSource>,
}

fn prune(
    tx: &Connection,
    clock: &dyn Clock,
    retention: (i64, i64),
    user: &str,
) -> Result<(), InboxError> {
    tx.execute(
        "DELETE FROM inbox_entries WHERE user_id=? AND created_at < ?",
        params![user, clock.now() - retention.0],
    )?;
    tx.execute(
        "DELETE FROM inbox_entries WHERE user_id=? AND seq NOT IN (SELECT seq FROM inbox_entries WHERE user_id=? ORDER BY seq DESC LIMIT ?)",
        params![user, user, retention.1],
    )?;
    Ok(())
}

const INSERT: &str = "INSERT INTO inbox_entries(id,user_id,dedupe_key,kind,severity,title_key,params,ref,created_at) VALUES (?,?,?,?,?,?,?,?,?)";

impl InboxStore {
    /// `new InboxStore(options)`: validates the retention, opens (and creates) the file.
    pub fn open(o: InboxStoreOptions) -> Result<Self, InboxError> {
        let max_age = o.max_age_ms.unwrap_or(DEFAULT_MAX_AGE_MS as f64);
        let max_entries = o.max_entries.unwrap_or(DEFAULT_MAX_ENTRIES as f64);
        if !is_integer(max_age) || max_age < 1.0 {
            return Err(InboxError::invalid("maxAgeMs must be a positive integer"));
        }
        if !is_integer(max_entries) || max_entries < 1.0 {
            return Err(InboxError::invalid("maxEntries must be a positive integer"));
        }
        private_store::prepare(&o.path)
            .map_err(|e| InboxError::Store(format!("cannot prepare the inbox store: {e}")))?;
        // `platformCapabilities.securePath(path)` is best effort in TypeScript (its result is not read); here the hook runs
        // and a store whose permissions cannot be applied is not opened, as for the other private stores of this crate.
        let applied = match &o.secure_path {
            Some(f) => f(&o.path),
            None => private_store::default_secure(&o.path),
        };
        if !applied {
            return Err(InboxError::Store("inbox permissions unavailable".into()));
        }
        let owner = OwnerSpec {
            store: StoreSpec {
                synchronous: Synchronous::Full,
                ..StoreSpec::new("inbox", 0)
            },
            // The TypeScript store never selects WAL: the file keeps SQLite's rollback journal.
            journal: Journal::Unchanged,
            schema: Schema::Unversioned,
            create: true,
        };
        let db = Store::open_owner(&o.path, &owner)?;
        db.conn().execute_batch(TABLES)?;
        Ok(Self {
            db,
            // Both are integers within the safe range once they passed the checks above.
            retention: (max_age as i64, max_entries as i64),
            clock: o.clock,
            ids: o.ids.unwrap_or_else(|| Arc::new(UuidIds)),
        })
    }

    /// `retention`: `(maxAgeMs, maxEntries)`.
    pub fn retention(&self) -> (i64, i64) {
        self.retention
    }

    /// Creates the entry unless this person already has one under `dedupeKey` (then nothing changes).
    pub fn publish(&mut self, d: &InboxDraft) -> Result<Published, InboxError> {
        validate(d)?;
        let Self {
            db,
            retention,
            clock,
            ids,
        } = self;
        db.write_with(|tx| {
            // Retention first: an entry past its age must not hide a repeat event behind its dedupe key.
            prune(tx, clock.as_ref(), *retention, &d.user_id)?;
            let known: Option<String> = tx
                .query_row(
                    "SELECT id FROM inbox_entries WHERE user_id=? AND dedupe_key=?",
                    params![d.user_id, d.dedupe_key],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(id) = known {
                return Ok(Published { id, created: false });
            }
            let id = ids.next_id();
            tx.execute(
                INSERT,
                params![
                    id,
                    d.user_id,
                    d.dedupe_key,
                    d.kind,
                    d.severity,
                    d.title_key,
                    params_json(d.params.as_ref()),
                    d.reference.as_ref().map(ref_json),
                    clock.now()
                ],
            )?;
            prune(tx, clock.as_ref(), *retention, &d.user_id)?;
            Ok::<_, InboxError>(Published { id, created: true })
        })
    }

    /// A rolling cooldown committed atomically with the entry, independent of dismissal, entry retention and process lifetime.
    pub fn publish_rate_limited(
        &mut self,
        d: &InboxDraft,
        cooldown_ms: f64,
    ) -> Result<Published, InboxError> {
        validate(d)?;
        if !is_safe_integer(cooldown_ms) || cooldown_ms < 1.0 {
            return Err(InboxError::invalid(
                "cooldownMs must be a positive safe integer",
            ));
        }
        let Self {
            db,
            retention,
            clock,
            ids,
        } = self;
        db.write_with(|tx| {
            let now = clock.now();
            let last: Option<(i64, String)> = tx
                .query_row(
                    "SELECT published_at, entry_id FROM inbox_cooldowns WHERE user_id=? AND cause=?",
                    params![d.user_id, d.dedupe_key],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((at, id)) = last {
                if ((now - at) as f64) < cooldown_ms {
                    return Ok(Published { id, created: false });
                }
            }
            prune(tx, clock.as_ref(), *retention, &d.user_id)?;
            let id = ids.next_id();
            tx.execute(
                INSERT,
                params![
                    id,
                    d.user_id,
                    format!("rate:{id}"),
                    d.kind,
                    d.severity,
                    d.title_key,
                    params_json(d.params.as_ref()),
                    d.reference.as_ref().map(ref_json),
                    now
                ],
            )?;
            tx.execute(
                "INSERT INTO inbox_cooldowns(user_id,cause,published_at,entry_id) VALUES (?,?,?,?) ON CONFLICT(user_id,cause) DO UPDATE SET published_at=excluded.published_at,entry_id=excluded.entry_id",
                params![d.user_id, d.dedupe_key, now, id],
            )?;
            prune(tx, clock.as_ref(), *retention, &d.user_id)?;
            Ok::<_, InboxError>(Published { id, created: true })
        })
    }

    /// One page of the person's entries, newest first.
    pub fn list(&self, user_id: &str, q: &InboxListQuery) -> Result<InboxPage, InboxError> {
        let limit = q.limit.unwrap_or(DEFAULT_PAGE as f64);
        if !is_integer(limit) || limit < 1.0 || limit > MAX_PAGE as f64 {
            return Err(InboxError::Invalid(format!("limit must be 1-{MAX_PAGE}")));
        }
        let limit = limit as i64;
        if let Some(k) = &q.kinds {
            if k.iter().any(|k| !INBOX_KINDS.contains(&k.as_str())) {
                return Err(InboxError::invalid("unknown inbox kind"));
            }
        }
        let mut wh = vec!["user_id=?".to_owned()];
        let mut args: Vec<plur1bus_store::rusqlite::types::Value> = vec![user_id.to_owned().into()];
        if let Some(c) = &q.cursor {
            wh.push("seq < ?".into());
            args.push(decode_cursor(c)?.into());
        }
        if let Some(k) = q.kinds.as_ref().filter(|k| !k.is_empty()) {
            wh.push(format!("kind IN ({})", vec!["?"; k.len()].join(",")));
            args.extend(k.iter().map(|k| k.clone().into()));
        }
        if q.unread_only {
            wh.push("read_at IS NULL".into());
        }
        if !q.include_dismissed {
            wh.push("dismissed_at IS NULL".into());
        }
        args.push((limit + 1).into());
        let sql = format!(
            "SELECT * FROM inbox_entries WHERE {} ORDER BY seq DESC LIMIT ?",
            wh.join(" AND ")
        );
        let mut st = self.db.conn().prepare(&sql)?;
        let mut rows = Vec::new();
        let mut it = st.query(params_from_iter(args))?;
        while let Some(r) = it.next()? {
            rows.push(entry_of(r)?);
        }
        let more = rows.len() as i64 > limit;
        rows.truncate(limit as usize);
        let next_cursor = more.then(|| encode_cursor(rows.last().map_or(0, |r| r.0)));
        Ok(InboxPage {
            entries: rows.into_iter().map(|r| r.1).collect(),
            next_cursor,
        })
    }

    /// Unread, not dismissed entries per kind (every kind is present), plus the number of visible entries.
    pub fn count(&self, user_id: &str) -> Result<InboxCounts, InboxError> {
        let mut unread: Vec<(String, i64)> =
            INBOX_KINDS.iter().map(|k| ((*k).to_owned(), 0)).collect();
        let conn = self.db.conn();
        let mut st = conn.prepare("SELECT kind, COUNT(*) AS n FROM inbox_entries WHERE user_id=? AND dismissed_at IS NULL AND read_at IS NULL GROUP BY kind")?;
        let rows = st.query_map([user_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for r in rows {
            let (k, n) = r?;
            match unread.iter_mut().find(|(x, _)| *x == k) {
                Some(slot) => slot.1 = n,
                None => unread.push((k, n)),
            }
        }
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) AS n FROM inbox_entries WHERE user_id=? AND dismissed_at IS NULL",
            [user_id],
            |r| r.get(0),
        )?;
        Ok(InboxCounts { unread, total })
    }

    /// The kinds a `mark_read` (`unread`) or `dismiss` (`open`) of these ids would touch, for the person's own entries only.
    /// No page limit.
    pub fn kinds_of(
        &self,
        user_id: &str,
        ids: Ids<'_>,
        unread: bool,
    ) -> Result<Vec<String>, InboxError> {
        let state = if unread {
            "read_at IS NULL AND dismissed_at IS NULL"
        } else {
            "dismissed_at IS NULL"
        };
        let conn = self.db.conn();
        let (sql, args): (String, Vec<String>) = match ids {
            Ids::All => (
                format!("SELECT DISTINCT kind FROM inbox_entries WHERE user_id=? AND {state}"),
                vec![user_id.to_owned()],
            ),
            list => {
                let list = id_list(list)?;
                let mut args = vec![user_id.to_owned()];
                args.extend(list.iter().cloned());
                (
                    format!(
                        "SELECT DISTINCT kind FROM inbox_entries WHERE user_id=? AND {state} AND id IN ({})",
                        vec!["?"; list.len()].join(",")
                    ),
                    args,
                )
            }
        };
        let mut st = conn.prepare(&sql)?;
        let rows = st.query_map(params_from_iter(args), |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Marks the person's own entries read (the first read time is kept); returns how many changed.
    pub fn mark_read(&mut self, user_id: &str, ids: Ids<'_>) -> Result<i64, InboxError> {
        let now = self.clock.now();
        let list = match ids {
            Ids::All => None,
            list => Some(id_list(list)?),
        };
        self.db.write_with(|tx| match &list {
            None => Ok::<_, InboxError>(tx.execute(
                "UPDATE inbox_entries SET read_at=? WHERE user_id=? AND read_at IS NULL AND dismissed_at IS NULL",
                params![now, user_id],
            )? as i64),
            Some(list) => {
                let mut n = 0;
                for id in list {
                    n += tx.execute(
                        "UPDATE inbox_entries SET read_at=? WHERE user_id=? AND id=? AND read_at IS NULL",
                        params![now, user_id, id],
                    )? as i64;
                }
                Ok(n)
            }
        })
    }

    /// Hides the person's own entries (read as well); the row stays until retention so a repeat event does not bring it back.
    pub fn dismiss(&mut self, user_id: &str, ids: Ids<'_>) -> Result<i64, InboxError> {
        let list = id_list(ids)?;
        let now = self.clock.now();
        self.db.write_with(|tx| {
            let mut n = 0;
            for id in &list {
                n += tx.execute(
                    "UPDATE inbox_entries SET dismissed_at=?, read_at=COALESCE(read_at,?) WHERE user_id=? AND id=? AND dismissed_at IS NULL",
                    params![now, now, user_id, id],
                )? as i64;
            }
            Ok::<_, InboxError>(n)
        })
    }

    /// Like `settle` for everyone who has the entry; returns the people whose entry was closed.
    pub fn settle_everywhere(&mut self, dedupe_key: &str) -> Result<Vec<String>, InboxError> {
        let now = self.clock.now();
        self.db.write_with(|tx| {
            let mut st = tx.prepare("UPDATE inbox_entries SET dismissed_at=?, read_at=COALESCE(read_at,?) WHERE dedupe_key=? AND dismissed_at IS NULL RETURNING user_id")?;
            let rows = st.query_map(params![now, now, dedupe_key], |r| r.get::<_, String>(0))?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok::<_, InboxError>(out)
        })
    }

    /// Producer side: the thing the entry was about is settled, so close it. True when an open entry was closed.
    pub fn settle(&mut self, user_id: &str, dedupe_key: &str) -> Result<bool, InboxError> {
        let now = self.clock.now();
        self.db.write_with(|tx| {
            Ok::<_, InboxError>(
                tx.execute(
                    "UPDATE inbox_entries SET dismissed_at=?, read_at=COALESCE(read_at,?) WHERE user_id=? AND dedupe_key=? AND dismissed_at IS NULL",
                    params![now, now, user_id, dedupe_key],
                )? > 0,
            )
        })
    }
}
