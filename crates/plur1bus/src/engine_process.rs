//! Shared Rust-engine process specification for supervisor and standalone Core ownership.

use crate::{paths::Layout, supervisor::child::ChildSpec};
use serde_json::Value;
use std::{ffi::OsStr, path::Path};

pub(crate) fn selected(config: &Value) -> Result<bool, &'static str> {
    match config.pointer("/engine/implementation") {
        None if config.is_object() => Ok(false),
        Some(Value::String(value)) if value == "node" => Ok(false),
        Some(Value::String(value)) if value == "rust" => Ok(true),
        _ => Err("invalid engine implementation"),
    }
}

/// Read the same validated selector as Core without creating or rewriting config.json.
pub(crate) fn configured_spec(
    layout: &Layout,
    instance: &str,
) -> Result<Option<ChildSpec>, &'static str> {
    let config = plur1bus_config::read(&layout.config_path())
        .map_err(|_| "engine configuration is invalid")?;
    if !selected(&config)? {
        return Ok(None);
    }
    spec(layout, instance).map(Some)
}

/// What a try-lock of `run/engine.process.lock` found ([`lock_state`]).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LockState {
    /// No lock file, or one this process could lock (and released at once).
    Free,
    /// Another process holds the OS lock: a running Rust engine (or another holder).
    Held,
    /// The file exists but could not be opened or locked (a symlink, no permission, a sharing violation, ...): it
    /// cannot be checked, which counts as held (fail closed, T8a N3). The error, for the message.
    Unverifiable(String),
}

/// `run/engine.process.lock`, the OS lock every running Rust engine holds (and `backup restore` fences): one exclusive
/// try-lock, released at once. Only a missing file is free without locking; every other open or lock failure is
/// [`LockState::Unverifiable`]. The file is never created (no `create`, `O_NOFOLLOW`). Shared by the supervisor's B3
/// gate and `core run` with the Node engine (RE-D173, Nachtrag 8), which both refuse anything but `Free`.
pub(crate) fn lock_state(layout: &Layout) -> LockState {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = match options.open(layout.run().join("engine.process.lock")) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return LockState::Free,
        Err(e) => return LockState::Unverifiable(e.to_string()),
    };
    match file.try_lock() {
        Ok(()) => LockState::Free,
        Err(std::fs::TryLockError::WouldBlock) => LockState::Held,
        Err(std::fs::TryLockError::Error(e)) => LockState::Unverifiable(e.to_string()),
    }
}

/// Keep the same engine writer fence as the engine process across a cold import.
pub(crate) fn hold_writer(layout: &Layout) -> std::io::Result<std::fs::File> {
    let run = layout.run();
    plur1bus_rpc::trust::verify_run_dir(&run).map_err(std::io::Error::other)?;
    let path = run.join("engine.process.lock");
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(std::io::Error::other("invalid engine writer lock"));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other("invalid engine writer lock"));
    }
    file.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => std::io::ErrorKind::WouldBlock.into(),
        std::fs::TryLockError::Error(error) => error,
    })?;
    Ok(file)
}

fn executable_path(
    current: Option<&Path>,
    override_path: Option<&OsStr>,
) -> Result<std::path::PathBuf, &'static str> {
    if let Some(path) = override_path {
        return Ok(path.into());
    }
    current
        .and_then(Path::parent)
        .map(|parent| {
            parent.join(if cfg!(windows) {
                "plur1bus-engine.exe"
            } else {
                "plur1bus-engine"
            })
        })
        .ok_or("cannot locate engine executable")
}

/// The single engine specification used by both process owners. No token is put in argv/env.
pub(crate) fn spec(layout: &Layout, instance: &str) -> Result<ChildSpec, &'static str> {
    let current = std::env::current_exe().ok();
    let override_path = std::env::var_os("PLUR1BUS_ENGINE_BIN");
    let executable = executable_path(current.as_deref(), override_path.as_deref())?;
    let seam = std::env::var_os("PLUR1BUS_TEST_INTERNALS");
    let allow =
        std::env::var_os("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Some(OsStr::new("1"));
    spec_with(layout, instance, &executable, seam.as_deref(), allow)
}

