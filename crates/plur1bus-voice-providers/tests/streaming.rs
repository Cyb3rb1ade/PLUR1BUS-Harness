#![allow(clippy::unwrap_used, reason = "loopback fixture assertions")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_channels::websocket::{SocketPorts, TimedStream};
use plur1bus_voice_providers::{
    elevenlabs::{stream_synthesis, AudioFormat, SynthesisOptions, TtsSocket, VoiceSettings},
    http::{Client, Ports},
};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::{json, Value};
use std::{
    io,
    net::SocketAddr,
    time::{Duration, Instant},
};
use url::Url;

const CREDENTIAL: &str = "synthetic-voice-credential";
const BUDGET: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct Pin {
    addr: SocketAddr,
    expected_target: String,
}

impl Pin {
    fn agreed_endpoint(&self, endpoint: &Url) -> Option<SocketAddr> {
        let target = &endpoint[url::Position::BeforePath..];
        assert_eq!(target, self.expected_target);
        assert!(!target.contains(CREDENTIAL));
        Some(self.addr)
    }
}

impl Ports for Pin {
    fn wall_time(&self) -> std::time::SystemTime {
        std::time::UNIX_EPOCH
    }

    fn pin(&self, endpoint: &Url, _: Instant) -> Option<SocketAddr> {
        self.agreed_endpoint(endpoint)
    }
}

impl SocketPorts for Pin {
    fn wall_time(&self) -> std::time::SystemTime {
        std::time::UNIX_EPOCH
    }

    fn resolver(&self) -> plur1bus_providers::resolution::Resolver<Url, Option<SocketAddr>> {
        let host = self.clone();
        std::sync::Arc::new(move |endpoint, _, _| host.agreed_endpoint(endpoint))
    }

    fn dial(
        &self,
        _: &Url,
        addr: SocketAddr,
        deadline: Instant,
    ) -> io::Result<Box<dyn TimedStream>> {
        plur1bus_providers::connect_pinned_tcp(addr, deadline, &|| SocketPorts::cancelled(self))
            .map(|stream| Box::new(stream) as Box<dyn TimedStream>)
    }
}

fn options(input: &Value) -> SynthesisOptions<'_> {
    SynthesisOptions {
        voice: input["voice"].as_str().unwrap(),
        language: input["language"].as_str(),
        zero_retention: true,
        ..Default::default()
    }
}

fn recorded_settings(input: &Value) -> Vec<(String, Value)> {
    serde_json::from_value(input["voiceSettingsEntries"].clone()).unwrap()
}

