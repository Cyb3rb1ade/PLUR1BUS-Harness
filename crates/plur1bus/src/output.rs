use plur1bus_rpc::RpcError;
use serde::Serialize;
use serde_json::{json, Value};

pub struct Out {
    pub json: bool,
}

/// Inserts the top-level `"schema"` id into a `--json` document (ADR-016 §8). `value` must
/// serialize to a JSON object — every CLI document does, including the raw RPC result (ruling
/// R13: this is the *only* key `ok`/`fail` add on top of it) and the hand-built stub/error/
/// journaled/degraded documents. Debug-asserted rather than `Result`-returned: a document that
/// isn't an object is a programming bug at the call site, not a runtime condition to handle.
fn document(schema: &str, mut value: Value) -> Value {
    debug_assert!(
        value.is_object(),
        "--json document must be a JSON object, got {value}"
    );
    if let Some(map) = value.as_object_mut() {
        map.insert("schema".to_string(), json!(schema));
    }
    value
}

/// Exit code for a mapped RPC error code (per G18/carry-over from Task 4 review):
/// `E_LOCKED` → 3, `E_NOT_AVAILABLE` and `E_APPROVAL_REQUIRED` → 2 (a script run that hits
/// `E_APPROVAL_REQUIRED` must not report success), everything else → 1.
fn exit_code_for(code_name: &str) -> i32 {
    match code_name {
        "E_LOCKED" => 3,
        "E_NOT_AVAILABLE" => 2,
        "E_APPROVAL_REQUIRED" => 2,
        _ => 1,
    }
}

impl Out {
    /// Prints `value` as `--json` (the raw RPC/CLI value, `schema: "<schema>"` inserted at the
    /// top level per ADR-016 §8 and ruling R13) or `human()` otherwise.
    pub fn ok<T: Serialize>(&self, schema: &str, value: &T, human: impl FnOnce() -> String) {
        if self.json {
            let v = serde_json::to_value(value).unwrap();
            println!("{}", serde_json::to_string(&document(schema, v)).unwrap());
        } else {
            println!("{}", human());
        }
    }
    /// Prints an error and exits. JSON goes to stdout (stable shape, `schema: "error/1"`), human
    /// text to stderr.
    pub fn fail(&self, code: &str, message: &str, extra: serde_json::Value, exit: i32) -> ! {
        if self.json {
            let mut v = json!({ "error": code, "message": message });
            if let (Some(a), Some(b)) = (v.as_object_mut(), extra.as_object()) {
                for (k, x) in b {
                    a.insert(k.clone(), x.clone());
                }
            }
            println!("{}", document("error/1", v));
        } else {
            eprintln!("plur1bus: {message}");
            if let Some(line) = ids_line(&extra) {
                eprintln!("{line}");
            }
        }
        std::process::exit(exit)
    }
    // `from_*` here is the brief's literal interface name for a "build+emit error
    // from an RpcError" helper, not a `From` conversion, so it legitimately takes `&self`.
    #[allow(clippy::wrong_self_convention)]
    pub fn from_rpc_error(&self, e: &RpcError) -> ! {
        let extra = rpc_error_extra(e);
        self.fail(
            &e.code_name(),
            &e.to_string(),
            extra,
            exit_code_for(&e.code_name()),
        )
    }
}

/// The `reason`/`detail`/`ids` `--json` fields for an `RpcError` (Task 4 carry-over review, G7):
/// `error.data.reason`, `error.data.detail` and `error.data.ids` (non-secret recovery ids, e.g.
/// a half-finished shared-copy refresh) survive onto the CLI's error document when the core sent
/// them. Split out from `from_rpc_error` so it is unit-testable without exercising `process::exit`.
fn rpc_error_extra(e: &RpcError) -> Value {
    let mut extra = json!({});
    if let RpcError::Call { reason, detail, .. } = e {
        if let Some(r) = reason {
            extra["reason"] = json!(r);
        }
        if let Some(d) = detail {
            extra["detail"] = json!(d);
        }
    }
    if let Some(ids) = e.ids() {
        extra["ids"] = json!(ids);
    }
    extra
}

