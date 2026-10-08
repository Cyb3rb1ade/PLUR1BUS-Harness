mod common;
#[path = "support/controller.rs"]
mod support_controller;
use plur1bus_desktop::{
    connections::Store,
    controller::{Controller, InstallStep, Resources},
    pair,
    runtime::{ExecOutput, RuntimeKind},
    secrets::{token_account, MemoryStore, TokenStore},
};
use plur1bus_mock_harness::{MockHarness, MockOptions};
use std::sync::Arc;
use support_controller::{FakeRuntime, Healthy};
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[tokio::test]
async fn pair_bundled_creates_owner_pairs_and_stores_a_bundled_connection() {
    let _serial = SERIAL.lock().await;
    let d = tempfile::tempdir().unwrap();
    let r = Arc::new(FakeRuntime::new(RuntimeKind::Docker));
    let ctl = Controller::with_health(
        r.clone(),
        plur1bus_desktop::controller::bundle::embedded().clone(),
        d.path().join("bundled"),
        Arc::new(Healthy),
    )
    .with_test_namespace("pair")
    .unwrap();
    let i = ctl.install(Resources::default(), |_| {}).await.unwrap();
    let mock = MockHarness::start(MockOptions {
        bind: format!("127.0.0.1:{}", i.port).parse().unwrap(),
        ..Default::default()
    })
    .await
    .unwrap();
    let control = mock.control.clone();
    *r.exec_hook.lock().unwrap() = Some(Arc::new(move |argv| match &argv[1..] {
        ["user", "create", "--owner", "--json"] => {
            control.set_provisioned(true);
            ExecOutput {
                code: 0,
                stdout: br#"{"schema":"user.create/1","userId":"mock-owner"}"#.to_vec(),
                stderr: vec![],
            }
        }
        ["device", "pair", ..] => {
            let code = control.create_pair_code_with_grant(true);
            ExecOutput{code:0,stdout:serde_json::to_vec(&serde_json::json!({"schema":"device.pair/1","code":code,"expiresAt":"2099-01-01T00:00:00Z"})).unwrap(),stderr:vec![]}
        }
        _ => panic!("unexpected synthetic exec"),
    }));
    let tokens = MemoryStore::default();
    let store = Store::open(&d.path().join("connections"));
    let steps = std::sync::Mutex::new(vec![]);
    let c = pair::pair_bundled(&ctl, &tokens, &store, "p1t desktop", |s| {
        steps.lock().unwrap().push(s)
    })
    .await
    .unwrap();
    assert_eq!(c.kind, plur1bus_desktop::connections::Kind::Bundled);
    assert!(mock.control.provisioned());
    assert_eq!(
        *steps.lock().unwrap(),
        vec![InstallStep::Owner, InstallStep::Pairing, InstallStep::Done]
    );
    let token = tokens.get(&token_account(c.id)).unwrap().unwrap();
    common::assert_no_token_on_disk(d.path(), token.expose());
    assert!(!r
        .state
        .lock()
        .unwrap()
        .calls
        .iter()
        .any(|c| c.contains(token.expose())));
    let calls = r.state.lock().unwrap().calls.clone();
    assert!(calls
        .iter()
        .any(|c| c == "exec:plur1bus user create --owner --json"));
    assert!(calls.iter().any(|c|c=="exec:plur1bus device pair --json --kind desktop --name p1t desktop --scope ui.session,events.read,bridge.serve --grant host.keyUnlock"));
    pair::validate_connection(&mut c.clone(), &tokens, &store)
        .await
        .unwrap();
}
struct RefuseWrite(Arc<MemoryStore>);
impl TokenStore for RefuseWrite {
    fn get(
        &self,
        a: &str,
    ) -> Result<
        Option<plur1bus_desktop::secrets::SecretString>,
        plur1bus_desktop::secrets::TokenError,
    > {
        self.0.get(a)
    }
    fn set(
        &self,
        _: &str,
        _: &plur1bus_desktop::secrets::SecretString,
    ) -> Result<(), plur1bus_desktop::secrets::TokenError> {
        Err(plur1bus_desktop::secrets::TokenError::AccessDenied)
    }
    fn delete(&self, a: &str) -> Result<(), plur1bus_desktop::secrets::TokenError> {
        self.0.delete(a)
    }
    fn kind(&self) -> plur1bus_desktop::secrets::StoreKind {
        plur1bus_desktop::secrets::StoreKind::MemoryOnly
    }
}
#[tokio::test]
async fn pair_bundled_keeps_old_token_on_failure_and_revokes_after_new_storage_then_repairs_once() {
    let _serial = SERIAL.lock().await;
    let d = tempfile::tempdir().unwrap();
    let r = Arc::new(FakeRuntime::new(RuntimeKind::Apple));
    let ctl = Controller::with_health(
        r.clone(),
        plur1bus_desktop::controller::bundle::embedded().clone(),
        d.path().join("bundled"),
        Arc::new(Healthy),
    )
    .with_test_namespace("repair")
    .unwrap();
    let installed = ctl.install(Resources::default(), |_| {}).await.unwrap();
    let mock = MockHarness::start(MockOptions {
        bind: format!("127.0.0.1:{}", installed.port).parse().unwrap(),
        ..Default::default()
    })
    .await
    .unwrap();
    let tokens = Arc::new(MemoryStore::default());
    let path = d.path().join("connections");
    let store = Store::open(&path);
    let control = mock.control.clone();
    let token_view = tokens.clone();
    let stored_path = path.clone();
    let revocations = Arc::new(std::sync::Mutex::new(vec![]));
    let revoked_view = revocations.clone();
    *r.exec_hook.lock().unwrap() = Some(Arc::new(move |argv| {
        match &argv[1..]{
 ["user","create","--owner","--json"]=>{if control.provisioned(){ExecOutput{code:2,stdout:br#"{"schema":"error/1","code":"E_EXISTS"}"#.to_vec(),stderr:vec![]}}else{control.set_provisioned(true);ExecOutput{code:0,stdout:br#"{"schema":"user.create/1","userId":"mock-owner"}"#.to_vec(),stderr:vec![]}}},
 ["device","pair",..]=>ExecOutput{code:0,stdout:serde_json::to_vec(&serde_json::json!({"schema":"device.pair/1","code":control.create_pair_code_with_grant(true),"expiresAt":"2099-01-01T00:00:00Z"})).unwrap(),stderr:vec![]},
 ["device","revoke",old,"--json"]=>{let row=Store::open(&stored_path).load().unwrap().remove(0);assert_ne!(row.device_id,*old);assert!(token_view.get(&token_account(row.id)).unwrap().is_some());revoked_view.lock().unwrap().push(old.to_string());control.revoke_device(old);ExecOutput{code:0,stdout:br#"{"schema":"device.revoke/1","ok":true}"#.to_vec(),stderr:vec![]}},
 _=>panic!("unexpected exec")
 }
    }));
    let first = pair::pair_bundled(&ctl, tokens.as_ref(), &store, "p1t repair", |_| {})
        .await
        .unwrap();
    let first_token = tokens.get(&token_account(first.id)).unwrap().unwrap();
    assert!(pair::pair_bundled(
        &ctl,
        &RefuseWrite(tokens.clone()),
        &store,
        "p1t repair",
        |_| {}
    )
    .await
    .is_err());
    assert_eq!(
        tokens
            .get(&token_account(first.id))
            .unwrap()
            .unwrap()
            .expose(),
        first_token.expose()
    );
    assert!(revocations.lock().unwrap().is_empty());
    assert_eq!(store.load().unwrap()[0].device_id, first.device_id);
    let second = pair::pair_bundled(&ctl, tokens.as_ref(), &store, "p1t repair", |_| {})
        .await
        .unwrap();
    assert_eq!(second.id, first.id);
    assert_ne!(second.device_id, first.device_id);
    assert_eq!(*revocations.lock().unwrap(), vec![first.device_id]);
    mock.control.revoke_device(&second.device_id);
    let mut row = second.clone();
    assert!(pair::validate_connection(&mut row, tokens.as_ref(), &store)
        .await
        .is_err());
    let mut repair = pair::BundledRepair::default();
    let repaired = repair
        .repair_once(&ctl, &row, tokens.as_ref(), &store)
        .await
        .unwrap();
    assert_ne!(repaired.device_id, row.device_id);
    assert!(matches!(
        repair
            .repair_once(&ctl, &repaired, tokens.as_ref(), &store)
            .await,
        Err(pair::PairError::PairingNeeded)
    ));
    common::assert_no_token_on_disk(
        d.path(),
        tokens
            .get(&token_account(repaired.id))
            .unwrap()
            .unwrap()
            .expose(),
    );
}
#[tokio::test]
async fn cancellation_before_pairing_never_calls_exec_or_creates_a_token() {
    let d = tempfile::tempdir().unwrap();
    let r = Arc::new(FakeRuntime::new(RuntimeKind::Docker));
    let ctl = Controller::with_health(
        r.clone(),
        plur1bus_desktop::controller::bundle::embedded().clone(),
        d.path().join("bundled"),
        Arc::new(Healthy),
    )
    .with_test_namespace("cancel-pair")
    .unwrap();
    ctl.install(Resources::default(), |_| {}).await.unwrap();
    r.state.lock().unwrap().calls.clear();
    let control = pair::PairControl::default();
    assert!(control.cancel());
    let store = Store::open(&d.path().join("connections"));
    assert!(matches!(
        pair::pair_bundled_controlled(
            &ctl,
            &MemoryStore::default(),
            &store,
            "p1t cancel",
            |_| {},
            Some(&control)
        )
        .await,
        Err(pair::PairError::Cancelled)
    ));
    assert!(store.load().unwrap().is_empty());
    assert!(!r
        .state
        .lock()
        .unwrap()
        .calls
        .iter()
        .any(|call| call.starts_with("exec:")));
}