#[test]
fn http_stream_replays_the_recorded_request_audio_and_usage() {
    let fixture = serde_json::from_str::<Value>(include_str!(
        "../../../fixtures/parity/voice/synthesis-http-stream.json"
    ))
    .unwrap();
    let exchange = &fixture["exchanges"][0];
    let server = FakeServer::start(&fixture);
    let pin = Pin {
        addr: server.addr,
        expected_target: exchange["request"]["path"].as_str().unwrap().into(),
    };
    let base = Url::parse(&format!("http://{}", server.addr)).unwrap();
    let base = base.join("/v1").unwrap();
    let client = Client::new(&pin).with_loopback_http();
    let input = &fixture["input"];
    let settings = recorded_settings(input);
    let options = SynthesisOptions {
        voice_settings: Some(VoiceSettings(&settings)),
        ..options(input)
    };
    let mut audio = Vec::new();
    let usage = stream_synthesis(
        &client,
        &base,
        CREDENTIAL,
        input["text"].as_str().unwrap(),
        &options,
        BUDGET,
        |chunk| {
            assert_eq!(chunk.format, AudioFormat::Pcm16);
            assert_eq!(
                chunk.sample_rate,
                fixture["expected"]["sampleRate"].as_u64().unwrap() as u32
            );
            audio.extend_from_slice(chunk.bytes);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(STANDARD.encode(audio), fixture["expected"]["dataBase64"]);
    assert_eq!(usage.model, fixture["expected"]["usage"]["model"]);
    assert_eq!(
        usage.input_utf16_units,
        fixture["expected"]["usage"]["chars"].as_u64().unwrap() as usize
    );
    let requests = server.received();
    assert_eq!(requests[0]["body"], exchange["request"]["bodyText"]);
    assert_eq!(requests[0]["headers"]["xi-api-key"], CREDENTIAL);
}

#[test]
fn websocket_stream_replays_the_recorded_dialogue_audio_and_usage() {
    let fixture = socket_fixture();
    let server = FakeServer::start(&fixture);
    let pin = Pin {
        addr: server.addr,
        expected_target: fixture["request"]["path"].as_str().unwrap().into(),
    };
    let base = Url::parse(&format!("http://{}", server.addr)).unwrap();
    let input = &fixture["input"];
    let settings = recorded_settings(input);
    let options = SynthesisOptions {
        voice_settings: Some(VoiceSettings(&settings)),
        ..options(input)
    };
    let mut stream = TtsSocket::connect(&base, CREDENTIAL, &options, &pin, BUDGET, true).unwrap();
    assert!(stream.usage().is_none());
    for text in input["text"].as_array().unwrap() {
        stream.send_text(text.as_str().unwrap()).unwrap();
    }
    stream.finish_input().unwrap();
    let mut chunks = Vec::new();
    while let Some(chunk) = stream.next_audio().unwrap() {
        assert_eq!(chunk.format, AudioFormat::Pcm16);
        chunks.push(json!({"dataBase64": STANDARD.encode(chunk.bytes), "format":"pcm16", "sampleRate":chunk.sample_rate}));
    }
    let usage = stream.usage().unwrap();
    assert_eq!(json!(chunks), fixture["expected"]["chunks"]);
    assert_eq!(usage.model, fixture["expected"]["usage"]["model"]);
    assert_eq!(
        usage.input_utf16_units,
        fixture["expected"]["usage"]["chars"].as_u64().unwrap() as usize
    );
    assert_eq!(json!(server.received()), fixture["exchanges"][0]["send"]);
    let upgrades = server.websocket_upgrades();
    assert_eq!(upgrades.len(), 1);
    assert_eq!(upgrades[0]["path"], fixture["request"]["path"]);
    assert_eq!(upgrades[0]["headers"]["xi-api-key"], CREDENTIAL);
}

fn socket_fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../fixtures/parity/voice/synthesis-ws-stream.json"
    ))
    .unwrap()
}

#[test]
fn websocket_provider_error_drops_its_text_and_never_reports_usage() {
    use plur1bus_voice_providers::http::Error;

    let mut fixture = socket_fixture();
    fixture["exchanges"][0]["receive"] = json!([{
        "message_type": "error", "code": "rate_limited", "message": CREDENTIAL,
    }]);
    let server = FakeServer::start(&fixture);
    let pin = Pin {
        addr: server.addr,
        expected_target: fixture["request"]["path"].as_str().unwrap().into(),
    };
    let base = Url::parse(&format!("http://{}", server.addr)).unwrap();
    let input = &fixture["input"];
    let settings = recorded_settings(input);
    let options = SynthesisOptions {
        voice_settings: Some(VoiceSettings(&settings)),
        ..options(input)
    };
    let mut stream = TtsSocket::connect(&base, CREDENTIAL, &options, &pin, BUDGET, true).unwrap();
    for text in input["text"].as_array().unwrap() {
        stream.send_text(text.as_str().unwrap()).unwrap();
    }
    stream.finish_input().unwrap();
    let error = stream.next_audio().err().unwrap();
    assert_eq!(error, Error::RateLimited);
    assert!(!format!("{error:?} {error}").contains(CREDENTIAL));
    assert!(stream.usage().is_none());
    assert!(matches!(stream.next_audio(), Err(Error::Closed)));
}

