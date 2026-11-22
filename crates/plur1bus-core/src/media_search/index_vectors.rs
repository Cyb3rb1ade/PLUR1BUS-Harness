use super::*;
use crate::media_search::Authority;
use crate::rbac::types::{Principal, PrincipalKind, Role};
use serde_json::{json, Value};
use std::cell::Cell;

struct Auth {
    revoked: Cell<bool>,
}
impl Authority for Auth {
    fn principal(&self, id: &str) -> Option<Principal> {
        (!self.revoked.get()).then(|| owner(id))
    }
    fn scope_is_current(&self, _principal: &Principal, _scope: &Scope) -> bool {
        !self.revoked.get()
    }
    fn now(&self) -> u64 {
        0
    }
}
fn owner(id: &str) -> Principal {
    let mut who = Principal::new(id, Role::Owner);
    who.kind = Some(PrincipalKind::Person);
    who
}
struct Rank {
    hits: Vec<CaptionHit>,
}
impl Ranker for Rank {
    fn embed_text(&self, text: &str, _scope: &Scope) -> Result<Vec<f64>, Error> {
        Ok(if text == "bad" {
            vec![1.0]
        } else {
            vec![1.0, 0.0]
        })
    }
    fn captions(&self, text: &str, limit: usize, _scope: &Scope) -> Result<Vec<CaptionHit>, Error> {
        assert!(limit >= 50);
        assert!(!text.is_empty());
        Ok(self.hits.clone())
    }
}

fn project<T: Serialize>(got: Result<T, Error>) -> Value {
    got.map_or_else(|e| json!({"error":e.code}), |value| json!(value))
}

#[test]
fn rank_and_visibility_match_typescript() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../../fixtures/parity/media/index.json")).unwrap();
    let auth = Auth {
        revoked: Cell::new(false),
    };
    let who = owner("owner");
    let mut index = Index::new(2, Some(vec![Kind::Image, Kind::Video])).unwrap();
    let rank = Rank {
        hits: serde_json::from_value(fixture["cap"].clone()).unwrap(),
    };
    for (row, expected) in fixture["rows"]
        .as_array()
        .unwrap()
        .iter()
        .zip(fixture["indexed"].as_array().unwrap())
    {
        let id = row["id"].as_str().unwrap();
        let scope = serde_json::from_value(row["scope"].clone()).unwrap();
        let caller = Caller {
            who: &who,
            scope: &scope,
            authority: &auth,
        };
        let kind = serde_json::from_value(row["kind"].clone()).unwrap();
        let ticket = index.begin(&caller, id, kind).unwrap();
        let encoding = if id == "failed" {
            Err(Error::new("E_MEDIA_UNAVAILABLE", "isolated"))
        } else {
            Ok(Encoded {
                vectors: serde_json::from_value(row["vectors"].clone()).unwrap(),
                segments: row
                    .get("segments")
                    .map_or_else(Vec::new, |s| serde_json::from_value(s.clone()).unwrap()),
            })
        };
        let caption = row
            .get("caption")
            .and_then(Value::as_str)
            .map(str::to_owned);
        assert_eq!(
            project(index.finish(&caller, ticket, encoding, caption)),
            *expected,
            "{id}"
        );
    }
    let scope = serde_json::from_value(fixture["viewer"].clone()).unwrap();
    let caller = Caller {
        who: &who,
        scope: &scope,
        authority: &auth,
    };
    for row in fixture["searches"].as_array().unwrap() {
        let mut request = row["request"].clone();
        request.as_object_mut().unwrap().remove("scope");
        let query = serde_json::from_value(request).unwrap();
        let mut actual = project(index.search(&caller, &query, &rank));
        let mut expected = row["outcome"].clone();
        if let (Some(got), Some(want)) = (actual.as_array_mut(), expected.as_array_mut()) {
            assert_eq!(got.len(), want.len());
            for (a, b) in got.iter_mut().zip(want) {
                assert!(
                    (a["score"].as_f64().unwrap() - b["score"].as_f64().unwrap()).abs() < 1e-13,
                    "{}",
                    row["name"]
                );
                a.as_object_mut().unwrap().remove("score");
                b.as_object_mut().unwrap().remove("score");
            }
        }
        assert_eq!(actual, expected, "{}", row["name"]);
    }
    let counts = serde_json::to_value(index.counts(&caller).unwrap()).unwrap();
    assert_eq!(
        counts["indexed"].as_u64().unwrap() + 2,
        fixture["counts"]["indexed"].as_u64().unwrap()
    );
    assert_eq!(counts["failed"], fixture["counts"]["failed"]);
    assert_eq!(counts["unsupported"], fixture["counts"]["unsupported"]);
    index.remove(&caller, "image").unwrap();
    let query = serde_json::from_value(json!({"likeMediaId":"image","limit":3})).unwrap();
    assert_eq!(
        project(index.search(&caller, &query, &rank)),
        fixture["afterRemoval"]
    );
}

#[test]
fn deletion_and_revocation_win_over_delayed_index() {
    let who = owner("owner");
    let scope = Scope {
        workspace: "w".into(),
        agent_id: "a".into(),
        user: Some("owner".into()),
    };
    let other = Scope {
        workspace: "other".into(),
        ..scope.clone()
    };
    let auth = Auth {
        revoked: Cell::new(false),
    };
    let caller = Caller {
        who: &who,
        scope: &scope,
        authority: &auth,
    };
    let outsider = Caller {
        who: &who,
        scope: &other,
        authority: &auth,
    };
    let mut index = Index::new(2, None).unwrap();
    let first = index.begin(&caller, "m", Kind::Image).unwrap();
    assert!(index.begin(&outsider, "m", Kind::Image).is_err());
    assert!(index.remove(&outsider, "m").is_err());
    index.remove(&caller, "m").unwrap();
    let second = index.begin(&caller, "m", Kind::Image).unwrap();
    let encode = || {
        Ok(Encoded {
            vectors: vec![vec![1.0, 0.0]],
            segments: Vec::new(),
        })
    };
    assert_eq!(
        index.finish(&caller, first, encode(), None).unwrap().state,
        State::Pending
    );
    auth.revoked.set(true);
    assert!(index.finish(&caller, second, encode(), None).is_err());
    auth.revoked.set(false);
    assert_eq!(index.counts(&caller).unwrap().indexed, 0);
    assert!(index.begin(&caller, "m", Kind::Image).is_ok());
}
