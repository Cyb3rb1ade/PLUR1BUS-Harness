//! `exec.run` against real processes (`test/tools/exec/real.test.ts`), and the gate with the real classifier in front of
//! the executor (`replay.test.ts`: the binding to the working directory and the environment).
//!
//! The program every test starts is this test binary itself, the one program that exists wherever the tests run. Started
//! with `P4K_CHILD_ROLE` in its environment, the test `child_role` plays the child (prints what it was given, floods its
//! output, starts a grandchild, sleeps) and exits; without it that test does nothing. Every process runs in the test's
//! own temporary directory; nothing uses the network.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::process::doubles::{ScriptedPort, Stage, Step};
use super::process::OsProcessPort;
use super::*;
use crate::gate::doubles::{MemoryAudit, Permits, SetClock};
use crate::gate::{Gate, GatedTool, UnverifiedAction};
use plur1bus_core::policy::fs_paths::RealFs;
use plur1bus_core::policy::paths::IcuNfc;
use std::cell::Cell;
use std::io::Write as _;
use std::rc::Rc;

const ROLE: &str = "P4K_CHILD_ROLE";
const INHERITED: &str = "inherited-marker-value";
type Env = Vec<(String, Option<String>)>;

#[test]
fn child_role() {
    let Ok(role) = std::env::var(ROLE) else {
        return; // an ordinary test run: nothing to play
    };
    let mut out = std::io::stdout();
    match role.as_str() {
        "show" => {
            let argv: Vec<String> = std::env::args().skip(4).collect();
            let env: Vec<(String, String)> = std::env::vars().collect();
            writeln!(out, "CHILD:{}", json!({ "argv": argv, "env": env })).unwrap();
        }
        "flood" => out.write_all(&vec![b'x'; 2_000_000]).unwrap(),
        "tree" => {
            let me = std::env::current_exe().unwrap();
            let mut g = std::process::Command::new(me)
                .args(["exec::tests::child_role", "--exact", "--nocapture"])
                .env(ROLE, "sleep")
                .spawn()
                .unwrap();
            std::fs::write("grandchild.pid", g.id().to_string()).unwrap();
            // Both are killed long before this returns.
            let _ = g.wait();
        }
        _ => std::thread::sleep(std::time::Duration::from_secs(60)),
    }
    out.flush().unwrap();
    std::process::exit(0);
}

struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> f64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
    }
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

struct Bench {
    _dir: tempfile::TempDir,
    root: String,
    work: String,
    base_env: Env,
    config: ExecConfig,
}

impl Bench {
    fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("p4k-exec-real-")
            .tempdir()
            .unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        // Windows: the resolver answers with the `\\?\` form; the path layer wants the plain one.
        let root = root
            .to_str()
            .unwrap()
            .trim_start_matches(r"\\?\")
            .to_owned();
        let work = std::path::Path::new(&root).join("work");
        std::fs::create_dir(&work).unwrap();
        // The real environment (the child needs the system's own variables), plus values that must never arrive.
        let mut base_env: Env = std::env::vars().map(|(k, v)| (k, Some(v))).collect();
        for name in [
            "SECRET_TOKEN",
            "API_KEY",
            "DB_PASSWORD",
            "PATH_TOKEN",
            "HOME",
            "EDITOR",
        ] {
            base_env.retain(|(k, _)| k != name);
            base_env.push((name.to_owned(), Some(INHERITED.to_owned())));
        }
        let mut allow: Vec<String> = env::DEFAULT_ENV_ALLOW
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        // Allowlisted by the person, and still not inherited: the name looks like a credential.
        allow.extend([
            ROLE.to_owned(),
            "API_KEY".to_owned(),
            "PATH_TOKEN".to_owned(),
        ]);
        Bench {
            _dir: dir,
            root: root.clone(),
            work: work.to_str().unwrap().to_owned(),
            base_env,
            config: ExecConfig {
                mode: Some("ask".into()),
                roots: vec![PathRoot {
                    id: "r".into(),
                    path: root,
                    identity: None,
                }],
                env_allow: Some(allow),
                ..ExecConfig::default()
            },
        }
    }

    fn call(&self, role: &str, extra: &[&str], more: &Value) -> Value {
        let me = std::env::current_exe().unwrap();
        let mut argv = vec!["exec::tests::child_role", "--exact", "--nocapture"];
        argv.extend(extra);
        let mut args = json!({ "program": me.to_str().unwrap(), "args": argv, "cwd": self.work, "env": { ROLE: role } });
        for (k, v) in more.as_object().unwrap() {
            args[k] = v.clone();
        }
        args
    }

