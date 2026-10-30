//! Claude plugin normalization: optional metadata, nested digests, explicit member rights and unsupported parts (M-A11).
use plur1bus_ext::claude::{normalise_claude, ClaudeInput, EgressFetch, NoNetwork};
use plur1bus_ext::manifest::Kind;
use plur1bus_ext::mcpb::McpbContext;
use plur1bus_ext::refusal::{reason, Refusal};
use plur1bus_ext::zipaudit::{audit_zip, read_entry, Limits};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};
use std::path::Path;

const CREATED: &str = "2026-10-28T12:00:00Z";

fn context(name: &str) -> Result<McpbContext, Refusal> {
    Ok(McpbContext {
        platform: "linux".into(),
        extension_dir: format!("/extensions/packages/{name}/payload"),
        path_separator: "/".into(),
        system_dirs: [("HOME".into(), "/home/demo".into())].into(),
        ..Default::default()
    })
}

fn write(root: &Path, path: &str, bytes: impl AsRef<[u8]>) {
    let path = root.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

fn skill(root: &Path, name: &str) {
    write(
        root,
        &format!("skills/{name}/SKILL.md"),
        format!("---\nname: {name}\ndescription: A demo skill\nlicense: MIT\n---\n\n# Body\n"),
    );
}

fn normalize(root: &Path) -> (plur1bus_ext::claude::ClaudeReport, Vec<u8>) {
    let mut out = Cursor::new(Vec::new());
    let report = normalise_claude(
        &ClaudeInput::Dir(root.into()),
        context,
        &mut NoNetwork,
        &Limits::default(),
        CREATED,
        &mut out,
    )
    .unwrap();
    (report, out.into_inner())
}

fn mcpb() -> Vec<u8> {
    let m = json!({"manifest_version":"0.4","name":"demo-server","version":"1.2.3","description":"Demo",
        "author":{"name":"Example"},"server":{"type":"node","entry_point":"server/main.js","mcp_config":{"command":"node","args":["${__dirname}/server/main.js"]}}});
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("manifest.json", options).unwrap();
    zip.write_all(&serde_json::to_vec(&m).unwrap()).unwrap();
    zip.start_file("server/main.js", options).unwrap();
    zip.write_all(b"console.log('demo');").unwrap();
    zip.finish().unwrap().into_inner()
}

#[test]
fn optional_plugin_manifest_uses_default_skills_and_an_inert_unsigned_wrapper() {
    for with_manifest in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        skill(dir.path(), "demo-skill");
        if with_manifest {
            write(
                dir.path(),
                ".claude-plugin/plugin.json",
                br#"{"name":"demo-plugin"}"#,
            );
        }
        let (report, bytes) = normalize(dir.path());
        assert_eq!(report.manifest.kind, Kind::Bundle);
        assert!(!report.manifest.default_enabled);
        assert_eq!(report.manifest.requires["runtime"]["type"], "none");
        assert_eq!(report.manifest.capabilities["processes"]["spawn"], false);
        assert_eq!(report.members.len(), 1);
        assert_eq!(report.members[0].manifest.kind, Kind::Skill);
        let mut input = Cursor::new(bytes);
        let audit = audit_zip(&mut input, &Limits::default()).unwrap();
        assert!(!audit.entries.iter().any(|e| e.name.ends_with(".minisig")));
        let child = audit
            .entries
            .iter()
            .find(|e| e.name == "payload/members/demo-skill.p1x")
            .unwrap();
        let body = read_entry(&mut input, child, 1 << 20).unwrap();
        let hash = format!("{:x}", Sha256::digest(body));
        assert_eq!(report.manifest.rest["members"][0]["sha256"], hash);
        assert_eq!(report.members[0].sha256, hash);
    }
}

