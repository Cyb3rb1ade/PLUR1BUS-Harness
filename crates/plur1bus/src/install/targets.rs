//! The five release targets (platform matrix §1, HB7): what `setup` downloads for, and what the release workflow
//! builds. macOS x64 is best-effort and not built (Q2), so [`Target::current`] is `None` there.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Target {
    LinuxX64,
    LinuxArm64,
    DarwinArm64,
    WinX64,
    WinArm64,
}

impl Target {
    /// Every target, in the order the release manifest and the workflow list them.
    pub const ALL: [Target; 5] = [
        Target::LinuxX64,
        Target::LinuxArm64,
        Target::DarwinArm64,
        Target::WinX64,
        Target::WinArm64,
    ];

    /// The target this binary was built for, `None` on a host outside the matrix.
    pub fn current() -> Option<Target> {
        if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            Some(Target::LinuxX64)
        } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
            Some(Target::LinuxArm64)
        } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            Some(Target::DarwinArm64)
        } else if cfg!(all(windows, target_arch = "x86_64")) {
            Some(Target::WinX64)
        } else if cfg!(all(windows, target_arch = "aarch64")) {
            Some(Target::WinArm64)
        } else {
            None
        }
    }

    /// The id used in file names, the install manifest and the release manifest (Node's own platform-arch names).
    pub fn id(self) -> &'static str {
        match self {
            Target::LinuxX64 => "linux-x64",
            Target::LinuxArm64 => "linux-arm64",
            Target::DarwinArm64 => "darwin-arm64",
            Target::WinX64 => "win-x64",
            Target::WinArm64 => "win-arm64",
        }
    }

    /// The inverse of [`Target::id`].
    pub fn from_id(id: &str) -> Option<Target> {
        Target::ALL.into_iter().find(|t| t.id() == id)
    }

    pub fn rust_triple(self) -> &'static str {
        match self {
            Target::LinuxX64 => "x86_64-unknown-linux-gnu",
            Target::LinuxArm64 => "aarch64-unknown-linux-gnu",
            Target::DarwinArm64 => "aarch64-apple-darwin",
            Target::WinX64 => "x86_64-pc-windows-msvc",
            Target::WinArm64 => "aarch64-pc-windows-msvc",
        }
    }

    pub fn is_windows(self) -> bool {
        matches!(self, Target::WinX64 | Target::WinArm64)
    }

    /// The Node distribution archive for `version` (without a leading `v`): `.tar.gz` on Linux and macOS, `.zip` on
    /// Windows, exactly as named in `https://nodejs.org/dist/v<version>/SHASUMS256.txt`.
    pub fn node_archive(self, version: &str) -> String {
        let ext = if self.is_windows() { "zip" } else { "tar.gz" };
        format!("node-v{version}-{}.{ext}", self.id())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_archive_names_per_target() {
        let names: Vec<String> = Target::ALL
            .iter()
            .map(|t| t.node_archive("24.21.0"))
            .collect();
        assert_eq!(
            names,
            [
                "node-v24.21.0-linux-x64.tar.gz",
                "node-v24.21.0-linux-arm64.tar.gz",
                "node-v24.21.0-darwin-arm64.tar.gz",
                "node-v24.21.0-win-x64.zip",
                "node-v24.21.0-win-arm64.zip",
            ]
        );
        for t in Target::ALL {
            assert_eq!(Target::from_id(t.id()), Some(t));
        }
        assert_eq!(Target::from_id("darwin-x64"), None);
    }

    #[test]
    fn rust_triples() {
        let triples: Vec<&str> = Target::ALL.iter().map(|t| t.rust_triple()).collect();
        assert_eq!(
            triples,
            [
                "x86_64-unknown-linux-gnu",
                "aarch64-unknown-linux-gnu",
                "aarch64-apple-darwin",
                "x86_64-pc-windows-msvc",
                "aarch64-pc-windows-msvc",
            ]
        );
    }

    /// CI runs on ubuntu-24.04 (x64), macos-15 (arm64) and windows-2025 (x64): each is a release target.
    #[test]
    fn current_target_is_some_on_ci_hosts() {
        let expected = if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            Some(Target::LinuxX64)
        } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            Some(Target::DarwinArm64)
        } else if cfg!(all(windows, target_arch = "x86_64")) {
            Some(Target::WinX64)
        } else {
            None
        };
        if let Some(t) = expected {
            assert_eq!(Target::current(), Some(t));
        }
        if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
            assert_eq!(
                Target::current(),
                None,
                "macOS x64 is not a release target (Q2)"
            );
        }
    }
}
