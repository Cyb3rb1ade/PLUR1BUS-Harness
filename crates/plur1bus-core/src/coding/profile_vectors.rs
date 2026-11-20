use super::*;
use crate::prompt::telemetry::CACHE_MISS_CAUSES;
use serde_json::{json, Value};

fn read(s: &Value) -> CacheUsageSummary {
    let n = |key: &str| s[key].as_u64().unwrap();
    CacheUsageSummary {
        hits: n("hits"),
        misses: n("misses"),
        not_cacheable: n("notCacheable"),
        miss_causes: CACHE_MISS_CAUSES.map(|k| s["missCauses"][k].as_u64().unwrap()),
        cache_read_tokens: n("cacheReadTokens"),
        cache_creation_tokens: n("cacheCreationTokens"),
        input_tokens: n("inputTokens"),
        total_input_tokens: n("totalInputTokens"),
        hit_ratio: s["hitRatio"].as_f64().unwrap(),
        turns: n("turns"),
    }
}

#[test]
fn coding_profile_vectors() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/coding/profile.json"
    ))
    .unwrap();
    assert_eq!(json!(CODING_INSTRUCTIONS), data["instructions"]);
    assert_eq!(json!(CODING_TOOL_NAMES), data["tools"]);
    for case in data["cases"].as_array().unwrap() {
        let out = merge_cache_summaries(
            case["input"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|v| !v.is_null())
                .map(read),
        );
        let wire = out.map_or(Value::Null, |s| s.to_j().to_value());
        assert_eq!(wire, case["result"]);
    }
}
