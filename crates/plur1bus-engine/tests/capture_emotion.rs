//! RE-05/T3 emotion goldens are raw outputs of the pinned Node classifiers, not Rust snapshots.
#![allow(clippy::unwrap_used, clippy::expect_used)]

pub use plur1bus_engine::{contract, store, text};

use plur1bus_engine::capture::{emotion_blends, emotion_score, tier1, tier2};

use text::js::JsString;
use text::json::{parse_json, write_json, TolerantJsonValue as Json};

const NOW: i64 = 1_710_000_000_000;

fn fixture() -> Json {
    parse_json(include_str!("fixtures/capture/golden/emotion.json")).unwrap()
}
fn get<'a>(value: &'a Json, key: &str) -> &'a Json {
    static NULL: Json = Json::Null;
    if let Json::Object(fields) = value {
        fields
            .iter()
            .rev()
            .find(|(name, _)| name == &JsString::from(key))
            .map_or(&NULL, |(_, value)| value)
    } else {
        &NULL
    }
}
fn array(value: &Json) -> &[Json] {
    if let Json::Array(values) = value {
        values
    } else {
        &[]
    }
}
fn string(value: &Json) -> String {
    if let Json::String(value) = value {
        value.to_utf8_lossy()
    } else {
        String::new()
    }
}
fn js_string(value: &Json) -> JsString {
    if let Json::String(value) = value {
        value.clone()
    } else {
        JsString::from("")
    }
}

fn compare_score(score: &emotion_score::EmotionScore, expected: &Json) {
    assert_eq!(
        score.to_dict_json().unwrap(),
        string(get(expected, "dictLine"))
    );
    assert_eq!(score.vector_json(), string(get(expected, "vectorLine")));
    assert_eq!(
        Json::Bool(score.is_high_intensity()),
        *get(expected, "highIntensity")
    );
    assert_eq!(
        Json::Bool(score.is_ambivalent()),
        *get(expected, "ambivalent")
    );
    assert_eq!(
        score.effective_label(),
        string(get(expected, "effectiveLabel"))
    );
    assert_eq!(
        score.active_emotions_json(),
        string(get(expected, "activeLine"))
    );
    assert_eq!(
        write_json(&score.unrounded()),
        write_json(get(expected, "unrounded"))
    );
}

#[test]
fn emotion_score_validation_rounding_vectors_and_field_order_equal_node() {
    for case in array(get(get(&fixture(), "results"), "score")) {
        let result = emotion_score::EmotionScore::from_props(get(case, "input"), NOW);
        if get(case, "ok") == &Json::Bool(false) {
            assert!(result.is_err());
        } else {
            compare_score(&result.unwrap(), get(case, "result"));
        }
    }
}

#[test]
fn every_curated_english_and_german_word_preserves_the_node_tier1_result() {
    for case in array(get(get(&fixture(), "results"), "tier1")) {
        let classifier = tier1::Tier1Classifier::new(get(case, "options")).unwrap();
        let result = classifier
            .classify(
                &js_string(get(case, "text")),
                &string(get(case, "source")),
                NOW,
            )
            .unwrap();
        if get(case, "result") == &Json::Null {
            assert!(result.is_none(), "{}", string(get(case, "text")));
        } else {
            let score = result.unwrap();
            compare_score(&score, get(case, "result"));
        }
    }
}

#[test]
fn tier2_density_softmax_german_markers_and_confidence_are_byte_identical() {
    for case in array(get(get(&fixture(), "results"), "tier2")) {
        let classifier = tier2::Tier2Classifier::new().unwrap();
        assert!(!classifier.model_loaded());
        let score = classifier
            .classify(
                &js_string(get(case, "text")),
                &string(get(case, "source")),
                NOW,
            )
            .unwrap();
        compare_score(&score, get(case, "result"));
    }
}

#[test]
fn every_blend_rule_keeps_trigger_threshold_transition_and_tie_order() {
    for case in array(get(get(&fixture(), "results"), "blends")) {
        let actual = emotion_blends::detect_blend(
            get(case, "labels"),
            &js_string(get(case, "text")),
            get(case, "context"),
        )
        .unwrap();
        assert_eq!(
            write_json(&actual.unwrap_or(Json::Null)),
            string(get(case, "line"))
        );
    }
}

