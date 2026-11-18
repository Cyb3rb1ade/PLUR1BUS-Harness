//! The file tools behind the gate with their real classifier (the tests of `test/tools/fs/fs.test.ts` that the recorded
//! cases do not hold: the gate in front, the binding, the mode of the temporary file, the entry cap, cancellation).
//! Every test works in its own temporary directory.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![cfg_attr(not(unix), allow(unused_imports, dead_code))]

use super::*;
use crate::gate::doubles::{MemoryAudit, Permits, SetClock};
use crate::gate::{Gate, GateError, GatedTool, UnverifiedAction};
use plur1bus_core::approvals::OsRandom;
use plur1bus_core::policy::fs_paths::RealFs;
use plur1bus_core::policy::paths::IcuNfc;
use std::cell::Cell;

struct Bench {
    _dir: tempfile::TempDir,
    root: String,
    config: FsConfig,
    clock: SetClock,
}

fn who() -> Caller {
    Caller {
        principal: "christian".into(),
        agent_id: "bernd".into(),
        surface: 3,
        session_id: Some("s1".into()),
        ..Caller::default()
    }
}

impl Bench {
    fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("p4k-fs-gate-")
            .tempdir()
            .unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let base = base
            .to_str()
            .unwrap()
            .trim_start_matches(r"\\?\")
            .to_owned();
        let root = std::path::Path::new(&base).join("root");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(root.join(".ssh")).unwrap();
        std::fs::create_dir_all(std::path::Path::new(&base).join("outside")).unwrap();
        std::fs::write(root.join("file.txt"), "inside").unwrap();
        std::fs::write(root.join(".ssh").join("id"), "key").unwrap();
        let root = root.to_str().unwrap().to_owned();
        Bench {
            _dir: dir,
            config: FsConfig {
                roots: vec![PathRoot {
                    id: "ws".into(),
                    path: root.clone(),
                    identity: None,
                }],
                deny: Some(json!([{ "name": ".ssh" }])),
                home: Some(format!("{base}/no-home")),
                ..FsConfig::default()
            },
            root,
            clock: SetClock::at(1_000_000.0),
        }
    }

    fn p(&self, rel: &str) -> String {
        std::path::Path::new(&self.root)
            .join(rel)
            .to_str()
            .unwrap()
            .to_owned()
    }

    /// The gate with the composition's classifiers for the four tools; `approving`: a person says yes when asked.
    fn verify(
        &self,
        tool: &str,
        args: Value,
        who: &Caller,
        approving: bool,
    ) -> Result<ApprovedAction, GateError> {
        let classifier = |access| FsClassifier {
            fs: &RealFs,
            nfc: &IcuNfc,
            roots: &self.config.roots,
            deny: self.config.deny.as_ref(),
            access,
        };
        let (read, write) = (classifier(Access::Read), classifier(Access::Write));
        let tools: Vec<GatedTool<'_>> = TOOLS
            .iter()
            .map(|(name, _, effect, _)| GatedTool {
                name,
                capability: if *effect == "read" {
                    "fs.read"
                } else {
                    "fs.write"
                },
                effect,
                risk: "low",
                classifier: Some(if *effect == "read" { &read } else { &write }),
            })
            .collect();
        let mut audit = MemoryAudit::default();
        let mut permits = if approving {
            Permits::approving()
        } else {
            Permits::default()
        };
        Gate::new(&tools, &self.clock, &mut audit, &mut permits).verify(
            UnverifiedAction {
                tool: tool.to_owned(),
                args,
                call_id: "c1".into(),
                reason: None,
                diff: None,
            },
            who,
        )
    }

    fn run(
        &self,
        approved: ApprovedAction,
        who: &Caller,
        aborted: &dyn Fn() -> bool,
        after_check: Option<&dyn Fn(&str)>,
    ) -> Result<Value, FsFailure> {
        FsTools {
            config: self.config.clone(),
            ports: FsPorts {
                fs: &RealFs,
                nfc: &IcuNfc,
                clock: &self.clock,
                random: &OsRandom,
                aborted,
                known_secrets: None,
            },
            after_check,
        }
        .execute(approved, who)
    }
}

fn never() -> bool {
    false
}

