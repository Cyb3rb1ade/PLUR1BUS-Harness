#![allow(clippy::unwrap_used, clippy::panic, reason = "wire fixture assertions")]

use plur1bus_voice_providers::{
    catalog::{Catalog, Vendor},
    http::{Client, Error, Ports},
};
use plur1bus_wire_fixtures::{load_fixture, FakeServer};
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};
use url::Url;

const CREDENTIAL: &str = "synthetic-voice-credential";

struct Pin(SocketAddr);

impl Ports for Pin {
    fn pin(&self, _: &Url, _: Instant) -> Option<SocketAddr> {
        Some(self.0)
    }
}

#[test]
fn provider_catalogs_match_recorded_typescript_requests_and_results() {
    let fixture = load_fixture("voice", "catalog");
    for scenario in fixture["scenarios"].as_array().unwrap() {
        let server =
            FakeServer::start(&json!({"transport":"http","exchanges":scenario["exchanges"]}));
        let pin = Pin(server.addr);
        let client = Client::new(&pin).with_loopback_http();
        let base = Url::parse(&format!("http://{}/v1", server.addr)).unwrap();
        let operation = scenario["operation"].as_str().unwrap();
        let vendor = match operation {
            "eleven-voices" | "eleven-models" | "eleven-asr-models" => Vendor::ElevenLabs,
            "gemini-models" => Vendor::Gemini,
            "xai-models" => Vendor::Xai,
            _ => panic!("unrecognized voice fixture"),
        };
        let catalog = Catalog::new(client, base, vendor).unwrap();
        let budget = Duration::from_secs(5);
        let result = if operation == "eleven-voices" {
            catalog.list_elevenlabs_voices(CREDENTIAL, budget)
        } else if operation == "eleven-asr-models" {
            catalog.list_elevenlabs_asr_models(CREDENTIAL, None, budget)
        } else {
            catalog.list_models(CREDENTIAL, budget)
        };
        let expected = match result {
            Ok(result) => json!({"result":result}),
            Err(error) => {
                assert!(!format!("{error:?} {error}").contains(CREDENTIAL));
                json!({"code":error.code(),"retryable":error.retryable()})
            }
        };
        assert_eq!(expected, scenario["expected"], "{operation}");

        let received = server.received();
        let recorded = scenario["exchanges"].as_array().unwrap();
        assert_eq!(received.len(), recorded.len(), "{operation}");
        for (actual, record) in received.iter().zip(recorded) {
            let request = &record["request"];
            assert_eq!(actual["method"], request["method"]);
            assert_eq!(actual["path"], request["path"]);
            for (key, value) in request["headers"].as_object().unwrap() {
                let expected = value.as_str().unwrap().replace("<credential>", CREDENTIAL);
                assert_eq!(actual["headers"][key], expected);
            }
        }
    }
}

#[test]
fn response_deadline_covers_the_body_after_headers() {
    let server = FakeServer::start(&json!({
        "transport":"http",
        "exchanges":[{"request":{"method":"GET","path":"/catalog"},
            "response":{"status":200,"chunksBase64":["ew==","fQ=="],"chunkGapMs":700}}]
    }));
    let pin = Pin(server.addr);
    let client = Client::new(&pin).with_loopback_http();
    let url = Url::parse(&format!("http://{}/catalog", server.addr)).unwrap();
    assert_eq!(
        client.json(&url, "GET", &[], b"", Duration::from_millis(350)),
        Err(Error::Timeout)
    );
    assert_eq!(server.received().len(), 1);
}

