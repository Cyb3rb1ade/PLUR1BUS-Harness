//! The setup test environment shared by `setup.rs` and `setup_profile.rs`: a temp PLUR1BUS home, a stand-in OS user
//! home, the recording fake service manager (`PLUR1BUS_SERVICE_FAKE`) and a `file://` Node mirror holding a fake
//! archive whose hash replaces the pin (`PLUR1BUS_TEST_NODE_SHA256`). See `setup.rs` for the details.
#![allow(dead_code)]
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::OnceLock;

pub const NODE_VERSION: &str = "24.21.0";
pub const STEP_IDS: [&str; 9] = [
    "state-root",
    "runtime.node",
    "runtime.core",
    "modules.bundled",
    "config",
    "skills",
    "service",
    "start",
    "check",
];

pub fn bin() -> PathBuf {
    assert_cmd::cargo::cargo_bin("plur1bus")
}

pub fn payload() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/setup")
}

/// The release target id of this host (`Target::current`).
pub fn target_id() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("macos", "aarch64") => "darwin-arm64",
        ("windows", "x86_64") => "win-x64",
        ("windows", "aarch64") => "win-arm64",
        other => panic!("no release target for {other:?}"),
    }
}

pub fn archive_name() -> String {
    let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
    format!("node-v{NODE_VERSION}-{}.{ext}", target_id())
}

/// The real Node running the fake core behind the shim.
pub fn real_node() -> PathBuf {
    static P: OnceLock<PathBuf> = OnceLock::new();
    P.get_or_init(|| {
        let out = Command::new(if cfg!(windows) { "node.exe" } else { "node" })
            .args(["-p", "process.execPath"])
            .output()
            .expect("node on PATH");
        PathBuf::from(String::from_utf8(out.stdout).unwrap().trim())
    })
    .clone()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// The fake Node archive's bytes, built once per test process.
pub fn archive_bytes() -> &'static [u8] {
    static B: OnceLock<Vec<u8>> = OnceLock::new();
    B.get_or_init(build_archive)
}

#[cfg(not(windows))]
pub fn build_archive() -> Vec<u8> {
    let root = format!("node-v{NODE_VERSION}-{}", target_id());
    let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut b = tar::Builder::new(gz);
    let mut add = |name: String, data: &[u8], mode: u32, dir: bool| {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(if dir {
            tar::EntryType::Directory
        } else {
            tar::EntryType::Regular
        });
        h.set_mode(mode);
        h.set_size(data.len() as u64);
        h.set_cksum();
        b.append_data(&mut h, name, data).unwrap();
    };
    add(format!("{root}/"), b"", 0o755, true);
    add(format!("{root}/bin/"), b"", 0o755, true);
    add(
        format!("{root}/bin/node"),
        b"#!/bin/sh\nexec \"$REAL_NODE\" \"$@\"\n",
        0o755,
        false,
    );
    add(
        format!("{root}/README.md"),
        b"TEST ONLY fake Node\n",
        0o644,
        false,
    );
    b.into_inner().unwrap().finish().unwrap()
}

#[cfg(windows)]
pub fn build_archive() -> Vec<u8> {
    use std::io::Write;
    let root = format!("node-v{NODE_VERSION}-{}", target_id());
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);
    w.add_directory(format!("{root}/"), opts).unwrap();
    w.start_file(format!("{root}/node.exe"), opts).unwrap();
    w.write_all(&std::fs::read(real_node()).unwrap()).unwrap();
    w.start_file(format!("{root}/README.md"), opts).unwrap();
    w.write_all(b"TEST ONLY fake Node\n").unwrap();
    w.finish().unwrap().into_inner()
}

/// A temp root with the PLUR1BUS home, the stand-in OS user home, the fake service manager's directory and a Node
/// mirror (`<mirror>/v24.21.0/<archive>`).
pub struct Env {
    pub _tmp: tempfile::TempDir,
    pub root: PathBuf,
    pub home: PathBuf,
    pub user: PathBuf,
    pub fake: PathBuf,
    pub mirror: PathBuf,
    pub node_sha: String,
}

impl Env {
    pub fn new() -> Env {
        Env::with_home("h")
    }

    pub fn with_home(rel: &str) -> Env {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let home = rel.split('/').fold(root.clone(), |p, c| p.join(c));
        let user = root.join("user");
        let fake = root.join("fake");
        let mirror = root.join("mirror");
        for d in [&user, &fake, &mirror.join(format!("v{NODE_VERSION}"))] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(
            mirror.join(format!("v{NODE_VERSION}")).join(archive_name()),
            archive_bytes(),
        )
        .unwrap();
        Env {
            _tmp: tmp,
            root,
            home,
            user,
            fake,
            mirror,
            node_sha: sha256_hex(archive_bytes()),
        }
    }

    pub fn mirror_url(&self) -> String {
        let p = self.mirror.to_string_lossy().replace('\\', "/");
        if p.starts_with('/') {
            format!("file://{p}")
        } else {
            format!("file:///{p}")
        }
    }