    /// The gate with the real classifier of `exec.run`, a person who approves, then the approved action.
    fn approve(&self, args: &Value, clock: &dyn Clock, who: &Caller) -> ApprovedAction {
        let allow = self.config.env_allow();
        let classifier = ExecClassifier {
            fs: &RealFs,
            nfc: &IcuNfc,
            roots: &self.config.roots,
            deny: None,
            env_allow: &allow,
            base_env: &self.base_env,
            sandboxed: true,
            platform: None,
        };
        let tools = [GatedTool {
            name: "exec.run",
            capability: "shell.exec",
            effect: "local-write",
            risk: "medium",
            classifier: Some(&classifier),
        }];
        let mut audit = MemoryAudit::default();
        let mut permits = Permits::approving();
        Gate::new(&tools, clock, &mut audit, &mut permits)
            .verify(
                UnverifiedAction {
                    tool: "exec.run".into(),
                    args: args.clone(),
                    call_id: "c1".into(),
                    reason: None,
                    diff: None,
                },
                who,
            )
            .unwrap()
    }

    fn run(
        &self,
        args: &Value,
        aborted: &dyn Fn() -> bool,
    ) -> (Result<ExecResult, ExecFailure>, Vec<AuditEvent>) {
        let clock = SystemClock;
        let approved = self.approve(args, &clock, &who());
        let mut events: Vec<AuditEvent> = Vec::new();
        let mut sink = |e: &AuditEvent| -> Result<(), String> {
            events.push(e.clone());
            Ok(())
        };
        let r = ExecTool {
            config: self.config.clone(),
            ports: ExecPorts {
                fs: &RealFs,
                nfc: &IcuNfc,
                process: &OsProcessPort,
                clock: &clock,
                audit: &mut sink,
                base_env: &self.base_env,
                aborted,
                known_secrets: None,
            },
            platform: None,
            host: None,
        }
        .execute(approved, &who());
        (r, events)
    }
}

fn never() -> bool {
    false
}

#[test]
fn a_real_child_gets_its_arguments_literally_and_no_inherited_secret() {
    let b = Bench::new();
    let extra = [
        "; touch pwned",
        "$(touch pwned)",
        "`touch pwned`",
        "a && b",
        "*",
        "%PATH%",
        "a\"b",
    ];
    let (r, events) = b.run(&b.call("show", &extra, &json!({})), &never);
    let r = r.unwrap();
    assert_eq!(
        (r.exit_code, r.timed_out, r.aborted),
        (Some(0), false, false),
        "{}",
        r.stderr
    );
    let line = r
        .stdout
        .lines()
        .find_map(|l| l.strip_prefix("CHILD:"))
        .unwrap_or_else(|| panic!("no child line in {:?}", r.stdout));
    let seen: Value = serde_json::from_str(line).unwrap();
    assert_eq!(seen["argv"], json!(extra), "no shell touched the arguments");
    assert!(!std::path::Path::new(&b.work).join("pwned").exists());
    let env: Vec<(String, String)> = serde_json::from_value(seen["env"].clone()).unwrap();
    // No value of the inherited environment that was marked arrived, under any name.
    assert!(env.iter().all(|(_, v)| !v.contains(INHERITED)), "{env:?}");
    for (name, _) in &env {
        assert!(!env::is_secretish_name(name), "{name} reached the child");
        // Only what is on the allowlist is there at all. The systems add names of their own to every process, which
        // is not inheritance: Windows several, macOS `__CF_USER_TEXT_ENCODING` (written by its runtime at start).
        if cfg!(unix) && name != "__CF_USER_TEXT_ENCODING" {
            assert!(
                b.config.env_allow().iter().any(|a| a == name),
                "{name} is not on the allowlist"
            );
        }
    }
    assert!(env.iter().any(|(k, v)| k == ROLE && v == "show"));
    // HOME and EDITOR were in the inherited environment and are not on the allowlist.
    assert!(env.iter().all(|(k, _)| k != "HOME" && k != "EDITOR"));
    // The audit lines carry names, never values or argument text.
    let text = format!("{events:?}");
    assert!(!text.contains(INHERITED) && !text.contains("touch pwned"));
    assert_eq!(
        events.iter().map(|e| e.action.as_str()).collect::<Vec<_>>(),
        ["exec.run", "exec.result"]
    );
}

#[test]
fn large_real_output_is_cut_and_does_not_block_the_child() {
    let b = Bench::new();
    let (r, _) = b.run(
        &b.call("flood", &[], &json!({ "maxOutputBytes": 1000 })),
        &never,
    );
    let r = r.unwrap();
    assert_eq!(
        (r.stdout.len(), r.stdout_truncated, r.exit_code),
        (1000, true, Some(0))
    );
    assert!(r.stdout.ends_with("xxxx"));
}

