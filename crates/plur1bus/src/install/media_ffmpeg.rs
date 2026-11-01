//! MM-3a/E7: read-only ffmpeg discovery and manual package-manager guidance.
//! No download, bundle or shell is involved; failures leave photo search available.
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

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
}

/// Read-only filesystem discovery result, including actionable manual commands.
#[derive(Debug)]
pub(crate) struct Inspection {
    pub(crate) available: bool,
    pub(crate) manual_commands: Vec<&'static str>,
}

/// Read-only setup outcome; missing ffmpeg never makes setup fail.
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

fn test_manager(
    gate: Option<&OsStr>,
    manager: Option<&OsStr>,
    path: Option<&OsStr>,
) -> Option<Manager> {
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
    Some(manager)
}

fn inspect_with(platform: &str, path: &OsStr, release: &str, test: Option<Manager>) -> Inspection {
    let supported = managers(platform);
    let preferred = test
        .or_else(|| {
            supported
                .iter()
                .copied()
                .find(|manager| find_binary(manager.name(), platform, path).is_some())
        })
        .or_else(|| {
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
    }
}

/// Finds ffmpeg and supported package managers on PATH without executing a process or changing the system.
pub(crate) fn inspect() -> Inspection {
    let test = test_manager(
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

fn guidance(inspection: Inspection, interactive: bool) -> SetupOutcome {
    if inspection.available {
        return SetupOutcome {
            available: true,
            state: "available",
            manual_commands: inspection.manual_commands,
        };
    }
    // Owner rule: never start sudo, a package manager or an elevation helper.
    // This is identical for root and non-root callers, interactive or unattended.
    fallback(
        inspection,
        if interactive {
            "manual"
        } else {
            "non-interactive"
        },
    )
}

/// Reports availability or manual installation commands without starting a process.
/// Neither an interactive terminal, global `--yes`, root privileges nor test seams permit installation.
pub(crate) fn setup(interactive: bool) -> SetupOutcome {
    guidance(inspect(), interactive)
}

#[cfg(test)]
#[path = "media_ffmpeg_tests.rs"]
mod tests;