fn spec_with(
    layout: &Layout,
    instance: &str,
    executable: &Path,
    seam: Option<&OsStr>,
    allow: bool,
) -> Result<ChildSpec, &'static str> {
    uuid::Uuid::parse_str(instance).map_err(|_| "invalid engine incarnation")?;
    let executable = executable
        .canonicalize()
        .map_err(|_| "engine executable is unavailable")?;
    if !executable.is_file() {
        return Err("engine executable is not a regular file");
    }
    let mut args = vec![
        "serve".into(),
        "--home".into(),
        layout.home.clone().into(),
        "--lifeline".into(),
        "stdin".into(),
        "--instance".into(),
        instance.into(),
    ];
    if let Some(seam) = seam {
        if !allow {
            return Err("engine test seams require explicit authorization");
        }
        if !matches!(seam.to_str(), Some("flat-embedder" | "flat-embedder-cold")) {
            return Err("unknown engine test seam");
        }
        args.extend(["--test-internals".into(), seam.to_owned()]);
    }
    Ok(ChildSpec {
        role: "engine".into(),
        program: executable,
        args,
        env: Vec::new(),
        cwd: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// T8a N3: only a missing file is free without locking; a free file is free; a held one is held; a file that
    /// cannot be opened (a symlink under O_NOFOLLOW, no permission) cannot be checked, which counts as held. Nothing is
    /// ever created.
    #[test]
    fn a_cold_import_fence_excludes_engine_writers_until_released() {
        let root = tempfile::tempdir().unwrap();
        let layout = Layout::new(root.path().to_owned());
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(layout.run()).unwrap();
        let guard = hold_writer(&layout).unwrap();
        assert_eq!(lock_state(&layout), LockState::Held);
        assert_eq!(
            hold_writer(&layout).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        drop(guard);
        assert_eq!(lock_state(&layout), LockState::Free);
        assert!(hold_writer(&layout).is_ok());
    }

    #[test]
    fn only_a_missing_or_free_engine_lock_is_free() {
        let root = tempfile::tempdir().unwrap();
        let layout = Layout::new(root.path().to_owned());
        let lock = layout.run().join("engine.process.lock");
        assert_eq!(lock_state(&layout), LockState::Free, "no run/ at all");
        std::fs::create_dir_all(layout.run()).unwrap();
        assert_eq!(lock_state(&layout), LockState::Free, "no lock file");
        assert!(!lock.exists(), "never created");
        std::fs::write(&lock, b"").unwrap();
        assert_eq!(lock_state(&layout), LockState::Free, "a free file");
        let holder = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock)
            .unwrap();
        holder.lock().unwrap();
        assert_eq!(lock_state(&layout), LockState::Held);
        assert_ne!(lock_state(&layout), LockState::Free);
        drop(holder);
        assert_eq!(lock_state(&layout), LockState::Free);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::remove_file(&lock).unwrap();
            let target = root.path().join("elsewhere.lock");
            std::os::unix::fs::symlink(&target, &lock).unwrap();
            assert!(matches!(lock_state(&layout), LockState::Unverifiable(_)));
            assert_ne!(lock_state(&layout), LockState::Free, "fail closed");
            assert!(!target.exists(), "nothing created through the link");
            std::fs::remove_file(&lock).unwrap();
            // SAFETY: plain geteuid(2).
            if unsafe { libc::geteuid() } != 0 {
                std::fs::write(&lock, b"").unwrap();
                std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o000)).unwrap();
                assert!(matches!(lock_state(&layout), LockState::Unverifiable(_)));
                std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o600)).unwrap();
            }
        }
    }

    #[test]
    fn default_config_does_not_resolve_an_engine_or_create_config_files() {
        let root = tempfile::tempdir().unwrap();
        let layout = Layout::new(root.path().to_owned());
        assert!(
            configured_spec(&layout, "0b7a6a6e-2f1d-4c1e-9a55-6d7e8f901234")
                .unwrap()
                .is_none()
        );
        assert!(!layout.config_path().exists());
    }

    #[test]
    fn explicit_binary_override_wins_over_the_executable_sibling() {
        let root = tempfile::tempdir().unwrap();
        let current = root.path().join("plur1bus");
        let override_path = root.path().join("other engine");
        assert_eq!(
            executable_path(Some(&current), Some(override_path.as_os_str())).unwrap(),
            override_path
        );
        assert_eq!(
            executable_path(None, Some(override_path.as_os_str())).unwrap(),
            override_path
        );
        assert_eq!(
            executable_path(Some(&current), None).unwrap(),
            root.path().join(if cfg!(windows) {
                "plur1bus-engine.exe"
            } else {
                "plur1bus-engine"
            })
        );
    }

    #[test]
    fn implementation_selection_uses_validated_config_without_an_environment_override() {
        assert!(!selected(&json!({})).unwrap());
        assert!(!selected(&json!({"engine":{"implementation":"node"}})).unwrap());
        assert!(selected(&json!({"engine":{"implementation":"rust"}})).unwrap());
        assert!(selected(&json!({"engine":{"implementation":"unknown"}})).is_err());
        assert!(selected(&json!({"engine":{"implementation":true}})).is_err());
    }

    #[test]
    fn common_spec_binds_home_instance_lifeline_and_native_executable() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("engine with space");
        std::fs::write(&executable, b"fixture").unwrap();
        let layout = Layout::new(root.path().join("home with space"));
        let instance = "0b7a6a6e-2f1d-4c1e-9a55-6d7e8f901234";
        let spec = spec_with(&layout, instance, &executable, None, false).unwrap();
        assert_eq!(spec.role, "engine");
        assert_eq!(spec.program, executable.canonicalize().unwrap());
        let args: Vec<_> = spec.args.iter().map(|s| s.to_str().unwrap()).collect();
        assert_eq!(
            args,
            vec![
                "serve",
                "--home",
                layout.home.to_str().unwrap(),
                "--lifeline",
                "stdin",
                "--instance",
                instance
            ]
        );
        assert!(spec.env.is_empty());
        assert!(spec.cwd.is_none());
    }

    #[test]
    fn test_seam_is_forwarded_only_with_explicit_authorization() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("engine");
        std::fs::write(&executable, b"fixture").unwrap();
        let layout = Layout::new(root.path().to_owned());
        let instance = "0b7a6a6e-2f1d-4c1e-9a55-6d7e8f901234";
        let denied = spec_with(
            &layout,
            instance,
            &executable,
            Some(OsStr::new("flat-embedder")),
            false,
        );
        assert!(denied.is_err());
        let allowed = spec_with(
            &layout,
            instance,
            &executable,
            Some(OsStr::new("flat-embedder")),
            true,
        )
        .unwrap();
        assert_eq!(allowed.args[7], "--test-internals");
        assert_eq!(allowed.args[8], "flat-embedder");
        assert!(spec_with(
            &layout,
            instance,
            &executable,
            Some(OsStr::new("unknown")),
            true
        )
        .is_err());
    }

    #[test]
    fn missing_binary_and_invalid_incarnation_fail_before_spawning() {
        let root = tempfile::tempdir().unwrap();
        let layout = Layout::new(root.path().to_owned());
        assert!(spec_with(
            &layout,
            "0b7a6a6e-2f1d-4c1e-9a55-6d7e8f901234",
            Path::new("/missing/engine"),
            None,
            false
        )
        .is_err());
        assert!(spec_with(&layout, "invalid", root.path(), None, false).is_err());
    }
}
