//! Direct tests of the checkpoint, restore and retention code against the real `git` in temporary directories (skipped, with a
//! line saying so, where there is none). They port the TypeScript tests `rewind-files`, `rewind-missing-worktree`,
//! `rewind-retention-restart` and `rewind-retention-timer`; the argument lists and the failure paths that have a TypeScript
//! answer are replayed in `rewind_vectors.rs`.
//!
//! These tests send real paths through the real file system port, which on Windows answers nothing useful for
//! `realpath` of a `\\?\` path against Git's forward-slash output (R-K-12 is the same limit of the path layer), so they run
//! on unix only.
#![cfg(all(test, unix))]
use super::rewind::RestoreInput;
use super::rewind_git::{AbortReason, Cancel, GitFailure, RewindError};
use super::rewind_support::*;
use super::{SessionKind, SessionStore};
use std::sync::atomic::Ordering;

fn restore(w: &mut World, turn: &str) -> Result<(), RewindError> {
    let mut ok = |_: &mut SessionStore| Ok(());
    w.checkpoints.restore_files(
        &mut w.store,
        RestoreInput {
            session_id: w.session.id.clone(),
            parent_seq: 0,
            hidden_from_seq: 1,
            hidden_to_seq: 2,
            checkpoint_turn_id: turn.to_owned(),
            approver: super::rewind_checkpoints::TurnApprover {
                person: Some("owner".into()),
                surface: 2,
            },
            signal: Cancel::new(),
            validate: &mut ok,
        },
    )
}

fn reason(r: Result<(), RewindError>) -> String {
    r.unwrap_err().reason().unwrap_or("-").to_owned()
}

#[test]
fn capture_writes_a_private_ref_a_row_and_an_audit_line_and_leaves_the_real_index_and_head_alone() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    let head = w.repo.git(&["rev-parse", "HEAD"]);
    let index = std::fs::read(format!("{}/.git/index", w.repo.root)).unwrap();
    w.repo.write("tracked.txt", "edited but unstaged\n");
    let turn = w.turn();
    let row = w.store.checkpoint(&w.session.id, &turn).unwrap().unwrap();
    assert_eq!(
        row.ref_name,
        format!("refs/plur1bus/checkpoints/{}/{turn}", w.session.id)
    );
    assert_eq!(w.repo.refs(), row.ref_name);
    assert_eq!(
        w.repo.git(&["rev-parse", &row.ref_name]).trim(),
        row.commit_id
    );
    assert_eq!(
        w.repo
            .git(&["rev-parse", &format!("{}^{{tree}}", row.ref_name)])
            .trim(),
        row.tree
    );
    // The snapshot holds the working bytes, not the staged ones.
    assert_eq!(
        w.repo
            .git(&["show", &format!("{}:tracked.txt", row.ref_name)]),
        "edited but unstaged\n"
    );
    assert_eq!(
        w.repo.git(&["rev-parse", "HEAD"]),
        head,
        "HEAD does not move"
    );
    assert_eq!(
        std::fs::read(format!("{}/.git/index", w.repo.root)).unwrap(),
        index,
        "the real index is untouched"
    );
    assert_eq!(
        w.repo
            .git(&["log", "-1", "--format=%an <%ae>", &row.ref_name])
            .trim(),
        "PLUR1BUS <checkpoint@plur1bus.invalid>"
    );
    assert_eq!(w.actions(), ["session.checkpoint.created"]);
    let e = w.audit.borrow()[0].clone();
    assert_eq!(
        (e.user.as_str(), e.host.as_str(), e.target.as_str()),
        ("owner", "core", w.session.id.as_str())
    );
    assert_eq!(row.root, w.repo.root);
    assert!(row.common_git_dir.ends_with("/.git"));
}

#[test]
fn capture_does_nothing_for_a_direct_or_incognito_session_or_when_the_project_is_not_opted_in() {
    let Some(mut w) = World::new(SessionKind::Direct) else {
        return;
    };
    w.turn();
    assert!(!w.store.has_checkpoints().unwrap());
    assert!(
        w.log.borrow().is_empty(),
        "no Git call for a session that takes no checkpoint"
    );
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    w.projects.borrow_mut().clear();
    w.turn();
    assert!(!w.store.has_checkpoints().unwrap());
    *w.projects.borrow_mut() = vec!["other".into()];
    w.turn();
    assert!(
        !w.store.has_checkpoints().unwrap(),
        "a project that is not in the list takes none"
    );
    assert!(w.log.borrow().is_empty());
}

