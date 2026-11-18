//! `approvals/chain.ts` (D109 §6): the append-only event log with an HMAC-SHA256 chain. Every entry stores the MAC of its
//! predecessor and its own MAC over `JSON.stringify([prev, seq, ts, kind, refId, nonce, payload])`, keyed by the
//! per-installation key; a keyed head row `(seq, mac, tag)` pins the newest entry, so cutting the tail is caught too.
//! `approval.decided` entries may also carry an Ed25519 signature over their MAC ([`super::signing`]).
//!
//! Not protected (stated in the spec): code with the person's OS rights that can read the secret store can forge the chain,
//! and a rollback to an older, fully consistent copy of the file is not detected.
//!
//! Verification is the TypeScript order, step for step: sequence, linkage, MAC, head, the semantic rules over MAC-valid
//! entries (binding, single-use nonce, no second decision or use, no decision after a cancel), then the signatures. The
//! verified view is cached per connection until this chain appends, the signer changes, or another connection commits
//! (`PRAGMA data_version`), as in TypeScript.
//!
//! Where a row cannot be read the way `node:sqlite` hands it to TypeScript (a text column holding a number or a blob), the
//! read fails ([`ChainError::Unreadable`]): TypeScript would compute with the foreign value or throw; either way nothing is
//! decided from such a file. `ts` and `seq` are read with `Number()`, as TypeScript reads them.
use super::js_json::J;
use super::node_codec::hex_encode;
use super::signing::{verify_decision_signature, DecisionSigner};
use super::Clock;
use crate::metrics::registry::js_number_to_string;
use crate::policy::js_value::string_to_number;
use plur1bus_store::rusqlite::types::ValueRef;
use plur1bus_store::rusqlite::{params, Connection, OptionalExtension};
use ring::hmac;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::rc::Rc;
use std::sync::Arc;

/// `GENESIS_MAC`: the predecessor of the first entry.
pub const GENESIS_MAC: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// One chain row.
#[derive(Clone, Debug, PartialEq)]
pub struct ChainEntry {
    /// Position, from 1.
    pub seq: f64,
    /// Milliseconds since the epoch (as `Number(row.ts)` reads it).
    pub ts: f64,
    /// `approval.requested`, `grant.created`, ...
    pub kind: String,
    /// The approval or grant it belongs to.
    pub ref_id: String,
    /// The request's nonce (requests and decisions only).
    pub nonce: Option<String>,
    /// `JSON.stringify(payload)`.
    pub payload: String,
    /// The predecessor's MAC.
    pub prev_mac: String,
    /// This entry's MAC.
    pub mac: String,
}

/// `VerifyFailure`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerifyFailure {
    /// `seq-gap`.
    SeqGap,
    /// `prev-mismatch`.
    PrevMismatch,
    /// `mac-mismatch`.
    MacMismatch,
    /// `truncated`.
    Truncated,
    /// `head-mismatch`.
    HeadMismatch,
    /// `malformed`.
    Malformed,
    /// `nonce-reuse`.
    NonceReuse,
    /// `binding-mismatch`.
    BindingMismatch,
    /// `duplicate`.
    Duplicate,
    /// `signature-mismatch`.
    SignatureMismatch,
}

impl VerifyFailure {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            VerifyFailure::SeqGap => "seq-gap",
            VerifyFailure::PrevMismatch => "prev-mismatch",
            VerifyFailure::MacMismatch => "mac-mismatch",
            VerifyFailure::Truncated => "truncated",
            VerifyFailure::HeadMismatch => "head-mismatch",
            VerifyFailure::Malformed => "malformed",
            VerifyFailure::NonceReuse => "nonce-reuse",
            VerifyFailure::BindingMismatch => "binding-mismatch",
            VerifyFailure::Duplicate => "duplicate",
            VerifyFailure::SignatureMismatch => "signature-mismatch",
        }
    }
}

/// `SignatureSummary`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SignatureSummary {
    /// Entries without a signature (every entry that is not a decision counts here, as in TypeScript).
    pub unsigned_legacy: u64,
    /// Decisions whose signature verifies (and is by the configured signer, when there is one).
    pub signed_ok: u64,
    /// Decisions whose signature does not.
    pub signed_bad: u64,
}

