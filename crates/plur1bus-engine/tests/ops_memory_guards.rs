//! C7 decisions recorded from Node source and the actual model-facing forget tool.
#![allow(clippy::unwrap_used, reason = "synthetic golden assertions")]
use plur1bus_engine::{
    capture::dynamics::merged_expires_at,
    ops::memory_guards::*,
    text::json::{parse_json, TolerantJsonValue as Json},
};
use serde_json::{json, Value};
fn raw(value: &Value) -> Json {
    parse_json(&value.to_string()).unwrap()
}
fn value(v: &Value) -> Option<Json> {
    match v["tag"].as_str() {
        Some("undefined") => None,
        Some("nan") => Some(Json::Number("NaN".into())),
        Some("infinity") => Some(Json::Number("Infinity".into())),
        Some("negative-infinity") => Some(Json::Number("-Infinity".into())),
        _ => Some(raw(v)),
    }
}
fn number(v: &Value) -> f64 {
    match v["tag"].as_str() {
        Some("nan") => f64::NAN,
        Some("infinity") => f64::INFINITY,
        Some("negative-infinity") => f64::NEG_INFINITY,
        _ => v.as_f64().unwrap_or(f64::NAN),
    }
}
#[test]
fn node_store_validation_and_own_property_ttls() {
    let g: Value = serde_json::from_str(include_str!("fixtures/ops/golden/guards.json")).unwrap();
    for c in g["store"].as_array().unwrap() {
        let params = if let Some(r) = c.get("repeat") {
            json!({"text":r["unit"].as_str().unwrap().repeat(r["count"].as_u64().unwrap() as usize)})
        } else {
            c["params"].clone()
        };
        let result = match validate_store(&raw(&params)) {
            Ok(()) => json!({"ok":true}),
            Err(e) => json!({"ok":false,"reason":e.reason,"error":e.error}),
        };
        assert_eq!(result, c["result"], "{c}");
    }
    let map = raw(&g["ttlMap"]);
    for c in g["ttl"].as_array().unwrap() {
        assert_eq!(
            resolve_ttl_ms(&map, Some(&raw(&c["input"]))),
            c["result"].as_f64().unwrap(),
            "{c}"
        );
    }
    // These keys are legitimate only when explicitly present, never via Object's prototype.
    let own = raw(&json!({"constructor":12,"toString":13,"__proto__":14}));
    for (k, v) in [("constructor", 12.), ("toString", 13.), ("__proto__", 14.)] {
        assert_eq!(resolve_ttl_ms(&own, Some(&raw(&json!(k)))), v);
    }
}
#[test]
fn node_merge_permanence_and_core_ttl_conflicts() {
    let g: Value = serde_json::from_str(include_str!("fixtures/ops/golden/guards.json")).unwrap();
    for c in g["merge"].as_array().unwrap() {
        assert_eq!(
            merged_expires_at(value(&c["a"]).as_ref(), value(&c["b"]).as_ref()),
            c["result"].as_f64().unwrap(),
            "{c}"
        );
    }
    for c in g["expiry"].as_array().unwrap() {
        let result = match store_expiry(1800000000000., number(&c["ttl"]), number(&c["importance"]))
        {
            Ok(expires) => json!({"expiresAt":expires}),
            Err(e) => json!({"reason":e.reason}),
        };
        assert_eq!(result.get("reason"), c["result"].get("reason"), "{c}");
        assert_eq!(
            result["expiresAt"].as_f64(),
            c["result"]["expiresAt"].as_f64(),
            "{c}"
        );
    }
    for c in g["storeTool"].as_array().unwrap() {
        let ttl = resolve_ttl_ms(&raw(&g["ttlMap"]), Some(&raw(&c["ttl"])));
        let error = store_expiry(1800000000000., ttl, number(&c["importance"])).unwrap_err();
        assert_eq!(error.reason, c["result"]["details"]["reason"]);
        assert_eq!(c["embedded"], 1);
    }
}
#[test]
fn actual_node_tool_query_forget_requires_a_single_sufficiently_similar_visible_hit() {
    let g: Value = serde_json::from_str(include_str!("fixtures/ops/golden/guards.json")).unwrap();
    for c in g["forget"].as_array().unwrap() {
        let scores = c["scores"]
            .as_array()
            .unwrap()
            .iter()
            .map(number)
            .collect::<Vec<_>>();
        let decision = forget_by_query(&scores, number(&c["threshold"]), c["disabled"] != true);
        assert_eq!(json!(decision), c["decision"], "{c}");
        assert_eq!(
            decision == ForgetDecision::Forget,
            c["calls"]["forget"] == 1
        );
        if decision == ForgetDecision::Blocked {
            assert_eq!(c["calls"], json!({"open":0,"embed":0,"forget":0}));
        }
    }
}