#[test]
fn buffered_synthesis_matches_the_typescript_request_and_audio() {
    use plur1bus_voice_providers::elevenlabs::{
        synthesize, AudioFormat, SynthesisOptions, VoiceSettings,
    };
    let fixture = load_fixture("voice", "synthesis");
    let server = FakeServer::start(&fixture);
    let pin = Pin(server.addr);
    let client = Client::new(&pin).with_loopback_http();
    let base = Url::parse(&format!("http://{}/v1", server.addr)).unwrap();
    let input = &fixture["input"];
    let settings: Vec<(String, Value)> =
        serde_json::from_value(input["voiceSettingsEntries"].clone()).unwrap();
    let audio = synthesize(
        &client,
        &base,
        CREDENTIAL,
        input["text"].as_str().unwrap(),
        &SynthesisOptions {
            voice: input["voice"].as_str().unwrap(),
            language: input["language"].as_str(),
            zero_retention: true,
            voice_settings: Some(VoiceSettings(&settings)),
            ..SynthesisOptions::default()
        },
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(audio.format, AudioFormat::Pcm16);
    assert_eq!(
        audio.sample_rate,
        fixture["expected"]["sampleRate"].as_u64().unwrap() as u32
    );
    assert_eq!(audio.bytes, [0, 1, 2, 255]);
    assert_eq!(
        audio.input_utf16_units,
        fixture["expected"]["usage"]["chars"].as_u64().unwrap() as usize
    );
    assert_eq!(audio.model, fixture["expected"]["usage"]["model"]);
    let received = server.received();
    let request = &fixture["exchanges"][0]["request"];
    assert_eq!(received[0]["method"], request["method"]);
    assert_eq!(received[0]["path"], request["path"]);
    assert_eq!(received[0]["body"], request["bodyText"]);
    assert_eq!(received[0]["headers"]["xi-api-key"], CREDENTIAL);
}

#[test]
fn transcription_uses_the_recorded_multipart_bytes_and_word_timing() {
    use plur1bus_voice_providers::elevenlabs::{transcribe, Pcm16, TranscriptionOptions};
    let fixture = load_fixture("voice", "transcription");
    let server = FakeServer::start(&fixture);
    let pin = Pin(server.addr);
    let client = Client::new(&pin).with_loopback_http();
    let base = Url::parse(&format!("http://{}", server.addr)).unwrap();
    let input = &fixture["input"];
    let bytes = serde_json::from_value::<Vec<u8>>(input["pcm"].clone()).unwrap();
    let transcript = transcribe(
        &client,
        &base,
        CREDENTIAL,
        Pcm16 {
            bytes: &bytes,
            sample_rate: input["sampleRate"].as_u64().unwrap() as u32,
        },
        &TranscriptionOptions {
            language: Some("en"),
            timestamps: true,
            zero_retention: true,
            ..Default::default()
        },
        input["fixtureBoundary"].as_str().unwrap(),
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(transcript.text, fixture["expected"]["text"]);
    assert_eq!(transcript.language.as_deref(), Some("en"));
    assert_eq!(transcript.model, fixture["expected"]["usage"]["model"]);
    assert_eq!(
        transcript.audio_seconds,
        fixture["expected"]["usage"]["seconds"]
    );
    let words = transcript.words.unwrap();
    assert_eq!(words.len(), 1);
    assert_eq!(words[0].text, fixture["expected"]["words"][0]["text"]);
    assert_eq!(
        words[0].start_ms,
        fixture["expected"]["words"][0]["startMs"]
    );
    assert_eq!(words[0].end_ms, fixture["expected"]["words"][0]["endMs"]);
    let received = server.received();
    let request = &fixture["exchanges"][0]["request"];
    assert_eq!(received[0]["method"], request["method"]);
    assert_eq!(received[0]["path"], request["path"]);
    assert_eq!(received[0]["bodyBase64"], request["bodyBase64"]);
    assert_eq!(
        received[0]["headers"]["content-type"],
        request["headers"]["content-type"]
    );
}

#[test]
fn a_pin_for_another_port_is_refused_before_authorization_leaves_the_host() {
    let server = FakeServer::start(&json!({"transport":"http","exchanges":[]}));
    let pin = Pin(server.addr);
    let client = Client::new(&pin).with_loopback_http();
    let url = Url::parse("http://127.0.0.1:1/catalog").unwrap();
    assert_eq!(
        client.json(
            &url,
            "GET",
            &[("xi-api-key", CREDENTIAL)],
            b"",
            Duration::from_secs(1)
        ),
        Err(Error::InvalidRequest)
    );
    assert!(server.received().is_empty());
}

#[test]
fn a_non_json_body_never_exposes_any_provider_supplied_text() {
    let server = FakeServer::start(&json!({
        "transport":"http",
        "exchanges":[{"request":{"method":"GET","path":"/catalog"},
            "response":{"status":200,"chunksBase64":["c3ludGhldGljLXZvaWNlLWNyZWRlbnRpYWw="]}}]
    }));
    let pin = Pin(server.addr);
    let client = Client::new(&pin).with_loopback_http();
    let url = Url::parse(&format!("http://{}/catalog", server.addr)).unwrap();
    let error = client
        .json(&url, "GET", &[], b"", Duration::from_secs(5))
        .unwrap_err();
    assert_eq!(error, Error::BadResponse);
    assert!(!format!("{error:?} {error}").contains(CREDENTIAL));
}

#[test]
fn complete_json_at_the_published_ceiling_and_one_extra_byte() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::io::Write;

    const CEILING: usize = 1024 * 1024;
    for encoding in ["identity", "gzip"] {
        let input = format!("\"{}\"", "a".repeat(CEILING - 2));
        let chunk = |body: &[u8]| {
            let bytes = if encoding == "gzip" {
                let mut encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
                encoder.write_all(body).unwrap();
                encoder.finish().unwrap()
            } else {
                body.to_vec()
            };
            STANDARD.encode(bytes)
        };
        let over = format!("{input} ");
        let server = FakeServer::start(&json!({
            "transport": "http",
            "exchanges": [
                {"request": {"method": "GET", "path": "/at"},
                 "response": {"status": 200, "headers": {"content-encoding": encoding},
                              "chunksBase64": [chunk(input.as_bytes())]}},
                {"request": {"method": "GET", "path": "/over"},
                 "response": {"status": 200, "headers": {"content-encoding": encoding},
                              "chunksBase64": [chunk(over.as_bytes())]}},
            ]
        }));
        let pin = Pin(server.addr);
        let client = Client::new(&pin).with_loopback_http();
        let url = |path: &str| Url::parse(&format!("http://{}/{path}", server.addr)).unwrap();
        let budget = Duration::from_secs(5);
        let at = client.json(&url("at"), "GET", &[], b"", budget).unwrap();
        assert_eq!(at.as_str().map(str::len), Some(CEILING - 2), "{encoding}");
        assert_eq!(
            client.json(&url("over"), "GET", &[], b"", budget),
            Err(Error::BadResponse),
            "{encoding}",
        );
    }
}