impl SignatureSummary {
    /// `report`: `signed-bad`, `signed-ok` or `unsigned (legacy)`.
    pub fn report(&self) -> &'static str {
        if self.signed_bad > 0 {
            "signed-bad"
        } else if self.signed_ok > 0 {
            "signed-ok"
        } else {
            "unsigned (legacy)"
        }
    }

    /// `{ unsignedLegacy, signedOk, signedBad, report }`.
    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({ "unsignedLegacy": self.unsigned_legacy, "signedOk": self.signed_ok, "signedBad": self.signed_bad,
            "report": self.report() })
    }
}

/// `VerifyResult`.
#[derive(Clone, Debug, PartialEq)]
pub enum VerifyResult {
    /// The whole chain holds.
    Ok {
        /// Number of entries.
        entries: usize,
        /// `{ seq, mac }` of the newest entry; `None` for an empty chain.
        head: Option<(usize, String)>,
        /// The signature summary.
        signatures: SignatureSummary,
    },
    /// The chain does not hold from `broken_at` on.
    Broken {
        /// Number of entries.
        entries: usize,
        /// The first position (seq) at which the chain does not hold.
        broken_at: f64,
        /// Why.
        reason: VerifyFailure,
        /// A fixed sentence (no key, no payload).
        detail: String,
        /// The signature summary (only computed when the signatures were reached).
        signatures: SignatureSummary,
    },
}

impl VerifyResult {
    /// `result.ok`.
    pub fn ok(&self) -> bool {
        matches!(self, VerifyResult::Ok { .. })
    }

    /// The TypeScript object.
    pub fn json(&self) -> serde_json::Value {
        use serde_json::json;
        match self {
            VerifyResult::Ok {
                entries,
                head,
                signatures,
            } => json!({ "ok": true, "entries": entries,
                "head": head.as_ref().map_or(serde_json::Value::Null, |(seq, mac)| json!({ "seq": seq, "mac": mac })),
                "signatures": signatures.json() }),
            VerifyResult::Broken {
                entries,
                broken_at,
                reason,
                detail,
                signatures,
            } => {
                json!({ "ok": false, "entries": entries, "brokenAt": super::js_json::num_value(*broken_at),
                "reason": reason.as_str(), "detail": detail, "signatures": signatures.json() })
            }
        }
    }
}

/// Why the chain could not be read or extended.
#[derive(Clone, Debug, PartialEq)]
pub enum ChainError {
    /// `ApprovalChainError` (`chain-broken`): the chain does not verify, so nothing is decided from it or added to it.
    Broken {
        /// The first position that does not hold.
        broken_at: f64,
        /// Why.
        reason: VerifyFailure,
        /// The fixed sentence.
        detail: String,
    },
    /// A row holds a value `node:sqlite` would hand over as something other than the column's type.
    Unreadable(String),
    /// SQLite failed.
    Sqlite(String),
    /// `append` was called outside a write transaction (a caller error: every write runs under `BEGIN IMMEDIATE`).
    NoTransaction,
}

impl fmt::Display for ChainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ChainError::Broken {
                broken_at,
                reason,
                detail,
            } => write!(
                f,
                "approval chain is broken at {} ({}): {detail}",
                js_number_to_string(*broken_at),
                reason.as_str()
            ),
            ChainError::Unreadable(m) => write!(f, "approval chain row is unreadable: {m}"),
            ChainError::Sqlite(m) => write!(f, "approval chain: {m}"),
            ChainError::NoTransaction => {
                f.write_str("approval chain append outside a write transaction")
            }
        }
    }
}

impl std::error::Error for ChainError {}

impl From<plur1bus_store::rusqlite::Error> for ChainError {
    fn from(e: plur1bus_store::rusqlite::Error) -> Self {
        ChainError::Sqlite(e.to_string())
    }
}

impl From<plur1bus_store::StoreError> for ChainError {
    fn from(e: plur1bus_store::StoreError) -> Self {
        ChainError::Sqlite(e.to_string())
    }
}

