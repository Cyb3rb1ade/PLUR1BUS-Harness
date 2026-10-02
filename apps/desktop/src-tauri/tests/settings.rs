use plur1bus_desktop::commands::{allowed_command, authorized_shell, linux_desktop};
use plur1bus_desktop::settings::{Settings, SettingsStore};
use serde_json::json;

#[test]
fn settings_default_round_trip_and_reject_unknown_input() {
    let home = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(home.path().to_path_buf());
    assert_eq!(store.get().unwrap(), Settings::default());
    let selected: Settings =
        serde_json::from_value(json!({"theme":"light","locale":"de"})).unwrap();
    store.set(&selected).unwrap();
    assert_eq!(store.get().unwrap(), selected);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(home.path().join("settings.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    assert!(
        serde_json::from_value::<Settings>(json!({"theme":"dark","locale":"en","extra":1}))
            .is_err()
    );
    assert!(serde_json::from_value::<Settings>(json!({"theme":"blue","locale":"en"})).is_err());
}

#[test]
fn linux_desktop_family_maps_kde_and_other_desktops() {
    assert_eq!(linux_desktop("GNOME"), "gnome");
    assert_eq!(linux_desktop("X-Cinnamon:KDE"), "kde");
    assert_eq!(linux_desktop("plasma"), "kde");
    assert_eq!(linux_desktop(""), "gnome");
}

#[test]
fn malformed_settings_fail_clearly() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("settings.json"), "not json").unwrap();
    assert!(store(home.path())
        .get()
        .unwrap_err()
        .to_string()
        .contains("parse"));
    store(home.path()).set(&Settings::default()).unwrap();
    let preserved: Vec<_> = std::fs::read_dir(home.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("settings-recovered-")
        })
        .collect();
    assert_eq!(preserved.len(), 1);
    assert_eq!(
        std::fs::read_to_string(preserved[0].path()).unwrap(),
        "not json"
    );
}

#[test]
fn newer_settings_fields_survive_old_client_saves_and_missing_fields_default() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("settings.json");
    std::fs::write(&path, r#"{"theme":"dark","future":{"enabled":true}}"#).unwrap();
    assert_eq!(store(home.path()).get().unwrap().locale, Default::default());
    store(home.path()).set(&Settings::default()).unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(saved["future"], json!({"enabled":true}));
}

#[test]
fn save_without_a_prior_read_preserves_invalid_settings_before_replacing() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("settings.json"), "broken").unwrap();
    assert!(store(home.path()).set(&Settings::default()).is_err());
    let preserved = std::fs::read_dir(home.path())
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("settings-recovered-")
        })
        .unwrap();
    assert_eq!(std::fs::read_to_string(preserved.path()).unwrap(), "broken");
}

#[test]
fn write_failure_returns_error_without_claiming_success() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("settings.json")).unwrap();
    assert!(store(home.path()).set(&Settings::default()).is_err());
}

#[test]
fn only_shell_at_exact_bundled_top_level_origin_may_call_settings() {
    for good in ["tauri://localhost/", "http://tauri.localhost/index.html"] {
        assert!(authorized_shell("shell", good));
    }
    for (label, url) in [
        ("spa", "tauri://localhost/"),
        ("shell", "https://tauri.localhost/"),
        ("shell", "tauri://localhost.evil/"),
        ("shell", "http://tauri.localhost:8080/"),
        ("shell", "file:///index.html"),
    ] {
        assert!(!authorized_shell(label, url), "{label} {url}");
    }
    assert!(allowed_command("shell", "settings_get"));
    assert!(allowed_command("shell", "settings_set"));
    assert!(allowed_command("shell", "app_info"));
    assert!(!allowed_command("spa", "settings_get"));
    assert!(!allowed_command("shell", "runtime_start"));
}

fn store(path: &std::path::Path) -> SettingsStore {
    SettingsStore::new(path.to_path_buf())
}
