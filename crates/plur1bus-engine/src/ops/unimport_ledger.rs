//! Per-run write-ahead rollback markers. They distinguish unimport from a human forget.
use super::{
    context::error,
    import_lock::ImportLease,
    import_primitives::{field, number},
    journal,
    link::valid_run_id,
};
use crate::{
    contract::{EngineError, MemoryOpErrorCode},
    store::{ledger::JsonlLedger, paths::assert_trusted_path},
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue as Json},
    },
};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
fn storage<T>(_: T) -> EngineError {
    error(MemoryOpErrorCode::Storage)
}
fn imported_at(value: Option<&Json>) -> f64 {
    let n = value.map_or(0., number);
    if n.is_nan() {
        0.
    } else {
        n
    }
}
/// Node's exact `(cardId, Number(importedAt) || 0)` marker, including legacy UTF-16 IDs.
pub fn marker_key(card: &JsString, time: Option<&Json>) -> JsString {
    let mut units = card.as_utf16_units().to_vec();
    units.push(0);
    units.extend(
        ryu_js::Buffer::new()
            .format(imported_at(time))
            .encode_utf16(),
    );
    JsString::from_utf16_units(units)
}
/// Snapshot read without lock or mutation. Markers preserve distinct reimports of the same key.
#[derive(Default)]
pub struct UnimportState {
    /// Whether the sidecar file is present, even when it has no valid header.
    pub exists: bool,
    /// Last valid header; opaque legacy fields are retained.
    pub header: Option<Json>,
    /// Durable delete intents, keyed by card and original import timestamp.
    pub intents: HashSet<JsString>,
    /// Completed key-release markers with the same generation key.
    pub done: HashSet<JsString>,
}
/// The selected import generation, shared by intent and completion records.
#[derive(Clone)]
pub struct UndoReceipt {
    /// Exact deterministic card identity from its import receipt.
    pub card_id: JsString,
    /// Exact caller idempotency key; opaque UTF-16 stays lossless.
    pub idempotency_key: JsString,
    /// Original import timestamp, distinguishing repeated imports under one run.
    pub imported_at: f64,
}
/// Non-creating handle. Every write requires the caller's import/unimport lease.
pub struct UnimportLedger {
    base: PathBuf,
}
impl UnimportLedger {
    /// Use the same base as import, link and the active agent store.
    pub fn new(base: &Path) -> Self {
        Self {
            base: base.to_owned(),
        }
    }
    fn path(&self, agent: &str, run: &str) -> Result<PathBuf, EngineError> {
        crate::context::safe_agent_id(agent).map_err(|_| error(MemoryOpErrorCode::InvalidInput))?;
        if !valid_run_id(run) {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let path = self
            .base
            .join("_unimports")
            .join(agent)
            .join(format!("{run}.jsonl"));
        assert_trusted_path(&path).map_err(storage)?;
        Ok(path)
    }
    /// A malformed/foreign line never hides subsequent valid markers; hard I/O errors abort.
    pub fn load(&self, agent: &str, run: &str) -> Result<UnimportState, EngineError> {
        let path = self.path(agent, run)?;
        match fs::metadata(&path) {
            Ok(m) if m.is_file() => {}
            Ok(_) => return Err(error(MemoryOpErrorCode::Storage)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(UnimportState::default())
            }
            Err(e) => return Err(storage(e)),
        };
        let mut out = UnimportState {
            exists: true,
            ..Default::default()
        };
        for line in JsonlLedger::<Json>::open(&path)
            .map_err(storage)?
            .snapshot()
            .map_err(storage)?
            .lines()
        {
            let Ok(row) = parse_json(line) else { continue };
            if !matches!(field(&row,"v"),Some(Json::Number(n)) if n.parse::<f64>()==Ok(1.)) {
                continue;
            }
            let kind = super::rebind_ledger::string(&row, "kind");
            match kind.as_deref() {
                Some("header") => out.header = Some(row),
                Some("intent" | "done") => {
                    if let Some(Json::String(card)) = field(&row, "cardId") {
                        let key = marker_key(card, field(&row, "importedAt"));
                        if kind.as_deref() == Some("intent") {
                            out.intents.insert(key);
                        } else {
                            out.done.insert(key);
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(out)
    }
    /// Repair/quarantine the sidecar before a store write, never as part of dry-run.
    pub fn prepare(
        &self,
        agent: &str,
        run: &str,
        now: i64,
        lease: &ImportLease,
    ) -> Result<(), EngineError> {
        journal::prepare(&self.path(agent, run)?, now, &|| lease.assert_held())
    }
    fn append(
        &self,
        agent: &str,
        run: &str,
        row: &Json,
        now: i64,
        lease: &ImportLease,
    ) -> Result<(), EngineError> {
        journal::append(&self.path(agent, run)?, row, now, false, &|| {
            lease.assert_held()
        })
    }
    /// Append the header only when none is readable. Always called after prepare.
    pub fn ensure_header(
        &self,
        agent: &str,
        run: &str,
        now: i64,
        lease: &ImportLease,
    ) -> Result<(), EngineError> {
        if self.load(agent, run)?.header.is_some() {
            return Ok(());
        }
        let row=parse_json(&serde_json::json!({"v":1,"kind":"header","agentId":agent,"importRunId":run,"createdAt":now}).to_string()).map_err(storage)?;
        self.append(agent, run, &row, now, lease)
    }
    /// Archive first, then persist this intent before deleting the row.
    pub fn append_intent(
        &self,
        agent: &str,
        run: &str,
        receipt: &UndoReceipt,
        now: i64,
        lease: &ImportLease,
    ) -> Result<(), EngineError> {
        let row = Json::Object(vec![
            ("v".into(), Json::Number("1".into())),
            ("kind".into(), Json::String("intent".into())),
            ("cardId".into(), Json::String(receipt.card_id.clone())),
            (
                "idempotencyKey".into(),
                Json::String(receipt.idempotency_key.clone()),
            ),
            ("importedAt".into(), time_json(receipt.imported_at)),
            ("archived".into(), Json::Bool(true)),
        ]);
        self.append(agent, run, &row, now, lease)
    }
    /// The import receipt must free the key before this completion marker is appended.
    pub fn append_done(
        &self,
        agent: &str,
        run: &str,
        receipt: &UndoReceipt,
        now: i64,
        lease: &ImportLease,
    ) -> Result<(), EngineError> {
        let row = Json::Object(vec![
            ("v".into(), Json::Number("1".into())),
            ("kind".into(), Json::String("done".into())),
            ("cardId".into(), Json::String(receipt.card_id.clone())),
            ("importedAt".into(), time_json(receipt.imported_at)),
        ]);
        self.append(agent, run, &row, now, lease)
    }
}
fn time_json(time: f64) -> Json {
    if time.is_nan() {
        Json::Number("0".into())
    } else if time.is_finite() {
        Json::Number(ryu_js::Buffer::new().format(time).to_owned())
    } else {
        Json::Null
    }
}