    /// `plur1bus --home <home> <args>` with every test seam of this file.
    pub fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(bin());
        c.arg("--home")
            .arg(&self.home)
            .args(args)
            .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
            .env("PLUR1BUS_SERVICE_FAKE", &self.fake)
            .env("PLUR1BUS_NODE_MIRROR", self.mirror_url())
            .env("PLUR1BUS_TEST_NODE_SHA256", &self.node_sha)
            .env("REAL_NODE", real_node())
            .env("HOME", &self.user)
            .env("USERPROFILE", &self.user)
            .env("LOCALAPPDATA", self.user.join("AppData").join("Local"))
            .env("FAKE_CORE_GRACE_MS", "300")
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("PLUR1BUS_HOME")
            .env_remove("PLUR1BUS_NODE")
            .env_remove("PLUR1BUS_CORE_JS")
            .env_remove("PLUR1BUS_CONTAINER")
            .env_remove("PLUR1BUS_TEST_INTERNALS")
            .env_remove("PLUR1BUS_TEST_SETUP_PAUSE_AT")
            .env_remove("PLUR1BUS_SUPERVISOR_TIME_SCALE")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c
    }

    /// `setup --json --core-from <fixture> <extra>` → (exit code, setup/1 document).
    pub fn setup(&self, extra: &[&str]) -> (i32, Value) {
        let core = payload();
        let mut args = vec!["--json", "setup", "--core-from", core.to_str().unwrap()];
        args.extend_from_slice(extra);
        let out = self.cmd(&args).output().unwrap();
        (out.status.code().unwrap_or(-1), doc(&out))
    }

    pub fn json(&self, args: &[&str]) -> Value {
        let mut a = vec!["--json"];
        a.extend_from_slice(args);
        doc(&self.cmd(&a).output().unwrap())
    }

    pub fn audit_actions(&self) -> Vec<String> {
        std::fs::read_to_string(self.home.join("logs/audit.log"))
            .unwrap_or_default()
            .lines()
            .map(|l| {
                let v: Value = serde_json::from_str(l).expect("audit lines are JSON");
                v["action"].as_str().unwrap().to_string()
            })
            .collect()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        teardown(self);
    }
}

/// Stops the supervisor setup started (and, on unix, kills anything left whose command line names the home).
pub fn teardown(e: &Env) {
    if !e.home.join("run").exists() {
        return;
    }
    let _ = e.cmd(&["daemon", "stop"]).output();
    #[cfg(unix)]
    for name in ["supervisor.pid", "core.pid"] {
        let pid = std::fs::read_to_string(e.home.join("run").join(name))
            .ok()
            .and_then(|t| t.split_whitespace().next()?.parse::<i32>().ok());
        if let Some(pid) = pid {
            let out = Command::new("ps")
                .args(["-ww", "-o", "command=", "-p", &pid.to_string()])
                .output();
            if out.is_ok_and(|o| {
                String::from_utf8_lossy(&o.stdout).contains(&*e.home.to_string_lossy())
            }) {
                // SAFETY: plain kill(2) on a pid whose command line names this test's own temp home.
                unsafe { libc::kill(pid, libc::SIGKILL) };
            }
        }
    }
}

pub fn doc(out: &Output) -> Value {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|l| l.starts_with('{'))
        .unwrap_or("");
    serde_json::from_str(line).unwrap_or_else(|err| {
        panic!(
            "{err}: stdout={stdout:?} stderr={:?}",
            String::from_utf8_lossy(&out.stderr)
        )
    })
}

pub fn ids(v: &Value) -> Vec<String> {
    v["steps"]
        .as_array()
        .unwrap_or_else(|| panic!("no steps: {v}"))
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_string())
        .collect()
}

pub fn step<'a>(v: &'a Value, id: &str) -> &'a Value {
    v["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .unwrap_or_else(|| panic!("no step {id}: {v}"))
}

pub fn status_of(v: &Value, id: &str) -> String {
    step(v, id)["status"].as_str().unwrap().to_string()
}

/// Every entry under `dir` (recursively) whose name contains `.tmp-`.
pub fn stray_temps(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return found;
    };
    for e in rd.flatten() {
        let p = e.path();
        if e.file_name().to_string_lossy().contains(".tmp-") {
            found.push(p.clone());
        }
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            found.extend(stray_temps(&p));
        }
    }
    found
}

pub fn runtime_node_dirs(home: &Path) -> Vec<String> {
    std::fs::read_dir(home.join("runtime"))
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("node-"))
                .collect()
        })
        .unwrap_or_default()
}

pub fn node_binary(home: &Path) -> PathBuf {
    home.join(format!("runtime/node-{NODE_VERSION}/bin"))
        .join(if cfg!(windows) { "node.exe" } else { "node" })
}

/// `daemon status` reports the core child `ready`.
pub fn assert_core_ready(e: &Env) {
    let status = e.json(&["daemon", "status"]);
    let core = status["children"]
        .as_array()
        .and_then(|c| c.iter().find(|c| c["kind"] != "module"))
        .unwrap_or_else(|| panic!("no core child: {status}"));
    assert_eq!(core["process"]["state"], "ready", "{status}");
}

pub fn assert_success(code: i32, v: &Value) {
    assert_eq!(code, 0, "setup failed: {v:#}");
    assert_eq!(v["schema"], "setup/1", "{v}");
    assert_eq!(ids(v), STEP_IDS, "{v}");
    assert_eq!(v["check"]["fail"], 0, "{v:#}");
}
