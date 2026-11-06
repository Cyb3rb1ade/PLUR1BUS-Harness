//! Filesystem-only discovery and manual guidance; no installer process may run.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "plur1bus-ffmpeg-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn executable(&self, name: &str, text: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, text).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        path
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn manual_commands_are_fixed_for_each_supported_manager() {
    for (manager, command) in [
        (Manager::Brew, "brew install ffmpeg"),
        (Manager::Apt, "sudo apt install ffmpeg"),
        (Manager::Dnf, "sudo dnf install ffmpeg"),
        (Manager::Pacman, "sudo pacman -S ffmpeg"),
        (Manager::Zypper, "sudo zypper install ffmpeg"),
        (
            Manager::Winget,
            "winget install --id Gyan.FFmpeg --exact --source winget",
        ),
    ] {
        assert_eq!(manager.command(), command);
    }
}

#[test]
fn discovery_only_accepts_executable_files_and_native_windows_names() {
    let dir = Directory::new();
    fs::create_dir(dir.0.join("ffmpeg")).unwrap();
    assert_eq!(find_binary("ffmpeg", "linux", dir.0.as_os_str()), None);
    dir.executable("ffmpeg.cmd", "unused");
    assert_eq!(find_binary("ffmpeg", "windows", dir.0.as_os_str()), None);
    let native = dir.executable("ffmpeg.exe", "unused");
    assert_eq!(
        find_binary("ffmpeg", "windows", dir.0.as_os_str()),
        Some(native.canonicalize().unwrap())
    );
}

#[cfg(unix)]
#[test]
fn discovery_rejects_a_non_executable_file() {
    let dir = Directory::new();
    fs::write(dir.0.join("ffmpeg"), "unused").unwrap();
    assert_eq!(find_binary("ffmpeg", "linux", dir.0.as_os_str()), None);
}

#[cfg(unix)]
#[test]
fn discovery_respects_the_current_users_execute_permission() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Command, Stdio};
    let dir = Directory::new();
    let binary = dir.executable("ffmpeg", "#!/bin/sh\nexit 0\n");
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o001)).unwrap();
    // Check the actual OS boundary: root can execute this fixture, its unprivileged owner cannot.
    let os_allows_execution = Command::new(&binary)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    assert_eq!(
        find_binary("ffmpeg", "linux", dir.0.as_os_str()).is_some(),
        os_allows_execution
    );
}

#[test]
fn discovery_chooses_only_the_current_platforms_package_manager() {
    let dir = Directory::new();
    for name in ["apt", "dnf", "pacman", "zypper", "brew", "winget.exe"] {
        dir.executable(name, "unused");
    }
    for (platform, expected) in [
        ("linux", Manager::Apt),
        ("macos", Manager::Brew),
        ("windows", Manager::Winget),
    ] {
        let inspection = inspect_with(platform, dir.0.as_os_str(), "", None);
        assert_eq!(inspection.manual_commands, [expected.command()]);
    }
}

#[test]
fn manual_fallback_selects_a_distro_command_or_lists_exact_supported_commands() {
    let dir = Directory::new();
    for (release, expected) in [
        ("ID=ubuntu\n", "sudo apt install ffmpeg"),
        ("ID=fedora\n", "sudo dnf install ffmpeg"),
        ("ID=arch\n", "sudo pacman -S ffmpeg"),
        ("ID=opensuse-tumbleweed\n", "sudo zypper install ffmpeg"),
        (
            "ID=derivative\nID_LIKE=\"debian ubuntu\"\n",
            "sudo apt install ffmpeg",
        ),
    ] {
        assert_eq!(
            inspect_with("linux", dir.0.as_os_str(), release, None).manual_commands,
            [expected]
        );
    }
    assert_eq!(
        inspect_with("linux", dir.0.as_os_str(), "", None).manual_commands,
        [
            "sudo apt install ffmpeg",
            "sudo dnf install ffmpeg",
            "sudo pacman -S ffmpeg",
            "sudo zypper install ffmpeg"
        ]
    );
}

#[test]
fn fake_executable_override_requires_the_explicit_test_gate() {
    let dir = Directory::new();
    let executable = dir.executable(
        if cfg!(windows) {
            "fake-package-manager.exe"
        } else {
            "fake-package-manager"
        },
        "unused",
    );
    for gate in [None, Some(OsStr::new("0")), Some(OsStr::new("true"))] {
        assert!(
            test_manager(gate, Some(OsStr::new("apt")), Some(executable.as_os_str())).is_none()
        );
    }
    let plan = test_manager(
        Some(OsStr::new("1")),
        Some(OsStr::new("apt")),
        Some(executable.as_os_str()),
    )
    .unwrap();
    assert_eq!(plan, Manager::Apt);
    assert!(test_manager(
        Some(OsStr::new("1")),
        Some(OsStr::new("sh")),
        Some(executable.as_os_str())
    )
    .is_none());
}

#[cfg(unix)]
#[test]
fn test_manager_override_remains_read_only_even_when_it_would_succeed_or_fail() {
    for code in [0, 1, 126] {
        let dir = Directory::new();
        let marker = dir.0.join("executed");
        let executable = dir.executable(
            "fake-package-manager",
            &format!("#!/bin/sh\n: > '{}'\nexit {code}\n", marker.display()),
        );
        let manager = test_manager(
            Some(OsStr::new("1")),
            Some(OsStr::new("apt")),
            Some(executable.as_os_str()),
        )
        .unwrap();
        for interactive in [true, false] {
            let outcome = guidance(
                inspect_with("linux", dir.0.as_os_str(), "", Some(manager)),
                interactive,
            );
            assert!(!outcome.available);
            assert_eq!(outcome.manual_commands, ["sudo apt install ffmpeg"]);
            assert_eq!(
                outcome.state,
                if interactive {
                    "manual"
                } else {
                    "non-interactive"
                }
            );
            assert!(
                !marker.exists(),
                "the test seam must not enable an installation path"
            );
        }
    }
}

#[test]
fn missing_manager_still_provides_manual_guidance() {
    let dir = Directory::new();
    let outcome = guidance(inspect_with("macos", dir.0.as_os_str(), "", None), true);
    assert_eq!(outcome.state, "manual");
    assert_eq!(outcome.manual_commands, ["brew install ffmpeg"]);
}

#[test]
fn already_available_ffmpeg_needs_no_installation() {
    let dir = Directory::new();
    dir.executable("ffmpeg", "unused");
    let outcome = guidance(inspect_with("linux", dir.0.as_os_str(), "", None), true);
    assert_eq!(outcome.state, "available");
    assert!(outcome.available);
}

#[cfg(unix)]
#[test]
fn interactive_setup_never_executes_path_package_managers_or_sudo() {
    for (platform, manager) in [
        ("linux", "apt"),
        ("linux", "dnf"),
        ("linux", "pacman"),
        ("linux", "zypper"),
        ("macos", "brew"),
        ("windows", "winget.exe"),
    ] {
        let dir = Directory::new();
        let marker = dir.0.join("executed");
        let script = format!("#!/bin/sh\n: > '{}'\nexit 0\n", marker.display());
        dir.executable(manager, &script);
        dir.executable("sudo", &script);
        for interactive in [true, false] {
            let outcome = guidance(
                inspect_with(platform, dir.0.as_os_str(), "", None),
                interactive,
            );
            assert!(!outcome.available);
            assert!(!outcome.manual_commands.is_empty());
            assert!(
                !marker.exists(),
                "setup executed a package manager or sudo on {platform}"
            );
        }
    }
}