#[test]
fn capture_refuses_a_turn_of_another_session_and_an_ended_card() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    let other = w
        .store
        .create_session(&super::CreateSessionInput::new(
            SessionKind::Card,
            "a",
            "owner",
        ))
        .unwrap();
    let begun = w
        .store
        .begin_turn(&other.id, "x", 1, &Default::default())
        .unwrap();
    let e = w
        .checkpoints
        .capture(
            &mut w.store,
            &w.session.id,
            &begun.turn.id,
            "owner",
            &Cancel::new(),
        )
        .unwrap_err();
    assert_eq!(e.reason(), Some("rewind-checkpoint"));
    w.ended.set(true);
    let begun2 = w
        .store
        .begin_turn(&w.session.id, "y", 1, &Default::default())
        .unwrap();
    let e = w
        .checkpoints
        .capture(
            &mut w.store,
            &w.session.id,
            &begun2.turn.id,
            "owner",
            &Cancel::new(),
        )
        .unwrap_err();
    assert_eq!(e.reason(), Some("rewind-checkpoint-unavailable"));
    assert_eq!(w.repo.refs(), "");
}

#[test]
fn a_capture_for_a_repository_without_a_commit_is_refused_and_leaves_nothing_behind() {
    let Some(mut w) = World::new_with(SessionKind::Card, |repo| {
        let fresh = std::fs::canonicalize(repo.dir.path())
            .unwrap()
            .join("fresh");
        std::fs::create_dir_all(&fresh).unwrap();
        let fresh = fresh.to_string_lossy().into_owned();
        repo.git_in(&fresh, &["init", "-q"]);
        std::fs::write(format!("{fresh}/a.txt"), "a\n").unwrap();
        repo.git_in(&fresh, &["add", "a.txt"]);
        fresh
    }) else {
        return;
    };
    let begun = w
        .store
        .begin_turn(&w.session.id, "x", 1, &Default::default())
        .unwrap();
    let e = w
        .checkpoints
        .capture(
            &mut w.store,
            &w.session.id,
            &begun.turn.id,
            "owner",
            &Cancel::new(),
        )
        .unwrap_err();
    assert_eq!(e.reason(), Some("rewind-checkpoint"));
    assert!(!w.store.has_checkpoints().unwrap());
    assert_eq!(
        w.actions(),
        Vec::<String>::new(),
        "no audit line for a checkpoint that was not made"
    );
}

#[test]
fn restore_puts_tracked_files_back_and_leaves_untracked_files_and_the_real_index_alone() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    let turn = w.turn();
    w.repo.write("tracked.txt", "changed later\n");
    std::fs::remove_file(format!("{}/other.txt", w.repo.root)).unwrap();
    w.repo.write("untracked.txt", "mine\n");
    w.repo.write("staged.txt", "staged\n");
    w.repo.git(&["add", "staged.txt"]);
    let index_before = std::fs::read(format!("{}/.git/index", w.repo.root)).unwrap();
    let head = w.repo.git(&["rev-parse", "HEAD"]);
    restore(&mut w, &turn).unwrap();
    assert_eq!(w.repo.read("tracked.txt").as_deref(), Some("original\n"));
    assert_eq!(
        w.repo.read("other.txt").as_deref(),
        Some("other\n"),
        "a deleted tracked file comes back"
    );
    assert_eq!(
        w.repo.read("untracked.txt").as_deref(),
        Some("mine\n"),
        "an untracked file stays"
    );
    assert_eq!(
        w.repo.read("staged.txt").as_deref(),
        Some("staged\n"),
        "a file added after the checkpoint stays (overlay)"
    );
    assert_eq!(
        std::fs::read(format!("{}/.git/index", w.repo.root)).unwrap(),
        index_before,
        "the real index is untouched"
    );
    assert_eq!(w.repo.git(&["rev-parse", "HEAD"]), head);
    let asks = w.asks.borrow();
    assert_eq!(asks.len(), 1);
    assert_eq!(asks[0].tool, "rewind.files.restore");
    assert_eq!(asks[0].targets, [w.repo.root.clone()]);
    assert!(
        asks[0]
            .diff
            .starts_with("Overlay restore: overwrite 2; preserve 1 newly tracked paths."),
        "{}",
        asks[0].diff
    );
    assert!(asks[0].diff.contains("Overwrite: \"tracked.txt\""));
    assert!(asks[0]
        .diff
        .contains("Preserve new tracked: \"staged.txt\""));
    assert_eq!(asks[0].action_hash.len(), 64);
    assert_eq!(
        w.actions(),
        ["session.checkpoint.created", "session.rewind.files"],
        "the audit line of the restore is the second event"
    );
    assert_eq!(
        *w.order.borrow(),
        ["request", "begin"],
        "the approval is consumed after the ask and before the write"
    );
}

#[test]
fn restore_audit_names_the_action_hash_and_the_request_and_no_file_content() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    let turn = w.turn();
    w.repo.write("tracked.txt", "SECRET-CONTENT\n");
    restore(&mut w, &turn).unwrap();
    let e = w.audit.borrow()[1].clone();
    let keys: Vec<&str> = e.detail.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        keys,
        [
            "sessionId",
            "root",
            "ref",
            "checkpoint",
            "beforeTree",
            "indexHash",
            "changes",
            "actionHash",
            "requestId"
        ]
    );
    assert_eq!(e.user, "owner");
    assert!(!format!("{:?}", e.detail).contains("SECRET-CONTENT"));
    assert_eq!(
        w.asks.borrow()[0].action_hash,
        e.detail[7].1.as_str().unwrap()
    );
}

