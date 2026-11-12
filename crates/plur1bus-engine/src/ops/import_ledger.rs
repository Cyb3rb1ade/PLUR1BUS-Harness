//! Durable import receipts and last-line-wins indices. The stored card remains authoritative.
use super::import_primitives::field;
use crate::{
    contract::StoreError,
    store::ledger::JsonlLedger,
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue as Json},
    },
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

/// One valid receipt, retaining unknown fields and legacy UTF-16 without normalization.
#[derive(Clone, Debug)]
pub struct ImportLine {
    /// Original parseable JSON object.
    pub raw: Json,
    /// Exact caller idempotency key.
    pub key: JsString,
    /// Exact stored card ID.
    pub card_id: JsString,
}
impl ImportLine {
    fn parse(raw: Json) -> Option<Self> {
        if !matches!(field(&raw, "v"), Some(Json::Number(n)) if n.parse::<f64>() == Ok(1.)) {
            return None;
        }
        let (Some(Json::String(key)), Some(Json::String(card_id))) =
            (field(&raw, "idempotencyKey"), field(&raw, "cardId"))
        else {
            return None;
        };
        Some(Self {
            key: key.clone(),
            card_id: card_id.clone(),
            raw,
        })
    }
}

/// Import and unimport receipts folded in file order; unknown kinds do not affect indices.
#[derive(Default)]
pub struct ImportIndex {
    /// Latest import receipt per idempotency key.
    pub by_key: HashMap<JsString, ImportLine>,
    /// Latest import receipt per card ID.
    pub by_card_id: HashMap<JsString, ImportLine>,
    /// Latest unimport receipt, removed when the card is imported again.
    pub unimported_by_card_id: HashMap<JsString, ImportLine>,
}
impl ImportIndex {
    fn from_lines(lines: Vec<ImportLine>) -> Self {
        let mut index = Self::default();
        for row in lines {
            match field(&row.raw, "kind") {
                Some(Json::String(kind)) if *kind == JsString::from("unimported") => {
                    if index
                        .by_key
                        .get(&row.key)
                        .is_some_and(|old| old.card_id == row.card_id)
                    {
                        index.by_key.remove(&row.key);
                    }
                    index.by_card_id.remove(&row.card_id);
                    index.unimported_by_card_id.insert(row.card_id.clone(), row);
                }
                None | Some(Json::Null) => {
                    index.by_key.insert(row.key.clone(), row.clone());
                    index.unimported_by_card_id.remove(&row.card_id);
                    index.by_card_id.insert(row.card_id.clone(), row);
                }
                _ => {}
            }
        }
        index
    }
}

/// Per-agent JSONL sidecars. Mutation callers hold the corresponding import lease.
pub struct ImportLedger {
    base: PathBuf,
}
impl ImportLedger {
    /// Construct a handle without creating a directory or a file.
    pub fn new(base: &Path) -> Self {
        Self {
            base: base.to_owned(),
        }
    }
    fn path(&self, agent: &str) -> Result<PathBuf, StoreError> {
        crate::context::safe_agent_id(agent).map_err(|_| StoreError::Corrupt)?;
        Ok(self.base.join("_imports").join(format!("{agent}.jsonl")))
    }
    /// Read every valid V1 receipt in order; torn/foreign lines are ignored individually.
    /// Invalid agent IDs produce an empty read without opening a path, as in Node.
    pub fn read_lines(&self, agent: &str) -> Result<Vec<ImportLine>, StoreError> {
        let Ok(path) = self.path(agent) else {
            return Ok(Vec::new());
        };
        let ledger = JsonlLedger::<Json>::open(&path)?;
        Ok(ledger
            .snapshot()?
            .lines()
            .filter_map(|line| parse_json(line).ok().and_then(ImportLine::parse))
            .collect())
    }
    /// Fold the ledger without changing any persistent state.
    pub fn load(&self, agent: &str) -> Result<ImportIndex, StoreError> {
        Ok(ImportIndex::from_lines(self.read_lines(agent)?))
    }
    /// Project schema-owned receipt fields, append and fsync before returning success.
    /// A torn preceding line is terminated by the shared durable ledger primitive.
    pub fn append(&self, agent: &str, row: &Json) -> Result<(), StoreError> {
        let path = self.path(agent)?;
        let mut fields = vec![(JsString::from("v"), Json::Number("1".to_owned()))];
        let unimported = matches!(field(row, "kind"), Some(Json::String(kind)) if *kind == JsString::from("unimported"));
        let keys: &[&str] = if unimported {
            &["kind", "idempotencyKey", "cardId", "importRunId", "at"]
        } else {
            &["idempotencyKey", "cardId", "importedAt"]
        };
        for key in keys {
            if let Some(value) = field(row, key) {
                fields.push(((*key).into(), value.clone()));
            }
        }
        if !unimported {
            let source = match field(row, "sourceRef") {
                Some(Json::String(source)) => source.clone(),
                _ => JsString::default(),
            };
            fields.push(("sourceRef".into(), Json::String(source)));
            if let Some(Json::String(run)) =
                field(row, "importRunId").filter(|v| matches!(v, Json::String(s) if !s.is_empty()))
            {
                fields.push(("importRunId".into(), Json::String(run.clone())));
            }
            if field(row, "backfilled") == Some(&Json::Bool(true)) {
                fields.push(("backfilled".into(), Json::Bool(true)));
            }
            if let Some(digest @ (Json::Array(_) | Json::Object(_))) = field(row, "digest") {
                fields.push(("digest".into(), digest.clone()));
            }
        }
        let receipt = Json::Object(fields);
        if ImportLine::parse(receipt.clone()).is_none() {
            return Err(StoreError::Corrupt);
        }
        JsonlLedger::<Json>::open(&path)?.append_durable(&receipt)
    }
}
