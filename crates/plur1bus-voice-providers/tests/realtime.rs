#![allow(clippy::unwrap_used, reason = "loopback fixture assertions")]

use plur1bus_channels::websocket::{SocketPorts, TimedStream};
use plur1bus_voice_providers::realtime::{Event, Options, Session, Vendor};
use plur1bus_wire_fixtures::{load_fixture, FakeServer};
use serde_json::json;
use std::{
    io,
    net::{SocketAddr, TcpStream},
    time::{Duration, Instant},
};
use url::Url;

struct Loopback(SocketAddr, Option<String>);

impl SocketPorts for Loopback {
    fn pin(&self, endpoint: &Url, _: Instant) -> Option<SocketAddr> {
        if let Some(target) = &self.1 {
            assert_eq!(target, &endpoint[url::Position::BeforePath..]);
        }
        Some(self.0)
    }

    fn dial(
        &self,
        _: &Url,
        address: SocketAddr,
        deadline: Instant,
    ) -> io::Result<Box<dyn TimedStream>> {
        TcpStream::connect_timeout(&address, deadline.saturating_duration_since(Instant::now()))
            .map(|socket| Box::new(socket) as Box<dyn TimedStream>)
    }
}

impl plur1bus_voice_providers::http::Ports for Loopback {
    fn pin(&self, endpoint: &Url, deadline: Instant) -> Option<SocketAddr> {
        SocketPorts::pin(self, endpoint, deadline)
    }
}

#[test]
fn discovery_selection_matches_the_typescript_websocket_handshake_and_setup() {
    use plur1bus_voice_providers::{catalog, http::Client};
    use serde_json::Value;

    const KEY: &str = "synthetic-voice-credential";
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../fixtures/parity/voice/model-selection.json"
    ))
    .unwrap();
    let budget = Duration::from_secs(5);
    for case in cases {
        let (catalog_vendor, vendor) = if case["vendor"] == "xai" {
            (catalog::Vendor::Xai, Vendor::Grok)
        } else {
            (catalog::Vendor::Gemini, Vendor::Gemini)
        };
        let http = FakeServer::start(&case["http"]);
        let ports = Loopback(http.addr, None);
        let base = Url::parse(&format!("http://{}", http.addr)).unwrap();
        let client = Client::new(&ports).with_loopback_http();
        let catalog = catalog::Catalog::new(client, base, catalog_vendor).unwrap();
        let model = catalog
            .realtime_model(KEY, case["override"].as_str(), budget)
            .unwrap();
        assert_eq!(model, case["expected"]);
        let requests = http.received();
        let exchanges = case["http"]["exchanges"].as_array().unwrap();
        assert_eq!(requests.len(), exchanges.len());
        for (request, exchange) in requests.iter().zip(exchanges) {
            assert_eq!(request["path"], exchange["request"]["path"]);
            for (header, value) in exchange["request"]["headers"].as_object().unwrap() {
                assert_eq!(
                    request["headers"][header],
                    value.as_str().unwrap().replace("<credential>", KEY)
                );
            }
        }

        let socket = FakeServer::start(&case["socket"]);
        let target = case["socket"]["request"]["path"].as_str().unwrap();
        let ports = Loopback(socket.addr, Some(target.into()));
        let base = Url::parse(&format!("http://{}", socket.addr)).unwrap();
        let options = Options {
            vendor,
            model: &model,
            voice: None,
            instructions: None,
            tools: &[],
            input_rate: 16_000,
        };
        let mut session = Session::connect(&base, KEY, &options, &ports, budget, true).unwrap();
        assert_eq!(session.receive(budget).unwrap(), [Event::Ready]);
        assert_eq!(
            json!(socket.received()),
            case["socket"]["exchanges"][0]["send"]
        );
        session.close().unwrap();
    }
}

#[test]
fn recorded_ready_and_audio_turns_replay_through_the_blocking_socket() {
    for (name, vendor) in [
        ("grok-realtime", Vendor::Grok),
        ("gemini-realtime", Vendor::Gemini),
        ("eleven-asr-realtime", Vendor::ElevenLabsAsr),
    ] {
        let fixture = load_fixture("voice", name);
        let server = FakeServer::start(&fixture);
        let ports = Loopback(server.addr, None);
        let base = Url::parse(&format!("http://{}", server.addr)).unwrap();
        let options = Options {
            vendor,
            model: fixture["input"]["model"].as_str().unwrap(),
            voice: None,
            instructions: None,
            tools: &[],
            input_rate: fixture["input"]["sampleRate"].as_u64().unwrap() as u32,
        };
        let budget = Duration::from_secs(5);
        let mut session = Session::connect(
            &base,
            "synthetic-voice-credential",
            &options,
            &ports,
            budget,
            true,
        )
        .unwrap();
        assert_eq!(session.receive(budget).unwrap(), [Event::Ready], "{name}");
        let pcm = serde_json::from_value::<Vec<u8>>(fixture["input"]["pcm"].clone()).unwrap();
        session.send_audio(&pcm).unwrap();
        let events = session.receive(budget).unwrap();
        let encoded: Vec<_> = events
            .into_iter()
            .map(|event| match event {
                Event::Audio { bytes, sample_rate } => {
                    json!({"type":"audio","bytes":bytes,"sampleRate":sample_rate})
                }
                Event::Transcript { text, final_, .. } if final_ => {
                    json!({"type":"final","text":text})
                }
                other => json!({"unexpected":format!("{other:?}")}),
            })
            .collect();
        assert_eq!(encoded, [fixture["expected"][1].clone()], "{name}");
        let sent: Vec<_> = fixture["exchanges"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|exchange| exchange["send"].as_array().unwrap().iter().cloned())
            .collect();
        assert_eq!(server.received(), sent, "{name}");
        session.close().unwrap();
    }
}

