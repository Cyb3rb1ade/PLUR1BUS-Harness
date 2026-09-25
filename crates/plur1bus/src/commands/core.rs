use crate::output::Out;
use crate::paths::Layout;
use serde_json::json;
use std::path::PathBuf;
use std::process::Command;

/// Locates the Node runtime and dist/core.js and runs the core in the foreground.
/// Order: $PLUR1BUS_NODE, <home>/runtime/node-*/bin/node (installed by setup, H2), `node` on PATH.
/// core.js: $PLUR1BUS_CORE_JS, then <home>/runtime/core/core.js (installed by setup, H2).
pub fn run(out: &Out, layout: &Layout) -> ! {
    let node = std::env::var_os("PLUR1BUS_NODE")
        .map(PathBuf::from)
        .or_else(|| {
            std::fs::read_dir(layout.runtime())
                .ok()?
                .filter_map(Result::ok)
                .map(|e| e.path())
                .find(|p| {
                    p.file_name()
                        .map(|n| n.to_string_lossy().starts_with("node-"))
                        .unwrap_or(false)
                })
                .map(|p| {
                    p.join("bin")
                        .join(if cfg!(windows) { "node.exe" } else { "node" })
                })
        })
        .unwrap_or_else(|| PathBuf::from("node"));
    let core_js = std::env::var_os("PLUR1BUS_CORE_JS")
        .map(PathBuf::from)
        .unwrap_or_else(|| layout.runtime().join("core").join("core.js"));
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
