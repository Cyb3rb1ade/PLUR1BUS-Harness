//! Native capture journals over real files: authority, replay and interrupted publication.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    capture::shared_scope::CapturePolicy,
    context::{harness_user_principal, RequestContext},
    contract::{Cancel, EngineError, TurnRecord},
    neo::{episode_store::EpisodeStore, merged::Layout, session_store::SessionStore},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[path = "support/neo_episode.rs"]
mod fixtures;
use fixtures::*;
#[test]
fn continuation_commits_episodes_and_session_state_together() {
    let mut f = setup();
    let all = f.turn.messages.clone();
    f.turn.messages.truncate(3);
    assert_eq!(
        f.journal
            .process(&f.turn, &f.context, &Cancel::never())
            .unwrap(),
        1
    );
    let first = rows(&f.directory, "episodes.jsonl");
    f.host.time.fetch_add(60_000, Ordering::SeqCst);
    f.turn.messages = all;
    assert_eq!(
        f.journal
            .process(&f.turn, &f.context, &Cancel::never())
            .unwrap(),
        1
    );
    let episodes = rows(&f.directory, "episodes.jsonl");
    assert_eq!(episodes.len(), 2);
    assert_eq!(episodes[1]["id"], first[0]["id"]);
    assert_eq!(episodes[1]["revision"], 1);
    assert_eq!(episodes[1]["memoryIds"].as_array().unwrap().len(), 5);
    let turns = rows(&f.directory, "turn-journal.jsonl");
    for id in episodes[1]["memoryIds"].as_array().unwrap() {
        assert!(turns.iter().any(|row| &row["id"] == id));
    }
    assert_eq!(episodes[1]["ownerUserId"], f.context.owner_user_id);
    assert_eq!(episodes[1]["visibility"]["scope"], "agent_private");
    assert_eq!(
        f.journal
            .process(&f.turn, &f.context, &Cancel::never())
            .unwrap(),
        0
    );
    assert_eq!(rows(&f.directory, "episodes.jsonl"), episodes);
    let checkpoint = SessionStore::open(f.root.path(), f.host.clone()).unwrap();
    assert_eq!(
        checkpoint
            .read(
                &f.turn.principal,
                &f.turn.agent,
                &plur1bus_engine::text::js::JsString::from("stable-session"),
                &Cancel::never()
            )
            .unwrap()
            .count,
        5.
    );
}
#[test]
fn interrupted_episode_publication_does_not_advance_and_recovers_once() {
    let f = setup();
    f.policy.stop_after_first.store(true, Ordering::SeqCst);
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    assert_eq!(rows(&f.directory, "episodes.jsonl").len(), 1);
    let checkpoint = SessionStore::open(f.root.path(), f.host.clone()).unwrap();
    let key = plur1bus_engine::text::js::JsString::from("stable-session");
    assert_eq!(
        checkpoint
            .read(&f.turn.principal, &f.turn.agent, &key, &Cancel::never())
            .unwrap()
            .count,
        0.
    );
    f.policy.stop_after_first.store(false, Ordering::SeqCst);
    f.policy.allowed.store(true, Ordering::SeqCst);
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    assert_eq!(rows(&f.directory, "episodes.jsonl").len(), 1);
    assert_eq!(
        checkpoint
            .read(&f.turn.principal, &f.turn.agent, &key, &Cancel::never())
            .unwrap()
            .count,
        5.
    );
}
#[test]
fn separate_sessions_never_continue_each_others_episode() {
    let mut f = setup();
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    f.turn.session_key = Some("another-session".into());
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    let episodes = rows(&f.directory, "episodes.jsonl");
    assert_eq!(episodes.len(), 2);
    assert_ne!(episodes[0]["id"], episodes[1]["id"]);
    assert!(!episodes[1]["continued"].as_bool().unwrap_or(false));
}
#[test]
fn changed_source_after_interruption_cannot_be_acknowledged() {
    let f = setup();
    f.policy.stop_after_first.store(true, Ordering::SeqCst);
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    let checkpoint = native_file(&f.directory, "native-episode-pending-");
    let pending = fs::read(&checkpoint).unwrap();
    let mut source = rows(&f.directory, "turn-journal.jsonl");
    source[0]["content"] = json!("changed after planning");
    fs::write(
        f.directory.join("turn-journal.jsonl"),
        source.iter().map(|r| format!("{r}\n")).collect::<String>(),
    )
    .unwrap();
    f.policy.stop_after_first.store(false, Ordering::SeqCst);
    f.policy.allowed.store(true, Ordering::SeqCst);
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    assert_eq!(fs::read(checkpoint).unwrap(), pending);
    let state = SessionStore::open(f.root.path(), f.host).unwrap();
    assert_eq!(
        state
            .read(
                &f.turn.principal,
                &f.turn.agent,
                &plur1bus_engine::text::js::JsString::from("stable-session"),
                &Cancel::never()
            )
            .unwrap()
            .count,
        0.
    );
}
#[test]
fn repeated_content_ids_match_full_journal_and_incognito_writes_nothing() {
    let mut f = setup();
    f.turn.incognito = true;
    assert_eq!(
        f.journal
            .process(&f.turn, &f.context, &Cancel::never())
            .unwrap(),
        0
    );
    assert!(!f.directory.exists());
    f.turn.incognito = false;
    let message = f.turn.messages[0].clone();
    f.turn.messages = vec![message.clone()];
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    f.turn.messages = vec![message.clone(), message.clone(), message];
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    let episodes = rows(&f.directory, "episodes.jsonl");
    let turns = rows(&f.directory, "turn-journal.jsonl");
    assert_eq!(
        episodes[1]["memoryIds"],
        json!(turns.iter().map(|r| &r["id"]).collect::<Vec<_>>())
    );
    assert_eq!(turns.len(), 3);
    assert_ne!(turns[0]["id"], turns[2]["id"]);
}
#[test]
fn concurrent_writers_and_checkpoint_cas_do_not_duplicate_or_skip_episodes() {
    let f = setup();
    std::thread::scope(|scope| {
        let threads: Vec<_> = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    f.journal
                        .process(&f.turn, &f.context, &Cancel::never())
                        .unwrap()
                })
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .map(|t| t.join().unwrap())
                .sum::<usize>(),
            1
        );
    });
    assert_eq!(rows(&f.directory, "episodes.jsonl").len(), 1);
    let before = fs::read(native_file(&f.directory, "native-hook-state-")).unwrap();
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    assert_eq!(
        before,
        fs::read(native_file(&f.directory, "native-hook-state-")).unwrap()
    );
}
#[test]
fn a_different_principal_never_inherits_or_continues_an_episode() {
    let mut f = setup();
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    f.turn = turn(f.root.path(), "two");
    f.context = RequestContext::build(&f.turn.principal, &f.turn.agent, f.host.as_ref()).unwrap();
    // Stable turn IDs collide in this shared physical workspace. Foreign sources are refused.
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    assert_eq!(rows(&f.directory, "episodes.jsonl").len(), 1);
}
#[cfg(unix)]
#[test]
fn episode_child_fixture() {
    use std::io::{Read, Write};
    let Some(root) = std::env::var_os("PLUR1BUS_EPISODE_CRASH_FIXTURE") else {
        return;
    };
    let root = PathBuf::from(root);
    let after_checkpoint = std::env::var_os("PLUR1BUS_EPISODE_AFTER_CHECKPOINT").is_some();
    struct Pause {
        directory: PathBuf,
        after_checkpoint: bool,
    }
    impl CapturePolicy for Pause {
        fn allowed(&self, _: &RequestContext) -> Result<bool, EngineError> {
            let episode =
                fs::metadata(self.directory.join("episodes.jsonl")).is_ok_and(|m| m.len() > 0);
            let checkpoint = fs::read_dir(&self.directory).is_ok_and(|mut entries| {
                entries.any(|e| {
                    e.unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with("native-hook-state-")
                })
            });
            if episode && (!self.after_checkpoint || checkpoint) {
                println!("EPISODE_CRASH_BOUNDARY");
                std::io::stdout().flush().unwrap();
                let _ = std::io::stdin().read(&mut [0]);
            }
            Ok(true)
        }
    }
    let host = Arc::new(support::TestHost::new(root.join("state")));
    host.set_workspace("alpha", root.clone());
    host.time.store(1_794_139_200_000, Ordering::SeqCst);
    let t = turn(&root, "one");
    let ctx = RequestContext::build(&t.principal, &t.agent, host.as_ref()).unwrap();
    let directory = root
        .join("workspaces")
        .join(Layout::for_key(&ctx.workspace_key).canonical);
    let policy = Arc::new(Pause {
        directory,
        after_checkpoint,
    });
    let mood = Arc::new(plur1bus_engine::capture::emotion_pool::EmotionalPool::new(
        host.clone(),
        json!({}),
    ));
    EpisodeStore::open(&root, host, policy, mood)
        .unwrap()
        .process(&t, &ctx, &Cancel::never())
        .unwrap();
}
#[cfg(unix)]
#[test]
fn sigkill_before_and_after_checkpoint_recovers_without_new_revision() {
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    for after_checkpoint in [false, true] {
        let f = setup();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                std::any::type_name_of_val(&episode_child_fixture)
                    .split_once("::")
                    .map_or("", |(_, name)| name),
                "--nocapture",
            ])
            .env("PLUR1BUS_EPISODE_CRASH_FIXTURE", f.root.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        if after_checkpoint {
            command.env("PLUR1BUS_EPISODE_AFTER_CHECKPOINT", "1");
        }
        let mut child = command.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if line.unwrap().contains("EPISODE_CRASH_BOUNDARY") {
                    let _ = tx.send(());
                    break;
                }
            }
        });
        let ready = rx.recv_timeout(Duration::from_secs(20));
        child.kill().unwrap();
        assert!(!child.wait().unwrap().success());
        reader.join().unwrap();
        ready.unwrap();
        let original = fs::read(f.directory.join("episodes.jsonl")).unwrap();
        let checkpoint = SessionStore::open(f.root.path(), f.host.clone()).unwrap();
        let key = plur1bus_engine::text::js::JsString::from("stable-session");
        assert_eq!(
            checkpoint
                .read(&f.turn.principal, &f.turn.agent, &key, &Cancel::never())
                .unwrap()
                .count,
            if after_checkpoint { 5. } else { 0. }
        );
        let deadline = Cancel::with_deadline(Instant::now() + Duration::from_secs(5));
        f.journal.process(&f.turn, &f.context, &deadline).unwrap();
        assert_eq!(
            fs::read(f.directory.join("episodes.jsonl")).unwrap(),
            original
        );
        assert_eq!(
            checkpoint
                .read(&f.turn.principal, &f.turn.agent, &key, &Cancel::never())
                .unwrap()
                .count,
            5.
        );
        let pending: Value = serde_json::from_slice(
            &fs::read(native_file(&f.directory, "native-episode-pending-")).unwrap(),
        )
        .unwrap();
        assert!(pending["plan"].is_null());
    }
}
