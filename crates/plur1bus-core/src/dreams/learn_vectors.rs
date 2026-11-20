use super::*;
use crate::identity::principals::derive_user_principal;
use crate::rbac::types::{PrincipalKind, Role};
use crate::toolcall::json::parse;
use serde_json::{json, Value};
use std::cell::RefCell;

struct Fixture {
    who: Principal,
    name: String,
    data: Value,
    sessions: Vec<V>,
    loaded: RefCell<Vec<String>>,
}

fn id(row: &V) -> String {
    row.get("id").unwrap().as_js().unwrap().lossy()
}

impl Source for Fixture {
    fn current_person(&self, owner: &str) -> Option<Principal> {
        (self.who.user_id == owner).then(|| self.who.clone())
    }

    fn sessions(
        &self,
        _: &Target,
        _: Window,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<V>, Error> {
        Ok(self
            .sessions
            .iter()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect())
    }

    fn may_read_target(&self, _target: &Target, _who: &Principal) -> bool {
        true
    }

    fn may_read(&self, _: &Target, row: &V, _: &Principal) -> bool {
        !self.data["unreadable"]
            .as_array()
            .unwrap()
            .contains(&json!(id(row)))
    }

    fn transcript(&self, row: &V, _: Window) -> Result<V, Error> {
        let id = id(row);
        self.loaded.borrow_mut().push(id.clone());
        let mut session = row.clone();
        if self.name == "cross transcript" {
            let V::Obj(fields) = &mut session else {
                unreachable!()
            };
            fields.set("owner", V::s(&derive_user_principal("other").unwrap()));
        }
        let messages = match self.name.as_str() {
            "empty" => 0,
            "message cap" => 2001,
            _ => 1,
        };
        let events = match self.name.as_str() {
            "empty" => 0,
            "event cap" => 4001,
            _ => 1,
        };
        let text = if self.name == "byte cap" {
            "é".repeat(132_000)
        } else {
            "example".into()
        };
        let messages = (0..messages)
            .map(|i| {
                V::obj([
                    ("id", V::s(&format!("msg{i}"))),
                    (
                        "sessionId",
                        V::s(if self.name == "cross message" {
                            "other"
                        } else {
                            &id
                        }),
                    ),
                    ("turnId", V::s("turn")),
                    ("seq", V::Num(f64::from(i))),
                    ("role", V::s("user")),
                    ("text", V::s(&text)),
                    ("tokens", V::Num(2.0)),
                    ("createdAt", V::Num(23.0)),
                ])
            })
            .collect();
        let events = (0..events)
            .map(|i| {
                V::obj([
                    (
                        "sessionId",
                        V::s(if self.name == "cross event" {
                            "other"
                        } else {
                            &id
                        }),
                    ),
                    ("turnId", V::s("turn")),
                    ("seq", V::Num(f64::from(i))),
                    ("type", V::s("turn.started")),
                    ("data", V::obj([("origin", V::s("fixture"))])),
                    ("at", V::Num(23.0)),
                ])
            })
            .collect();
        let days = if self.name == "empty" {
            vec![]
        } else {
            vec![V::s("1970-01-01")]
        };
        let mut transcript = V::obj([
            ("session", session),
            ("messages", V::Arr(messages)),
            ("events", V::Arr(events)),
            ("days", V::Arr(days)),
        ]);
        if self.name == "person source" {
            let V::Obj(fields) = &mut transcript else {
                unreachable!()
            };
            fields.set("personMessageIds", V::Arr(vec![V::s("msg0")]));
        }
        Ok(transcript)
    }
}

#[test]
fn transcript_selection_matches_typescript() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/learn/selection.json"
    ))
    .unwrap();
    for row in fixture.as_array().unwrap() {
        let name = row["name"].as_str().unwrap();
        let target: Target = serde_json::from_value(row["target"].clone()).unwrap();
        let window: Window = serde_json::from_value(row["window"].clone()).unwrap();
        let mut who = Principal::new(row["who"]["userId"].as_str().unwrap(), Role::Owner);
        who.kind = PrincipalKind::parse(row["who"]["kind"].as_str().unwrap());
        let cap = usize::try_from(row["cap"].as_u64().unwrap()).unwrap();
        let source = Fixture {
            who: who.clone(),
            name: name.into(),
            data: row.clone(),
            sessions: row["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| parse(&x.to_string()).unwrap())
                .collect(),
            loaded: RefCell::new(Vec::new()),
        };
        let mut result = match select(&source, &target, &who, window, cap, window.to) {
            Ok(result) => {
                json!({"ids":result.transcripts.iter().map(|x|id(x.get("session").unwrap())).collect::<Vec<_>>(),
                "digest":selection_digest(&result.transcripts).unwrap(),"truncated":result.omitted_sessions>0,"omittedSessions":result.omitted_sessions})
            }
            Err(e) => json!({"error":e.as_str()}),
        };
        result["loaded"] = json!(*source.loaded.borrow());
        result["targetHash"] = json!(target_hash(&target));
        assert_eq!(result, row["expected"], "{name}");
    }
}
