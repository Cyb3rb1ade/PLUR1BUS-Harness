//! Parity mode B for the file checkpoints of rewind (P4-K K5c, plan P4-40): TypeScript captures a checkpoint and Rust restores
//! it, and the other way round, over the same SQLite store file and the same repository. After each run the TypeScript product
//! code dumps the file tree, the working-tree status, the checkpoint row and the private refs, and the dump of the world a
//! second implementation touched must equal the dump of the world that implementation handled alone
//! (`tests/core-parity/sessions-b-driver.ts`, commands `rewind-*`). Needs Node (`PLUR1BUS_NODE` or `node` on PATH) and `git`;
//! unix only (the path layer refuses Windows paths, R-K-12).
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_core::budget::{Clock, UuidIds};
use plur1bus_core::policy::fs_paths::RealFs;
use plur1bus_core::rbac::audit::{AuditEvent, AuditSink};
use plur1bus_core::sessions::checkpoint_retention::SharedAudit;
use plur1bus_core::sessions::rewind::RestoreInput;
use plur1bus_core::sessions::rewind_checkpoints::{
    null_device, ApprovalAnswer, ApprovalAsk, CheckpointDeps, ProjectBinding, RestoreApproval,
    RewindCheckpoints, TurnApprover,
};
use plur1bus_core::sessions::rewind_git::{Cancel, RewindError, SystemGit};
use plur1bus_core::sessions::{BeginOptions, CreateSessionInput, SessionKind, SessionStore};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::sync::Arc;

struct At(i64);
impl Clock for At {
    fn now(&self) -> i64 {
        self.0
    }
}

struct Nothing;
impl AuditSink for Nothing {
    fn append(&mut self, _: &AuditEvent) -> Result<(), String> {
        Ok(())
    }
}

