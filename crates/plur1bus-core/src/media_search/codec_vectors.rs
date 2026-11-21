use super::*;
use crate::{
    media_search::Authority,
    rbac::types::{Principal, PrincipalKind, Role},
};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};

const PNG: [u8; 20] = [
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];
const HEADER: &[u8] = b"\0\0\0\x18ftypisom";

struct Rig<'a> {
    mode: &'a str,
    plans: RefCell<Vec<Value>>,
    live: Cell<bool>,
}
struct Input<'a> {
    rig: &'a Rig<'a>,
    bytes: Vec<u8>,
}
impl Lease for Input<'_> {
    fn live(&self, _: &Scope) -> bool {
        self.rig.live.get()
    }
    fn head(&self) -> &[u8] {
        &self.bytes
    }
    fn bytes(&self) -> usize {
        self.bytes.len()
    }
}
impl Sources for Rig<'_> {
    fn lease(&self, _: &Scope, source: Source<'_>, _: usize) -> Result<Box<dyn Lease + '_>, Error> {
        let Source::Bytes(bytes) = source else {
            panic!("expected only inline fixtures");
        };
        Ok(Box::new(Input {
            rig: self,
            bytes: bytes.to_vec(),
        }))
    }
}
impl Process for Rig<'_> {
    fn has_probe(&self) -> bool {
        true
    }
    fn execute(&self, _: &dyn Lease, plan: &Plan) -> Result<Output, Error> {
        self.plans
            .borrow_mut()
            .push(json!({"args":plan.arguments(),"shell":false}));
        if self.mode == "lost lease" {
            self.live.set(false);
        }
        let mut stderr = b"showinfo pts_time:0\nshowinfo pts_time:2.5\n".to_vec();
        let stdout = match plan.command {
            Command::Probe => b"12.5\n".to_vec(),
            Command::Audio { .. } => [0.0_f32, 0.25, -0.5, 1.0]
                .into_iter()
                .flat_map(f32::to_le_bytes)
                .collect(),
            Command::Video {
                filter: VideoFilter::Scene,
                ..
            } if self.mode == "fallback" => Vec::new(),
            Command::Video { .. } if self.mode == "truncated" => PNG[..17].to_vec(),
            Command::Video { .. } if self.mode == "bad time" => {
                stderr = b"showinfo pts_time:-90\n".to_vec();
                [PNG, PNG].concat()
            }
            Command::Video { .. } => [PNG, PNG].concat(),
        };
        Ok(Output { stdout, stderr })
    }
}
impl Authority for Rig<'_> {
    fn principal(&self, id: &str) -> Option<Principal> {
        let mut who = Principal::new(id, Role::Owner);
        who.kind = Some(PrincipalKind::Person);
        Some(who)
    }
    fn scope_is_current(&self, _: &Principal, _: &Scope) -> bool {
        true
    }
    fn now(&self) -> u64 {
        0
    }
}

fn scope() -> Scope {
    Scope {
        workspace: "w".into(),
        agent_id: "a".into(),
        user: Some("u".into()),
    }
}
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/parity/media/codec.json")).unwrap()
}

#[test]
fn codecs_apply_same_formats_and_bounded_process_plans() {
    let f = fixture();
    for row in f["headers"].as_array().unwrap() {
        let bytes: Vec<u8> = serde_json::from_value(row["bytes"].clone()).unwrap();
        assert_eq!(
            json!(allowed_container(&bytes)),
            row["allowed"],
            "{}",
            row["name"]
        );
    }
    for row in f["names"].as_array().unwrap() {
        let windows = row["platform"] == "win32";
        assert_eq!(json!(binary_extensions(windows)), row["extensions"]);
        for row in row["paths"].as_array().unwrap() {
            assert_eq!(
                json!(spawnable_name(row["path"].as_str().unwrap(), windows)),
                row["allowed"],
                "{}",
                row["path"]
            );
        }
    }
    let scope = scope();
    for row in f["ports"].as_array().unwrap() {
        let mode = row["name"].as_str().unwrap();
        let rig = Rig {
            mode,
            plans: RefCell::new(Vec::new()),
            live: Cell::new(true),
        };
        let who = rig.principal("u").unwrap();
        let caller = Caller {
            who: &who,
            scope: &scope,
            authority: &rig,
        };
        let out = if mode == "pcm" {
            let options = Audio {
                rate: 8000,
                max_seconds: 4,
                samples_per_chunk: 2,
            };
            json!(pcm(
                &caller,
                Source::Bytes(b"RIFF\0\0\0\0"),
                &options,
                &rig,
                &rig
            )
            .unwrap())
        } else {
            let options = Video {
                interval: 1.0,
                scene_detect: mode == "fallback",
                max_frames: 2,
            };
            let result = frames(&caller, Source::Bytes(HEADER), &options, &rig, &rig).unwrap();
            json!(result
                .into_iter()
                .map(|f| json!({"tsMs":f.ts_ms,"bytes":f.bytes,"mime":f.mime}))
                .collect::<Vec<_>>())
        };
        if mode == "pcm" {
            let actual = out.as_array().unwrap();
            let expected = row["out"].as_array().unwrap();
            assert_eq!(actual.len(), expected.len());
            for (a, b) in actual.iter().zip(expected) {
                assert_eq!(a["startMs"], b["startMs"]);
                let samples = |v: &Value| {
                    v["samples"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|n| n.as_f64().unwrap())
                        .collect::<Vec<_>>()
                };
                assert_eq!(samples(a), samples(b));
            }
        } else {
            assert_eq!(out, row["out"], "{mode}");
        }
        assert_eq!(json!(rig.plans.into_inner()), row["plans"], "{mode}");
    }
}

#[test]
fn rejects_untrusted_inputs_stale_leases_and_truncated_codec_output() {
    let scope = scope();
    for (mode, head, max, reason, calls) in [
        (
            "container",
            b"unsupported".as_slice(),
            2,
            "container-not-allowed",
            0,
        ),
        ("frames", HEADER, 10_000, "codec-frame-options", 0),
        ("lost lease", HEADER, 2, "codec-input-changed", 1),
        ("truncated", HEADER, 2, "codec-png-incomplete", 2),
    ] {
        let rig = Rig {
            mode,
            plans: RefCell::new(Vec::new()),
            live: Cell::new(true),
        };
        let who = rig.principal("u").unwrap();
        let caller = Caller {
            who: &who,
            scope: &scope,
            authority: &rig,
        };
        let options = Video {
            interval: 1.0,
            scene_detect: false,
            max_frames: max,
        };
        let result = frames(&caller, Source::Bytes(head), &options, &rig, &rig);
        assert_eq!(result.err().unwrap().reason, reason, "{mode}");
        assert_eq!(rig.plans.borrow().len(), calls, "{mode}");
    }
}
