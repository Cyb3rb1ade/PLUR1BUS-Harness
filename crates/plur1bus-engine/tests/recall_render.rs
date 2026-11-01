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
        if case["input"]["kind"].is_string() {
            fixture::verify_helper(&case);
            continue;
        }
        if name == "system-supplement" {
            fixture::verify_supplement(&case);
            continue;
        }
        let neo = fixture::FixtureNeo::new(&case);
        let actual = if case["input"]["minimal"] == true {
            let mut request = fixture::request(&case);
            request.additions.knowledge_nudge =
                fixture::text(&case["input"]["knowledgeNudge"]).into();
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
            fixture::warm(&case, &neo)
        } else {
            fixture::assemble(&case, &neo)
        };
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
        assert_eq!(
            actual.to_json_line(),
            fixture::text(&case["rawLine"]),
            "{name}/{} result bytes",
            case["input"]["variant"]
        );
        let joined = inject_budget::plan(&actual.blocks, actual.cap_chars);
        assert_eq!(joined.to_json_line(), fixture::text(&case["joinedLine"]));
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