struct Yes;
impl RestoreApproval for Yes {
    fn request(
        &self,
        _: &mut SessionStore,
        _: &ApprovalAsk,
        _: &Cancel,
    ) -> Result<ApprovalAnswer, RewindError> {
        Ok(ApprovalAnswer {
            approved: true,
            scope: Some("once".into()),
            request_id: Some("r".into()),
        })
    }
    fn begin(&self, _: &ApprovalAnswer, _: &ApprovalAsk) -> bool {
        true
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn have(program: &str) -> bool {
    Command::new(program)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn driver(command: &str, dir: &Path, rest: &[&str]) -> Value {
    let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
    let out = Command::new(&node)
        .current_dir(repo_root())
        .args([
            "--experimental-strip-types",
            "--conditions=source",
            "--no-warnings=ExperimentalWarning",
            "tests/core-parity/sessions-b-driver.ts",
            command,
        ])
        .arg(dir)
        .args(rest)
        .output()
        .unwrap_or_else(|e| {
            panic!("could not run Node {node:?}: {e}. Install Node and run `pnpm test:prep`.")
        });
    assert!(
        out.status.success(),
        "sessions-b-driver {command}: {}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

const DATE: &str = "2026-01-02T03:04:05Z";

fn git(root: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgSign=false",
        ])
        .args(args)
        .current_dir(root)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", root)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_AUTHOR_DATE", DATE)
        .env("GIT_COMMITTER_DATE", DATE)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

struct World {
    store: SessionStore,
    checkpoints: RewindCheckpoints<RealFs>,
    session: String,
    turn: String,
    root: PathBuf,
}

/// Opens the store file and builds the Rust side over the repository `info` names (written by either language).
fn open_world(dir: &Path, name: &str) -> World {
    let info: Value =
        serde_json::from_slice(&std::fs::read(dir.join(format!("{name}.json"))).unwrap()).unwrap();
    let root = PathBuf::from(info["root"].as_str().unwrap());
    let mut store = SessionStore::open(
        &dir.join(format!("{name}.sqlite")),
        Arc::new(At(1_791_000_000_000)),
        Arc::new(UuidIds),
    )
    .unwrap();
    let bound = root.to_string_lossy().into_owned();
    let audit: SharedAudit = Rc::new(RefCell::new(Box::new(Nothing)));
    let checkpoints = RewindCheckpoints::new(
        &mut store,
        CheckpointDeps {
            audit,
            clock: Arc::new(At(1_791_000_000_000)),
            ids: Arc::new(UuidIds),
            git: Arc::new(SystemGit::default()),
            fs: RealFs,
            temp_dir: std::env::temp_dir(),
            null_device: null_device(),
            project: Rc::new(move |_, _| {
                Ok(Some(ProjectBinding {
                    project_id: "p".into(),
                    card_id: "c".into(),
                    root: bound.clone(),
                }))
            }),
            // This parity driver serializes the Rust and TypeScript owners of its private repository.
            writer_lease: Some(Rc::new(|_| Some(Box::new(|| true)))),
            approval: Box::new(Yes),
            file_projects: Some(Rc::new(|| vec!["p".to_owned()])),
            retention_turns: Some(Rc::new(|| 50.0)),
            card_ended: Some(Rc::new(|_, _| Ok(false))),
            on_cleanup_error: None,
        },
    )
    .unwrap();
    World {
        store,
        checkpoints,
        session: info["session"].as_str().unwrap().to_owned(),
        turn: info["turn"].as_str().unwrap().to_owned(),
        root,
    }
}

/// The Rust twin of the driver's `rewind-capture`: the repository, the store, one checkpoint, then a failed attempt.
fn rust_capture(dir: &Path, name: &str) {
    let root = dir.join(format!("{name}-repo"));
    std::fs::create_dir_all(root.join("sub")).unwrap();
    git(&root, &["init", "-q"]);
    std::fs::write(root.join("tracked.txt"), "original\n").unwrap();
    std::fs::write(root.join("other.txt"), "other\n").unwrap();
    std::fs::write(root.join("sub/deep.txt"), "deep\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "fixture"]);
    let mut store = SessionStore::open(
        &dir.join(format!("{name}.sqlite")),
        Arc::new(At(1_791_000_000_000)),
        Arc::new(UuidIds),
    )
    .unwrap();
    let session = store
        .create_session(&CreateSessionInput::new(SessionKind::Card, "a", "owner"))
        .unwrap();
    let turn = store
        .begin_turn(&session.id, "edit", 1, &BeginOptions::default())
        .unwrap()
        .turn
        .id;
    std::fs::write(
        dir.join(format!("{name}.json")),
        json!({"session": session.id, "turn": turn, "root": root.to_string_lossy()}).to_string(),
    )
    .unwrap();
    drop(store);
    let mut w = open_world(dir, name);
    std::fs::write(root.join("tracked.txt"), "checkpoint working contents\n").unwrap();
    std::fs::write(root.join("sub/deep.txt"), "deep edited\n").unwrap();
    std::fs::write(root.join("untracked.txt"), "untracked must survive\n").unwrap();
    w.checkpoints
        .capture(&mut w.store, &w.session, &w.turn, "owner", &Cancel::new())
        .unwrap();
    w.store.complete_turn(&w.turn, "done", 1, None).unwrap();
    std::fs::write(root.join("tracked.txt"), "failed edit\n").unwrap();
    std::fs::write(root.join("new-after.txt"), "made after the checkpoint\n").unwrap();
}

fn rust_restore(dir: &Path, name: &str) {
    let mut w = open_world(dir, name);
    let mut ok = |_: &mut SessionStore| Ok(());
    w.checkpoints
        .restore_files(
            &mut w.store,
            RestoreInput {
                session_id: w.session.clone(),
                parent_seq: 0,
                hidden_from_seq: 1,
                hidden_to_seq: 2,
                checkpoint_turn_id: w.turn.clone(),
                approver: TurnApprover {
                    person: Some("owner".into()),
                    surface: 2,
                },
                signal: Cancel::new(),
                validate: &mut ok,
            },
        )
        .unwrap();
    let _ = w.root;
}

fn workdir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("p4k-rewind-b-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(dir).unwrap()
}

#[test]
fn a_checkpoint_taken_by_typescript_is_restored_by_rust_exactly_as_typescript_restores_it() {
    if !have("git") || !have("node") {
        eprintln!("SKIPPED: needs git and node");
        return;
    }
    let dir = workdir("ts-then-rust");
    driver("rewind-capture", &dir, &["a"]);
    driver("rewind-capture", &dir, &["b"]);
    rust_restore(&dir, "a");
    driver("rewind-restore", &dir, &["b"]);
    let (a, b) = (
        driver("rewind-dump", &dir, &["a"]),
        driver("rewind-dump", &dir, &["b"]),
    );
    assert_eq!(a, b, "Rust restored what TypeScript captured");
    assert_eq!(a["files"]["tracked.txt"], "checkpoint working contents\n");
    assert_eq!(a["files"]["sub/deep.txt"], "deep edited\n");
    assert_eq!(a["files"]["untracked.txt"], "untracked must survive\n");
    assert_eq!(
        a["files"]["new-after.txt"], "made after the checkpoint\n",
        "a file made after the checkpoint is kept"
    );
    assert!(
        a["row"].is_object() && a["checkpointTree"] == a["row"]["tree"],
        "{a}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_checkpoint_taken_by_rust_is_restored_by_typescript_exactly_as_rust_restores_it() {
    if !have("git") || !have("node") {
        eprintln!("SKIPPED: needs git and node");
        return;
    }
    let dir = workdir("rust-then-ts");
    rust_capture(&dir, "c");
    rust_capture(&dir, "d");
    driver("rewind-restore", &dir, &["c"]);
    rust_restore(&dir, "d");
    let (c, d) = (
        driver("rewind-dump", &dir, &["c"]),
        driver("rewind-dump", &dir, &["d"]),
    );
    assert_eq!(c, d, "TypeScript restored what Rust captured");
    assert_eq!(c["files"]["tracked.txt"], "checkpoint working contents\n");
    assert_eq!(c["files"]["untracked.txt"], "untracked must survive\n");
    // The checkpoint TypeScript captured in the first test has the same tree as the one Rust captures from the same files.
    let ts = driver("rewind-capture", &dir, &["e"]);
    assert!(ts["root"].is_string());
    let e = driver("rewind-dump", &dir, &["e"]);
    assert_eq!(
        e["row"]["tree"], c["row"]["tree"],
        "both languages hash the same working tree"
    );
    assert_eq!(
        e["head"], c["head"],
        "the fixture repositories are the same"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
