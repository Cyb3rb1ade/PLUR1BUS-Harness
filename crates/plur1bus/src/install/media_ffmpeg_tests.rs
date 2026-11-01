//! Fixed argv, consent and filesystem discovery tests; fake executables never invoke a package manager.
use super::*;
use std::cell::Cell;
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
fn package_plans_keep_fixed_argv_and_leave_os_approval_interactive() {
    for (manager, program, args, command) in [
        (
            Manager::Brew,
            "brew",
            vec!["install", "ffmpeg"],
            "brew install ffmpeg",
        ),
        (
            Manager::Apt,
            "sudo",
            vec!["apt", "install", "ffmpeg"],
            "sudo apt install ffmpeg",
        ),
        (
            Manager::Dnf,
            "sudo",
            vec!["dnf", "install", "ffmpeg"],
            "sudo dnf install ffmpeg",
        ),
        (
            Manager::Pacman,
            "sudo",
            vec!["pacman", "-S", "ffmpeg"],
            "sudo pacman -S ffmpeg",
        ),
        (
            Manager::Zypper,
            "sudo",
            vec!["zypper", "install", "ffmpeg"],
            "sudo zypper install ffmpeg",
        ),
        (
            Manager::Winget,
            "winget",
            vec![
                "install",
                "--id",
                "Gyan.FFmpeg",
                "--exact",
                "--source",
                "winget",
            ],
            "winget install --id Gyan.FFmpeg --exact --source winget",
        ),
    ] {
        let plan = Plan {
            manager,
            executable: manager.name().into(),
            fake: false,
        };
        let (actual_program, actual_args) = plan.invocation(Some(Path::new("sudo"))).unwrap();
        assert_eq!(actual_program, Path::new(program));
        assert_eq!(
            actual_args,
            args.iter().map(OsString::from).collect::<Vec<_>>()
        );
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
        assert_eq!(inspection.plan.unwrap().manager, expected);
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
        assert!(test_plan(gate, Some(OsStr::new("apt")), Some(executable.as_os_str())).is_none());
    }
    let plan = test_plan(
        Some(OsStr::new("1")),
        Some(OsStr::new("apt")),
        Some(executable.as_os_str()),
    )
    .unwrap();
    assert!(plan.fake);
    assert_eq!(plan.executable, executable);
    assert!(test_plan(
        Some(OsStr::new("1")),
        Some(OsStr::new("sh")),
        Some(executable.as_os_str())
    )
    .is_none());
}

#[cfg(unix)]
fn fake_inspection(dir: &Directory, script: &str) -> Inspection {
    let executable = dir.executable("fake-package-manager", script);
    let plan = test_plan(
        Some(OsStr::new("1")),
        Some(OsStr::new("apt")),
        Some(executable.as_os_str()),
    )
    .unwrap();
    inspect_with("linux", dir.0.as_os_str(), "ID=debian\n", Some(plan))
}

#[cfg(unix)]
#[test]
fn unattended_setup_never_prompts_or_launches_the_fake_manager() {
    let dir = Directory::new();
    let inspection = fake_inspection(&dir, "#!/bin/sh\nexit 99\n");
    let outcome = offer(inspection, false, |_| {
        panic!("unattended install asked for consent")
    });
    assert_eq!(outcome.state, "non-interactive");
    assert!(!outcome.available);
    assert_eq!(outcome.manual_commands, ["sudo apt install ffmpeg"]);
}

#[cfg(unix)]
#[test]
fn declined_install_never_executes_the_fake_manager() {
    let dir = Directory::new();
    let marker = dir.0.join("called");
    let inspection = fake_inspection(&dir, &format!("#!/bin/sh\n: > '{}'\n", marker.display()));
    let asked = Cell::new(false);
    let outcome = offer(inspection, true, |question| {
        asked.set(true);
        assert!(question.contains("sudo apt install ffmpeg"));
        false
    });
    assert!(asked.get());
    assert_eq!(outcome.state, "declined");
    assert!(!marker.exists());
}

#[cfg(unix)]
#[test]
fn accepted_install_runs_only_fixed_arguments_then_rechecks_ffmpeg() {
    let dir = Directory::new();
    let arguments = dir.0.join("arguments");
    let ffmpeg = dir.0.join("ffmpeg");
    let inspection = fake_inspection(
        &dir,
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n: > '{}'\n/bin/chmod 700 '{}'\n",
            arguments.display(),
            ffmpeg.display(),
            ffmpeg.display()
        ),
    );
    let outcome = offer(inspection, true, |_| true);
    assert_eq!(outcome.state, "installed");
    assert!(outcome.available);
    assert_eq!(fs::read_to_string(arguments).unwrap(), "install\nffmpeg\n");
}

#[cfg(unix)]
#[test]
fn package_failure_keeps_photos_available_and_returns_the_manual_command() {
    let dir = Directory::new();
    for code in [1, 126] {
        let inspection = fake_inspection(&dir, &format!("#!/bin/sh\nexit {code}\n"));
        let outcome = offer(inspection, true, |_| true);
        assert_eq!(outcome.state, "install-failed");
        assert!(!outcome.available);
        assert_eq!(outcome.manual_commands, ["sudo apt install ffmpeg"]);
    }
}

#[cfg(unix)]
#[test]
fn successful_package_install_without_a_visible_ffmpeg_keeps_the_manual_fallback() {
    let dir = Directory::new();
    let outcome = offer(fake_inspection(&dir, "#!/bin/sh\nexit 0\n"), true, |_| true);
    assert_eq!(outcome.state, "not-on-path");
    assert!(!outcome.available);
    assert_eq!(outcome.manual_commands, ["sudo apt install ffmpeg"]);
}

#[cfg(unix)]
#[test]
fn package_manager_spawn_failure_keeps_setup_running() {
    let dir = Directory::new();
    let inspection = fake_inspection(&dir, "#!/bin/sh\nexit 0\n");
    fs::remove_file(dir.0.join("fake-package-manager")).unwrap();
    let outcome = offer(inspection, true, |_| true);
    assert_eq!(outcome.state, "install-failed");
    assert_eq!(outcome.manual_commands, ["sudo apt install ffmpeg"]);
}

#[test]
fn missing_manager_never_prompts_and_provides_a_manual_command() {
    let dir = Directory::new();
    let outcome = offer(
        inspect_with("macos", dir.0.as_os_str(), "", None),
        true,
        |_| panic!("no package manager"),
    );
    assert_eq!(outcome.state, "no-package-manager");
    assert_eq!(outcome.manual_commands, ["brew install ffmpeg"]);
}

#[test]
fn missing_sudo_never_launches_a_linux_package_manager() {
    let dir = Directory::new();
    dir.executable("apt", "unused");
    let outcome = offer(
        inspect_with("linux", dir.0.as_os_str(), "", None),
        true,
        |_| true,
    );
    assert_eq!(outcome.state, "elevation-unavailable");
    assert_eq!(outcome.manual_commands, ["sudo apt install ffmpeg"]);
}

#[test]
fn already_available_ffmpeg_requires_no_installation_consent() {
    let dir = Directory::new();
    dir.executable("ffmpeg", "unused");
    let outcome = offer(
        inspect_with("linux", dir.0.as_os_str(), "", None),
        true,
        |_| panic!("already available"),
    );
    assert_eq!(outcome.state, "available");
    assert!(outcome.available);
}
