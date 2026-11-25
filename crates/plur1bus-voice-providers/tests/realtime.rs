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

const CREDENTIAL: &str = "synthetic-voice-credential";

fn assert_upgrade(server: &FakeServer, request: &serde_json::Value) {
    let upgrades = server.websocket_upgrades();
    assert_eq!(upgrades.len(), 1);
    assert_eq!(upgrades[0]["method"], "GET");
    assert_eq!(upgrades[0]["path"], request["path"]);
    for (header, expected) in request["headers"].as_object().unwrap() {
        assert_eq!(
            upgrades[0]["headers"][header],
            expected
                .as_str()
                .unwrap()
                .replace("<credential>", CREDENTIAL)
        );
    }
}

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
        plur1bus_providers::connect_pinned_tcp(address, deadline, &|| self.cancelled())
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
        assert_upgrade(&socket, &case["socket"]["request"]);
        assert_eq!(
            json!(socket.received()),
            case["socket"]["exchanges"][0]["send"]
        );
        session.close().unwrap();
    }
}

#[test]
fn interruption_and_remote_close_match_the_recorded_provider_events() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use plur1bus_wire_fixtures::frame;
    use serde_json::Value;

    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../fixtures/parity/voice/realtime-control.json"
    ))
    .unwrap();
    let budget = Duration::from_secs(5);
    for mut case in cases {
        let code = case["closeCode"].as_u64().unwrap() as u16;
        case["exchanges"][1]["rawFramesBase64"] =
            json!([STANDARD.encode(frame(0x8, &code.to_be_bytes(), None))]);
        let server = FakeServer::start(&case);
        let ports = Loopback(server.addr, None);
        let addr = Url::parse(&format!("http://{}", server.addr)).unwrap();
        let input = &case["input"];
        let vendor = if input["vendor"] == "grok" {
            Vendor::Grok
        } else {
            Vendor::Gemini
        };
        let options = Options {
            vendor,
            model: input["model"].as_str().unwrap(),
            voice: None,
            instructions: None,
            tools: &[],
            input_rate: input["inputSampleRate"].as_u64().unwrap() as u32,
        };
        let mut session =
            Session::connect(&addr, CREDENTIAL, &options, &ports, budget, true).unwrap();
        assert_eq!(session.receive(budget).unwrap(), [Event::Ready]);
        session.interrupt().unwrap();
        if matches!(vendor, Vendor::Gemini) {
            let pcm: Vec<u8> = serde_json::from_value(input["pcm"].clone()).unwrap();
            session.send_audio(&pcm).unwrap();
        }
        let mut observed = vec![json!({"type":"ready"})];
        let mut closed = false;
        while !closed {
            for event in session.receive(budget).unwrap() {
                observed.push(match event {
                    Event::Interrupted => json!({"type":"interrupted"}),
                    Event::Audio { bytes, sample_rate } => {
                        json!({"type":"audio","bytes":bytes,"sampleRate":sample_rate})
                    }
                    Event::Closed { code } => {
                        closed = true;
                        let reason = match code {
                            Some(1000) => "normal".to_owned(),
                            code => code.unwrap_or(1005).to_string(),
                        };
                        json!({"type":"closed","reason":reason})
                    }
                    Event::Error(error) => json!({"type":"error","code":error.code()}),
                    event => json!({"unexpected":format!("{event:?}")}),
                });
            }
        }
        assert_eq!(json!(observed), case["expected"]);
        assert_upgrade(&server, &case["request"]);
        assert!(matches!(
            session.interrupt(),
            Err(plur1bus_voice_providers::http::Error::Closed)
        ));
    }
}

