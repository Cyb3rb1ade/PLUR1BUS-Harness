use crate::output::Out;
use crate::paths::Layout;
use serde_json::json;
use std::path::PathBuf;
use std::process::Command;

/// The Node runtime (HB8): $PLUR1BUS_NODE, then the install manifest's `node.path` (written by setup), then the
/// first `<home>/runtime/node-*/bin/node` by name (never a staged `*.tmp-*` tree), then `node` on PATH. Shared by
/// `core run`, `import` and the supervisor.
pub(crate) fn locate_node(layout: &Layout) -> PathBuf {
    locate_node_with(std::env::var_os("PLUR1BUS_NODE"), layout)
}

fn locate_node_with(env_node: Option<std::ffi::OsString>, layout: &Layout) -> PathBuf {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    env_node
        .map(PathBuf::from)
        .or_else(|| {
            crate::install::manifest::read(layout)
                .ok()
                .flatten()
                .map(|m| PathBuf::from(m.node.path))
                .filter(|p| p.is_file())
        })
        .or_else(|| {
            let mut found: Vec<PathBuf> = std::fs::read_dir(layout.runtime())
                .ok()?
                .filter_map(Result::ok)
                .filter(|e| {
                    let n = e.file_name().to_string_lossy().into_owned();
                    n.starts_with("node-") && !n.contains(".tmp-")
                })
                .map(|e| e.path().join("bin").join(exe))
                .filter(|p| p.is_file())
                .collect();
            found.sort();
            found.into_iter().next()
        })
        .unwrap_or_else(|| PathBuf::from("node"))
}

/// dist/core.js: $PLUR1BUS_CORE_JS, then <home>/runtime/core/core.js (installed by setup, H2). Not checked for
/// existence here.
pub(crate) fn locate_core_js(layout: &Layout) -> PathBuf {
    std::env::var_os("PLUR1BUS_CORE_JS")
        .map(PathBuf::from)
        .unwrap_or_else(|| layout.runtime().join("core").join("core.js"))
}

/// The native attestation helper (`plur1bus-attest`, issue #192) shipped beside this executable, as a canonical absolute path, or
/// `None`. The core pins whatever it is given again (`PLUR1BUS_ATTEST_BIN`: absolute, regular file, not group/world-writable), so a
/// path that fails there simply means "no attestation here"; nothing breaks. A value already in the environment wins, as it does for
/// `PLUR1BUS_CORE_JS`.
pub(crate) fn locate_attest_bin() -> Option<PathBuf> {
    if std::env::var_os("PLUR1BUS_ATTEST_BIN").is_some() {
        return None; // inherited by the child as it is
    }
    attest_beside(&std::env::current_exe().ok()?)
}

pub(crate) fn attest_beside(exe: &std::path::Path) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "plur1bus-attest.exe"
    } else {
        "plur1bus-attest"
    };
    let candidate = exe.parent()?.join(name);
    if !candidate.is_file() {
        return None;
    }
    std::fs::canonicalize(candidate).ok()
}

/// The environment entries that hand the helper's expected content to the core. Passed verbatim and not validated: a malformed
/// value must reach the core, which then runs no helper at all, instead of vanishing and leaving the helper unpinned.
pub(crate) fn attest_pin_env(
    sha256: Option<&str>,
    team_id: Option<&str>,
    win_thumbprint: Option<&str>,
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    [
        ("PLUR1BUS_ATTEST_SHA256", sha256),
        ("PLUR1BUS_ATTEST_TEAM_ID", team_id),
        ("PLUR1BUS_ATTEST_WIN_THUMBPRINT", win_thumbprint),
    ]
    .into_iter()
    .filter_map(|(k, v)| v.map(|v| (k.into(), v.into())))
    .collect()
}

/// What the core child's environment gains from [`locate_attest_bin`]: the helper beside this executable and, when the build baked
/// them, the pins it must match. An inherited `PLUR1BUS_ATTEST_BIN` (an operator's own helper) brings no baked pins: they describe
/// the shipped binary, not that one.
pub(crate) fn attest_env() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let Some(bin) = locate_attest_bin() else {
        return Vec::new();
    };
    let (sha, team, thumb) = crate::install::pins::attest_helper_pins();
    let mut env = vec![("PLUR1BUS_ATTEST_BIN".into(), bin.into_os_string())];
    env.extend(attest_pin_env(sha, team, thumb));
    env
}