use plur1bus_engine::capture::emotion_engine::{AnalysisOptions, EmotionEngine};
use plur1bus_engine::contract::{Cancel, HostError, LlmParams, LlmPort, LlmResult};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
struct RecordedEmotionCompletion {
    behavior: String,
    answers: serde_json::Value,
    calls: Arc<Mutex<Vec<(String, String)>>>,
}
impl LlmPort for RecordedEmotionCompletion {
    fn complete(&self, params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError> {
        #[derive(serde::Serialize)]
        struct Message<'a> {
            role: &'a contract::MessageRole,
            content: &'a str,
        }
        let messages = params
            .messages
            .iter()
            .map(|m| Message {
                role: &m.role,
                content: &m.content,
            })
            .collect::<Vec<_>>();
        let line = serde_json::to_string(&messages).unwrap();
        let hash = format!("{:x}", Sha256::digest(line.as_bytes()));
        self.calls
            .lock()
            .unwrap()
            .push((hash.clone(), line.clone()));
        assert!(
            params.model.is_none() && params.max_tokens.is_none() && params.temperature.is_none()
        );
        if self.behavior == "reject" {
            return Err(HostError::Failed);
        }
        if self.behavior == "cancel" {
            cancel.cancel();
            return Err(HostError::Failed);
        }
        let fixture = &self.answers[&hash];
        assert_eq!(fixture["promptLine"], line);
        if self.behavior == "delayed" {
            let end = std::time::Instant::now() + std::time::Duration::from_millis(20);
            while std::time::Instant::now() < end {
                cancel.check()?;
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        Ok(LlmResult {
            text: fixture["answer"].as_str().unwrap().into(),
            model: None,
            usage: None,
        })
    }
}
fn completion(behavior: &str, calls: Arc<Mutex<Vec<(String, String)>>>) -> Arc<dyn LlmPort> {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/capture/llm/emotion.json")).unwrap();
    Arc::new(RecordedEmotionCompletion {
        behavior: behavior.into(),
        answers: fixture["answers"].clone(),
        calls,
    })
}

#[test]
fn tier_routing_calls_exact_recorded_prompts_and_returns_node_scores_and_stats() {
    for case in array(get(get(&fixture(), "results"), "engine")) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let provider = string(get(case, "provider"));
        let port = (!provider.is_empty()).then(|| completion(&provider, calls.clone()));
        let mut engine = EmotionEngine::new(get(case, "config"), port, Arc::new(|| NOW)).unwrap();
        let force = if let Json::Number(n) = get(case, "forceTier") {
            n.parse().ok()
        } else {
            None
        };
        let result = engine.analyze(
            &js_string(get(case, "text")),
            "user",
            AnalysisOptions {
                force_tier: force,
                skip_tier3: get(case, "skipTier3") == &Json::Bool(true),
            },
            &Cancel::never(),
        );
        if get(case, "rejected") == &Json::Bool(true) {
            assert!(result.is_err());
        } else {
            compare_score(&result.unwrap(), get(case, "result"));
            assert_eq!(
                engine.stats_json(),
                string(get(case, "statsLine")),
                "{}",
                string(get(case, "name"))
            );
        }
        let expected = array(get(case, "calls"))
            .iter()
            .map(|c| (string(get(c, "hash")), string(get(c, "promptLine"))))
            .collect::<Vec<_>>();
        assert_eq!(
            *calls.lock().unwrap(),
            expected,
            "{}",
            string(get(case, "name"))
        );
    }
}

#[test]
fn emotion_context_transitions_match_node_and_never_cross_instances() {
    let mut engine = EmotionEngine::new(
        &parse_json(r#"{"tier2":{"enabled":false},"tier3":{"enabled":false}}"#).unwrap(),
        None,
        Arc::new(|| NOW),
    )
    .unwrap();
    for case in array(get(get(&fixture(), "results"), "sequence")) {
        let score = engine
            .analyze(
                &js_string(get(case, "text")),
                "user",
                AnalysisOptions {
                    force_tier: Some(1),
                    ..Default::default()
                },
                &Cancel::never(),
            )
            .unwrap();
        compare_score(&score, get(case, "result"));
    }
    let mut other = EmotionEngine::new(&Json::Null, None, Arc::new(|| NOW)).unwrap();
    let first = other
        .analyze(
            &JsString::from("happy safe finally"),
            "user",
            AnalysisOptions {
                force_tier: Some(1),
                ..Default::default()
            },
            &Cancel::never(),
        )
        .unwrap();
    assert!(first.emotional_context.is_none());
}

#[test]
fn caller_cancellation_never_turns_into_a_successful_local_fallback_or_updates_stats() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let mut engine = EmotionEngine::new(
        &Json::Null,
        Some(completion("cancel", calls.clone())),
        Arc::new(|| NOW),
    )
    .unwrap();
    let before = engine.stats_json();
    let cancelled = Cancel::never();
    cancelled.cancel();
    assert!(engine
        .analyze(
            &JsString::from("plain ordinary sentence"),
            "user",
            Default::default(),
            &cancelled
        )
        .is_err());
    assert!(calls.lock().unwrap().is_empty());
    let during = Cancel::never();
    assert!(engine
        .analyze(
            &JsString::from("plain ordinary sentence"),
            "user",
            Default::default(),
            &during
        )
        .is_err());
    assert_eq!(calls.lock().unwrap().len(), 1);
    assert_eq!(engine.stats_json(), before);
    let next = engine
        .analyze(
            &JsString::from("happy joyful"),
            "user",
            AnalysisOptions {
                force_tier: Some(1),
                ..Default::default()
            },
            &Cancel::never(),
        )
        .unwrap();
    assert!(next.emotional_context.is_none());
}

#[test]
fn legacy_projection_and_compact_emotion_columns_equal_actual_node_bytes() {
    use plur1bus_engine::capture::emotion_legacy as legacy;
    let classifier = tier1::Tier1Classifier::new(&Json::Null).unwrap();
    for case in array(get(get(&fixture(), "results"), "legacy")) {
        let value = legacy::infer_sync(&classifier, &js_string(get(case, "text")), NOW).unwrap();
        assert_eq!(write_json(&value), string(get(case, "line")));
        let compact = legacy::serialize(&value);
        assert_eq!(compact, string(get(case, "serialized")));
        assert_eq!(
            write_json(&legacy::deserialize(&compact)),
            string(get(case, "deserializedLine"))
        );
    }
}

#[test]
fn compact_emotion_binary64_rounding_and_decimal_prefix_parsing_match_node() {
    use plur1bus_engine::capture::emotion_legacy as legacy;
    let cases = parse_json(include_str!("fixtures/capture/golden/emotion-format.json")).unwrap();
    for case in array(get(&cases, "serialization")) {
        assert_eq!(
            legacy::serialize(get(case, "input")),
            string(get(case, "output"))
        );
    }
    for case in array(get(&cases, "parsing")) {
        assert_eq!(
            write_json(&legacy::deserialize(&string(get(case, "input")))),
            string(get(case, "line"))
        );
    }
}

#[test]
fn rolling_mood_decay_restart_history_boost_and_display_match_actual_node_bytes() {
    use plur1bus_engine::capture::emotion_state::{
        format_mood_file, format_mood_line, EmotionalState,
    };
    for case in array(get(get(&fixture(), "results"), "state")) {
        let mut now = NOW;
        let mut state = EmotionalState::new(get(case, "options"), now).unwrap();
        for step in array(get(case, "steps")) {
            let elapsed = write_json(get(step, "elapsed")).parse::<i64>().unwrap_or(0);
            now += elapsed;
            match string(get(step, "op")).as_str() {
                "initial" => {}
                "apply" => state.apply_emotion(get(step, "input"), now).unwrap(),
                "decay" => state.decay(now).unwrap(),
                "messages" => {
                    let messages: Vec<contract::Message> =
                        serde_json::from_str(&write_json(get(step, "input"))).unwrap();
                    state.update_messages(&messages, now).unwrap();
                }
                "recalled" => state.update_recalled(get(step, "input"), now).unwrap(),
                "hydrate" => {
                    state = EmotionalState::new(get(case, "options"), now - elapsed).unwrap();
                    let record = parse_json(&string(get(step, "recordLine"))).unwrap();
                    assert_eq!(
                        Json::Bool(state.hydrate_once(Some(&record), now).unwrap()),
                        *get(step, "hydrated")
                    );
                    assert_eq!(
                        Json::Bool(state.hydrate_once(Some(&record), now).unwrap()),
                        *get(step, "secondHydrate")
                    );
                }
                _ => unreachable!(),
            }
            let state_json = state.serialize_state(now).unwrap();
            assert_eq!(
                write_json(&state_json),
                string(get(step, "stateLine")),
                "{}",
                string(get(step, "op"))
            );
            let mood = state.describe(now).unwrap();
            assert_eq!(
                write_json(&mood),
                string(get(step, "moodLine")),
                "{}",
                string(get(step, "op"))
            );
            if get(step, "snapshotLine") != &Json::Null {
                assert_eq!(
                    write_json(&state.snapshot(now).unwrap()),
                    string(get(step, "snapshotLine"))
                );
            }
            if get(step, "moodText") != &Json::Null {
                assert_eq!(
                    format_mood_file(&mood, "alpha", now).unwrap(),
                    string(get(step, "moodText"))
                );
            }
            if get(step, "moodPrompt") != &Json::Null {
                assert_eq!(format_mood_line(&mood), string(get(step, "moodPrompt")));
            }
            if get(step, "compatibility") != &Json::Null {
                assert_eq!(
                    state.compatibility(get(step, "input"), now).unwrap(),
                    write_json(get(step, "compatibility"))
                        .parse::<f64>()
                        .unwrap()
                );
                assert_eq!(
                    state.recall_boost(get(step, "input"), 0.8, now).unwrap(),
                    write_json(get(step, "boost")).parse::<f64>().unwrap()
                );
            }
        }
    }
}
