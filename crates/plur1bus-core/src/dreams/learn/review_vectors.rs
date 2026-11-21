use super::*;
use serde_json::{json, Value};

struct Port<'a> {
    name: &'a str,
    calls: Vec<Value>,
}
impl ReadPort for Port<'_> {
    fn read(&mut self, _: &Target, path: &str, max_bytes: usize, _: &AbortSignal) -> ReadResult {
        self.calls
            .push(json!({"method":"file.read","args":{"path":path,"maxBytes":max_bytes}}));
        ReadResult {
            ok: self.name != "missing",
            truncated: self.name == "truncated",
            text: Some(match self.name {
                "byte cap" => "é".repeat(17_000),
                "contradicted" => "other text".into(),
                _ => "fixture token".into(),
            }),
        }
    }
}

fn read() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/learn/review.json"
    ))
    .unwrap()
}
fn native(value: &V) -> Value {
    serde_json::from_str(&value.stringify()).unwrap()
}

#[test]
fn scoped_read_verification_replays_typescript() {
    for row in read()["verification"].as_array().unwrap() {
        let name = row["name"].as_str().unwrap();
        let target: Target = serde_json::from_value(row["checked"]["target"].clone()).unwrap();
        let checked = V::from_serde(&row["checked"]);
        let mut port = Port {
            name,
            calls: Vec::new(),
        };
        let reader = (name != "no read port").then_some(&mut port as &mut dyn ReadPort);
        let verdict = verify(&target, &checked, reader, &AbortSignal::new(), || Ok(())).unwrap();
        assert_eq!(json!(verdict), row["expected"], "{name}");
        assert_eq!(json!(port.calls), row["calls"], "{name}");
    }
}

#[test]
fn model_review_exposes_only_the_approved_evidence() {
    for row in read()["review"].as_array().unwrap() {
        let name = row["name"].as_str().unwrap();
        let original = V::from_serde(&row["original"]);
        let sources = row["sources"]
            .as_array()
            .unwrap()
            .iter()
            .map(V::from_serde)
            .collect::<Vec<_>>();
        let stage = row["stage"].as_str().unwrap();
        let response = row["response"].as_str().unwrap();
        let mut calls = Vec::new();
        let result = if stage == "wording" {
            wording_data(&original).and_then(|value| {
                calls
                    .push(json!({"stage":stage,"key":row["original"]["id"],"data":native(&value)}));
                apply_wording(&original, response, "large-fixture")
            })
        } else {
            skeptic_data(&original, &sources).and_then(|data| {
                let Some(data) = data else {
                    return Ok(original.clone());
                };
                calls.push(json!({"stage":stage,"key":row["original"]["id"],"data":native(&data)}));
                apply_skeptic(&original, response, "large-fixture")
            })
        };
        let actual = match result {
            Ok(v) => json!({"result":native(&v)}),
            Err(e) => json!({"error":e.as_str()}),
        };
        assert_eq!(actual, row["expected"], "{name}");
        assert_eq!(json!(calls), row["calls"], "{name}");
    }
}