#[test]
fn a_declined_or_wrong_scope_answer_changes_nothing() {
    for answer in [Answer::Deny, Answer::Session] {
        let Some(mut w) = World::new(SessionKind::Card) else {
            return;
        };
        let turn = w.turn();
        w.repo.write("tracked.txt", "changed\n");
        w.answer.set(answer);
        assert_eq!(reason(restore(&mut w, &turn)), "rewind-files-not-approved");
        assert_eq!(w.repo.read("tracked.txt").as_deref(), Some("changed\n"));
        assert_eq!(w.begun.get(), 0, "an unapproved answer is never consumed");
        assert_eq!(w.actions(), ["session.checkpoint.created"]);
    }
}

#[test]
fn a_consumed_approval_refuses_the_write() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    let turn = w.turn();
    w.repo.write("tracked.txt", "changed\n");
    restore(&mut w, &turn).unwrap();
    w.repo.write("tracked.txt", "changed again\n");
    // The double's approval is single use: the second restore finds it consumed.
    assert_eq!(reason(restore(&mut w, &turn)), "rewind-files-not-approved");
    assert_eq!(
        w.repo.read("tracked.txt").as_deref(),
        Some("changed again\n")
    );
}

#[test]
fn a_change_while_the_approval_waits_refuses_the_restore() {
    for what in ["file", "stage"] {
        let Some(mut w) = World::new(SessionKind::Card) else {
            return;
        };
        let turn = w.turn();
        w.repo.write("tracked.txt", "changed\n");
        let root = w.repo.root.clone();
        let home = w.repo.home.clone();
        *w.hook.borrow_mut() = Some(Box::new(move |_, _| {
            if what == "file" {
                std::fs::write(format!("{root}/tracked.txt"), "changed while waiting\n").unwrap();
            } else {
                let r = Repo {
                    dir: tempfile::tempdir().unwrap(),
                    root: root.clone(),
                    home: home.clone(),
                };
                std::fs::write(format!("{root}/new.txt"), "n\n").unwrap();
                r.git(&["add", "new.txt"]);
            }
            None
        }));
        assert_eq!(
            reason(restore(&mut w, &turn)),
            "rewind-files-changed",
            "{what}"
        );
        assert_ne!(w.repo.read("tracked.txt").as_deref(), Some("original\n"));
        assert_eq!(w.begun.get(), 0);
        assert_eq!(
            w.actions(),
            ["session.checkpoint.created"],
            "no restore line before the write is allowed"
        );
    }
}

#[test]
fn a_restore_needs_a_person_a_recorded_checkpoint_and_the_project_opt_in() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    let turn = w.turn();
    let mut ok = |_: &mut SessionStore| Ok(());
    let input = |person: Option<&str>,
                 turn: &str,
                 ok: &mut dyn FnMut(&mut SessionStore) -> Result<(), RewindError>| {
        let _ = &ok;
        (person.map(str::to_owned), turn.to_owned())
    };
    let _ = input(None, &turn, &mut ok);
    let run = |w: &mut World, person: Option<&str>, t: &str| {
        let mut ok = |_: &mut SessionStore| Ok(());
        w.checkpoints.restore_files(
            &mut w.store,
            RestoreInput {
                session_id: w.session.id.clone(),
                parent_seq: 0,
                hidden_from_seq: 1,
                hidden_to_seq: 2,
                checkpoint_turn_id: t.to_owned(),
                approver: super::rewind_checkpoints::TurnApprover {
                    person: person.map(str::to_owned),
                    surface: 2,
                },
                signal: Cancel::new(),
                validate: &mut ok,
            },
        )
    };
    assert_eq!(reason(run(&mut w, None, &turn)), "rewind-person-required");
    assert_eq!(
        reason(run(&mut w, Some(""), &turn)),
        "rewind-person-required"
    );
    assert_eq!(
        reason(run(&mut w, Some("owner"), "no_such_turn")),
        "rewind-checkpoint-unavailable"
    );
    assert_eq!(
        reason(run(&mut w, Some("owner"), "bad turn id")),
        "rewind-checkpoint"
    );
    w.projects.borrow_mut().clear();
    assert_eq!(
        reason(run(&mut w, Some("owner"), &turn)),
        "rewind-files-disabled"
    );
    assert!(w.asks.borrow().is_empty(), "nobody was asked");
}

