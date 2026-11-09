//! Actual pinned merge decisions and exact host messages through a deterministic offline port.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "frozen fixture assertions"
)]
use plur1bus_engine::{
    capture::merge_decision,
    contract::{Cancel, HostError, LlmParams, LlmPort, LlmResult},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use std::sync::Mutex;
fn get<'a>(v: &'a Json, key: &str) -> &'a Json {
    let Json::Object(v) = v else { panic!("object") };
    v.iter()
        .find(|(k, _)| k == &JsString::from(key))
        .map(|(_, v)| v)
        .unwrap_or(&Json::Null)
}
fn array(v: &Json) -> &[Json] {
    let Json::Array(v) = v else { panic!("array") };
    v
}
fn string(v: &Json) -> String {
    let Json::String(v) = v else { panic!("string") };
    String::from_utf16(v.as_utf16_units()).unwrap()
}
struct Port {
    response: String,
    fail: bool,
    abort: bool,
    calls: Mutex<Vec<LlmParams>>,
}
impl LlmPort for Port {
    fn complete(&self, p: LlmParams, c: &Cancel) -> Result<LlmResult, HostError> {
        self.calls.lock().unwrap().push(p);
        if self.abort {
            c.cancel();
        }
        if self.fail {
            return Err(HostError::Unavailable);
        }
        Ok(LlmResult {
            text: self.response.clone(),
            model: None,
            usage: None,
        })
    }
}
#[test]
fn node_results_and_request_contracts_match_except_named_unicode_projection() {
    use sha2::{Digest, Sha256};
    let bytes = include_bytes!("fixtures/capture/golden/merge-decision.json");
    let golden = parse_json(std::str::from_utf8(bytes).unwrap()).unwrap();
    let exceptions = parse_json(include_str!(
        "fixtures/capture/merge-decision-native-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        string(get(&exceptions, "nodeGoldenSha256")),
        format!("{:x}", Sha256::digest(bytes))
    );
    for case in array(get(&golden, "recordings")) {
        let name = string(get(case, "name"));
        let port_name = string(get(case, "port"));
        let response = string(get(case, "response"));
        let port = Port {
            response,
            fail: port_name == "reject",
            abort: false,
            calls: Mutex::new(vec![]),
        };
        let cancel = Cancel::never();
        if get(case, "aborted") == &Json::Bool(true) {
            cancel.cancel();
        }
        let model = match get(get(case, "config"), "model") {
            Json::String(v) => Some(v.to_utf8_lossy()),
            _ => None,
        };
        let result = merge_decision::check(
            if port_name == "absent" {
                None
            } else {
                Some(&port)
            },
            get(case, "a"),
            get(case, "b"),
            model.as_deref(),
            &cancel,
        );
        if get(case, "error") != &Json::Null {
            assert!(result.is_err(), "{name}");
        } else {
            assert_eq!(
                write_json(
                    &result
                        .unwrap_or_else(|e| panic!("{name}: {e}"))
                        .unwrap_or(Json::Null)
                ),
                string(get(case, "resultLine")),
                "{name}"
            );
        }
        let calls = port.calls.lock().unwrap();
        assert_eq!(calls.len(), array(get(case, "calls")).len(), "{name}");
        if let Some(call) = calls.first() {
            let node = get(&array(get(case, "calls"))[0], "contract");
            assert_eq!(string(get(node, "purpose")), merge_decision::PURPOSE);
            assert_eq!(call.temperature, None);
            assert_eq!(call.max_tokens.as_ref().unwrap().as_u64(), Some(300));
            assert_eq!(call.model, model);
            let raw =
                merge_decision::messages(get(case, "a"), get(case, "b"), &Cancel::never()).unwrap();
            assert_eq!(
                write_json(&raw),
                write_json(get(node, "messages")),
                "{name}"
            );
            let exception = array(get(&exceptions, "cases"))
                .iter()
                .find(|e| string(get(e, "name")) == name);
            let expected = exception.map_or(get(node, "messages"), |e| get(e, "messages"));
            assert_eq!(call.messages.len(), 1);
            assert_eq!(
                call.messages[0].content,
                string(get(&array(expected)[0], "content")),
                "{name}"
            );
        }
    }
}
#[test]
fn cancelled_provider_and_bounded_response_cannot_produce_a_decision() {
    let a = Json::String("A".into());
    let b = Json::String("B".into());
    for mode in ["cancel", "oversize"] {
        let p = Port {
            response: if mode == "oversize" {
                "x".repeat(1_048_577)
            } else {
                "{\"merge\":true,\"reason\":\"fixture\",\"mergedText\":\"A B\"}".into()
            },
            fail: false,
            abort: mode == "cancel",
            calls: Mutex::new(vec![]),
        };
        assert!(merge_decision::check(Some(&p), &a, &b, None, &Cancel::never()).is_err());
    }
    let large = Json::String(JsString::from("x".repeat(1_048_577)));
    assert!(merge_decision::messages(&large, &b, &Cancel::never()).is_err());
}
