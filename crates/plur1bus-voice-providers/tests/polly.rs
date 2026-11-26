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
    limit: usize,
    pages: Vec<Value>,
    audio: Vec<u8>,
    synthesis: RefCell<Vec<Value>>,
    lists: RefCell<Vec<Value>>,
}

impl Ports for Fixture {
    fn wall_time(&self) -> std::time::SystemTime {
        std::time::UNIX_EPOCH
    }

    fn stream_limits(&self) -> plur1bus_voice_providers::http::StreamLimits {
        plur1bus_voice_providers::http::StreamLimits {
            max_audio_bytes: self.limit,
            ..Default::default()
        }
    }
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
        limit: 64 * 1024 * 1024,
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

#[test]
fn text_input_is_sent_in_recorded_sentence_and_word_windows() {
    use plur1bus_voice_providers::polly::synthesize_stream;

    let recording: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/voice/polly.json")).unwrap();
    let expected = &recording["expected"];
    let port = Fixture {
        limit: 64 * 1024 * 1024,
        pages: Vec::new(),
        audio: serde_json::from_value(expected["data"].clone()).unwrap(),
        synthesis: RefCell::new(Vec::new()),
        lists: RefCell::new(Vec::new()),
    };
    let input = &recording["input"];
    let chunks = recording["stream"]["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry.as_str().unwrap());
    let mut observed = Vec::new();
    synthesize_stream(
        &port,
        chunks,
        &Options {
            voice: input["voice"].as_str().unwrap(),
            ..Options::default()
        },
        recording["stream"]["maxWords"]
            .as_u64()
            .map(|value| value as usize),
        Duration::from_secs(5),
        |audio| {
            assert_eq!(
                audio.format,
                plur1bus_voice_providers::elevenlabs::AudioFormat::Pcm16
            );
            observed
                .push(json!({"bytes":audio.bytes,"format":"pcm16","sampleRate":audio.sample_rate}));
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(json!(observed), expected["streamAudio"]);
    assert_eq!(json!(*port.synthesis.borrow()), recording["streamRequests"]);
}

#[test]
fn unfinished_input_and_single_delta_have_independent_byte_ceilings() {
    use plur1bus_voice_providers::polly::synthesize_stream;
    let port = Fixture {
        limit: 64 * 1024 * 1024,
        pages: Vec::new(),
        audio: Vec::new(),
        synthesis: RefCell::new(Vec::new()),
        lists: RefCell::new(Vec::new()),
    };
    let options = Options {
        voice: "FixtureVoice",
        ..Options::default()
    };
    let budget = Duration::from_secs(5);
    let limit = 1024 * 1024;
    let half = " ".repeat(limit / 2);
    let over = format!("A sentence. {}", " ".repeat(limit - 11));
    assert_eq!(over.len(), limit + 1);
    assert_eq!(
        synthesize_stream(&port, [over.as_str()], &options, None, budget, |_| Ok(())),
        Err(Error::InvalidRequest)
    );
    assert_eq!(
        synthesize_stream(
            &port,
            [half.as_str(), half.as_str(), " "],
            &options,
            None,
            budget,
            |_| Ok(())
        ),
        Err(Error::InvalidRequest)
    );
    assert!(port.synthesis.borrow().is_empty());
}

#[test]
fn cancellation_is_checked_during_a_single_text_delta() {
    use plur1bus_voice_providers::polly::synthesize_stream;
    use std::cell::Cell;

    #[derive(Default)]
    struct CancelDuringScan(Cell<usize>);
    impl Ports for CancelDuringScan {
        fn wall_time(&self) -> std::time::SystemTime {
            std::time::UNIX_EPOCH
        }

        fn pin(&self, _: &Url, _: Instant) -> Option<SocketAddr> {
            None
        }
        fn cancelled(&self) -> bool {
            let previous = self.0.get();
            self.0.set(previous + 1);
            previous >= 3
        }
    }
    impl SignedRequests for CancelDuringScan {
        fn synthesize(&self, _: &Request<'_>, _: Instant) -> Result<Box<dyn Read>, Error> {
            Err(Error::UpstreamProtocol)
        }
        fn describe_voices(&self, _: Option<&str>, _: Instant) -> Result<Box<dyn Read>, Error> {
            Err(Error::UpstreamProtocol)
        }
    }
    let host = CancelDuringScan::default();
    let delta = " ".repeat(4096);
    let options = Options {
        voice: "FixtureVoice",
        ..Options::default()
    };
    assert_eq!(
        synthesize_stream(
            &host,
            [delta.as_str()],
            &options,
            None,
            Duration::from_secs(2),
            |_| Ok(())
        ),
        Err(Error::Aborted)
    );
}

#[test]
fn polly_checks_the_text_length_before_submitting_the_request() {
    let host = Fixture {
        limit: 64 * 1024 * 1024,
        pages: Vec::new(),
        audio: vec![1, 0],
        synthesis: RefCell::new(Vec::new()),
        lists: RefCell::new(Vec::new()),
    };
    let options = Options {
        voice: "FixtureVoice",
        ..Options::default()
    };
    assert!(synthesize(&host, &"x".repeat(3000), &options, Duration::from_secs(2)).is_ok());
    assert_eq!(
        synthesize(&host, &"x".repeat(3001), &options, Duration::from_secs(2)).err(),
        Some(Error::InvalidRequest)
    );
    assert_eq!(host.synthesis.borrow().len(), 1);
}

#[test]
fn polly_describe_voices_stops_at_twenty_pages() {
    let host = Fixture {
        limit: 64 * 1024 * 1024,
        pages: vec![json!({"Voices":[{"Id":"fixture"}],"NextToken":"next"}); 2],
        audio: Vec::new(),
        synthesis: RefCell::new(Vec::new()),
        lists: RefCell::new(Vec::new()),
    };
    let results = list_voices(&host, Duration::from_secs(2)).unwrap();
    assert_eq!(results.len(), 20);
    assert_eq!(host.lists.borrow().len(), 20);
}

#[test]
fn polly_stops_submitting_billable_sentences_when_the_audio_budget_is_spent() {
    let host = Fixture {
        limit: 2,
        pages: Vec::new(),
        audio: vec![1, 0],
        synthesis: RefCell::new(Vec::new()),
        lists: RefCell::new(Vec::new()),
    };
    let options = Options {
        voice: "FixtureVoice",
        ..Options::default()
    };
    let mut chunks = Vec::new();
    let result = plur1bus_voice_providers::polly::synthesize_stream(
        &host,
        ["First sentence! Second sentence!"],
        &options,
        None,
        Duration::from_secs(2),
        |chunk| {
            chunks.push(chunk.bytes);
            Ok(())
        },
    );
    assert_eq!(result.err().map(|err| err.code()), Some("stream_limit"));
    assert_eq!(chunks, [vec![1, 0]]);
    assert_eq!(host.synthesis.borrow().len(), 1);
}
