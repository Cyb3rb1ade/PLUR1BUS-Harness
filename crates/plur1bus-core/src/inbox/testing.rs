//! Test doubles and JSON helpers of the inbox: a clock and an id source a scenario drives, a store over a temporary file, and the
//! shapes (`draft`, `notice`, `entry`, `page`) the recorded scenarios use.
use super::service::{InboxNotice, InboxTarget};
use super::{
    InboxCounts, InboxDraft, InboxError, InboxPage, InboxRef, InboxStore, InboxStoreOptions,
};
use crate::budget::{Clock, IdSource};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;

pub(crate) struct TestClock(pub AtomicI64);
impl Clock for TestClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// `e1`, `e2`, ...: the `idGen` of the exporter.
#[derive(Default)]
pub(crate) struct SeqIds(pub AtomicU64);
impl IdSource for SeqIds {
    fn next_id(&self) -> String {
        format!("e{}", self.0.fetch_add(1, Ordering::SeqCst) + 1)
    }
}

pub(crate) fn open(
    path: PathBuf,
    clock: Arc<TestClock>,
    ids: Arc<SeqIds>,
    max_age_ms: Option<f64>,
    max_entries: Option<f64>,
) -> Result<InboxStore, InboxError> {
    InboxStore::open(InboxStoreOptions {
        path,
        clock,
        max_age_ms,
        max_entries,
        ids: Some(ids),
        secure_path: Some(Box::new(|_| true)),
    })
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_owned()
}

pub(crate) fn reference_of(v: &Value) -> Option<InboxRef> {
    v.as_object().map(|o| InboxRef {
        route: o.get("route").and_then(Value::as_str).map(str::to_owned),
        object_id: o.get("objectId").and_then(Value::as_str).map(str::to_owned),
    })
}

fn params_of(v: &Value) -> Option<Vec<(String, Value)>> {
    v.as_object()
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

pub(crate) fn draft_of(v: &Value) -> InboxDraft {
    InboxDraft {
        user_id: s(&v["userId"]),
        kind: s(&v["kind"]),
        severity: s(&v["severity"]),
        title_key: s(&v["titleKey"]),
        params: params_of(&v["params"]),
        reference: reference_of(&v["ref"]),
        dedupe_key: s(&v["dedupeKey"]),
    }
}

pub(crate) fn notice_of(v: &Value) -> InboxNotice {
    let d = draft_of(v);
    InboxNotice {
        target: match v["userId"].as_str() {
            Some(u) => InboxTarget::User(u.to_owned()),
            None => InboxTarget::Admins,
        },
        kind: d.kind,
        severity: d.severity,
        title_key: d.title_key,
        params: d.params,
        reference: d.reference,
        dedupe_key: d.dedupe_key,
    }
}

pub(crate) fn err_json(e: &InboxError) -> Value {
    match e.code() {
        Some(code) => json!({"name": "InboxError", "code": code, "message": e.to_string()}),
        None => json!({"name": "Error", "message": e.to_string()}),
    }
}

pub(crate) fn page_json(p: &InboxPage) -> Value {
    let mut o = json!({"entries": p.entries.iter().map(|e| json!({
        "id": e.id, "kind": e.kind, "severity": e.severity, "titleKey": e.title_key, "params": e.params,
        "ref": e.reference, "createdAt": e.created_at, "readAt": e.read_at, "dismissedAt": e.dismissed_at,
    })).collect::<Vec<_>>()});
    if let Some(c) = &p.next_cursor {
        o["nextCursor"] = json!(c);
    }
    o
}

pub(crate) fn counts_json(c: &InboxCounts) -> Value {
    let mut m = serde_json::Map::new();
    for (k, n) in &c.unread {
        m.insert(k.clone(), json!(n));
    }
    json!({"unread": m, "total": c.total})
}