#[test]
fn local_mcpb_members_keep_full_capabilities_outside_the_inert_wrapper() {
    let dir = tempfile::tempdir().unwrap();
    skill(dir.path(), "demo-skill");
    write(
        dir.path(),
        ".claude-plugin/plugin.json",
        br#"{"name":"demo-plugin","mcpServers":"./server.mcpb"}"#,
    );
    write(dir.path(), "server.mcpb", mcpb());
    let (report, _) = normalize(dir.path());
    assert_eq!(report.members.len(), 2);
    let child = report
        .members
        .iter()
        .find(|m| m.manifest.kind == Kind::McpServer)
        .unwrap();
    assert_eq!(child.manifest.capabilities["processes"]["spawn"], true);
    assert_eq!(child.manifest.capabilities["network"]["mode"], "any");
    assert_eq!(report.manifest.capabilities["network"]["mode"], "none");
}

#[test]
fn custom_unsupported_component_paths_are_not_copied_into_inline_mcp_members() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        ".claude-plugin/plugin.json",
        br#"{"name":"demo-plugin","commands":{"custom":"./extra-commands"}}"#,
    );
    write(
        dir.path(),
        ".mcp.json",
        br#"{"mcpServers":{"demo-server":{"command":"node","args":["./server/main.js"]}}}"#,
    );
    write(dir.path(), "server/main.js", "console.log('demo');");
    write(dir.path(), "extra-commands/danger.md", "PRIVATE-COMMAND");
    let (report, _) = normalize(dir.path());
    assert!(report
        .skipped
        .iter()
        .any(|component| component.name == "commands"));
    assert!(!report.members[0]
        .manifest
        .files
        .keys()
        .any(|path| path.starts_with("payload/extra-commands/")));
}

#[test]
fn unsupported_component_names_are_reported_without_copying_or_running_contents() {
    let dir = tempfile::tempdir().unwrap();
    skill(dir.path(), "demo-skill");
    write(dir.path(),".claude-plugin/plugin.json",serde_json::to_vec(&json!({"name":"demo-plugin",
        "commands":{"danger":{"command":"PRIVATE-COMMAND"}},"agents":["./agents"],"hooks":{"value":"PRIVATE-HOOK"},
        "lspServers":{},"outputStyles":"./styles","workflows":{},"experimental":{"danger":{"key":"PRIVATE-EXPERIMENT"}},
        "settings":{"key":"PRIVATE-SETTING"},"channels":{}})).unwrap());
    write(dir.path(), "bin/run.sh", b"touch /tmp/THIS-MUST-NOT-RUN");
    let (report, bytes) = normalize(dir.path());
    for name in [
        "commands",
        "agents",
        "hooks",
        "lspServers",
        "outputStyles",
        "workflows",
        "experimental.danger",
        "bin/",
        "settings",
        "channels",
    ] {
        assert!(report.skipped.iter().any(|s| s.name == name), "{name}");
    }
    let text = format!("{:?}", report);
    assert!(!text.contains("PRIVATE-"));
    let mut input = Cursor::new(bytes);
    let audit = audit_zip(&mut input, &Limits::default()).unwrap();
    assert!(audit
        .entries
        .iter()
        .all(|e| e.name == "p1x.json" || e.name.starts_with("payload/members/")));
}

#[test]
fn inline_stdio_and_default_mcp_json_become_members_without_source_credentials() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        ".claude-plugin/plugin.json",
        br#"{"name":"demo-plugin"}"#,
    );
    write(
        dir.path(),
        ".mcp.json",
        serde_json::to_vec(&json!({"mcpServers":{"inline":{"command":"node",
        "args":["${CLAUDE_PLUGIN_ROOT}/servers/main.js"],"env":{"API_KEY":"PRIVATE-CREDENTIAL"}}}}))
        .unwrap(),
    );
    write(dir.path(), "servers/main.js", b"console.log('demo');");
    let (report, bytes) = normalize(dir.path());
    let child = &report.members[0];
    assert_eq!(child.manifest.kind, Kind::McpServer);
    assert!(child.manifest.capabilities["secrets"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["slot"] == "API_KEY" && s["required"] == true));
    assert!(!format!("{:?}", report).contains("PRIVATE-CREDENTIAL"));
    let mut input = Cursor::new(bytes);
    let audit = audit_zip(&mut input, &Limits::default()).unwrap();
    let member = audit
        .entries
        .iter()
        .find(|e| e.name.starts_with("payload/"))
        .unwrap();
    let raw = read_entry(&mut input, member, 1 << 20).unwrap();
    let mut input = Cursor::new(raw);
    let nested = audit_zip(&mut input, &Limits::default()).unwrap();
    for entry in &nested.entries {
        assert!(!read_entry(&mut input, entry, 1 << 20)
            .unwrap()
            .windows(18)
            .any(|b| b == b"PRIVATE-CREDENTIAL"));
    }
}

