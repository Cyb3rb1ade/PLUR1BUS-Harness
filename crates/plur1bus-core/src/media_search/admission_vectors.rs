use super::*;
use crate::media_search::Authority;
use crate::rbac::types::{Principal, PrincipalKind, Role};
use serde_json::json;
use std::cell::{Cell, RefCell};

struct Rig<'a> {
    name: &'a str,
    log: RefCell<Vec<Value>>,
    reserved: Cell<bool>,
}

impl Authority for Rig<'_> {
    fn principal(&self, user: &str) -> Option<Principal> {
        if self.name == "revoked" && self.reserved.get() {
            return None;
        }
        let mut who = Principal::new(user, Role::Owner);
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
        let provider = if self.name == "route changes" && self.reserved.get() {
            "changed"
        } else {
            "cloud"
        };
        Some(Route {
            provider: provider.into(),
            model: "m".into(),
            endpoint: None,
            local: self.name.starts_with("local"),
            pinned: self.name == "pinned" || self.name == "pin changes" && self.reserved.get(),
            acknowledgment: Some(
                json!({"provider":provider,"by":"fixture","acknowledgedAt":"2026-01-01T00:00:00Z"}),
            ),
        })
    }
}
impl Budget for Rig<'_> {
    fn reserve(&self, units: Units<'_>) -> Result<Box<dyn Hold + '_>, Error> {
        self.log.borrow_mut().push(json!(units));
        self.reserved.set(true);
        Ok(Box::new(Reservation(&self.log)))
    }
}
struct Reservation<'a>(&'a RefCell<Vec<Value>>);
impl Hold for Reservation<'_> {
    fn settle(self: Box<Self>) -> Result<(), Error> {
        self.0.borrow_mut().push(json!("settle"));
        Ok(())
    }
    fn release(self: Box<Self>) -> Result<(), Error> {
        self.0.borrow_mut().push(json!("release"));
        Ok(())
    }
}

fn run(name: &str) -> (Value, Value) {
    let rig = Rig {
        name,
        log: RefCell::new(Vec::new()),
        reserved: Cell::new(false),
    };
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
        authority: &rig,
    };
    let result = if name.ends_with("search") {
        local_operation(&caller, &rig, Operation::Search, |_| {
            rig.log.borrow_mut().push(json!("text"));
            Ok(())
        })
    } else if name.ends_with("backfill") {
        local_operation(&caller, &rig, Operation::Backfill, |_| Ok(()))
    } else {
        let (kind, duration) = match name {
            "video" => (Kind::Video, Some(1.25)),
            "no duration" => (Kind::Video, None),
            "negative duration" => (Kind::Video, Some(-1.0)),
            "infinite duration" => (Kind::Video, Some(f64::INFINITY)),
            "audio" => (Kind::Audio, None),
            _ => (Kind::Image, None),
        };
        let budget = (name != "no budget").then_some(&rig as &dyn Budget);
        encode(&caller, &rig, budget, kind, duration, |_| {
            rig.log.borrow_mut().push(json!("encode"));
            if name == "failed" {
                return Err(Error::new("E_MEDIA_UNAVAILABLE", "fixture"));
            }
            Ok(())
        })
    };
    (
        json!(result.map_or_else(|e| e.code, |()| "ok")),
        json!(rig.log.into_inner()),
    )
}

#[test]
fn privacy_and_metering_match_typescript() {
    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/media/admission.json"
    ))
    .unwrap();
    for row in fixture {
        let name = row["name"].as_str().unwrap();
        let (outcome, events) = run(name);
        assert_eq!(outcome, row["outcome"], "{name}");
        assert_eq!(events, row["events"], "{name}");
    }
}

#[test]
fn route_changes_and_revocations_release_without_encoding() {
    for name in ["route changes", "revoked"] {
        let (result, events) = run(name);
        assert_ne!(result, "ok", "{name}");
        assert_eq!(events.as_array().unwrap().len(), 2, "{name}");
        assert_eq!(events[1], "release", "{name}");
    }
}
