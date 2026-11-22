#![allow(
    clippy::unwrap_used,
    reason = "assertions over the genuine TypeScript recording"
)]

use plur1bus_voice_providers::{
    http::{Error, Ports},
    polly::{list_models, list_voices, synthesize, Options, Request, SignedRequests},
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    io::{Cursor, Read},
    net::SocketAddr,
    time::{Duration, Instant},
};
use url::Url;

struct Fixture {
    pages: Vec<Value>,
    audio: Vec<u8>,
    synthesis: RefCell<Vec<Value>>,
    lists: RefCell<Vec<Value>>,
}

impl Ports for Fixture {
    fn pin(&self, _: &Url, _: Instant) -> Option<SocketAddr> {
        None
    }
}

impl SignedRequests for Fixture {
    fn synthesize(&self, request: &Request<'_>, _: Instant) -> Result<Box<dyn Read>, Error> {
        let mut call = json!({
            "Text":request.text, "VoiceId":request.voice, "Engine":request.engine,
            "OutputFormat":request.output_format, "SampleRate":request.sample_rate,
        });
        if let Some(language) = request.language {
            call["LanguageCode"] = json!(language);
        }
        self.synthesis.borrow_mut().push(call);
        Ok(Box::new(Cursor::new(self.audio.clone())))
    }

    fn describe_voices(&self, next: Option<&str>, _: Instant) -> Result<Box<dyn Read>, Error> {
        self.lists
            .borrow_mut()
            .push(next.map_or_else(|| json!({}), |token| json!({"NextToken":token})));
        let index = usize::from(next.is_some());
        let bytes = serde_json::to_vec(&self.pages[index]).unwrap();
        Ok(Box::new(Cursor::new(bytes)))
    }
}

#[test]
fn signed_request_arguments_and_projection_match_recorded_typescript() {
    let recording: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/voice/polly.json")).unwrap();
    let expected = &recording["expected"];
    let port = Fixture {
        pages: recording["pages"].as_array().unwrap().clone(),
        audio: serde_json::from_value(expected["data"].clone()).unwrap(),
        synthesis: RefCell::new(Vec::new()),
        lists: RefCell::new(Vec::new()),
    };
    let input = &recording["input"];
    let timeout = Duration::from_secs(5);
    let audio = synthesize(
        &port,
        input["text"].as_str().unwrap(),
        &Options {
            voice: input["voice"].as_str().unwrap(),
            language: input["language"].as_str(),
            ..Options::default()
        },
        timeout,
    )
    .unwrap();
    assert_eq!(json!(audio.bytes), expected["data"]);
    assert_eq!(audio.sample_rate, expected["sampleRate"]);
    assert_eq!(audio.model, expected["usage"]["model"]);
    assert_eq!(audio.input_utf16_units, expected["usage"]["chars"]);
    assert_eq!(
        json!(list_voices(&port, timeout).unwrap()),
        expected["voices"]
    );
    assert_eq!(
        json!(list_models(&port, timeout).unwrap()),
        expected["models"]
    );
    assert_eq!(
        json!(*port.synthesis.borrow()),
        recording["synthesisRequests"]
    );
    assert_eq!(json!(*port.lists.borrow()), recording["listRequests"]);
}
