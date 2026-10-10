use plur1bus_desktop::helper::{self, Pane};
#[test]
fn helper_hello_reports_no_capabilities() {
    assert_eq!(
        helper::response("hello").unwrap(),
        serde_json::json!({"version":"1","capabilities":[]})
    );
    assert_eq!(
        helper::response("os.permissions.status").unwrap(),
        serde_json::json!({"grants":[]})
    );
    assert!(helper::response("os.permissions.request").is_none());
}
#[test]
fn helper_is_restarted_with_backoff() {
    let mut b = helper::Restart::default();
    assert_eq!(
        (0..7).map(|_| b.failed(0.5).as_secs()).collect::<Vec<_>>(),
        vec![1, 2, 4, 8, 16, 30, 30]
    );
}
#[test]
fn helper_gets_no_inherited_env() {
    let vars = vec![
        ("PATH".into(), "/usr/bin".into()),
        ("HOME".into(), "/p1t/home".into()),
        ("LANG".into(), "de_DE.UTF-8".into()),
        ("INJECTED_SECRET".into(), uuid::Uuid::now_v7().to_string()),
        ("LD_PRELOAD".into(), "/p1t/injection".into()),
    ];
    let clean = helper::environment(vars);
    assert_eq!(clean.len(), 3);
    assert!(!clean
        .iter()
        .any(|(k, _)| k == "INJECTED_SECRET" || k == "LD_PRELOAD"));
}
#[test]
fn permissions_open_pane_accepts_only_known_panes() {
    for name in ["accessibility", "screen-capture", "automation"] {
        assert!(serde_json::from_value::<Pane>(serde_json::json!(name)).is_ok());
    }
    for name in [
        "input-monitoring",
        "file:///tmp",
        "https://harness.test",
        "shell",
    ] {
        assert!(serde_json::from_value::<Pane>(serde_json::json!(name)).is_err());
    }
}
#[test]
fn approval_projection_drops_nonce_and_raw_arguments() {
    let nonce = uuid::Uuid::now_v7().to_string();
    let raw = uuid::Uuid::now_v7().to_string();
    let v = serde_json::json!({"approval":{"id":"request","capability":"fs.write","targets":["/p1t/report"],"actionHash":"synthetic","agentReason":"unverified","rawArgs":raw},"nonce":nonce});
    let card = plur1bus_desktop::host_commands::project(&v).unwrap();
    let bytes = serde_json::to_string(&card).unwrap();
    assert!(!bytes.contains(&nonce));
    assert!(!bytes.contains(&raw));
}
#[test]
fn approval_window_has_a_narrow_origin_checked_acl() {
    use plur1bus_desktop::commands::*;
    assert!(allowed_command("approvals", "approvals_list"));
    assert!(allowed_command("approvals", "approval_open"));
    assert!(!allowed_command("approvals", "bridge_settings"));
    assert!(!allowed_command("approvals", "settings_set"));
    assert!(!authorized_shell("approvals", "https://harness.test"));
}
#[test]
fn the_host_switch_and_appearance_changes_preserve_each_other() {
    use plur1bus_desktop::settings::{Locale, Settings, SettingsStore, Theme};
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(dir.path().into());
    assert!(store.key_unlock().unwrap());
    store.set_key_unlock(false).unwrap();
    store
        .set(&Settings {
            theme: Theme::Dark,
            locale: Locale::De,
        })
        .unwrap();
    assert!(!store.key_unlock().unwrap());
    store.set_key_unlock(true).unwrap();
    assert_eq!(store.get().unwrap().theme, Theme::Dark);
    assert_eq!(store.get().unwrap().locale, Locale::De);
}
