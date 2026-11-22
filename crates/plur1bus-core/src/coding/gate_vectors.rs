use super::*;
use crate::coding::verifier::{VerifierCommand, VerifierResult};
use crate::rbac::audit::AuditEvent;
use crate::rbac::types::{PrincipalKind, Role};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};

const HEAD: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MANIFEST: &str = r#"{"scripts":{"format":"f","lint":"l","typecheck":"ty","test":"t"}}"#;
const BASE: &str = "src/example.ts";
const NETWORK_CONFIG: &str = ".plur1bus-verifiers.json";
const NETWORK_MANIFEST: &str = r#"{"commands":{"format":["fixture-format"],"lint":["fixture-lint"],"typecheck":["fixture-typecheck"],"test":["fixture-test"]},"networkAllowed":true}"#;

const ROOT: &str = "/fixture";

struct Fixture<'a> {
    name: &'a str,
    lines: u64,
    changed: Cell<bool>,
    reviewer: Cell<bool>,
    checks: RefCell<Vec<Value>>,
}
struct FixedClock;
impl Clock for FixedClock {
    fn now(&self) -> i64 {
        1
    }
}
impl WorktreeFiles for Fixture<'_> {
    fn canonical(&self, path: &str) -> R<String> {
        Ok(path.to_owned())
    }
    fn metadata(&self, _: &str, _: &str) -> R<Option<WorktreeEntry>> {
        Ok(Some(WorktreeEntry {
            kind: FileKind::File,
            size: 1,
            links: 1,
        }))
    }
    fn read(&self, _: &str, name: &str, _: usize) -> R<Option<Vec<u8>>> {
        if name == NETWORK_CONFIG && self.name.starts_with("project network ") {
            return Ok(Some(NETWORK_MANIFEST.as_bytes().to_vec()));
        }
        Ok((name == "package.json").then(|| {
            let mut manifest = MANIFEST.to_owned();
            if self.name == "changed convention" {
                manifest.push(' ');
            }
            manifest.into_bytes()
        }))
    }
    fn windows(&self) -> bool {
        false
    }
}
impl RepoGit for Fixture<'_> {
    fn read(&self, root: &str, args: &[&str]) -> Result<String, String> {
        match args {
            ["rev-parse", "--show-toplevel"] => Ok(format!("{root}\n")),
            ["rev-parse", "HEAD"] => Ok(format!("{HEAD}\n")),
            ["ls-files", "-z"] => Ok(format!("package.json\0{BASE}\0")),
            ["ls-files", "--others", "--exclude-standard", "-z"] => Ok(String::new()),
            ["diff", "--binary", "HEAD", "--"] => Ok(if self.changed.get() {
                "new diff\n"
            } else {
                "fixture diff\n"
            }
            .to_owned()),
            ["diff", "--numstat", "HEAD", "--"] => Ok(format!("{}\t0\t{BASE}\n", self.lines)),
            ["diff", "--name-only", "HEAD", "--"] => Ok(format!("{BASE}\n")),
            _ => Err("unexpected git operation".to_owned()),
        }
    }
}
impl GateGit for Fixture<'_> {
    fn committed(&self, _: &str, _: &str, name: &str) -> R<Option<String>> {
        if name == NETWORK_CONFIG && self.name.starts_with("project network ") {
            return Ok(Some(NETWORK_MANIFEST.to_owned()));
        }
        Ok((name == "package.json").then(|| MANIFEST.to_owned()))
    }
}
impl Verifier for Fixture<'_> {
    fn run(
        &self,
        _: &str,
        command: &VerifierCommand,
        network_allowed: bool,
        _: &AbortSignal,
    ) -> VerifierResult {
        self.checks
            .borrow_mut()
            .push(json!({ "kind": command.kind.as_str(), "networkAllowed": network_allowed }));
        if self.name == "changed during verification" {
            self.changed.set(true);
        }
        let fail = self.name == "verifier failure" && command.kind == CheckKind::Lint;
        VerifierResult {
            ok: !fail,
            exit_code: Some(i32::from(fail)),
            output: format!("fixture {}", command.kind.as_str()),
            reason: fail.then(|| "fixture-failure".to_owned()),
        }
    }
}

