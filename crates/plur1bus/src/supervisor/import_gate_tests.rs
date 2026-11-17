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

/// A Rust engine slot does not replace the same live preflight proof required on either engine.
#[test]
fn an_engine_slot_does_not_bypass_the_import_preflight() {
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
    .expect_err("no maintenance without a genuine preflight");
    assert_eq!(error.code, "E_NOT_FOUND");
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

/// P4D-39: a local caller that writes for somebody else is judged by that one's role wherever a credential is held,
/// and as before everywhere else. Each write is a dry run; the judgement is the same.
#[test]
fn a_write_made_for_somebody_is_judged_by_their_role_where_a_credential_is_held() {
    let (_temp, layout, shared) = fixture();
    let blocks = [
        ("media.adapters.fal.apiKeyRef", json!("fal.key")),
        ("voice.providers.xai.apiKeyRef", json!("xai.key")),
        ("engine.merging.apiKeyRef", json!("merge.key")),
        ("engine.merging.baseUrl", json!("https://mine.example")),
        ("channels.telegram.tokenSecret", json!("telegram.token")),
        ("a2aServer.signingKey.privateKeySecret", json!("a2a.key")),
    ];
    for (key, value) in &blocks {
        let write = |role: &str| {
            config::set_for(
                &shared,
                &layout,
                vec![((*key).into(), value.clone())],
                None,
                true,
                role,
            )
        };
        assert!(write("owner").is_ok(), "{key}: the owner");
        for role in ["admin", "operator", "member", "viewer", ""] {
            assert_eq!(
                write(role),
                Err(config::SetError::Invalid(vec!["config-write-role".into()])),
                "{key}: {role:?}"
            );
        }
    }
    // Outside the blocks the one for whom the write is made changes nothing: the caller is trusted as before.
    for role in ["owner", "admin", "member", ""] {
        let result = config::set_for(
            &shared,
            &layout,
            vec![("supervisor.graceMs".into(), json!(15000))],
            None,
            true,
            role,
        );
        assert!(result.is_ok(), "{role:?}: {result:?}");
    }
    assert!(!layout.config_path().exists(), "dry runs write nothing");
}

/// P4D-39: the role an actor is judged by. A person has the role the core resolved; the engine and the core's own
/// causes write as before; what is no known kind, and a person without a role, has no role at all.
#[test]
fn the_role_an_actor_is_judged_by() {
    let role = |actor: Value| server::credential_role(&actor).to_owned();
    assert_eq!(
        role(json!({"kind": "person", "userId": "u1", "role": "admin"})),
        "admin"
    );
    assert_eq!(
        role(json!({"kind": "person", "userId": "u1", "role": "owner"})),
        "owner"
    );
    assert_eq!(role(json!({"kind": "person", "userId": "u1"})), "");
    assert_eq!(role(json!({"kind": "engine"})), "owner");
    assert_eq!(
        role(json!({"kind": "core", "cause": "embedding-switch"})),
        "owner"
    );
    assert_eq!(role(json!({"kind": "somebody"})), "");
    assert_eq!(role(json!({})), "");
    assert_eq!(role(json!("owner")), "");
}
