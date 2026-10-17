#[allow(dead_code)]
#[path = "../src/desktop_integration.rs"]
mod integration;
use integration::*;
use std::cell::Cell;
#[cfg(unix)]
use std::{cell::RefCell, path::Path};

struct Icon {
    state: Cell<Ownership>,
    calls: Cell<usize>,
    refuse: bool,
}
impl DesktopIconAdapter for Icon {
    fn ownership(&self) -> IntegrationResult<Ownership> {
        Ok(self.state.get())
    }
    fn apply(&self, enabled: bool) -> IntegrationResult<()> {
        self.calls.set(self.calls.get() + 1);
        if !self.refuse {
            self.state.set(if enabled {
                Ownership::Owned
            } else {
                Ownership::Absent
            });
        }
        Ok(())
    }
}
#[test]
fn desktop_icon_foreign_content_never_reaches_mutating_adapter() {
    for enabled in [true, false] {
        let icon = Icon {
            state: Cell::new(Ownership::Foreign),
            calls: Cell::new(0),
            refuse: false,
        };
        assert_eq!(icon_set(&icon, enabled), Err("DESKTOP_INTEGRATION_FOREIGN"));
        assert_eq!(icon.calls.get(), 0);
    }
}
#[test]
fn desktop_icon_choices_verify_observed_os_state() {
    let icon = Icon {
        state: Cell::new(Ownership::Absent),
        calls: Cell::new(0),
        refuse: false,
    };
    assert_eq!(icon_get(&icon), Ok(false));
    assert_eq!(icon_set(&icon, true), Ok(true));
    assert_eq!(icon_set(&icon, false), Ok(false));
    let refused = Icon {
        refuse: true,
        ..icon
    };
    assert_eq!(
        icon_set(&refused, true),
        Err("DESKTOP_INTEGRATION_NOT_APPLIED")
    );
}
#[cfg(unix)]
struct Memory(RefCell<std::collections::BTreeMap<std::path::PathBuf, String>>);
#[cfg(unix)]
impl EntryIo for Memory {
    fn read(&self, p: &Path) -> IntegrationResult<Option<String>> {
        Ok(self.0.borrow().get(p).cloned())
    }
    fn write(&self, p: &Path, s: &str) -> IntegrationResult<()> {
        self.0.borrow_mut().insert(p.into(), s.into());
        Ok(())
    }
    fn remove(&self, p: &Path) -> IntegrationResult<()> {
        self.0.borrow_mut().remove(p);
        Ok(())
    }
}
#[cfg(unix)]
#[test]
fn moving_appimage_refreshes_only_enabled_owned_entries_and_preserves_disabled_choice() {
    let io = Memory(RefCell::default());
    let menu = Path::new("/private-xdg/applications/app.plur1bus.desktop.desktop");
    let auto = Path::new("/private-xdg/autostart/app.plur1bus.desktop.desktop");
    let old = Path::new("/old/PLUR1BUS.AppImage");
    let new = Path::new("/moved/PLUR1BUS.AppImage");
    entry_set(&io, menu, old, EntryKind::Menu, true).unwrap();
    refresh_entries(&io, menu, auto, new).unwrap();
    assert!(io
        .read(menu)
        .unwrap()
        .unwrap()
        .contains("Exec=\"/moved/PLUR1BUS.AppImage\" %u\n"));
    assert_eq!(io.read(auto), Ok(None));
    entry_set(&io, auto, old, EntryKind::Autostart, true).unwrap();
    refresh_entries(&io, menu, auto, new).unwrap();
    assert!(io
        .read(auto)
        .unwrap()
        .unwrap()
        .contains("Exec=\"/moved/PLUR1BUS.AppImage\" --autostart\n"));
    entry_set(&io, menu, new, EntryKind::Menu, false).unwrap();
    refresh_entries(&io, menu, auto, old).unwrap();
    assert_eq!(io.read(menu), Ok(None));
}
#[cfg(unix)]
#[test]
fn foreign_or_modified_entry_is_preserved_on_enable_disable_and_refresh() {
    let io = Memory(RefCell::default());
    let menu = Path::new("/xdg/menu");
    let auto = Path::new("/xdg/autostart");
    let exe = Path::new("/app/image");
    entry_set(&io, menu, exe, EntryKind::Menu, true).unwrap();
    let owned = io.read(menu).unwrap().unwrap();
    for foreign in [
        "[Desktop Entry]\nExec=foreign\n".to_string(),
        owned.replace("Terminal=false", "Terminal=true"),
    ] {
        io.write(auto, &foreign).unwrap();
        for enabled in [true, false] {
            assert_eq!(
                entry_set(&io, auto, exe, EntryKind::Autostart, enabled),
                Err("DESKTOP_INTEGRATION_FOREIGN")
            );
        }
        assert_eq!(
            refresh_entries(&io, menu, auto, Path::new("/moved/app")),
            Err("DESKTOP_INTEGRATION_FOREIGN")
        );
        assert_eq!(io.read(menu).unwrap().unwrap(), owned);
        assert_eq!(io.read(auto).unwrap().unwrap(), foreign);
    }
}
#[cfg(unix)]
#[test]
fn desktop_exec_escaping_cannot_inject_fields_or_expand_shell_variables() {
    let io = Memory(RefCell::default());
    let path = Path::new("/xdg/menu");
    entry_set(
        &io,
        path,
        Path::new("/app/a % \" $ ` \\ image"),
        EntryKind::Menu,
        true,
    )
    .unwrap();
    let text = io.read(path).unwrap().unwrap();
    assert_eq!(
        text.lines().find(|l| l.starts_with("Exec=")),
        Some(r#"Exec="/app/a %% \\" \\$ \\` \\\\ image" %u"#)
    );
    let before = io.read(path).unwrap();
    assert!(entry_set(
        &io,
        path,
        Path::new("/app/x\nExec=evil"),
        EntryKind::Menu,
        true
    )
    .is_err());
    assert_eq!(io.read(path).unwrap(), before);
}
#[cfg(unix)]
#[test]
fn real_files_adapter_uses_only_disposable_profile_and_preserves_foreign_entry() {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .canonicalize()
        .unwrap()
        .join("applications/app.plur1bus.desktop.desktop");
    entry_set(
        &FileEntries,
        &path,
        Path::new("/fake/one.AppImage"),
        EntryKind::Menu,
        true,
    )
    .unwrap();
    entry_set(
        &FileEntries,
        &path,
        Path::new("/fake/two.AppImage"),
        EntryKind::Menu,
        true,
    )
    .unwrap();
    std::fs::write(&path, "foreign").unwrap();
    assert_eq!(
        entry_set(
            &FileEntries,
            &path,
            Path::new("/fake/two.AppImage"),
            EntryKind::Menu,
            false
        ),
        Err("DESKTOP_INTEGRATION_FOREIGN")
    );
    assert_eq!(std::fs::read_to_string(path).unwrap(), "foreign");
}
#[cfg(unix)]
#[test]
fn symlink_entries_and_parent_directories_never_escape_disposable_root() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("foreign");
    std::fs::write(&target, "preserve").unwrap();
    let entry = root.path().join("entry");
    symlink(&target, &entry).unwrap();
    assert_eq!(
        entry_get(&FileEntries, &entry, EntryKind::Menu),
        Err("DESKTOP_INTEGRATION_FOREIGN")
    );
    let dir = root.path().join("actual");
    std::fs::create_dir(&dir).unwrap();
    let alias = root.path().join("alias");
    symlink(&dir, &alias).unwrap();
    assert_eq!(
        entry_set(
            &FileEntries,
            &alias.join("menu"),
            Path::new("/fake/image"),
            EntryKind::Menu,
            true
        ),
        Err("DESKTOP_INTEGRATION_FOREIGN")
    );
    assert!(!dir.join("menu").exists());
    assert_eq!(std::fs::read_to_string(target).unwrap(), "preserve");
}

#[cfg(any(not(windows), feature = "store"))]
#[test]
fn direct_windows_autostart_is_unavailable_on_other_platforms_and_store_builds() {
    assert_eq!(
        windows_autostart_get(),
        Err("DESKTOP_INTEGRATION_UNAVAILABLE")
    );
    assert_eq!(
        windows_autostart_set(true),
        Err("DESKTOP_INTEGRATION_UNAVAILABLE")
    );
    assert_eq!(
        windows_autostart_set(false),
        Err("DESKTOP_INTEGRATION_UNAVAILABLE")
    );
}
