//! Test support for the rewind half: a recording Git port over the real `git`, a repository fixture in a temporary directory
//! with an isolated Git environment (`HOME` and the global and system configuration pointed away, so no test reads or writes
//! the configuration or a repository of the person running it), the clock, the ids, the audit sink and an approval double.
//!
//! Tests that run `git` skip, and say so, when no `git` is installed.
#![cfg(test)]
use super::checkpoint_retention::SharedAudit;
use super::rewind_checkpoints::{
    ApprovalAnswer, ApprovalAsk, CheckpointDeps, ProjectBinding, RestoreApproval, RewindCheckpoints,
};
use super::rewind_git::{Cancel, GitFailure, GitProcess, RewindError, SystemGit};
use super::{
    BeginOptions, Clock, CreateSessionInput, IdSource, SessionKind, SessionRecord, SessionStore,
};
use crate::policy::fs_paths::RealFs;
use crate::rbac::audit::{AuditEvent, AuditSink};
use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::rc::Rc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;

pub(crate) struct TestClock(pub AtomicI64);
impl Clock for TestClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

pub(crate) struct TestIds(pub AtomicU64);
impl IdSource for TestIds {
    fn next_id(&self) -> String {
        (self.0.fetch_add(1, Ordering::SeqCst) + 1).to_string()
    }
}

pub(crate) fn clock(at: i64) -> Arc<TestClock> {
    Arc::new(TestClock(AtomicI64::new(at)))
}

pub(crate) fn store_with(clock: Arc<TestClock>) -> SessionStore {
    SessionStore::open_memory(clock, Arc::new(TestIds(AtomicU64::new(0)))).unwrap()
}

/// Whether a `git` is installed; a test that needs one prints a skip line and returns when it is not.
pub(crate) fn have_git() -> bool {
    let ok = Command::new("git")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        eprintln!("SKIPPED: no `git` on the PATH");
    }
    ok
}

const DATE: &str = "2026-01-02T03:04:05Z";

/// The environment of the fixture's own Git calls and of the recording port: nothing of the real configuration.
pub(crate) fn isolated_env(home: &Path) -> Vec<(String, String)> {
    let path = std::env::var("PATH").unwrap_or_default();
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    vec![
        ("PATH".into(), path),
        ("HOME".into(), home.to_string_lossy().into_owned()),
        ("USERPROFILE".into(), home.to_string_lossy().into_owned()),
        (
            "XDG_CONFIG_HOME".into(),
            home.join("xdg").to_string_lossy().into_owned(),
        ),
        ("GIT_CONFIG_GLOBAL".into(), null.into()),
        ("GIT_CONFIG_SYSTEM".into(), null.into()),
        ("GIT_AUTHOR_DATE".into(), DATE.into()),
        ("GIT_COMMITTER_DATE".into(), DATE.into()),
    ]
}

/// One recorded Git call: the argument list and the `GIT_` variables of its environment.
#[derive(Clone, Debug)]
pub(crate) struct Call {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

pub(crate) type FailHook = Box<dyn FnMut(&[String]) -> Option<GitFailure>>;
/// Answers a call with the given text instead of running it (what a real `git` cannot be made to print).
pub(crate) type Tamper = Box<dyn FnMut(&[String]) -> Option<String>>;

/// The real `git` behind the port, recording every call; `fail` may refuse a call by its arguments.
pub(crate) struct Recording {
    pub inner: SystemGit,
    pub log: Rc<RefCell<Vec<Call>>>,
    pub home: PathBuf,
    pub fail: Rc<RefCell<Option<FailHook>>>,
    pub tamper: Rc<RefCell<Option<Tamper>>>,
}

impl GitProcess for Recording {
    fn base_env(&self) -> Vec<(String, String)> {
        // Includes inherited-looking GIT_ names on purpose: the policy must strip them.
        let mut env = isolated_env(&self.home);
        env.retain(|(k, _)| !k.starts_with("GIT_"));
        env.push(("GIT_DIR".into(), "/nonexistent/inherited".into()));
        env.push(("git_work_tree".into(), "/nonexistent/inherited".into()));
        env
    }