struct Fetch {
    bytes: Vec<u8>,
    calls: Vec<String>,
}
impl EgressFetch for Fetch {
    fn fetch(&mut self, url: &str, _cap: u64) -> Result<Box<dyn Read>, Refusal> {
        self.calls.push(url.into());
        Ok(Box::new(Cursor::new(self.bytes.clone())))
    }
}

#[test]
fn https_mcpb_references_use_only_the_injected_bounded_egress_port() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        ".claude-plugin/plugin.json",
        br#"{"name":"demo-plugin","mcpServers":"https://example.test/server.mcpb"}"#,
    );
    let mut fetch = Fetch {
        bytes: mcpb(),
        calls: Vec::new(),
    };
    let mut out = Cursor::new(Vec::new());
    let report = normalise_claude(
        &ClaudeInput::Dir(dir.path().into()),
        context,
        &mut fetch,
        &Limits::default(),
        CREATED,
        &mut out,
    )
    .unwrap();
    assert_eq!(fetch.calls, ["https://example.test/server.mcpb"]);
    assert_eq!(report.members.len(), 1);
    let error = normalise_claude(
        &ClaudeInput::Dir(dir.path().into()),
        context,
        &mut NoNetwork,
        &Limits::default(),
        CREATED,
        &mut Cursor::new(Vec::new()),
    )
    .unwrap_err();
    assert_eq!(error.code, "E_NOT_AVAILABLE");
}

#[test]
fn escaping_paths_invalid_manifests_and_oversized_sources_refuse_without_output() {
    for source in [
        br#"{"name":"demo-plugin","mcpServers":"../outside.mcpb"}"#.as_slice(),
        br#"{}"#.as_slice(),
        br#"{"name":4}"#.as_slice(),
    ] {
        let dir = tempfile::tempdir().unwrap();
        skill(dir.path(), "demo-skill");
        write(dir.path(), ".claude-plugin/plugin.json", source);
        let mut out = Cursor::new(Vec::new());
        assert!(normalise_claude(
            &ClaudeInput::Dir(dir.path().into()),
            context,
            &mut NoNetwork,
            &Limits::default(),
            CREATED,
            &mut out
        )
        .is_err());
        assert!(out.into_inner().is_empty());
    }
}

#[test]
fn referenced_mcp_configuration_files_are_not_copied_into_inline_server_payloads() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        ".claude-plugin/plugin.json",
        br#"{"name":"demo-plugin","mcpServers":"./config/mcp.json"}"#,
    );
    write(
        dir.path(),
        "config/mcp.json",
        serde_json::to_vec(&json!({"mcpServers":{"inline":{"command":"node",
        "args":["${CLAUDE_PLUGIN_ROOT}/servers/main.js"],"env":{"TOKEN":"PRIVATE-CREDENTIAL"}}}}))
        .unwrap(),
    );
    write(dir.path(), "servers/main.js", b"console.log('demo');");
    let (_, bytes) = normalize(dir.path());
    let mut outer = Cursor::new(bytes);
    let audit = audit_zip(&mut outer, &Limits::default()).unwrap();
    let entry = audit
        .entries
        .iter()
        .find(|e| e.name.starts_with("payload/"))
        .unwrap();
    let child = read_entry(&mut outer, entry, 1 << 20).unwrap();
    let mut child = Cursor::new(child);
    let nested = audit_zip(&mut child, &Limits::default()).unwrap();
    assert!(!nested
        .entries
        .iter()
        .any(|e| e.name == "payload/config/mcp.json"));
    for entry in &nested.entries {
        assert!(!read_entry(&mut child, entry, 1 << 20)
            .unwrap()
            .windows(18)
            .any(|b| b == b"PRIVATE-CREDENTIAL"));
    }
}

