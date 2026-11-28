#![forbid(unsafe_code)]
#![allow(clippy::unwrap_used, clippy::panic)]

use plur1bus_providers::cache::{self, CacheInput, CacheProfileTable, CacheRoute};
use plur1bus_providers::{Json, RequestOptions, Wire};
use serde_json::{json, Value};
use ureq::http::{HeaderMap, HeaderName, HeaderValue};

#[test]
fn cache_profile_table_matches_every_existing_vector() {
    let table = CacheProfileTable::bundled().unwrap();
    let vector: Value = serde_json::from_str(include_str!(
        "../../../packages/providers/fixtures/cache-profile-vectors.json"
    ))
    .unwrap();
    for case in vector["profiles"].as_array().unwrap() {
        let route: CacheRoute = serde_json::from_value(case["route"].clone()).unwrap();
        let result = table.find_cache_profile(case["model"].as_str().unwrap(), &route);
        let actual = json!({
            "ref": result.model_ref, "gateway": result.gateway, "platform": result.platform,
            "rowId": result.row.map(|row| &row.id),
        });
        assert_eq!(actual, case["expected"], "{}", case["name"]);
    }
    for case in vector["urls"].as_array().unwrap() {
        let route = table.cache_route_for_url(case["url"].as_str().unwrap());
        assert_eq!(json!(route), case["expected"], "{}", case["url"]);
    }
}

#[test]
fn emitter_matches_recorded_request_bytes_and_affinity_headers() {
    let table = CacheProfileTable::bundled().unwrap();
    let vector: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/provider-cache/emitter.json"
    ))
    .unwrap();
    for case in vector["cases"].as_array().unwrap() {
        let wire = match case["wire"].as_str().unwrap() {
            "chat_completions" => Wire::ChatCompletions,
            "anthropic_messages" => Wire::AnthropicMessages,
            "codex_responses" => Wire::CodexResponses,
            other => panic!("unexpected fixture wire {other}"),
        };
        let request = Json::parse(case["requestJson"].as_str().unwrap()).unwrap();
        let mut body = wire
            .request(&request, true, &RequestOptions::default())
            .unwrap();
        let mut headers = HeaderMap::new();
        for (name, value) in case["headers"].as_object().unwrap() {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value.as_str().unwrap()).unwrap(),
            );
        }
        let route = serde_json::from_value(case["route"].clone()).unwrap();
        let prompt = Json::parse(&case["prompt"].to_string()).unwrap();
        cache::emit(
            wire,
            &mut body,
            &mut headers,
            CacheInput {
                table: &table,
                route: &route,
                prompt: &prompt,
            },
        );
        assert_eq!(
            body.encode(),
            case["expected"]["bodyText"],
            "{}",
            case["name"]
        );
        let seen: serde_json::Map<String, Value> = headers
            .iter()
            .map(|(name, value)| (name.as_str().into(), json!(value.to_str().unwrap())))
            .collect();
        assert_eq!(json!(seen), case["expected"]["headers"], "{}", case["name"]);
    }
}