    fn run(
        &self,
        args: &[String],
        env: &[(String, String)],
        cancel: &Cancel,
    ) -> Result<String, GitFailure> {
        self.log.borrow_mut().push(Call {
            args: args.to_vec(),
            env: env
                .iter()
                .filter(|(k, _)| k.to_uppercase().starts_with("GIT_"))
                .cloned()
                .collect(),
        });
        if let Some(hook) = self.fail.borrow_mut().as_mut() {
            if let Some(f) = hook(args) {
                return Err(f);
            }
        }
        if let Some(hook) = self.tamper.borrow_mut().as_mut() {
            if let Some(text) = hook(args) {
                return Ok(text);
            }
        }
        // Fixed dates make commit ids repeatable; the inherited configuration is pointed away by the policy itself.
        let mut env = env.to_vec();
        env.push(("GIT_AUTHOR_DATE".into(), DATE.into()));
        env.push(("GIT_COMMITTER_DATE".into(), DATE.into()));
        self.inner.run(args, &env, cancel)
    }
}

/// An audit sink that keeps its events.
pub(crate) struct MemAudit(pub Rc<RefCell<Vec<AuditEvent>>>);
impl AuditSink for MemAudit {
    fn append(&mut self, event: &AuditEvent) -> Result<(), String> {
        self.0.borrow_mut().push(event.clone());
        Ok(())
    }
}

pub(crate) fn audit_pair() -> (SharedAudit, Rc<RefCell<Vec<AuditEvent>>>) {
    let events = Rc::new(RefCell::new(Vec::new()));
    (
        Rc::new(RefCell::new(
            Box::new(MemAudit(events.clone())) as Box<dyn AuditSink>
        )),
        events,
    )
}

/// A repository in a temporary directory, with a committed `HEAD`.
pub(crate) struct Repo {
    pub dir: tempfile::TempDir,
    pub root: String,
    pub home: PathBuf,
}

impl Repo {
    pub fn new() -> Repo {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let home = base.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let root = base.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let repo = Repo {
            root: root.to_string_lossy().into_owned(),
            home,
            dir,
        };
        repo.git(&["init", "-q"]);
        repo
    }

    pub fn git(&self, args: &[&str]) -> String {
        self.git_in(&self.root, args)
    }

    pub fn git_in(&self, cwd: &str, args: &[&str]) -> String {
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
            .current_dir(cwd)
            .env_clear()
            .envs(isolated_env(&self.home))
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    pub fn write(&self, rel: &str, content: &str) {
        let p = Path::new(&self.root).join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, content).unwrap();
    }

    pub fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(Path::new(&self.root).join(rel)).ok()
    }

    pub fn commit_all(&self) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", "fixture"]);
    }

    pub fn refs(&self) -> String {
        self.git(&[
            "for-each-ref",
            "--format=%(refname)",
            "refs/plur1bus/checkpoints",
        ])
        .trim()
        .to_owned()
    }
}

/// What the approval double answers.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Answer {
    Once,
    Deny,
    Session,
}

pub(crate) type Hook = Box<dyn FnMut(&mut SessionStore, &Cancel) -> Option<RewindError>>;

/// An approval port that records what it was asked, runs a hook while "waiting" and answers as told.
pub(crate) struct Approval {
    pub asks: Rc<RefCell<Vec<ApprovalAsk>>>,
    pub answer: Rc<Cell<Answer>>,
    pub hook: Rc<RefCell<Option<Hook>>>,
    pub begun: Rc<Cell<usize>>,
    pub consumed: Cell<bool>,
    pub order: Rc<RefCell<Vec<String>>>,
}

impl RestoreApproval for Approval {
    fn request(
        &self,
        store: &mut SessionStore,
        ask: &ApprovalAsk,
        cancel: &Cancel,
    ) -> Result<ApprovalAnswer, RewindError> {
        self.asks.borrow_mut().push(ask.clone());
        self.order.borrow_mut().push("request".into());
        if let Some(hook) = self.hook.borrow_mut().as_mut() {
            if let Some(e) = hook(store, cancel) {
                return Err(e);
            }
        }
        let a = self.answer.get();
        Ok(ApprovalAnswer {
            approved: a != Answer::Deny,
            scope: Some(
                if a == Answer::Session {
                    "session"
                } else {
                    "once"
                }
                .into(),
            ),
            request_id: Some("req-1".into()),
        })
    }

    fn begin(&self, _answer: &ApprovalAnswer, _ask: &ApprovalAsk) -> bool {
        self.order.borrow_mut().push("begin".into());
        self.begun.set(self.begun.get() + 1);
        !self.consumed.replace(true)
    }
}

/// The doubles a [`World`] hands to the code under test and keeps to look at afterwards.
pub(crate) struct Shared {
    pub clock: Arc<TestClock>,
    pub log: Rc<RefCell<Vec<Call>>>,
    pub fail: Rc<RefCell<Option<FailHook>>>,
    pub tamper: Rc<RefCell<Option<Tamper>>>,
    pub audit: Rc<RefCell<Vec<AuditEvent>>>,
    pub asks: Rc<RefCell<Vec<ApprovalAsk>>>,
    pub answer: Rc<Cell<Answer>>,
    pub hook: Rc<RefCell<Option<Hook>>>,
    pub begun: Rc<Cell<usize>>,
    pub order: Rc<RefCell<Vec<String>>>,
    pub warnings: Rc<Cell<usize>>,
    pub ended: Rc<Cell<bool>>,
    pub ended_checks: Rc<Cell<usize>>,
    pub projects: Rc<RefCell<Vec<String>>>,
    pub turns: Rc<Cell<f64>>,
    pub root: String,
    home: PathBuf,
    audit_shared: SharedAudit,
}

