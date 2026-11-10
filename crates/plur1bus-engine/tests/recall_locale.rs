//! `resolveLocale`/`detectLanguage` parity at the Node pin (RE-D152).
//!
//! `fixtures/recall/locale.json` was recorded twice by `record-locale.mjs` from the
//! SHA-checked pin sources; both recordings were byte-identical.
#![allow(clippy::unwrap_used, reason = "parity fixtures fail immediately")]

use plur1bus_engine::recall::locale::{
    detect_language, resolve_locale, LocaleMessage, GERMAN_WORDS,
};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/recall/locale.json")).unwrap()
}

fn messages(value: &Value) -> Vec<LocaleMessage<'_>> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|message| LocaleMessage {
            role: message["role"].as_str(),
            content: message["content"].as_str(),
        })
        .collect()
}

#[test]
fn the_fixture_binds_the_pinned_sources_and_word_list() {
    let fixture = fixture();
    assert_eq!(
        fixture["source"]["commit"],
        "9f34008c143c5da87b2194b5a28442b407ff8ba7"
    );
    assert_eq!(
        fixture["source"]["files"]["lib/i18n.js"],
        "f9846591fc0bb8ec21b66c6ec178c1d9be4ef6619d8d7e6fb09ed9923e81e148"
    );
    let words = fixture["germanWords"]
        .as_array()
        .unwrap()
        .iter()
        .map(|word| word.as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(words, GERMAN_WORDS);
}

#[test]
fn detection_matches_node() {
    let fixture = fixture();
    let cases = fixture["detect"].as_array().unwrap();
    assert!(cases.len() >= 30);
    for case in cases {
        assert_eq!(
            detect_language(&messages(&case["messages"])),
            case["detected"].as_str().unwrap(),
            "{}",
            case["messages"]
        );
    }
}

#[test]
fn resolution_matches_node() {
    for case in fixture()["resolve"].as_array().unwrap() {
        let args = &case["args"];
        let list = args.get("messages").map(messages).unwrap_or_default();
        assert_eq!(
            resolve_locale(
                args["config"].as_str(),
                args["ctx"]["lang"].as_str(),
                &list,
                args["fallback"].as_str().unwrap_or("en"),
            ),
            case["resolved"].as_str().unwrap(),
            "{args}"
        );
    }
}
