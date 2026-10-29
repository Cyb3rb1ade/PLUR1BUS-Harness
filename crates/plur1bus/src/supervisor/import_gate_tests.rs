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