#[test]
fn a_restore_does_not_overwrite_an_untracked_file_or_a_non_directory_in_a_checkpointed_path() {
    for shape in ["file", "directory-is-a-file"] {
        let Some(mut w) = World::new(SessionKind::Card) else {
            return;
        };
        w.repo.write("dir/inner.txt", "tracked at capture\n");
        w.repo.git(&["add", "dir/inner.txt"]);
        let turn = w.turn();
        // Drop the path from the index but keep (or replace) the file: it is now untracked yet in the checkpoint tree.
        w.repo.git(&["rm", "--cached", "-q", "dir/inner.txt"]);
        if shape == "directory-is-a-file" {
            std::fs::remove_dir_all(format!("{}/dir", w.repo.root)).unwrap();
            w.repo.write("dir", "now a file\n");
        } else {
            w.repo.write("dir/inner.txt", "untracked and precious\n");
        }
        assert_eq!(
            reason(restore(&mut w, &turn)),
            "rewind-files-changed",
            "{shape}"
        );
        if shape == "file" {
            assert_eq!(
                w.repo.read("dir/inner.txt").as_deref(),
                Some("untracked and precious\n")
            );
        } else {
            assert_eq!(w.repo.read("dir").as_deref(), Some("now a file\n"));
        }
        assert!(w.asks.borrow().is_empty(), "refused before anyone is asked");
    }
}

#[test]
fn a_changed_checkpoint_ref_is_refused_as_changed_outside_the_harness() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    let turn = w.turn();
    let row = w.store.checkpoint(&w.session.id, &turn).unwrap().unwrap();
    w.repo.git(&["update-ref", &row.ref_name, "HEAD"]);
    assert_eq!(reason(restore(&mut w, &turn)), "rewind-checkpoint");
}

#[test]
fn the_git_calls_are_argument_lists_with_the_documented_options_and_a_clean_environment() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    w.turn();
    let calls = w.log.borrow().clone();
    let first = &calls[0];
    let null = "/dev/null";
    let root = w.repo.root.clone();
    let expect: Vec<String> = [
        "--no-pager",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "tag.gpgSign=false",
        "-c",
        &format!("core.hooksPath={null}"),
        "-c",
        &format!("core.attributesFile={null}"),
        "-C",
        &root,
        "rev-parse",
        "--show-toplevel",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    assert_eq!(first.args, expect);
    let names: Vec<&str> = first.env.iter().map(|(k, _)| k.as_str()).collect();
    for n in [
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_GLOBAL",
        "GIT_ATTR_NOSYSTEM",
        "GIT_NO_REPLACE_OBJECTS",
        "GIT_OPTIONAL_LOCKS",
        "GIT_TERMINAL_PROMPT",
    ] {
        assert!(names.contains(&n), "{n} is set");
    }
    assert!(
        !names.contains(&"GIT_DIR") && !names.contains(&"git_work_tree"),
        "inherited GIT_ names are removed: {names:?}"
    );
    // Every private-index call binds the private Git directory, the worktree and the shared object store.
    let adds: Vec<&Call> = calls
        .iter()
        .filter(|c| c.args.iter().any(|a| a == "add"))
        .collect();
    assert_eq!(adds.len(), 2);
    for c in &adds {
        let n: Vec<&str> = c.env.iter().map(|(k, _)| k.as_str()).collect();
        for k in [
            "GIT_INDEX_FILE",
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_OBJECT_DIRECTORY",
        ] {
            assert!(n.contains(&k), "{k} in {n:?}");
        }
        let work = c.env.iter().find(|(k, _)| k == "GIT_WORK_TREE").unwrap();
        assert_eq!(work.1, root);
    }
    let commit = calls
        .iter()
        .find(|c| c.args.iter().any(|a| a == "commit-tree"))
        .unwrap();
    let ident: Vec<(&str, &str)> = commit
        .env
        .iter()
        .filter(|(k, _)| k.contains("NAME") || k.contains("EMAIL"))
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    assert!(
        ident.contains(&("GIT_AUTHOR_NAME", "PLUR1BUS"))
            && ident.contains(&("GIT_COMMITTER_EMAIL", "checkpoint@plur1bus.invalid"))
    );
    assert!(commit
        .args
        .windows(2)
        .any(|p| p == ["-m", "PLUR1BUS turn checkpoint"]));
    let update = calls
        .iter()
        .find(|c| c.args.iter().any(|a| a == "update-ref"))
        .unwrap();
    let zero = update.args.last().unwrap();
    assert!(
        zero.bytes().all(|b| b == b'0') && zero.len() == 40,
        "the old value is all zeros: the ref is created once"
    );
    // The private Git directory is gone.
    let leftovers: Vec<_> = std::fs::read_dir(&w.repo.home)
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("p1b-checkpoint-")
        })
        .collect();
    assert!(
        leftovers.is_empty(),
        "the temporary index directory is removed"
    );
}