impl Shared {
    fn deps(&self, project_throws: bool) -> CheckpointDeps<RealFs> {
        let (e2, p2, t2, w2, c2) = (
            self.ended.clone(),
            self.projects.clone(),
            self.turns.clone(),
            self.warnings.clone(),
            self.ended_checks.clone(),
        );
        let root = self.root.clone();
        CheckpointDeps {
            audit: self.audit_shared.clone(),
            clock: self.clock.clone(),
            ids: Arc::new(TestIds(AtomicU64::new(100))),
            git: Arc::new(Recording {
                inner: SystemGit::default(),
                log: self.log.clone(),
                home: self.home.clone(),
                fail: self.fail.clone(),
                tamper: self.tamper.clone(),
            }),
            fs: RealFs,
            temp_dir: self.home.clone(),
            null_device: super::rewind_checkpoints::null_device(),
            project: Rc::new(move |_, _| {
                if project_throws {
                    return Err("an erased session has no live binding".to_owned());
                }
                Ok(Some(ProjectBinding {
                    project_id: "p".into(),
                    card_id: "c".into(),
                    root: root.clone(),
                }))
            }),
            approval: Box::new(Approval {
                asks: self.asks.clone(),
                answer: self.answer.clone(),
                hook: self.hook.clone(),
                begun: self.begun.clone(),
                consumed: Cell::new(false),
                order: self.order.clone(),
            }),
            file_projects: Some(Rc::new(move || p2.borrow().clone())),
            retention_turns: Some(Rc::new(move || t2.get())),
            card_ended: Some(Rc::new(move |_, _| {
                c2.set(c2.get() + 1);
                Ok(e2.get())
            })),
            on_cleanup_error: Some(Rc::new(move || w2.set(w2.get() + 1))),
        }
    }
}

/// A project card with a session, a store, a recording Git port, the audit events and the approval double.
pub(crate) struct World {
    pub repo: Repo,
    pub store: SessionStore,
    pub session: SessionRecord,
    pub checkpoints: Rc<RewindCheckpoints<RealFs>>,
    shared: Shared,
}

impl std::ops::Deref for World {
    type Target = Shared;
    fn deref(&self) -> &Shared {
        &self.shared
    }
}

impl World {
    /// `None` when there is no `git`.
    pub fn new(kind: SessionKind) -> Option<World> {
        Self::new_with(kind, |repo| repo.root.clone())
    }

    /// Like [`World::new`], with the project root chosen by `root_of` (a linked worktree, a repository without a commit).
    pub fn new_with(kind: SessionKind, root_of: impl FnOnce(&Repo) -> String) -> Option<World> {
        if !have_git() {
            return None;
        }
        let repo = Repo::new();
        repo.write("tracked.txt", "original\n");
        repo.write("other.txt", "other\n");
        repo.commit_all();
        let root = root_of(&repo);
        let clock = clock(1_000);
        let mut store = store_with(clock.clone());
        let session = store
            .create_session(&CreateSessionInput::new(kind, "a", "owner"))
            .unwrap();
        let (audit_shared, events) = audit_pair();
        let shared = Shared {
            clock,
            log: Rc::new(RefCell::new(Vec::new())),
            fail: Rc::new(RefCell::new(None)),
            tamper: Rc::new(RefCell::new(None)),
            audit: events,
            asks: Rc::new(RefCell::new(Vec::new())),
            answer: Rc::new(Cell::new(Answer::Once)),
            hook: Rc::new(RefCell::new(None)),
            begun: Rc::new(Cell::new(0)),
            order: Rc::new(RefCell::new(Vec::new())),
            warnings: Rc::new(Cell::new(0)),
            ended: Rc::new(Cell::new(false)),
            ended_checks: Rc::new(Cell::new(0)),
            projects: Rc::new(RefCell::new(vec!["p".to_owned()])),
            turns: Rc::new(Cell::new(50.0)),
            root,
            home: repo.home.clone(),
            audit_shared,
        };
        let checkpoints = Rc::new(RewindCheckpoints::new(&mut store, shared.deps(false)).unwrap());
        Some(World {
            repo,
            store,
            session,
            checkpoints,
            shared,
        })
    }

    /// A new lifecycle on the same store and repository: what a restart of the core does.
    pub fn restart(&mut self, project_throws: bool) {
        let deps = self.shared.deps(project_throws);
        self.checkpoints = Rc::new(RewindCheckpoints::new(&mut self.store, deps).unwrap());
    }

    /// Begins a turn, captures a checkpoint before it, completes it. Returns the turn id.
    pub fn turn(&mut self) -> String {
        let begun = self
            .store
            .begin_turn(&self.session.id, "edit", 1, &BeginOptions::default())
            .unwrap();
        let id = begun.turn.id.clone();
        self.checkpoints
            .capture(
                &mut self.store,
                &self.session.id,
                &id,
                "owner",
                &Cancel::new(),
            )
            .unwrap();
        self.store.complete_turn(&id, "done", 1, None).unwrap();
        id
    }

    pub fn actions(&self) -> Vec<String> {
        self.audit
            .borrow()
            .iter()
            .map(|e| e.action.clone())
            .collect()
    }
}
