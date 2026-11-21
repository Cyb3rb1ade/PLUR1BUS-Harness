use super::*;
use crate::{
    media_search::{admission::Operation, Authority},
    policy::decide::{DenyReason, Via},
    rbac::types::{Principal, PrincipalKind, Role},
};
use serde_json::json;
use std::cell::{Cell, RefCell};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/parity/media/caption.json"
    ))
    .unwrap()
}

struct Rig<'a> {
    name: &'a str,
    local: bool,
    events: RefCell<Vec<Value>>,
    pin: Cell<bool>,
    cancelled: Cell<bool>,
    claim: Cell<bool>,
}
impl<'a> Rig<'a> {
    fn new(name: &'a str, local: bool) -> Self {
        Self {
            name,
            local,
            events: RefCell::new(Vec::new()),
            pin: Cell::new(name == "pinned"),
            cancelled: Cell::new(name == "cancelled"),
            claim: Cell::new(name != "claim failed"),
        }
    }

    fn run(&self, request: &Request<'_>, settings: &Settings) -> Result<Option<Caption>, Error> {
        let mut who = Principal::new("u", Role::Owner);
        who.kind = Some(PrincipalKind::Person);
        let scope = Scope {
            workspace: "w".into(),
            agent_id: "a".into(),
            user: Some("u".into()),
        };
        let caller = Caller {
            who: &who,
            scope: &scope,
            authority: self,
        };
        let ports = Ports {
            policy: self,
            input: self,
            provider: self,
            budget: (self.name != "unbound").then_some(self as &dyn TokenBudget),
        };
        resolve(&caller, request, settings, &ports)
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
impl Policy for Rig<'_> {
    fn route(&self, _: Operation, _: &Scope) -> Option<Route> {
        if self.name == "no provider" {
            return None;
        }
        Some(Route {
            provider: if self.local { "local" } else { "fixture-cloud" }.into(),
            model: "fixture-model".into(),
            endpoint: (self.name == "endpoint").then_some("https://example.invalid".into()),
            local: self.local,
            pinned: self.pin.get(),
            acknowledgment: (self.name != "missing").then(|| {
                json!({
                    "provider":"fixture-cloud","acknowledgedAt":"2026-01-01T00:00:00Z",
                    "by":if self.name=="invalid"{" "}else{"u"}
                })
            }),
        })
    }
}
impl Input for Rig<'_> {
    fn read(&self, _: &Scope, _: Source<'_>, _: usize) -> Result<Vec<u8>, Error> {
        Ok(vec![1, 2, 3])
    }
    fn frames(
        &self,
        _: &Scope,
        _: Source<'_>,
        count: usize,
        _: usize,
    ) -> Result<Vec<Frame>, Error> {
        self.events
            .borrow_mut()
            .push(json!({"intervalSec":10,"sceneDetect":true,"maxFrames":count}));
        Ok((0_u8..10)
            .map(|i| Frame {
                ts_ms: u64::from(i) * 100,
                bytes: vec![i],
                mime: "image/png".into(),
            })
            .collect())
    }
    fn cancelled(&self) -> bool {
        self.cancelled.get()
    }
}
impl Provider for Rig<'_> {
    fn decide_cloud(&self, _: &Caller<'_>, _: &ImageCall<'_>) -> Decision {
        self.events.borrow_mut().push(json!("policy"));
        if self.name == "pin during policy" {
            self.pin.set(true);
        }
        if self.name == "policy denied" {
            return Decision::Deny {
                reason: DenyReason::PolicyNever,
                rule: "test",
            };
        }
        Decision::Allow {
            via: Via::Default,
            grant_id: None,
            review_due: false,
        }
    }
    fn claim_cloud(&self, _: &Caller<'_>, _: &ImageCall<'_>, _: &Decision) -> bool {
        self.claim.get()
    }
    fn cloud_image(&self, call: &ImageCall<'_>) -> Result<Reply, Error> {
        self.events
            .borrow_mut()
            .push(json!(["request", call.wire()]));
        if self.name == "aborted while sent" {
            self.cancelled.set(true);
            return Err(Error::new("cancelled in port", "test"));
        }
        if self.name == "failed while sent" {
            return Err(Error::new("fixture provider failure", "test"));
        }
        Ok(Reply {
            text: " a fixture caption ".into(),
            provider: if self.name == "foreign reply" {
                "wrong"
            } else {
                "fixture-cloud"
            }
            .into(),
            model: "fixture-model".into(),
            input_tokens: (self.name != "no usage").then_some(11),
            output_tokens: (self.name != "no usage").then_some(5),
        })
    }
    fn local_image(&self, call: &ImageCall<'_>) -> Result<String, Error> {
        if self.name == "frames" {
            let i = call.frame.bytes[0];
            self.events.borrow_mut().push(json!(i));
            return Ok(format!("frame {i}"));
        }
        self.events.borrow_mut().push(json!("local"));
        Ok(" local\ncaption ".into())
    }
    fn local_transcript(&self, _: &Scope, _: Source<'_>, _: usize) -> Result<String, Error> {
        Ok("local transcript".into())
    }
}
impl TokenBudget for Rig<'_> {
    fn reserve(&self, call: &CallRequest<'_>) -> Result<Box<dyn TokenHold + '_>, Error> {
        self.events.borrow_mut().push(json!(["reserve",{
            "principal":call.principal,"agent":call.agent,"project":call.project,"model":call.model,
            "provider":call.provider,"estimatedInputTokens":call.estimated_input_tokens,"maxOutputTokens":call.max_output_tokens
        }]));
        if self.name == "budget" {
            return Err(Error::new("E_MEDIA_UNAVAILABLE", "budget"));
        }
        if self.name == "pin during reserve" {
            self.pin.set(true);
        }
        Ok(Box::new(Reservation(&self.events)))
    }
}
struct Reservation<'a>(&'a RefCell<Vec<Value>>);
impl TokenHold for Reservation<'_> {
    fn settle(self: Box<Self>, usage: &ActualCallUsage) -> Result<(), Error> {
        self.0.borrow_mut().push(json!(["settle","hold",{"inputTokens":usage.input_tokens,"outputTokens":usage.output_tokens}]));
        Ok(())
    }
    fn release(self: Box<Self>) -> Result<(), Error> {
        self.0.borrow_mut().push(json!(["release", "hold"]));
        Ok(())
    }
}

