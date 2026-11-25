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
        // P4D-251 adds the resource policy to the Rust template.
        let policy = format!(
            "<meta http-equiv=\"Content-Security-Policy\" content=\"{}\">\n",
            templates::DOCUMENT_CSP
        );
        let actual = templates::assemble(template, &document);
        assert_eq!(actual.matches(&policy).count(), 1);
        assert_eq!(
            actual.replacen(&policy, "", 1),
            vector["expected"],
            "{kind}"
        );
        let html = assemble_html(template, &document, &fonts).unwrap();
        assert!(
            plur1bus_documents::checks::static_checks(&html)
                .iter()
                .all(|finding| finding.check != "fonts"),
            "{kind}"
        );
        let html = html.replacen(&policy, "", 1);
        assert_eq!(html.len() as u64, rendered["bytes"], "{kind}");
        assert_eq!(
            format!("{:x}", Sha256::digest(html.as_bytes())),
            rendered["sha256"],
            "{kind}"
        );
    }
}

#[test]
fn templates_declare_a_closed_resource_policy() {
    use plur1bus_documents::templates::{assemble, Document, Kit, Meta, Template};
    let html = assemble(
        Template::Report,
        &Document {
            title: "Fixture",
            subtitle: "",
            markdown: "An ordinary paragraph.",
            meta: Meta::default(),
            kit: Kit::default(),
        },
    );
    let policy = html
        .lines()
        .find(|line| line.contains("Content-Security-Policy"))
        .unwrap();
    assert!(policy.contains("default-src 'none'"));
    assert!(policy.contains("connect-src 'none'"));
    assert!(policy.contains("frame-src 'none'"));
    assert!(policy.contains("font-src data:"));
    assert!(policy.contains("img-src data:"));
}

#[test]
fn brand_kit_accepts_hex_colours_and_refuses_other_literals() {
    use plur1bus_documents::templates::Kit;
    let mut kit = Kit::default();
    assert!(kit.set("accent", "#134280").is_ok());
    assert!(kit.set("accent", "red").is_err());
    assert!(kit.set("accent", "#12345").is_err());
    assert!(kit.set("accent", "#fff ").is_err());
}

#[test]
fn escaped_attribute_like_text_remains_readable_in_authored_templates() {
    use plur1bus_documents::templates::{self, Document, Kit, Meta};
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/documents/sanitizer.json"
    ))
    .unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 50);
    for case in cases {
        let input = &case["input"];
        let markdown = input["markdown"].as_str().unwrap();
        let template = input["template"].as_str().unwrap().parse().unwrap();
        let escaped = case["escaped"].as_str().unwrap();
        let actual = templates::assemble(
            template,
            &Document {
                title: "Fixture",
                subtitle: "",
                markdown,
                meta: Meta::default(),
                kit: Kit::default(),
            },
        );
        assert!(actual.contains(escaped), "{input}");
        assert!(!actual.contains("<entry"));
        if case["expectedDivergence"] == "P4D-252" {
            assert_ne!(escaped, case["sanitized"].as_str().unwrap());
        } else {
            let directive = format!(
                "<meta http-equiv=\"Content-Security-Policy\" content=\"{}\">\n",
                templates::DOCUMENT_CSP
            );
            let comparable = actual.replacen(&directive, "", 1);
            assert_eq!(
                format!("{:x}", Sha256::digest(comparable.as_bytes())),
                case["typescriptSha256"],
                "{input}"
            );
        }
    }
}

#[test]
fn cv_role_is_escaped_in_the_document() {
    use plur1bus_documents::templates::{assemble, Document, Kit, Meta, Template};
    let html = assemble(
        Template::Cv,
        &Document {
            title: "CV",
            subtitle: "",
            markdown: "",
            kit: Kit::default(),
            meta: Meta {
                role: "Design & <Research>",
                ..Meta::default()
            },
        },
    );
    assert!(html.contains("Design &amp; &lt;Research&gt;"));
}
