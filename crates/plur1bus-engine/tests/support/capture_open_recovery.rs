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
        // RE-D159: a completed admission leaves no file behind.
        assert!(retained(root.path()).is_none(), "{phase}");
        let second = BoundaryFixture::new(root.path(), "");
        let effects = second.effects.clone();
        drop(open(second).unwrap());
        assert_eq!(effects.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn modified_records_never_mutate_lance_and_never_block_the_runtime() {
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
        // RE-D156: one record never fails the runtime. A malformed file is kept untouched;
        // a well-formed record whose caller, configuration, vector space, workspace or row
        // no longer matches is closed terminally. Lance is never mutated.
        let runtime = open(f).unwrap();
        assert!(runtime.0.close(Duration::from_secs(5)), "{kind}");
        let after = stores
            .get("capture-agent")
            .unwrap()
            .scan(&store::RowFilter::default(), 100)
            .unwrap();
        assert_eq!(after.len(), before.len(), "{kind}");
        assert_eq!(after[0].id, before[0].id, "{kind}");
        let malformed = matches!(kind, "version" | "row-id" | "options" | "unknown-field");
        if malformed {
            let now = std::fs::read(&path).unwrap();
            assert_eq!(now, serde_json::to_vec(&value).unwrap(), "{kind}");
        } else {
            // Every well-formed mismatch, the caller included (the file name holds no caller
            // digest since RE-D159, so the record is found and assessed), is closed: removed.
            assert!(!path.exists(), "{kind}");
        }
    }
}
#[test]
fn an_edited_lance_row_closes_its_entry_without_cleanup_or_reentry() {
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
        let effects = f.effects.clone();
        drop(open(f).unwrap());
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
        // The human edit is kept; the entry is closed terminally, its effects never re-run.
        assert_eq!(effects.load(Ordering::SeqCst), 0, "{phase}");
        assert!(pending(root.path()).is_null(), "{phase}");
    }
}
#[test]
fn changed_effective_configuration_and_revoked_capture_policy_close_the_entry() {
    for revoked in [false, true] {
        let root = killed("after-first-row");
        let extra = if revoked {
            serde_json::json!({})
        } else {
            serde_json::json!({"duplicateThreshold":0.5})
        };
        let f = BoundaryFixture::configured(root.path(), "", extra, None);
        let stores = f.stores.clone();
        if revoked {
            plur1bus_engine::ops::workspace_policy::PolicyStore::new(&root.path().join("stores")).unwrap()
                .set(&serde_json::json!({"agentId":"capture-agent","workspaceIdentity":f.context.workspace_key,"enabled":false,"expectedRevision":0,"actorId":"fixture-controller"}),1_710_000_000_001).unwrap();
        }
        // RE-D156: closed terminally, the retained turn content is discarded and the row
        // written before the crash stays, as at the pin.
        drop(open(f).unwrap());
        assert!(pending(root.path()).is_null(), "{revoked}");
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
fn oversized_duplicate_and_linked_admission_files_are_kept_without_lance_mutation() {
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
        // RE-D156: an unreadable file is never recovered and never blocks the runtime.
        drop(open(f).unwrap());
        assert!(path.symlink_metadata().is_ok(), "{kind}");
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
fn an_unknown_post_store_implementation_closes_its_step_instead_of_replaying() {
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
    // The classifier cannot prove replay safety: that is a library limit, so the step is
    // closed with a fixed reason (RE-D156) and never re-entered; the stored rows stay.
    drop(open(f).unwrap());
    assert_eq!(
        stores
            .get("capture-agent")
            .unwrap()
            .count(&store::RowFilter::default())
            .unwrap(),
        2
    );
    let before: serde_json::Value = serde_json::from_slice(&before).unwrap();
    assert!(before["record"].is_object());
    assert!(pending(root.path()).is_null());
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

/// RE-D159: running out of the owner's own recovery budget defers its input; the runtime opens.
#[test]
fn startup_deadline_defers_original_input_without_failing_the_runtime() {
    let root = killed("short-deadline");
    let f = BoundaryFixture::configured(
        root.path(),
        "expire-recovery",
        serde_json::json!({"runtime":{"captureTimeoutMs":20}}),
        None,
    );
    let stores = f.stores.clone();
    let runtime = open(f).unwrap();
    assert!(runtime.0.close(Duration::from_secs(5)));
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

/// The retained record, or null once it is closed (RE-D159: a closed file is removed).
fn pending(root: &std::path::Path) -> serde_json::Value {
    retained(root).map_or(serde_json::Value::Null, |path| {
        serde_json::from_slice::<serde_json::Value>(&std::fs::read(path).unwrap()).unwrap()
            ["record"]
            .clone()
    })
}
/// The admission file still on disk, if any.
fn retained(root: &std::path::Path) -> Option<std::path::PathBuf> {
    std::fs::read_dir(root.join("stores/_capture-admissions"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|x| x == "json"))
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

/// A workspace policy whose maintenance state a test switches on and off.
struct Maintenance(
    Arc<std::sync::atomic::AtomicBool>,
    shared_scope::WorkspaceCapturePolicy,
);
impl shared_scope::CapturePolicy for Maintenance {
    fn allowed(&self, context: &context::RequestContext) -> Result<bool, EngineError> {
        if self.0.load(Ordering::SeqCst) {
            return Ok(false);
        }
        self.1.allowed(context)
    }
    fn decision(
        &self,
        context: &context::RequestContext,
    ) -> Result<shared_scope::PolicyDecision, EngineError> {
        if self.0.load(Ordering::SeqCst) {
            return Ok(shared_scope::PolicyDecision::Maintenance);
        }
        self.1.decision(context)
    }
}

#[test]
fn maintenance_keeps_a_retained_entry_until_it_ends() {
    let root = killed("after-first-row");
    let mut f = BoundaryFixture::new(root.path(), "");
    let stores = f.stores.clone();
    let active = Arc::new(std::sync::atomic::AtomicBool::new(true));
    f.worker = pipeline::CapturePipeline::new(
        f.host.clone(),
        stores.clone(),
        Arc::new(capture_pipeline_support::HashEmbedder::new(false)),
        Arc::new(BoundaryClassifier {
            root: root.path().to_owned(),
            phase: String::new(),
            calls: AtomicUsize::new(0),
            effects: f.effects.clone(),
        }),
        Arc::new(Maintenance(
            active.clone(),
            shared_scope::WorkspaceCapturePolicy::new(root.path().join("stores")),
        )),
    )
    .unwrap();
    // During maintenance the runtime opens; the entry waits untouched and blocks nothing.
    drop(open(f).unwrap());
    assert!(pending(root.path()).is_object());
    let count = || {
        stores
            .get("capture-agent")
            .unwrap()
            .count(&store::RowFilter::default())
            .unwrap()
    };
    assert_eq!(count(), 1);
    active.store(false, Ordering::SeqCst);
    // After maintenance the next open completes it exactly once.
    let next = BoundaryFixture::new(root.path(), "");
    drop(open(next).unwrap());
    assert!(pending(root.path()).is_null());
    assert_eq!(count(), 2);
}

#[test]
fn transient_failures_are_retried_at_most_five_times_across_restarts() {
    let root = physical_temp();
    let f = BoundaryFixture::new(root.path(), "transient-post-always");
    assert_eq!(serde_json::to_value(f.run().unwrap()).unwrap()["stored"], 2);
    let effects = f.effects.clone();
    drop(f);
    assert_eq!(
        pending(root.path())["recoveryAttempts"],
        serde_json::Value::Null
    );
    for attempt in 1..=pipeline_failure::MAX_RECOVERY_ATTEMPTS {
        let next = BoundaryFixture::new(root.path(), "transient-post-always");
        drop(open(next).unwrap());
        // Counted durably before each attempt, so a crash can neither repeat nor lose it.
        assert_eq!(
            pending(root.path())["recoveryAttempts"],
            attempt,
            "{attempt}"
        );
    }
    let last = BoundaryFixture::new(root.path(), "transient-post-always");
    let effects_last = last.effects.clone();
    drop(open(last).unwrap());
    // Exhausted: closed terminally without another attempt; rows stay.
    assert!(pending(root.path()).is_null());
    assert_eq!(effects_last.load(Ordering::SeqCst), 0);
    assert_eq!(effects.load(Ordering::SeqCst), 1);
}

#[test]
fn a_pending_entry_is_retried_before_its_agents_next_turn() {
    let root = physical_temp();
    let f = BoundaryFixture::new(root.path(), "transient-post-once");
    let first = f.turn.clone();
    let mut second = serde_json::to_value(&f.turn).unwrap();
    second["runId"] = "capture-boundary-next".into();
    let second: TurnRecord = serde_json::from_value(second).unwrap();
    let effects = f.effects.clone();
    let stores = f.stores.clone();
    let runtime = open(f).unwrap();
    let options = || serde_json::from_value(serde_json::json!({})).unwrap();
    let done = |handle: contract::CaptureHandle| {
        serde_json::to_value(handle.done.recv_timeout(Duration::from_secs(15)).unwrap()).unwrap()
    };
    // The first turn's post-store step fails transiently: its entry stays pending.
    assert_eq!(
        done(runtime.0.accept(first, options()).unwrap())["stored"],
        2
    );
    assert!(pending(root.path()).is_object());
    // The agent's next turn first retries it (no restart), then runs normally.
    let result = done(runtime.0.accept(second, options()).unwrap());
    assert!(result.get("reason").is_none(), "{result}");
    assert!(pending(root.path()).is_null());
    assert_eq!(effects.load(Ordering::SeqCst), 3);
    assert!(
        stores
            .get("capture-agent")
            .unwrap()
            .count(&store::RowFilter::default())
            .unwrap()
            >= 2
    );
    assert!(runtime.0.close(Duration::from_secs(5)));
}
