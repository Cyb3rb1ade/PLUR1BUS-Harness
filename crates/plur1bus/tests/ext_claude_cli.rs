//! Real CLI plugin normalization and credential-free egress bridge behavior (M-A11).
use serde_json::{json, Value};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

fn put(root: &Path, path: &str, body: impl AsRef<[u8]>) {
    let path = root.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

fn binary() -> PathBuf {
    assert_cmd::cargo::cargo_bin("plur1bus")
}

fn document(output: Output, schema: &str) -> Value {
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schema"], schema);
    value
}

fn inspect(home: &Path, source: &Path) -> Output {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let node = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .unwrap();
    assert!(node.status.success());
    Command::new(binary())
        .arg("--home")
        .arg(home)
        .args(["--json", "ext", "inspect"])
        .arg(source)
        .env(
            "PLUR1BUS_NODE",
            String::from_utf8(node.stdout).unwrap().trim(),
        )
        .env(
            "PLUR1BUS_CORE_JS",
            workspace.join("packages/core/dist/core.js"),
        )
        .env("DO_NOT_LEAK_TO_FETCH", "PRIVATE-CREDENTIAL")
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

#[test]
fn cli_normalizes_optional_metadata_and_reports_all_unsupported_components_and_member_rights() {
    for metadata in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("plugin");
        let home = dir.path().join("home");
        put(
            &source,
            "skills/demo-skill/SKILL.md",
            b"---\nname: demo-skill\ndescription: Demo\n---\n# Body",
        );
        put(
            &source,
            "skills/demo-skill/scripts/run.sh",
            b"#!/bin/sh\necho demo\n",
        );
        put(
            &source,
            "hooks/hooks.json",
            br#"{"command":"PRIVATE-COMMAND"}"#,
        );
        if metadata {
            put(
                &source,
                ".claude-plugin/plugin.json",
                br#"{"name":"demo-plugin","commands":{"danger":{"command":"PRIVATE-COMMAND"}}}"#,
            );
        }
        let value = document(inspect(&home, &source), "ext.inspect/1");
        assert_eq!(value["manifest"]["kind"], "bundle");
        assert_eq!(value["trust"]["tier"], "unsigned");
        let checks = value["checks"].to_string();
        assert!(checks.contains("hooks"));
        assert!(checks.contains("demo-skill"));
        assert!(checks.contains("spawn"));
        assert!(checks.contains("true"));
        assert!(!checks.contains("PRIVATE-COMMAND"));
        assert!(!home.join("extensions").exists());
        assert!(!home.join("mcp").exists());
    }
}

#[test]
fn production_plugin_fetch_refuses_a_host_outside_the_actual_target_egress_policy() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let source = dir.path().join("plugin");
    put(
        &source,
        ".claude-plugin/plugin.json",
        br#"{"name":"demo-plugin","mcpServers":"https://not-allowed.example.invalid/bundle.mcpb"}"#,
    );
    put(&home,"config.json",serde_json::to_vec(&json!({"schemaVersion":1,"egress":{"allowHosts":[],"allowPorts":[443],"allowLoopback":false}})).unwrap());
    let output = inspect(&home, &source);
    assert!(!output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["error"], "E_DENIED");
    assert_eq!(value["reason"], "egress-denied");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("PRIVATE-CREDENTIAL"));
    assert!(!home.join("extensions").exists());
    assert!(!home.join("mcp").exists());
}

#[test]
fn worker_detects_plugin_zips_and_preserves_a_skill_zip_with_a_skills_asset_directory() {
    for plugin in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.zip");
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let path = if plugin {
            "wrapper/skills/demo-skill/SKILL.md"
        } else {
            "SKILL.md"
        };
        zip.start_file(path, options).unwrap();
        zip.write_all(b"---\nname: demo-skill\ndescription: Demo\n---\n# Body")
            .unwrap();
        let path = if plugin {
            "wrapper/.claude-plugin/plugin.json"
        } else {
            "skills/reference.md"
        };
        zip.start_file(path, options).unwrap();
        zip.write_all(if plugin {
            br#"{"name":"demo-plugin"}"#
        } else {
            b"reference"
        })
        .unwrap();
        std::fs::write(&source, zip.finish().unwrap().into_inner()).unwrap();
        let value = document(inspect(&dir.path().join("home"), &source), "ext.inspect/1");
        assert_eq!(
            value["manifest"]["kind"],
            if plugin { "bundle" } else { "skill" }
        );
    }
}

#[test]
fn parser_deadline_stops_the_fetch_child_and_its_descendant_without_ambient_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let source = dir.path().join("plugin");
    put(
        &source,
        ".claude-plugin/plugin.json",
        br#"{"name":"demo-plugin","mcpServers":"https://allowed.example/bundle.mcpb"}"#,
    );
    std::fs::create_dir_all(&home).unwrap();
    put(dir.path(),"extension-source.js",br#"
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 const request=JSON.parse(input), marker=path.join(request.home,'escaped');
 cp.spawn(process.execPath,['-e',`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),2500)`],{stdio:'ignore'});
 fs.writeFileSync(path.join(request.home,'ready'),JSON.stringify({ambient:process.env.DO_NOT_LEAK_TO_FETCH!==undefined,argv:process.argv.length}));
 process.stderr.write('{"ok":true}\n');setInterval(()=>{},1000);
});
"#);
    let node = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .unwrap();
    assert!(node.status.success());
    let started = std::time::Instant::now();
    let output = Command::new(binary())
        .arg("--home")
        .arg(&home)
        .args(["--json", "ext", "inspect"])
        .arg(&source)
        .env(
            "PLUR1BUS_NODE",
            String::from_utf8(node.stdout).unwrap().trim(),
        )
        .env("PLUR1BUS_CORE_JS", dir.path().join("core.js"))
        .env("DO_NOT_LEAK_TO_FETCH", "PRIVATE-CREDENTIAL")
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_TEST_EXT_WORKER_DEADLINE_MS", "inspect:1500")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(started.elapsed() < std::time::Duration::from_secs(4));
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["reason"], "worker-failed");
    let ready: Value = serde_json::from_slice(
        &std::fs::read(home.join("ready")).expect("fetch child actually started"),
    )
    .unwrap();
    assert_eq!(ready, json!({"ambient":false,"argv":2}));
    std::thread::sleep(std::time::Duration::from_millis(2600));
    assert!(
        !home.join("escaped").exists(),
        "fetch descendant escaped the worker process tree"
    );
}
