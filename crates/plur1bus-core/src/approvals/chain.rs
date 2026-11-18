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
//! A cell of another storage class than its column's is read the way `node:sqlite` hands it to TypeScript and then used the
//! way TypeScript uses it (review B, RB-3): a blob in a text column is a `Uint8Array` ([`Blobs`]), which `JSON.stringify`
//! writes as `{"0":..,"1":..}` (so the entry's MAC does not verify and the chain is broken there) and which `eq` compares
//! by its bytes (so a blob holding the very bytes of a MAC passes, as in TypeScript, and is carried on as the predecessor).
//! `ts` and `seq` are read with `Number()`, a blob included. Where TypeScript throws instead (an integer beyond 2^53, which
//! `node:sqlite` refuses to hand over; `timingSafeEqual` over texts of one length but not one byte length), the read fails
//! with [`ChainError::Unreadable`], which is no integrity failure, as TypeScript's `TypeError` or `RangeError` is none.
use super::js_json::J;
use super::node_codec::hex_encode;
use super::node_codec::{base64_decode, hex_decode};
use super::signing::{verify_decoded, DecisionSigner};
use super::Clock;
use crate::metrics::registry::js_number_to_string;
use crate::policy::js_value::string_to_number;
use plur1bus_store::rusqlite::types::{Value as SqlValue, ValueRef};
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
    /// The columns that hold a blob ([`BLOB_TEXT`] stands in the text field); `None` when every column is a text.
    pub blobs: Option<Box<Blobs>>,
}

/// The text field of a [`ChainEntry`] whose column holds a blob: it equals nothing the product writes, so a lookup by kind
/// or id never meets it, as a `Uint8Array` never equals a string in TypeScript.
pub const BLOB_TEXT: &str = "\u{0}blob";

/// The bytes of the text columns of one row that hold a blob (`None` for a text).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Blobs {
    /// `kind`.
    pub kind: Option<Vec<u8>>,
    /// `ref_id`.
    pub ref_id: Option<Vec<u8>>,
    /// `nonce`.
    pub nonce: Option<Vec<u8>>,
    /// `payload`.
    pub payload: Option<Vec<u8>>,
    /// `prev_mac`.
    pub prev_mac: Option<Vec<u8>>,
    /// `mac`.
    pub mac: Option<Vec<u8>>,
}

/// A text column's value as TypeScript sees it: a string or a `Uint8Array`.
#[derive(Clone, Copy, Debug)]
enum TextRef<'a> {
    Text(&'a str),
    Bytes(&'a [u8]),
}

impl<'a> TextRef<'a> {
    fn of(text: &'a str, blob: Option<&'a Vec<u8>>) -> Self {
        blob.map_or(TextRef::Text(text), |b| TextRef::Bytes(b))
    }

    /// `JSON.stringify` of it: a `Uint8Array` is an object of its bytes by index.
    fn json(self) -> J {
        match self {
            TextRef::Text(t) => J::s(t),
            TextRef::Bytes(b) => bytes_json(b),
        }
    }

    /// `Buffer.from(v)`.
    fn bytes(self) -> &'a [u8] {
        match self {
            TextRef::Text(t) => t.as_bytes(),
            TextRef::Bytes(b) => b,
        }
    }

    /// `v.length`: UTF-16 units of a string, bytes of a `Uint8Array`.
    fn js_length(self) -> usize {
        match self {
            TextRef::Text(t) => t.encode_utf16().count(),
            TextRef::Bytes(b) => b.len(),
        }
    }

    fn owned(self) -> TextCell {
        match self {
            TextRef::Text(t) => TextCell::Text(t.to_owned()),
            TextRef::Bytes(b) => TextCell::Bytes(b.to_vec()),
        }
    }
}

/// An owned [`TextRef`] (the predecessor's MAC while the chain is walked or extended).
#[derive(Clone, Debug)]
enum TextCell {
    Text(String),
    Bytes(Vec<u8>),
}

