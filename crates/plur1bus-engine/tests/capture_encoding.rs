//! Actual frozen Node encoding/refinement outputs and byte-exact injected host messages.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use plur1bus_engine::{
    capture::encoding,
    contract::{Cancel, HostError, LlmParams, LlmPort, LlmResult, MessageRole},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
const NOW: i64 = 1_710_000_000_000;
fn get<'a>(v: &'a Json, k: &str) -> &'a Json {
    static NULL: Json = Json::Null;
    if let Json::Object(fields) = v {
        fields
            .iter()
            .rev()
            .find(|(key, _)| key == &JsString::from(k))
            .map_or(&NULL, |(_, v)| v)
    } else {
        &NULL
    }
}
fn array(v: &Json) -> &[Json] {
    if let Json::Array(v) = v {
        v
    } else {
        &[]
    }
}
fn text(v: &Json) -> String {
    if let Json::String(v) = v {
        v.to_utf8_lossy()
    } else {
        String::new()
    }
}
fn js(v: &Json) -> JsString {
    if let Json::String(v) = v {
        v.clone()
    } else {
        JsString::from("")
    }
}
fn fixture() -> Json {
    parse_json(include_str!("fixtures/capture/golden/encoding.json")).unwrap()
}
fn messages(params: &LlmParams) -> String {
    #[derive(serde::Serialize)]
    struct Message<'a> {
        role: &'a MessageRole,
        content: &'a str,
    }
    serde_json::to_string(
        &params
            .messages
            .iter()
            .map(|m| Message {
                role: &m.role,
                content: &m.content,
            })
            .collect::<Vec<_>>(),
    )
    .unwrap()
}
#[test]
fn actual_node_parser_rejects_coerced_importance_and_preserves_order_and_unicode_reference() {
    let old = parse_json(include_str!("fixtures/capture/golden/emotion.json")).unwrap();
    for case in array(get(get(&old, "results"), "encoding"))
        .iter()
        .chain(array(get(&fixture(), "parsing")))
    {
        assert_eq!(
            write_json(&encoding::parse_response(&text(get(case, "input")))),
            text(get(case, "line"))
        );
    }
}
#[test]
fn actual_node_prompt_bytes_and_hashes_match_at_utf16_budget_edges() {
    let old = parse_json(include_str!("fixtures/capture/golden/emotion.json")).unwrap();
    for case in array(get(get(&old, "results"), "encodingPrompts")) {
        let input = js(get(case, "input"));
        assert_eq!(
            encoding::truncate_for_prompt(&input, 2000).to_json(),
            text(get(case, "truncatedLine"))
        );
        let params = encoding::params(&input).unwrap();
        let line = messages(&params);
        assert_eq!(line, text(get(case, "promptLine")));
        assert_eq!(
            format!("{:x}", Sha256::digest(line.as_bytes())),
            text(get(case, "promptHash"))
        );
        assert!(
            params.model.is_none() && params.temperature.is_none() && params.max_tokens.is_none()
        );
    }
}
#[test]
fn actual_refinement_preserves_manual_importance_strength_and_rollback_provenance() {
    for case in array(get(&fixture(), "refinement")) {
        let patch = encoding::refine_patch(
            get(case, "row"),
            get(case, "encoding"),
            NOW,
            get(get(case, "options"), "flashbulbEncodingEnabled") == &Json::Bool(true),
        )
        .unwrap();
        let expected = text(get(case, "line"));
        let expected = if get(case, "unicodeBoundary") == &Json::Bool(true) {
            assert!(expected.contains("\\ud83d"));
            expected.replace("\\ud83d", "") // F3: reference retained; outward persisted reason ends on a code point.
        } else {
            expected
        };
        assert_eq!(
            write_json(&patch),
            expected,
            "row {}",
            write_json(get(case, "row"))
        );
        assert_eq!(get(&patch, "updateSource"), &Json::Null);
        assert_eq!(get(&patch, "updateEvidence"), &Json::Null);
        if get(&patch, "memoryClass") == &Json::Null {
            assert_eq!(get(&patch, "lastDynamicsAt"), &Json::Null);
        }
    }
    assert!(encoding::refine_patch(&Json::Null, &Json::Null, NOW, true).is_none());
}
struct Port {
    mode: String,
    calls: Mutex<Vec<String>>,
}
impl LlmPort for Port {
    fn complete(&self, params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError> {
        self.calls.lock().unwrap().push(messages(&params));
        let answer = match self.mode.as_str() {
            "throw" => return Err(HostError::Failed),
            "cancel" => {
                cancel.cancel();
                return Err(HostError::Failed);
            }
            "empty" => "",
            "invalid" => "invalid fixture answer",
            "refused" => r#"{"importance":null}"#,
            "valid" => r#"{"importance":0.8,"intensity":0.7,"dominant":"trust"}"#,
            _ => panic!("unknown fixture mode"),
        };
        Ok(LlmResult {
            text: answer.into(),
            model: None,
            usage: None,
        })
    }
}
#[test]
fn host_route_failures_remain_distinct_from_received_but_unusable_judgments() {
    for case in array(get(&fixture(), "calls")) {
        let port = Port {
            mode: text(get(case, "mode")),
            calls: Mutex::new(vec![]),
        };
        let route = if port.mode == "missing" {
            None
        } else {
            Some(&port as &dyn LlmPort)
        };
        let result = encoding::classify(
            &JsString::from("A public fixture memory."),
            route,
            &Cancel::never(),
        )
        .unwrap();
        assert_eq!(write_json(&result), text(get(case, "line")));
        let calls = port.calls.lock().unwrap();
        if port.mode == "missing" {
            assert!(calls.is_empty());
        } else {
            assert_eq!(calls.as_slice(), [write_json(get(case, "messages"))]);
            assert_eq!(
                format!("{:x}", Sha256::digest(calls[0].as_bytes())),
                text(get(case, "promptHash"))
            );
        }
    }
}
#[test]
fn cancelled_encoding_is_not_misreported_as_a_retryable_route_failure() {
    let port = Port {
        mode: "cancel".into(),
        calls: Mutex::new(vec![]),
    };
    let input = JsString::from("public fixture text");
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(encoding::classify(&input, Some(&port), &cancel).is_err());
    assert!(port.calls.lock().unwrap().is_empty());
    assert!(encoding::classify(&input, Some(&port), &Cancel::never()).is_err());
    assert_eq!(port.calls.lock().unwrap().len(), 1);
}
