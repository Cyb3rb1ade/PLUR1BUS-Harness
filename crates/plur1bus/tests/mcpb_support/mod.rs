//! Shared source fixtures and process assertions for MCPB CLI compatibility and lifecycle tests (M-A9/A2).
use serde_json::{json, Value};
use std::io::{Cursor, Write};
use std::path::Path;
use std::process::{Command, Output, Stdio};

pub fn fixture(path: &Path) {
    let manifest = json!({"manifest_version":"0.3","name":"demo-server","version":"1.0.0",
        "description":"Demo","author":{"name":"Example"},"server":{"type":"node",
        "entry_point":"server/main.js","mcp_config":{"command":"node","args":["${__dirname}/server/main.js"]}}});
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("manifest.json", options).unwrap();
    zip.write_all(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    zip.start_file("server/main.js", options).unwrap();
    zip.write_all(b"console.log('demo');").unwrap();
    std::fs::write(path, zip.finish().unwrap().into_inner()).unwrap();
}

pub fn run(home: &Path, args: &[&str]) -> Output {
    Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .arg("--home")
        .arg(home)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

pub fn document(output: Output, schema: &str) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schema"], schema);
    value
}