#[test]
fn model_dialogues_match_recorded_transcripts_tools_usage_and_asr_timestamps() {
    use plur1bus_voice_providers::realtime::Settings;
    use serde_json::Value;

    for (recording, vendor, first_part, reply_part) in [
        (
            include_str!("../../../fixtures/parity/voice/grok-dialogue.json"),
            Vendor::Grok,
            5,
            2,
        ),
        (
            include_str!("../../../fixtures/parity/voice/gemini-dialogue.json"),
            Vendor::Gemini,
            5,
            4,
        ),
        (
            include_str!("../../../fixtures/parity/voice/eleven-asr-dialogue.json"),
            Vendor::ElevenLabsAsr,
            3,
            0,
        ),
    ] {
        let fixture: Value = serde_json::from_str(recording).unwrap();
        let input = &fixture["input"];
        let server = FakeServer::start(&fixture);
        let base = Url::parse(&format!("http://{}", server.addr)).unwrap();
        let ports = Loopback(
            server.addr,
            fixture["request"]["path"].as_str().map(str::to_owned),
        );
        let model = input["model"].as_str().unwrap();
        let tool_name = input["tool"].as_str().unwrap();
        let tools = [plur1bus_voice_providers::realtime::Tool {
            name: tool_name,
            description: None,
            parameters: None,
        }];
        let options = Options {
            vendor,
            model,
            voice: None,
            instructions: None,
            tools: &tools,
            input_rate: input["sampleRate"].as_u64().unwrap() as u32,
        };
        let asr = matches!(vendor, Vendor::ElevenLabsAsr);
        let settings = Settings {
            language: input["language"].as_str(),
            timestamps: asr,
            zero_retention: asr,
            usage_session_id: Some("<session>"),
        };
        let budget = Duration::from_secs(5);
        let mut session = Session::connect_with_settings(
            &base,
            "synthetic-voice-credential",
            &options,
            settings,
            &ports,
            budget,
            true,
        )
        .unwrap();
        let mut observed = Vec::new();
        let encode = |event| match event {
            Event::Ready => json!({"type":"ready"}),
            Event::Transcript {
                text,
                final_,
                language,
                words,
                ..
            } if asr => {
                let mut out =
                    json!({"type": if final_ { "final" } else { "partial" }, "text":text});
                if let Some(language) = language {
                    out["language"] = json!(language);
                }
                if let Some(words) = words {
                    out["words"] = json!(words.into_iter().map(|word| json!({
                        "text":word.text,"startMs":word.start_ms as i64,"endMs":word.end_ms as i64
                    })).collect::<Vec<_>>());
                }
                out
            }
            Event::Transcript {
                role, text, final_, ..
            } => json!({"type":"transcript","role":role,"text":text,"final":final_}),
            Event::ToolCall {
                id,
                name,
                arguments,
            } => json!({"type":"tool.call","callId":id,"name":name,"arguments":arguments}),
            Event::TurnDone => json!({"type":"turn.done"}),
            Event::Usage {
                input_tokens,
                output_tokens,
                event_id,
            } => {
                let report = json!({"provider":vendor.id(),"operation":"realtime","model":model,
                    "eventId":event_id,"inputTokens":input_tokens,"outputTokens":output_tokens});
                json!({"type":"usage","report":report})
            }
            other => json!({"unexpected":format!("{other:?}")}),
        };
        if asr {
            let pcm: Vec<u8> = serde_json::from_value(input["pcm"].clone()).unwrap();
            session.send_audio(&pcm).unwrap();
            session.commit().unwrap();
        } else {
            session.send_text(input["text"].as_str().unwrap()).unwrap();
        }
        observed.extend(session.receive(budget).unwrap().into_iter().map(encode));
        let mut take = |session: &mut Session, target| {
            while observed.len() < target {
                observed.extend(session.receive(budget).unwrap().into_iter().map(encode));
            }
        };
        take(&mut session, first_part);
        if !asr {
            session
                .submit_tool_result(
                    input["callId"].as_str().unwrap(),
                    tool_name,
                    &input["result"],
                )
                .unwrap();
            take(&mut session, first_part + reply_part);
        }
        assert_eq!(json!(observed), fixture["expected"], "{}", input["vendor"]);
        let sent: Vec<_> = fixture["exchanges"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|exchange| exchange["send"].as_array().unwrap().iter().cloned())
            .collect();
        assert_eq!(server.received(), sent);
        session.close().unwrap();
    }
}