/// `ChainSnapshot`: the verified view of the whole chain.
#[derive(Debug)]
pub struct ChainSnapshot {
    /// The verification result.
    pub result: VerifyResult,
    /// Every row, in `seq` order.
    pub entries: Vec<ChainEntry>,
    /// Indices into `entries` per `ref_id`, in order of first appearance (the order of TypeScript's `Map`).
    by_ref: Vec<(String, Vec<usize>)>,
    by_ref_index: HashMap<String, usize>,
    /// Entries with `seq` below this are proven; infinite when the whole chain verifies.
    pub trusted_below: f64,
}

impl ChainSnapshot {
    /// `byRef.get(refId)`.
    pub fn by_ref(&self, ref_id: &str) -> Vec<&ChainEntry> {
        self.by_ref_index
            .get(ref_id)
            .map(|&i| self.by_ref[i].1.iter().map(|&j| &self.entries[j]).collect())
            .unwrap_or_default()
    }

    /// Every `ref_id` with its entries, in order of first appearance.
    pub fn refs(&self) -> impl Iterator<Item = (&str, Vec<&ChainEntry>)> {
        self.by_ref.iter().map(|(id, list)| {
            (
                id.as_str(),
                list.iter().map(|&j| &self.entries[j]).collect(),
            )
        })
    }

    /// The broken result as an error (`trusted()` of the store); `None` when the chain holds.
    pub fn broken(&self) -> Option<ChainError> {
        match &self.result {
            VerifyResult::Ok { .. } => None,
            VerifyResult::Broken {
                broken_at,
                reason,
                detail,
                ..
            } => Some(ChainError::Broken {
                broken_at: *broken_at,
                reason: *reason,
                detail: detail.clone(),
            }),
        }
    }
}

/// Constant-time equality of two strings as bytes (a length difference returns early; the length is not secret).
pub fn same_bytes(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `bindingTuple(b)`: the binding every approval is tied to, as one canonical string; `None` unless all seven members are
/// strings.
pub fn binding_tuple(b: Option<&J>) -> Option<String> {
    let b = b.filter(|b| b.is_object_like())?;
    let s = b.get("subject");
    let parts = [
        b.get("actionHash"),
        b.get("principal"),
        s.and_then(|s| s.get("kind")),
        s.and_then(|s| s.get("id")),
        b.get("turnId"),
        b.get("taskId"),
        b.get("sessionId"),
    ];
    let strings: Option<Vec<J>> = parts
        .iter()
        .map(|p| p.and_then(J::as_str).map(J::s))
        .collect();
    Some(J::Arr(strings?).stringify())
}

struct Cache {
    data_version: i64,
    gen: u64,
    snap: Rc<ChainSnapshot>,
}

/// `ApprovalChain`: the chain over one connection. It holds the key in memory only (never printed, never written).
pub struct ApprovalChain {
    key: hmac::Key,
    clock: Arc<dyn Clock>,
    signer: Option<Arc<dyn DecisionSigner>>,
    gen: Cell<u64>,
    cache: RefCell<Option<Cache>>,
}

impl fmt::Debug for ApprovalChain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApprovalChain").finish_non_exhaustive()
    }
}

fn text(v: ValueRef<'_>, what: &str) -> Result<String, ChainError> {
    match v {
        ValueRef::Text(t) => Ok(String::from_utf8_lossy(t).into_owned()),
        _ => Err(ChainError::Unreadable(format!("{what} is not text"))),
    }
}

/// `Number(v)` of a column value as `node:sqlite` hands it over.
fn number(v: ValueRef<'_>) -> f64 {
    match v {
        ValueRef::Integer(i) => i as f64,
        ValueRef::Real(r) => r,
        ValueRef::Text(t) => string_to_number(&String::from_utf8_lossy(t)),
        ValueRef::Null => 0.0,
        ValueRef::Blob(_) => f64::NAN,
    }
}

fn num_text(n: f64) -> String {
    J::Num(n).stringify()
}

impl ApprovalChain {
    /// `new ApprovalChain(db, key, clock, signer)`: `key` must have at least 32 bytes.
    pub fn new(
        key: &[u8],
        clock: Arc<dyn Clock>,
        signer: Option<Arc<dyn DecisionSigner>>,
    ) -> Result<Self, super::keys::KeyError> {
        super::keys::assert_key(key)?;
        Ok(ApprovalChain {
            key: hmac::Key::new(hmac::HMAC_SHA256, key),
            clock,
            signer,
            gen: Cell::new(0),
            cache: RefCell::new(None),
        })
    }

