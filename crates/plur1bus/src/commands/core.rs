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
                    contract: "1.9.0".into(),
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
