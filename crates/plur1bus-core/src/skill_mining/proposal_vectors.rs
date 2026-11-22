use super::*;
use crate::rbac::types::{PrincipalKind, Role};
use crate::skill_mining::evidence::{Execution, Store};
use crate::skill_mining::miner::vectors::source;
use crate::skill_mining::review::{Decision, Proposal, State};
use serde_json::{json, Value};
use std::path::Path;

struct Host;
impl Clock for Host {
    fn now(&self) -> i64 {
        10
    }
}
impl Authority for Host {
    fn current(&self, id: &str) -> Option<Principal> {
        Some(Principal {
            kind: Some(PrincipalKind::Person),
            ..Principal::new(id, Role::Owner)
        })
    }
    fn allows(&self, _: &Scope, _: &Principal) -> bool {
        true
    }
}
struct Receiver<'a> {
    name: &'a str,
    calls: Vec<Value>,
    saved: Option<Proposal>,
}
impl Backend for Receiver<'_> {
    fn ready(&self) -> bool {
        self.name != "unavailable"
    }
    fn find(&mut self, scope: &Scope, hash: &str) -> R<Option<Proposal>> {
        self.calls
            .push(json!({"operation":"find","scope":scope,"hash":hash}));
        Ok(self.saved.clone())
    }
    fn propose(&mut self, scope: &Scope, candidate: &Candidate) -> R<Proposal> {
        self.calls.push(json!({"operation":"propose","scope":scope,"hash":candidate.workflow_hash,"enabled":candidate.enabled}));
        let proposal = Proposal {
            id: "fixture-proposal".into(),
            scope: scope.clone(),
            candidate: candidate.clone(),
            status: if self.name == "nonpending" {
                State::Accepted
            } else {
                State::Pending
            },
        };
        self.saved = Some(proposal.clone());
        Ok(proposal)
    }
    fn get(&mut self, _: &Scope, _: &str) -> R<Proposal> {
        panic!("mining must not review proposals")
    }
    fn decide(&mut self, _: &Scope, _: &str, _: &str, _: Decision) -> R<()> {
        panic!("mining must not mutate review state")
    }
}

#[test]
fn mining_is_proposal_only_and_deduplicates_the_scope() {
    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/skills/proposals.json"
    ))
    .unwrap();
    let original: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/skills/mining.json"
    ))
    .unwrap();
    let model = original.iter().find(|v| v["name"] == "valid").unwrap();
    let scope: Scope = serde_json::from_value(model["scope"].clone()).unwrap();
    let tools: Vec<Tool> = serde_json::from_value(model["tools"].clone()).unwrap();
    let source = source(model);
    let who = Host.current("ada").unwrap();
    for row in fixture {
        let name = row["name"].as_str().unwrap();
        let store = Store::open(Path::new(":memory:")).unwrap();
        if name != "no proof" {
            for entry in model["recorded"].as_array().unwrap() {
                store
                    .record(&serde_json::from_value::<Execution>(entry.clone()).unwrap())
                    .unwrap();
            }
        }
        let abort = AbortSignal::new();
        let mut backend = Receiver {
            name,
            calls: Vec::new(),
            saved: None,
        };
        let request = Request {
            scope: &scope,
            who: &who,
            settings: Settings::default(),
            abort: &abort,
        };
        let mut ports = Ports {
            authority: &Host,
            clock: &Host,
            sessions: &source,
            proof: &store,
            tools: &tools,
            backend: &mut backend,
        };
        let mut result = Vec::new();
        let times = if name == "deduplicated" { 2 } else { 1 };
        for _ in 0..times {
            result.push(match propose(&request,&mut ports){
                Ok(p)=>json!(p),
                Err(e)=>json!({"error":if e.code==CollabErrorCode::Conflict{"E_NOT_AVAILABLE"}else{"E_STORAGE"}}),
            });
        }
        assert_eq!(
            json!({"result":result,"calls":backend.calls,"status":status(&backend)}),
            row["expected"],
            "{name}"
        );
    }
}
