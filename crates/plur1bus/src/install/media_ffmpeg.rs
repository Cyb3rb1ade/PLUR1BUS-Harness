//! MM-3a/E7: discover system ffmpeg and offer fixed package-manager commands after separate consent.
//! No download, bundle or shell is involved; failures leave photo search available.
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Manager {
    Brew,
    Apt,
    Dnf,
    Pacman,
    Zypper,
    Winget,
}

const ALL_MANAGERS: &[Manager] = &[
    Manager::Brew,
    Manager::Apt,
    Manager::Dnf,
    Manager::Pacman,
    Manager::Zypper,
    Manager::Winget,
];

impl Manager {
    fn name(self) -> &'static str {
        match self {
            Self::Brew => "brew",
            Self::Apt => "apt",
            Self::Dnf => "dnf",
            Self::Pacman => "pacman",
            Self::Zypper => "zypper",
            Self::Winget => "winget",
        }
    }

    fn args(self) -> &'static [&'static str] {
        match self {
            Self::Brew | Self::Apt | Self::Dnf | Self::Zypper => &["install", "ffmpeg"],
            Self::Pacman => &["-S", "ffmpeg"],
            Self::Winget => &[
                "install",
                "--id",
                "Gyan.FFmpeg",
                "--exact",
                "--source",
                "winget",
            ],
        }
    }

    fn command(self) -> &'static str {
        match self {
            Self::Brew => "brew install ffmpeg",
            Self::Apt => "sudo apt install ffmpeg",
            Self::Dnf => "sudo dnf install ffmpeg",
            Self::Pacman => "sudo pacman -S ffmpeg",
            Self::Zypper => "sudo zypper install ffmpeg",
            Self::Winget => "winget install --id Gyan.FFmpeg --exact --source winget",
        }
    }

    fn requires_sudo(self) -> bool {
        matches!(self, Self::Apt | Self::Dnf | Self::Pacman | Self::Zypper)
    }
}

#[derive(Debug, Clone)]
struct Plan {
    manager: Manager,
    executable: PathBuf,
    fake: bool,
}

impl Plan {
    fn invocation(&self, sudo: Option<&Path>) -> Option<(PathBuf, Vec<OsString>)> {
        let mut args: Vec<OsString> = self.manager.args().iter().map(OsString::from).collect();
        if !self.fake && self.manager.requires_sudo() {
            args.insert(0, self.executable.as_os_str().to_owned());
            return Some((sudo?.to_path_buf(), args));
        }
        Some((self.executable.clone(), args))
    }
}

/// Read-only filesystem discovery result, including actionable manual commands.
#[derive(Debug)]
pub(crate) struct Inspection {
    pub(crate) available: bool,
    pub(crate) manual_commands: Vec<&'static str>,
    plan: Option<Plan>,
    platform: String,
    search_path: OsString,
}

/// Optional installation outcome; a missing ffmpeg never makes setup fail.
#[derive(Debug)]
pub(crate) struct SetupOutcome {
    pub(crate) available: bool,
    pub(crate) state: &'static str,
    pub(crate) manual_commands: Vec<&'static str>,
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: access only reads the current user's permissions, using a live NUL-terminated path.
        unsafe { libc::access(path.as_ptr(), libc::X_OK) == 0 }
    }
    #[cfg(not(unix))]
    true
}

fn find_binary(name: &str, platform: &str, path: &OsStr) -> Option<PathBuf> {
    // Match the Core decoder: Windows accepts native images, never .cmd/.bat or PATHEXT shell shims.
    let extensions: &[&str] = if platform == "windows" {
        &[".exe", ".com"]
    } else {
        &[""]
    };
    for dir in std::env::split_paths(path).filter(|p| !p.as_os_str().is_empty()) {
        for extension in extensions {
            let candidate = dir.join(format!("{name}{extension}"));
            if executable(&candidate) {
                if let Ok(absolute) = candidate.canonicalize() {
                    return Some(absolute);
                }
            }
        }
    }
    None
}

fn managers(platform: &str) -> &'static [Manager] {
    match platform {
        "macos" => &[Manager::Brew],
        "linux" => &[Manager::Apt, Manager::Dnf, Manager::Pacman, Manager::Zypper],
        "windows" => &[Manager::Winget],
        _ => &[],
    }
}

fn distro_manager(release: &str) -> Option<Manager> {
    for key in ["ID=", "ID_LIKE="] {
        let value = release.lines().find_map(|line| line.strip_prefix(key));
        for id in value
            .unwrap_or("")
            .trim_matches(['\'', '"'])
            .split_whitespace()
        {
            match id {
                "debian" | "ubuntu" | "linuxmint" => return Some(Manager::Apt),
                "fedora" | "rhel" | "centos" | "rocky" | "almalinux" => return Some(Manager::Dnf),
                "arch" | "manjaro" => return Some(Manager::Pacman),
                "suse" | "opensuse" | "opensuse-leap" | "opensuse-tumbleweed" | "sles" => {
                    return Some(Manager::Zypper)
                }
                _ => {}
            }
        }
    }
    None
}