    /// `setSigner`: late wiring; the cached view is dropped.
    pub fn set_signer(&mut self, signer: Option<Arc<dyn DecisionSigner>>) {
        self.signer = signer;
        self.bump();
    }

    /// The configured signer's public key.
    pub fn signer_public_key(&self) -> Option<&str> {
        self.signer.as_deref().map(DecisionSigner::public_key)
    }

    fn bump(&self) {
        self.gen.set(self.gen.get().wrapping_add(1));
        self.cache.borrow_mut().take();
    }

    /// The canonical text an entry's MAC is computed over.
    pub fn mac_input(
        prev: &str,
        seq: f64,
        ts: f64,
        kind: &str,
        ref_id: &str,
        nonce: Option<&str>,
        payload: &str,
    ) -> String {
        J::Arr(vec![
            J::s(prev),
            J::Num(seq),
            J::Num(ts),
            J::s(kind),
            J::s(ref_id),
            J::opt_s(nonce),
            J::s(payload),
        ])
        .stringify()
    }

    /// `#mac(prev, e)`.
    #[allow(clippy::too_many_arguments)]
    pub fn mac(
        &self,
        prev: &str,
        seq: f64,
        ts: f64,
        kind: &str,
        ref_id: &str,
        nonce: Option<&str>,
        payload: &str,
    ) -> String {
        let input = Self::mac_input(prev, seq, ts, kind, ref_id, nonce, payload);
        hex_encode(hmac::sign(&self.key, input.as_bytes()).as_ref())
    }

    /// `#tag(seq, mac)`: the keyed pin of the head row.
    pub fn tag(&self, seq: f64, mac: &str) -> String {
        let input = J::Arr(vec![J::s("head"), J::Num(seq), J::s(mac)]).stringify();
        hex_encode(hmac::sign(&self.key, input.as_bytes()).as_ref())
    }

    /// `snapshot()`: the verified view, from the cache while nothing changed.
    pub fn snapshot(&self, conn: &Connection) -> Result<Rc<ChainSnapshot>, ChainError> {
        let dv: i64 = conn.query_row("PRAGMA data_version", [], |r| r.get(0))?;
        if let Some(c) = self.cache.borrow().as_ref() {
            if c.data_version == dv && c.gen == self.gen.get() {
                return Ok(Rc::clone(&c.snap));
            }
        }
        let snap = Rc::new(self.build(conn)?);
        *self.cache.borrow_mut() = Some(Cache {
            data_version: dv,
            gen: self.gen.get(),
            snap: Rc::clone(&snap),
        });
        Ok(snap)
    }

    /// `verify()`.
    pub fn verify(&self, conn: &Connection) -> Result<VerifyResult, ChainError> {
        Ok(self.snapshot(conn)?.result.clone())
    }

    fn rows(conn: &Connection) -> Result<Vec<ChainEntry>, ChainError> {
        let mut stmt = conn.prepare(
            "SELECT seq, ts, kind, ref_id, nonce, payload, prev_mac, mac FROM approval_chain ORDER BY seq",
        )?;
        let mut rows = stmt.query([])?;
        let mut out = Vec::new();
        while let Some(r) = rows.next()? {
            let nonce = match r.get_ref(4)? {
                ValueRef::Null => None,
                v => Some(text(v, "nonce")?),
            };
            out.push(ChainEntry {
                seq: number(r.get_ref(0)?),
                ts: number(r.get_ref(1)?),
                kind: text(r.get_ref(2)?, "kind")?,
                ref_id: text(r.get_ref(3)?, "ref_id")?,
                nonce,
                payload: text(r.get_ref(5)?, "payload")?,
                prev_mac: text(r.get_ref(6)?, "prev_mac")?,
                mac: text(r.get_ref(7)?, "mac")?,
            });
        }
        Ok(out)
    }