fn request() -> Request<'static> {
    Request {
        kind: Kind::Image,
        mime: "image/png",
        source: Source::Bytes(&[1, 2, 3]),
        prompt: None,
        user_caption: None,
    }
}
fn settings() -> Settings {
    Settings {
        order: Order::PromptThenUserThenAuto,
        max_chars: 50,
        frames: 5,
    }
}

#[test]
fn text_precedence_models_and_frames_match_typescript() {
    let f = fixture();
    for row in f["normalise"].as_array().unwrap() {
        assert_eq!(
            normalize(
                row["input"].as_str().unwrap(),
                row["cap"].as_u64().unwrap() as usize
            ),
            row["outcome"].as_str().unwrap()
        );
    }
    for row in f["service"].as_array().unwrap() {
        let mut req = request();
        req.prompt = row["prompt"].as_str();
        req.user_caption = row["userCaption"].as_str();
        let order = serde_json::from_value(row["source"].clone()).unwrap();
        let name = row["name"].as_str().unwrap();
        let rig = Rig::new(name, true);
        let output = rig
            .run(
                &req,
                &Settings {
                    order,
                    max_chars: 24,
                    frames: 5,
                },
            )
            .unwrap();
        assert_eq!(json!(output), row["outcome"], "{name}");
        assert_eq!(json!(rig.events.borrow().len()), row["calls"], "{name}");
    }
    let ack = json!({"provider":"fixture-cloud","acknowledgedAt":"2026-01-01T00:00:00Z","by":"u"});
    for row in f["providers"].as_array().unwrap() {
        let output = select_provider(
            row["id"].as_str(),
            row["pinned"].as_bool().unwrap(),
            row["embeddingLocal"].as_bool().unwrap(),
            Some(&ack),
        );
        assert_eq!(
            output.map_or_else(|e| json!({"error":e.code}), |id| json!(id)),
            row["chosen"]
        );
    }
    let frames = f["frameRows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["tsMs"].as_u64().unwrap(),
                f["text"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(merge(frames, 25), f["merged"].as_str().unwrap());
    for row in f["frames"].as_array().unwrap() {
        let rig = Rig::new("frames", true);
        let mut req = request();
        req.kind = Kind::Video;
        let out = rig
            .run(
                &req,
                &Settings {
                    max_chars: 60,
                    frames: row["count"].as_u64().unwrap() as usize,
                    ..settings()
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(out.text, row["caption"].as_str().unwrap());
        assert_eq!(json!(rig.events.into_inner()), row["calls"]);
    }
}

#[test]
fn cancelling_a_sent_caption_without_usage_charges_the_reserved_output() {
    let rig = Rig::new("aborted while sent", false);
    assert!(rig.run(&request(), &settings()).is_err());
    let events = rig.events.into_inner();
    assert_eq!(events[2][0], "request");
    assert_eq!(
        events[3],
        json!(["settle","hold",{"inputTokens":1500,"outputTokens":120}])
    );
}

#[test]
fn cloud_caption_replays_fake_wire_and_preserves_rights() {
    let f = fixture();
    assert_eq!(PROMPT, f["prompt"].as_str().unwrap());
    for row in f["cloud"].as_array().unwrap() {
        let name = row["name"].as_str().unwrap();
        let rig = Rig::new(name, false);
        let output = rig.run(&request(), &settings());
        let mut events = row["events"].clone();
        if row["divergence"] == "charge-uncertain-provider-usage" {
            *events.as_array_mut().unwrap().last_mut().unwrap() =
                json!(["settle","hold",{"inputTokens":1500,"outputTokens":120}]);
        }
        assert_eq!(json!(rig.events.into_inner()), events, "{name}");
        if let Some(text) = row["outcome"].as_str() {
            assert_eq!(output.unwrap().unwrap().text, text.trim(), "{name}");
        } else {
            let error = match name {
                "policy denied" => "E_DENIED",
                "cancelled" => "E_MEDIA_UNAVAILABLE",
                _ => row["outcome"]["error"].as_str().unwrap(),
            };
            assert_eq!(output.unwrap_err().code, error, "{name}");
        }
    }
}

#[test]
fn post_reservation_pin_and_policy_claim_win_before_send() {
    for name in ["pin during reserve", "claim failed"] {
        let rig = Rig::new(name, false);
        assert!(rig.run(&request(), &settings()).is_err());
        let events = rig.events.into_inner();
        assert_eq!(events.len(), 3, "{name}");
        assert_eq!(events[2], json!(["release", "hold"]), "{name}");
    }
    let rig = Rig::new("foreign reply", false);
    assert!(rig.run(&request(), &settings()).is_err());
    assert_eq!(rig.events.borrow()[3][0], "settle");
    let rig = Rig::new("wrong type", false);
    assert!(rig
        .run(
            &Request {
                mime: "text/plain",
                ..request()
            },
            &settings()
        )
        .is_err());
    assert!(rig.events.borrow().is_empty());
}
