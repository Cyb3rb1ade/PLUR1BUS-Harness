//! The protoc build on Windows MSVC (README, "protoc"): `.cargo/config.toml` hands the `cmake` crate a CMake
//! toolchain file for both Windows targets, and that file puts protobuf on the DLL runtime its vendored abseil uses.
//! No other target reads the two entries, so these tests keep them intact on runners that never build for Windows.
#![cfg_attr(test, allow(clippy::unwrap_used))]

use std::fs;
use std::path::{Path, PathBuf};

/// The Windows release targets (`crates/plur1bus/src/install/targets.rs`), spelled the way the `cmake` crate looks
/// them up (`CMAKE_TOOLCHAIN_FILE_<target with underscores>`).
const WINDOWS_TARGETS: [&str; 2] = ["x86_64_pc_windows_msvc", "aarch64_pc_windows_msvc"];

const TOOLCHAIN_FILE: &str = "crates/plur1bus-engine/cmake/protobuf-msvc-crt.cmake";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

/// The `value` of the `[env.<name>]` table in a cargo config and whether the table says `relative = true`.
fn env_table(config: &str, name: &str) -> Option<(String, bool)> {
    let header = format!("[env.{name}]");
    let body: Vec<&str> = config
        .lines()
        .map(str::trim)
        .skip_while(|line| *line != header)
        .skip(1)
        .take_while(|line| !line.starts_with('['))
        .collect();
    let value = body.iter().find_map(|line| line.strip_prefix("value = "))?;
    Some((
        value.trim_matches('"').to_owned(),
        body.contains(&"relative = true"),
    ))
}

#[test]
fn both_windows_targets_name_the_protobuf_toolchain_file() {
    let config = fs::read_to_string(repo_root().join(".cargo").join("config.toml")).unwrap();
    for target in WINDOWS_TARGETS {
        let name = format!("CMAKE_TOOLCHAIN_FILE_{target}");
        let entry = env_table(&config, &name);
        assert!(
            entry.is_some(),
            "no [env.{name}] table in .cargo/config.toml"
        );
        let (value, relative) = entry.unwrap();
        assert_eq!(value, TOOLCHAIN_FILE, "{name}");
        assert!(
            relative,
            "{name} must be resolved against the repository root (relative = true)"
        );
    }
    assert!(
        repo_root().join(TOOLCHAIN_FILE).is_file(),
        "{TOOLCHAIN_FILE} is missing"
    );
}

#[test]
fn the_toolchain_file_only_puts_protobuf_on_the_dll_runtime() {
    // One cache entry and nothing else: a compiler or a CMAKE_SYSTEM_NAME here would turn the build into a cross build.
    let text = fs::read_to_string(repo_root().join(TOOLCHAIN_FILE)).unwrap();
    let commands: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect();
    assert_eq!(
        commands,
        [r#"set(protobuf_MSVC_STATIC_RUNTIME OFF CACHE BOOL "Link static runtime libraries")"#]
    );
}