#[test]
fn wire_logger_drops_the_provider_close_reason_and_credential() {
    use plur1bus_voice_providers::http::Error;
    use plur1bus_wire_fixtures::frame;
    use std::sync::{Arc, Mutex};

    const KEY: &str = "synthetic-tts-logging-credential";
    const REASON: &str = "synthetic-tts-close-reason";
    struct Records(Arc<Mutex<Vec<String>>>);

    impl log::Log for Records {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool {
            true
        }

        fn log(&self, record: &log::Record<'_>) {
            self.0.lock().unwrap().push(record.args().to_string());
        }

        fn flush(&self) {}
    }

    let records = Arc::new(Mutex::new(Vec::new()));
    plur1bus_wire_log::install(Records(Arc::clone(&records))).unwrap();
    log::set_max_level(log::LevelFilter::Trace);
    log::debug!(target: "plur1bus_voice_providers", "synthetic logger control");

    let mut fixture = socket_fixture();
    let mut payload = 1008u16.to_be_bytes().to_vec();
    payload.extend_from_slice(REASON.as_bytes());
    fixture["exchanges"][0]["receive"] = json!([]);
    fixture["exchanges"][0]["rawFramesBase64"] =
        json!([STANDARD.encode(frame(0x8, &payload, None))]);
    let server = FakeServer::start(&fixture);
    let pin = Pin {
        addr: server.addr,
        expected_target: fixture["request"]["path"].as_str().unwrap().into(),
    };
    let base = Url::parse(&format!("http://{}", server.addr)).unwrap();
    let input = &fixture["input"];
    let settings = recorded_settings(input);
    let options = SynthesisOptions {
        voice_settings: Some(VoiceSettings(&settings)),
        ..options(input)
    };
    let mut stream = TtsSocket::connect(&base, KEY, &options, &pin, BUDGET, true).unwrap();
    for text in input["text"].as_array().unwrap() {
        stream.send_text(text.as_str().unwrap()).unwrap();
    }
    stream.finish_input().unwrap();
    assert_eq!(stream.next_audio().err(), Some(Error::Auth));
    assert!(stream.usage().is_none());

    let records = records.lock().unwrap();
    assert!(records
        .iter()
        .any(|line| line == "synthetic logger control"));
    assert!(!records
        .iter()
        .any(|line| line.contains(REASON) || line.contains(KEY)));
}

#[test]
fn callback_can_stop_http_playback_before_success() {
    use plur1bus_voice_providers::http::Error;

    let fixture = serde_json::from_str::<Value>(include_str!(
        "../../../fixtures/parity/voice/synthesis-http-stream.json"
    ))
    .unwrap();
    let server = FakeServer::start(&fixture);
    let pin = Pin {
        addr: server.addr,
        expected_target: fixture["exchanges"][0]["request"]["path"]
            .as_str()
            .unwrap()
            .into(),
    };
    let base = Url::parse(&format!("http://{}", server.addr)).unwrap();
    let base = base.join("/v1").unwrap();
    let client = Client::new(&pin).with_loopback_http();
    let input = &fixture["input"];
    let mut callbacks = 0;
    let outcome = stream_synthesis(
        &client,
        &base,
        CREDENTIAL,
        input["text"].as_str().unwrap(),
        &options(input),
        BUDGET,
        |_| {
            callbacks += 1;
            Err(Error::Aborted)
        },
    );
    assert!(matches!(outcome, Err(Error::Aborted)));
    assert_eq!(callbacks, 1);
}

#[test]
fn http_synthesis_deadline_applies_after_the_headers() {
    use plur1bus_voice_providers::http::{AudioFailure, Error};

    let mut fixture = serde_json::from_str::<Value>(include_str!(
        "../../../fixtures/parity/voice/synthesis-http-stream.json"
    ))
    .unwrap();
    fixture["exchanges"][0]["response"]["chunksBase64"] = json!(["AQI=", "AwQ="]);
    fixture["exchanges"][0]["response"]["chunkGapMs"] = json!(700);
    let server = FakeServer::start(&fixture);
    let pin = Pin {
        addr: server.addr,
        expected_target: fixture["exchanges"][0]["request"]["path"]
            .as_str()
            .unwrap()
            .into(),
    };
    let base = Url::parse(&format!("http://{}/v1", server.addr)).unwrap();
    let client = Client::new(&pin).with_loopback_http();
    let input = &fixture["input"];
    let error = stream_synthesis(
        &client,
        &base,
        CREDENTIAL,
        input["text"].as_str().unwrap(),
        &options(input),
        Duration::from_millis(350),
        |_| Ok(()),
    )
    .err()
    .unwrap();
    assert_eq!(error, Error::AfterAudio(AudioFailure::Timeout));
    assert!(!error.retryable());
    assert_eq!(server.received().len(), 1);
}