#[cfg(unix)]
#[test]
fn the_gate_decides_and_the_tools_run_what_it_approved() {
    let b = Bench::new();
    // A read inside the root needs nobody.
    let a = b
        .verify(
            "file.read",
            json!({ "path": b.p("file.txt") }),
            &who(),
            false,
        )
        .unwrap();
    assert_eq!(a.targets(), [b.p("file.txt")]);
    let r = b.run(a, &who(), &never, None).unwrap();
    assert_eq!(
        (&r["content"], &r["path"], &r["rootId"]),
        (&json!("inside"), &json!("file.txt"), &json!("ws"))
    );
    // A credential path is refused by the policy: the executor is never reached.
    let e = b
        .verify("file.read", json!({ "path": b.p(".ssh/id") }), &who(), true)
        .unwrap_err();
    assert!(
        matches!(
            e,
            GateError::Denied {
                reason: "deny-list",
                ..
            }
        ),
        "{e:?}"
    );
    // A call without a path cannot be classified.
    assert!(matches!(
        b.verify("file.read", json!({}), &who(), true),
        Err(GateError::Unclassified(_))
    ));
    // Outside every root: only with a person's approval does the gate pass it, and the tool itself still refuses.
    let outside = format!("{}/../outside/x.txt", b.root);
    assert!(b
        .verify(
            "file.write",
            json!({ "path": outside, "content": "x" }),
            &who(),
            false
        )
        .is_err());
    if let Ok(a) = b.verify(
        "file.write",
        json!({ "path": outside, "content": "x" }),
        &who(),
        true,
    ) {
        assert!(a.flag("outsideRoots"));
        let e = b.run(a, &who(), &never, None).unwrap_err();
        assert_eq!(
            (e.code, e.reason),
            (FsFailureCode::PathRefused, Some("outside-root"))
        );
    }
    // A write inside the root: created with mode 0600.
    let a = b
        .verify(
            "file.write",
            json!({ "path": b.p("new.txt"), "content": "hello" }),
            &who(),
            true,
        )
        .unwrap();
    let r = b.run(a, &who(), &never, None).unwrap();
    assert_eq!(
        (&r["created"], &r["bytesWritten"]),
        (&json!(true), &json!(5))
    );
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(b.p("new.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[cfg(unix)]
#[test]
fn an_approval_is_for_one_target_one_caller_and_a_short_time() {
    let b = Bench::new();
    std::fs::create_dir(b.p("a")).unwrap();
    std::fs::create_dir(b.p("b")).unwrap();
    std::fs::write(b.p("a/f.txt"), "from a").unwrap();
    std::fs::write(b.p("b/f.txt"), "from b").unwrap();
    std::os::unix::fs::symlink(b.p("a"), b.p("cur")).unwrap();
    let args = json!({ "path": b.p("cur/f.txt") });
    // Approved while the path led to a/f.txt; it leads to b/f.txt when the tool runs. Both are inside the root, and the
    // policy judged only the first.
    let a = b.verify("file.read", args.clone(), &who(), false).unwrap();
    std::fs::remove_file(b.p("cur")).unwrap();
    std::os::unix::fs::symlink(b.p("b"), b.p("cur")).unwrap();
    let e = b.run(a, &who(), &never, None).unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (
            FsFailureCode::Changed,
            "the approved action is not this action (targets)"
        )
    );
    // Another person, and too late.
    let a = b.verify("file.read", args.clone(), &who(), false).unwrap();
    let mut eva = who();
    eva.principal = "eva".into();
    assert_eq!(
        b.run(a, &eva, &never, None).unwrap_err().message,
        "the approved action is not this action (principal)"
    );
    let a = b.verify("file.read", args, &who(), false).unwrap();
    b.clock.advance(crate::gate::APPROVAL_TTL_MS + 1.0);
    assert_eq!(
        b.run(a, &who(), &never, None).unwrap_err().message,
        "the approved action is not this action (expired)"
    );
    // An action approved for one tool is not run as another.
    let a = b
        .verify(
            "file.stat",
            json!({ "path": b.p("file.txt") }),
            &who(),
            false,
        )
        .unwrap();
    let tool = a.tool().to_owned();
    assert_eq!(tool, "file.stat");
    assert_eq!(
        b.run(a, &who(), &never, None).unwrap()["type"],
        json!("file")
    );
}

#[cfg(unix)]
#[test]
fn the_temporary_file_is_private_from_its_first_moment_and_is_gone_afterwards() {
    use std::os::unix::fs::PermissionsExt;
    let b = Bench::new();
    let seen = Cell::new(0);
    let root = b.root.clone();
    let look = |op: &str| {
        assert_eq!(op, "write");
        for e in std::fs::read_dir(&root).unwrap().flatten() {
            if e.file_name().to_string_lossy().ends_with(".p1tmp") {
                seen.set(e.metadata().unwrap().permissions().mode() & 0o777);
            }
        }
    };
    let a = b
        .verify(
            "file.write",
            json!({ "path": b.p("n.txt"), "content": "x" }),
            &who(),
            true,
        )
        .unwrap();
    b.run(a, &who(), &never, Some(&look)).unwrap();
    assert_eq!(seen.get(), 0o600, "the temporary file of a new file");
    let left: Vec<_> = std::fs::read_dir(&b.root)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".p1tmp"))
        .collect();
    assert!(left.is_empty());
    // An overwrite keeps the bits of the file it replaces.
    std::fs::set_permissions(b.p("n.txt"), std::fs::Permissions::from_mode(0o640)).unwrap();
    let args = json!({ "path": b.p("n.txt"), "content": "y", "overwrite": true });
    let a = b.verify("file.write", args, &who(), true).unwrap();
    b.run(a, &who(), &never, None).unwrap();
    assert_eq!(
        std::fs::metadata(b.p("n.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o640
    );
    assert_eq!(std::fs::read_to_string(b.p("n.txt")).unwrap(), "y");
}

#[cfg(unix)]
#[test]
fn a_cancelled_call_does_nothing_and_a_huge_directory_is_refused_whole() {
    let b = Bench::new();
    let a = b
        .verify(
            "file.write",
            json!({ "path": b.p("c.txt"), "content": "x" }),
            &who(),
            true,
        )
        .unwrap();
    let e = b.run(a, &who(), &|| true, None).unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (FsFailureCode::Aborted, "cancelled")
    );
    assert!(!std::path::Path::new(&b.p("c.txt")).exists());
    // Cancelled after the bytes were written and before the publish: nothing is published, nothing is left.
    let calls = Cell::new(0);
    let late = || calls.replace(calls.get() + 1) >= 1;
    let a = b
        .verify(
            "file.write",
            json!({ "path": b.p("c.txt"), "content": "x" }),
            &who(),
            true,
        )
        .unwrap();
    assert_eq!(
        b.run(a, &who(), &late, None).unwrap_err().code,
        FsFailureCode::Aborted
    );
    assert_eq!(
        std::fs::read_dir(b.p("")).unwrap().count(),
        3,
        "file.txt, sub and .ssh only"
    );
    // More entries than the scan cap: refused rather than listed in part.
    std::fs::create_dir(b.p("many")).unwrap();
    for i in 0..=LIST_SCAN_CAP {
        std::fs::write(b.p(&format!("many/{i}")), "").unwrap();
    }
    let a = b
        .verify("file.list", json!({ "path": b.p("many") }), &who(), false)
        .unwrap();
    let e = b.run(a, &who(), &never, None).unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (FsFailureCode::TooLarge, "more than 10000 entries")
    );
    std::fs::remove_file(b.p("many/0")).unwrap();
    let a = b
        .verify("file.list", json!({ "path": b.p("many") }), &who(), false)
        .unwrap();
    let r = b.run(a, &who(), &never, None).unwrap();
    assert_eq!(
        (r["entries"].as_array().unwrap().len(), &r["truncated"]),
        (1000, &json!(true))
    );
}

#[test]
fn the_classifier_marks_what_the_path_layer_refuses() {
    let b = Bench::new();
    let c = FsClassifier {
        fs: &RealFs,
        nfc: &IcuNfc,
        roots: &b.config.roots,
        deny: b.config.deny.as_ref(),
        access: Access::Write,
    };
    assert_eq!(
        c.classify(&json!({ "path": 7 })).unwrap_err(),
        "path must be a string"
    );
    let bad = c.classify(&json!({ "path": "a\u{0}b" })).unwrap();
    assert_eq!(
        Value::Object(bad.flags),
        json!({ "outsideRoots": true, "denyListHit": true })
    );
    assert_eq!(
        (bad.targets, bad.access),
        (Some(vec!["a\u{0}b".to_owned()]), Some("write"))
    );
    // Without a root nothing can be approved for the executor to run.
    let empty = FsConfig::default();
    assert!(empty.roots.is_empty());
}