    fn build(&self, conn: &Connection) -> Result<ChainSnapshot, ChainError> {
        let rows = Self::rows(conn)?;
        let mut by_ref: Vec<(String, Vec<usize>)> = Vec::new();
        let mut by_ref_index: HashMap<String, usize> = HashMap::new();
        for (i, e) in rows.iter().enumerate() {
            match by_ref_index.get(&e.ref_id) {
                Some(&k) => by_ref[k].1.push(i),
                None => {
                    by_ref_index.insert(e.ref_id.clone(), by_ref.len());
                    by_ref.push((e.ref_id.clone(), vec![i]));
                }
            }
        }
        let result = self.check(conn, &rows)?;
        let trusted_below = match &result {
            VerifyResult::Ok { .. } => f64::INFINITY,
            VerifyResult::Broken { broken_at, .. } => *broken_at,
        };
        Ok(ChainSnapshot {
            result,
            entries: rows,
            by_ref,
            by_ref_index,
            trusted_below,
        })
    }

    fn check(&self, conn: &Connection, rows: &[ChainEntry]) -> Result<VerifyResult, ChainError> {
        let n = rows.len();
        let fail = |at: f64, reason: VerifyFailure, detail: &str| VerifyResult::Broken {
            entries: n,
            broken_at: at,
            reason,
            detail: detail.to_owned(),
            signatures: SignatureSummary::default(),
        };
        let mut expected = 1.0;
        let mut prev = GENESIS_MAC.to_owned();
        for e in rows {
            if e.seq != expected {
                let detail = format!(
                    "expected entry {}, found {}",
                    num_text(expected),
                    num_text(e.seq)
                );
                return Ok(fail(expected, VerifyFailure::SeqGap, &detail));
            }
            if !same_bytes(&e.prev_mac, &prev) {
                return Ok(fail(
                    e.seq,
                    VerifyFailure::PrevMismatch,
                    "the entry does not chain to its predecessor",
                ));
            }
            let mac = self.mac(
                &prev,
                e.seq,
                e.ts,
                &e.kind,
                &e.ref_id,
                e.nonce.as_deref(),
                &e.payload,
            );
            if !same_bytes(&e.mac, &mac) {
                return Ok(fail(
                    e.seq,
                    VerifyFailure::MacMismatch,
                    "the entry's MAC does not verify",
                ));
            }
            prev = e.mac.clone();
            expected += 1.0;
        }

        let head = conn
            .query_row(
                "SELECT seq, mac, tag FROM chain_head WHERE id = 1",
                [],
                |r| {
                    Ok((
                        number(r.get_ref(0)?),
                        match r.get_ref(1)? {
                            ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
                            _ => None,
                        },
                        match r.get_ref(2)? {
                            ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
                            _ => None,
                        },
                    ))
                },
            )
            .optional()?;
        let nf = n as f64;
        if n == 0 {
            if head.is_some() {
                return Ok(fail(
                    1.0,
                    VerifyFailure::Truncated,
                    "the head points at entries that are gone",
                ));
            }
        } else {
            let tag_ok = |seq: f64, mac: &Option<String>, tag: &Option<String>| match (mac, tag) {
                (Some(mac), Some(tag)) => same_bytes(tag, &self.tag(seq, mac)),
                _ => false,
            };
            let Some((seq, mac, _)) = head.filter(|(s, m, t)| tag_ok(*s, m, t)) else {
                return Ok(fail(
                    nf,
                    VerifyFailure::HeadMismatch,
                    "the chain head is missing or its tag does not verify",
                ));
            };
            if seq > nf {
                let detail = format!(
                    "the head pins entry {}, the chain ends at {n}",
                    num_text(seq)
                );
                return Ok(fail(nf + 1.0, VerifyFailure::Truncated, &detail));
            }
            if seq < nf {
                return Ok(fail(
                    seq + 1.0,
                    VerifyFailure::HeadMismatch,
                    "entries exist beyond the pinned head",
                ));
            }
            if !same_bytes(mac.as_deref().unwrap_or(""), &rows[n - 1].mac) {
                return Ok(fail(
                    nf,
                    VerifyFailure::HeadMismatch,
                    "the pinned head does not match the last entry",
                ));
            }
        }

        if let Some((at, reason, detail)) = semantic(rows) {
            return Ok(fail(at, reason, detail));
        }
        let stored = signature_rows(conn)?;
        let mut sig = SignatureSummary::default();
        let mut first_bad = None;
        for e in rows {
            if e.kind != "approval.decided" {
                sig.unsigned_legacy += 1;
                continue;
            }
            let Some(row) = stored.get(&e.seq.to_bits()) else {
                sig.unsigned_legacy += 1;
                continue;
            };
            if self.signature_ok(e, row) {
                sig.signed_ok += 1;
            } else {
                sig.signed_bad += 1;
                first_bad.get_or_insert(e.seq);
            }
        }
        if sig.signed_bad > 0 {
            return Ok(VerifyResult::Broken {
                entries: n,
                broken_at: first_bad.unwrap_or(nf),
                reason: VerifyFailure::SignatureMismatch,
                detail: "a signed decision does not verify".to_owned(),
                signatures: sig,
            });
        }
        Ok(VerifyResult::Ok {
            entries: n,
            head: (n > 0).then(|| (n, rows[n - 1].mac.clone())),
            signatures: sig,
        })
    }

