use super::*;
use crate::dreams::learn::{digest, Error, Target, Window};
use crate::rbac::{
    audit::AuditEvent,
    types::{PrincipalKind, Role},
};
use crate::toolcall::json::parse;
use serde_json::{json, Value};
use std::path::Path;

struct When;
impl Clock for When {
    fn now(&self) -> i64 {
        25
    }
}
fn person(id: &str) -> Principal {
    Principal {
        kind: Some(PrincipalKind::Person),
        ..Principal::new(id, Role::Owner)
    }
}
struct Scoped {
    transcript: V,
    live: bool,
}
impl Source for Scoped {
    fn current_person(&self, id: &str) -> Option<Principal> {
        (id == "ada" && self.live).then(|| person(id))
    }
    fn sessions(&self, _: &Target, _: Window, _: usize, _: usize) -> Result<Vec<V>, Error> {
        Ok(vec![self.transcript.get("session").unwrap().clone()])
    }
    fn may_read_target(&self, _: &Target, _: &Principal) -> bool {
        self.live
    }
    fn may_read(&self, _: &Target, _: &V, _: &Principal) -> bool {
        self.live
    }
    fn session(&self, id: &str) -> Result<Option<V>, Error> {
        let s = self.transcript.get("session").unwrap();
        Ok(s.get("id").unwrap().is_str(id).then(|| s.clone()))
    }
    fn transcript(&self, _: &V, _: Window) -> Result<V, Error> {
        Ok(self.transcript.clone())
    }
    fn evidence(&self, _: &V, _: &[V]) -> Result<V, Error> {
        Ok(self.transcript.clone())
    }
}

struct Destination<'a> {
    name: &'a str,
    calls: Vec<Value>,
}

impl Memory for Destination<'_> {
    fn show(&mut self, _: &Principal, _: &str, _: &str) -> R<Option<ShownCard>> {
        panic!("an add must not read another memory");
    }
    fn apply(
        &mut self,
        _: &Principal,
        agent: &str,
        effect: Effect<'_>,
    ) -> Result<EffectReceipt, EffectFailure> {
        let Effect::Import {
            text,
            idempotency_key,
        } = effect
        else {
            panic!("unexpected test effect")
        };
        self.calls.push(json!({"method":"memory.importText.apply","params":{
            "entries":[{"category":"Other","sourceType":"chat","text":text,"warnings":[],"idempotencyKey":idempotency_key}],
            "targets":[{"target":"agent","agentIds":[agent]}],"dryRun":false
        }}));
        if self.name == "definite refusal" {
            return Err(EffectFailure::Refused);
        }
        Ok(EffectReceipt {
            agent_id: agent.into(),
            id: "import-fixture".into(),
            changed: usize::from(self.name != "unconfirmed"),
        })
    }
}

fn native(v: &V) -> Value {
    serde_json::from_str(&v.stringify()).unwrap()
}

#[test]
fn explicit_owner_decisions_replay_the_typescript_boundary() {
    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/learn/decisions.json"
    ))
    .unwrap();
    for row in fixture {
        let name = row["name"].as_str().unwrap();
        let target: Target = serde_json::from_value(row["target"].clone()).unwrap();
        let store = LearnStore::open(Path::new(":memory:")).unwrap();
        let mut run = store
            .begin(&target, Window { from: 1, to: 20 }, 20)
            .unwrap();
        run.session_ids = vec!["s1".into()];
        run.digest = "fixture".into();
        store.save(&run).unwrap();
        let finding = parse(row["finding"].as_str().unwrap()).unwrap();
        let id = finding.get("id").unwrap().as_js().unwrap().lossy();
        store.publish(&run, &[finding], 21, &[]).unwrap();
        let hash = if name == "wrong hash" {
            "stale".into()
        } else {
            digest(&store.finding(&id).unwrap().unwrap())
        };
        let source = Scoped {
            live: name != "revoked",
            transcript: parse(row["snapshot"].as_str().unwrap()).unwrap(),
        };
        let mut dest = Destination {
            name,
            calls: vec![],
        };
        let mut audit = |_: &AuditEvent| Ok(());
        let request = ReviewRequest {
            id: &id,
            content_hash: &hash,
            decision: if name == "rejected" {
                Decision::Rejected
            } else {
                Decision::Accepted
            },
            stale_action: None,
        };
        let mut service = Service {
            store: &store,
            source: &source,
            clock: &When,
            memory: &mut dest,
            audit: &mut audit,
        };
        let result = match service.decide(
            request,
            &person(if name == "other owner" { "ben" } else { "ada" }),
        ) {
            Ok(v) => native(&v),
            Err(e) => json!({"error":e.reason}),
        };
        let status = store
            .finding(&id)
            .unwrap()
            .unwrap()
            .get("status")
            .unwrap()
            .as_js()
            .unwrap()
            .lossy();
        let action = store.action(&id, 1).unwrap().as_ref().map(native);
        assert_eq!(
            json!({"result":result,"calls":dest.calls,"status":status,"action":action}),
            row["expected"],
            "{name}"
        );
    }
}

struct Bridge {
    name: String,
    calls: Vec<String>,
}
impl Handoff for Bridge {
    fn available(&self) -> bool {
        self.name != "missing"
    }
    fn submit(&mut self, finding: &V, key: &str) -> R<HandoffReceipt> {
        self.calls.push(key.into());
        if self.name == "retry" && self.calls.len() == 1 {
            return Err(CollabError::new(
                CollabErrorCode::Storage,
                "fixture unavailable",
            ));
        }
        Ok(HandoffReceipt {
            finding: finding.get("id").unwrap().as_js().unwrap().lossy(),
            hash: digest(finding),
            receipt: "receipt".into(),
        })
    }
}

#[test]
fn procedural_handoff_reuses_the_same_idempotency_key() {
    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/learn/handoff.json"
    ))
    .unwrap();
    for row in fixture {
        let name = row["name"].as_str().unwrap();
        let target: Target = serde_json::from_value(row["target"].clone()).unwrap();
        let store = LearnStore::open(Path::new(":memory:")).unwrap();
        let mut run = store
            .begin(&target, Window { from: 1, to: 20 }, 20)
            .unwrap();
        run.digest = "handoff".into();
        run.session_ids = vec!["s1".into()];
        store.save(&run).unwrap();
        let finding = parse(row["finding"].as_str().unwrap()).unwrap();
        let id = finding.get("id").unwrap().as_js().unwrap().lossy();
        store.publish(&run, &[finding], 21, &[]).unwrap();
        let source = Scoped {
            live: name != "revoked",
            transcript: parse(row["snapshot"].as_str().unwrap()).unwrap(),
        };
        let mut dest = Destination {
            name,
            calls: vec![],
        };
        let mut audit = |_: &AuditEvent| Ok(());
        let mut bridge = Bridge {
            name: name.into(),
            calls: Vec::new(),
        };
        let mut service = Service {
            store: &store,
            source: &source,
            clock: &When,
            memory: &mut dest,
            audit: &mut audit,
        };
        let first = service
            .handoff(&id, &person("ada"), &mut bridge)
            .unwrap_or(false);
        let second = service
            .handoff(&id, &person("ada"), &mut bridge)
            .unwrap_or(false);
        assert_eq!(
            json!({"calls":bridge.calls,"recorded":first||second}),
            row["expected"],
            "{name}"
        );
    }
}
