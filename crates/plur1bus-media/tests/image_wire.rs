#![allow(clippy::unwrap_used, reason = "synthetic media adapter fixtures")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_media::{
    adapters::{
        ImageAdapter, ImageRequest, Observer, Run, VideoAdapter, VideoProfile, VideoRequest,
    },
    http::{Auth, Cleartext, Client, Options, Ports},
    jobs::{Checkpoint, Progress, Result},
};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    net::SocketAddr,
    time::{Duration, Instant},
};
use url::Url;

struct Loopback(SocketAddr, RefCell<Vec<u64>>);

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
    fn wait(&self, delay: Duration, _: Instant) -> Result<()> {
        self.1.borrow_mut().push(delay.as_millis() as u64);
        Ok(())
    }
}

#[derive(Default)]
struct Events {
    boundary: Option<String>,
    progress: Vec<Progress>,
    checkpoints: Vec<Checkpoint>,
}

impl Observer for Events {
    fn multipart_boundary(&mut self) -> Result<String> {
        Ok(self.boundary.clone().unwrap())
    }
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
fn openai_edit_preserves_the_typescript_multipart_after_boundary_substitution() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/media/image-multipart.json"
    ))
    .unwrap();
    let input = &fixture["input"];
    let server = FakeServer::start(&fixture);
    let host = Loopback(server.addr, RefCell::default());
    let http = Client::new(
        &host,
        &format!("http://{}", server.addr),
        Options {
            cleartext: Some(Cleartext::Loopback),
            ..Options::default()
        },
    )
    .unwrap();
    let adapter = ImageAdapter::new(
        "openai".parse().unwrap(),
        input["model"].as_str().unwrap(),
        http,
        Duration::from_millis(1),
    )
    .unwrap();
    let source = STANDARD.decode(input["image"].as_str().unwrap()).unwrap();
    let result = adapter
        .edit(
            &ImageRequest {
                parameters: &input["parameters"],
                references: &[&source],
                mask: Some(&source),
            },
            &mut Events {
                boundary: Some(input["boundary"].as_str().unwrap().into()),
                ..Events::default()
            },
            Run {
                deadline: Instant::now() + Duration::from_secs(5),
                resume: None,
            },
        )
        .unwrap();
    assert_eq!(
        STANDARD.encode(&result.files[0].bytes),
        fixture["expected"]["bytes"]
    );
    let observed = server.received();
    let request = &fixture["exchanges"][0]["request"];
    assert_eq!(observed.len(), 1);
    for field in ["method", "path", "bodyBase64"] {
        assert_eq!(observed[0][field], request[field], "{field}");
    }
    assert_eq!(
        observed[0]["headers"]["content-type"],
        request["headers"]["content-type"]
    );
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
        let host = Loopback(server.addr, RefCell::default());
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

#[test]
fn all_video_provider_requests_are_byte_identical_and_stream_the_recorded_media() {
    let sources = [
        include_str!("../../../fixtures/parity/media/video-wire-google.json"),
        include_str!("../../../fixtures/parity/media/video-wire-openrouter.json"),
        include_str!("../../../fixtures/parity/media/video-wire-xai.json"),
        include_str!("../../../fixtures/parity/media/video-wire-replicate.json"),
        include_str!("../../../fixtures/parity/media/video-wire-fal.json"),
    ];
    for source in sources {
        let fixture: Value = serde_json::from_str(source).unwrap();
        let input = &fixture["input"];
        let expected = &fixture["expected"];
        let id = input["id"].as_str().unwrap();
        let model = input["model"].as_str().unwrap();
        let profile: VideoProfile = serde_json::from_value(input["capabilities"].clone()).unwrap();
        let server = FakeServer::start_with(|address| {
            serde_json::from_str(&source.replace("<fixture-origin>", &format!("http://{address}")))
                .unwrap()
        });
        let host = Loopback(server.addr, RefCell::default());
        let client = Client::new(
            &host,
            &format!("http://{}", server.addr),
            Options {
                cleartext: Some(Cleartext::Loopback),
                ..Options::default()
            },
        )
        .unwrap();
        let adapter = VideoAdapter::new(
            id.parse().unwrap(),
            model,
            client,
            Duration::from_millis(7),
            profile,
        )
        .unwrap();
        let mut events = Events::default();
        let output = adapter
            .generate(
                &VideoRequest {
                    parameters: &input["request"],
                    reference_image: None,
                    reference_video: None,
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
        assert_eq!(json!(events.checkpoints), expected["checkpoints"], "{id}");
        assert_eq!(json!(&*host.1.borrow()), expected["waits"], "{id}");
        let progress = expected["progress"].as_array().unwrap();
        assert_eq!(events.progress.len(), progress.len(), "{id}");
        for (actual, expected) in events.progress.iter().zip(progress) {
            assert_eq!(Some(actual.fraction), expected["fraction"].as_f64(), "{id}");
            assert_eq!(json!(actual.stage), expected["stage"], "{id}");
        }
        let calls_before_body = server.received().len();
        let source = output.download.open().unwrap().read_bytes().unwrap();
        assert_eq!(STANDARD.encode(source), expected["bytes"], "{id}");
        assert_eq!(calls_before_body + 1, server.received().len(), "{id}");
        host.1.borrow_mut().clear();
        let mut resumed = Events::default();
        let output = adapter
            .generate(
                &VideoRequest {
                    parameters: &input["request"],
                    reference_image: None,
                    reference_video: None,
                },
                &mut resumed,
                Run {
                    deadline: Instant::now() + Duration::from_secs(5),
                    resume: Some(&events.checkpoints[0]),
                },
            )
            .unwrap();
        let source = output.download.open().unwrap().read_bytes().unwrap();
        let resume = &expected["resume"];
        assert_eq!(STANDARD.encode(source), resume["bytes"], "{id}");
        assert!(resumed.checkpoints.is_empty(), "{id}");
        assert_eq!(json!(&*host.1.borrow()), resume["waits"], "{id}");
        let progress = resume["progress"].as_array().unwrap();
        assert_eq!(resumed.progress.len(), progress.len(), "{id}");
        for (actual, expected) in resumed.progress.iter().zip(progress) {
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