fn test_plan(gate: Option<&OsStr>, manager: Option<&OsStr>, path: Option<&OsStr>) -> Option<Plan> {
    if gate != Some(OsStr::new("1")) {
        return None;
    }
    let manager = ALL_MANAGERS
        .iter()
        .copied()
        .find(|m| Some(OsStr::new(m.name())) == manager)?;
    let executable = PathBuf::from(path?);
    if !executable.is_absolute() || !self::executable(&executable) {
        return None;
    }
    #[cfg(windows)]
    if !executable
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("com"))
    {
        return None;
    }
    Some(Plan {
        manager,
        executable,
        fake: true,
    })
}

fn inspect_with(platform: &str, path: &OsStr, release: &str, test: Option<Plan>) -> Inspection {
    let supported = managers(platform);
    let plan = test.or_else(|| {
        supported.iter().find_map(|manager| {
            find_binary(manager.name(), platform, path).map(|executable| Plan {
                manager: *manager,
                executable,
                fake: false,
            })
        })
    });
    let preferred = plan.as_ref().map(|p| p.manager).or_else(|| {
        if platform == "linux" {
            distro_manager(release)
        } else {
            supported.first().copied()
        }
    });
    let manual_commands = preferred.map_or_else(
        || {
            let choices = if supported.is_empty() {
                ALL_MANAGERS
            } else {
                supported
            };
            choices.iter().map(|m| m.command()).collect()
        },
        |m| vec![m.command()],
    );
    Inspection {
        available: find_binary("ffmpeg", platform, path).is_some(),
        manual_commands,
        plan,
        platform: platform.into(),
        search_path: path.into(),
    }
}

/// Finds ffmpeg and supported package managers on PATH without executing a process or changing the system.
pub(crate) fn inspect() -> Inspection {
    let test = test_plan(
        std::env::var_os("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref(),
        std::env::var_os("PLUR1BUS_TEST_FFMPEG_MANAGER").as_deref(),
        std::env::var_os("PLUR1BUS_TEST_FFMPEG_PACKAGE_MANAGER").as_deref(),
    );
    let path = std::env::var_os("PATH").unwrap_or_default();
    let release = if cfg!(target_os = "linux") {
        fs::read_to_string("/etc/os-release").unwrap_or_default()
    } else {
        String::new()
    };
    inspect_with(std::env::consts::OS, &path, &release, test)
}

fn fallback(inspection: Inspection, state: &'static str) -> SetupOutcome {
    eprintln!(
        "ffmpeg is unavailable ({state}). Photos continue to work; audio and video need ffmpeg."
    );
    for command in &inspection.manual_commands {
        eprintln!("  Run manually with the matching system package manager: {command}");
    }
    SetupOutcome {
        available: false,
        state,
        manual_commands: inspection.manual_commands,
    }
}

fn offer(
    inspection: Inspection,
    interactive: bool,
    mut confirm: impl FnMut(&str) -> bool,
) -> SetupOutcome {
    if inspection.available {
        return SetupOutcome {
            available: true,
            state: "available",
            manual_commands: inspection.manual_commands,
        };
    }
    if !interactive {
        return fallback(inspection, "non-interactive");
    }
    let Some(plan) = inspection.plan.as_ref() else {
        return fallback(inspection, "no-package-manager");
    };
    let question = format!(
        "Install ffmpeg with `{}`? This is separate consent; the system may ask for sudo/UAC approval",
        plan.manager.command()
    );
    if !confirm(&question) {
        return fallback(inspection, "declined");
    }
    let sudo = find_binary("sudo", &inspection.platform, &inspection.search_path);
    let Some((program, args)) = plan.invocation(sudo.as_deref()) else {
        return fallback(inspection, "elevation-unavailable");
    };
    // E7: the terminal belongs to the OS package manager. Never pass approval/elevation-bypass flags.
    let result = Command::new(program)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();
    if !result.is_ok_and(|status| status.success()) {
        return fallback(inspection, "install-failed");
    }
    if find_binary("ffmpeg", &inspection.platform, &inspection.search_path).is_none() {
        eprintln!("The package manager completed, but ffmpeg is not on PATH. Refresh the terminal PATH and retry.");
        return fallback(inspection, "not-on-path");
    }
    SetupOutcome {
        available: true,
        state: "installed",
        manual_commands: inspection.manual_commands,
    }
}

/// Offers installation only when the caller has an interactive terminal, using a separate, default-no answer.
/// A global `--yes` is intentionally not an input to this consent gate. No failure aborts photo setup.
pub(crate) fn setup(interactive: bool, confirm: impl FnMut(&str) -> bool) -> SetupOutcome {
    offer(inspect(), interactive, confirm)
}

#[cfg(test)]
#[path = "media_ffmpeg_tests.rs"]
mod tests;
