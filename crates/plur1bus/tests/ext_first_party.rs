//! Owner decision Mv2-3: trusted first-party packages activate for all agents; other tiers need explicit opt-in.
use plur1bus_ext::pack::PayloadFile;
use plur1bus_ext::testkit::{build_package_from, test_key, TestKey};
use serde_json::{json, Value};
use std::path::Path;
use std::process::{Command, Stdio};

fn package(kind: &str, key: Option<&TestKey>) -> Vec<u8> {
    let mut manifest = json!({
        "$schema":"https://plur1bus.app/schema/p1x/1/p1x.schema.json", "format":1,
        "id":"demo/fixture", "name":"fixture", "version":"1.0.0", "kind":kind,
        "title":{"en":"Fixture"}, "summary":{"en":"Activation fixture"},
        "publisher":{"id":"demo","name":"Demo"}, "licence":"MIT",
        "compat":{"harness":">=0.0.0"}, "requires":{"runtime":{"type":"none"}},
        "capabilities":{"network":{"mode":"none"},"filesystem":[],"processes":{"spawn":false},"harness":{"authority":"none"}}
    });
    let files = match kind {
        "skill" => vec![(
            "SKILL.md",
            b"---\nname: fixture\ndescription: Fixture\n---\nbody\n".to_vec(),
        )],
        "mcp-server" => {
            manifest["remote"] = json!({"url":"https://mcp.example.org/v1","auth":"none"});
            manifest["capabilities"]["network"] =
                json!({"mode":"allowlist","hosts":["mcp.example.org"]});
            vec![("README.md", b"Fixture remote server\n".to_vec())]
        }
        _ => {
            manifest["compat"]["moduleApi"] = json!(["1"]);
            manifest["requires"]["runtime"] = json!({"type":"node","range":">=24"});
            let module = json!({"name":"fixture","version":"1.0.0","apiVersion":"1","entry":"index.js","kind":kind,"scope":"installation","priority":500});
            vec![
                ("module.json", serde_json::to_vec(&module).unwrap()),
                ("index.js", b"// fixture\n".to_vec()),
            ]
        }
    };
    build_package_from(
        &manifest,
        files
            .into_iter()
            .map(|(rel, bytes)| PayloadFile {
                rel: rel.into(),
                bytes,
                exec: false,
            })
            .collect(),
        key,
    )
}

fn install(home: &Path, kind: &str, key: Option<&TestKey>, extra: &[&str]) -> Value {
    std::fs::create_dir_all(home).unwrap();
    let source = home.parent().unwrap().join("fixture.p1x");
    std::fs::write(&source, package(kind, key)).unwrap();
    let mut cfg = plur1bus_config::defaults();
    cfg["agents"] = json!({"anna":{"skills":{"blocked":["fixture"]}},"bernd":{"skills":{"blocked":["fixture"]}}});
    plur1bus_config::write_atomic(&home.join("config.json"), &cfg).unwrap();
    let verb = if kind == "skill" { "skill" } else { "plugin" };
    let mut command = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
    command
        .arg("--home")
        .arg(home)
        .args(["--json", verb, "install"])
        .arg(source)
        .arg("--yes")
        .args(extra)
        .stdin(Stdio::null());
    if let Some(key) = key {
        command.env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1").env(
            "PLUR1BUS_TEST_EXT_PUBKEYS",
            format!("{}={}", key.label, key.public_b64),
        );
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn first_party_defaults_activate_every_supported_kind_for_all_agents() {
    let key = test_key("first-party-fixture");
    for kind in ["skill", "module", "channel", "mcp-server"] {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let result = install(&home, kind, Some(&key), &[]);
        assert_eq!(result["state"], "enabled", "{kind}");
        let cfg: Value =
            serde_json::from_slice(&std::fs::read(home.join("config.json")).unwrap()).unwrap();
        if kind == "skill" {
            let index: Value =
                serde_json::from_slice(&std::fs::read(home.join("skills/index.json")).unwrap())
                    .unwrap();
            assert_eq!(index["skills"][0]["enabled"], true);
            for agent in ["anna", "bernd"] {
                assert_eq!(cfg["agents"][agent]["skills"]["blocked"], json!([]));
            }
        } else if kind == "mcp-server" {
            assert_eq!(cfg["mcp"]["servers"]["fixture"]["enabled"], true);
            assert_eq!(cfg["mcp"]["servers"]["fixture"]["agents"], "all");
        } else {
            assert_eq!(cfg["modules"]["fixture"]["enabled"], true);
        }
        let state: Value =
            serde_json::from_slice(&std::fs::read(home.join("extensions/state.json")).unwrap())
                .unwrap();
        assert!(state["items"]["fixture"]["capabilitiesAck"].is_string());
    }
}

#[test]
fn unsigned_defaults_stay_disabled_and_explicit_agent_opt_in_remains_available() {
    for kind in ["skill", "module", "channel", "mcp-server"] {
        let temp = tempfile::tempdir().unwrap();
        let result = install(&temp.path().join("home"), kind, None, &["--allow-unsigned"]);
        assert_eq!(result["state"], "installed", "{kind}");
    }
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let result = install(
        &home,
        "mcp-server",
        None,
        &["--allow-unsigned", "--enable=anna"],
    );
    assert_eq!(result["state"], "enabled");
    let cfg: Value =
        serde_json::from_slice(&std::fs::read(home.join("config.json")).unwrap()).unwrap();
    assert_eq!(cfg["mcp"]["servers"]["fixture"]["agents"], json!(["anna"]));

    // The original boolean spelling remains a complete install-and-enable action for modules.
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let result = install(&home, "module", None, &["--allow-unsigned", "--enable"]);
    assert_eq!(result["state"], "enabled");
    let cfg: Value =
        serde_json::from_slice(&std::fs::read(home.join("config.json")).unwrap()).unwrap();
    assert_eq!(cfg["modules"]["fixture"]["enabled"], true);
}

#[test]
fn first_party_install_uses_all_even_when_the_old_enable_flag_names_one_agent() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let key = test_key("first-party-fixture");
    let result = install(&home, "mcp-server", Some(&key), &["--enable=anna"]);
    assert_eq!(result["state"], "enabled");
    let cfg: Value =
        serde_json::from_slice(&std::fs::read(home.join("config.json")).unwrap()).unwrap();
    assert_eq!(cfg["mcp"]["servers"]["fixture"]["agents"], "all");
}
