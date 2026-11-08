//! Actual Node narrative responses and exact prompts through an offline provider.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use plur1bus_engine::{
    contract::{Cancel, HostError, LlmParams, LlmPort, LlmResult},
    neo::narrative,
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
struct Port {
    response: String,
    fail: bool,
    abort: bool,
    calls: Mutex<Vec<LlmParams>>,
}
impl LlmPort for Port {
    fn complete(&self, params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError> {
        self.calls.lock().unwrap().push(params);
        if self.abort {
            cancel.cancel();
        }
        if self.fail {
            return Err(HostError::Unavailable);
        }
        Ok(LlmResult {
            text: self.response.clone(),
            usage: None,
            model: None,
        })
    }
}
fn field<'a>(value: &'a Json, name: &str) -> Option<&'a Json> {
    let Json::Object(v) = value else { return None };
    v.iter()
        .find(|(k, _)| k == &JsString::from(name))
        .map(|(_, v)| v)
}
fn array(value: &Json) -> &[Json] {
    let Json::Array(v) = value else {
        panic!("array")
    };
    v
}
fn string(value: &Json) -> &JsString {
    let Json::String(v) = value else {
        panic!("string")
    };
    v
}
fn port(response: String) -> Port {
    Port {
        response,
        fail: false,
        abort: false,
        calls: Mutex::new(vec![]),
    }
}
#[test]
fn actual_node_narrative_results_and_prompt_hashes_match_with_named_exceptions() {
    let raw = include_bytes!("fixtures/capture/golden/neo-narrative.json");
    let golden = parse_json(std::str::from_utf8(raw).unwrap()).unwrap();
    let exceptions = parse_json(include_str!(
        "fixtures/capture/neo-narrative-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        string(field(&exceptions, "nodeGoldenSha256").unwrap()).to_utf8_lossy(),
        format!("{:x}", Sha256::digest(raw))
    );
    for case in array(field(&golden, "cases").unwrap()) {
        let exception = array(field(&exceptions, "cases").unwrap())
            .iter()
            .find(|e| field(e, "name") == field(case, "name"));
        let mut port = port(string(field(case, "response").unwrap()).to_utf8_lossy());
        port.fail = field(case, "fail") == Some(&Json::Bool(true));
        let names = field(case, "names").filter(|v| **v != Json::Null).map(|v| {
            (
                string(field(v, "user").unwrap()),
                string(field(v, "assistant").unwrap()),
            )
        });
        let result = narrative::enrich(
            field(case, "episode").unwrap(),
            array(field(case, "turns").unwrap()),
            names,
            Some(&port),
            &Cancel::never(),
        );
        if exception.and_then(|v| field(v, "refuse")) == Some(&Json::Bool(true)) {
            assert!(result.is_err());
            assert!(port.calls.lock().unwrap().is_empty());
            continue;
        }
        let expected = exception
            .and_then(|v| field(v, "result"))
            .unwrap_or_else(|| field(case, "result").unwrap());
        assert_eq!(
            result.unwrap(),
            *expected,
            "{}",
            write_json(field(case, "name").unwrap())
        );
        let expected = exception
            .and_then(|v| field(v, "calls"))
            .unwrap_or_else(|| field(case, "calls").unwrap());
        let calls = port.calls.lock().unwrap();
        assert_eq!(
            calls.len(),
            array(expected).len(),
            "{}",
            write_json(field(case, "name").unwrap())
        );
        for (actual, expected) in calls.iter().zip(array(expected)) {
            let messages = Json::Array(
                actual
                    .messages
                    .iter()
                    .map(|m| {
                        Json::Object(vec![
                            (
                                "role".into(),
                                parse_json(&serde_json::to_string(&m.role).unwrap()).unwrap(),
                            ),
                            ("content".into(), Json::String(m.content.as_str().into())),
                        ])
                    })
                    .collect(),
            );
            assert_eq!(&messages, field(expected, "messages").unwrap());
            assert_eq!(
                format!("{:x}", Sha256::digest(write_json(&messages).as_bytes())),
                string(field(expected, "sha256").unwrap()).to_utf8_lossy()
            );
            assert_eq!(actual.max_tokens, Some(500.into()));
            assert_eq!(actual.temperature, Some(0.into()));
            assert!(actual.model.is_none());
        }
    }
}
#[test]
fn provider_cancellation_and_native_budgets_refuse_without_partial_output() {
    let episode = parse_json(r#"{"id":"e","agentId":"alpha"}"#).unwrap();
    let turn = parse_json(r#"{"role":"user","content":"synthetic"}"#).unwrap();
    let mut port = port("{}".into());
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(narrative::enrich(
        &episode,
        &[turn.clone(), turn.clone()],
        None,
        Some(&port),
        &cancel
    )
    .is_err());
    assert!(port.calls.lock().unwrap().is_empty());
    assert!(narrative::enrich(
        &episode,
        &vec![turn.clone(); 513],
        None,
        Some(&port),
        &Cancel::never()
    )
    .is_err());
    assert!(port.calls.lock().unwrap().is_empty());
    port.abort = true;
    port.fail = true;
    assert!(narrative::enrich(
        &episode,
        &[turn.clone(), turn],
        None,
        Some(&port),
        &Cancel::never()
    )
    .is_err());
    assert_eq!(port.calls.lock().unwrap().len(), 1);
}

#[test]
fn input_size_and_final_prompt_bounds_precede_provider_egress() {
    let episode = parse_json(r#"{"id":"e","agentId":"alpha"}"#).unwrap();
    let turn = parse_json(r#"{"role":"user","content":"synthetic"}"#).unwrap();
    let port = port("{}".into());
    let huge = Json::Object(vec![
        ("role".into(), Json::String("user".into())),
        ("content".into(), Json::String("x".repeat(1_048_577).into())),
    ]);
    assert!(narrative::enrich(
        &episode,
        &[huge, turn.clone()],
        None,
        Some(&port),
        &Cancel::never()
    )
    .is_err());
    let huge_voice = Json::Object(vec![
        ("id".into(), Json::String("e".into())),
        (
            "voiceSpeakers".into(),
            Json::Array(vec![Json::String("x".repeat(65_536).into())]),
        ),
    ]);
    assert!(narrative::enrich(
        &huge_voice,
        &[turn.clone(), turn.clone()],
        None,
        Some(&port),
        &Cancel::never()
    )
    .is_err());
    assert!(port.calls.lock().unwrap().is_empty());
    let mut large = port;
    large.response = "x".repeat(65_537);
    assert_eq!(
        narrative::enrich(
            &episode,
            &[turn.clone(), turn],
            None,
            Some(&large),
            &Cancel::never()
        )
        .unwrap(),
        episode
    );
    assert_eq!(large.calls.lock().unwrap().len(), 1);
}
