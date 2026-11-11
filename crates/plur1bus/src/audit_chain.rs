//! The CLI side of the audit chain. The writer (D1: offline Rust writers share the core's chain and SQLite OS byte-range
//! lock) lives in `crates/plur1bus-audit` since P4-03, shared with the Rust core. This adapter supplies the CLI's actor
//! (the OS user and host, `writer: "cli"`) and keeps the two-argument calls every CLI module uses.
use plur1bus_audit::chain::Actor;
// `audit.rs` (and with it this file) is also compiled into integration tests that use only part of it, like the
// `#![allow(dead_code)]` in `audit.rs`.
#[allow(unused_imports)]
pub(crate) use plur1bus_audit::chain::{
    hash_line, refusal_reason, Disagreement, ReanchorError, Reanchored,
};
use serde_json::Value;
use std::io;
use std::path::Path;

/// Runs `f` with the actor of this CLI process.
fn as_cli<T>(f: impl FnOnce(&Actor<'_>) -> T) -> T {
    let caller = crate::identity::caller();
    f(&Actor {
        user: &caller.user_id,
        host: &caller.account_id,
        writer: "cli",
    })
}

/// [`plur1bus_audit::chain::append`] as this CLI process.
pub(crate) fn append(dir: &Path, rec: &Value) -> io::Result<()> {
    as_cli(|actor| plur1bus_audit::chain::append(dir, actor, rec))
}

/// [`plur1bus_audit::chain::append_batch`] as this CLI process.
pub(crate) fn append_batch(dir: &Path, recs: &[Value]) -> io::Result<()> {
    as_cli(|actor| plur1bus_audit::chain::append_batch(dir, actor, recs))
}

/// [`plur1bus_audit::chain::reanchor`] as this CLI process.
pub(crate) fn reanchor(
    dir: &Path,
    reason: &str,
    dry_run: bool,
) -> Result<Reanchored, ReanchorError> {
    as_cli(|actor| plur1bus_audit::chain::reanchor(dir, actor, reason, dry_run))
}

#[cfg(test)]
#[path = "../tests/common/prerequisites.rs"]
mod test_prerequisites;

// The chain's own tests are in `crates/plur1bus-audit/src/chain.rs`; this one drives the CLI's audit producer.
#[cfg(test)]
mod tests {
    use plur1bus_audit::chain::ACTIVE;
    use serde_json::{json, Value};
    use std::fs;
    use std::io::{Read, Write};
    use std::path::Path;
    use std::process::{Child, Command, Stdio};

    // The subprocess branch invokes the actual CLI audit producer, not a replica of
    // the chain algorithm. No production test switch or additional binary is needed.
    #[test]
    fn mixed_typescript_and_rust_processes_share_one_intact_chain() {
        if let Some(home) = std::env::var_os("PLUR1BUS_AUDIT_TEST_CHILD_HOME") {
            let layout = crate::paths::Layout::new(home.into());
            for i in 0..30 {
                let mut advance = [0];
                std::io::stdin().read_exact(&mut advance).unwrap();
                assert_eq!(advance, [1]);
                crate::audit::append(&layout, "rust.process", "fixture", json!({"i":i})).unwrap();
                std::io::stdout().write_all(&[6]).unwrap();
                std::io::stdout().flush().unwrap();
            }
            return;
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        super::test_prerequisites::require("audit", &root);
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
        // Join or reap every owned writer before the temporary chain can be removed, including on failure.
        struct Writers(Vec<Child>);
        impl Drop for Writers {
            fn drop(&mut self) {
                for child in &mut self.0 {
                    if !matches!(child.try_wait(), Ok(Some(_))) {
                        let _ = child.kill();
                    }
                    let _ = child.wait();
                }
            }
        }
        let mut children = Writers(Vec::new());
        for i in 0..3 {
            children.0.push(Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "audit::chain::tests::mixed_typescript_and_rust_processes_share_one_intact_chain", "--nocapture"])
                .env("PLUR1BUS_AUDIT_TEST_CHILD_HOME", dir.path())
                .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap());
            children.0.push(
                Command::new(&node)
                    .current_dir(&root)
                    .args([
                        "--experimental-strip-types",
                        "--conditions=source",
                        "--no-warnings=ExperimentalWarning",
                        "packages/core/test/audit/writer-child.ts",
                    ])
                    .arg(&logs)
                    .arg(format!("ts-{i}"))
                    .arg("30")
                    .arg("--stepped")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
        }
        // All six real processes contend in each round, but none can reacquire the lock 30 times ahead of a peer.
        // Preserve the production five-second lock deadline and all 180 independently appended records.
        for _ in 0..30 {
            for child in &mut children.0 {
                child.stdin.as_mut().unwrap().write_all(&[1]).unwrap();
            }
            for child in &mut children.0 {
                let mut ack = [0];
                loop {
                    child.stdout.as_mut().unwrap().read_exact(&mut ack).unwrap();
                    if ack == [6] {
                        break;
                    }
                    // The Rust libtest harness also prints its ordinary ASCII header on this pipe.
                }
            }
        }
        for child in &mut children.0 {
            assert!(child.wait().unwrap().success());
        }
        let verify = |dir: &Path| {
            let output = Command::new(&node).current_dir(&root)
                .args(["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", "--input-type=module", "-e", "import {createAuditChain} from './packages/core/src/audit/chain.ts'; console.log(JSON.stringify(createAuditChain({dir:process.argv[1]}).verify()))"])
                .arg(dir).output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            serde_json::from_slice::<Value>(&output.stdout).unwrap()
        };
        let ok = verify(&logs);
        assert_eq!(ok["ok"], true, "{ok}");
        assert_eq!(ok["records"], 180);
        assert_eq!(ok["lastSeq"], 180);
        let active = logs.join(ACTIVE);
        let bytes = fs::read_to_string(&active).unwrap();
        let tampered = bytes.replacen("\"at\":", "\"tampered\":", 1);
        fs::write(&active, tampered).unwrap();
        let bad = verify(&logs);
        assert_eq!(bad["ok"], false);
        assert!(bad["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["code"] == "hash-mismatch"));
    }
}
