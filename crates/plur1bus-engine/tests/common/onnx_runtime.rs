// Test-only CPU ONNX Runtime matching onnxruntime-node 1.30.0 in the pinned Node lockfile.
// This helper returns a verified path and never mutates process environment variables.

use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

const VERSION: &str = "1.30.0";
static PREPARATION: Mutex<()> = Mutex::new(());

#[allow(clippy::expect_used, clippy::panic)]
fn pin() -> (&'static str, &'static str, u64, &'static str) {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => (
            "linux-x64",
            "libonnxruntime.so.1",
            45_828_512,
            "ffb75a925ba05e47b235bb66e3e3911714a80b328a9c9425539feb204aa32a23",
        ),
        ("linux", "aarch64") => (
            "linux-arm64",
            "libonnxruntime.so.1",
            25_135_496,
            "1f549d46250b005580b597f4164984aaf75b3bcb9f3aeb07c7f8a8fe60b23c76",
        ),
        ("macos", "aarch64") => (
            "darwin-arm64",
            "libonnxruntime.1.30.0.dylib",
            44_589_928,
            "685d2be5dba1309c89d3a5324b7fd06a5c42f1a61bfea32d14c4cc28d072121d",
        ),
        ("windows", "x86_64") => (
            "win32-x64",
            "onnxruntime.dll",
            28_754_232,
            "508c362f5673483dd3a086379c392795b2e42d10d5e6f3f90ebd7ac21c97af67",
        ),
        ("windows", "aarch64") => (
            "win32-arm64",
            "onnxruntime.dll",
            29_815_136,
            "6c3a2abf5c6aca11c48a0d338a91af309f2266f25ce2e4084e6a87bbcb0fbfd0",
        ),
        (os, arch) => panic!("unsupported ONNX Runtime test target: {os}-{arch}"),
    }
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
    let (target, filename, bytes, expected) = pin();
    let directory = target_directory();
    let path = directory
        .join("ort")
        .join(VERSION)
        .join(target)
        .join(filename);
    let valid = verified(&path, bytes, expected).unwrap_or_else(|error| {
        panic!(
            "cannot inspect ONNX Runtime test cache {}: {error}",
            path.display()
        )
    });
    if !valid {
        let script =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/common/setup-onnx-runtime.mjs");
        let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
        let output = Command::new(node).arg("--use-env-proxy").arg(&script)
            .arg("--target-directory").arg(&directory).arg("--target").arg(target)
            .output().unwrap_or_else(|error| panic!("cannot run ONNX Runtime test preparation {}: {error}; use the repository's Node 24 toolchain", script.display()));
        assert!(
            output.status.success(),
            "ONNX Runtime {VERSION} test preparation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert!(
        verified(&path, bytes, expected).unwrap_or(false),
        "ONNX Runtime {VERSION} CPU library failed SHA-256 verification: {}",
        path.display()
    );
    path
}
