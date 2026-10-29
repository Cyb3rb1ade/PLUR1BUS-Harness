//! Private maintenance config controls use kernel peer identity and immutable active-run metadata.
use super::*;
use crate::supervisor::imports::Job;
use crate::supervisor::state::ChildState;
use std::os::unix::net::UnixStream;

const RUN: &str = "12345678-1234-4123-8123-123456789011";
const PLAN: &str = "12345678-1234-4123-8123-123456789012";

fn fixture() -> (tempfile::TempDir, ConnCtx, Conn, UnixStream) {
    let dir = tempfile::tempdir().unwrap();
    let layout = Layout::new(dir.path().to_path_buf());
    std::fs::create_dir_all(layout.run()).unwrap();
    let listener = imp::Listener::bind(dir.path().join("peer.sock").to_str().unwrap()).unwrap();
    let client = UnixStream::connect(dir.path().join("peer.sock")).unwrap();
    let accepted = listener.accept().unwrap();
    assert_eq!(accepted.peer_pid, Some(std::process::id()));
    let mut state = super::super::test_state();
    state.no_core = false;
    let slot = state.slot_mut("core").unwrap();
    let mut child = ChildState::fresh(&slot.role);
    child.pid = accepted.peer_pid;
    slot.child = Some(child);
    let shared = Arc::new(Shared {
        state: Mutex::new(state),
        wake: Default::default(),
        log: super::super::Log::none(),
        config: Mutex::new(config::initial(&layout)),
        subscribers: Default::default(),
        out_logs: Default::default(),
        maintenance: Default::default(),
    });
    relock(&shared.maintenance).active = Some(Job {
        invocation_id: uuid::Uuid::new_v4().to_string(),
        run_id: RUN.into(),
        plan_id: PLAN.into(),
        plan_sha256: "a".repeat(64),
        owner_id: "alice".into(),
        role: "owner".into(),
        source_type: "fixture".into(),
        mode: "apply".into(),
        attempt: 1,
        preflight_id: None,
        target_sha256: None,
        migrate_secrets: false,
        automatic_rollback: false,
    });
    let conn = Conn {
        peer_pid: accepted.peer_pid,
        api_user: None,
        writer: Arc::new(Mutex::new(accepted.writer)),
        closer: accepted.closer,
        subscriptions: vec![],
        config_sub: None,
        module_sub: None,
        ext_sub: None,
        import_sub: None,
    };
    let context = ConnCtx {
        token: "t".repeat(64),
        hello: json!({}),
        audit_health: Default::default(),
        shared,
        layout,
    };
    (dir, context, conn, client)
}

fn params() -> Value {
    json!({"runId":RUN,"planId":PLAN,"planSha256":"a".repeat(64),
      "changes":[{"key":"embedding.useClass","value":"research"}]})
}

#[test]
fn kernel_peer_matching_current_core_applies_active_run_config_without_a_restart_job() {
    let (_dir, ctx, conn, _client) = fixture();
    let result = ctx.runtime_config_set(&json!(1), &params(), None, &conn);
    assert_eq!(result["result"]["applied"], true, "{result}");
    assert_eq!(
        relock(&ctx.shared.config).running.as_ref().unwrap()["embedding"]["useClass"],
        "research"
    );
    assert!(
        ctx.shared.lock().restart_jobs.is_empty(),
        "maintenance owns Core-class restarts"
    );
}

#[test]
fn same_uid_client_with_wrong_kernel_pid_and_api_delegation_cannot_write() {
    let (_dir, ctx, mut conn, _client) = fixture();
    let before = relock(&ctx.shared.config).revision.clone();
    // A real, distinct same-user process is the tracked Core; this socket still belongs to the test process.
    let mut core = std::process::Command::new(
        std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into()),
    )
    .args(["-e", "setInterval(()=>{},1000)"])
    .spawn()
    .expect("Node24 test prerequisite");
    ctx.shared
        .lock()
        .slot_mut("core")
        .unwrap()
        .child
        .as_mut()
        .unwrap()
        .pid = Some(core.id());
    let wrong = ctx.runtime_config_set(&json!(1), &params(), None, &conn);
    let _ = core.kill();
    let _ = core.wait();
    assert_eq!(wrong["error"]["data"]["error"], "E_DENIED", "{wrong}");
    ctx.shared
        .lock()
        .slot_mut("core")
        .unwrap()
        .child
        .as_mut()
        .unwrap()
        .pid = conn.peer_pid;
    let api = json!({"kind":"person","userId":"alice","role":"owner"});
    assert_eq!(
        ctx.runtime_config_set(&json!(1), &params(), Some(&api), &conn)["error"]["data"]["error"],
        "E_DENIED"
    );
    conn.api_user = Some("alice".into());
    assert_eq!(
        ctx.runtime_config_set(&json!(1), &params(), None, &conn)["error"]["data"]["error"],
        "E_DENIED"
    );
    assert_eq!(relock(&ctx.shared.config).revision, before);
}

#[test]
fn missing_peer_or_active_run_mismatches_and_extra_params_never_write() {
    let (_dir, ctx, mut conn, _client) = fixture();
    let before = relock(&ctx.shared.config).revision.clone();
    for field in ["runId", "planId", "planSha256"] {
        let mut wrong = params();
        wrong[field] = json!(if field == "planSha256" {
            "b".repeat(64)
        } else {
            "12345678-1234-4123-8123-123456789013".into()
        });
        assert_eq!(
            ctx.runtime_config_set(&json!(1), &wrong, None, &conn)["error"]["data"]["error"],
            "E_DENIED"
        );
    }
    let mut unknown = params();
    unknown["role"] = json!("owner");
    assert_eq!(
        ctx.runtime_config_set(&json!(1), &unknown, None, &conn)["error"]["data"]["error"],
        "E_INVALID_PARAMS"
    );
    conn.peer_pid = None;
    assert_eq!(
        ctx.runtime_config_set(&json!(1), &params(), None, &conn)["error"]["data"]["error"],
        "E_DENIED"
    );
    conn.peer_pid = Some(std::process::id());
    relock(&ctx.shared.maintenance).active = None;
    assert_eq!(
        ctx.runtime_config_set(&json!(1), &params(), None, &conn)["error"]["data"]["error"],
        "E_DENIED"
    );
    assert_eq!(relock(&ctx.shared.config).revision, before);
}

#[test]
fn maintenance_write_keeps_the_initiating_job_role_instead_of_inheriting_local_owner() {
    let (_dir, ctx, conn, _client) = fixture();
    relock(&ctx.shared.maintenance)
        .active
        .as_mut()
        .unwrap()
        .role = "admin".into();
    let mut request = params();
    request["changes"] = json!([{"key":"import.ssh.connections","value":{"source":{
        "host":"source.invalid","port":22,"user":"reader","roots":["/home/reader"],"allowPrivate":false
    }}}]);
    let before = relock(&ctx.shared.config).revision.clone();
    let result = ctx.runtime_config_set(&json!(1), &request, None, &conn);
    assert_eq!(result["error"]["data"]["error"], "E_DENIED", "{result}");
    assert_eq!(relock(&ctx.shared.config).revision, before);
}
