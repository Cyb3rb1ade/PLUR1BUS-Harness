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

struct Loopback(SocketAddr);

impl SocketPorts for Loopback {
    fn pin(&self, _: &Url, _: Instant) -> Option<SocketAddr> {
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

#[test]
fn recorded_ready_and_audio_turns_replay_through_the_blocking_socket() {
    for (name, vendor) in [
        ("grok-realtime", Vendor::Grok),
        ("gemini-realtime", Vendor::Gemini),
        ("eleven-asr-realtime", Vendor::ElevenLabsAsr),
    ] {
        let fixture = load_fixture("voice", name);
        let server = FakeServer::start(&fixture);
        let ports = Loopback(server.addr);
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