#[test]
fn an_abort_during_a_blocked_read_resolves_by_the_deadline_and_releases_the_socket() {
    use plur1bus_voice_providers::http::Error;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Sender},
        Arc,
    };
    use std::thread;

    struct ObserveRead {
        tcp: TcpStream,
        entered: Sender<()>,
        armed: Arc<AtomicBool>,
        dropped: Arc<AtomicBool>,
    }

    impl io::Read for ObserveRead {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            if self.armed.swap(false, Ordering::SeqCst) {
                self.entered.send(()).unwrap();
            }
            self.tcp.read(bytes)
        }
    }

    impl io::Write for ObserveRead {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.tcp.write(bytes)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.tcp.flush()
        }
    }

    impl TimedStream for ObserveRead {
        fn peer_addr(&self) -> io::Result<SocketAddr> {
            self.tcp.peer_addr()
        }
        fn set_deadline(&mut self, deadline: Instant) -> io::Result<()> {
            self.tcp.set_deadline(deadline)
        }
    }

    impl Drop for ObserveRead {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    struct AbortPort {
        entered: Sender<()>,
        armed: Arc<AtomicBool>,
        cancelled: AtomicBool,
        dropped: Arc<AtomicBool>,
    }

    impl SocketPorts for AbortPort {
        fn cancelled(&self) -> bool {
            self.cancelled.load(Ordering::SeqCst)
        }
        fn pin(&self, endpoint: &Url, _: Instant) -> Option<SocketAddr> {
            Some(SocketAddr::from(([127, 0, 0, 1], endpoint.port()?)))
        }
        fn dial(
            &self,
            _: &Url,
            addr: SocketAddr,
            deadline: Instant,
        ) -> io::Result<Box<dyn TimedStream>> {
            let tcp = plur1bus_providers::connect_pinned_tcp(addr, deadline, &|| self.cancelled())?;
            Ok(Box::new(ObserveRead {
                tcp,
                entered: self.entered.clone(),
                armed: Arc::clone(&self.armed),
                dropped: Arc::clone(&self.dropped),
            }))
        }
    }

    let server = FakeServer::start(&json!({
        "transport": "websocket",
        "exchanges": [{ "send": [], "receive": [{ "message_type": "session_started" }] }],
    }));
    let (entered, read) = mpsc::channel();
    let ports = AbortPort {
        entered,
        armed: Arc::default(),
        cancelled: AtomicBool::default(),
        dropped: Arc::default(),
    };
    let base = Url::parse(&format!("http://{}", server.addr)).unwrap();
    let options = Options {
        vendor: Vendor::ElevenLabsAsr,
        model: "scribe_fixture",
        voice: None,
        instructions: None,
        tools: &[],
        input_rate: 16_000,
    };
    let setup_budget = Duration::from_secs(3);
    let mut session =
        Session::connect(&base, CREDENTIAL, &options, &ports, setup_budget, true).unwrap();
    assert_eq!(session.receive(setup_budget).unwrap(), [Event::Ready]);
    ports.armed.store(true, Ordering::SeqCst);
    thread::scope(|scope| {
        let cancelled = &ports.cancelled;
        scope.spawn(move || {
            read.recv_timeout(setup_budget).unwrap();
            cancelled.store(true, Ordering::SeqCst);
        });
        let start = Instant::now();
        assert_eq!(session.receive(setup_budget).unwrap_err(), Error::Aborted);
        assert!(
            start.elapsed() < Duration::from_millis(500),
            "a silent WebSocket held the session for {:?} after read started",
            start.elapsed()
        );
    });
    assert!(ports.dropped.load(Ordering::SeqCst));
    assert_eq!(session.receive(setup_budget).unwrap_err(), Error::Closed);
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
        assert_upgrade(&server, &fixture["request"]);
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
            description: input["description"].as_str(),
            parameters: None,
        }];
        let options = Options {
            vendor,
            model,
            voice: input["voice"].as_str(),
            instructions: input["instructions"].as_str(),
            tools: &tools,
            input_rate: input["sampleRate"].as_u64().unwrap() as u32,
        };
        let asr = matches!(vendor, Vendor::ElevenLabsAsr);
        let settings = Settings {
            language: input["language"].as_str(),
            timestamps: asr,
            zero_retention: asr,
            usage_session_id: Some("<session>"),
            stream_limits: Default::default(),
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
        assert_upgrade(&server, &fixture["request"]);
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
