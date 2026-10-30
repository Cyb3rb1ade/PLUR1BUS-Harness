//! Actual CLI → Core RPC → SSH key service with memory-only secret storage; no OS keychain or source writes.
mod common;
use assert_cmd::Command;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Stdio},
    time::Duration,
};

struct CoreFixture {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    _runtime: tempfile::TempDir,
}
impl CoreFixture {
    fn start(home: &Path) -> Self {
        Self::start_with_source(home, None)
    }
    fn start_with_source(home: &Path, source: Option<&Path>) -> Self {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/core/test/import/cli-ssh-rpc.mjs");
        let runtime = tempfile::tempdir().unwrap();
        let mut command = std::process::Command::new("node");
        command
            .args([
                "--experimental-strip-types",
                "--conditions=source",
                "--no-warnings=ExperimentalWarning",
            ])
            .arg(fixture)
            .arg(home);
        if let Some(source) = source {
            let binary = assert_cmd::cargo::cargo_bin("plur1bus");
            let example = binary
                .parent()
                .unwrap()
                .join("examples")
                .join(if cfg!(windows) {
                    "sftp_test_server.exe"
                } else {
                    "sftp_test_server"
                });
            assert!(
                example.is_file(),
                "explicit prerequisite: build the existing remote-fs sftp_test_server example"
            );
            let worker = runtime.path().join(if cfg!(windows) {
                "plur1bus.exe"
            } else {
                "plur1bus"
            });
            let server = runtime.path().join(if cfg!(windows) {
                "server.exe"
            } else {
                "server"
            });
            std::fs::copy(binary, &worker).unwrap();
            std::fs::copy(example, &server).unwrap();
            command.arg(worker).arg(server).arg(source);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        assert!(
            output.read_line(&mut line).unwrap() > 0,
            "actual Core fixture must become ready"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap(),
            json!({"ready":true})
        );
        Self {
            child,
            input,
            output,
            _runtime: runtime,
        }
    }
    fn role(&mut self, role: &str) {
        writeln!(self.input.as_mut().unwrap(), "{role}").unwrap();
        self.input.as_mut().unwrap().flush().unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        assert_eq!(line, "ok\n");
    }
    fn control(&mut self, value: &str) -> Value {
        writeln!(self.input.as_mut().unwrap(), "{value}").unwrap();
        self.input.as_mut().unwrap().flush().unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
}
impl Drop for CoreFixture {
    fn drop(&mut self) {
        self.input.take();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if self.child.try_wait().unwrap().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn explicit_cli_probe_and_trust_enable_only_the_verified_native_source_connection() {
    let home = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    std::fs::write(source.path().join("config.json"), b"{\"fixture\":true}\n").unwrap();
    let mut core = CoreFixture::start_with_source(home.path(), Some(source.path()));
    call(home.path(), &["--key", "generate"], true);
    let server = core.control("start-server");
    let endpoint = format!(
        "fixture@{}:{}",
        server["ip"].as_str().unwrap(),
        server["port"].as_u64().unwrap()
    );
    let setup = call(
        home.path(),
        &[
            "--ssh",
            &endpoint,
            "--connection",
            "source",
            "--source",
            "/",
            "--allow-private",
        ],
        true,
    );
    assert_eq!(setup["schema"], "import.ssh.connection/1");
    assert!(setup["connection"].get("hostKey").is_none());
    let refused = call(
        home.path(),
        &["--connection", "source", "--probe-host-key"],
        false,
    );
    assert_eq!(refused["error"], "E_DENIED");
    assert_eq!(
        refused["reason"], "ssh-egress-denied",
        "allow-private alone cannot widen central egress policy"
    );
    call(
        home.path(),
        &[
            "--ssh",
            &endpoint,
            "--connection",
            "source",
            "--source",
            "/",
            "--allow-private",
            "--allow-egress",
        ],
        true,
    );
    let probe = call(
        home.path(),
        &["--connection", "source", "--probe-host-key"],
        true,
    );
    assert_eq!(probe["hostKeySha256"], server["hostKeySha256"]);
    let fingerprint = probe["hostKeySha256"].as_str().unwrap();
    let probe_id = probe["probeId"].as_str().unwrap();
    assert_eq!(
        call(
            home.path(),
            &[
                "--connection",
                "source",
                "--trust-host-key",
                &format!("SHA256:{}", "A".repeat(43)),
                "--probe-id",
                probe_id
            ],
            false
        )["error"],
        "E_NOT_FOUND"
    );
    let trusted = call(
        home.path(),
        &[
            "--connection",
            "source",
            "--trust-host-key",
            fingerprint,
            "--probe-id",
            probe_id,
        ],
        true,
    );
    assert_eq!(trusted["connection"]["hostKey"]["sha256"], fingerprint);
    assert_eq!(core.control("read"), json!({"read":true}));
    assert_eq!(
        std::fs::read(source.path().join("config.json")).unwrap(),
        b"{\"fixture\":true}\n"
    );
    core.role("admin");
    assert_eq!(
        call(
            home.path(),
            &[
                "--ssh",
                &endpoint,
                "--connection",
                "source",
                "--source",
                "/",
                "--allow-egress"
            ],
            false
        )["error"],
        "E_DENIED"
    );
    assert_eq!(
        call(
            home.path(),
            &["--connection", "source", "--probe-host-key"],
            false
        )["error"],
        "E_DENIED"
    );
    assert_eq!(
        call(
            home.path(),
            &[
                "--connection",
                "source",
                "--trust-host-key",
                fingerprint,
                "--probe-id",
                probe_id
            ],
            false
        )["error"],
        "E_DENIED"
    );
}
fn import_tree(root: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    fn visit(base: &Path, path: &Path, out: &mut std::collections::BTreeMap<String, Vec<u8>>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let key = path
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            if entry.file_type().unwrap().is_dir() {
                out.insert(format!("{key}/"), vec![]);
                visit(base, &path, out);
            } else {
                out.insert(key, std::fs::read(path).unwrap());
            }
        }
    }
    let mut entries = std::collections::BTreeMap::new();
    if root.exists() {
        entries.insert("./".into(), vec![]);
        visit(root, root, &mut entries);
    }
    entries
}
fn call(home: &Path, args: &[&str], success: bool) -> Value {
    let output = Command::cargo_bin("plur1bus")
        .unwrap()
        .arg("--home")
        .arg(home)
        .args(["--json", "import", "ssh"])
        .args(args)
        .timeout(Duration::from_secs(30))
        .output()
        .unwrap();
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        output.status.success(),
        success,
        "unexpected CLI status for {:?}: error={}, reason={} ({})",
        args.first(),
        result["error"],
        result["reason"],
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("BEGIN PRIVATE KEY"));
    result
}
#[test]
fn ssh_help_is_additive_and_offline_ssh_never_falls_back_to_the_legacy_importer() {
    let output = Command::cargo_bin("plur1bus")
        .unwrap()
        .args(["import", "--help"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).unwrap();
    for flag in [
        "--detect",
        "--skills",
        "--rollback",
        "--source",
        "--map",
        "--profile",
        "--apply",
        "--enable",
        "--on-conflict",
        "--migrate-secrets",
        "--max-skill-bytes",
        "--resume",
        "--force",
        "--adopt-store",
        "--agent",
        "--adopt-strategy",
        "--merge-profiles",
        "--ssh",
        "--key",
        "--probe-host-key",
        "--allow-egress",
        "--trust-host-key",
        "--run-status",
    ] {
        assert!(help.contains(flag), "required import option disappeared");
    }
    assert!(help.contains("plur1bus import ssh --key generate"));
    let home = tempfile::tempdir().unwrap();
    assert_eq!(
        call(home.path(), &["--key", "status"], false)["error"],
        "E_CORE_UNAVAILABLE"
    );
    assert_eq!(
        std::fs::read_dir(home.path()).unwrap().count(),
        0,
        "offline read must create neither credentials nor import state"
    );
}
#[test]
fn run_history_uses_the_actual_supervisor_with_core_offline() {
    let home = tempfile::tempdir().unwrap();
    let _supervisor = common::start(home.path());
    let before = import_tree(&home.path().join("imports"));
    assert_eq!(
        call(home.path(), &["--runs"], true),
        json!({"schema":"import.ssh.runs/1","runs":[]})
    );
    assert_eq!(
        import_tree(&home.path().join("imports")),
        before,
        "CLI history must create or mutate no import entries"
    );
}

#[test]
fn key_lifecycle_uses_actual_core_owner_gates_and_never_creates_private_key_files() {
    let home = tempfile::tempdir().unwrap();
    let mut core = CoreFixture::start(home.path());
    assert_eq!(
        call(home.path(), &["--key", "status"], true),
        json!({"schema":"import.ssh.key.status/1","configured":false})
    );
    let generated = call(home.path(), &["--key", "generate"], true);
    assert_eq!(generated["schema"], "import.ssh.key.generate/1");
    assert_eq!(generated["configured"], true);
    assert!(generated["publicKey"]
        .as_str()
        .unwrap()
        .starts_with("ssh-ed25519 "));
    let instructions = generated["instructions"].as_str().unwrap();
    assert!(instructions.contains("restrict,command=\""));
    assert!(instructions.contains("sftp-server -R\""));
    let human = Command::cargo_bin("plur1bus")
        .unwrap()
        .arg("--home")
        .arg(home.path())
        .args(["import", "ssh", "--key", "status"])
        .timeout(Duration::from_secs(30))
        .output()
        .unwrap();
    assert!(human.status.success());
    assert_eq!(
        String::from_utf8(human.stdout).unwrap().trim_end(),
        instructions,
        "human setup guidance must keep the returned forced read-only lines directly copyable"
    );
    for role in ["admin", "viewer", "agent"] {
        core.role(role);
        for operation in ["status", "generate", "rotate", "delete"] {
            let denied = call(home.path(), &["--key", operation], false);
            assert_eq!(denied["error"], "E_DENIED");
        }
        if role == "admin" {
            assert_eq!(call(home.path(), &[], true)["connections"], json!([]));
        } else {
            assert_eq!(call(home.path(), &[], false)["error"], "E_DENIED");
        }
    }
    core.role("owner");
    let rotated = call(home.path(), &["--key", "rotate"], true);
    assert_ne!(rotated["publicKey"], generated["publicKey"]);
    assert_eq!(
        call(home.path(), &["--key", "delete"], true),
        json!({"schema":"import.ssh.key.delete/1","deleted":true})
    );
    assert_eq!(
        call(home.path(), &["--key", "status"], true)["configured"],
        false
    );
    assert_eq!(
        call(home.path(), &["--key", "delete"], true)["deleted"],
        false
    );
    let names = std::fs::read_dir(home.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        [std::ffi::OsString::from("run")],
        "SSH private identity must stay in the real memory Secret Store"
    );
    for name in ["core.token", "core.pid"] {
        assert!(!std::fs::read(home.path().join("run").join(name))
            .unwrap()
            .windows(17)
            .any(|bytes| bytes == b"BEGIN PRIVATE KEY"));
    }
}