    fn signature_ok(&self, e: &ChainEntry, row: &SignatureRow) -> bool {
        let (Some(public_key), Some(signature)) = (&row.public_key, &row.signature) else {
            return false; // `Buffer.from` of a non-string throws inside the verifier's try: not verified
        };
        let crypto_ok = verify_decision_signature(&e.mac, public_key, signature);
        let key_ok = self
            .signer
            .as_deref()
            .is_none_or(|s| s.public_key() == public_key);
        crypto_ok && key_ok
    }

    /// `append(kind, refId, payload, nonce)`: one entry, in the caller's write transaction. Refuses to extend a broken
    /// chain. A decision is signed when a signer is configured.
    pub fn append(
        &self,
        conn: &Connection,
        kind: &str,
        ref_id: &str,
        payload: &J,
        nonce: Option<&str>,
    ) -> Result<ChainEntry, ChainError> {
        if conn.is_autocommit() {
            return Err(ChainError::NoTransaction);
        }
        let out = self.append_in(conn, kind, ref_id, payload, nonce);
        self.bump(); // the cache is stale from here on, whether or not the statements succeeded
        out
    }

    fn append_in(
        &self,
        conn: &Connection,
        kind: &str,
        ref_id: &str,
        payload: &J,
        nonce: Option<&str>,
    ) -> Result<ChainEntry, ChainError> {
        let snap = self.snapshot(conn)?;
        if let Some(e) = snap.broken() {
            return Err(e);
        }
        let last = snap.entries.last();
        let prev = last.map_or(GENESIS_MAC.to_owned(), |l| l.mac.clone());
        let seq = last.map_or(0.0, |l| l.seq) + 1.0;
        let ts = self.clock.now() as f64;
        let payload = payload.stringify();
        let mac = self.mac(&prev, seq, ts, kind, ref_id, nonce, &payload);
        self.bump();
        conn.execute(
            "INSERT INTO approval_chain (seq, ts, kind, ref_id, nonce, payload, prev_mac, mac) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![seq as i64, ts as i64, kind, ref_id, nonce, payload, prev, mac],
        )?;
        conn.execute(
            "INSERT INTO chain_head (id, seq, mac, tag) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, mac = excluded.mac, tag = excluded.tag",
            params![seq as i64, mac, self.tag(seq, &mac)],
        )?;
        if let Some(signer) = self
            .signer
            .as_deref()
            .filter(|_| kind == "approval.decided")
        {
            let sig = signer.sign(&mac);
            conn.execute(
                "INSERT INTO approval_signatures (seq, alg, public_key, signature) VALUES (?, ?, ?, ?)",
                params![seq as i64, sig.alg, sig.public_key, sig.signature],
            )?;
        }
        Ok(ChainEntry {
            seq,
            ts,
            kind: kind.to_owned(),
            ref_id: ref_id.to_owned(),
            nonce: nonce.map(str::to_owned),
            payload,
            prev_mac: prev,
            mac,
        })
    }
}

struct SignatureRow {
    public_key: Option<String>,
    signature: Option<String>,
}