#[test]
fn coding_gate_vectors() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../../fixtures/parity/coding/gate.json")).unwrap();
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let fixture = Fixture {
            name,
            lines: c["lines"].as_u64().unwrap(),
            changed: Cell::new(false),
            reviewer: Cell::new(true),
            checks: RefCell::default(),
        };
        let local = |id: &str| id == "writer" || (fixture.reviewer.get() && id == "reviewer");
        let mut audit = Vec::new();
        let mut sink = |event: &AuditEvent| {
            audit.push(event.action.clone());
            Ok(())
        };
        let mut ports = GatePorts {
            files: &fixture,
            git: &fixture,
            verifier: &fixture,
            local: &local,
            network_approved: name == "project network approved",
            clock: &FixedClock,
            audit: &mut sink,
        };
        let gate = CodingGate::open(Path::new(":memory:")).unwrap();
        let snapshot = gate
            .snapshot(ROOT, &ports)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            json!({ "head": snapshot.head, "treeHash": snapshot.tree_hash, "changedLines": snapshot.changed_lines,
            "files": snapshot.files }),
            c["snapshot"],
            "{name}"
        );
        let task = "project/card";
        let owner = Principal {
            kind: Some(PrincipalKind::Person),
            ..Principal::new("lead", Role::Owner)
        };
        let signal = AbortSignal::new();
        let result = (|| {
            if name == "self review" {
                gate.record_review(task, &snapshot, "writer", "writer", &mut ports)?;
            }
            if name == "review of stale tree" {
                gate.record_review(
                    task,
                    &Snapshot {
                        tree_hash: "stale".to_owned(),
                        ..snapshot.clone()
                    },
                    "reviewer",
                    "writer",
                    &mut ports,
                )?;
            }
            if name == "review recorded" || name == "review revoked" {
                gate.record_review(task, &snapshot, "reviewer", "writer", &mut ports)?;
                if name == "review revoked" {
                    fixture.reviewer.set(false);
                }
            }
            let note = match name {
                "override" => Some("checked manually"),
                "empty override" => Some("   "),
                _ => None,
            };
            gate.verify(
                VerifyInput {
                    task,
                    writer: "writer",
                    root: ROOT,
                    abort: &signal,
                    override_note: note.map(|note| GateOverride {
                        actor: &owner,
                        project: "project",
                        note,
                    }),
                },
                &mut ports,
            )
        })();
        let wire = match result {
            Ok(result) => json!({ "ok": result }),
            Err(error) => {
                json!({ "err": { "code": error.code.as_str(), "message": error.message } })
            }
        };
        assert_eq!(wire, c["result"], "{name}");
        assert_eq!(json!(audit), c["audit"], "{name}");
        let mut expected = c["toolCalls"].clone();
        if let Some(network) = c["divergence"]["networkAllowed"].as_bool() {
            for call in expected.as_array_mut().unwrap() {
                assert_eq!(call["networkAllowed"], true);
                call["networkAllowed"] = json!(network);
            }
        }
        assert_eq!(json!(fixture.checks.take()), expected, "{name}");
    }
}

#[test]
fn a_review_is_bound_to_its_writer_and_worktree_even_when_content_matches() {
    let fixture = Fixture {
        name: "review binding",
        lines: 200,
        changed: Cell::new(false),
        reviewer: Cell::new(true),
        checks: RefCell::default(),
    };
    let mut audit = |_: &AuditEvent| Ok(());
    let mut ports = GatePorts {
        files: &fixture,
        git: &fixture,
        verifier: &fixture,
        local: &|_| true,
        network_approved: false,
        clock: &FixedClock,
        audit: &mut audit,
    };
    let gate = CodingGate::open(Path::new(":memory:")).unwrap();
    let task = "project/card";
    let before = gate.snapshot(ROOT, &ports).unwrap();
    let other = gate.snapshot("/other-worktree", &ports).unwrap();
    assert_eq!(before.tree_hash, other.tree_hash);
    gate.record_review(task, &before, "reviewer", "writer", &mut ports)
        .unwrap();
    gate.db
        .conn()
        .execute(
            "INSERT INTO coding_reviews VALUES (?,?,?,?)",
            params![
                "self-review",
                review_key(&before, "writer"),
                "writer",
                "writer"
            ],
        )
        .unwrap();
    let abort = AbortSignal::new();
    let mut verify = |task, root, writer| {
        gate.verify(
            VerifyInput {
                task,
                writer,
                root,
                abort: &abort,
                override_note: None,
            },
            &mut ports,
        )
        .unwrap()
    };
    assert!(verify(task, ROOT, "writer").ok);
    assert_eq!(
        verify(task, &other.root, "writer").reason,
        Some("review-required")
    );
    assert_eq!(
        verify(task, ROOT, "other-writer").reason,
        Some("review-required")
    );
    assert_eq!(
        verify("self-review", ROOT, "writer").reason,
        Some("review-required")
    );
}

#[test]
fn coding_review_round_trips_between_stores() {
    let dir = tempfile::tempdir().unwrap();
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/core-parity/k6b-gate-b-driver.ts");
    let driver = |action| {
        let out = std::process::Command::new("node")
            .args([
                "--experimental-strip-types",
                "--conditions=source",
                "--no-warnings=ExperimentalWarning",
            ])
            .arg(&script)
            .arg(action)
            .arg(dir.path())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "driver failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    driver("prepare");
    let fixture = Fixture {
        name: "round-trip",
        lines: 200,
        changed: Cell::new(false),
        reviewer: Cell::new(true),
        checks: RefCell::default(),
    };
    let mut sink = |_: &AuditEvent| Ok(());
    let mut ports = GatePorts {
        files: &fixture,
        git: &fixture,
        verifier: &fixture,
        local: &|id| ["reviewer", "writer"].contains(&id),
        network_approved: false,
        clock: &FixedClock,
        audit: &mut sink,
    };
    let from_ts = CodingGate::open(&dir.path().join("from-ts.sqlite")).unwrap();
    let snapshot = from_ts.snapshot(ROOT, &ports).unwrap();
    assert!(!from_ts
        .has_review("project/card", &snapshot, "writer", &ports)
        .unwrap());
    from_ts
        .record_review("from-rust", &snapshot, "reviewer", "writer", &mut ports)
        .unwrap();
    assert!(from_ts
        .has_review("from-rust", &snapshot, "writer", &ports)
        .unwrap());
    drop(from_ts);
    let rust = CodingGate::open(&dir.path().join("from-rust.sqlite")).unwrap();
    rust.record_review("new-rust", &snapshot, "reviewer", "writer", &mut ports)
        .unwrap();
    drop(rust);
    driver("verify");
}