/// The human `ids: k=v …` line (keys sorted) for an error document's `ids`, so the recovery ids of
/// e.g. a half-finished shared-copy refresh are not `--json`-only; `None` without ids.
fn ids_line(extra: &Value) -> Option<String> {
    let ids = extra.get("ids")?.as_object()?;
    if ids.is_empty() {
        return None;
    }
    let mut pairs: Vec<(&String, &Value)> = ids.iter().collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    let text = pairs
        .iter()
        .map(|(k, v)| match v.as_str() {
            Some(s) => format!("{k}={s}"),
            None => format!("{k}={v}"),
        })
        .collect::<Vec<_>>()
        .join(" ");
    Some(format!("ids: {text}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_inserts_schema_at_the_top_level() {
        let v = document("memory.recall/1", json!({ "blocks": [] }));
        assert_eq!(v["schema"], "memory.recall/1");
        assert_eq!(v["blocks"], json!([]));
    }

    #[test]
    fn document_leaves_the_rest_of_the_value_untouched() {
        let v = document(
            "agent.list/1",
            json!({ "agents": ["bernd"], "core": "ready" }),
        );
        assert_eq!(v["agents"], json!(["bernd"]));
        assert_eq!(v["core"], "ready");
        assert_eq!(
            v.as_object().unwrap().len(),
            3,
            "only `schema` is added on top of the original keys"
        );
    }

    #[test]
    fn exit_codes_map_e_approval_required_and_e_locked_and_e_not_available() {
        assert_eq!(exit_code_for("E_LOCKED"), 3);
        assert_eq!(exit_code_for("E_NOT_AVAILABLE"), 2);
        assert_eq!(
            exit_code_for("E_APPROVAL_REQUIRED"),
            2,
            "G18: a script run that hits E_APPROVAL_REQUIRED must exit 2, not report success"
        );
        assert_eq!(exit_code_for("E_DENIED"), 1);
        assert_eq!(exit_code_for("E_INTERNAL"), 1);
    }

    #[test]
    fn error_documents_carry_reason_detail_and_ids() {
        use std::collections::BTreeMap;
        let mut ids = BTreeMap::new();
        ids.insert("sourceId".to_string(), "abc".to_string());
        ids.insert("sharedId".to_string(), "def".to_string());
        let e = RpcError::Call {
            error: serde_json::from_value(json!("E_STORAGE")).unwrap(),
            jsonrpc: 2,
            message: "shared-copy refresh failed halfway".into(),
            reason: Some("storage".into()),
            detail: Some("write failed".into()),
            ids: Some(ids),
        };
        // Build the same document from_rpc_error would emit, without exercising process::exit.
        let extra = rpc_error_extra(&e);
        let mut v = json!({ "error": e.code_name(), "message": e.to_string() });
        if let (Some(a), Some(b)) = (v.as_object_mut(), extra.as_object()) {
            for (k, x) in b {
                a.insert(k.clone(), x.clone());
            }
        }
        let doc = document("error/1", v);
        assert_eq!(doc["schema"], "error/1");
        assert_eq!(doc["error"], "E_STORAGE");
        assert_eq!(doc["reason"], "storage");
        assert_eq!(doc["detail"], "write failed");
        assert_eq!(doc["ids"]["sourceId"], "abc");
        assert_eq!(doc["ids"]["sharedId"], "def");
    }

    #[test]
    fn human_errors_print_ids_in_stable_key_order() {
        let extra = json!({ "reason": "storage", "ids": { "staleSharedId": "c", "sourceId": "a", "sharedId": "b" } });
        assert_eq!(
            ids_line(&extra).as_deref(),
            Some("ids: sharedId=b sourceId=a staleSharedId=c")
        );
        assert_eq!(ids_line(&json!({ "reason": "storage" })), None);
        assert_eq!(ids_line(&json!({ "ids": {} })), None);
    }
}
