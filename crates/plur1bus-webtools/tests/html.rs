#![allow(clippy::unwrap_used, reason = "TypeScript HTML fixtures")]

use plur1bus_webtools::html::{extract, Metadata};
use plur1bus_webtools::text::estimate_tokens;
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
            800_000,
            &|| Ok(()),
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
        800_000,
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(
        json!(output.title),
        json!(format!("{}list…", "a".repeat(295)))
    );
}

#[test]
fn blank_lines_do_not_spend_the_final_markdown_budget() {
    let data: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/web/html.json")).unwrap();
    for row in data["blankLines"].as_array().unwrap() {
        let input = format!(
            "<p>{}</p><pre>x{}y</pre>",
            "word word ".repeat(row["words"].as_u64().unwrap() as usize),
            "\n".repeat(row["lines"].as_u64().unwrap() as usize)
        );
        let output = extract(
            &input,
            row["base"].as_str().unwrap(),
            &|text, _| text.to_owned(),
            804_096,
            &|| Ok(()),
        )
        .unwrap();
        assert_eq!(json!(estimate_tokens(&output.markdown)), row["tokens"]);
        assert!(output.markdown.ends_with(row["suffix"].as_str().unwrap()));
    }
}

#[test]
fn preformatted_trailing_whitespace_does_not_exhaust_the_output_budget() {
    let input = format!(
        "<pre>News{}<span>{}</span></pre>",
        " ".repeat(8192),
        "\t".repeat(8192)
    );
    let result = extract(
        &input,
        "https://example.invalid/",
        &|v, _| v.into(),
        12,
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(result.markdown, "```\nNews\n```");
}

#[test]
fn combined_noscript_alternatives_fit_one_output_budget() {
    let input = "<script src='/edition.js'></script><noscript>First edition</noscript><noscript>Second edition</noscript>";
    assert_eq!(
        extract(
            input,
            "https://example.invalid/",
            &|v, _| v.into(),
            20,
            &|| Ok(())
        )
        .err(),
        Some(plur1bus_webtools::http::Failure::TooLarge)
    );
}