/// `#signatureRows()`: by `seq`; a missing table (a file not migrated past v2) reads as no signatures.
fn signature_rows(conn: &Connection) -> Result<HashMap<u64, SignatureRow>, ChainError> {
    let mut out = HashMap::new();
    let Ok(mut stmt) =
        conn.prepare("SELECT seq, alg, public_key, signature FROM approval_signatures")
    else {
        return Ok(out);
    };
    let opt_text = |v: ValueRef<'_>| match v {
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        _ => None,
    };
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        out.insert(
            number(r.get_ref(0)?).to_bits(),
            SignatureRow {
                public_key: opt_text(r.get_ref(2)?),
                signature: opt_text(r.get_ref(3)?),
            },
        );
    }
    Ok(out)
}

/// `#semantic(rows)`: the binding and replay rules over MAC-valid entries (defence in depth against a buggy or key-holding
/// writer).
fn semantic(rows: &[ChainEntry]) -> Option<(f64, VerifyFailure, &'static str)> {
    let mut requested: HashMap<&str, (String, Option<&str>)> = HashMap::new();
    let mut decided: HashMap<&str, String> = HashMap::new();
    let mut used: HashSet<&str> = HashSet::new();
    let mut cancelled: HashSet<&str> = HashSet::new();
    let mut nonces: HashSet<&str> = HashSet::new();
    for e in rows {
        if !e.kind.starts_with("approval.") {
            continue;
        }
        let Some(p) = J::parse(&e.payload) else {
            return Some((e.seq, VerifyFailure::Malformed, "payload is not JSON"));
        };
        if !p.is_object_like() {
            return Some((e.seq, VerifyFailure::Malformed, "payload is not an object"));
        }
        let tuple = binding_tuple(p.get("bound"));
        let r = e.ref_id.as_str();
        match e.kind.as_str() {
            "approval.requested" => {
                let Some(tuple) = tuple else {
                    return Some((e.seq, VerifyFailure::Malformed, "request entry"));
                };
                if requested.contains_key(r) {
                    return Some((e.seq, VerifyFailure::Duplicate, "request entry"));
                }
                requested.insert(r, (tuple, e.nonce.as_deref()));
            }
            "approval.decided" => {
                let Some(nonce) = e.nonce.as_deref().filter(|n| !nonces.contains(n)) else {
                    return Some((e.seq, VerifyFailure::NonceReuse, "a nonce is single-use"));
                };
                nonces.insert(nonce);
                let ok = requested.get(r).is_some_and(|(t, n)| {
                    tuple.as_deref() == Some(t.as_str()) && *n == Some(nonce)
                });
                if !ok {
                    return Some((
                        e.seq,
                        VerifyFailure::BindingMismatch,
                        "decision does not match its request",
                    ));
                }
                if decided.contains_key(r) {
                    return Some((e.seq, VerifyFailure::Duplicate, "request decided twice"));
                }
                if cancelled.contains(r) {
                    return Some((
                        e.seq,
                        VerifyFailure::BindingMismatch,
                        "a cancelled request was decided",
                    ));
                }
                let decision = p.get("decision").and_then(J::as_str);
                let Some(decision) = decision.filter(|d| *d == "approve" || *d == "deny") else {
                    return Some((e.seq, VerifyFailure::Malformed, "decision"));
                };
                decided.insert(r, decision.to_owned());
            }
            "approval.cancelled" => {
                let ok = requested
                    .get(r)
                    .is_some_and(|(t, _)| tuple.as_deref() == Some(t.as_str()))
                    && !decided.contains_key(r);
                if !ok {
                    return Some((
                        e.seq,
                        VerifyFailure::BindingMismatch,
                        "cancel does not match an undecided request",
                    ));
                }
                cancelled.insert(r);
            }
            "approval.used" => {
                let ok = requested
                    .get(r)
                    .is_some_and(|(t, _)| tuple.as_deref() == Some(t.as_str()))
                    && decided.get(r).map(String::as_str) == Some("approve");
                if !ok {
                    return Some((
                        e.seq,
                        VerifyFailure::BindingMismatch,
                        "use does not match an approved request",
                    ));
                }
                if !used.insert(r) {
                    return Some((e.seq, VerifyFailure::Duplicate, "approval used twice"));
                }
            }
            _ => {}
        }
    }
    None
}
