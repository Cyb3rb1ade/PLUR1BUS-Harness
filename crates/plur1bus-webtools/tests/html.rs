#![allow(clippy::unwrap_used, reason = "TypeScript HTML fixtures")]

use plur1bus_webtools::html::{extract, Metadata};
use serde_json::{json, Value};

#[test]
fn readable_markdown_metadata_and_page_signals_match_typescript() {
    let data: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/web/html.json")).unwrap();
    for row in data["cases"].as_array().unwrap() {
        let actual = extract(
            row["input"].as_str().unwrap(),
            row["base"].as_str().unwrap(),
            &|text, _| text.to_owned(),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            row["expected"],
            "{}",
            row["name"]
        );
    }
}

#[test]
fn metadata_mask_runs_before_the_utf16_title_limit() {
    let input = format!(
        "<title>{}fixture-private-marker</title><p>Read the edition</p>",
        "a".repeat(295)
    );
    let output = extract(
        &input,
        "https://edition.fixture.invalid/",
        &|value, field| match field {
            Metadata::Title => value.replace("fixture-private-marker", "listed"),
            _ => value.to_owned(),
        },
    )
    .unwrap();
    assert_eq!(
        json!(output.title),
        json!(format!("{}list…", "a".repeat(295)))
    );
}