#[test]
fn a_failing_git_call_is_a_storage_error_with_the_exit_status_and_an_abort_is_not_wrapped() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    *w.fail.borrow_mut() = Some(Box::new(|a| {
        a.iter()
            .any(|x| x == "write-tree")
            .then_some(GitFailure::Exit { code: Some(3) })
    }));
    let begun = w
        .store
        .begin_turn(&w.session.id, "x", 1, &Default::default())
        .unwrap();
    let e = w
        .checkpoints
        .capture(
            &mut w.store,
            &w.session.id,
            &begun.turn.id,
            "owner",
            &Cancel::new(),
        )
        .unwrap_err();
    assert_eq!(e.session().unwrap().code.as_str(), "storage");
    assert_eq!(e.reason(), Some("rewind-checkpoint"));
    assert_eq!(e.session().unwrap().message, "checkpoint Git failed");
    assert_eq!(e.git_exit(), Some(3));
    assert_eq!(w.repo.refs(), "");
    assert!(
        !w.store.has_checkpoints().unwrap(),
        "no row without a ref intent"
    );
    let leftovers = std::fs::read_dir(&w.repo.home)
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("p1b-checkpoint-")
        })
        .count();
    assert_eq!(
        leftovers, 0,
        "the temporary directory goes even when Git fails"
    );
    // An abort during Git is the raw abort.
    let cancel = Cancel::new();
    cancel.abort(AbortReason::Caller);
    *w.fail.borrow_mut() = None;
    let e = w
        .checkpoints
        .capture(
            &mut w.store,
            &w.session.id,
            &begun.turn.id,
            "owner",
            &cancel,
        )
        .unwrap_err();
    assert!(
        matches!(e, RewindError::Aborted(AbortReason::Caller)),
        "{e:?}"
    );
}

// ---- retention ---------------------------------------------------------------------------------------------------------

fn pruned(w: &World) -> Vec<(String, String)> {
    w.audit
        .borrow()
        .iter()
        .filter(|e| e.action == "session.checkpoint.pruning")
        .map(|e| {
            let get = |k: &str| {
                e.detail
                    .iter()
                    .find(|(n, _)| n == k)
                    .map(|(_, v)| v.as_str().unwrap().to_owned())
                    .unwrap_or_default()
            };
            (
                get("turnId"),
                if get("reason").is_empty() {
                    get("result")
                } else {
                    get("reason")
                },
            )
        })
        .collect()
}

#[test]
fn turn_retention_prunes_the_oldest_checkpoint_at_the_boundary_and_keeps_the_newer_ones() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    w.turns.set(2.0);
    let t1 = w.turn();
    let t2 = w.turn();
    let t3 = w.turn();
    // Retention 2, latest turn seq 3: cutoff 1; the checkpoint of turn 1 (seq 1) goes, seq 2 stays.
    let t4 = w.turn(); // the prune before this capture ran with latest seq 3 (turn 4 not begun)
    let _ = (&t1, &t2, &t3, &t4);
    let refs = w.repo.refs();
    assert!(!refs.contains(&t1), "turn 1 is past the retention");
    assert!(
        !refs.contains(&t2),
        "turn 2 too: the cutoff is latest - turns"
    );
    assert!(refs.contains(&t3) && refs.contains(&t4));
    assert_eq!(
        pruned(&w),
        [
            (t1.clone(), "turn-retention".into()),
            (t2.clone(), "turn-retention".into())
        ]
    );
    assert!(w.store.checkpoint(&w.session.id, &t1).unwrap().is_none());
}

#[test]
fn an_out_of_range_or_fractional_retention_falls_back_to_fifty() {
    for bad in [0.0, 501.0, 1.5, f64::NAN, -3.0] {
        let Some(mut w) = World::new(SessionKind::Card) else {
            return;
        };
        w.turns.set(bad);
        w.turn();
        w.turn();
        w.turn();
        assert_eq!(pruned(&w), [], "retention {bad} behaves as 50");
    }
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    w.turns.set(1.0);
    w.turn();
    w.turn();
    assert_eq!(pruned(&w).len(), 1, "1 is allowed");
    w.turns.set(500.0);
    w.turn();
    assert_eq!(
        pruned(&w).len(),
        1,
        "500 is allowed and prunes nothing more"
    );
}

#[test]
fn archiving_a_session_releases_its_refs_and_rows_and_never_touches_the_transcript() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    let t = w.turn();
    let messages = w
        .store
        .list_messages(&w.session.id, &Default::default())
        .unwrap()
        .len();
    w.store.archive_session(&w.session.id).unwrap();
    w.checkpoints.idle(&mut w.store);
    assert_eq!(w.repo.refs(), "");
    assert!(!w.store.has_checkpoints().unwrap());
    assert_eq!(pruned(&w), [(t, "session-ended".into())]);
    assert_eq!(
        w.store
            .list_messages(&w.session.id, &Default::default())
            .unwrap()
            .len(),
        messages
    );
}

