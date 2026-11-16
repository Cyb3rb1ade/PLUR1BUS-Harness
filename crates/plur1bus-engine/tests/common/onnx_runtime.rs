// Test-only CPU ONNX Runtime matching onnxruntime-node 1.30.0 in the pinned Node lockfile.
// This helper returns a verified path and never mutates process environment variables.

use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

static PREPARATION: Mutex<()> = Mutex::new(());

#[derive(serde::Deserialize)]
struct Pins {
    version: String,
    targets: std::collections::HashMap<String, Pin>,
}

#[derive(serde::Deserialize)]
struct Pin {
    path: String,
    bytes: u64,
    sha256: String,
}

#[allow(clippy::expect_used, clippy::panic)]
fn pin() -> (String, &'static str, Pin) {
    let target = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("macos", "aarch64") => "darwin-arm64",
        ("windows", "x86_64") => "win32-x64",
        ("windows", "aarch64") => "win32-arm64",
        (os, arch) => panic!("unsupported ONNX Runtime test target: {os}-{arch}"),
    };
    let mut pins: Pins = serde_json::from_str(include_str!(
        "../../../../scripts/release/onnx-runtime-pins.json"
    ))
    .expect("valid repository ONNX Runtime pins");
    let pin = pins
        .targets
        .remove(target)
        .expect("ONNX Runtime target pin");
    (pins.version, target, pin)
}

fn verified(path: &Path, bytes: u64, expected: &str) -> io::Result<bool> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() != bytes {
        return Ok(false);
    }
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let length = file.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        hash.update(&buffer[..length]);
    }
    Ok(format!("{:x}", hash.finalize()) == expected)
}

#[allow(clippy::expect_used, clippy::panic)]
fn target_directory() -> PathBuf {
    if let Some(path) = std::env::var_os("CARGO_TARGET_DIR").map(PathBuf::from) {
        if path.is_absolute() {
            return path;
        }
    }
    let executable =
        std::env::current_exe().expect("locate the test executable's target directory");
    let deps = executable.parent().expect("test executable has a parent");
    if deps.file_name() == Some(std::ffi::OsStr::new("deps")) {
        return deps
            .parent()
            .and_then(Path::parent)
            .expect("test executable is below target/profile/deps")
            .to_owned();
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target")
}

/// Download missing or invalid test runtime bytes to target/ort/1.30.0 and verify SHA-256.
/// Callers pass the returned path directly to the runtime loader; no set_var race is introduced.
#[allow(clippy::expect_used, clippy::panic)]
pub fn ensure_runtime() -> PathBuf {
    let _preparation = PREPARATION
        .lock()
        .expect("ONNX Runtime test preparation lock");
    let (version, target, pin) = pin();
    let filename = pin
        .path
        .rsplit('/')
        .next()
        .expect("ONNX Runtime archive member name");
    let directory = target_directory();
    let path = directory
        .join("ort")
        .join(&version)
        .join(target)
        .join(filename);
    let valid = verified(&path, pin.bytes, &pin.sha256).unwrap_or_else(|error| {
        panic!(
            "cannot inspect ONNX Runtime test cache {}: {error}",
            path.display()
        )
    });
    if !valid {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../scripts/release/onnx-runtime.mjs");
        let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
        let output = Command::new(node).arg("--use-env-proxy").arg(&script)
            .arg("--target-directory").arg(&directory).arg("--target").arg(target)
            .output().unwrap_or_else(|error| panic!("cannot run ONNX Runtime test preparation {}: {error}; use the repository's Node 24 toolchain", script.display()));
        assert!(
            output.status.success(),
            "ONNX Runtime {version} test preparation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert!(
        verified(&path, pin.bytes, &pin.sha256).unwrap_or(false),
        "ONNX Runtime {version} CPU library failed SHA-256 verification: {}",
        path.display()
    );
    path
}
