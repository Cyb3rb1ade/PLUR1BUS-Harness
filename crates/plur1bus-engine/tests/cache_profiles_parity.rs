//! The provider-owned table and TypeScript-generated vectors are the compatibility contract for RE-14/T1.
#![cfg_attr(test, allow(clippy::unwrap_used))]

use plur1bus_engine::cache_profiles::{CacheProfileTable, CacheRoute};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

const TABLE: &str = include_str!("../../../packages/providers/schema/cache-profiles.json");

fn raw_table() -> Value {
    serde_json::from_str(TABLE).unwrap()
}

fn rejection(mut change: impl FnMut(&mut Value), expected: &str) {
    let mut raw = raw_table();
    change(&mut raw);
    let error = CacheProfileTable::load(&raw).unwrap_err().to_string();
    assert!(error.contains(expected), "{error}");
}

#[test]
fn rejects_tables_that_violate_the_shared_schema() {
    rejection(
        |raw| {
            raw["rows"][0].as_object_mut().unwrap().remove("source");
        },
        "source",
    );
    rejection(|raw| raw["rows"][0]["cost"] = json!(1), "cost");
    rejection(|raw| raw["rows"][0]["ttls"][0]["ttl"] = json!("2h"), "2h");
    rejection(|raw| raw["rows"][0]["minTokens"] = json!(0), "minTokens");
    rejection(|raw| raw["rows"][0]["warmMs"] = json!(-1), "warmMs");
    rejection(|raw| raw["version"] = json!("1"), "version");
}

#[test]
fn rejects_duplicate_row_ids_invalid_patterns_and_inconsistent_breakpoints() {
    rejection(
        |raw| {
            let first = raw["rows"][0].clone();
            raw["rows"].as_array_mut().unwrap().push(first);
        },
        "duplicate row id",
    );
    rejection(
        |raw| raw["rows"][0]["match"] = json!("("),
        "invalid match pattern",
    );
    rejection(
        |raw| raw["hosts"][0]["pattern"] = json!("["),
        "host pattern",
    );
    rejection(
        |raw| raw["rows"][0]["mechanism"] = json!("implicit"),
        "only explicit rows have breakpoints",
    );
    rejection(
        |raw| raw["rows"][0]["maxBreakpoints"] = json!(0),
        "only explicit rows have breakpoints",
    );
}

#[test]
fn exposes_all_row_metadata_and_preserves_absent_optional_fields() {
    let table = CacheProfileTable::bundled().unwrap();
    let raw = raw_table();
    assert!(table.rows().len() > 30);
    let mut ids = HashSet::new();
    for (row, original) in table.rows().iter().zip(raw["rows"].as_array().unwrap()) {
        assert!(ids.insert(&row.id), "{}", row.id);
        assert!(!row.source.is_empty(), "{}", row.id);
        assert!(!row.tokenizer_family.is_empty(), "{}", row.id);
        assert_eq!(serde_json::to_value(row).unwrap(), *original, "{}", row.id);
    }
    let row = table
        .find_cache_profile("gpt-5.6", &CacheRoute::default())
        .row
        .unwrap();
    assert_eq!(row.ttls[1].ttl, "12h");
    assert_eq!(
        row.ttls[1].wires.as_deref(),
        Some(["codex_responses".to_owned()].as_slice())
    );
    assert_eq!(row.status, "conflict");
    assert_eq!(
        serde_json::to_value(CacheRoute::default()).unwrap(),
        json!({})
    );
}

#[test]
fn explicit_route_overrides_inferred_gateway_and_platform_and_local_wins() {
    let table = CacheProfileTable::bundled().unwrap();
    let route: CacheRoute =
        serde_json::from_value(json!({"gateway":"direct","platform":"first-party","local":false}))
            .unwrap();
    let found = table.find_cache_profile("anthropic/us.anthropic.claude-opus-4-7-v1:0", &route);
    assert_eq!(found.gateway, "direct");
    assert_eq!(found.platform, "first-party");
    assert_eq!(found.model_ref.gateway.as_deref(), Some("openrouter"));
    assert_eq!(found.model_ref.platform.as_deref(), Some("bedrock"));
    assert_eq!(found.row.unwrap().min_tokens, 2048);
    let local: CacheRoute =
        serde_json::from_value(json!({"local":true,"platform":"vertex"})).unwrap();
    assert_eq!(
        table
            .find_cache_profile("claude-opus-5", &local)
            .row
            .unwrap()
            .id,
        "local.kv-prefix"
    );
    assert!(
        table.find_cache_profile("", &local).row.is_none(),
        "an empty id does not match the local row's dot pattern"
    );
}

