//! Pinned job prompt bytes and Phase 1 cache boundaries.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "fixture data is required"
)]

use plur1bus_engine::{
    jobs::prompts::{self, Benefit, Rendered},
    text::js::JsString,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn renders(text: &JsString) -> [(&'static str, Rendered); 4] {
    let empty = JsString::from("");
    [
        (
            "conversation-insights",
            prompts::conversation_insights(&[("user", text.clone())]),
        ),
        (
            "rem-pattern-analysis",
            prompts::rem_pattern(std::slice::from_ref(text)),
        ),
        (
            "skill-extraction",
            prompts::skill_extraction(std::slice::from_ref(text)),
        ),
        (
            "skill-benefit",
            prompts::skill_benefit(&Benefit {
                title: &empty,
                category: &empty,
                description: text,
                instructions: &empty,
                examples: &[],
                evidence_count: 0,
            }),
        ),
    ]
}

#[test]
fn versioned_templates_match_the_recorded_node_prompt_in_phase_one_order() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/prompts/hashes.json")).unwrap();
    for (text, key) in [
        ("", "emptySha256"),
        (fixture["volatile"].as_str().unwrap(), "populatedSha256"),
    ] {
        for (name, prompt) in renders(&JsString::from(text)) {
            let hash = format!("{:x}", Sha256::digest(prompt.text.to_utf8_lossy()));
            assert_eq!(hash, fixture["records"][name][key], "{name} / {key}");
        }
    }
}

#[test]
fn only_the_prefix_before_the_first_volatile_field_is_stable() {
    let empty = renders(&JsString::from(""));
    let populated = renders(&JsString::from(
        "A transcript containing {{evidence}} and 🦀.",
    ));
    for ((name, first), (_, second)) in empty.into_iter().zip(populated) {
        assert!(first.breakpoint > 0, "{name}");
        assert_eq!(first.breakpoint, second.breakpoint, "{name}");
        assert_eq!(first.stable_hash, second.stable_hash, "{name}");
        assert_ne!(first.text, second.text, "{name}");
        let prefix = second
            .text
            .utf16_slice(0, second.breakpoint)
            .to_utf8_lossy();
        assert_eq!(second.stable_hash, format!("{:x}", Sha256::digest(prefix)));
        assert!(second.text.to_utf8_lossy().contains("{{evidence}}"));
    }
}

#[test]
fn the_llm_cache_key_of_a_prompt_cut_inside_an_emoji_matches_node() {
    use plur1bus_engine::{jobs::llm_cache_key::Request, text::json::parse_json};
    let recorded = include_str!("fixtures/prompts/cache-key.json");
    // Parse separately so the exact message array keeps the lone UTF-16 surrogate.
    let exact = parse_json(recorded).unwrap();
    use plur1bus_engine::text::json::TolerantJsonValue as Json;
    fn field<'a>(value: &'a Json, key: &str) -> &'a Json {
        match value {
            Json::Object(fields) => {
                &fields
                    .iter()
                    .find(|(name, _)| name == &JsString::from(key))
                    .unwrap()
                    .1
            }
            _ => panic!("expected fixture object"),
        }
    }
    let Json::String(hash) = field(&exact, "cacheKey") else {
        panic!("expected cache key")
    };
    let request = field(&exact, "request");
    let expected = |name| match field(request, name) {
        Json::String(value) => value.to_utf8_lossy(),
        _ => panic!("expected request string"),
    };
    let scope_id = expected("scopeId");
    let purpose = expected("purpose");
    let endpoint = expected("endpoint");
    let credential = expected("credential");
    let model = expected("model");
    let mut input = Request {
        scope_id: &scope_id,
        purpose: &purpose,
        endpoint: &endpoint,
        credential: Some(&credential),
        model: &model,
        messages: field(request, "messages"),
        max_tokens: 600,
        temperature: None,
        json_mode: false,
        disable_thinking: false,
        headers: field(request, "headers"),
    };
    assert_eq!(input.node_key().key_hash, hash.to_utf8_lossy());
    let original = input.versioned_key(1);
    assert_ne!(original, input.versioned_key(2));
    input.model = "other-model";
    assert_ne!(original.key_hash, input.versioned_key(1).key_hash);
    input.model = &model;
    input.purpose = "rem-pattern-analysis";
    assert_ne!(original.key_hash, input.versioned_key(1).key_hash);
    input.purpose = &purpose;
    let other_messages = parse_json(r#"[{"role":"user","content":"x😀"}]"#).unwrap();
    input.messages = &other_messages;
    assert_ne!(original.key_hash, input.versioned_key(1).key_hash);
}
