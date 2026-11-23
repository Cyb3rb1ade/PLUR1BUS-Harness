#![allow(clippy::unwrap_used, reason = "synthetic media adapter fixtures")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_media::{
    adapters::{ImageAdapter, ImageRequest, Observer, Run},
    http::{Auth, Cleartext, Client, Options, Ports},
    jobs::{Checkpoint, Progress, Result},
};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};
use url::Url;

struct Loopback(SocketAddr);

impl Ports for Loopback {
    fn pin(&self, url: &Url, _: Instant) -> Option<SocketAddr> {
        (url.port() == Some(self.0.port())).then_some(self.0)
    }
    fn credential(&self, _: Auth, _: Instant) -> Result<Option<String>> {
        Ok(None)
    }
    fn random(&self) -> f64 {
        0.25
    }
    fn wait(&self, _: Duration, _: Instant) -> Result<()> {
        Ok(())
    }
}

#[derive(Default)]
struct Events {
    progress: Vec<Progress>,
    checkpoints: Vec<Checkpoint>,
}

impl Observer for Events {
    fn progress(&mut self, progress: Progress) -> Result<()> {
        self.progress.push(progress);
        Ok(())
    }
    fn checkpoint(&mut self, checkpoint: Checkpoint) -> Result<()> {
        self.checkpoints.push(checkpoint);
        Ok(())
    }
}

#[test]
fn all_image_provider_requests_are_byte_identical_to_the_typescript_recordings() {
    let sources = [
        include_str!("../../../fixtures/parity/media/image-wire-openai.json"),
        include_str!("../../../fixtures/parity/media/image-wire-openrouter.json"),
        include_str!("../../../fixtures/parity/media/image-wire-google.json"),
        include_str!("../../../fixtures/parity/media/image-wire-xai.json"),
        include_str!("../../../fixtures/parity/media/image-wire-together.json"),
        include_str!("../../../fixtures/parity/media/image-wire-draw-things.json"),
        include_str!("../../../fixtures/parity/media/image-wire-replicate.json"),
        include_str!("../../../fixtures/parity/media/image-wire-fal.json"),
    ];
    for source in sources {
        let fixture: Value = serde_json::from_str(source).unwrap();
        let input = &fixture["input"];
        let expected = &fixture["expected"];
        let id = input["id"].as_str().unwrap();
        let model = input["model"].as_str().unwrap();
        let server = FakeServer::start(&fixture);
        let host = Loopback(server.addr);
        let client = Client::new(
            &host,
            &format!("http://{}", server.addr),
            Options {
                cleartext: Some(Cleartext::Loopback),
                ..Options::default()
            },
        )
        .unwrap();
        let adapter =
            ImageAdapter::new(id.parse().unwrap(), model, client, Duration::from_millis(1))
                .unwrap();
        let mut events = Events::default();
        let output = adapter
            .generate(
                &ImageRequest {
                    parameters: &input["request"],
                    references: &[],
                    mask: None,
                },
                &mut events,
                Run {
                    deadline: Instant::now() + Duration::from_secs(5),
                    resume: None,
                },
            )
            .unwrap();
        let mut metadata = output.metadata;
        metadata.as_object_mut().unwrap().remove("origin");
        metadata.as_object_mut().unwrap().remove("durationMs");
        assert_eq!(metadata, expected["metadata"], "{id}");
        assert_eq!(json!(output.partial), expected["partial"], "{id}");
        let files: Vec<_> = output
            .files
            .iter()
            .map(|file| {
                json!({
                    "format":file.format, "bytes":STANDARD.encode(&file.bytes),
                })
            })
            .collect();
        assert_eq!(json!(files), expected["files"], "{id}");
        assert_eq!(json!(events.checkpoints), expected["checkpoints"], "{id}");
        let progress = expected["progress"].as_array().unwrap();
        assert_eq!(events.progress.len(), progress.len(), "{id}");
        for (actual, expected) in events.progress.iter().zip(progress) {
            assert_eq!(Some(actual.fraction), expected["fraction"].as_f64(), "{id}");
            assert_eq!(json!(actual.stage), expected["stage"], "{id}");
        }
        let actual = server.received();
        let expected = fixture["exchanges"].as_array().unwrap();
        assert_eq!(actual.len(), expected.len(), "{id}");
        for (observed, recorded) in actual.iter().zip(expected) {
            let request = &recorded["request"];
            assert_eq!(observed["method"], request["method"], "{id}");
            assert_eq!(observed["path"], request["path"], "{id}");
            assert_eq!(observed["body"], request["bodyText"], "{id}");
            assert_eq!(
                observed["headers"]["content-type"], request["headers"]["content-type"],
                "{id}"
            );
        }
    }
}