impl TextCell {
    fn as_ref(&self) -> TextRef<'_> {
        match self {
            TextCell::Text(t) => TextRef::Text(t),
            TextCell::Bytes(b) => TextRef::Bytes(b),
        }
    }
}

/// `JSON.stringify(uint8Array)`: `{"0":b0,"1":b1,...}`.
pub(crate) fn bytes_json(b: &[u8]) -> J {
    J::Obj(
        b.iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), J::Num(f64::from(*v))))
            .collect(),
    )
}

/// `eq(a, b)` of `chain.ts`: `a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))`. Where the lengths
/// agree but the byte lengths do not (64 non-ASCII characters against a hex MAC), `timingSafeEqual` throws a `RangeError`.
fn js_eq(a: TextRef<'_>, b: TextRef<'_>) -> Result<bool, ChainError> {
    if a.js_length() != b.js_length() {
        return Ok(false);
    }
    let (x, y) = (a.bytes(), b.bytes());
    if x.len() != y.len() {
        return Err(ChainError::Unreadable(
            "Input buffers must have the same byte length".to_owned(),
        ));
    }
    Ok(x.iter().zip(y).fold(0u8, |acc, (p, q)| acc | (p ^ q)) == 0)
}

impl ChainEntry {
    fn blob(&self, f: impl Fn(&Blobs) -> Option<&Vec<u8>>) -> Option<&Vec<u8>> {
        self.blobs.as_deref().and_then(f)
    }

    /// Whether `ref_id` holds a blob (a `Uint8Array` key of `byRef`, which no string lookup finds).
    pub fn ref_is_blob(&self) -> bool {
        self.blob(|b| b.ref_id.as_ref()).is_some()
    }

