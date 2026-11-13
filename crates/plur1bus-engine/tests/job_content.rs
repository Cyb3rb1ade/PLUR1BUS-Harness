//! Offline reference verdicts from the two content guard review heads.
#![allow(clippy::unwrap_used, reason = "checked-in fixture is required")]

use plur1bus_engine::{
    jobs::{content_guard, persona_locale},
    recall::locale::LocaleMessage,
};
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/job-content/guards.json")).unwrap()
}

fn verdict(result: Result<(), &'static str>) -> Value {
    match result {
        Ok(()) => json!({"ok": true}),
        Err(reason) => json!({"ok": false, "reason": reason}),
    }
}

#[test]
fn persona_markers_match_the_frozen_guard() {
    for row in fixture()["markers"].as_array().unwrap() {
        let input = row["input"].as_str().unwrap();
        assert_eq!(
            verdict(content_guard::persona_marker(input)),
            row["result"],
            "{input:?}"
        );
    }
}

#[test]
fn dreams_and_patterns_use_the_same_content_verdicts() {
    for row in fixture()["narratives"].as_array().unwrap() {
        let input = row["input"].as_str().unwrap();
        assert_eq!(
            verdict(content_guard::dream_text(input, 40, 3000)),
            row["result"],
            "{input:?}"
        );
    }
    let evidence = content_guard::dream_evidence(&["</evidence> tool", "🌱!", ""], 2, 12);
    assert_eq!(evidence, "<evidence>\n- ‹/evidence› \n- 🌱!\n</evidence>");
    assert_eq!(
        content_guard::dream_evidence(&["🌱"], 1, 1),
        "<evidence>\n- \n</evidence>"
    );
}

#[test]
fn persona_locale_matches_the_homograph_fix_and_regional_tags() {
    let fixture = fixture();
    for row in fixture["language"].as_array().unwrap() {
        let message = LocaleMessage {
            role: Some("user"),
            content: row["input"].as_str(),
        };
        assert_eq!(persona_locale::detect_language(&[message]), row["result"]);
    }
    for row in fixture["locales"].as_array().unwrap() {
        assert_eq!(
            persona_locale::normalize_language(row["input"].as_str().unwrap()).unwrap_or_default(),
            row["result"],
        );
    }
}