#[test]
fn normalization_preserves_unknown_prefixes_suffix_rules_and_single_alias_application() {
    let mut raw = raw_table();
    raw["aliases"].as_array_mut().unwrap().push(
        json!({"from":"gemini-3-6-flash","to":"sentinel","since":"2026-10-26","source":"test"}),
    );
    let table = CacheProfileTable::load(&raw).unwrap();
    assert_eq!(
        table
            .normalize_model_ref(" \u{feff}Google/Gemini-3.5-Flash:FREE\u{feff} ")
            .id,
        "gemini-3-6-flash"
    );
    assert_eq!(
        table.normalize_model_ref("unknown/gpt-6:free").id,
        "unknown/gpt-6:free"
    );
    assert_eq!(
        table.normalize_model_ref("openai/gpt-6:free2").id,
        "gpt-6:free2"
    );
    assert_eq!(table.normalize_model_ref("openai/gpt-6:free\n").id, "gpt-6");
    assert_eq!(
        table
            .normalize_model_ref("claude-opus-4-1@2025080")
            .platform,
        None
    );
}

#[test]
fn ordered_rows_and_hosts_use_the_first_matching_entry() {
    let mut raw = raw_table();
    let mut first = raw["rows"][0].clone();
    first["id"] = json!("test.first");
    first["match"] = json!("^gpt-");
    first["platforms"] = json!(["first-party"]);
    raw["rows"].as_array_mut().unwrap().insert(0, first);
    raw["hosts"]
        .as_array_mut()
        .unwrap()
        .insert(0, json!({"pattern":"openai", "vendor":"local"}));
    let table = CacheProfileTable::load(&raw).unwrap();
    assert_eq!(
        table
            .find_cache_profile("gpt-6", &CacheRoute::default())
            .row
            .unwrap()
            .id,
        "test.first"
    );
    assert_eq!(
        table
            .cache_route_for_url("https://api.openai.com")
            .vendor
            .as_deref(),
        Some("local")
    );
}

#[test]
fn model_patterns_follow_javascript_digits_and_dot_line_terminators() {
    let mut raw = raw_table();
    raw["rows"][0]["match"] = json!("^gpt-\\d+$");
    raw["rows"][0]["platforms"] = json!(["first-party"]);
    let table = CacheProfileTable::load(&raw).unwrap();
    assert_eq!(
        table
            .find_cache_profile("gpt-٦", &CacheRoute::default())
            .row
            .unwrap()
            .id,
        "openai.implicit"
    );
    // U+0085 is retained by JS trim, so internal line terminators still reach the pattern.
    raw["rows"][0]["match"] = json!("^\u{0085}.x$");
    let table = CacheProfileTable::load(&raw).unwrap();
    for terminator in ['\n', '\r', '\u{2028}', '\u{2029}'] {
        let model = format!("\u{0085}{terminator}x");
        assert!(
            table
                .find_cache_profile(&model, &CacheRoute::default())
                .row
                .is_none(),
            "{model:?}"
        );
    }
}

#[derive(Deserialize)]
struct Vectors {
    version: u32,
    profiles: Vec<ProfileVector>,
    urls: Vec<UrlVector>,
}
#[derive(Deserialize)]
struct ProfileVector {
    name: String,
    model: String,
    route: CacheRoute,
    expected: Value,
}
#[derive(Deserialize)]
struct UrlVector {
    url: String,
    expected: Value,
}

#[test]
fn agrees_with_typescript_generated_profile_and_url_vectors() {
    let fixture = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/providers/fixtures/cache-profile-vectors.json"
    ))
    .unwrap();
    let vectors: Vectors = serde_json::from_str(&fixture).unwrap();
    assert_eq!(vectors.version, 1);
    assert!(!vectors.profiles.is_empty());
    assert!(!vectors.urls.is_empty());
    let table = CacheProfileTable::bundled().unwrap();
    let mut covered = HashSet::new();
    for vector in vectors.profiles {
        let found = table.find_cache_profile(&vector.model, &vector.route);
        let row_id = found.row.map(|row| row.id.as_str());
        if let Some(id) = row_id {
            covered.insert(id.to_owned());
        }
        assert_eq!(
            json!({"ref":found.model_ref,"platform":found.platform,"gateway":found.gateway,"rowId":row_id}),
            vector.expected,
            "{}: {}",
            vector.name,
            vector.model
        );
    }
    assert_eq!(
        covered.len(),
        table.rows().len(),
        "vectors must reach every row"
    );
    for vector in vectors.urls {
        assert_eq!(
            serde_json::to_value(table.cache_route_for_url(&vector.url)).unwrap(),
            vector.expected,
            "{}",
            vector.url
        );
    }
}
