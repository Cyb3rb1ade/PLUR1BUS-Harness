//! T5's text and serialization oracle is the actual pinned Node execution.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "golden failures must stop parity tests"
)]

#[path = "support/render_fixture.rs"]
mod fixture;

use plur1bus_engine::recall::{inject_budget, maintenance};
use plur1bus_engine::text::json::{parse_json, TolerantJsonValue};

fn verify(name: &str) {
    for case in fixture::cases(name) {
        verify_case(name, &case);
    }
}

fn verify_case(name: &str, case: &serde_json::Value) {
    let mut case = case.clone();
    let exceptions: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/recall/unicode-exceptions.json")).unwrap();
    if let Some(exception) = exceptions["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|exception| {
            exception["golden"] == name && exception["variant"] == case["input"]["variant"]
        })
    {
        use sha2::{Digest, Sha256};
        let digest = format!(
            "{:x}",
            Sha256::digest(fixture::text(&case["rawLine"]).as_bytes())
        );
        assert_eq!(digest, exception["nodeRawLineSha256"]);
        case["rawLine"] = exception["rustRawLine"].clone();
        case["joinedLine"] = exception["rustJoinedLine"].clone();
    }
    let case = &case;
    if case["input"]["kind"].is_string() {
        fixture::verify_helper(case);
        return;
    }
    if name == "system-supplement" {
        fixture::verify_supplement(case);
        return;
    }
    if case.get("disclosureLine").is_some() {
        verify_disclosure(case);
    }
    let actual = render_case(name, case);
    assert_lens_authorized(case, &actual);
    assert_eq!(
        actual.to_json_line(),
        fixture::text(&case["rawLine"]),
        "{name}/{} result bytes",
        case["input"]["variant"]
    );
    let joined = inject_budget::plan(&actual.blocks, actual.cap_chars);
    assert_eq!(joined.to_json_line(), fixture::text(&case["joinedLine"]));
    verify_blocks(name, case, &actual);
}

macro_rules! golden_test {
    ($name:ident, $golden:literal) => {
        #[test]
        fn $name() {
            verify($golden);
        }
    };
}
golden_test!(render_plain, "render-plain");
golden_test!(render_memories_cap_clips, "render-memories-cap-clips");
golden_test!(render_global_cap_drops, "render-global-cap-drops");
golden_test!(render_neo_prelude, "render-neo-prelude");
golden_test!(render_temporal_block, "render-temporal-block");
golden_test!(render_reminder_block, "render-reminder-block");
golden_test!(render_reactivation_boost, "render-reactivation-boost");
golden_test!(
    render_contradiction_disclosure,
    "render-contradiction-disclosure"
);
golden_test!(render_confidence_framing, "render-confidence-framing");
golden_test!(warm_only_path, "warm-only-path");
golden_test!(system_supplement, "system-supplement");

#[test]
fn block_texts_are_byte_identical() {
    for name in [
        "render-plain",
        "render-memories-cap-clips",
        "render-global-cap-drops",
        "render-neo-prelude",
        "render-temporal-block",
        "render-reminder-block",
        "render-reactivation-boost",
        "render-contradiction-disclosure",
        "render-confidence-framing",
    ] {
        verify(name);
    }
}

fn verify_variants(name: &str, variants: &[&str]) {
    let cases = fixture::cases(name)
        .into_iter()
        .filter(|case| variants.contains(&case["input"]["variant"].as_str().unwrap()))
        .collect::<Vec<_>>();
    assert_eq!(
        cases.len(),
        variants.len(),
        "all specified Node cases must exist"
    );
    for case in cases {
        verify_case(name, &case);
    }
}

fn verify_disclosure(case: &serde_json::Value) {
    use plur1bus_engine::recall::boosters;
    let rows = case["input"]["rows"].as_array().unwrap();
    let (a, b) = (&rows[0]["entry"], &rows[1]["entry"]);
    let winner = boosters::contradiction_winner(a, b);
    assert_eq!(winner["id"], case["winnerId"]);
    let loser = if std::ptr::eq(winner, a) { b } else { a };
    let pairs = [(winner.clone(), loser.clone())];
    let actual = boosters::contradiction_disclosure(
        &pairs,
        case["input"]["cfg"]["contradictionDisclosure"]["enabled"] != false,
    );
    let line = actual
        .as_ref()
        .map_or_else(|| "null".into(), |text| text.to_json());
    assert_eq!(line, fixture::text(&case["disclosureLine"]));
}

