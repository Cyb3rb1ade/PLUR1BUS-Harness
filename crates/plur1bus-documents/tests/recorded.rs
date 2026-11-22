#![allow(
    clippy::unwrap_used,
    reason = "checked records from the TypeScript exporter"
)]

use plur1bus_documents::{contrast, markdown};
use serde_json::Value;

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
fn authored_templates_replay_complete_typescript_markup() {
    use plur1bus_documents::templates::{self, Document, Kit, LineItem, Meta};

    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/documents/templates.json"
    ))
    .unwrap();
    for vector in fixture["cases"].as_array().unwrap() {
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
        let actual = templates::assemble(
            kind.parse().unwrap(),
            &Document {
                title: input["title"].as_str().unwrap(),
                subtitle: input["subtitle"].as_str().unwrap(),
                markdown: input["markdown"].as_str().unwrap(),
                meta,
                kit,
            },
        );
        assert_eq!(actual, vector["expected"], "{kind}");
    }
}
