use plur1bus_desktop::ids;
use serde_json::Value;

fn config() -> Value {
    serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
}

#[test]
fn identifier_matches_ids_rs() {
    assert_eq!(config()["identifier"], ids::BUNDLE_ID);
}
#[test]
fn csp_is_the_spec_string() {
    assert_eq!(config()["app"]["security"]["csp"], "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
}
#[test]
fn global_tauri_is_off_and_prototype_frozen() {
    let c = config();
    assert_eq!(c["app"]["withGlobalTauri"], false);
    assert_eq!(c["app"]["security"]["freezePrototype"], true);
}
#[test]
fn no_forbidden_plugins_in_cargo_toml() {
    for plugin in ["shell", "fs", "http", "dialog", "opener"] {
        assert!(!include_str!("../Cargo.toml").contains(&format!("tauri-plugin-{plugin}")));
    }
}
#[test]
fn nsis_is_current_user_only() {
    assert_eq!(
        config()["bundle"]["windows"]["nsis"]["installMode"],
        "currentUser"
    );
}
#[test]
fn min_window_is_800x600() {
    let c = config();
    let windows = c["app"]["windows"].as_array().unwrap();
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0]["label"], "shell");
    assert_eq!(windows[0]["minWidth"], 800);
    assert_eq!(windows[0]["minHeight"], 600);
    assert_eq!(windows[0]["visible"], false);
}
#[test]
fn shell_capability_is_local_only() {
    let c: Value = serde_json::from_str(include_str!("../capabilities/shell-ui.json")).unwrap();
    assert_eq!(c["permissions"], serde_json::json!([]));
    assert_eq!(c["local"], true);
    assert!(c.get("remote").is_none());
    assert_eq!(
        config()["app"]["security"]["capabilities"],
        serde_json::json!(["shell-ui"])
    );
}
#[test]
fn bundle_icons_exist() {
    for icon in config()["bundle"]["icon"].as_array().unwrap() {
        assert!(std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(icon.as_str().unwrap())
            .is_file());
    }
}
