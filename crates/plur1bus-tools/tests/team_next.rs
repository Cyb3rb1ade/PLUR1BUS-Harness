#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_tools::team::dispatch;
use serde_json::{json, Value};
fn initial() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/rpc-schema/fixtures/team/state.json"
    ))
    .unwrap()
}
fn step(s: &Value, mut e: Value) -> Value {
    e["seq"] = json!(s["run"]["lastEventSeq"].as_u64().unwrap() + 1);
    e["at"] = json!(s["run"]["now"].as_u64().unwrap() + 1);
    dispatch("tools.team.next", &json!({"state":s,"event":e})).unwrap()
}
fn approve(s: &Value, kind: &str) -> Value {
    step(
        s,
        json!({"kind":"plan.approved","actor":"person","by":"owner","planHash":s["run"]["planHash"],"checkHash":s["run"]["checkHash"],"compositionHash":s["run"]["compositionHash"],"policyHash":s["run"]["policyHash"],"scope":{"kind":kind}}),
    )
}
fn pkg(kind: &str, s: &Value) -> Value {
    json!({"kind":kind,"package":"duration","writerEpoch":s["packages"][0]["writerEpoch"]})
}
fn has(r: &Value, kind: &str) -> bool {
    r["actions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["kind"] == kind)
}
#[test]
fn no_execution_before_bound_approval_and_worktree_readiness() {
    let s = initial();
    let r = approve(&s, "plan");
    assert!(has(&r, "create-worktree"));
    assert!(!has(&r, "start-worker"));
    let s = &r["state"];
    assert_eq!(s["packages"][0]["status"], "ready");
    let r = step(s, pkg("worktree.ready", s));
    assert!(has(&r, "start-worker"));
    assert_eq!(r["state"]["packages"][0]["status"], "writing");
}
fn writing(lane: &str, scope: &str) -> Value {
    let mut s = initial();
    s["packages"][0]["lane"] = json!(lane);
    s["run"]["autoAllowed"] = json!(true);
    let r = approve(&s, scope);
    let s = &r["state"];
    step(s, pkg("worktree.ready", s))["state"].clone()
}
fn checked(mut s: Value, status: &str) -> Value {
    let mut e = pkg("worker.returned", &s);
    e["treeHash"] = json!("d".repeat(64));
    e["met"] = json!([true]);
    e["committedClean"] = json!(true);
    s = step(&s, e)["state"].clone();
    let mut e = pkg("checks.finished", &s);
    e["treeHash"] = s["packages"][0]["treeHash"].clone();
    e["sectionHead"] = s["sections"][0]["head"].clone();
    e["checks"] = json!([{"checkIndex":0,"criterion":0,"status":status}]);
    step(&s, e)["state"].clone()
}
fn review(s: &Value) -> Value {
    let mut e = pkg("review.verdict", s);
    e["treeHash"] = s["packages"][0]["treeHash"].clone();
    e["verdict"] = json!("pass");
    e["findingHash"] = Value::Null;
    e["disputed"] = json!(false);
    step(s, e)
}
fn confirm(s: &Value) -> Value {
    let mut e = pkg("team.merge.confirm", s);
    e["actor"] = json!("person");
    e["by"] = json!("owner");
    e["treeHash"] = s["packages"][0]["treeHash"].clone();
    e["sectionHead"] = s["sections"][0]["head"].clone();
    step(s, e)
}
#[test]
fn closed_and_wide_lanes_require_exact_human_confirmations() {
    let s = checked(writing("closed", "auto"), "passed");
    let r = review(&s);
    assert!(!has(&r, "merge-into-section"));
    assert!(has(&r, "ask-person"));
    let mut s = r["state"].clone();
    let mut bad = pkg("team.merge.confirm", &s);
    bad["actor"] = json!("person");
    bad["by"] = json!("owner");
    bad["treeHash"] = json!("e".repeat(64));
    bad["sectionHead"] = s["sections"][0]["head"].clone();
    assert!(!has(&step(&s, bad), "merge-into-section"));
    let r = confirm(&s);
    assert!(has(&r, "merge-into-section"));
    s = r["state"].clone();
    let mut e = pkg("package.merge.done", &s);
    e["treeHash"] = s["packages"][0]["treeHash"].clone();
    e["sectionHead"] = json!("e".repeat(64));
    e["affected"] = json!([]);
    let r = step(&s, e);
    assert!(has(&r, "lead-turn"));
    s = r["state"].clone();
    let r = step(
        &s,
        json!({"kind":"section.summary","section":"first","treeHash":s["sections"][0]["head"]}),
    );
    assert!(!has(&r, "merge-section"));
    assert!(has(&r, "ask-person"));
    let s = &r["state"];
    assert!(has(
        &step(
            s,
            json!({"kind":"team.section.merge","section":"first","treeHash":s["sections"][0]["head"],"targetHead":s["sections"][0]["targetHead"],"actor":"person","by":"owner"})
        ),
        "merge-section"
    ));
    for defect in 0..6 {
        let mut s = checked(writing("wide", "auto"), "passed");
        s["packages"][0]["revertRate"] = json!(0.05);
        match defect {
            0 => s["packages"][0]["revertRate"] = Value::Null,
            1 => s["packages"][0]["revertRate"] = json!(0.1),
            2 => s["packages"][0]["fixRounds"] = json!(3),
            3 => s["packages"][0]["hasDispute"] = json!(true),
            4 => s["packages"][0]["hadNeedsDecision"] = json!(true),
            _ => {}
        }
        let r = review(&s);
        assert_eq!(has(&r, "merge-into-section"), defect == 5);
    }
}
#[test]
fn unavailable_or_missing_checks_override_worker_met() {
    for status in ["failed", "unavailable"] {
        let s = checked(writing("contained", "plan"), status);
        assert_ne!(s["packages"][0]["status"], "reviewing");
        assert!(!has(&review(&s), "merge-into-section"));
    }
    let s = writing("contained", "plan");
    let mut e = pkg("worker.returned", &s);
    e["treeHash"] = json!("d".repeat(64));
    e["met"] = json!([true]);
    e["committedClean"] = json!(true);
    let s = step(&s, e)["state"].clone();
    let mut e = pkg("checks.finished", &s);
    e["treeHash"] = s["packages"][0]["treeHash"].clone();
    e["sectionHead"] = s["sections"][0]["head"].clone();
    e["checks"] = json!([]);
    assert!(!has(&step(&s, e), "start-review"));
}
#[test]
fn old_epochs_and_repeated_events_are_exact_noops() {
    let mut s = writing("contained", "plan");
    s["packages"][0]["writerEpoch"] = json!(2);
    let e = json!({"kind":"worktree.unavailable","package":"duration","writerEpoch":1,"seq":100,"at":100});
    let r = dispatch("tools.team.next", &json!({"state":s,"event":e})).unwrap();
    assert_eq!(r["state"], s);
    assert_eq!(r["actions"], json!([]));
    let e = json!({"kind":"disk.measured","freeBytes":0,"seq":100,"at":100});
    let input = json!({"state":s,"event":e});
    let a = dispatch("tools.team.next", &input).unwrap();
    assert_eq!(a, dispatch("tools.team.next", &input).unwrap());
    let b = dispatch("tools.team.next", &json!({"state":a["state"],"event":e})).unwrap();
    assert_eq!(b["state"], a["state"]);
    assert_eq!(b["actions"], json!([]));
}
#[test]
fn pause_resume_waits_for_stop_acknowledgement() {
    let s = writing("contained", "plan");
    let r = step(
        &s,
        json!({"kind":"team.pause","actor":"person","by":"owner"}),
    );
    assert!(has(&r, "stop-worker"));
    let s = &r["state"];
    let r = step(
        s,
        json!({"kind":"team.resume","actor":"person","by":"owner"}),
    );
    assert!(!has(&r, "start-worker"));
    let s = &r["state"];
    assert!(has(&step(s, pkg("writer.stopped", s)), "start-worker"));
}
#[test]
fn quota_handover_is_two_phase_and_honors_deadline_and_veto() {
    let mut s = writing("contained", "plan");
    s["members"].as_array_mut().unwrap().push(
        json!({"id":"other","roles":["writer"],"available":true,"eligiblePackages":["duration"]}),
    );
    let mut e = pkg("failure", &s);
    e["class"] = json!("quota");
    e["role"] = json!("writer");
    e["retryAfterMs"] = json!(0);
    e["retryBudgetExhausted"] = json!(false);
    e["canContinue"] = json!(false);
    s = step(&s, e)["state"].clone();
    assert_eq!(s["packages"][0]["status"], "holding");
    let at = s["packages"][0]["hold"]["handoverAt"].as_u64().unwrap();
    let timer = |s: &Value, at: u64| {
        dispatch("tools.team.next",&json!({"state":s,"event":{"seq":s["run"]["lastEventSeq"].as_u64().unwrap()+1,"at":at,"kind":"timer"}})).unwrap()
    };
    assert!(!has(&timer(&s, at - 1), "commit-handover"));
    let r = timer(&s, at);
    assert!(has(&r, "stop-worker"));
    assert!(!has(&r, "start-worker"));
    assert!(!has(&r, "commit-handover"));
    let next = &r["state"];
    let r = step(next, pkg("writer.stopped", next));
    assert!(has(&r, "commit-handover"));
    assert!(!has(&r, "start-worker"));
    let next = &r["state"];
    let r = step(next, pkg("handover.committed", next));
    assert!(has(&r, "start-worker"));
    assert_eq!(r["state"]["packages"][0]["writer"], "other");
    let mut e = pkg("person.hold", &s);
    e["actor"] = json!("person");
    e["by"] = json!("owner");
    e["until"] = Value::Null;
    s = step(&s, e)["state"].clone();
    let r = timer(&s, at + 100);
    assert_eq!(r["state"]["packages"][0]["status"], "holding");
    assert!(!has(&r, "stop-worker"));
}
#[test]
fn generated_sequences_preserve_safety_idempotency_and_determinism() {
    for seed in 0..32_u64 {
        let mut s = writing(if seed % 2 == 0 { "closed" } else { "wide" }, "auto");
        let mut random = seed + 1;
        for _ in 0..80 {
            random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
            let choice = (random >> 32) % 10;
            let mut e = match choice {
                0 => json!({"kind":"timer"}),
                1 => {
                    json!({"kind":"disk.measured","freeBytes":if random%2==0{0}else{40000000000_u64}})
                }
                2 => {
                    let mut e = pkg("worker.returned", &s);
                    e["treeHash"] = json!("d".repeat(64));
                    e["met"] = json!([true]);
                    e["committedClean"] = json!(true);
                    e
                }
                3 | 4 => {
                    let mut e = pkg("checks.finished", &s);
                    e["treeHash"] = json!("d".repeat(64));
                    e["sectionHead"] = s["sections"][0]["head"].clone();
                    e["checks"] = json!([{"checkIndex":0,"criterion":0,"status":if choice==3{"unavailable"}else{"passed"}}]);
                    e
                }
                5 => {
                    let mut e = pkg("review.verdict", &s);
                    e["treeHash"] = json!("d".repeat(64));
                    e["verdict"] = json!("pass");
                    e["findingHash"] = Value::Null;
                    e["disputed"] = json!(false);
                    e
                }
                6 => pkg("writer.stopped", &s),
                7 => pkg("worktree.ready", &s),
                8 => json!({"kind":"capacity.changed","maxWriters":random%4,"computedWriters":2}),
                _ => {
                    let mut e = pkg("failure", &s);
                    e["class"] = json!("auth");
                    e["role"] = json!("writer");
                    e["retryAfterMs"] = json!(0);
                    e["retryBudgetExhausted"] = json!(false);
                    e["canContinue"] = json!(false);
                    e
                }
            };
            e["seq"] = json!(s["run"]["lastEventSeq"].as_u64().unwrap() + 1);
            e["at"] = json!(s["run"]["now"].as_u64().unwrap() + 1000);
            let input = json!({"state":s,"event":e});
            let r = dispatch("tools.team.next", &input).unwrap();
            assert_eq!(r, dispatch("tools.team.next", &input).unwrap());
            assert!(!has(&r, "merge-into-section"));
            assert!(!has(&r, "merge-section"));
            if s["packages"][0]["status"] == "needs-decision" {
                assert_eq!(r["state"]["packages"][0]["status"], "needs-decision");
            }
            let replay =
                dispatch("tools.team.next", &json!({"state":r["state"],"event":e})).unwrap();
            assert_eq!(replay["state"], r["state"]);
            assert_eq!(replay["actions"], json!([]));
            s = r["state"].clone();
        }
    }
}
#[test]
fn scope_disk_budget_and_person_backpressure_prevent_admission() {
    for condition in 0..4 {
        let mut s = initial();
        match condition {
            0 => s["disk"]["freeBytes"] = json!(0),
            1 => s["capacity"]["maxWriters"] = json!(0),
            2 => s["packages"][0]["budgetAvailable"] = json!(false),
            _ => s["sections"][0]["budgetAvailable"] = json!(false),
        }
        assert!(!has(&approve(&s, "plan"), "create-worktree"));
    }
    let mut s = initial();
    for i in 0..3 {
        let key = format!("extra{i}");
        let mut p = s["plan"]["packages"][0].clone();
        p["key"] = json!(key);
        p["owns"] = json!([{ "glob": format!("src/{key}"), "mode": "own" }]);
        s["plan"]["packages"].as_array_mut().unwrap().push(p);
        s["plan"]["sections"][0]["mergeOrder"]
            .as_array_mut()
            .unwrap()
            .push(json!(key));
        let mut p = s["packages"][0].clone();
        p["key"] = json!(key);
        p["status"] = json!("needs-decision");
        p["personPending"] = json!(true);
        s["packages"].as_array_mut().unwrap().push(p);
    }
    s["run"]["planHash"] = json!(plur1bus_tools::team::hash(&s["plan"]));
    assert!(!has(&approve(&s, "plan"), "create-worktree"));
}
#[test]
fn dependency_waits_until_queued_and_old_epoch_cannot_release_it() {
    let mut s = initial();
    let mut plan = s["plan"]["packages"][0].clone();
    plan["key"] = json!("dependent");
    plan["worker"]["member"] = json!("other");
    plan["dependsOn"] = json!([{"package":"duration","kind":"code","carries":[{"kind":"symbol","value":"duration"}]}]);
    plan["owns"] = json!([{ "glob": "src/dependent", "mode": "own" }]);
    s["plan"]["packages"].as_array_mut().unwrap().push(plan);
    s["plan"]["sections"][0]["mergeOrder"] = json!(["duration", "dependent"]);
    let mut p = s["packages"][0].clone();
    p["key"] = json!("dependent");
    p["writer"] = json!("other");
    s["packages"].as_array_mut().unwrap().push(p);
    s["members"].as_array_mut().unwrap().push(
        json!({"id":"other","roles":["writer"],"available":true,"eligiblePackages":["dependent"]}),
    );
    s["run"]["planHash"] = json!(plur1bus_tools::team::hash(&s["plan"]));
    let r = approve(&s, "plan");
    assert_eq!(
        r["actions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|a| a["kind"] == "create-worktree")
            .count(),
        1
    );
    assert_eq!(r["state"]["packages"][1]["status"], "planned");
    s = r["state"].clone();
    s["packages"][0]["status"] = json!("queued");
    let r = step(&s, json!({"kind":"timer"}));
    assert_eq!(r["state"]["packages"][1]["status"], "ready");
}
#[test]
fn shared_next_fixture_roundtrips_and_unknown_events_are_refused() {
    let f: Value = serde_json::from_str(include_str!(
        "../../../packages/rpc-schema/fixtures/methods/tools.team.next.json"
    ))
    .unwrap();
    assert_eq!(
        dispatch("tools.team.next", &f["params"]).unwrap(),
        f["result"]
    );
    let mut bad = f["params"].clone();
    bad["event"]["kind"] = json!("model.approved");
    assert!(dispatch("tools.team.next", &bad).is_err());
    bad = f["params"].clone();
    bad["state"]["secret"] = json!("not-allowed");
    assert!(dispatch("tools.team.next", &bad).is_err());
}
#[test]
fn review_repetition_and_sync_conflicts_need_a_person() {
    let mut s = checked(writing("contained", "plan"), "passed");
    for round in 0..3 {
        let mut e = pkg("review.verdict", &s);
        e["treeHash"] = s["packages"][0]["treeHash"].clone();
        e["verdict"] = json!("changes-requested");
        e["findingHash"] = json!("f".repeat(64));
        e["disputed"] = json!(false);
        s = step(&s, e)["state"].clone();
        if round < 2 {
            s = checked(s, "passed");
        }
    }
    assert_eq!(s["packages"][0]["status"], "needs-decision");
    let r = step(&s, pkg("worktree.ready", &s));
    assert_eq!(r["state"]["packages"][0]["status"], "needs-decision");
    let mut s = writing("contained", "plan");
    s["packages"][0]["syncPending"] = json!(true);
    let mut e = pkg("safe-point", &s);
    e["committedClean"] = json!(false);
    assert!(!has(&step(&s, e.clone()), "sync-worktree"));
    e["committedClean"] = json!(true);
    let r = step(&s, e);
    assert!(has(&r, "sync-worktree"));
    s = r["state"].clone();
    let mut e = pkg("sync.conflict", &s);
    e["outsideOwns"] = json!(true);
    assert_eq!(
        step(&s, e)["state"]["packages"][0]["status"],
        "needs-decision"
    );
}
#[test]
fn a_reviewer_quota_hold_resumes_review_and_never_reassigns_the_writer() {
    let mut s = checked(writing("contained", "plan"), "passed");
    assert_eq!(s["packages"][0]["activeRole"], "reviewer");
    assert_eq!(s["packages"][0]["reviewer"], "reviewer");
    let mut e = pkg("failure", &s);
    e["class"] = json!("quota");
    e["role"] = json!("reviewer");
    e["retryAfterMs"] = json!(0);
    e["retryBudgetExhausted"] = json!(false);
    e["canContinue"] = json!(false);
    s = step(&s, e)["state"].clone();
    s = step(&s, pkg("writer.stopped", &s))["state"].clone();
    let mut e = pkg("quota.result", &s);
    e["available"] = json!(true);
    let r = step(&s, e);
    assert!(has(&r, "start-review"));
    assert!(!has(&r, "start-worker"));
    assert_eq!(r["state"]["packages"][0]["writer"], "writer");
}
#[test]
fn lead_holds_pause_the_run_and_old_lead_epochs_are_ignored() {
    let mut s = writing("contained", "plan");
    let r = step(
        &s,
        json!({"kind":"lead.failure","leadEpoch":0,"class":"quota","retryAfterMs":0}),
    );
    assert_eq!(r["state"]["run"]["status"], "paused");
    assert!(has(&r, "stop-lead"));
    assert!(has(&r, "stop-worker"));
    s = r["state"].clone();
    let r = step(
        &s,
        json!({"kind":"lead.quota.result","leadEpoch":0,"available":true}),
    );
    assert_eq!(r["state"], s);
    let r = step(
        &s,
        json!({"kind":"lead.stopped","leadEpoch":s["lead"]["epoch"]}),
    );
    s = r["state"].clone();
    let r = step(
        &s,
        json!({"kind":"lead.quota.result","leadEpoch":s["lead"]["epoch"],"available":true}),
    );
    assert!(has(&r, "lead-turn"));
    assert_eq!(r["state"]["run"]["status"], "running");
    assert!(!has(&r, "start-worker"));
}
#[test]
fn global_budget_holds_never_handover_and_run_budget_quiesces_workers() {
    let s = writing("contained", "plan");
    let r = step(
        &s,
        json!({"kind":"budget.refused","scope":"global","target":"duration","resetAt":0}),
    );
    let s = &r["state"];
    assert_eq!(s["packages"][0]["hold"]["allowHandover"], false);
    let r = dispatch(
        "tools.team.next",
        &json!({"state":s,"event":{"kind":"timer","at":5000000,"seq":100}}),
    )
    .unwrap();
    assert_eq!(r["state"]["packages"][0]["status"], "holding");
    assert!(!has(&r, "stop-worker"));
    let s = writing("contained", "plan");
    let r = step(
        &s,
        json!({"kind":"budget.refused","scope":"run","target":"team_fixture","resetAt":0}),
    );
    assert!(has(&r, "stop-worker"));
    assert_eq!(r["state"]["run"]["status"], "paused");
}
#[test]
fn shared_transition_vectors_cover_nonempty_outbox_and_epoch_noops() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../packages/rpc-schema/fixtures/team/transitions.json"
    ))
    .unwrap();
    for vector in vectors.as_array().unwrap() {
        assert_eq!(
            dispatch("tools.team.next", &vector["params"]).unwrap(),
            vector["result"],
            "{}",
            vector["name"]
        );
    }
}
#[test]
fn incoherent_authority_snapshots_are_refused_before_actions() {
    for defect in 0..3 {
        let mut s = initial();
        match defect {
            0 => {
                s["run"]["approved"] = json!(true);
                s["run"]["scope"] = json!({"kind":"auto"});
            }
            1 => s["lead"]["member"] = json!("writer"),
            _ => {
                s["packages"][0]["activeRole"] = json!("reviewer");
                s["packages"][0]["reviewer"] = json!("writer");
            }
        }
        assert!(dispatch(
            "tools.team.next",
            &json!({"state":s,"event":{"kind":"timer","at":1,"seq":1}})
        )
        .is_err());
    }
}
