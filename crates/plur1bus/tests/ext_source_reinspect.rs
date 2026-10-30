//! Normalized source bytes are reproducible and inline MCP updates respect immutable version storage.
mod mcpb_support;
use mcpb_support::{document, fixture, run};
use serde_json::{json, Value};
use std::io::{Cursor, Read, Write};
use std::path::Path;

fn inspect(home: &Path, source: &Path) -> Value {
    document(
        run(
            home,
            &["--json", "ext", "inspect", source.to_str().unwrap()],
        ),
        "ext.inspect/1",
    )
}

fn install(home: &Path, source: &Path) -> Value {
    let output = run(
        home,
        &[
            "--json",
            "plugin",
            "install",
            source.to_str().unwrap(),
            "--allow-unsigned",
            "--yes",
        ],
    );
    if !output.status.success() {
        let error: Value = serde_json::from_slice(&output.stdout).unwrap();
        panic!(
            "source install refused: code={} reason={}",
            error["error"].as_str().unwrap_or("invalid"),
            error["reason"].as_str().unwrap_or("invalid")
        );
    }
    document(output, "plugin.install/1")
}

fn plugin(source: &Path, version: Option<&str>, body: &str) {
    std::fs::create_dir_all(source.join(".claude-plugin")).unwrap();
    let mut manifest = json!({"name":"source-demo","mcpServers":{"source-server":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/server.js"]}}});
    if let Some(version) = version {
        manifest["version"] = version.into();
    }
    std::fs::write(
        source.join(".claude-plugin/plugin.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(source.join("server.js"), body).unwrap();
}

#[test]
fn the_identical_mcpb_can_be_inspected_and_installed_again_without_changing_its_version_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let source = dir.path().join("source.mcpb");
    fixture(&source);
    let first = inspect(&home, &source);
    let second = inspect(&home, &source);
    assert_eq!(
        first["sha256"], second["sha256"],
        "the wall clock must not mutate normalized MCP version bytes"
    );
    install(&home, &source);
    install(&home, &source);
    assert!(home
        .join("mcp/demo-server/1.0.0/payload/server/main.js")
        .is_file());
    let mut original = zip::ZipArchive::new(Cursor::new(std::fs::read(&source).unwrap())).unwrap();
    let mut changed = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for index in 0..original.len() {
        let mut file = original.by_index(index).unwrap();
        let name = file.name().unwrap().into_owned();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        if name == "server/main.js" {
            bytes = b"console.log('changed');".to_vec();
        }
        changed
            .start_file(
                name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        changed.write_all(&bytes).unwrap();
    }
    std::fs::write(&source, changed.finish().unwrap().into_inner()).unwrap();
    let refused = run(
        &home,
        &[
            "--json",
            "plugin",
            "install",
            source.to_str().unwrap(),
            "--allow-unsigned",
            "--yes",
        ],
    );
    assert!(!refused.status.success());
    let error: Value = serde_json::from_slice(&refused.stdout).unwrap();
    assert_eq!(error["reason"], "version-conflict");
    assert_eq!(
        std::fs::read(home.join("mcp/demo-server/1.0.0/payload/server/main.js")).unwrap(),
        b"console.log('demo');"
    );
}

#[test]
fn an_explicit_plugin_version_is_inherited_by_its_inline_mcp_child_and_updates_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let source = dir.path().join("source");
    plugin(&source, Some("1.0.0"), "console.log('first');");
    let first = inspect(&home, &source);
    let again = inspect(&home, &source);
    assert_eq!(first["sha256"], again["sha256"]);
    assert_eq!(first["members"][0]["manifest"]["version"], "1.0.0");
    install(&home, &source);
    plugin(&source, Some("1.1.0"), "console.log('second');");
    let next = inspect(&home, &source);
    assert_eq!(next["members"][0]["manifest"]["version"], "1.1.0");
    install(&home, &source);
    assert!(home
        .join("mcp/source-server/1.0.0/payload/server.js")
        .is_file());
    assert_eq!(
        std::fs::read_to_string(home.join("mcp/source-server/1.1.0/payload/server.js")).unwrap(),
        "console.log('second');"
    );
}

#[test]
fn a_versionless_inline_mcp_uses_stable_content_identity_and_changed_source_can_update() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let source = dir.path().join("source");
    plugin(&source, None, "console.log('first');");
    let first = inspect(&home, &source);
    let again = inspect(&home, &source);
    assert_eq!(first["sha256"], again["sha256"]);
    let version = first["members"][0]["manifest"]["version"].as_str().unwrap();
    assert!(semver::Version::parse(version).is_ok());
    install(&home, &source);
    plugin(&source, None, "console.log('second');");
    let next = inspect(&home, &source);
    let new_version = next["members"][0]["manifest"]["version"].as_str().unwrap();
    assert_ne!(
        version, new_version,
        "changed versionless source needs another immutable version"
    );
    install(&home, &source);
    assert!(home.join("mcp/source-server").join(version).is_dir());
    assert_eq!(
        std::fs::read_to_string(
            home.join("mcp/source-server")
                .join(new_version)
                .join("payload/server.js")
        )
        .unwrap(),
        "console.log('second');"
    );
    // Content IDs have equal SemVer precedence; neither hash order nor returning to a retained build is a downgrade.
    plugin(&source, None, "console.log('first');");
    install(&home, &source);
}

#[test]
fn inline_endpoint_query_or_fragment_credentials_never_reach_output_payload_records_or_logs() {
    let marker = "PRIVATE_INLINE_ENDPOINT_CREDENTIAL";
    for suffix in [format!("?access_token={marker}"), format!("#{marker}")] {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let source = dir.path().join("source");
        std::fs::create_dir_all(source.join(".claude-plugin")).unwrap();
        let manifest = json!({"name":"source-demo","mcpServers":{"source-server":{"url":format!("https://mcp.example/mcp{suffix}")}}});
        std::fs::write(
            source.join(".claude-plugin/plugin.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let output = run(
            &home,
            &["--json", "ext", "inspect", source.to_str().unwrap()],
        );
        assert!(
            !output.status.success(),
            "source endpoint credentials were accepted"
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains(marker));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(marker));
        fn clean(root: &Path, marker: &[u8]) {
            let Ok(entries) = std::fs::read_dir(root) else {
                return;
            };
            for entry in entries {
                let entry = entry.unwrap();
                let kind = entry.file_type().unwrap();
                if kind.is_dir() {
                    clean(&entry.path(), marker);
                } else if kind.is_file() {
                    let bytes = std::fs::read(entry.path()).unwrap();
                    assert!(
                        !bytes.windows(marker.len()).any(|part| part == marker),
                        "source credential reached a stored artifact"
                    );
                }
            }
        }
        clean(&home, marker.as_bytes());
    }
}

#[test]
fn an_inert_wrapper_name_avoids_every_member_instead_of_only_the_first_suffix_collision() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let source = dir.path().join("source");
    std::fs::create_dir_all(source.join(".claude-plugin")).unwrap();
    let manifest = json!({"name":"source-server","mcpServers":{"source-server":{"url":"https://one.example/mcp"},"source-server-bundle":{"url":"https://two.example/mcp"}}});
    std::fs::write(
        source.join(".claude-plugin/plugin.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let result = inspect(&home, &source);
    let name = result["manifest"]["name"].as_str().unwrap();
    assert!(result["members"]
        .as_array()
        .unwrap()
        .iter()
        .all(|member| member["name"] != name));
    install(&home, &source);
}

#[test]
fn stripped_inline_environment_values_do_not_influence_public_content_versions() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let source = dir.path().join("source");
    plugin(&source, None, "console.log('source');");
    let path = source.join(".claude-plugin/plugin.json");
    let mut metadata: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    metadata["mcpServers"]["source-server"]["env"] = json!({"TOKEN":"PRIVATE_FIRST_SOURCE_VALUE"});
    std::fs::write(&path, serde_json::to_vec(&metadata).unwrap()).unwrap();
    let first = inspect(&home, &source);
    metadata["mcpServers"]["source-server"]["env"] = json!({"TOKEN":"PRIVATE_SECOND_SOURCE_VALUE"});
    std::fs::write(&path, serde_json::to_vec(&metadata).unwrap()).unwrap();
    let second = inspect(&home, &source);
    assert_eq!(
        first["sha256"], second["sha256"],
        "stripped credentials must not leave a public fingerprint"
    );
}

#[test]
fn inline_remote_members_use_the_plugin_or_content_version_when_the_endpoint_changes() {
    for explicit in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let source = dir.path().join("source");
        std::fs::create_dir_all(source.join(".claude-plugin")).unwrap();
        let mut metadata = json!({"name":"source-demo","mcpServers":{"source-server":{"url":"https://mcp.example/one"}}});
        if explicit {
            metadata["version"] = "1.0.0".into();
        }
        let path = source.join(".claude-plugin/plugin.json");
        std::fs::write(&path, serde_json::to_vec(&metadata).unwrap()).unwrap();
        let first = inspect(&home, &source);
        let old = first["members"][0]["manifest"]["version"].as_str().unwrap();
        if explicit {
            assert_eq!(old, "1.0.0");
        }
        install(&home, &source);
        metadata["mcpServers"]["source-server"]["url"] = "https://mcp.example/two".into();
        if explicit {
            metadata["version"] = "1.1.0".into();
        }
        std::fs::write(&path, serde_json::to_vec(&metadata).unwrap()).unwrap();
        let second = inspect(&home, &source);
        let new = second["members"][0]["manifest"]["version"]
            .as_str()
            .unwrap();
        assert_ne!(old, new);
        if explicit {
            assert_eq!(new, "1.1.0");
        }
        install(&home, &source);
        assert!(home.join("mcp/source-server").join(old).is_dir());
        let installed: Value = serde_json::from_slice(
            &std::fs::read(home.join("mcp/source-server").join(new).join("p1x.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(installed["remote"]["url"], "https://mcp.example/two");
    }
}
