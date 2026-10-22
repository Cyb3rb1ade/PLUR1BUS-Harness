//! Shared setup checks for tests which invoke the real TypeScript sources or built core.
use std::path::Path;
use std::process::Command;

pub fn require(mode: &str, root: &Path) {
    let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/test-prerequisites.mjs");
    let output = Command::new(&node)
        .args([
            "--experimental-strip-types",
            "--conditions=source",
            "--no-warnings=ExperimentalWarning",
        ])
        .arg(script)
        .arg(mode)
        .arg(root)
        .output()
        .unwrap_or_else(|error| {
            panic!("Test prerequisites ({mode}): could not run Node {node:?}: {error}. Install Node 24.21 and put it on PATH or set PLUR1BUS_NODE. Run `pnpm test:prep` (GP5 T2) for workspace prerequisites.")
        });
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