#[test]
fn a_restart_releases_refs_whose_transcript_was_erased_while_cleanup_was_stopped() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    w.turn();
    w.checkpoints.close(&mut w.store);
    w.store.archive_session(&w.session.id).unwrap();
    w.store
        .erase_session(&w.session.id, "owner", "explicit deletion")
        .unwrap();
    assert!(!w.repo.refs().is_empty(), "stopped cleanup leaves the ref");
    assert!(
        w.store.has_checkpoints().unwrap(),
        "the durable intent survives the erasure"
    );
    // A new lifecycle on the same store: its construction owes a sweep, and an erased session has no live binding.
    w.restart(true);
    w.checkpoints.idle(&mut w.store);
    assert_eq!(w.repo.refs(), "");
    assert!(!w.store.has_checkpoints().unwrap());
    assert!(w.store.get_session(&w.session.id).unwrap().is_none());
}

#[test]
fn an_ended_card_releases_its_checkpoints_at_the_next_sweep_and_only_then() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    let t = w.turn();
    assert!(
        w.checkpoints.retention().timer_at().is_some(),
        "a timer is armed while checkpoints exist"
    );
    w.clock.0.fetch_add(9_999, Ordering::SeqCst);
    assert!(!w.checkpoints.tick(&mut w.store), "not due before 10 s");
    w.ended.set(true);
    w.clock.0.fetch_add(1, Ordering::SeqCst);
    assert!(w.checkpoints.tick(&mut w.store), "due at exactly 10 s");
    assert_eq!(pruned(&w), [(t, "card-ended".into())]);
    assert_eq!(w.repo.refs(), "");
    assert_eq!(
        w.checkpoints.retention().timer_at(),
        None,
        "no timer once the last intent is gone"
    );
    let n = w.audit.borrow().len();
    w.clock.0.fetch_add(60_000, Ordering::SeqCst);
    assert!(!w.checkpoints.tick(&mut w.store));
    assert_eq!(
        w.audit.borrow().len(),
        n,
        "no further maintenance after the last intent is gone"
    );
}

#[test]
fn a_pending_restore_does_not_block_the_sweep_and_an_ended_card_aborts_it_and_is_then_pruned() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    let t = w.turn();
    w.repo.write("tracked.txt", "changed\n");
    let (ended, clock, checks) = (w.ended.clone(), w.clock.clone(), w.ended_checks.clone());
    let cp = w.checkpoints.clone();
    let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let seen2 = seen.clone();
    // While the approval waits, the host's timer ticks; the second tick finds the card ended.
    *w.hook.borrow_mut() = Some(Box::new(move |store, cancel| {
        let before = checks.get();
        clock.0.fetch_add(10_000, Ordering::SeqCst);
        cp.tick(store);
        seen2.borrow_mut().push(checks.get() > before);
        assert!(!cancel.is_aborted());
        ended.set(true);
        let before = checks.get();
        clock.0.fetch_add(10_000, Ordering::SeqCst);
        cp.tick(store);
        seen2.borrow_mut().push(checks.get() > before);
        cancel.throw_if_aborted().err()
    }));
    let r = restore(&mut w, &t);
    assert_eq!(
        *seen.borrow(),
        [true, true],
        "maintenance keeps checking while the session awaits its approval"
    );
    assert_eq!(reason(r), "rewind-checkpoint-unavailable");
    assert_eq!(
        w.repo.read("tracked.txt").as_deref(),
        Some("changed\n"),
        "nothing was restored"
    );
    assert_eq!(w.begun.get(), 0);
    w.checkpoints.idle(&mut w.store);
    assert_eq!(w.repo.refs(), "");
    assert!(!w.store.has_checkpoints().unwrap());
    assert_eq!(
        w.store
            .list_messages(&w.session.id, &Default::default())
            .unwrap()
            .len(),
        2,
        "the transcript is untouched"
    );
    assert_eq!(pruned(&w), [(t, "card-ended".into())]);
}

#[test]
fn a_missing_linked_checkout_releases_only_its_own_refs_and_the_stale_registration() {
    for missing in ["directory", "git-metadata"] {
        let linked = std::cell::RefCell::new(String::new());
        let Some(mut w) = World::new_with(SessionKind::Card, |repo| {
            let dir = std::fs::canonicalize(repo.dir.path())
                .unwrap()
                .join("linked checkout");
            repo.git(&[
                "worktree",
                "add",
                "--quiet",
                "--detach",
                &dir.to_string_lossy(),
                "HEAD",
            ]);
            let dir = std::fs::canonicalize(dir)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            *linked.borrow_mut() = dir.clone();
            dir
        }) else {
            return;
        };
        let linked = linked.into_inner();
        let tracked = format!("{linked}/tracked.txt");
        let before = std::fs::read(&tracked).unwrap();
        let t = w.turn();
        let row = w.store.checkpoint(&w.session.id, &t).unwrap().unwrap();
        if missing == "directory" {
            std::fs::remove_dir_all(&linked).unwrap();
        } else {
            let _ = std::fs::remove_dir_all(format!("{linked}/.git"))
                .or_else(|_| std::fs::remove_file(format!("{linked}/.git")));
        }
        w.store.archive_session(&w.session.id).unwrap();
        w.checkpoints.idle(&mut w.store);
        assert!(
            !w.store.has_checkpoints().unwrap(),
            "missing roots cannot retain cleanup intents forever ({missing})"
        );
        assert_eq!(
            w.repo
                .git(&["for-each-ref", "--format=%(refname)", &row.ref_name])
                .trim(),
            ""
        );
        assert!(
            !w.repo
                .git(&["worktree", "list", "--porcelain"])
                .contains(&linked),
            "the stale linked entry was pruned"
        );
        if missing == "git-metadata" {
            assert_eq!(
                std::fs::read(&tracked).unwrap(),
                before,
                "cleanup never removes checkout contents"
            );
        }
        let result = if missing == "directory" {
            "root-missing"
        } else {
            "root-not-repository"
        };
        assert!(
            pruned(&w).iter().any(|(_, r)| r == result),
            "{:?}",
            pruned(&w)
        );
        let n = w.audit.borrow().len();
        for _ in 0..6 {
            w.clock.0.fetch_add(10_000, Ordering::SeqCst);
            w.checkpoints.tick(&mut w.store);
        }
        assert_eq!(
            w.audit.borrow().len(),
            n,
            "no further maintenance runs after the last intent is gone"
        );
        assert!(w.warnings.get() <= 1);
    }
}