    fn mac_cell(&self) -> TextRef<'_> {
        TextRef::of(&self.mac, self.blob(|b| b.mac.as_ref()))
    }

    fn prev_cell(&self) -> TextRef<'_> {
        TextRef::of(&self.prev_mac, self.blob(|b| b.prev_mac.as_ref()))
    }

    /// The MAC input of the entry after `prev`: `JSON.stringify([prev, seq, ts, kind, refId, nonce, payload])`.
    fn mac_input_after(&self, prev: TextRef<'_>) -> String {
        let nonce = match &self.nonce {
            None => J::Null,
            Some(n) => TextRef::of(n, self.blob(|b| b.nonce.as_ref())).json(),
        };
        J::Arr(vec![
            prev.json(),
            J::Num(self.seq),
            J::Num(self.ts),
            TextRef::of(&self.kind, self.blob(|b| b.kind.as_ref())).json(),
            TextRef::of(&self.ref_id, self.blob(|b| b.ref_id.as_ref())).json(),
            nonce,
            TextRef::of(&self.payload, self.blob(|b| b.payload.as_ref())).json(),
        ])
        .stringify()
    }
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
        /// `{ seq, mac }` of the newest entry; `None` for an empty chain. A `mac` column holding a blob with the bytes of
        /// the MAC passes (review B, RB-3); `head_mac_blob` says so, and the object shows it as TypeScript's does.
        head: Option<(usize, String)>,
        /// Whether the newest entry's `mac` is a blob.
        head_mac_blob: bool,
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
                head_mac_blob,
                signatures,
            } => json!({ "ok": true, "entries": entries,
                "head": head.as_ref().map_or(serde_json::Value::Null, |(seq, mac)| {
                    let mac = if *head_mac_blob { bytes_json(mac.as_bytes()).to_value() } else { json!(mac) };
                    json!({ "seq": seq, "mac": mac })
                }),
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
    /// TypeScript throws while reading or checking a row (no `ApprovalChainError`, so no integrity failure): `node:sqlite`
    /// refuses an integer beyond 2^53, `timingSafeEqual` refuses buffers of different byte lengths.
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

/// A text column: the text, or [`BLOB_TEXT`] and the bytes of a blob. The columns are declared `TEXT`, so SQLite stores a
/// number written to them as text; a number here would be a file SQLite itself did not write, and is refused.
fn text(v: ValueRef<'_>, what: &str) -> Result<(String, Option<Vec<u8>>), ChainError> {
    match v {
        ValueRef::Text(t) => Ok((String::from_utf8_lossy(t).into_owned(), None)),
        ValueRef::Blob(b) => Ok((BLOB_TEXT.to_owned(), Some(b.to_vec()))),
        _ => Err(ChainError::Unreadable(format!("{what} is not text"))),
    }
}

/// The largest integer `node:sqlite` hands over as a number; beyond it, it throws.
const MAX_SAFE: i64 = (1 << 53) - 1;

/// `Number(v)` of a column value as `node:sqlite` hands it over (a blob is a `Uint8Array`, whose `Number()` is that of its
/// bytes joined by commas: `0` when empty, the byte when one, `NaN` otherwise).
fn number(v: ValueRef<'_>) -> Result<f64, ChainError> {
    Ok(match v {
        ValueRef::Integer(i) if !(-MAX_SAFE..=MAX_SAFE).contains(&i) => {
            return Err(ChainError::Unreadable(
                "an integer beyond 2^53 cannot be read".to_owned(),
            ))
        }
        ValueRef::Integer(i) => i as f64,
        ValueRef::Real(r) => r,
        ValueRef::Text(t) => string_to_number(&String::from_utf8_lossy(t)),
        ValueRef::Null => 0.0,
        ValueRef::Blob(b) => {
            string_to_number(&b.iter().map(u8::to_string).collect::<Vec<_>>().join(","))
        }
    })
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
        self.tag_of(seq, J::s(mac))
    }

    /// `#tag(seq, mac)` with `mac` as TypeScript holds it (a blob is a `Uint8Array`).
    fn tag_of(&self, seq: f64, mac: J) -> String {
        self.hmac_hex(&J::Arr(vec![J::s("head"), J::Num(seq), mac]).stringify())
    }

    fn hmac_hex(&self, input: &str) -> String {
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
        // K3-D2: a view built inside a write transaction may hold entries that transaction appended; if it rolls back,
        // neither `data_version` (this connection's own change) nor the generation (bumped before the read) would tell,
        // and the view would keep a phantom entry: TypeScript then reports a chain the file does not hold and the next
        // append leaves a gap that breaks the chain for good. Only a view of committed state is cached.
        if conn.is_autocommit() {
            *self.cache.borrow_mut() = Some(Cache {
                data_version: dv,
                gen: self.gen.get(),
                snap: Rc::clone(&snap),
            });
        }
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
            let mut blobs = Blobs::default();
            let (nonce, nonce_blob) = match r.get_ref(4)? {
                ValueRef::Null => (None, None),
                v => {
                    let (t, b) = text(v, "nonce")?;
                    (Some(t), b)
                }
            };
            blobs.nonce = nonce_blob;
            let col =
                |i: usize, what: &str, slot: &mut Option<Vec<u8>>| -> Result<String, ChainError> {
                    let (t, b) = text(r.get_ref(i)?, what)?;
                    *slot = b;
                    Ok(t)
                };
            let kind = col(2, "kind", &mut blobs.kind)?;
            let ref_id = col(3, "ref_id", &mut blobs.ref_id)?;
            let payload = col(5, "payload", &mut blobs.payload)?;
            let prev_mac = col(6, "prev_mac", &mut blobs.prev_mac)?;
            let mac = col(7, "mac", &mut blobs.mac)?;
            out.push(ChainEntry {
                seq: number(r.get_ref(0)?)?,
                ts: number(r.get_ref(1)?)?,
                kind,
                ref_id,
                nonce,
                payload,
                prev_mac,
                mac,
                blobs: (blobs != Blobs::default()).then(|| Box::new(blobs)),
            });
        }
        Ok(out)
    }

    fn build(&self, conn: &Connection) -> Result<ChainSnapshot, ChainError> {
        let rows = Self::rows(conn)?;
        let mut by_ref: Vec<(String, Vec<usize>)> = Vec::new();
        let mut by_ref_index: HashMap<String, usize> = HashMap::new();
        for (i, e) in rows.iter().enumerate() {
            if e.ref_is_blob() {
                // Every `Uint8Array` is a key of its own in TypeScript's `Map`, and no lookup by a string finds it.
                by_ref.push((BLOB_TEXT.to_owned(), vec![i]));
                continue;
            }
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
        let mut prev = TextCell::Text(GENESIS_MAC.to_owned());
        for e in rows {
            if e.seq != expected {
                let detail = format!(
                    "expected entry {}, found {}",
                    num_text(expected),
                    num_text(e.seq)
                );
                return Ok(fail(expected, VerifyFailure::SeqGap, &detail));
            }
            if !js_eq(e.prev_cell(), prev.as_ref())? {
                return Ok(fail(
                    e.seq,
                    VerifyFailure::PrevMismatch,
                    "the entry does not chain to its predecessor",
                ));
            }
            let mac = self.hmac_hex(&e.mac_input_after(prev.as_ref()));
            if !js_eq(e.mac_cell(), TextRef::Text(&mac))? {
                return Ok(fail(
                    e.seq,
                    VerifyFailure::MacMismatch,
                    "the entry's MAC does not verify",
                ));
            }
            prev = e.mac_cell().owned();
            expected += 1.0;
        }

        let head = conn
            .query_row(
                "SELECT seq, mac, tag FROM chain_head WHERE id = 1",
                [],
                |r| {
                    let cell = |i: usize| -> plur1bus_store::rusqlite::Result<Option<TextCell>> {
                        Ok(match r.get_ref(i)? {
                            ValueRef::Text(t) => {
                                Some(TextCell::Text(String::from_utf8_lossy(t).into_owned()))
                            }
                            ValueRef::Blob(b) => Some(TextCell::Bytes(b.to_vec())),
                            _ => None,
                        })
                    };
                    Ok((number(r.get_ref(0)?), cell(1)?, cell(2)?))
                },
            )
            .optional()?;
        let head = match head {
            Some((seq, mac, tag)) => Some((seq?, mac, tag)),
            None => None,
        };
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
            // A number in a text column of the head (SQLite stores none there) is refused as a non-match.
            let tag_ok = |seq: f64, mac: &Option<TextCell>, tag: &Option<TextCell>| match (mac, tag)
            {
                (Some(mac), Some(tag)) => js_eq(
                    tag.as_ref(),
                    TextRef::Text(&self.tag_of(seq, mac.as_ref().json())),
                ),
                _ => Ok(false),
            };
            let head = match head {
                Some((s, m, t)) if tag_ok(s, &m, &t)? => Some((s, m)),
                _ => None,
            };
            let Some((seq, mac)) = head else {
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
            let mac = mac.unwrap_or(TextCell::Text(String::new()));
            if !js_eq(mac.as_ref(), rows[n - 1].mac_cell())? {
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
        let last = rows.last();
        Ok(VerifyResult::Ok {
            entries: n,
            head: last.map(|l| {
                (
                    n,
                    String::from_utf8_lossy(l.mac_cell().bytes()).into_owned(),
                )
            }),
            head_mac_blob: last.is_some_and(|l| matches!(l.mac_cell(), TextRef::Bytes(_))),
            signatures: sig,
        })
    }

    /// `verifyDecisionSignature(e.mac, row.public_key, row.signature)` and the signer's key. `Buffer.from(v, enc)` of a
    /// `Uint8Array` copies its bytes and ignores the encoding, so a blob is used as it is: a blob key holding the DER verifies
    /// (and is never the signer's, a string); a blob MAC is its 64 ASCII bytes, not the 32 the signature covers.
    fn signature_ok(&self, e: &ChainEntry, row: &SignatureRow) -> bool {
        let (Some(public_key), Some(signature)) = (&row.public_key, &row.signature) else {
            return false; // `Buffer.from` of a number throws inside the verifier's try: not verified
        };
        let decode = |c: &TextCell| match c {
            TextCell::Text(t) => base64_decode(t),
            TextCell::Bytes(b) => b.clone(),
        };
        let message = match e.mac_cell() {
            TextRef::Text(t) => hex_decode(t),
            TextRef::Bytes(b) => b.to_vec(),
        };
        let crypto_ok = verify_decoded(&message, &decode(public_key), &decode(signature));
        let key_ok = self.signer.as_deref().is_none_or(
            |s| matches!(public_key, TextCell::Text(k) if k.as_str() == s.public_key()),
        );
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
        self.append_ref(conn, kind, TextRef::Text(ref_id), payload, nonce)
    }

    /// `append` with a `refId` that is a `Uint8Array`: a grant revoked by the id a blob column held (`endTask` and
    /// `endSession` read the ids from the table). TypeScript stores it as a blob and MACs its `JSON.stringify`.
    pub fn append_blob_ref(
        &self,
        conn: &Connection,
        kind: &str,
        ref_id: &[u8],
        payload: &J,
    ) -> Result<ChainEntry, ChainError> {
        self.append_ref(conn, kind, TextRef::Bytes(ref_id), payload, None)
    }

    fn append_ref(
        &self,
        conn: &Connection,
        kind: &str,
        ref_id: TextRef<'_>,
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
        ref_id: TextRef<'_>,
        payload: &J,
        nonce: Option<&str>,
    ) -> Result<ChainEntry, ChainError> {
        let snap = self.snapshot(conn)?;
        if let Some(e) = snap.broken() {
            return Err(e);
        }
        let last = snap.entries.last();
        // The predecessor as TypeScript holds it: a blob `mac` that verified is carried on as a `Uint8Array`, enters the
        // MAC as an object and is stored as a blob again.
        let prev = last.map_or(TextCell::Text(GENESIS_MAC.to_owned()), |l| {
            l.mac_cell().owned()
        });
        let seq = last.map_or(0.0, |l| l.seq) + 1.0;
        let ts = self.clock.now() as f64;
        let payload = payload.stringify();
        let mut blobs = Blobs::default();
        let ref_text = match ref_id {
            TextRef::Text(t) => t.to_owned(),
            TextRef::Bytes(b) => {
                blobs.ref_id = Some(b.to_vec());
                BLOB_TEXT.to_owned()
            }
        };
        let mut entry = ChainEntry {
            seq,
            ts,
            kind: kind.to_owned(),
            ref_id: ref_text,
            nonce: nonce.map(str::to_owned),
            payload,
            prev_mac: String::new(),
            mac: String::new(),
            blobs: (blobs != Blobs::default()).then(|| Box::new(blobs)),
        };
        let mac = self.hmac_hex(&entry.mac_input_after(prev.as_ref()));
        self.bump();
        let sql = |c: TextRef<'_>| match c {
            TextRef::Text(t) => SqlValue::Text(t.to_owned()),
            TextRef::Bytes(b) => SqlValue::Blob(b.to_vec()),
        };
        let (prev_sql, ref_sql) = (sql(prev.as_ref()), sql(ref_id));
        conn.execute(
            "INSERT INTO approval_chain (seq, ts, kind, ref_id, nonce, payload, prev_mac, mac) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![seq as i64, ts as i64, kind, ref_sql, nonce, entry.payload, prev_sql, mac],
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
        match prev {
            TextCell::Text(t) => entry.prev_mac = t,
            TextCell::Bytes(b) => {
                entry.prev_mac = BLOB_TEXT.to_owned();
                entry.blobs.get_or_insert_with(Box::default).prev_mac = Some(b);
            }
        }
        entry.mac = mac;
        Ok(entry)
    }
}

/// `public_key` and `signature` as TypeScript sees them (`None` for a number, which SQLite does not store in a text column).
struct SignatureRow {
    public_key: Option<TextCell>,
    signature: Option<TextCell>,
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
        ValueRef::Text(t) => Some(TextCell::Text(String::from_utf8_lossy(t).into_owned())),
        ValueRef::Blob(b) => Some(TextCell::Bytes(b.to_vec())),
        _ => None,
    };
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        out.insert(
            number(r.get_ref(0)?)?.to_bits(),
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