/// Locates the Node runtime ([`locate_node`]) and dist/core.js ([`locate_core_js`]) and runs the core in the
/// foreground.
pub fn run(out: &Out, layout: &Layout) -> ! {
    let node = locate_node(layout);
    let core_js = locate_core_js(layout);
    if !core_js.exists() {
        out.fail(
            "E_CORE_UNAVAILABLE",
            &format!(
                "core.js not found at {} (set PLUR1BUS_CORE_JS or run setup)",
                core_js.display()
            ),
            json!({}),
            1,
        );
    }
    let mut cmd = Command::new(&node);
    cmd.arg(&core_js).arg("--home").arg(&layout.home);
    cmd.envs(attest_env());
    if let Some(ti) = std::env::var_os("PLUR1BUS_TEST_INTERNALS") {
        cmd.arg("--test-internals").arg(ti);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let e = cmd.exec();
        out.fail(
            "E_CORE_UNAVAILABLE",
            &format!("cannot exec {}: {e}", node.display()),
            json!({}),
            1,
        );
    }
    #[cfg(windows)]
    {
        match cmd.status() {
            Ok(s) => std::process::exit(s.code().unwrap_or(1)),
            Err(e) => out.fail(
                "E_CORE_UNAVAILABLE",
                &format!("cannot start {}: {e}", node.display()),
                json!({}),
                1,
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::manifest::{self, CoreUnit, InstallManifest, NodeUnit, Unit};

    fn touch(p: &std::path::Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "").unwrap();
    }

    #[test]
    fn the_attest_helper_is_the_binary_beside_the_executable_and_only_when_it_exists() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join(if cfg!(windows) {
            "plur1bus.exe"
        } else {
            "plur1bus"
        });
        assert_eq!(attest_beside(&exe), None);
        let helper = dir.path().join(if cfg!(windows) {
            "plur1bus-attest.exe"
        } else {
            "plur1bus-attest"
        });
        touch(&helper);
        assert_eq!(
            attest_beside(&exe),
            Some(std::fs::canonicalize(&helper).unwrap())
        );
    }

    #[test]
    fn the_baked_attest_pins_travel_as_environment_verbatim() {
        let none = attest_pin_env(None, None, None);
        assert!(none.is_empty());
        let all = attest_pin_env(
            Some("ab".repeat(32).as_str()),
            Some("ABCDE12345"),
            Some("A1"),
        );
        let get = |k: &str| {
            all.iter()
                .find(|(n, _)| n == k)
                .map(|(_, v)| v.to_string_lossy().into_owned())
        };
        assert_eq!(get("PLUR1BUS_ATTEST_SHA256"), Some("ab".repeat(32)));
        assert_eq!(
            get("PLUR1BUS_ATTEST_TEAM_ID").as_deref(),
            Some("ABCDE12345")
        );
        // Not validated here: a malformed pin must reach the core, which then runs no helper (fail closed),
        // instead of vanishing and leaving the helper unpinned.
        assert_eq!(get("PLUR1BUS_ATTEST_WIN_THUMBPRINT").as_deref(), Some("A1"));
        let empty = attest_pin_env(Some(""), None, None);
        assert_eq!(empty.len(), 1);
    }

    #[test]
    fn locate_node_prefers_the_manifest_path() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().join("h"));
        let exe = if cfg!(windows) { "node.exe" } else { "node" };
        let first = layout.runtime().join("node-1.0.0").join("bin").join(exe);
        touch(&first);
        touch(
            &layout
                .runtime()
                .join("node-0.9.0.tmp-7")
                .join("bin")
                .join(exe),
        );
        assert_eq!(
            locate_node_with(None, &layout),
            first,
            "the first runtime/node-* by name, never a temp"
        );

        let pinned = dir.path().join("elsewhere").join(exe);
        touch(&pinned);
        let sha = "0".repeat(64);
        manifest::write(
            &layout,
            &InstallManifest {
                schema_version: 1,
                installed_at: 1,
                updated_at: 1,
                channel: "stable".into(),
                target: "linux-x64".into(),
                binary: Unit {
                    version: "0.1.0".into(),
                    sha256: None,
                },
                node: NodeUnit {
                    version: "24.21.0".into(),
                    archive_sha256: sha.clone(),
                    binary_sha256: sha,
                    path: pinned.to_string_lossy().into_owned(),
                },
                core: CoreUnit {
                    version: "0.1.0".into(),
                    contract: crate::install::manifest::CORE_CONTRACT.into(),
                    rpc: "1.3.0".into(),
                    sha256: None,
                    source: "local".into(),
                },
                modules: vec![],
                skills: vec![],
                profile: None,
            },
        )
        .unwrap();
        assert_eq!(locate_node_with(None, &layout), pinned);
        assert_eq!(
            locate_node_with(Some("/opt/node".into()), &layout),
            PathBuf::from("/opt/node"),
            "PLUR1BUS_NODE wins"
        );
        std::fs::remove_file(&pinned).unwrap();
        assert_eq!(
            locate_node_with(None, &layout),
            first,
            "a vanished manifest path falls through"
        );
        std::fs::remove_dir_all(layout.runtime()).unwrap();
        assert_eq!(locate_node_with(None, &layout), PathBuf::from("node"));
    }
}
