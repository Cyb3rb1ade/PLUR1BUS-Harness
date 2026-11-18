//! Replays `fixtures/parity/session-rewind/cases.json` (mode V, `scripts/parity/export-session-rewind.ts`): the exact argument
//! lists and `GIT_*` environments the TypeScript checkpoint code sends its Git process, the error reasons of the failure paths,
//! the checkpoint commit and tree ids, and the file contents that remain. The fixture was recorded on unix (`/dev/null` is the
//! null device in the arguments), so the replay runs on unix only; the real `git` is needed and its absence is reported.
//!
//! Run-specific names are written in the file as `$ROOT`, `$TMP`, `$SID` and `$TURN`, and the replay maps its own names the
//! same way before it compares.
#![cfg(all(test, unix))]
use super::rewind::RestoreInput;
use super::rewind_checkpoints::TurnApprover;
use super::rewind_git::Cancel;
use super::rewind_support::*;
use super::{BeginOptions, SessionKind, SessionStore};
use serde_json::Value;

fn normalise(text: &str, root: &str, sid: &str, turn: &str) -> String {
    let t = text
        .replace(root, "$ROOT")
        .replace(sid, "$SID")
        .replace(turn, "$TURN");
    // The private directory of one operation: the path run before `p1b-checkpoint-` (no space or `=`) and the name after it.
    let mut out = String::new();
    let mut rest = t.as_str();
    while let Some(at) = rest.find("p1b-checkpoint-") {
        let head = &rest[..at];
        let start = head
            .rfind(|c: char| c.is_whitespace() || c == '=')
            .map_or(0, |i| i + 1);
        let end = rest[at + 15..]
            .find(|c: char| !c.is_ascii_alphanumeric())
            .map_or(rest.len(), |i| at + 15 + i);
        out.push_str(&head[..start]);
        out.push_str("$TMP");
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

fn calls(w: &World, from: usize, sid: &str, turn: &str) -> Value {
    let root = w.root.clone();
    let log = w.log.borrow();
    Value::Array(
        log[from..]
            .iter()
            .map(|c| {
                let mut env: Vec<(String, String)> = c.env.iter().map(|(k, v)| (k.clone(), normalise(v, &root, sid, turn))).collect();
                env.sort();
                serde_json::json!({
                    "args": c.args.iter().map(|a| normalise(a, &root, sid, turn)).collect::<Vec<_>>(),
                    "env": env.iter().map(|(k, v)| serde_json::json!([k, v])).collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

fn world(repository: &str) -> Option<World> {
    World::new_with(SessionKind::Card, |repo| match repository {
        "none" => repo.root.clone(),
        other => {
            let dir = std::path::Path::new(&repo.root)
                .parent()
                .unwrap()
                .join(other);
            std::fs::create_dir_all(&dir).unwrap();
            let dir = dir.to_string_lossy().into_owned();
            if other == "no-commit" {
                repo.git_in(&dir, &["init", "-q"]);
                std::fs::write(format!("{dir}/tracked.txt"), "original\n").unwrap();
                std::fs::write(format!("{dir}/other.txt"), "other\n").unwrap();
                repo.git_in(&dir, &["add", "-A"]);
            }
            dir
        }
    })
}

#[test]
fn the_recorded_typescript_checkpoint_and_restore_calls_replay_exactly() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/session-rewind/cases.json"
    ))
    .unwrap();
    let mut ran = 0;
    for case in fixture.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let Some(mut w) = world(case["repository"].as_str().unwrap()) else {
            return;
        };
        let root = w.root.clone();
        let sid = w.session.id.clone();
        w.answer.set(if case["approve"].as_bool().unwrap() {
            Answer::Once
        } else {
            Answer::Deny
        });
        let turn = w
            .store
            .begin_turn(&sid, "edit", 1, &BeginOptions::default())
            .unwrap()
            .turn
            .id;
        let write = |rel: &str, text: &str| {
            let p = std::path::Path::new(&root).join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        let git = |args: &[&str]| {
            w.repo.git_in(&root, args);
        };
        let mut results = Vec::new();
        for step in case["steps"].as_array().unwrap() {
            let step = step.as_str().unwrap();
            let (verb, text) = step.split_once(' ').unwrap_or((step, ""));
            match verb {
                "edit" => {
                    let (file, body) = text.split_once(' ').unwrap();
                    write(file, body);
                }
                "track" => git(&["add", text]),
                "untrack" => git(&["rm", "-q", "--cached", text]),
                "capture" | "restore" | "restore-asked-then-edit" => {
                    let from = w.log.borrow().len();
                    if verb == "restore-asked-then-edit" {
                        let (file, body) = text.split_once(' ').unwrap();
                        let p = std::path::Path::new(&root).join(file);
                        let body = body.to_owned();
                        *w.hook.borrow_mut() = Some(Box::new(move |_, _| {
                            std::fs::write(&p, &body).unwrap();
                            None
                        }));
                    }
                    let out = if verb == "capture" {
                        w.checkpoints
                            .capture(&mut w.store, &sid, &turn, "owner", &Cancel::new())
                    } else {
                        let mut ok = |_: &mut SessionStore| Ok(());
                        w.checkpoints.restore_files(
                            &mut w.store,
                            RestoreInput {
                                session_id: sid.clone(),
                                parent_seq: 0,
                                hidden_from_seq: 1,
                                hidden_to_seq: 2,
                                checkpoint_turn_id: turn.clone(),
                                approver: TurnApprover {
                                    person: Some("owner".into()),
                                    surface: 2,
                                },
                                signal: Cancel::new(),
                                validate: &mut ok,
                            },
                        )
                    };
                    *w.hook.borrow_mut() = None;
                    if verb == "capture" {
                        let _ = w.store.complete_turn(&turn, "done", 1, None);
                    }
                    let recorded = &case["results"][results.len()];
                    let want = &recorded["result"];
                    assert_eq!(
                        want["ok"].as_bool().unwrap(),
                        out.is_ok(),
                        "{name} {verb}: outcome"
                    );
                    if let Err(e) = &out {
                        assert_eq!(want["reason"].as_str(), e.reason(), "{name} {verb}: reason");
                        assert_eq!(
                            want["gitExit"].as_i64(),
                            e.git_exit().map(i64::from),
                            "{name} {verb}: git exit"
                        );
                    }
                    let got = calls(&w, from, &sid, &turn);
                    let (want_calls, got_calls) = (
                        recorded["calls"].as_array().unwrap(),
                        got.as_array().unwrap(),
                    );
                    for (i, (a, b)) in want_calls.iter().zip(got_calls).enumerate() {
                        assert_eq!(a, b, "{name} {verb}: git call {i}");
                    }
                    assert_eq!(
                        want_calls.len(),
                        got_calls.len(),
                        "{name} {verb}: number of git calls"
                    );
                    results.push(());
                }
                other => panic!("unknown step {other}"),
            }
        }
        let row = w.store.checkpoint(&sid, &turn).unwrap();
        match (&case["checkpoint"], row) {
            (Value::Null, None) => {}
            (want, Some(row)) => {
                assert_eq!(want["tree"].as_str().unwrap(), row.tree, "{name}: tree");
                assert_eq!(
                    want["commitId"].as_str().unwrap(),
                    row.commit_id,
                    "{name}: commit id"
                );
            }
            (want, None) => panic!("{name}: expected checkpoint {want}"),
        }
        for (file, want) in case["after"].as_object().unwrap() {
            let got = std::fs::read_to_string(std::path::Path::new(&root).join(file)).ok();
            assert_eq!(want.as_str().map(str::to_owned), got, "{name}: file {file}");
        }
        ran += 1;
    }
    assert_eq!(ran, fixture.as_array().unwrap().len());
}
