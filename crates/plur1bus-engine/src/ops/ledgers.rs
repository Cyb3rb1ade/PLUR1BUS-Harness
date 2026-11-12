//! Per-agent sidecar views. Read errors hide provenance, never the underlying card.
use crate::{contract::StoreError, store::ledger::JsonlLedger, text::json::TolerantJsonValue};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};

pub(super) struct Provenance {
    imports: BTreeMap<String, Value>,
    links: BTreeMap<String, Vec<Value>>,
}
impl Provenance {
    pub fn load(base: &Path, agent: &str) -> Self {
        let mut imports = BTreeMap::new();
        for row in lines(&base.join("_imports").join(format!("{agent}.jsonl"))).unwrap_or_default()
        {
            let (Some(card), Some(_key)) = (row["cardId"].as_str(), row["idempotencyKey"].as_str())
            else {
                continue;
            };
            if row["v"].as_f64() != Some(1.) {
                continue;
            }
            if row["kind"] == "unimported" {
                imports.remove(card);
            } else if row["kind"].is_null() {
                imports.insert(card.to_owned(), row);
            }
        }
        let mut latest = BTreeMap::new();
        for (order, row) in lines(&base.join("_links").join(format!("{agent}.jsonl")))
            .unwrap_or_default()
            .into_iter()
            .enumerate()
        {
            let (Some(link), Some(_card)) = (row["linkId"].as_str(), row["cardId"].as_str()) else {
                continue;
            };
            if row["v"].as_f64() != Some(1.)
                || !matches!(row["kind"].as_str(), Some("linked" | "unlinked"))
                || (row["kind"] == "linked" && !row["sourceRef"].is_string())
            {
                continue;
            }
            latest.insert(link.to_owned(), (order, row));
        }
        let mut ordered: Vec<_> = latest.into_values().collect();
        ordered.sort_by_key(|(order, _)| *order);
        let mut links: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for (_, row) in ordered {
            if row["kind"] == "unlinked" {
                continue;
            }
            let Some(card) = row["cardId"].as_str() else {
                continue;
            };
            links.entry(card.to_owned()).or_default().push(row);
        }
        for rows in links.values_mut() {
            rows.sort_by(|a, b| number(&a["at"]).total_cmp(&number(&b["at"])));
        }
        Self { imports, links }
    }
    pub fn apply(&self, card: &mut Value) {
        let id = card["id"].as_str().unwrap_or("").to_owned();
        if let Some(imported) = self.imports.get(&id) {
            card["provenance"] = json!("imported");
            if imported["sourceRef"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
            {
                card["sourceRef"] = imported["sourceRef"].clone();
            }
        }
        if let Some(links) = self.links.get(&id).filter(|rows| !rows.is_empty()) {
            card["links"] = Value::Array(links.iter().map(|row| json!({ "linkId": row["linkId"], "sourceRef": row["sourceRef"], "provenance": "imported", "importRunId": row["importRunId"].as_str().filter(|s| !s.is_empty()), "linkedAt": number(&row["at"]) })).collect());
        }
    }
}
fn number(value: &Value) -> f64 {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
        .filter(|n| n.is_finite())
        .unwrap_or(0.)
}
fn lines(path: &Path) -> Option<Vec<Value>> {
    read_lines(path).ok()
}

// Write-side classification must distinguish an unreadable ledger from an empty one.
pub(super) fn read_lines(path: &Path) -> Result<Vec<Value>, StoreError> {
    let ledger = JsonlLedger::<TolerantJsonValue>::open(path)?;
    let text = ledger.snapshot()?;
    let mut rows = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        // Node ignores malformed/foreign lines individually.
        if let Ok(row) = crate::text::json::parse_json(line) {
            rows.push(super::json_fields::project(
                &row,
                &[
                    "v",
                    "cardId",
                    "idempotencyKey",
                    "kind",
                    "sourceRef",
                    "linkId",
                    "at",
                    "importRunId",
                ],
            ));
        }
    }
    Ok(rows)
}
