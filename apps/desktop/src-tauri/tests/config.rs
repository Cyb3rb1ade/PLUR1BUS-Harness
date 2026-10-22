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
            "allow-transport-check",
            "allow-connection-transport-set",
            "allow-quit-request",
            "allow-quit-offer",
            "allow-background-hint",
            "allow-crash-last-report",
            "allow-crash-dismiss",
            "allow-diagnostics-open",
            "allow-crash-restart",
            "allow-crash-offers",
            "allow-crash-handled",
            "allow-quit-response",
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "allow-autostart-get",
            "allow-autostart-set",
            "allow-runtime-detect",
            "allow-runtime-start",
            "allow-bundle-install",
            "allow-harness-start",
            "allow-harness-stop",
            "allow-harness-status",
            "allow-harness-logs-tail",
            "allow-bridge-settings",
            "allow-helper-status",
            "allow-permissions-open-pane",
            "allow-approvals-list",
            "allow-approval-open",
            "allow-approval-decide",
            "allow-update-check",
            "allow-update-settings",
            "allow-update-install",
            "allow-update-skip",
            "allow-update-later",
            "allow-update-store-open",
            "allow-harness-upgrade-status",
            "allow-harness-rollback",
            "allow-deep-link-next",
            "allow-deep-link-open",
            "allow-install-options",
            "allow-runtime-install-apple",
            "allow-runtime-install-vendor",
            "allow-runtime-enable-podman-socket",
            "allow-cli-shim-install",
            "allow-cli-shim-remove",
            "allow-uninstall-summary",
            "allow-uninstall-run",
            "allow-desktop-integration-get",
            "allow-desktop-integration-set"
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
        serde_json::json!(["shell-ui", "approvals"])
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
            "install_options",
            "runtime_install_apple",
            "runtime_install_vendor",
            "runtime_enable_podman_socket",
            "cli_shim_install",
            "cli_shim_remove",
            "uninstall_summary",
            "uninstall_run",
            "runtime_detect",
            "runtime_start",
            "bundle_install",
            "harness_start",
            "harness_upgrade_status",
            "harness_rollback",
            "harness_stop",
            "harness_status",
            "harness_logs_tail",
            "update_store_open",
            "update_check",
            "update_settings",
            "update_install",
            "update_skip",
            "update_later",
            "deep_link_next",
            "deep_link_open",
            "app_info",
            "settings_get",
            "settings_set",
            "connections_list",
            "connections_rename",
            "connections_remove",
            "pair_code",
            "pair_local",
            "open_connection",
            "transport_check",
            "connection_transport_set",
            "desktop_integration_get",
            "desktop_integration_set",
            "autostart_get",
            "autostart_set",
            "quit_request",
            "quit_offer",
            "background_hint",
            "crash_last_report",
            "crash_dismiss",
            "diagnostics_open",
            "crash_restart",
            "crash_offers",
            "crash_handled",
            "bridge_settings",
            "helper_status",
            "permissions_open_pane",
            "approvals_list",
            "approval_open",
            "approval_decide",
            "quit_response"
        ]
    );
    let registration = include_str!("../src/lib.rs");
    for command in SHELL_COMMANDS {
        assert!(
            registration.contains(&format!("commands::{command}"))
                || registration.contains(&format!("host_commands::{command}"))
                || registration.contains(&format!("deeplink::{command}"))
        );
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
        .map(|s| s.split("::").last().unwrap())
        .collect();
    assert_eq!(actual, plur1bus_desktop::commands::APP_COMMANDS);
}

#[test]
fn updater_artifacts_are_signed_only_through_the_release_overlay() {
    // Preview/CI bundles must not need TAURI_SIGNING_PRIVATE_KEY; the release workflow opts in with
    // `pnpm tauri build --config src-tauri/tauri.release.conf.json` and supplies the private key.
    assert_eq!(config()["bundle"]["createUpdaterArtifacts"], false);
    let release: Value = serde_json::from_str(include_str!("../tauri.release.conf.json")).unwrap();
    assert_eq!(release["bundle"]["createUpdaterArtifacts"], true);
    assert_eq!(release.as_object().unwrap().len(), 1);
}