// Unix only: the test asks the kernel whether the grandchild is alive (signal 0), which has no counterpart in `std` on
// Windows; there the tree is ended by `taskkill /T`, which the TypeScript suite covers with a runner double.
#[cfg(unix)]
#[test]
fn a_timeout_ends_the_child_and_its_grandchild() {
    let b = Bench::new();
    let (r, events) = b.run(&b.call("tree", &[], &json!({ "timeoutMs": 1500 })), &never);
    let r = r.unwrap();
    assert_eq!(
        (r.timed_out, r.exit_code, r.signal.as_deref()),
        (true, None, Some("SIGKILL"))
    );
    assert!(
        r.duration_ms >= 1500.0 && r.duration_ms < 15_000.0,
        "{}",
        r.duration_ms
    );
    let pid: i32 = std::fs::read_to_string(std::path::Path::new(&b.work).join("grandchild.pid"))
        .unwrap()
        .parse()
        .unwrap();
    let pid = rustix::process::Pid::from_raw(pid).unwrap();
    let mut alive = true;
    for _ in 0..100 {
        if rustix::process::test_kill_process(pid).is_err() {
            alive = false;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(!alive, "the grandchild must be gone");
    assert_eq!(
        events[1].detail[1],
        ("outcome".to_owned(), json!("timeout"))
    );
}

#[test]
fn an_abort_ends_a_real_child() {
    let b = Bench::new();
    let asked = Cell::new(0);
    // Not aborted when the run begins; aborted once the child is running.
    let aborted = || asked.replace(asked.get() + 1) > 3;
    let (r, _) = b.run(&b.call("sleep", &[], &json!({})), &aborted);
    let r = r.unwrap();
    assert!(r.aborted && !r.timed_out);
    assert!(r.duration_ms < 20_000.0);
}

#[test]
fn a_program_that_cannot_be_started_is_a_spawn_failure_with_both_audit_lines() {
    let b = Bench::new();
    let missing = std::path::Path::new(&b.work).join("no-such-program");
    let args = json!({ "program": missing.to_str().unwrap(), "cwd": b.work });
    let (r, events) = b.run(&args, &never);
    let e = r.unwrap_err();
    assert_eq!(e.code, ExecFailureCode::SpawnFailed);
    assert_eq!(
        e.message,
        format!("spawn {} ENOENT", missing.to_str().unwrap())
    );
    assert_eq!(
        events.iter().map(|e| e.action.as_str()).collect::<Vec<_>>(),
        ["exec.run", "exec.result"]
    );
}

// --- the gate in front of the executor ------------------------------------------------------------------------------------------

/// Verify with `b`, then execute with what `change` made of the surroundings; the result, the spawns, the audit lines.
fn verify_then(
    b: &Bench,
    change: impl FnOnce(&mut Env, &mut Caller, &SetClock),
) -> (Result<ExecResult, ExecFailure>, usize, Vec<AuditEvent>) {
    let stage = Rc::new(Stage::default());
    stage.clock.0.set(1_000_000.0);
    let args =
        json!({ "program": "git", "args": ["status"], "cwd": b.work, "env": { "LANG": "C" } });
    let approved = b.approve(&args, &stage.clock, &who());
    let mut base_env = b.base_env.clone();
    let mut caller = who();
    change(&mut base_env, &mut caller, &stage.clock);
    let port = ScriptedPort {
        stage: Rc::clone(&stage),
        script: vec![Step::Exit(0)],
        spawn_fails: None,
    };
    let mut events: Vec<AuditEvent> = Vec::new();
    let mut sink = |e: &AuditEvent| -> Result<(), String> {
        events.push(e.clone());
        Ok(())
    };
    let r = ExecTool {
        config: b.config.clone(),
        ports: ExecPorts {
            fs: &RealFs,
            nfc: &IcuNfc,
            process: &port,
            clock: &stage.clock,
            audit: &mut sink,
            base_env: &base_env,
            aborted: &never,
            known_secrets: None,
        },
        platform: None,
        host: None,
    }
    .execute(approved, &caller);
    let spawned = stage.spawned.borrow().len();
    (r, spawned, events)
}

#[test]
fn the_approved_action_runs_once_for_what_was_approved() {
    let b = Bench::new();
    let (r, spawned, events) = verify_then(&b, |_, _, _| {});
    assert_eq!(r.unwrap().exit_code, Some(0));
    assert_eq!(spawned, 1);
    assert_eq!(events[0].action, "exec.run");
}

#[test]
fn an_environment_that_changed_since_the_approval_starts_nothing() {
    // The approval covers the values the child would get: PATH=/usr/bin is another action than PATH=/tmp/evil.
    let b = Bench::new();
    let (r, spawned, events) = verify_then(&b, |env, _, _| {
        env.retain(|(k, _)| k != "PATH");
        env.push(("PATH".into(), Some("/tmp/evil".into())));
    });
    let e = r.unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (
            ExecFailureCode::EnvRefused,
            "environment no longer matches the classified call"
        )
    );
    assert_eq!(spawned, 0);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].action, "exec.refused");
}

