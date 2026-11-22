use super::*;
use crate::budget::Clock;
use crate::collab::board::CardFields;
use crate::collab::ids::CollabIds;
use crate::collab::service::Ports;
use crate::collab::{CollabStore, StoreOptions};
use crate::rbac::types::{PrincipalKind, Role};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

struct Fixed;
impl Clock for Fixed {
    fn now(&self) -> i64 {
        1
    }
}

#[derive(Default)]
struct Ids(AtomicUsize);
impl CollabIds for Ids {
    fn new_id(&self, prefix: &str) -> String {
        format!("{prefix}_{}", self.0.fetch_add(1, Ordering::Relaxed))
    }
    fn trace_id(&self) -> String {
        self.new_id("trace")
    }
    fn span_id(&self) -> String {
        self.new_id("span")
    }
}

struct Roots<'a> {
    name: &'a str,
    rebound: Cell<bool>,
}
impl WorktreeBindings for Roots<'_> {
    fn root(&self, _: &str, _: &str, _: &str) -> R<Option<String>> {
        Ok(match (self.name, self.rebound.get()) {
            ("missing worktree", _) => None,
            (_, true) => Some("other".to_owned()),
            _ => Some("bound".to_owned()),
        })
    }
    fn canonical(&self, path: &str) -> R<String> {
        Ok(path.to_owned())
    }
}

struct Gate<'a> {
    svc: &'a CollabService,
    roots: &'a Roots<'a>,
    project: &'a str,
    card: &'a str,
    actor: &'a J,
    calls: RefCell<Vec<String>>,
}
impl SurfaceGate for Gate<'_> {
    fn snapshot(&self, root: &str) -> R<Snapshot> {
        self.calls.borrow_mut().push("snapshot".to_owned());
        let hash = if self.roots.name == "changed snapshot" {
            "changed"
        } else {
            "fixture-tree"
        };
        Ok(Snapshot {
            root: root.to_owned(),
            head: "fixture".to_owned(),
            tree_hash: hash.to_owned(),
            changed_lines: 5,
            files: vec![],
        })
    }
    fn verify(&mut self, input: VerifyInput<'_>) -> R<GateResult> {
        self.calls.borrow_mut().push(
            if input.override_note.is_some() {
                "override"
            } else {
                "verify"
            }
            .to_owned(),
        );
        if self.roots.name == "assignment revoked" {
            self.svc.store().board_assign(
                self.project,
                self.card,
                &J::obj([("kind", J::s("agent")), ("id", J::s("writer"))]),
                false,
                self.actor,
            )?;
        }
        if self.roots.name == "worktree rebound" {
            self.roots.rebound.set(true);
        }
        let failed = self.roots.name == "failed check";
        Ok(GateResult {
            ok: !failed,
            tree_hash: "fixture-tree".to_owned(),
            changed_lines: 5,
            checks: vec![],
            doc_gaps: vec![],
            reason: failed.then_some("verifiers-failed"),
            override_note: input.override_note.is_some(),
        })
    }
    fn record_review(&mut self, _: &str, _: &Snapshot, reviewer: &str, writer: &str) -> R<()> {
        self.calls
            .borrow_mut()
            .push(format!("review:{reviewer}:{writer}"));
        Ok(())
    }
}

#[test]
fn coding_surface_vectors() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/coding/surface.json"
    ))
    .unwrap();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let ids = Arc::new(Ids::default());
        let store = CollabStore::open(
            Path::new(":memory:"),
            StoreOptions::new(Arc::new(Fixed), ids.clone()),
        )
        .unwrap();
        let svc = CollabService::new(store, Ports::default(), ids);
        let owner = Principal {
            kind: Some(PrincipalKind::Person),
            ..Principal::new("owner", Role::Owner)
        };
        let outside = Principal {
            kind: Some(PrincipalKind::Person),
            ..Principal::new("outside", Role::Member)
        };
        let actor = J::obj([("kind", J::s("person")), ("id", J::s("owner"))]);
        let project = svc.create_project(&owner, "Coding", None).unwrap();
        for agent in ["writer", "reviewer", "a2a:peer"] {
            svc.add_agent(&owner, &project.id, agent).unwrap();
        }
        let cols = svc.store().board_columns(&project.id).unwrap();
        let start = cols[0].get("id").and_then(J::as_str).unwrap();
        let card = svc
            .store()
            .board_create_card(
                &project.id,
                start,
                None,
                &CardFields {
                    title: Some("Fixture".to_owned()),
                    description: Some("Self-reported green".to_owned()),
                    ..CardFields::default()
                },
                &actor,
                false,
            )
            .unwrap();
        let card_id = card.get("id").and_then(J::as_str).unwrap();
        svc.store()
            .board_assign(
                &project.id,
                card_id,
                &J::obj([("kind", J::s("agent")), ("id", J::s("writer"))]),
                true,
                &actor,
            )
            .unwrap();
        let roots = Roots {
            name,
            rebound: Cell::new(false),
        };
        let mut gate = Gate {
            svc: &svc,
            roots: &roots,
            project: &project.id,
            card: card_id,
            actor: &actor,
            calls: RefCell::default(),
        };
        let abort = AbortSignal::new();
        let result = if name.starts_with("review ") {
            start_review(&svc, &roots, &gate, &owner, &project.id, card_id, "writer").and_then(
                |ticket| {
                    let reviewer = if name == "review remote" {
                        "a2a:peer"
                    } else {
                        "reviewer"
                    };
                    let status = if name == "review partial" {
                        "partial"
                    } else {
                        "done"
                    };
                    finish_review(
                        &svc,
                        &mut gate,
                        &ticket,
                        reviewer,
                        &V::from_serde(
                            &json!({ "status": status, "output": { "verdict": "pass" } }),
                        ),
                    )
                },
            )
        } else {
            let person = if name == "foreign person" {
                &outside
            } else {
                &owner
            };
            let worker = !matches!(name, "human override" | "foreign person");
            complete(
                &svc,
                &roots,
                &mut gate,
                CompleteInput {
                    person,
                    project: &project.id,
                    card: card_id,
                    worker: worker.then_some(Worker {
                        agent: if name == "unassigned agent" {
                            "reviewer"
                        } else {
                            "writer"
                        },
                        user_id: if name == "wrong caller" {
                            "outside"
                        } else {
                            "owner"
                        },
                        turn_project: Some(&project.id),
                    }),
                    override_note: matches!(name, "human override" | "agent override")
                        .then_some("Explicit decision"),
                    abort: &abort,
                },
            )
            .map(|_| ())
        };
        let wire = match result {
            Ok(()) => json!({ "ok": true }),
            Err(error) => json!({ "error": match error.code {
                C::Unauthorized => "E_DENIED", C::Conflict => "E_CONFLICT", _ => error.code.as_str(),
            }, "message": error.message }),
        };
        assert_eq!(wire, case["result"], "{name}");
        let after = svc.store().board_get_card(&project.id, card_id).unwrap();
        assert_eq!(
            json!(after.get("columnId").and_then(J::as_str) != Some(start)),
            case["finished"],
            "{name}"
        );
        assert_eq!(json!(gate.calls.into_inner()), case["calls"], "{name}");
    }
}