/// Transport choice spec §9.5: the two transport commands are shell commands at the bundled origin only; their
/// requests are closed and carry only a validated host, a port, enums and a connection id.
#[test]
fn transport_commands_are_shell_only_and_take_closed_requests() {
    use plur1bus_desktop::commands::{
        allowed_command, authorized_shell, host_target, PairCodeRequest, TransportCheckRequest,
        TransportSetRequest, APP_COMMANDS,
    };
    use serde_json::json;
    for command in ["transport_check", "connection_transport_set"] {
        assert!(allowed_command("shell", command));
        assert!(!allowed_command("approvals", command));
        assert!(!allowed_command("spa", command));
        assert!(APP_COMMANDS.contains(&command));
    }
    // The label check is paired with the exact bundled origin.
    assert!(authorized_shell("shell", "tauri://localhost/"));
    assert!(authorized_shell("shell", "http://tauri.localhost/"));
    for url in [
        "https://harness.test/",
        "http://127.0.0.1:30001/",
        "tauri://localhost:1/",
    ] {
        assert!(!authorized_shell("shell", url), "{url}");
    }
    assert!(!authorized_shell("spa", "tauri://localhost/"));

    let id = "01940000-0000-7000-8000-000000000001";
    for good in [
        json!({"target":{"kind":"origin","origin":"https://harness.test"},"transport":"direct","purpose":"remote"}),
        json!({"target":{"kind":"host","host":"nas.example","port":22},"transport":"tailscale","purpose":"ssh"}),
        json!({"target":{"kind":"connection","id":id},"transport":"direct","purpose":"remote"}),
    ] {
        assert!(
            serde_json::from_value::<TransportCheckRequest>(good.clone()).is_ok(),
            "{good}"
        );
    }
    for bad in [
        json!({"target":{"kind":"origin","origin":"https://harness.test"},"transport":"direct","purpose":"remote","probe":true}),
        json!({"target":{"kind":"origin","origin":"https://harness.test","addresses":["1.1.1.1"]},"transport":"direct","purpose":"remote"}),
        json!({"target":{"kind":"host","host":"nas","port":22,"resolved":"10.0.0.1"},"transport":"direct","purpose":"ssh"}),
        json!({"target":{"kind":"connection","id":id,"origin":"https://x.test"},"transport":"direct","purpose":"remote"}),
        json!({"target":{"kind":"url","url":"https://harness.test"},"transport":"direct","purpose":"remote"}),
        json!({"target":{"kind":"host","host":"nas","port":70000},"transport":"direct","purpose":"ssh"}),
        json!({"target":{"kind":"origin","origin":"https://harness.test"},"transport":"vpn","purpose":"remote"}),
        json!({"target":{"kind":"origin","origin":"https://harness.test"},"transport":"direct","purpose":"web"}),
        json!({"target":{"kind":"origin","origin":"https://harness.test"},"transport":"direct"}),
    ] {
        assert!(
            serde_json::from_value::<TransportCheckRequest>(bad.clone()).is_err(),
            "{bad}"
        );
    }
    assert!(serde_json::from_value::<TransportSetRequest>(
        json!({"id":id,"transport":"direct","publicAck":true})
    )
    .is_ok());
    for bad in [
        json!({"id":id,"transport":"direct","publicAck":true,"classifier":"iana-special-2025-10-09"}),
        json!({"id":id,"transport":"direct","publicAck":true,"atMs":1}),
        json!({"id":id,"transport":"direct"}),
    ] {
        assert!(
            serde_json::from_value::<TransportSetRequest>(bad.clone()).is_err(),
            "{bad}"
        );
    }
    // `pair_code` needs the chosen path and the confirmation flag; the old request shape is refused.
    let pair = json!({"origin":"https://harness.test","name":"Desk","code":"ABCD-2345","repairId":null,"linkId":null});
    assert!(serde_json::from_value::<PairCodeRequest>(pair.clone()).is_err());
    let mut with_path = pair.clone();
    with_path["transport"] = json!("direct");
    with_path["publicAck"] = json!(false);
    let request = serde_json::from_value::<PairCodeRequest>(with_path.clone()).unwrap();
    assert_eq!(
        request.transport,
        plur1bus_desktop::transport::Transport::Direct
    );
    assert!(!request.public_ack);
    with_path["addresses"] = json!(["10.0.0.1"]);
    assert!(serde_json::from_value::<PairCodeRequest>(with_path).is_err());

    // Host strings: spec §4.4 limits, refused before any check.
    let name_254 = format!(
        "{}.{}.{}.{}",
        "a".repeat(63),
        "b".repeat(63),
        "c".repeat(63),
        "d".repeat(62)
    );
    assert_eq!(name_254.len(), 254);
    assert_eq!(host_target(&name_254, 22).unwrap_err(), "host-invalid");
    let name_253 = &name_254[..253];
    assert!(host_target(name_253.trim_end_matches('.'), 22).is_ok());
    assert_eq!(
        host_target(&"a".repeat(2000), 22).unwrap_err(),
        "host-invalid"
    );
    assert_eq!(
        host_target("127.1", 22).unwrap_err(),
        "host-ipv4-noncanonical"
    );
    assert_eq!(host_target("nas:22", 22).unwrap_err(), "host-invalid");
    assert_eq!(host_target("nas", 0).unwrap_err(), "invalid");
}
