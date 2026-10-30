//! MCPB/DXT worker normalization and disclosure; refusals leave live stores untouched (M-A9).
#![allow(dead_code)]
#[path = "../src/supervisor/state.rs"]
pub(crate) mod supervisor_state;
mod supervisor {
    pub(crate) use super::supervisor_state as state;
}
#[path = "../src/audit.rs"]
mod audit;
#[path = "../src/container.rs"]
mod container;
#[path = "../src/identity.rs"]
mod identity;
#[path = "../src/modules/graph.rs"]
pub(crate) mod modules_graph;
#[path = "../src/modules/install.rs"]
pub(crate) mod modules_install;
#[path = "../src/modules/manifest.rs"]
pub(crate) mod modules_manifest;
// `graph.rs` names its sibling as `super::manifest`.
pub(crate) use modules_manifest as manifest;
#[path = "../src/paths.rs"]
mod paths;
#[path = "../src/proc.rs"]
mod proc;
mod modules {
    pub(crate) use super::modules_graph as graph;
    pub(crate) use super::modules_install as install;
    pub(crate) use super::modules_manifest as manifest;
}
#[path = "../src/install/archive.rs"]
pub(crate) mod install_archive;
#[path = "../src/install/targets.rs"]
pub(crate) mod install_targets;
mod install {
    pub(crate) use super::install_archive as archive;
    pub(crate) use super::install_targets as targets;
}
#[path = "../src/ext/mod.rs"]
mod ext;

use ext::inspect::{self, Source};
use paths::Layout;
use serde_json::json;
use std::io::{Cursor, Write};
use std::path::Path;

fn source(version: &str, kind: &str) -> Vec<u8> {
    let manifest = json!({"manifest_version":version,"name":"demo-server","version":"1.0.0",
        "description":"Demo server","author":{"name":"Example"},"server":{"type":kind,
        "entry_point":"server/main.js","mcp_config":{"command":if kind=="node" {"node"} else {"uv"},
        "args":["${__dirname}/server/main.js"],"env":{"ROOT":"${HOME}"}}}});
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("manifest.json", options).unwrap();
    zip.write_all(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    zip.start_file("server/main.js", options).unwrap();
    zip.write_all(b"console.log('demo');").unwrap();
    if kind == "uv" {
        zip.start_file("pyproject.toml", options).unwrap();
        zip.write_all(b"[project]\nname='demo-server'\nversion='1.0.0'\n")
            .unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn signed(mut source: Vec<u8>) -> Vec<u8> {
    let der = b"\x30\x0f\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x07\x02\xa0\x02\x30\x00";
    source.extend_from_slice(b"MCPB_SIG_V1");
    source.extend_from_slice(&(der.len() as u32).to_le_bytes());
    source.extend_from_slice(der);
    source.extend_from_slice(b"MCPB_SIG_END");
    source
}

fn snapshot(home: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(root: &Path, base: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        if !root.exists() {
            return;
        }
        for item in std::fs::read_dir(root).unwrap() {
            let path = item.unwrap().path();
            if path.is_dir() {
                walk(&path, base, out);
            } else {
                out.push((
                    path.strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    std::fs::read(path).unwrap(),
                ));
            }
        }
    }
    let mut result = Vec::new();
    for directory in ["extensions", "skills"] {
        walk(&home.join(directory), home, &mut result);
    }
    if home.join("config.json").exists() {
        result.push((
            "config.json".into(),
            std::fs::read(home.join("config.json")).unwrap(),
        ));
    }
    result.sort();
    result
}

#[test]
fn mcpb_and_dxt_inspection_produce_unsigned_disabled_mcp_packages() {
    for (extension, version, kind) in [("dxt", "0.3", "node"), ("mcpb", "0.4", "uv")] {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().join("home"));
        let input = dir.path().join(format!("demo.{extension}"));
        std::fs::write(&input, source(version, kind)).unwrap();
        let before = snapshot(&layout.home);
        let record = inspect::inspect(
            &layout,
            Source::Path(input),
            &ext::worker::new_inspection_id(),
        )
        .unwrap();
        assert_eq!(record.manifest["kind"], "mcp-server");
        assert_eq!(record.manifest["defaultEnabled"], false);
        assert_eq!(record.trust["tier"], "unsigned");
        assert!(record.normalised);
        assert_eq!(snapshot(&layout.home), before);
    }
}

#[test]
fn framed_unverified_signatures_are_explicitly_disclosed_in_worker_checks() {
    let dir = tempfile::tempdir().unwrap();
    let layout = Layout::new(dir.path().join("home"));
    let input = dir.path().join("demo.mcpb");
    std::fs::write(&input, signed(source("0.4", "node"))).unwrap();
    let record = inspect::inspect(
        &layout,
        Source::Path(input),
        &ext::worker::new_inspection_id(),
    )
    .unwrap();
    assert_eq!(record.trust["tier"], "unsigned");
    assert!(record
        .checks
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["status"] == "warn"
            && row["detail"]
                .as_str()
                .unwrap_or("")
                .contains("signature not checked")));
}

#[test]
fn malformed_signature_refusal_leaves_config_stores_and_inspection_spool_empty() {
    let dir = tempfile::tempdir().unwrap();
    let layout = Layout::new(dir.path().join("home"));
    std::fs::create_dir_all(&layout.home).unwrap();
    std::fs::write(layout.config_path(), b"{\"mcp\":{\"servers\":{}}}").unwrap();
    let before = snapshot(&layout.home);
    for mutation in [0, 1, 2] {
        let mut bytes = signed(source("0.4", "node"));
        if mutation == 0 {
            bytes.push(0);
        } else if mutation == 1 {
            let offset = bytes.len() - 29;
            bytes[offset] ^= 1;
        } else {
            bytes[43] ^= 1;
        }
        let input = dir.path().join("demo.mcpb");
        std::fs::write(&input, bytes).unwrap();
        assert!(inspect::inspect(
            &layout,
            Source::Path(input),
            &ext::worker::new_inspection_id()
        )
        .is_err());
        assert_eq!(snapshot(&layout.home), before);
        if layout.run().join("inspect").exists() {
            assert_eq!(
                std::fs::read_dir(layout.run().join("inspect"))
                    .unwrap()
                    .count(),
                0
            );
        }
    }
}

#[test]
fn unsigned_policy_applies_to_framed_signatures_without_a_verifier() {
    let dir = tempfile::tempdir().unwrap();
    let layout = Layout::new(dir.path().join("home"));
    std::fs::create_dir_all(&layout.home).unwrap();
    std::fs::write(
        layout.config_path(),
        b"{\"extensions\":{\"allowUnsigned\":false}}",
    )
    .unwrap();
    let input = dir.path().join("demo.mcpb");
    std::fs::write(&input, signed(source("0.4", "node"))).unwrap();
    let before = snapshot(&layout.home);
    let error = inspect::inspect(
        &layout,
        Source::Path(input),
        &ext::worker::new_inspection_id(),
    )
    .unwrap_err();
    assert_eq!(error.code, "E_DENIED");
    assert_eq!(error.reason, Some("policy-unsigned-disallowed"));
    assert_eq!(snapshot(&layout.home), before);
}