#[cfg(unix)]
#[test]
fn plugin_zip_sources_refuse_symlink_inputs() {
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("plugin.zip");
    std::fs::write(&archive, mcpb()).unwrap();
    let link = dir.path().join("link.zip");
    std::os::unix::fs::symlink(&archive, &link).unwrap();
    let error = normalise_claude(
        &ClaudeInput::Zip(link),
        context,
        &mut NoNetwork,
        &Limits::default(),
        CREATED,
        &mut Cursor::new(Vec::new()),
    )
    .unwrap_err();
    assert_eq!(error.reason, reason::UNSAFE_ENTRY);
}

#[test]
fn a_plugin_zip_with_one_top_directory_supports_the_default_layout() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugin.zip");
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("plugin/skills/demo-skill/SKILL.md", options)
        .unwrap();
    zip.write_all(b"---\nname: demo-skill\ndescription: Demo\n---\n# Body")
        .unwrap();
    std::fs::write(&path, zip.finish().unwrap().into_inner()).unwrap();
    let report = normalise_claude(
        &ClaudeInput::Zip(path),
        context,
        &mut NoNetwork,
        &Limits::default(),
        CREATED,
        &mut Cursor::new(Vec::new()),
    )
    .unwrap();
    assert_eq!(report.manifest.name, "plugin");
    assert_eq!(report.members[0].manifest.name, "demo-skill");
}

#[test]
fn remote_inline_authorization_values_become_required_member_secret_slots() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(),".claude-plugin/plugin.json",serde_json::to_vec(&json!({"name":"demo-plugin",
        "mcpServers":{"remote":{"type":"http","url":"https://example.test/mcp","headers":{"Authorization":"Bearer PRIVATE-CREDENTIAL"}}}})).unwrap());
    let (report, _) = normalize(dir.path());
    let member = &report.members[0].manifest;
    assert_eq!(member.rest["remote"]["auth"], "header");
    assert_eq!(member.capabilities["secrets"][0]["slot"], "bearer");
    assert_eq!(member.capabilities["secrets"][0]["required"], true);
    assert!(!format!("{:?}", report).contains("PRIVATE-CREDENTIAL"));
}

#[test]
fn external_source_credentials_are_refused_without_being_reflected_in_errors() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(),".claude-plugin/plugin.json",br#"{"name":"demo-plugin","mcpServers":"https://user:PRIVATE-CREDENTIAL@example.test/server.mcpb"}"#);
    let mut fetch = Fetch {
        bytes: mcpb(),
        calls: Vec::new(),
    };
    let error = normalise_claude(
        &ClaudeInput::Dir(dir.path().into()),
        context,
        &mut fetch,
        &Limits::default(),
        CREATED,
        &mut Cursor::new(Vec::new()),
    )
    .unwrap_err();
    assert!(fetch.calls.is_empty());
    assert!(!error.detail.contains("PRIVATE-CREDENTIAL"));
}

#[test]
fn remote_sources_and_all_expanded_members_share_aggregate_limits() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        ".claude-plugin/plugin.json",
        br#"{"name":"demo-plugin","mcpServers":"https://example.test/server.mcpb"}"#,
    );
    let mut fetch = Fetch {
        bytes: mcpb(),
        calls: Vec::new(),
    };
    let mut out = Cursor::new(Vec::new());
    let limits = Limits {
        package_bytes: 128,
        ..Limits::default()
    };
    let error = normalise_claude(
        &ClaudeInput::Dir(dir.path().into()),
        context,
        &mut fetch,
        &limits,
        CREATED,
        &mut out,
    )
    .unwrap_err();
    assert_eq!(error.reason, reason::TOO_LARGE);
    assert!(out.into_inner().is_empty());
}