#[test]
fn review_crr_nested_bindings_match_the_pin() {
    verify_variants(
        "render-reactivation-boost",
        &[
            "selector-graph-bound",
            "selector-graph-missing-nested",
            "selector-graph-conflicting-source",
            "selector-graph-conflicting-target",
            "selector-graph-sparse-bound",
        ],
    );
}

#[test]
fn review_overlay_switches_preserve_the_base() {
    verify_variants(
        "render-plain",
        &[
            "overlay-default",
            "overlay-enabled",
            "overlay-disabled",
            "overlay-continuity-disabled",
            "overlay-no-workspace",
        ],
    );
}

#[test]
fn review_summary_numeric_encodings_match_the_pin() {
    verify_variants(
        "render-plain",
        &[
            "summary-words-4",
            "summary-number-4.0",
            "summary-number-4e0",
            "summary-number-4.5",
            "summary-number-0",
            "summary-number--1",
        ],
    );
}

#[test]
fn review_crr_property_enumeration_preserves_selected_ids() {
    verify_variants(
        "render-reactivation-boost",
        &[
            "selector-object-order-numeric",
            "selector-object-order-prefixed",
            "selector-object-order-array",
        ],
    );
}

#[test]
fn review_disclosure_uses_recorded_nonempty_and_disabled_oracles() {
    verify_variants(
        "render-contradiction-disclosure",
        &["default", "enabled", "disabled", "entity-cut"],
    );
}

fn render_case(
    name: &str,
    case: &serde_json::Value,
) -> plur1bus_engine::recall::blocks::RenderedRecall {
    let neo = fixture::FixtureNeo::new(case);
    if case["input"]["minimal"] == true {
        let mut request = fixture::request(case);
        request.additions.knowledge_nudge = fixture::text(&case["input"]["knowledgeNudge"]).into();
        maintenance::minimal(
            &request,
            &maintenance::MinimalPolicy {
                allowed: case["input"]["denied"] != true,
                internal: case["input"]["internal"] == true,
                has_workspace: case["input"]["noWorkspace"] != true,
                neo_enabled: false,
                gc_enabled: false,
            },
        )
        .unwrap()
    } else if name == "warm-only-path" && case["input"]["warm"] == true {
        fixture::warm(case, &neo)
    } else {
        fixture::assemble(case, &neo)
    }
}

fn assert_lens_authorized(
    case: &serde_json::Value,
    actual: &plur1bus_engine::recall::blocks::RenderedRecall,
) {
    if case["input"]["lensSecurity"] == true {
        let denied = &case["input"]["hydratedRows"][0];
        let safe = !actual
            .to_json_line()
            .contains(&fixture::text(&denied["id"]))
            && !actual
                .to_json_line()
                .contains(&fixture::text(&denied["text"]));
        assert!(safe, "Lens authorization failed");
    }
}

fn verify_blocks(
    name: &str,
    case: &serde_json::Value,
    actual: &plur1bus_engine::recall::blocks::RenderedRecall,
) {
    let expected = parse_json(&fixture::text(&case["rawLine"])).unwrap();
    let TolerantJsonValue::Array(blocks) = fixture::field(&expected, "blocks") else {
        panic!("blocks are required");
    };
    for (actual, expected) in actual.blocks.iter().zip(blocks) {
        assert_eq!(
            actual.text.to_json(),
            fixture::string(fixture::field(expected, "text")).to_json(),
            "{name}/{} block {}",
            case["input"]["variant"],
            actual.name
        );
        assert_eq!(actual.chars, actual.text.utf16_len());
        assert!(!actual.to_json_line().contains("tokensEstimate"));
    }
}
