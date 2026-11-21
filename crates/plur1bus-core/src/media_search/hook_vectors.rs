use super::*;
use crate::{
    media_search::{
        caption::{normalize, Origin},
        Authority,
    },
    rbac::types::{Principal, PrincipalKind, Role},
};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};

#[derive(Default)]
struct Rig {
    time: Cell<u64>,
    notices: RefCell<Vec<Stage>>,
}
impl Authority for Rig {
    fn principal(&self, id: &str) -> Option<Principal> {
        let mut who = Principal::new(id, Role::Owner);
        who.kind = Some(PrincipalKind::Person);
        Some(who)
    }
    fn scope_is_current(&self, _: &Principal, _: &Scope) -> bool {
        true
    }
    fn now(&self) -> u64 {
        self.time.get()
    }
}
impl Notices for Rig {
    fn failed(&self, _: &Scope, _: &str, stage: Stage, _: &'static str) {
        self.notices.borrow_mut().push(stage);
    }
}
fn scope() -> Scope {
    Scope {
        workspace: "w".into(),
        agent_id: "a".into(),
        user: Some("u".into()),
    }
}
fn record(id: &str) -> Record {
    Record {
        id: id.into(),
        kind: Kind::Image,
        mime: "image/png".into(),
        prompt: None,
        user_caption: None,
    }
}
fn done(name: &str, req: &Request<'_>) -> Finished {
    let encoding = if name == "failed" {
        Err(Error::new("E_MEDIA_UNAVAILABLE", "fixture"))
    } else {
        Ok(Encoded {
            vectors: vec![vec![1.0]],
            segments: Vec::new(),
        })
    };
    let caption = if name == "caption error" {
        Err(Error::new("E_MEDIA_UNAVAILABLE", "fixture"))
    } else {
        let (source, text) = if let Some(prompt) = req.prompt {
            (Origin::Prompt, prompt)
        } else if let Some(manual) = req.user_caption {
            (Origin::User, manual)
        } else {
            (Origin::Auto, "auto caption")
        };
        Ok(Some(Caption {
            source,
            text: normalize(text, 80),
        }))
    };
    Finished { encoding, caption }
}

#[test]
fn stored_and_uploaded_work_removal_and_failure_match_typescript() {
    let fixture: Vec<Value> =
        serde_json::from_str(include_str!("../../../../fixtures/parity/media/hook.json")).unwrap();
    for row in fixture {
        let name = row["name"].as_str().unwrap();
        let rig = Rig::default();
        let who = rig.principal("u").unwrap();
        let scope = scope();
        let caller = Caller {
            who: &who,
            scope: &scope,
            authority: &rig,
        };
        let mut hook = Hook::new(
            scope.clone(),
            "u".into(),
            Index::new(1, None).unwrap(),
            2,
            10,
        )
        .unwrap();
        let mut requested = Vec::new();
        let mut removed = Vec::new();
        let enabled = name != "disabled" && name != "off";
        if name == "remove" {
            hook.delete(&caller, "id", &rig).unwrap();
            removed.push("id");
        } else {
            let mut record = record("id");
            let event = match name {
                "stored" => {
                    record.prompt = Some(" prompt caption ".into());
                    record.user_caption = Some("manual caption".into());
                    Event::Stored
                }
                "uploaded" => {
                    record.prompt = Some("unused caption".into());
                    record.user_caption = Some(" manual caption ".into());
                    Event::Uploaded
                }
                _ => Event::Uploaded,
            };
            hook.enqueue(&caller, record, event, enabled).unwrap();
            if let Some(work) = hook.next(&caller, enabled, &rig).unwrap() {
                let out = done(name, &work.request());
                let caption = out.caption.as_ref().ok().and_then(Option::as_ref);
                requested.push(json!({"id":work.record.id,"caption":caption.map(|c|c.text.as_str()),"source":caption.map(|c|c.source)}));
                assert!(
                    hook.finish(&caller, work.sequence, enabled, out, &rig)
                        .unwrap()
                        .is_some(),
                    "{name}"
                );
            }
        }
        assert_eq!(json!(requested), row["requested"], "{name}");
        assert_eq!(json!(removed), row["removed"], "{name}");
        assert_eq!(json!(rig.notices.into_inner()), row["failed"], "{name}");
    }
}

#[test]
fn expiry_deletion_principal_and_queue_limits_are_enforced() {
    let rig = Rig::default();
    let who = rig.principal("u").unwrap();
    let other = rig.principal("other").unwrap();
    let scope = scope();
    let caller = Caller {
        who: &who,
        scope: &scope,
        authority: &rig,
    };
    let outsider = Caller {
        who: &other,
        scope: &scope,
        authority: &rig,
    };
    let mut hook = Hook::new(
        scope.clone(),
        "u".into(),
        Index::new(1, None).unwrap(),
        1,
        5,
    )
    .unwrap();
    assert!(hook
        .enqueue(&outsider, record("id"), Event::Stored, true)
        .is_err());
    assert!(hook
        .enqueue(&caller, record("id"), Event::Stored, true)
        .unwrap());
    let first = hook.next(&caller, true, &rig).unwrap().unwrap();
    hook.enqueue(&caller, record("second"), Event::Stored, true)
        .unwrap();
    assert!(hook.next(&caller, true, &rig).unwrap().is_none());
    rig.time.set(5);
    let second = hook.next(&caller, true, &rig).unwrap().unwrap();
    assert_eq!(second.record.id, "second");
    assert!(hook
        .finish(
            &caller,
            first.sequence,
            true,
            done("", &first.request()),
            &rig
        )
        .unwrap()
        .is_none());
    hook.delete(&caller, "second", &rig).unwrap();
    assert!(hook
        .finish(
            &caller,
            second.sequence,
            true,
            done("", &second.request()),
            &rig
        )
        .unwrap()
        .is_none());
    assert_eq!(hook.index().counts(&caller).unwrap().indexed, 0);
    assert_eq!(rig.notices.borrow().len(), 1);
}