#[cfg(unix)]
#[test]
fn a_working_directory_that_resolves_elsewhere_since_the_approval_starts_nothing() {
    let b = Bench::new();
    let work = b.work.clone();
    let other = format!("{}/other", b.root);
    std::fs::create_dir(&other).unwrap();
    let (r, spawned, _) = verify_then(&b, |_, _, _| {
        std::fs::rename(&work, format!("{work}.old")).unwrap();
        std::os::unix::fs::symlink(&other, &work).unwrap();
    });
    let e = r.unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (
            ExecFailureCode::CwdRefused,
            "cwd no longer matches the classified call"
        )
    );
    assert_eq!(spawned, 0);
}

#[test]
fn an_approval_for_someone_else_or_from_too_long_ago_starts_nothing() {
    let b = Bench::new();
    type Change = Box<dyn FnOnce(&mut Env, &mut Caller, &SetClock)>;
    let cases: Vec<(Change, &str)> = vec![
        (Box::new(|_, c, _| c.principal = "eva".into()), "principal"),
        (Box::new(|_, c, _| c.agent_id = "pi".into()), "agent"),
        (
            Box::new(|_, c, _| c.session_id = Some("s2".into())),
            "session",
        ),
        (
            Box::new(|_, _, clock| clock.advance(crate::gate::APPROVAL_TTL_MS + 1.0)),
            "expired",
        ),
    ];
    for (change, part) in cases {
        let (r, spawned, events) = verify_then(&b, change);
        let e = r.unwrap_err();
        assert_eq!(e.code, ExecFailureCode::PolicyDenied, "{part}");
        assert_eq!(
            e.message,
            format!("the approved action is not this action ({part})")
        );
        assert_eq!(spawned, 0, "{part}");
        assert_eq!(
            events[0].detail.last().unwrap(),
            &("binding".to_owned(), json!(part))
        );
    }
}

#[test]
fn the_classifier_judges_the_working_directory_and_binds_the_environment() {
    let b = Bench::new();
    let allow = b.config.env_allow();
    let classifier = |sandboxed| ExecClassifier {
        fs: &RealFs,
        nfc: &IcuNfc,
        roots: &b.config.roots,
        deny: None,
        env_allow: &allow,
        base_env: &b.base_env,
        sandboxed,
        platform: None,
    };
    let inside = classifier(true)
        .classify(&json!({ "program": "git", "cwd": b.work }))
        .unwrap();
    assert_eq!(inside.targets, Some(vec![b.work.clone()]));
    assert_eq!(inside.access, Some("write"));
    assert_eq!(
        Value::Object(inside.flags.clone()),
        json!({ "outsideRoots": false, "denyListHit": false, "sandboxed": true })
    );
    // Another environment is another hash extra; the same one is the same.
    let other = classifier(true)
        .classify(&json!({ "program": "git", "cwd": b.work, "env": { "LANG": "C" } }))
        .unwrap();
    assert_ne!(inside.hash_extra, other.hash_extra);
    assert_eq!(
        inside.hash_extra,
        classifier(false)
            .classify(&json!({ "cwd": b.work }))
            .unwrap()
            .hash_extra
    );
    // Outside every root: classified as such (the policy asks), not refused here.
    let parent = std::path::Path::new(&b.root).parent().unwrap();
    if let Ok(c) = classifier(false).classify(&json!({ "cwd": parent.to_str().unwrap() })) {
        assert_eq!(c.flags["outsideRoots"], json!(true));
        assert_eq!(c.flags["sandboxed"], json!(false));
    }
    for (args, want) in [
        (json!({ "cwd": 7 }), "cwd must be a string"),
        (json!(["x"]), "cwd must be a string"),
        (json!({ "cwd": "relative" }), "cwd refused: relative-no-cwd"),
        (
            json!({ "cwd": b.work, "env": { "HOME": "/x" } }),
            "environment variable HOME is not on the allowlist",
        ),
        (json!({ "cwd": b.work, "env": [] }), "env must be an object"),
    ] {
        assert_eq!(
            classifier(true).classify(&args).unwrap_err(),
            want,
            "{args}"
        );
    }
}
