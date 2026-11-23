#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture checks")]

use std::{
    cell::RefCell,
    ffi::OsString,
    path::PathBuf,
    time::{Duration, Instant},
};

use plur1bus_media::video::{self, Codec, Error, ProcessPort, VideoPaths, VideoRequest};
use serde_json::{json, Value};

struct Fixture<'a> {
    case: &'a Value,
    calls: RefCell<Vec<Value>>,
    deadline: Instant,
    paths: [(PathBuf, &'a str); 3],
}

impl ProcessPort for Fixture<'_> {
    fn run(
        &self,
        codec: Codec,
        args: &[OsString],
        max_stdout: usize,
        deadline: Instant,
        _cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<u8>, Error> {
        assert_eq!(max_stdout, 1024 * 1024);
        assert_eq!(deadline, self.deadline);
        let args: Vec<_> = args
            .iter()
            .map(|arg| {
                self.paths
                    .iter()
                    .find(|(actual, _)| actual.as_os_str() == arg)
                    .map_or_else(
                        || arg.to_string_lossy().into_owned(),
                        |(_, wire)| (*wire).into(),
                    )
            })
            .collect();
        let mut calls = self.calls.borrow_mut();
        calls.push(json!({"program":codec.program(),"args":args}));
        if self.case["failStep"].as_u64() == Some(calls.len() as u64) {
            return Err(Error::InvalidResponse);
        }
        if codec == Codec::Ffprobe {
            return Ok(if let Some(len) = self.case["probeBytes"].as_u64() {
                vec![0; len as usize]
            } else {
                serde_json::to_vec(&self.case["probe"]).unwrap()
            });
        }
        Ok(Vec::new())
    }
}

#[test]
fn video_probe_remux_and_poster_match_the_recorded_typescript_calls() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/media/video-process.json"
    ))
    .unwrap();
    for case in vectors["cases"].as_array().unwrap() {
        let fixture = Fixture {
            case,
            calls: RefCell::default(),
            deadline: Instant::now() + Duration::from_secs(10),
            paths: ["input", "output", "poster"].map(|key| {
                let wire = case[key].as_str().unwrap();
                (
                    std::env::temp_dir().join(wire.rsplit('/').next().unwrap()),
                    wire,
                )
            }),
        };
        let result = video::process(
            &fixture,
            &VideoRequest {
                paths: VideoPaths {
                    input: &fixture.paths[0].0,
                    output: &fixture.paths[1].0,
                    poster: &fixture.paths[2].0,
                },
                format: case["format"].as_str().unwrap().parse().unwrap(),
                prompt: case["prompt"].as_str(),
            },
            fixture.deadline,
            &|| case["cancelled"].as_bool() == Some(true),
        );
        let expected = &case["expected"];
        match result {
            Ok(info) => {
                assert_eq!(
                    info.duration_seconds,
                    expected["durationSeconds"].as_f64().unwrap()
                );
                assert_eq!(u64::from(info.width), expected["width"].as_u64().unwrap());
                assert_eq!(u64::from(info.height), expected["height"].as_u64().unwrap());
                assert_eq!(info.fps, expected["fps"].as_f64().unwrap());
                assert_eq!(info.audio, expected["audio"].as_bool().unwrap());
            }
            Err(error) => assert_eq!(error.code(), expected["error"], "{}", case["name"]),
        }
        assert_eq!(
            json!(*fixture.calls.borrow()),
            case["commands"],
            "{}",
            case["name"]
        );
    }
}

#[test]
fn video_container_is_detected_from_the_recorded_bytes() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/media/video-process.json"
    ))
    .unwrap();
    for case in vectors["containers"].as_array().unwrap() {
        let bytes: Vec<u8> = serde_json::from_value(case["bytes"].clone()).unwrap();
        let expected = case["expected"].as_str().unwrap();
        match video::detect_format(&bytes) {
            Ok(format) => assert_eq!(format, expected.parse().unwrap()),
            Err(error) => assert_eq!(error.code(), expected),
        }
    }
}
