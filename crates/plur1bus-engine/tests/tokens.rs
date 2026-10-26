//! RE-14/T2 counts are a library service; no engine runtime consumes them in Phase 1 (RE-R1).
#![cfg_attr(test, allow(clippy::unwrap_used))]

use plur1bus_engine::cache_profiles::CacheProfileTable;
use plur1bus_engine::tokens::{
    ArtifactState, CountRequest, CountResult, TokenCounter, TokenMethod,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::PathBuf;

fn request(value: Value) -> CountRequest {
    serde_json::from_value(value).unwrap()
}

fn run(counter: &TokenCounter, value: Value) -> CountResult {
    counter.count(&request(value)).unwrap()
}

#[test]
fn every_table_family_is_listed_once_and_missing_files_are_explicit() {
    let counter = TokenCounter::heuristic().unwrap();
    let expected: BTreeSet<_> = CacheProfileTable::bundled()
        .unwrap()
        .rows()
        .iter()
        .map(|row| row.tokenizer_family.clone())
        .collect();
    let families = counter.families();
    let actual: BTreeSet<_> = families
        .iter()
        .map(|family| family.family.clone())
        .collect();
    assert_eq!(actual, expected);
    assert_eq!(actual.len(), families.len());
    for family in families {
        assert_eq!(family.method, TokenMethod::Heuristic);
        assert_ne!(family.artifact_state, ArtifactState::Present);
    }
}

#[test]
fn all_estimator_families_obey_bounds_on_de_en_code_json_and_unicode() {
    let counter = TokenCounter::heuristic().unwrap();
    for family in counter.families() {
        for text in [
            "",
            "Hallo Welt!",
            "Hello, world!",
            "fn main() {}",
            "{\"ok\":true}",
            "👩‍🚀中\u{301}",
        ] {
            let result = run(
                &counter,
                json!({
                    "family": family.family, "items": [{"id":"text", "text":text}]
                }),
            );
            let item = &result.items[0];
            assert_eq!(result.method, TokenMethod::Heuristic);
            assert_eq!(
                item.tokens,
                (text.encode_utf16().count() as u64).div_ceil(4)
            );
            assert_eq!(item.lower, 0);
            assert_eq!(item.upper, text.len() as u64);
            assert!(item.lower <= item.tokens && item.tokens <= item.upper);
        }
    }
}

#[test]
fn routes_use_the_shared_normalizer_and_unknown_routes_remain_estimators() {
    let counter = TokenCounter::heuristic().unwrap();
    for (model, platform, expected) in [
        ("openai/gpt-5.5", "first-party", "o200k"),
        ("us.anthropic.claude-opus-4-7-v1:0", "bedrock", "claude-v2"),
        ("claude-sonnet-4-6", "first-party", "claude-v1"),
        ("gpt-6.1-sol", "first-party", "openai-unpublished"),
        ("unlisted-model", "first-party", "unknown"),
    ] {
        let result = run(
            &counter,
            json!({
                "route":{"provider":"fixture", "platform":platform, "wire":"chat_completions", "model":model},
                "items":[{"id":"text", "text":"Hello"}]
            }),
        );
        assert_eq!(result.family, expected);
        assert_eq!(result.method, TokenMethod::Heuristic);
    }
}

#[test]
fn chatgpt_plan_keeps_unpublished_model_families_heuristic_even_with_o200k_installed() {
    let empty = tempfile::tempdir().unwrap();
    let directory = std::env::var_os("PLUR1BUS_TOKENIZER_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| empty.path().to_path_buf());
    let counter = TokenCounter::from_directory(&directory).unwrap();
    let o200k = counter
        .families()
        .into_iter()
        .find(|family| family.family == "o200k")
        .unwrap();
    if std::env::var("PLUR1BUS_TOKENIZER_FILES_REQUIRED").as_deref() == Ok("1") {
        assert_eq!(
            o200k.artifact_state,
            ArtifactState::Present,
            "this regression must run with the real o200k file in CI"
        );
    }
    for (model, expected_family, expected_method) in [
        ("gpt-6.1-sol", "openai-unpublished", TokenMethod::Heuristic),
        (
            "openai/gpt-6.1-sol",
            "openai-unpublished",
            TokenMethod::Heuristic,
        ),
        ("gpt-5.5", "o200k", o200k.method),
    ] {
        let result = run(
            &counter,
            json!({
                "route":{"provider":"openai", "platform":"chatgpt-plan", "wire":"responses", "model":model},
                "items":[{"id":"text", "text":"Hello, world!"}]
            }),
        );
        assert_eq!(result.family, expected_family, "{model}");
        assert_eq!(result.method, expected_method, "{model}");
    }
    let explicit = run(
        &counter,
        json!({"family":"o200k", "items":[{"id":"text","text":"Hello, world!"}]}),
    );
    assert_eq!(explicit.family, "o200k");
    assert_eq!(explicit.method, o200k.method);
}

#[test]
fn messages_keep_boundaries_and_cumulative_recounts_each_segment_prefix() {
    let counter = TokenCounter::heuristic().unwrap();
    let result = run(
        &counter,
        json!({
            "family":"claude-v2", "cumulative":true,
            "items":[{"id":"conversation", "messages":[
                {"role":"user", "segments":[{"text":"a"},{"text":"bcd"}]},
                {"role":"assistant", "segments":[{"text":"e"}]}
            ]}]
        }),
    );
    assert_eq!(result.items[0].tokens, 2);
    let prefixes = result.cumulative.unwrap();
    assert_eq!(prefixes.len(), 2);
    assert_eq!(prefixes[0].message, 0);
    assert_eq!(
        prefixes[0]
            .counts
            .iter()
            .map(|count| count.tokens)
            .collect::<Vec<_>>(),
        [1, 1]
    );
    assert_eq!(prefixes[1].message, 1);
    assert_eq!(prefixes[1].counts[0].tokens, 1);

    let separate = run(
        &counter,
        json!({
            "family":"claude-v2", "items":[{"id":"one", "text":"a"},{"id":"two", "text":"bcd"}]
        }),
    );
    assert_eq!(
        separate.items.iter().map(|item| item.tokens).sum::<u64>(),
        2
    );
}

#[test]
fn malformed_selectors_duplicate_ids_and_ambiguous_content_are_rejected() {
    let counter = TokenCounter::heuristic().unwrap();
    for invalid in [
        json!({"items":[]}),
        json!({"family":"not-a-table-family", "items":[]}),
        json!({"family":"o200k", "route":{"provider":"openai","platform":"first-party","wire":"responses","model":"gpt-5"}, "items":[]}),
        json!({"family":"o200k", "items":[{"id":"same","text":"a"},{"id":"same","text":"b"}]}),
        json!({"family":"o200k", "items":[{"id":"empty"}]}),
        json!({"family":"o200k", "items":[{"id":"both","text":"a","tools":[]}]}),
    ] {
        assert!(
            counter.count(&request(invalid.clone())).is_err(),
            "accepted {invalid}"
        );
    }
    assert!(serde_json::from_value::<CountRequest>(
        json!({"family":"o200k","items":[],"extra":true})
    )
    .is_err());
}

#[test]
fn result_shape_exposes_zero_observations_and_omits_unrequested_cumulative() {
    let counter = TokenCounter::heuristic().unwrap();
    let output = serde_json::to_value(run(
        &counter,
        json!({
            "family":"claude-v2", "items":[{"id":"a", "text":"test"}]
        }),
    ))
    .unwrap();
    assert_eq!(
        output,
        json!({
            "family":"claude-v2", "method":"heuristic", "calibration":{"version":1,"observations":0},
            "items":[{"id":"a","tokens":1,"lower":0,"upper":4}]
        })
    );
}

fn read_goldens(name: &str) -> Value {
    let root =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/engine-parity/goldens/tokens");
    serde_json::from_slice(&std::fs::read(root.join(name)).unwrap()).unwrap()
}

fn assert_golden_manifest(counter: &TokenCounter, texts: &Value, goldens: &Value) {
    assert_eq!(texts["version"], 1);
    assert_eq!(goldens["version"], 1);
    assert!(
        !counter.artifacts().is_empty(),
        "the approved o200k reference must be pinned"
    );
    let fixture_ids: BTreeSet<_> = texts["texts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|text| text["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        fixture_ids.len(),
        texts["texts"].as_array().unwrap().len(),
        "duplicate fixture ids"
    );
    let references = goldens["reference"].as_array().unwrap();
    let reference_ids: BTreeSet<_> = references
        .iter()
        .map(|reference| reference["artifactId"].as_str().unwrap())
        .collect();
    let artifact_ids: BTreeSet<_> = counter
        .artifacts()
        .iter()
        .map(|artifact| artifact.id.as_str())
        .collect();
    assert_eq!(
        reference_ids.len(),
        references.len(),
        "duplicate golden references"
    );
    assert_eq!(reference_ids, artifact_ids);
    assert!(
        goldens["cases"]
            .as_array()
            .unwrap()
            .iter()
            .all(|case| artifact_ids.contains(case["artifactId"].as_str().unwrap())),
        "orphan golden artifact"
    );
    for artifact in counter.artifacts() {
        let reference = references
            .iter()
            .find(|reference| reference["artifactId"] == artifact.id)
            .unwrap();
        assert_eq!(
            reference["sha256"], artifact.sha256,
            "goldens must name the exact pinned artifact"
        );
    }
}

fn artifact_cases<'a>(
    goldens: &'a Value,
    texts: &Value,
    artifact: &plur1bus_engine::tokens::TokenizerArtifact,
) -> Vec<&'a Value> {
    let cases: Vec<_> = goldens["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["artifactId"].as_str() == Some(&artifact.id))
        .collect();
    let fixture_ids: BTreeSet<_> = texts["texts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|text| text["id"].as_str().unwrap())
        .collect();
    let case_ids: BTreeSet<_> = cases
        .iter()
        .map(|case| case["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        case_ids.len(),
        cases.len(),
        "duplicate golden cases for {}",
        artifact.id
    );
    assert_eq!(
        case_ids, fixture_ids,
        "missing or unknown golden case for {}",
        artifact.id
    );
    for case in &cases {
        assert_eq!(case["family"], artifact.family);
        assert_eq!(
            case["tokens"].as_u64().unwrap(),
            case["ids"].as_array().unwrap().len() as u64
        );
    }
    cases
}

fn assert_exact_golden(
    counter: &TokenCounter,
    reference: &tokenizers::Tokenizer,
    case: &Value,
    texts: &Value,
) {
    let text = texts["texts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|text| text["id"] == case["id"])
        .unwrap();
    let raw = text["text"].as_str().unwrap();
    let result = run(
        counter,
        json!({"family":case["family"],"items":[{"id":case["id"],"text":raw}]}),
    );
    let expected = case["tokens"].as_u64().unwrap();
    let item = &result.items[0];
    assert_eq!(result.method, TokenMethod::Exact);
    assert_eq!(
        (item.lower, item.tokens, item.upper),
        (expected, expected, expected),
        "{}:{}",
        case["family"],
        case["id"]
    );
    let ids: Vec<u32> = case["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_u64().unwrap().try_into().unwrap())
        .collect();
    assert_eq!(
        reference.encode(raw, false).unwrap().get_ids(),
        ids,
        "token-id parity {}:{}",
        case["family"],
        case["id"]
    );
}

#[test]
fn every_installed_artifact_matches_independently_recorded_counts_and_ids() {
    let empty = tempfile::tempdir().unwrap();
    let directory = std::env::var_os("PLUR1BUS_TOKENIZER_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| empty.path().to_path_buf());
    let counter = TokenCounter::from_directory(&directory).unwrap();
    let required = std::env::var("PLUR1BUS_TOKENIZER_FILES_REQUIRED").as_deref() == Ok("1");
    let texts = read_goldens("texts.json");
    let goldens = read_goldens("counts.json");
    assert_golden_manifest(&counter, &texts, &goldens);
    for artifact in counter.artifacts() {
        let cases = artifact_cases(&goldens, &texts, artifact);
        let family = counter
            .families()
            .into_iter()
            .find(|family| family.family == artifact.family)
            .unwrap();
        if family.artifact_state != ArtifactState::Present {
            assert!(
                !required,
                "required tokenizer {} is {:?}; run node scripts/tokens/setup-tokenizers.mjs",
                artifact.id, family.artifact_state
            );
            let result = run(
                &counter,
                json!({"family":artifact.family,"items":[{"id":"missing","text":"test"}]}),
            );
            assert_eq!(result.method, TokenMethod::Heuristic);
            assert_eq!(result.items[0].tokens, 1);
            assert_eq!(
                family.artifact_state,
                ArtifactState::Missing,
                "a damaged installed file must fail golden validation"
            );
            continue;
        }
        let mut reference =
            tokenizers::Tokenizer::from_file(directory.join(&artifact.id).join(&artifact.file))
                .unwrap();
        reference.with_truncation(None).unwrap();
        reference.with_padding(None);
        for case in cases {
            assert_exact_golden(&counter, &reference, case, &texts);
        }
    }
}

#[test]
fn required_files_mode_fails_the_golden_test_when_the_cache_is_empty() {
    let empty = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "every_installed_artifact_matches_independently_recorded_counts_and_ids",
            "--nocapture",
        ])
        .env("PLUR1BUS_TOKENIZER_DIR", empty.path())
        .env("PLUR1BUS_TOKENIZER_FILES_REQUIRED", "1")
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "required-files probe unexpectedly passed"
    );
    let diagnostic = String::from_utf8_lossy(&output.stderr);
    assert!(
        diagnostic.contains("required tokenizer") && diagnostic.contains("Missing"),
        "{diagnostic}"
    );
}

#[test]
fn installed_tokenizers_recount_bpe_prefixes_and_label_messages_as_visible_text_only() {
    let counter = match std::env::var_os("PLUR1BUS_TOKENIZER_DIR") {
        Some(directory) => TokenCounter::from_directory(&PathBuf::from(directory)).unwrap(),
        None => TokenCounter::heuristic().unwrap(),
    };
    for family in counter.families() {
        let segments = ["a", "bcd", " hello", " world", "👩", "‍🚀"];
        let messages = run(
            &counter,
            json!({"family":family.family,"cumulative":true,"items":[{
                "id":"message", "messages":[{"role":"user", "segments":segments.iter().map(|text| json!({"text":text})).collect::<Vec<_>>()}]
            }]}),
        );
        assert_eq!(
            messages.method,
            if family.artifact_state == ArtifactState::Present {
                TokenMethod::TokenizerText
            } else {
                TokenMethod::Heuristic
            }
        );
        let prefixes = messages.cumulative.unwrap();
        let mut joined = String::new();
        for (segment, prefix) in segments.iter().zip(&prefixes[0].counts) {
            joined.push_str(segment);
            let exact = run(
                &counter,
                json!({"family":family.family,"items":[{"id":"prefix","text":joined}]}),
            );
            assert_eq!(prefix.tokens, exact.items[0].tokens);
            assert!(prefix.lower <= prefix.tokens && prefix.tokens <= prefix.upper);
        }
        let text = run(
            &counter,
            json!({"family":family.family,"items":[{"id":"text","text":segments.concat()}]}),
        );
        assert_eq!(messages.items[0].tokens, text.items[0].tokens);
        assert!(
            messages.items[0].lower <= messages.items[0].tokens
                && messages.items[0].tokens <= messages.items[0].upper
        );
    }
}