#[test]
fn a_foreign_ref_stays_untouched_and_cleanup_warns_once_across_repeated_sweeps() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    let t = w.turn();
    let row = w.store.checkpoint(&w.session.id, &t).unwrap().unwrap();
    let foreign = w.repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    w.repo.git(&["update-ref", &row.ref_name, &foreign]);
    w.store.archive_session(&w.session.id).unwrap();
    w.checkpoints.idle(&mut w.store);
    for _ in 0..6 {
        w.clock.0.fetch_add(10_000, Ordering::SeqCst);
        w.checkpoints.tick(&mut w.store);
    }
    assert!(
        w.store.has_checkpoints().unwrap(),
        "a conflict remains discoverable"
    );
    assert_eq!(w.repo.git(&["rev-parse", &row.ref_name]).trim(), foreign);
    assert_eq!(w.warnings.get(), 1, "one warning for one stuck checkpoint");
}

#[test]
fn a_cleanup_that_finds_the_ref_already_gone_still_forgets_the_row() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    let t = w.turn();
    let row = w.store.checkpoint(&w.session.id, &t).unwrap().unwrap();
    w.repo.git(&["update-ref", "-d", &row.ref_name]);
    w.store.archive_session(&w.session.id).unwrap();
    w.checkpoints.idle(&mut w.store);
    assert!(
        !w.store.has_checkpoints().unwrap(),
        "interrupted publication or an earlier completed cleanup"
    );
}

#[test]
fn the_cleanup_identity_is_checked_before_anything_runs() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    let branches = w.repo.git(&["for-each-ref", "refs/heads"]);
    let begun = w
        .store
        .begin_turn(&w.session.id, "x", 1, &Default::default())
        .unwrap();
    // A row whose ref was rewritten in the database to a branch: cleanup must refuse it and delete nothing.
    w.store
        .record_checkpoint(&super::StoredCheckpoint {
            session_id: w.session.id.clone(),
            turn_id: begun.turn.id.clone(),
            project_id: "p".into(),
            card_id: "c".into(),
            root: w.repo.root.clone(),
            common_git_dir: format!("{}/.git", w.repo.root),
            ref_name: "refs/heads/some-branch".into(),
            tree: "a".repeat(40),
            commit_id: "b".repeat(40),
        })
        .unwrap();
    w.store
        .complete_turn(&begun.turn.id, "done", 1, None)
        .unwrap();
    w.store.archive_session(&w.session.id).unwrap();
    w.checkpoints.idle(&mut w.store);
    assert!(
        w.store.has_checkpoints().unwrap(),
        "a row that fails its identity check stays discoverable"
    );
    assert_eq!(w.warnings.get(), 1);
    assert_eq!(
        w.repo.git(&["for-each-ref", "refs/heads"]),
        branches,
        "no branch was touched"
    );
}

#[test]
fn a_retention_of_exactly_500_is_honoured_and_keeps_old_checkpoints() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    w.turns.set(500.0);
    for _ in 0..53 {
        w.turn();
    }
    // With the fallback of 50 the first three would be gone.
    assert_eq!(pruned(&w), [], "500 is inside 1..=500");
}

#[test]
fn a_directory_where_the_checkpoint_has_a_file_is_never_written_over() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    w.repo.write("d", "a file at the checkpoint\n");
    w.repo.commit_all();
    let turn = w.turn();
    w.repo.git(&["rm", "-q", "--cached", "d"]);
    std::fs::remove_file(format!("{}/d", w.repo.root)).unwrap();
    w.repo.write("d/inner.txt", "a directory now\n");
    assert_eq!(reason(restore(&mut w, &turn)), "rewind-files-changed");
    assert_eq!(
        w.repo.read("d/inner.txt").as_deref(),
        Some("a directory now\n")
    );
}

