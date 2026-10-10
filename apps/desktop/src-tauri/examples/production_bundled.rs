//! Native Wry wizard against mock-harness. Explicit synthetic runtime, memory-only credentials.
#[cfg(debug_assertions)]
#[path = "../tests/common/mod.rs"]
mod common;
#[cfg(debug_assertions)]
#[path = "../tests/support/controller.rs"]
mod support_controller;
#[cfg(debug_assertions)]
fn main() {
    use plur1bus_desktop::{
        commands,
        controller::{Controller, Resources},
        runtime::RuntimeKind,
        runtime_commands as rc,
        secrets::MemoryStore,
    };
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tauri::Manager;
    let root = std::path::PathBuf::from(std::env::args_os().nth(1).expect("p1t fixture root"));
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .expect("isolated HOME");
    assert_eq!(
        std::env::var_os("CFFIXED_USER_HOME"),
        std::env::var_os("HOME")
    );
    assert!(
        home.starts_with(&root)
            && root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("p1t-")
    );
    let config = root.join("config");
    std::env::set_var("PLUR1BUS_DESKTOP_CONFIG_DIR", &config);
    plur1bus_desktop::settings::SettingsStore::new(config.clone())
        .set(&plur1bus_desktop::settings::Settings {
            locale: plur1bus_desktop::settings::Locale::En,
            ..Default::default()
        })
        .unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let r = Arc::new(
        support_controller::FakeRuntime::new(RuntimeKind::Docker)
            .with_endpoint("unix:///p1t/native-engine.sock"),
    );
    let ctl = Arc::new(
        Controller::with_health(
            r.clone(),
            plur1bus_desktop::controller::bundle::embedded().clone(),
            config.join("bundled"),
            Arc::new(support_controller::Healthy),
        )
        .with_test_namespace("native-wizard")
        .unwrap(),
    );
    let i = runtime
        .block_on(ctl.install(Resources::default(), |_| {}))
        .unwrap();
    let mock = runtime
        .block_on(plur1bus_mock_harness::MockHarness::start(
            plur1bus_mock_harness::MockOptions {
                bind: format!("127.0.0.1:{}", i.port).parse().unwrap(),
                ..Default::default()
            },
        ))
        .unwrap();
    let control = mock.control.clone();
    *r.exec_hook.lock().unwrap() = Some(Arc::new(move |argv| {
        use plur1bus_desktop::runtime::ExecOutput;
        match &argv[1..]{
 ["daemon","status","--json"]=>ExecOutput{code:0,stdout:br#"{"schema":"daemon.status/1","supervisor":{"process":{"state":"running"}},"children":[{"kind":"core","process":{"state":"ready"}}]}"#.to_vec(),stderr:vec![]},
 ["user","create","--owner","--json"]=>{control.set_provisioned(true);ExecOutput{code:0,stdout:br#"{"schema":"user.create/1","userId":"p1t-owner"}"#.to_vec(),stderr:vec![]}},
 ["device","pair",..]=>ExecOutput{code:0,stdout:serde_json::to_vec(&serde_json::json!({"schema":"device.pair/1","code":control.create_pair_code_with_grant(true),"expiresAt":"2099-01-01T00:00:00Z"})).unwrap(),stderr:vec![]},
 _=>panic!("unexpected fixture exec")}
    }));
    let report_control = mock.control.clone();
    let complete = Arc::new(AtomicBool::new(false));
    let done = complete.clone();
    let report_root = root.clone();
    let app=tauri::Builder::default().plugin(tauri_plugin_autostart::Builder::new().build())
 .manage(plur1bus_desktop::native::NativeState::default()).manage(plur1bus_desktop::spa::SpaState::default())
 .manage(commands::ConnectionState(Arc::new(tokio::sync::Mutex::new(Some(Box::new(MemoryStore::default()))))))
 .manage(rc::RuntimeState::for_fixture(ctl).unwrap())
 .invoke_handler(tauri::generate_handler![commands::app_info,commands::settings_get,commands::settings_set,commands::connections_list,commands::connections_rename,commands::connections_remove,commands::pair_code,commands::pair_local,commands::open_connection,commands::autostart_get,commands::autostart_set,commands::quit_request,commands::quit_offer,commands::background_hint,commands::crash_offers,commands::crash_handled,commands::quit_response,commands::shell_info,rc::runtime_detect,rc::runtime_start,rc::bundle_install,rc::harness_start,rc::harness_stop,rc::harness_status,rc::harness_logs_tail])
 .on_page_load(|webview,payload|{if webview.label()=="shell"&&matches!(payload.event(),tauri::webview::PageLoadEvent::Finished){
 let _=webview.window().show();let _=webview.eval(r#"(()=>{let stage=0;const timer=setInterval(()=>{const buttons=[...document.querySelectorAll('button')];const find=text=>buttons.find(b=>b.textContent===text);if(stage===0){const b=find('Set up a local harness');if(b){b.click();stage++;}}else if(stage===1){const b=find('Continue');if(b){b.click();stage++;}}else if(stage===2){const c=document.querySelector('input[type=checkbox]');const b=find('Continue');if(c&&b){c.click();stage++;}}else if(stage===3){const b=find('Continue');if(b&&!b.disabled){b.click();stage++;}}else if(stage===4){const r=document.querySelector('input[type=radio]');const b=find('Continue');if(r&&b&&!b.disabled){b.click();stage++;}}else if(stage===5){const b=find('Open PLUR1BUS');if(b){b.click();clearInterval(timer);}}},50);})();"#);
 }}).setup(move|app|{let handle=app.handle().clone();let root=report_root.clone();let done=done.clone();tauri::async_runtime::spawn(async move{
 let result=tokio::time::timeout(std::time::Duration::from_secs(30),async{loop{if handle.get_webview_window("spa").is_some(){break;}tokio::time::sleep(std::time::Duration::from_millis(100)).await;}}).await;
 if result.is_ok(){let store=plur1bus_desktop::connections::Store::open(&root.join("config"));let rows=store.load().unwrap();let state=handle.state::<commands::ConnectionState>();let guard=state.0.lock().await;let row=rows.first().unwrap();let token=guard.as_ref().unwrap().get(&plur1bus_desktop::secrets::token_account(row.id)).unwrap().unwrap();common::assert_no_token_on_disk(&root,token.expose());assert!(row.bundled.is_some());std::fs::write(root.join("report.json"),serde_json::to_vec_pretty(&serde_json::json!({"nativeWizard":true,"preparedController":true,"ownerProvisioned":report_control.provisioned(),"bundledStored":true,"spaCreated":true,"tokenStore":"memory-only","noTokenOnDisk":true})).unwrap()).unwrap();done.store(true,Ordering::SeqCst);handle.exit(0);}else{handle.exit(2);}
 });Ok(())}).build(tauri::generate_context!()).unwrap();
    app.run(|_, _| {});
    assert!(complete.load(Ordering::SeqCst));
    assert!(mock.control.provisioned());
}
#[cfg(not(debug_assertions))]
fn main() {
    panic!("native fixture is debug-only");
}
