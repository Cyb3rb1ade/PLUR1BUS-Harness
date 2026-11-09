//! Native capture journals over real files: authority, replay and interrupted publication.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    capture::shared_scope::CapturePolicy,
    context::{harness_user_principal, RequestContext},
    contract::{Cancel, EngineError, TurnRecord},
    neo::{
        capture_journal::CaptureJournal,
        merged::{Layout, MetadataReader, RecordKind},
    },
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

struct Policy {
    allowed: AtomicBool,
    stop_after_first: AtomicBool,
    journal: PathBuf,
}
impl CapturePolicy for Policy {
    fn allowed(&self, _: &RequestContext) -> Result<bool, EngineError> {
        if self.stop_after_first.load(Ordering::SeqCst)
            && fs::metadata(&self.journal).is_ok_and(|m| m.len() > 0)
        {
            self.allowed.store(false, Ordering::SeqCst);
        }
        Ok(self.allowed.load(Ordering::SeqCst))
    }
}
fn turn(root: &Path, user: &str) -> TurnRecord {
    serde_json::from_value(json!({
        "agentId":"alpha",
        "principal":{"agentId":"alpha","workspace":format!("workspace-dir:v1:{}",root.display()),
            "user":harness_user_principal(user),"channel":"telegram","accountId":"fixture",
            "chat":{"id":"fixture","kind":"direct"},"trust":"proved"},
        "agent":{"origin":"user","background":false},"runId":"run-one","sessionKey":"stable-session",
        "incognito":false,"messages":[
            {"role":"user","content":"Architecture decision chosen"},
            {"role":"assistant","content":"I will plan the implementation"},
            {"role":"user","content":"yes exactly"},
            {"role":"assistant","content":"maybe we could use a queue"},
            {"role":"user","content":"never leak workspace data"}
        ]
    })).unwrap()
}
struct Fixture {
    root: tempfile::TempDir,
    host: Arc<support::TestHost>,
    policy: Arc<Policy>,
    journal: CaptureJournal,
    turn: TurnRecord,
    context: RequestContext,
    directory: PathBuf,
}
fn setup() -> Fixture {
    setup_config(json!({}))
}
fn setup_config(config: Value) -> Fixture {
    let root = support::canonical_tempdir();
    let host = Arc::new(
        support::TestHost::new(root.path().join("state"))
            .with_config(serde_json::from_value(config).unwrap()),
    );
    host.set_workspace("alpha", root.path().into());
    host.time.store(1_794_139_200_000, Ordering::SeqCst);
    let turn = turn(root.path(), "one");
    let context = RequestContext::build(&turn.principal, &turn.agent, host.as_ref()).unwrap();
    let directory = root
        .path()
        .join("workspaces")
        .join(Layout::for_key(&context.workspace_key).canonical);
    let policy = Arc::new(Policy {
        allowed: AtomicBool::new(true),
        stop_after_first: AtomicBool::new(false),
        journal: directory.join("turn-journal.jsonl"),
    });
    let journal = CaptureJournal::open(root.path(), host.clone(), policy.clone()).unwrap();
    Fixture {
        root,
        host,
        policy,
        journal,
        turn,
        context,
        directory,
    }
}
#[path = "support/neo_capture_cap.rs"]
mod cap_tests;
fn rows(directory: &Path, file: &str) -> Vec<Value> {
    fs::read_to_string(directory.join(file))
        .unwrap()
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
#[test]
fn five_turns_are_durable_private_and_replay_does_not_duplicate_any_journal() {
    let f = setup();
    let result = f
        .journal
        .record(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    assert_eq!(
        (
            result.turns,
            result.candidates,
            result.reactions,
            result.behavior,
            result.queued
        ),
        (5, 5, 2, 2, 12)
    );
    let files = [
        "turn-journal.jsonl",
        "memory-candidates.jsonl",
        "reaction-ledger.jsonl",
        "behavior-cards.jsonl",
        "embedding-queue.jsonl",
        "candidate-index.jsonl",
    ];
    let before: Vec<_> = files
        .iter()
        .map(|name| fs::read(f.directory.join(name)).unwrap())
        .collect();
    for file in files {
        for row in rows(&f.directory, file) {
            assert_eq!(row["agentId"], "alpha");
            assert_eq!(row["ownerUserId"], f.context.owner_user_id);
            assert_eq!(row["visibility"]["scope"], "agent_private");
            assert_eq!(
                row["visibility"]["workspaceIdentity"],
                f.context.workspace_key
            );
        }
    }
    let reopened = CaptureJournal::open(f.root.path(), f.host.clone(), f.policy.clone()).unwrap();
    let replay = reopened
        .record(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    assert_eq!(
        (
            replay.turns,
            replay.candidates,
            replay.reactions,
            replay.behavior,
            replay.queued
        ),
        (0, 0, 0, 0, 0)
    );
    assert_eq!(
        before,
        files
            .iter()
            .map(|name| fs::read(f.directory.join(name)).unwrap())
            .collect::<Vec<_>>()
    );
    let reader = MetadataReader::open(f.root.path(), &f.context.workspace_key).unwrap();
    assert_eq!(
        reader
            .read_metadata(RecordKind::Candidates, 20, &f.context)
            .unwrap()
            .len(),
        5
    );
    let other = turn(f.root.path(), "two");
    let context = RequestContext::build(&other.principal, &other.agent, f.host.as_ref()).unwrap();
    assert!(reader
        .read_metadata(RecordKind::Candidates, 20, &context)
        .unwrap()
        .is_empty());
}
#[test]
fn incognito_cancelled_and_disabled_capture_create_no_persistent_state() {
    let mut f = setup();
    f.turn.incognito = true;
    f.journal
        .record(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    assert_eq!(fs::read_dir(f.root.path()).unwrap().count(), 0);
    f.turn.incognito = false;
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(f.journal.record(&f.turn, &f.context, &cancel).is_err());
    assert_eq!(fs::read_dir(f.root.path()).unwrap().count(), 0);
    f.policy.allowed.store(false, Ordering::SeqCst);
    assert!(f
        .journal
        .record(&f.turn, &f.context, &Cancel::never())
        .is_err());
    assert_eq!(fs::read_dir(f.root.path()).unwrap().count(), 0);
}
#[test]
fn interrupted_plan_resumes_frozen_records_once_after_policy_is_restored() {
    let f = setup();
    f.policy.stop_after_first.store(true, Ordering::SeqCst);
    assert!(f
        .journal
        .record(&f.turn, &f.context, &Cancel::never())
        .is_err());
    let initial = rows(&f.directory, "turn-journal.jsonl");
    assert_eq!(initial.len(), 1);
    assert!(f
        .journal
        .recover(&f.turn.principal, &f.turn.agent, &Cancel::never())
        .is_err());
    f.policy.stop_after_first.store(false, Ordering::SeqCst);
    f.policy.allowed.store(true, Ordering::SeqCst);
    f.host.time.fetch_add(60_000, Ordering::SeqCst);
    let reopened = CaptureJournal::open(f.root.path(), f.host.clone(), f.policy.clone()).unwrap();
    assert!(
        reopened
            .recover(&f.turn.principal, &f.turn.agent, &Cancel::never())
            .unwrap()
            > 0
    );
    let turns = rows(&f.directory, "turn-journal.jsonl");
    assert_eq!(turns.len(), 5);
    assert!(turns
        .iter()
        .all(|row| row["createdAt"] == initial[0]["createdAt"]));
    assert_eq!(
        reopened
            .recover(&f.turn.principal, &f.turn.agent, &Cancel::never())
            .unwrap(),
        0
    );
    let replay = reopened
        .record(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    assert_eq!((replay.turns, replay.candidates, replay.queued), (0, 0, 0));
}
#[test]
fn another_owner_or_changed_host_binding_cannot_reuse_existing_identities() {
    let f = setup();
    f.journal
        .record(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    let before = fs::read(f.directory.join("turn-journal.jsonl")).unwrap();
    let other = turn(f.root.path(), "two");
    let other_context =
        RequestContext::build(&other.principal, &other.agent, f.host.as_ref()).unwrap();
    assert!(f
        .journal
        .record(&other, &other_context, &Cancel::never())
        .is_err());
    assert!(f
        .journal
        .record(&f.turn, &other_context, &Cancel::never())
        .is_err());
    assert_eq!(
        fs::read(f.directory.join("turn-journal.jsonl")).unwrap(),
        before
    );
    let new_workspace = support::canonical_tempdir();
    f.host.set_workspace("alpha", new_workspace.path().into());
    assert!(f
        .journal
        .record(&f.turn, &f.context, &Cancel::never())
        .is_err());
    assert_eq!(
        fs::read(f.directory.join("turn-journal.jsonl")).unwrap(),
        before
    );
}

fn pending(directory: &Path) -> PathBuf {
    fs::read_dir(directory)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("native-capture-pending-")
        })
        .unwrap()
}
#[test]
fn torn_final_line_is_replaced_but_complete_corruption_is_refused() {
    use std::io::Write;
    let f = setup();
    f.policy.stop_after_first.store(true, Ordering::SeqCst);
    assert!(f
        .journal
        .record(&f.turn, &f.context, &Cancel::never())
        .is_err());
    let file = f.directory.join("turn-journal.jsonl");
    fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .unwrap()
        .write_all(b"{\"id\":\"turn-partial")
        .unwrap();
    f.policy.stop_after_first.store(false, Ordering::SeqCst);
    f.policy.allowed.store(true, Ordering::SeqCst);
    f.journal
        .recover(&f.turn.principal, &f.turn.agent, &Cancel::never())
        .unwrap();
    assert_eq!(rows(&f.directory, "turn-journal.jsonl").len(), 5);
    fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .unwrap()
        .write_all(b"{broken}\n")
        .unwrap();
    let before = fs::read(&file).unwrap();
    assert!(f
        .journal
        .record(&f.turn, &f.context, &Cancel::never())
        .is_err());
    assert_eq!(before, fs::read(&file).unwrap());
}
#[test]
fn corrupt_or_foreign_pending_plan_cannot_append_records() {
    let f = setup();
    f.policy.stop_after_first.store(true, Ordering::SeqCst);
    assert!(f
        .journal
        .record(&f.turn, &f.context, &Cancel::never())
        .is_err());
    f.policy.stop_after_first.store(false, Ordering::SeqCst);
    f.policy.allowed.store(true, Ordering::SeqCst);
    let path = pending(&f.directory);
    let original = fs::read(&path).unwrap();
    let journal = fs::read(f.directory.join("turn-journal.jsonl")).unwrap();
    for mode in ["owner", "row", "invalid"] {
        let mut value: Value = serde_json::from_slice(&original).unwrap();
        match mode {
            "owner" => value["ownership"]["ownerUserId"] = json!(harness_user_principal("two")),
            "row" => value["records"][4][0]["ownerUserId"] = json!(harness_user_principal("two")),
            _ => value = Value::Null,
        }
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(f
            .journal
            .recover(&f.turn.principal, &f.turn.agent, &Cancel::never())
            .is_err());
        assert_eq!(
            journal,
            fs::read(f.directory.join("turn-journal.jsonl")).unwrap()
        );
    }
    fs::write(&path, original).unwrap();
    assert!(
        f.journal
            .recover(&f.turn.principal, &f.turn.agent, &Cancel::never())
            .unwrap()
            > 0
    );
}
#[test]
fn competing_writers_commit_once_and_waiting_is_cancellable() {
    use std::time::{Duration, Instant};
    let f = setup();
    std::thread::scope(|scope| {
        let mut workers = Vec::new();
        for _ in 0..4 {
            workers.push(scope.spawn(|| {
                f.journal
                    .record(&f.turn, &f.context, &Cancel::never())
                    .unwrap()
            }));
        }
        assert_eq!(
            workers
                .into_iter()
                .map(|w| w.join().unwrap().turns)
                .sum::<usize>(),
            5
        );
    });
    let lease = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(f.directory.join(".native-capture-leases/workspace.lock"))
        .unwrap();
    lease.lock().unwrap();
    let before = fs::read(pending(&f.directory)).unwrap();
    let cancel = Cancel::with_deadline(Instant::now() + Duration::from_millis(50));
    assert!(f.journal.record(&f.turn, &f.context, &cancel).is_err());
    assert_eq!(before, fs::read(pending(&f.directory)).unwrap());
}
#[test]
fn restored_same_path_requires_explicit_pending_plan_rebinding() {
    let parent = support::canonical_tempdir();
    let path = parent.path().join("neo");
    fs::create_dir(&path).unwrap();
    let host = Arc::new(support::TestHost::new(parent.path().join("state")));
    host.set_workspace("alpha", path.clone());
    let t = turn(&path, "one");
    let ctx = RequestContext::build(&t.principal, &t.agent, host.as_ref()).unwrap();
    let directory = path
        .join("workspaces")
        .join(Layout::for_key(&ctx.workspace_key).canonical);
    let policy = Arc::new(Policy {
        allowed: AtomicBool::new(true),
        stop_after_first: AtomicBool::new(true),
        journal: directory.join("turn-journal.jsonl"),
    });
    let writer = CaptureJournal::open(&path, host.clone(), policy.clone()).unwrap();
    assert!(writer.record(&t, &ctx, &Cancel::never()).is_err());
    policy.stop_after_first.store(false, Ordering::SeqCst);
    policy.allowed.store(true, Ordering::SeqCst);
    let moved = parent.path().join("old");
    fs::rename(&path, &moved).unwrap();
    fs::create_dir(&path).unwrap();
    fs::rename(moved.join("workspaces"), path.join("workspaces")).unwrap();
    assert!(writer
        .recover(&t.principal, &t.agent, &Cancel::never())
        .is_err());
    let reopened = CaptureJournal::open(&path, host, policy).unwrap();
    assert!(reopened
        .recover(&t.principal, &t.agent, &Cancel::never())
        .is_err());
    assert_eq!(rows(&directory, "turn-journal.jsonl").len(), 1);
}
#[cfg(unix)]
#[test]
fn capture_child_fixture() {
    use std::io::{Read, Write};
    let Some(root) = std::env::var_os("PLUR1BUS_NEO_CAPTURE_CRASH_FIXTURE") else {
        return;
    };
    let root = PathBuf::from(root);
    struct PauseAfterFirst(PathBuf);
    impl CapturePolicy for PauseAfterFirst {
        fn allowed(&self, _: &RequestContext) -> Result<bool, EngineError> {
            if fs::metadata(&self.0).is_ok_and(|m| m.len() > 0) {
                println!("CAPTURE_FIRST_ROW_DURABLE");
                std::io::stdout().flush().unwrap();
                let mut byte = [0];
                let _ = std::io::stdin().read(&mut byte);
            }
            Ok(true)
        }
    }
    let host = Arc::new(support::TestHost::new(root.join("state")));
    host.set_workspace("alpha", root.clone());
    host.time.store(1_794_139_200_000, Ordering::SeqCst);
    let t = turn(&root, "one");
    let ctx = RequestContext::build(&t.principal, &t.agent, host.as_ref()).unwrap();
    let file = root
        .join("workspaces")
        .join(Layout::for_key(&ctx.workspace_key).canonical)
        .join("turn-journal.jsonl");
    let journal = CaptureJournal::open(&root, host, Arc::new(PauseAfterFirst(file))).unwrap();
    journal.record(&t, &ctx, &Cancel::never()).unwrap();
}
#[cfg(unix)]
#[test]
fn sigkill_after_first_durable_row_releases_both_leases_and_recovers() {
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let f = setup();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "capture_child_fixture", "--nocapture"])
        .env("PLUR1BUS_NEO_CAPTURE_CRASH_FIXTURE", f.root.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line.unwrap().contains("CAPTURE_FIRST_ROW_DURABLE") {
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
    assert_eq!(rows(&f.directory, "turn-journal.jsonl").len(), 1);
    let cancel = Cancel::with_deadline(Instant::now() + Duration::from_secs(5));
    assert_eq!(
        f.journal
            .recover(&f.turn.principal, &f.turn.agent, &cancel)
            .unwrap(),
        25
    );
    assert_eq!(rows(&f.directory, "turn-journal.jsonl").len(), 5);
    assert_eq!(rows(&f.directory, "embedding-queue.jsonl").len(), 12);
    assert_eq!(
        f.journal
            .recover(&f.turn.principal, &f.turn.agent, &cancel)
            .unwrap(),
        0
    );
}