#[test]
fn a_tracked_file_removed_from_disk_and_index_after_the_checkpoint_comes_back() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    w.repo.write("gone.txt", "was here\n");
    w.repo.commit_all();
    let turn = w.turn();
    w.repo.git(&["rm", "-q", "gone.txt"]);
    assert!(w.repo.read("gone.txt").is_none());
    restore(&mut w, &turn).unwrap();
    assert_eq!(w.repo.read("gone.txt").as_deref(), Some("was here\n"));
}

/// 201 or 200 changed paths against a bound of 200; short names so the text bound is not the one that applies.
#[test]
fn the_preview_bound_is_200_paths_inclusive() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    for i in 0..201 {
        w.repo.write(&format!("a{i}"), "one\n");
    }
    w.repo.commit_all();
    let turn = w.turn();
    for i in 0..201 {
        w.repo.write(&format!("a{i}"), "two\n");
    }
    assert_eq!(
        reason(restore(&mut w, &turn)),
        "rewind-files-preview-limit",
        "201 paths"
    );
    w.repo.write("a0", "one\n");
    restore(&mut w, &turn).unwrap();
    assert_eq!(w.repo.read("a5").as_deref(), Some("one\n"));
}

/// The preview text may be 4096 UTF-16 units and not one more. The size is calibrated from a first run, so the test does not
/// depend on the wording.
#[test]
fn the_preview_text_bound_is_4096_units_inclusive() {
    fn attempt(pad: usize) -> (String, usize) {
        let mut w = World::new(SessionKind::Card).expect("git");
        let name = |i: usize| {
            let extra = if i == 0 {
                "p".repeat(pad)
            } else {
                String::new()
            };
            format!("n{i:02}{}{extra}", "x".repeat(117))
        };
        for i in 0..30 {
            w.repo.write(&name(i), "one\n");
        }
        w.repo.commit_all();
        let turn = w.turn();
        for i in 0..30 {
            w.repo.write(&name(i), "two\n");
        }
        w.answer.set(Answer::Deny);
        let r = reason(restore(&mut w, &turn));
        let len = w.asks.borrow().first().map_or(0, |a| a.diff.len());
        (r, len)
    }
    if !have_git() {
        return;
    }
    let (_, base) = attempt(0);
    assert!(
        base > 0 && base < 4096,
        "the calibration run shows a preview: {base}"
    );
    let (at, len_at) = attempt(4096 - base);
    assert_eq!((at.as_str(), len_at), ("rewind-files-not-approved", 4096));
    let (over, _) = attempt(4096 - base + 1);
    assert_eq!(over, "rewind-files-preview-limit");
}

#[test]
fn a_listed_path_outside_the_project_or_under_dot_git_is_refused_before_anything_is_written() {
    for evil in [
        "../outside.txt",
        "a/../b.txt",
        ".git/config",
        "sub/.GIT/hooks/x",
        "/etc/passwd",
        "a//b.txt",
        "./x",
    ] {
        let Some(mut w) = World::new(SessionKind::Card) else {
            return;
        };
        let turn = w.turn();
        w.repo.write("tracked.txt", "failed edit\n");
        let text = format!("{evil}\0");
        *w.tamper.borrow_mut() = Some(Box::new(move |args| {
            args.iter().any(|a| a == "ls-tree").then(|| text.clone())
        }));
        assert_eq!(
            reason(restore(&mut w, &turn)),
            "rewind-files-changed",
            "{evil}"
        );
        assert_eq!(
            w.repo.read("tracked.txt").as_deref(),
            Some("failed edit\n"),
            "{evil}: nothing was written"
        );
        assert!(w.asks.borrow().is_empty(), "{evil}: no human was asked");
    }
}

#[test]
fn an_index_changed_after_the_approval_stops_the_restore_before_it_writes() {
    let Some(mut w) = World::new(SessionKind::Card) else {
        return;
    };
    let turn = w.turn();
    w.repo.write("tracked.txt", "failed edit\n");
    let (begun, root, home) = (w.begun.clone(), w.repo.root.clone(), w.repo.home.clone());
    *w.fail.borrow_mut() = Some(Box::new(move |args| {
        // The private index of the approved write is made right after the approval was consumed.
        if begun.get() == 1 && args.iter().any(|a| a == "--git-path") {
            std::fs::write(format!("{root}/late.txt"), "late\n").unwrap();
            let status = std::process::Command::new("git")
                .args(["add", "late.txt"])
                .current_dir(&root)
                .env_clear()
                .envs(isolated_env(&home))
                .status()
                .unwrap();
            assert!(status.success());
        }
        None
    }));
    assert_eq!(reason(restore(&mut w, &turn)), "rewind-files-changed");
    assert_eq!(
        w.repo.read("tracked.txt").as_deref(),
        Some("failed edit\n"),
        "the files were not written"
    );
}
