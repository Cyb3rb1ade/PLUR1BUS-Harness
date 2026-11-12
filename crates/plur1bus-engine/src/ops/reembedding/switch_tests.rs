#![allow(
    clippy::panic,
    reason = "test-only malformed fixture and missed crash checkpoint failures"
)]
#![allow(
    clippy::unwrap_used,
    reason = "actual frozen Node switch and recovery observations"
)]
use super::super::state_json::normalize;
use super::*;
use crate::text::json::parse_json;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
fn f<'a>(v: &'a Json, k: &str) -> &'a Json {
    field(v, k).unwrap()
}
fn yes(v: &Json, k: &str) -> bool {
    field(v, k) == Some(&Json::Bool(true))
}
fn array(v: &Json) -> &[Json] {
    if let Json::Array(a) = v {
        a
    } else {
        panic!("array expected")
    }
}
fn fixture() -> Json {
    parse_json(include_str!(
        "../../../tests/fixtures/ops/golden/reembedding-switch.json"
    ))
    .unwrap()
}
struct Host {
    step: Json,
    calls: Mutex<Vec<Json>>,
    state_file: Option<std::path::PathBuf>,
}
impl Host {
    fn event(&self, kind: &str) {
        self.calls
            .lock()
            .unwrap()
            .push(obj(vec![("kind", string(kind))]));
    }
}
impl SwitchHost for Host {
    fn now_ms(&self) -> i64 {
        1000
    }
    fn enter(&self, _: &str, c: &Cancel) -> Result<(), Error> {
        check(c)?;
        self.event("enter");
        if yes(&self.step, "enterFails") {
            Err(Error::Host)
        } else {
            Ok(())
        }
    }
    fn exit(&self, _: &str, c: &Cancel) -> Result<(), Error> {
        check(c)?;
        self.event("exit");
        if yes(&self.step, "exitFails") {
            Err(Error::Host)
        } else {
            Ok(())
        }
    }
    fn assert_source(&self, _: &Json, c: &Cancel) -> Result<(), Error> {
        check(c)?;
        self.event("source-check");
        if yes(&self.step, "cancelAfterCheck") {
            c.cancel();
        }
        if yes(&self.step, "drift") {
            Err(Error::Host)
        } else {
            Ok(())
        }
    }
    fn mutate_selection(&self, selection: &Json, _: &Cancel) -> Result<(), Error> {
        self.calls.lock().unwrap().push(obj(vec![
            ("kind", string("mutate")),
            ("selection", selection.clone()),
        ]));
        if let Some(path) = &self.state_file {
            std::fs::write(path, b"broken state").unwrap();
            return Err(Error::Host);
        }
        if yes(&self.step, "mutationFails") {
            Err(Error::Host)
        } else {
            Ok(())
        }
    }
    fn active_generation(&self, c: &Cancel) -> Result<Option<String>, Error> {
        check(c)?;
        Ok(get_text(&self.step, "active"))
    }
    fn probe(&self, request: &Json, c: &Cancel) -> Result<Json, Error> {
        check(c)?;
        self.calls.lock().unwrap().push(obj(vec![
            ("kind", string("probe")),
            ("request", request.clone()),
        ]));
        if yes(&self.step, "probeFails") {
            return Err(Error::Provider);
        }
        Ok(field(&self.step, "probe").cloned().unwrap_or_else(|| {
            obj(vec![
                ("readiness", Json::Bool(true)),
                ("store", Json::Bool(true)),
                ("recall", Json::Bool(true)),
            ])
        }))
    }
}
fn root() -> tempfile::TempDir {
    tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
fn state(root: &std::path::Path, initial: &Json) -> Arc<MigrationStateStore> {
    let directory = root.join("control");
    std::fs::create_dir_all(&directory).unwrap();
    let id = text(initial, "id").unwrap();
    let migrations = Json::Object(vec![(id.into(), initial.clone())]);
    std::fs::write(
        directory.join("reembedding-state.json"),
        write_json(&obj(vec![
            ("schemaVersion", number(1)),
            ("revision", number(revision(initial).unwrap())),
            ("migrations", migrations),
        ])),
    )
    .unwrap();
    Arc::new(MigrationStateStore::new(root).unwrap())
}
#[test]
fn actual_node_switch_handoff_recovery_and_reverse_plans_match() {
    let fixture = fixture();
    let cases = array(f(&fixture, "cases"));
    assert_eq!(cases.len(), 20);
    let seed = super::super::state_json::integer(f(&fixture, "proofSeed")).unwrap() as u8;
    let proof = format!("reemb_v1_{}", URL_SAFE_NO_PAD.encode([seed; 32]));
    for case in cases {
        let root = root();
        let store = state(root.path(), f(case, "initial"));
        for (step, expected) in array(f(case, "steps"))
            .iter()
            .zip(array(f(case, "results")))
        {
            let host = Arc::new(Host {
                step: step.clone(),
                calls: Mutex::new(Vec::new()),
                state_file: None,
            });
            let runtime = Arc::new(SwitchRuntime::new(store.clone(), host.clone()));
            let cancel = Cancel::never();
            let actual = match get_text(step, "op").unwrap().as_str() {
                "switch" => runtime.switch(
                    "migration-switch",
                    if yes(step, "wrongProof") {
                        "invalid-proof"
                    } else {
                        &proof
                    },
                    &cancel,
                ),
                "manual" => runtime.manual_rollback(
                    "migration-switch",
                    &get_text(step, "newId").unwrap(),
                    &cancel,
                ),
                "recover" => {
                    let session = RecoverySession::new(runtime);
                    let result = session.start(&cancel);
                    let events = host.calls.lock().unwrap().len();
                    assert_eq!(session.start(&cancel), result);
                    assert_eq!(host.calls.lock().unwrap().len(), events);
                    assert_eq!(session.shutdown().is_err(), result.is_err());
                    assert_eq!(session.start(&cancel), Err(Error::Closed));
                    result.map(|r| r.unwrap_or(Json::Null))
                }
                _ => unreachable!(),
            };
            if field(expected, "error").is_some() {
                assert!(actual.is_err(), "{}", write_json(case));
            } else {
                assert_eq!(
                    normalize(&actual.unwrap(), 0).unwrap(),
                    normalize(f(expected, "value"), 0).unwrap(),
                    "{}",
                    get_text(case, "name").unwrap()
                );
            }
            assert_eq!(
                normalize(&Json::Array(host.calls.lock().unwrap().clone()), 0).unwrap(),
                normalize(f(expected, "calls"), 0).unwrap(),
                "{}",
                get_text(case, "name").unwrap()
            );
            assert_eq!(
                normalize(&store.get("migration-switch").unwrap().unwrap(), 0).unwrap(),
                normalize(f(expected, "state"), 0).unwrap(),
                "{}",
                get_text(case, "name").unwrap()
            );
        }
    }
}
#[test]
fn cancellation_and_corrupt_handoff_state_always_release_the_gate() {
    let fixture = fixture();
    let initial = f(&array(f(&fixture, "cases"))[0], "initial");
    let proof = format!("reemb_v1_{}", URL_SAFE_NO_PAD.encode([9; 32]));
    for corrupt in [false, true] {
        let root = root();
        let store = state(root.path(), initial);
        let host = Arc::new(Host {
            step: obj(vec![("cancelAfterCheck", Json::Bool(!corrupt))]),
            calls: Mutex::new(Vec::new()),
            state_file: corrupt.then(|| root.path().join("control/reembedding-state.json")),
        });
        let runtime = SwitchRuntime::new(store.clone(), host.clone());
        let cancel = Cancel::never();
        assert!(runtime.switch("migration-switch", &proof, &cancel).is_err());
        assert_eq!(
            host.calls.lock().unwrap().last().unwrap(),
            &obj(vec![("kind", string("exit"))])
        );
        if !corrupt {
            assert_eq!(
                get_text(&store.get("migration-switch").unwrap().unwrap(), "state").as_deref(),
                Some("ready_to_switch")
            );
        }
    }
}

struct CrashHost {
    root: std::path::PathBuf,
    phase: Option<String>,
}
impl CrashHost {
    fn checkpoint(&self, phase: &str) {
        if self.phase.as_deref() == Some(phase) {
            crate::store::atomic_write::atomic_write(
                &self.root.join("checkpoint"),
                phase.as_bytes(),
            )
            .unwrap();
            loop {
                std::thread::park();
            }
        }
    }
}
impl SwitchHost for CrashHost {
    fn now_ms(&self) -> i64 {
        1000
    }
    fn enter(&self, _: &str, c: &Cancel) -> Result<(), Error> {
        check(c)
    }
    fn exit(&self, _: &str, c: &Cancel) -> Result<(), Error> {
        check(c)
    }
    fn assert_source(&self, _: &Json, c: &Cancel) -> Result<(), Error> {
        check(c)
    }
    fn mutate_selection(&self, selection: &Json, c: &Cancel) -> Result<(), Error> {
        check(c)?;
        self.checkpoint("before-config");
        crate::store::atomic_write::atomic_write(
            &self.root.join("active-selection.json"),
            write_json(selection).as_bytes(),
        )
        .map_err(|_| Error::Host)?;
        self.checkpoint("after-config");
        Ok(())
    }
    fn active_generation(&self, c: &Cancel) -> Result<Option<String>, Error> {
        check(c)?;
        let path = self.root.join("active-selection.json");
        if !path.exists() {
            return Ok(None);
        }
        let value = parse_json(&std::fs::read_to_string(path).map_err(|_| Error::Host)?)
            .map_err(|_| Error::Host)?;
        Ok(get_text(&value, "generation"))
    }
    fn probe(&self, request: &Json, c: &Cancel) -> Result<Json, Error> {
        check(c)?;
        if get_text(request, "expectedGeneration").as_deref() == Some("target-generation") {
            self.checkpoint("during-target-probe");
        }
        Ok(obj(vec![
            ("readiness", Json::Bool(true)),
            ("store", Json::Bool(true)),
            ("recall", Json::Bool(true)),
        ]))
    }
}
#[test]
fn switch_crash_child() {
    let Ok(path) = std::env::var("PLUR1BUS_RX_SWITCH_CRASH_ROOT") else {
        return;
    };
    let phase = std::env::var("PLUR1BUS_RX_SWITCH_CRASH_PHASE").unwrap();
    let root = std::path::PathBuf::from(path);
    let store = Arc::new(MigrationStateStore::new(&root).unwrap());
    let host = Arc::new(CrashHost {
        root,
        phase: Some(phase),
    });
    let runtime = Arc::new(SwitchRuntime::new(store, host));
    let proof = format!("reemb_v1_{}", URL_SAFE_NO_PAD.encode([9; 32]));
    runtime
        .switch("migration-switch", &proof, &Cancel::never())
        .unwrap();
    RecoverySession::new(runtime)
        .start(&Cancel::never())
        .unwrap();
    panic!("requested crash checkpoint was not reached");
}
#[test]
fn forced_process_termination_preserves_switch_handoff_and_recovery() {
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let fixture = fixture();
    let initial = f(&array(f(&fixture, "cases"))[0], "initial");
    for phase in ["before-config", "after-config", "during-target-probe"] {
        let root = root();
        let store = state(root.path(), initial);
        drop(store);
        let mut child = Child(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "ops::reembedding::switch::tests::switch_crash_child",
                    "--nocapture",
                ])
                .env("PLUR1BUS_RX_SWITCH_CRASH_ROOT", root.path())
                .env("PLUR1BUS_RX_SWITCH_CRASH_PHASE", phase)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !root.path().join("checkpoint").is_file() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "child exited before {phase}"
            );
            assert!(
                std::time::Instant::now() < deadline,
                "checkpoint timed out: {phase}"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        child.0.kill().unwrap();
        let status = child.0.wait().unwrap();
        assert!(!status.success());
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(libc::SIGKILL));
        }
        let reopened = Arc::new(MigrationStateStore::new(root.path()).unwrap());
        assert_eq!(
            get_text(&reopened.get("migration-switch").unwrap().unwrap(), "state").as_deref(),
            Some("switching")
        );
        let host = Arc::new(CrashHost {
            root: root.path().to_owned(),
            phase: None,
        });
        let runtime = Arc::new(SwitchRuntime::new(reopened.clone(), host));
        let result = RecoverySession::new(runtime)
            .start(&Cancel::never())
            .unwrap()
            .unwrap();
        if phase == "before-config" {
            assert_eq!(get_text(&result, "state").as_deref(), Some("failed"));
            assert_eq!(
                get_text(f(&result, "error"), "code").as_deref(),
                Some("switch_target_not_activated")
            );
            assert_eq!(
                field(f(&result, "error"), "rollbackRestored"),
                Some(&Json::Bool(true))
            );
        } else {
            assert_eq!(get_text(&result, "state").as_deref(), Some("completed"));
            assert_eq!(
                get_text(f(f(&result, "receipts"), "switch"), "generation").as_deref(),
                Some("target-generation")
            );
        }
        assert_eq!(reopened.get("migration-switch").unwrap(), Some(result));
    }
}
