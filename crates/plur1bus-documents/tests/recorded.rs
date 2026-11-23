#![allow(
    clippy::unwrap_used,
    reason = "checked records from the TypeScript exporter"
)]

use plur1bus_documents::{contrast, markdown};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

#[test]
fn markdown_and_contrast_replay_the_real_document_helpers() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/documents/pure.json")).unwrap();
    for vector in fixture["markdown"].as_array().unwrap() {
        assert_eq!(
            markdown::to_html(vector["input"].as_str().unwrap()),
            vector["html"]
        );
    }
    for vector in fixture["ratios"].as_array().unwrap() {
        let result = contrast::ratio(
            vector["foreground"].as_str().unwrap(),
            vector["background"].as_str().unwrap(),
        );
        if let Some(expected) = vector["ratio"].as_f64() {
            assert!((result.unwrap() - expected).abs() <= 1e-12);
        } else {
            assert_eq!(result, Err(contrast::InvalidColour));
        }
    }
}

#[test]
fn review_findings_match_the_typescript_checks() {
    use plur1bus_documents::checks::{static_checks, summarize};
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/documents/checks.json"
    ))
    .unwrap();
    let input = &fixture["input"];
    let findings = static_checks(input["html"].as_str().unwrap());
    let report = summarize(
        findings,
        input["vision"].as_bool().unwrap(),
        input["fixed"]
            .as_array()
            .unwrap()
            .iter()
            .map(|fix| fix.as_str().unwrap()),
    );
    assert_eq!(serde_json::to_value(report).unwrap(), fixture["result"]);
}

#[test]
fn authored_templates_replay_complete_typescript_markup() {
    use plur1bus_documents::render::{assemble_html, FontDirectory};
    use plur1bus_documents::templates::{self, Document, Kit, LineItem, Meta};

    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/documents/templates.json"
    ))
    .unwrap();
    let font_fixtures: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/documents/render-html.json"
    ))
    .unwrap();
    let fonts = FontDirectory::new(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/documents/assets/fonts"),
    );
    let renders = font_fixtures["render"].as_array().unwrap();
    assert_eq!(renders.len(), fixture["cases"].as_array().unwrap().len());
    for (vector, rendered) in fixture["cases"].as_array().unwrap().iter().zip(renders) {
        let input = &vector["input"];
        let data = &input["meta"];
        let lines: Vec<_> = data["lineItems"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| LineItem {
                label: line["label"].as_str().unwrap(),
                amount: line["amount"].as_str().unwrap(),
            })
            .collect();
        let get = |name: &str| data[name].as_str().unwrap();
        let meta = Meta {
            title: Some(get("title")),
            author: get("author"),
            date: get("date"),
            from: get("from"),
            to: get("to"),
            subject: get("subject"),
            salutation: get("salutation"),
            closing: get("closing"),
            role: get("role"),
            total: get("total"),
            line_items: &lines,
        };
        let mut kit = Kit::default();
        for (token, value) in input["colors"].as_object().unwrap() {
            kit.set(token, value.as_str().unwrap()).unwrap();
        }
        let kind = input["template"].as_str().unwrap();
        let template = kind.parse().unwrap();
        let document = Document {
            title: input["title"].as_str().unwrap(),
            subtitle: input["subtitle"].as_str().unwrap(),
            markdown: input["markdown"].as_str().unwrap(),
            meta,
            kit,
        };
        let actual = templates::assemble(template, &document);
        assert_eq!(actual, vector["expected"], "{kind}");
        let html = assemble_html(template, &document, &fonts).unwrap();
        assert!(
            plur1bus_documents::checks::static_checks(&html)
                .iter()
                .all(|finding| finding.check != "fonts"),
            "{kind}"
        );
        assert_eq!(html.len() as u64, rendered["bytes"], "{kind}");
        assert_eq!(
            format!("{:x}", Sha256::digest(html.as_bytes())),
            rendered["sha256"],
            "{kind}"
        );
    }
}
