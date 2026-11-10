//! Real killed workers, original authority and durable recovery source checks.
use super::*;
struct Child(std::process::Child);
impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn killed(phase: &str) -> tempfile::TempDir {
    let root = physical_temp();
    let mut child = Child(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "pipeline_crash_child", "--nocapture"])
            .env("PLUR1BUS_RX_CAPTURE_CRASH_ROOT", root.path())
            .env(
                "PLUR1BUS_RX_CAPTURE_CRASH_PHASE",
                if phase == "without-run" {
                    "after-first-row"
                } else if phase == "short-deadline" {
                    "after-plan"
                } else {
                    phase
                },
            )
            .envs((phase == "without-run").then_some(("PLUR1BUS_RX_CAPTURE_WITHOUT_RUN", "1")))
            .envs(
                (phase == "short-deadline").then_some(("PLUR1BUS_RX_CAPTURE_SHORT_DEADLINE", "1")),
            )
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let end = std::time::Instant::now() + Duration::from_secs(20);
    while !root.path().join("checkpoint").exists() {
        assert!(child.0.try_wait().unwrap().is_none(), "{phase}");
        assert!(std::time::Instant::now() < end, "{phase}");
        std::thread::sleep(Duration::from_millis(10));
    }
    child.0.kill().unwrap();
    let status = child.0.wait().unwrap();
    assert!(!status.success());
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(libc::SIGKILL));
    }
    root
}
fn open(f: BoundaryFixture) -> Result<capture_pipeline_support::RuntimeGuard, EngineError> {
    let queue = Arc::new(
        queue::CaptureQueue::new(
            queue::RuntimeConfig::default(),
            Arc::new(queue::PressureSnapshot::disabled),
        )
        .unwrap(),
    );
    accept::CaptureRuntime::new(f.host, Arc::new(f.worker), queue, f.replay, false)
        .map(capture_pipeline_support::RuntimeGuard)
}
fn admission(root: &std::path::Path) -> std::path::PathBuf {
    std::fs::read_dir(root.join("stores/_capture-admissions"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|x| x == "json"))
        .unwrap()
}
#[test]
fn opening_runtime_recovers_original_capture_without_a_new_turn_from_the_host() {
    for phase in [
        "after-plan",
        "after-first-row",
        "after-settle",
        "without-run",
    ] {
        let root = killed(phase);
        let f = BoundaryFixture::new(root.path(), "");
        let stores = f.stores.clone();
        let effects = f.effects.clone();
        let runtime = open(f).unwrap();
        let rows = stores
            .get("capture-agent")
            .unwrap()
            .scan(&store::RowFilter::default(), 100)
            .unwrap();
        assert_eq!(rows.len(), 2, "{phase}");
        assert!(rows.iter().any(|r| r.text == FIRST_TEXT));
        assert!(rows.iter().any(|r| r.text == SECOND_TEXT));
        assert_eq!(effects.load(Ordering::SeqCst), 1, "{phase}");
        assert!(runtime.0.close(Duration::from_secs(5)));
        let cleared: serde_json::Value =
            serde_json::from_slice(&std::fs::read(admission(root.path())).unwrap()).unwrap();
        assert_eq!(cleared, serde_json::json!({"record":null}));
        let second = BoundaryFixture::new(root.path(), "");
        let effects = second.effects.clone();
        drop(open(second).unwrap());
        assert_eq!(effects.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn startup_refuses_modified_record_caller_config_model_and_physical_workspace() {
    for kind in [
        "version",
        "caller",
        "config",
        "model",
        "row-id",
        "row-hash",
        "workspace",
        "options",
        "unknown-field",
    ] {
        let root = killed("after-first-row");
        let path = admission(root.path());
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        match kind {
            "version" => value["record"]["version"] = 2.into(),
            "caller" => {
                value["record"]["turn"]["principal"]["chat"]["id"] = "different-chat".into()
            }
            "config" => value["record"]["config"] = "0".repeat(64).into(),
            "model" => value["record"]["space"] = "0".repeat(64).into(),
            "row-id" => {
                value["record"]["rows"]["foreign-id"] = "0".repeat(64).into();
            }
            "row-hash" => {
                let key = value["record"]["rows"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .next()
                    .unwrap()
                    .clone();
                value["record"]["rows"][key] = "0".repeat(64).into();
            }
            "workspace" => {
                std::fs::rename(
                    root.path().join("workspace"),
                    root.path().join("prior-workspace"),
                )
                .unwrap();
                std::fs::create_dir(root.path().join("workspace")).unwrap();
            }
            "options" => value["record"]["options"]["invented"] = true.into(),
            _ => value["record"]["unexpected"] = true.into(),
        }
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let f = BoundaryFixture::new(root.path(), "");
        let before = f.rows();
        let stores = f.stores.clone();
        assert!(open(f).is_err(), "{kind}");
        let after = stores
            .get("capture-agent")
            .unwrap()
            .scan(&store::RowFilter::default(), 100)
            .unwrap();
        assert_eq!(after.len(), before.len(), "{kind}");
        assert_eq!(after[0].id, before[0].id, "{kind}");
        assert_eq!(
            std::fs::read(&path).unwrap(),
            serde_json::to_vec(&value).unwrap(),
            "{kind}"
        );
    }
}
#[test]
fn edited_lance_row_blocks_primary_cleanup_and_post_store_reentry() {
    for phase in ["after-first-row", "after-settle"] {
        let root = killed(phase);
        let f = BoundaryFixture::new(root.path(), "");
        let stores = f.stores.clone();
        let mut row = f.rows()[0].clone();
        row.text.push_str(" Human revision.");
        stores
            .get("capture-agent")
            .unwrap()
            .upsert(std::slice::from_ref(&row))
            .unwrap();
        assert!(open(f).is_err(), "{phase}");
        assert_eq!(
            stores
                .get("capture-agent")
                .unwrap()
                .get(&row.id)
                .unwrap()
                .unwrap()
                .text,
            row.text
        );
    }
}
#[test]
fn changed_effective_configuration_and_revoked_capture_policy_preserve_pending_work() {
    for revoked in [false, true] {
        let root = killed("after-first-row");
        let extra = if revoked {
            serde_json::json!({})
        } else {
            serde_json::json!({"duplicateThreshold":0.5})
        };
        let f = BoundaryFixture::configured(root.path(), "", extra, None);
        let stores = f.stores.clone();
        let path = admission(root.path());
        let original = std::fs::read(&path).unwrap();
        if revoked {
            plur1bus_engine::ops::workspace_policy::PolicyStore::new(&root.path().join("stores")).unwrap()
                .set(&serde_json::json!({"agentId":"capture-agent","workspaceIdentity":f.context.workspace_key,"enabled":false,"expectedRevision":0,"actorId":"fixture-controller"}),1_710_000_000_001).unwrap();
        }
        assert!(open(f).is_err());
        assert_eq!(std::fs::read(path).unwrap(), original);
        assert_eq!(
            stores
                .get("capture-agent")
                .unwrap()
                .count(&store::RowFilter::default())
                .unwrap(),
            1
        );
    }
}

#[test]
fn oversized_duplicate_and_linked_admission_files_refuse_before_lance_mutation() {
    for kind in ["oversize", "duplicate", "symlink", "hardlink"] {
        let root = killed("after-first-row");
        let path = admission(root.path());
        let original = std::fs::read(&path).unwrap();
        match kind {
            "oversize" => std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_len(64 * 1024 * 1024 + 1)
                .unwrap(),
            "duplicate" => std::fs::write(&path, b"{\"record\":null,\"record\":null}").unwrap(),
            "hardlink" => {
                std::fs::hard_link(&path, root.path().join("other.json")).unwrap();
            }
            _ => {
                #[cfg(unix)]
                {
                    std::fs::rename(&path, root.path().join("other.json")).unwrap();
                    std::os::unix::fs::symlink(root.path().join("other.json"), &path).unwrap();
                }
                #[cfg(not(unix))]
                {
                    continue;
                }
            }
        }
        let f = BoundaryFixture::new(root.path(), "");
        let stores = f.stores.clone();
        assert!(open(f).is_err(), "{kind}");
        assert_eq!(
            stores
                .get("capture-agent")
                .unwrap()
                .count(&store::RowFilter::default())
                .unwrap(),
            1
        );
        if matches!(kind, "symlink" | "hardlink") {
            assert_eq!(
                std::fs::read(root.path().join("other.json")).unwrap(),
                original
            );
        }
    }
}

#[test]
fn another_authorized_chat_cannot_borrow_an_original_pending_capture() {
    let root = killed("after-first-row");
    let mut f = BoundaryFixture::new(root.path(), "");
    let path = admission(root.path());
    let original = std::fs::read(&path).unwrap();
    let original_row = f.rows()[0].id.clone();
    let mut value = serde_json::to_value(&f.turn).unwrap();
    value["principal"]["chat"]["id"] = "later-allowed-chat".into();
    f.turn = serde_json::from_value(value).unwrap();
    f.context =
        context::RequestContext::build(&f.turn.principal, &f.turn.agent, f.host.as_ref()).unwrap();
    assert!(f.run().is_err());
    assert_eq!(f.rows().len(), 1);
    assert_eq!(f.rows()[0].id, original_row);
    assert_eq!(std::fs::read(path).unwrap(), original);
}

#[test]
fn an_unknown_post_store_implementation_cannot_claim_replay_safety() {
    let root = killed("after-settle");
    let mut f = BoundaryFixture::new(root.path(), "");
    let stores = f.stores.clone();
    let path = admission(root.path());
    let before = std::fs::read(&path).unwrap();
    f.worker = pipeline::CapturePipeline::new(
        f.host.clone(),
        stores.clone(),
        Arc::new(capture_pipeline_support::HashEmbedder::new(false)),
        Arc::new(ClassificationFixture(BTreeMap::new())),
        Arc::new(shared_scope::WorkspaceCapturePolicy::new(
            root.path().join("stores"),
        )),
    )
    .unwrap();
    assert!(open(f).is_err());
    assert_eq!(
        stores
            .get("capture-agent")
            .unwrap()
            .count(&store::RowFilter::default())
            .unwrap(),
        2
    );
    let after: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let before: serde_json::Value = serde_json::from_slice(&before).unwrap();
    assert_eq!(after["record"]["turn"], before["record"]["turn"]);
    assert_eq!(after["record"]["classifierDone"], false);
}

#[test]
fn an_observed_caller_abort_does_not_restart_automatically() {
    let root = physical_temp();
    let f = BoundaryFixture::new(root.path(), "abort-after-first-row");
    assert!(matches!(f.run(), Err(EngineError::Cancelled(_))));
    assert_eq!(f.rows().len(), 1);
    let id = f.rows()[0].id.clone();
    drop(f);
    let next = BoundaryFixture::new(root.path(), "");
    let stores = next.stores.clone();
    let effects = next.effects.clone();
    drop(open(next).unwrap());
    let rows = stores
        .get("capture-agent")
        .unwrap()
        .scan(&store::RowFilter::default(), 100)
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, id);
    assert_eq!(effects.load(Ordering::SeqCst), 0);
}

#[test]
fn startup_deadline_retains_original_input_for_a_later_recovery_attempt() {
    let root = killed("short-deadline");
    let f = BoundaryFixture::configured(
        root.path(),
        "expire-recovery",
        serde_json::json!({"runtime":{"captureTimeoutMs":20}}),
        None,
    );
    let stores = f.stores.clone();
    assert!(open(f).is_err());
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(admission(root.path())).unwrap()).unwrap();
    assert!(value["record"].is_object());
    assert_eq!(
        value["record"]["turn"]["messages"][0]["content"],
        FIRST_TEXT
    );
    assert_eq!(
        stores
            .get("capture-agent")
            .unwrap()
            .count(&store::RowFilter::default())
            .unwrap(),
        0
    );
}

fn pending(root: &std::path::Path) -> serde_json::Value {
    serde_json::from_slice::<serde_json::Value>(&std::fs::read(admission(root)).unwrap()).unwrap()
        ["record"]
        .clone()
}

#[test]
fn a_terminal_post_store_refusal_closes_the_admission_and_reopens_cleanly() {
    let root = physical_temp();
    let f = BoundaryFixture::new(root.path(), "terminal-post");
    let result = serde_json::to_value(f.run().unwrap()).unwrap();
    assert_eq!(result, serde_json::json!({"stored":2,"skipped":0}));
    assert_eq!(f.rows().len(), 2);
    assert_eq!(f.effects.load(Ordering::SeqCst), 1);
    assert!(pending(root.path()).is_null());
    drop(f);
    let next = BoundaryFixture::new(root.path(), "terminal-post");
    let effects = next.effects.clone();
    let runtime = open(next).unwrap();
    assert!(runtime.0.close(Duration::from_secs(5)));
    assert_eq!(effects.load(Ordering::SeqCst), 0);
}

#[test]
fn a_transient_post_store_failure_stays_pending_and_is_recovered_once() {
    let root = physical_temp();
    let f = BoundaryFixture::new(root.path(), "transient-post-once");
    assert_eq!(serde_json::to_value(f.run().unwrap()).unwrap()["stored"], 2);
    let record = pending(root.path());
    assert_eq!(record["classifierDone"], false);
    assert!(record.get("postSkipped").is_none());
    drop(f);
    let next = BoundaryFixture::new(root.path(), "transient-post-once");
    let effects = next.effects.clone();
    drop(open(next).unwrap());
    assert_eq!(effects.load(Ordering::SeqCst), 1);
    assert!(pending(root.path()).is_null());
    let again = BoundaryFixture::new(root.path(), "transient-post-once");
    let effects = again.effects.clone();
    drop(open(again).unwrap());
    assert_eq!(effects.load(Ordering::SeqCst), 0);
}

#[test]
fn a_pending_entry_refused_terminally_on_recovery_is_closed_exactly_once() {
    let root = physical_temp();
    let f = BoundaryFixture::new(root.path(), "transient-post-once");
    f.run().unwrap();
    assert!(pending(root.path()).is_object());
    drop(f);
    // The retained entry's post-store step is now refused terminally.
    let next = BoundaryFixture::new(root.path(), "terminal-post");
    let effects = next.effects.clone();
    let stores = next.stores.clone();
    drop(open(next).unwrap());
    assert_eq!(effects.load(Ordering::SeqCst), 1);
    assert!(pending(root.path()).is_null());
    assert_eq!(
        stores
            .get("capture-agent")
            .unwrap()
            .count(&store::RowFilter::default())
            .unwrap(),
        2
    );
    let last = BoundaryFixture::new(root.path(), "terminal-post");
    let effects = last.effects.clone();
    drop(open(last).unwrap());
    assert_eq!(effects.load(Ordering::SeqCst), 0);
}
