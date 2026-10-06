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
    assert_eq!(
        c["permissions"],
        serde_json::json!([
            "allow-app-info",
            "allow-settings-get",
            "allow-settings-set",
            "allow-connections-list",
            "allow-connections-rename",
            "allow-connections-remove",
            "allow-pair-code",
            "allow-pair-local",
            "allow-open-connection",
            "allow-quit-request",
            "allow-quit-offer",
            "allow-background-hint",
            "allow-crash-offers",
            "allow-crash-handled",
            "allow-quit-response",
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "allow-autostart-get",
            "allow-autostart-set"
        ])
    );
    assert_eq!(c["webviews"], serde_json::json!(["shell"]));
    assert!(
        c.get("windows").is_none(),
        "do not grant sibling webviews by their parent window"
    );
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
#[test]
fn every_wp4_command_is_registered_guarded_and_no_pin_or_runtime_path_is_an_ipc_input() {
    use plur1bus_desktop::commands::{
        allowed_command, ConnectionIdRequest, PairCodeRequest, PairLocalRequest, RenameRequest,
        SHELL_COMMANDS,
    };
    assert_eq!(
        SHELL_COMMANDS,
        [
            "app_info",
            "settings_get",
            "settings_set",
            "connections_list",
            "connections_rename",
            "connections_remove",
            "pair_code",
            "pair_local",
            "open_connection",
            "autostart_get",
            "autostart_set",
            "quit_request",
            "quit_offer",
            "background_hint",
            "crash_offers",
            "crash_handled",
            "quit_response"
        ]
    );
    let registration = include_str!("../src/lib.rs");
    for command in SHELL_COMMANDS {
        assert!(registration.contains(&format!("commands::{command}")));
        assert!(allowed_command("shell", command));
        assert!(!allowed_command("spa", command));
    }
    assert!(serde_json::from_value::<PairLocalRequest>(
        serde_json::json!({"name":"Desk","cli":"/tmp/arbitrary"})
    )
    .is_err());
    assert!(serde_json::from_value::<PairCodeRequest>(serde_json::json!({"name":"Desk","origin":"https://harness.test","code":"invalid","caPin":"typed"})).is_err());
    assert!(serde_json::from_value::<ConnectionIdRequest>(serde_json::json!({"id":"01940000-0000-7000-8000-000000000001","url":"https://harness.test"})).is_err());
    assert!(serde_json::from_value::<RenameRequest>(
        serde_json::json!({"id":"01940000-0000-7000-8000-000000000001","name":"Desk","extra":true})
    )
    .is_err());
}

#[test]
fn registered_handlers_match_the_application_acl_table() {
    let source = include_str!("../src/lib.rs");
    let handlers = source
        .split("tauri::generate_handler![")
        .nth(1)
        .unwrap()
        .split(']')
        .next()
        .unwrap();
    let actual: Vec<_> = handlers
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.strip_prefix("commands::").unwrap())
        .collect();
    assert_eq!(actual, plur1bus_desktop::commands::APP_COMMANDS);
}
