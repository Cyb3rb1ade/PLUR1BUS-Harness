//! Direct callers must obey maintenance admission even after bypassing the RPC pre-dispatch check.
use super::*;

fn fixture() -> (tempfile::TempDir, Layout, Arc<Shared>) {
    let temp = tempfile::tempdir().unwrap();
    let layout = Layout::new(temp.path().to_path_buf());
    let shared = Arc::new(Shared {
        state: Mutex::new(test_state()),
        maintenance: Default::default(),
        wake: Default::default(),
        config: Mutex::new(config::initial(&layout)),
        log: Log::none(),
        subscribers: Default::default(),
        out_logs: Default::default(),
    });
    (temp, layout, shared)
}

#[test]
fn an_idle_metadata_reader_does_not_report_import_maintenance() {
    let (_temp, _layout, shared) = fixture();
    let idle = relock(&shared.maintenance);
    let (send, receive) = std::sync::mpsc::channel();
    let reader = {
        let shared = shared.clone();
        std::thread::spawn(move || send.send(imports::busy(&shared)).unwrap())
    };
    let early = receive.recv_timeout(Duration::from_millis(50));
    drop(idle);
    let busy = early.unwrap_or_else(|_| receive.recv_timeout(Duration::from_secs(2)).unwrap());
    reader.join().unwrap();
    assert!(
        !busy,
        "idle maintenance metadata contention is not an admitted import"
    );
}

#[test]
fn a_public_config_writer_waits_for_idle_metadata_without_a_false_busy_refusal() {
    let (_temp, layout, shared) = fixture();
    let idle = relock(&shared.maintenance);
    let (send, receive) = std::sync::mpsc::channel();
    let writer = {
        let shared = shared.clone();
        let layout = layout.clone();
        std::thread::spawn(move || {
            send.send(config::set(
                &shared,
                &layout,
                vec![("supervisor.graceMs".into(), json!(15000))],
                None,
                false,
            ))
            .unwrap();
        })
    };
    let early = receive.recv_timeout(Duration::from_millis(50));
    drop(idle);
    let result = early.unwrap_or_else(|_| receive.recv_timeout(Duration::from_secs(2)).unwrap());
    writer.join().unwrap();
    assert!(
        result.is_ok(),
        "idle metadata must not refuse a valid configuration: {result:?}"
    );
    assert!(layout.config_path().exists());
}

#[test]
fn public_config_writer_rechecks_the_reservation_under_its_write_lock() {
    let (_temp, layout, shared) = fixture();
    relock(&shared.maintenance).preparing = true;
    let before = relock(&shared.config).revision.clone();
    let result = config::set(
        &shared,
        &layout,
        vec![("supervisor.graceMs".into(), json!(15000))],
        None,
        false,
    );
    assert_eq!(result, Err(config::SetError::MaintenanceBusy));
    assert_eq!(relock(&shared.config).revision, before);
    assert!(
        !layout.config_path().exists(),
        "late public writer must create no configuration file"
    );
    assert!(
        !layout.audit_log().exists(),
        "refused writer must emit no successful-write audit"
    );
}

#[test]
fn late_module_control_cannot_enqueue_behind_an_import_reservation() {
    let (_temp, _layout, shared) = fixture();
    relock(&shared.maintenance).preparing = true;
    let result = modules::push_module_op(
        &shared,
        "fixture",
        ModuleVerb::Start,
        Duration::from_secs(1),
    );
    let error = result
        .err()
        .expect("maintenance must reject a late module operation");
    assert_eq!(error.error, "E_CONFLICT");
    assert_eq!(error.reason.as_deref(), Some("busy"));
    assert!(
        shared.lock().module_ops.is_empty(),
        "no operation may run after the cold snapshot"
    );
}

/// RE-D172 (B7): the Rust side refuses an import maintenance while an engine slot exists (the second guard beside
/// the Core's preflight), before it reserves anything.
#[test]
fn import_admission_is_refused_while_an_engine_slot_exists() {
    let (_temp, layout, shared) = fixture();
    {
        let mut state = shared.lock();
        state.no_core = false;
        state.slots.push(Slot::new(Role::engine(), 1.0));
    }
    let error = import_admission::queue(
        &shared,
        &layout,
        "admin.import.apply",
        &json!({
            "planId": "00000000-0000-4000-8000-000000000001",
            "preflightId": "00000000-0000-4000-8000-000000000002",
        }),
        None,
        None,
    )
    .expect_err("no maintenance beside the rust engine");
    assert_eq!(error.code, "E_NOT_AVAILABLE");
    assert_eq!(error.reason, Some("engine-writer"));
    assert!(!imports::busy(&shared), "nothing was reserved");
}

/// RE-D172 (B7): while an import maintenance holds the home, the supervisor starts no Rust engine (it starts once the
/// maintenance is over).
#[test]
fn no_engine_slot_is_added_while_import_maintenance_holds_the_home() {
    let (_temp, layout, shared) = fixture();
    shared.lock().no_core = false;
    std::fs::write(
        layout.config_path(),
        r#"{"schemaVersion":1,"engine":{"implementation":"rust"}}"#,
    )
    .unwrap();
    relock(&shared.maintenance).preparing = true;
    let mut monitors = Monitors::new();
    reconcile_engine(&shared, &layout, &mut monitors);
    assert!(shared.lock().slot("engine").is_none());
    assert!(monitors.is_empty());
}