#[test]
fn audio_already_delivered_makes_a_timeout_non_retryable() {
    use plur1bus_voice_providers::http::Error;

    let fixture = serde_json::from_str::<Value>(include_str!(
        "../../../fixtures/parity/voice/synthesis-http-stream.json"
    ))
    .unwrap();
    let server = FakeServer::start(&fixture);
    let pin = Pin {
        addr: server.addr,
        expected_target: fixture["exchanges"][0]["request"]["path"]
            .as_str()
            .unwrap()
            .into(),
    };
    let base = Url::parse(&format!("http://{}/v1", server.addr)).unwrap();
    let client = Client::new(&pin).with_loopback_http();
    let mut delivered = 0;
    let outcome = stream_synthesis(
        &client,
        &base,
        CREDENTIAL,
        "fixture",
        &options(&fixture["input"]),
        BUDGET,
        |audio| {
            delivered += audio.bytes.len();
            Err(Error::Timeout)
        },
    );
    let error = outcome.err().unwrap();
    assert!(delivered > 0);
    assert_eq!(error.code(), "timeout");
    assert!(!error.retryable());
    assert_eq!(server.received().len(), 1);
}

#[test]
fn websocket_upgrade_refusal_preserves_status_class_and_retry_hint() {
    use plur1bus_voice_providers::http::Error;

    let fixture = socket_fixture();
    let input = &fixture["input"];
    let target = fixture["request"]["path"].as_str().unwrap();
    for (status, hint, expected) in [
        (401, "3", Error::Auth),
        (429, "1.5", Error::RateLimitedAfter(1500)),
    ] {
        use std::{
            io::{BufRead, BufReader, Write},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut read = BufReader::new(&stream);
            loop {
                let mut line = String::new();
                let bytes = read.read_line(&mut line).unwrap();
                if bytes == 0 || line == "\r\n" {
                    break;
                }
            }
            write!(stream, "HTTP/1.1 {status} Refused\r\nRetry-After: {hint}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let pin = Pin {
            addr,
            expected_target: target.into(),
        };
        let base = Url::parse(&format!("http://{addr}")).unwrap();
        let result = TtsSocket::connect(&base, CREDENTIAL, &options(input), &pin, BUDGET, true);
        worker.join().unwrap();
        let error = result.err().unwrap();
        assert_eq!(error, expected);
    }
}

fn announced_tts(limit: usize, incoming: Value) -> Value {
    let mut fixture = socket_fixture();
    let exchange = &mut fixture["exchanges"][0];
    for field in ["send", "sendText"] {
        if let Some(frames) = exchange[field].as_array_mut() {
            frames.truncate(limit);
        }
    }
    exchange["receive"] = incoming;
    fixture
}

#[test]
fn tts_checks_text_size_and_input_completion_before_final_audio() {
    use plur1bus_voice_providers::http::Error;

    let fixture = announced_tts(1, json!([{"isFinal":true}]));
    let server = FakeServer::start(&fixture);
    let pin = Pin {
        addr: server.addr,
        expected_target: fixture["request"]["path"].as_str().unwrap().into(),
    };
    let base = Url::parse(&format!("http://{}", server.addr)).unwrap();
    let input = &fixture["input"];
    let settings = recorded_settings(input);
    let options = SynthesisOptions {
        voice_settings: Some(VoiceSettings(&settings)),
        ..options(input)
    };
    let mut socket = TtsSocket::connect(&base, CREDENTIAL, &options, &pin, BUDGET, true).unwrap();
    assert_eq!(
        socket.send_text(&"t".repeat(1024 * 1024 + 1)),
        Err(Error::InvalidRequest)
    );
    assert_eq!(socket.next_audio().err(), Some(Error::UpstreamProtocol));
    assert!(socket.usage().is_none());
}

#[test]
fn tts_stops_at_the_combined_audio_limit() {
    use plur1bus_voice_providers::http::{Error, StreamLimits};

    let fixture = announced_tts(1, json!([{"audio":"AQI="}, {"audio":"AwQ="}]));
    let server = FakeServer::start(&fixture);
    let pin = Pin {
        addr: server.addr,
        expected_target: fixture["request"]["path"].as_str().unwrap().into(),
    };
    let base = Url::parse(&format!("http://{}", server.addr)).unwrap();
    let input = &fixture["input"];
    let settings = recorded_settings(input);
    let options = SynthesisOptions {
        voice_settings: Some(VoiceSettings(&settings)),
        ..options(input)
    };
    let limits = StreamLimits {
        max_audio_bytes: 3,
        max_duration: Duration::from_secs(2),
    };
    let mut socket =
        TtsSocket::connect_with_limits(&base, CREDENTIAL, &options, &pin, BUDGET, true, limits)
            .unwrap();
    assert_eq!(socket.next_audio().unwrap().unwrap().bytes, [1, 2]);
    assert_eq!(socket.next_audio().err(), Some(Error::StreamLimit));
    assert!(socket.usage().is_none());
}

#[test]
fn http_synthesis_applies_the_audio_limit_provided_by_the_host() {
    use plur1bus_voice_providers::http::{Error, StreamLimits};

    struct LimitedPin(Pin);
    impl Ports for LimitedPin {
        fn wall_time(&self) -> std::time::SystemTime {
            std::time::UNIX_EPOCH
        }

        fn pin(&self, endpoint: &Url, deadline: Instant) -> Option<SocketAddr> {
            Ports::pin(&self.0, endpoint, deadline)
        }
        fn stream_limits(&self) -> StreamLimits {
            StreamLimits {
                max_audio_bytes: 3,
                max_duration: Duration::from_secs(2),
            }
        }
    }

    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/voice/synthesis-http-stream.json"
    ))
    .unwrap();
    let server = FakeServer::start(&fixture);
    let pin = LimitedPin(Pin {
        addr: server.addr,
        expected_target: fixture["exchanges"][0]["request"]["path"]
            .as_str()
            .unwrap()
            .into(),
    });
    let base = Url::parse(&format!("http://{}/v1", server.addr)).unwrap();
    let client = Client::new(&pin).with_loopback_http();
    let input = &fixture["input"];
    let mut delivered = 0;
    let result = stream_synthesis(
        &client,
        &base,
        CREDENTIAL,
        "fixture",
        &options(input),
        BUDGET,
        |audio| {
            delivered += audio.bytes.len();
            Ok(())
        },
    );
    assert_eq!(result.err(), Some(Error::StreamLimit));
    assert!(delivered <= 3);
}

#[test]
fn an_active_audio_stream_reports_timeout_after_delivering_chunks() {
    let mut fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/voice/synthesis-http-stream.json"
    ))
    .unwrap();
    let response = &mut fixture["exchanges"][0]["response"];
    response["chunksBase64"] = json!(vec![STANDARD.encode([1, 0].repeat(256)); 500]);
    response["chunkGapMs"] = json!(4);
    let server = FakeServer::start(&fixture);
    let pin = Pin {
        addr: server.addr,
        expected_target: fixture["exchanges"][0]["request"]["path"]
            .as_str()
            .unwrap()
            .into(),
    };
    let base = Url::parse(&format!("http://{}/v1", server.addr)).unwrap();
    let client = Client::new(&pin).with_loopback_http();
    let input = &fixture["input"];
    let mut chunks = 0;
    let result = stream_synthesis(
        &client,
        &base,
        CREDENTIAL,
        input["text"].as_str().unwrap(),
        &options(input),
        Duration::from_millis(750),
        |_| {
            chunks += 1;
            Ok(())
        },
    );
    let error = result.err().unwrap();
    assert!(chunks > 1);
    assert_eq!(error.code(), "timeout");
    assert!(!error.retryable());
    assert_eq!(server.received().len(), 1);
}
