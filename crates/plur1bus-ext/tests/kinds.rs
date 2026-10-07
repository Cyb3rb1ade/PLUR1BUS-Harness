//! X2 (D1): the per-kind manifest rules (`kinds::check_kind`) and the declared-rights list (`rights::declared_rights`).
use plur1bus_ext::kinds::check_kind;
use plur1bus_ext::manifest::{parse_manifest, Kind, P1xManifest};
use plur1bus_ext::pack::PayloadFile;
use plur1bus_ext::refusal::reason;
use plur1bus_ext::rights::{declared_rights, max_risk, Risk};
use sha2::{Digest, Sha256};
use serde_json::{json, Value};

fn base(name: &str, kind: &str) -> Value {
    json!({
        "$schema": "https://plur1bus.app/schema/p1x/1/p1x.schema.json",
        "format": 1,
        "id": format!("demo/{name}"),
        "name": name,
        "version": "1.0.0",
        "kind": kind,
        "title": { "en": "Demo" },
        "summary": { "en": "A demo." },
        "publisher": { "id": "demo", "name": "Demo" },
        "licence": "MIT",
        "compat": { "harness": ">=0.0.0" },
        "requires": { "runtime": { "type": "none" } },
        "capabilities": {
            "network": { "mode": "none" },
            "filesystem": [],
            "processes": { "spawn": false },
            "harness": { "authority": "none" }
        }
    })
}

fn f(rel: &str, bytes: &[u8], exec: bool) -> PayloadFile {
    PayloadFile {
        rel: rel.into(),
        bytes: bytes.to_vec(),
        exec,
    }
}

fn parse(t: &Value, files: Vec<PayloadFile>) -> Result<P1xManifest, plur1bus_ext::refusal::Refusal> {
    // Filled by hand: `testkit::filled_manifest` panics on a template the schema refuses, which these tests want to see.
    let mut v = t.clone();
    let mut map = serde_json::Map::new();
    let mut scripts = Vec::new();
    for pf in &files {
        let hex: String = Sha256::digest(&pf.bytes).iter().map(|b| format!("{b:02x}")).collect();
        let mut e = json!({ "sha256": hex, "size": pf.bytes.len() });
        if pf.exec {
            e["exec"] = json!(true);
            scripts.push(json!(format!("payload/{}", pf.rel)));
        }
        map.insert(format!("payload/{}", pf.rel), e);
    }
    v["files"] = Value::Object(map);
    v["scripts"] = Value::Array(scripts);
    parse_manifest(&serde_json::to_vec(&v).unwrap(), &[])
}

fn remote_mcp() -> Value {
    let mut t = base("crm", "mcp-server");
    t["remote"] = json!({ "url": "https://mcp.example.org/v1", "auth": "header" });
    t["capabilities"]["network"] = json!({ "mode": "allowlist", "hosts": ["mcp.example.org"] });
    t["capabilities"]["secrets"] = json!([{ "slot": "token", "label": { "en": "Token" }, "required": true }]);
    t
}

fn local_mcp() -> Value {
    let mut t = base("files", "mcp-server");
    t["requires"] = json!({ "runtime": { "type": "node", "range": ">=24" } });
    t["capabilities"]["processes"] = json!({ "spawn": true });
    t
}

fn provider() -> Value {
    let mut t = base("acme", "provider");
    t["provider"] = json!({ "api": "chat_completions", "baseUrl": "https://api.acme.example/v1" });
    t["capabilities"]["network"] = json!({ "mode": "allowlist", "hosts": ["api.acme.example"] });
    t["capabilities"]["secrets"] = json!([{ "slot": "apiKey", "label": { "en": "Key" }, "required": true }]);
    t
}

fn refused(t: &Value, files: Vec<PayloadFile>, needle: &str) {
    let m = match parse(t, files) {
        Ok(m) => m,
        Err(e) => {
            // The closed schema may refuse it first; that is also a refusal, with the same reason.
            assert_eq!(e.reason, reason::PACKAGE_INVALID, "{e}");
            assert!(e.detail.contains(needle), "{} lacks {needle:?}", e.detail);
            return;
        }
    };
    let e = check_kind(&m).expect_err("must be refused");
    assert_eq!(e.reason, reason::PACKAGE_INVALID);
    assert_eq!(e.code, "E_INVALID_PARAMS");
    assert!(e.detail.contains(needle), "{} lacks {needle:?}", e.detail);
}

fn entry() -> Vec<PayloadFile> {
    vec![f("server.js", b"console.log(1)\n", false)]
}

#[test]
fn skill_module_and_channel_accept_their_plain_shape() {
    let skill = parse(&base("demo", "skill"), vec![f("SKILL.md", b"x", false)]).unwrap();
    check_kind(&skill).unwrap();
    for kind in ["module", "channel"] {
        let mut t = base("demo", kind);
        t["capabilities"]["harness"] = json!({ "authority": "full" });
        let m = parse(&t, vec![f("module.json", b"{}", false)]).unwrap();
        check_kind(&m).unwrap();
    }
}

#[test]
fn a_skill_never_asks_for_harness_authority() {
    let mut t = base("demo", "skill");
    t["capabilities"]["harness"] = json!({ "authority": "full" });
    refused(&t, vec![f("SKILL.md", b"x", false)], "authority");
}

#[test]
fn remote_and_provider_blocks_belong_to_their_kind_only() {
    let mut t = base("demo", "skill");
    t["remote"] = json!({ "url": "https://x.example/mcp", "auth": "none" });
    refused(&t, vec![f("SKILL.md", b"x", false)], "remote");
    let mut t = base("demo", "module");
    t["provider"] = json!({ "api": "chat_completions", "baseUrl": "https://x.example/v1" });
    refused(&t, vec![], "provider");
}

#[test]
fn a_remote_mcp_server_is_accepted_with_a_matching_allowlist() {
    let m = parse(&remote_mcp(), vec![f("README.md", b"r", false)]).unwrap();
    assert_eq!(m.kind, Kind::McpServer);
    check_kind(&m).unwrap();
}

#[test]
fn a_remote_mcp_server_is_refused_when_it_hides_its_host() {
    let mut t = remote_mcp();
    t["capabilities"]["network"] = json!({ "mode": "none" });
    refused(&t, vec![], "network");
    let mut t = remote_mcp();
    t["capabilities"]["network"] = json!({ "mode": "allowlist", "hosts": ["other.example.org"] });
    refused(&t, vec![], "mcp.example.org");
    let mut t = remote_mcp();
    t["capabilities"]["network"] = json!({ "mode": "any" });
    refused(&t, vec![], "allowlist");
}

#[test]
fn a_remote_mcp_server_with_header_auth_declares_a_required_secret() {
    let mut t = remote_mcp();
    t["capabilities"]["secrets"] = json!([]);
    refused(&t, vec![], "secret");
}

#[test]
fn a_remote_mcp_server_runs_nothing_locally() {
    let mut t = remote_mcp();
    t["requires"] = json!({ "runtime": { "type": "node", "range": ">=24" } });
    refused(&t, vec![], "runtime");
    let mut t = remote_mcp();
    t["capabilities"]["processes"] = json!({ "spawn": true });
    refused(&t, vec![], "spawn");
    refused(&remote_mcp(), vec![f("run.sh", b"#!/bin/sh\n", true)], "script");
}

#[test]
fn a_remote_url_with_credentials_or_another_scheme_is_refused() {
    let mut t = remote_mcp();
    t["remote"]["url"] = json!("https://user:pw@mcp.example.org/v1");
    refused(&t, vec![], "credentials");
    let mut t = remote_mcp();
    t["remote"]["url"] = json!("http://mcp.example.org/v1");
    refused(&t, vec![], "remote");
}

#[test]
fn a_local_mcp_server_needs_a_runtime_spawn_and_files() {
    let m = parse(&local_mcp(), entry()).unwrap();
    check_kind(&m).unwrap();
    let mut t = local_mcp();
    t["requires"] = json!({ "runtime": { "type": "none" } });
    refused(&t, entry(), "runtime");
    let mut t = local_mcp();
    t["capabilities"]["processes"] = json!({ "spawn": false });
    refused(&t, entry(), "spawn");
    refused(&local_mcp(), vec![], "payload");
}

#[test]
fn an_mcp_server_never_gets_full_authority() {
    let mut t = local_mcp();
    t["capabilities"]["harness"] = json!({ "authority": "full" });
    refused(&t, entry(), "authority");
    let mut t = local_mcp();
    t["capabilities"]["harness"] = json!({ "authority": "scoped", "rpc": ["memory.recall"] });
    check_kind(&parse(&t, entry()).unwrap()).unwrap();
}

#[test]
fn a_provider_is_accepted_and_is_pure_data() {
    let m = parse(&provider(), vec![f("NOTICE", b"n", false)]).unwrap();
    assert_eq!(m.kind, Kind::Provider);
    check_kind(&m).unwrap();
}

#[test]
fn a_provider_needs_its_block_and_a_matching_allowlist() {
    let mut t = provider();
    t.as_object_mut().unwrap().remove("provider");
    refused(&t, vec![], "provider");
    let mut t = provider();
    t["capabilities"]["network"] = json!({ "mode": "allowlist", "hosts": ["elsewhere.example"] });
    refused(&t, vec![], "api.acme.example");
    let mut t = provider();
    t["capabilities"]["network"] = json!({ "mode": "none" });
    refused(&t, vec![], "network");
    let mut t = provider();
    t["provider"]["api"] = json!("soap");
    refused(&t, vec![], "provider");
}

#[test]
fn a_provider_runs_no_code_and_holds_no_authority() {
    let mut t = provider();
    t["requires"] = json!({ "runtime": { "type": "binary" } });
    refused(&t, vec![], "runtime");
    let mut t = provider();
    t["capabilities"]["processes"] = json!({ "spawn": true });
    refused(&t, vec![], "spawn");
    let mut t = provider();
    t["capabilities"]["harness"] = json!({ "authority": "full" });
    refused(&t, vec![], "authority");
    refused(&provider(), vec![f("run.sh", b"#!/bin/sh\n", true)], "script");
}

#[test]
fn allowlist_hosts_are_bare_names() {
    for bad in ["https://x.example", "x.example/path", "x.example:443", "X.Example", "a b", ""] {
        let mut t = provider();
        t["capabilities"]["network"] = json!({ "mode": "allowlist", "hosts": [bad, "api.acme.example"] });
        refused(&t, vec![], "host");
    }
    let mut t = provider();
    t["capabilities"]["network"] = json!({ "mode": "allowlist", "hosts": ["*.acme.example"] });
    check_kind(&parse(&t, vec![]).unwrap()).unwrap();
}

#[test]
fn secret_slots_are_unique() {
    let mut t = provider();
    t["capabilities"]["secrets"] = json!([
        { "slot": "apiKey", "label": { "en": "A" }, "required": true },
        { "slot": "apiKey", "label": { "en": "B" }, "required": false }
    ]);
    refused(&t, vec![], "apiKey");
}

#[test]
fn rights_list_what_the_extension_asks_for_in_a_stable_order() {
    let m = parse(&remote_mcp(), vec![]).unwrap();
    let ids: Vec<String> = declared_rights(&m).into_iter().map(|r| r.id).collect();
    assert_eq!(
        ids,
        ["network:host:mcp.example.org", "remote:https://mcp.example.org/v1", "secret:token:required"]
    );
    let mut t = local_mcp();
    t["capabilities"]["filesystem"] = json!([
        { "scope": "extension-data", "access": "read-write" },
        { "scope": "path", "access": "read", "path": "/srv/docs" }
    ]);
    t["capabilities"]["tools"] = json!([{ "name": "wipe", "effect": "destructive" }]);
    t["capabilities"]["hostBridge"] = json!(["keychain"]);
    t["capabilities"]["harness"] = json!({ "authority": "scoped", "rpc": ["memory.recall"] });
    t["capabilities"]["processes"] = json!({ "spawn": true, "commands": ["git"] });
    let m = parse(&t, entry()).unwrap();
    let rights = declared_rights(&m);
    let ids: Vec<&str> = rights.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "fs:extension-data:read-write",
            "fs:path:/srv/docs:read",
            "harness:scoped:memory.recall",
            "hostbridge:keychain",
            "process:command:git",
            "process:spawn",
            "tool:wipe:destructive"
        ]
    );
    assert_eq!(max_risk(&rights), Some(Risk::High));
}

#[test]
fn a_package_that_asks_for_nothing_has_no_rights() {
    let m = parse(&base("demo", "skill"), vec![f("SKILL.md", b"x", false)]).unwrap();
    assert!(declared_rights(&m).is_empty());
    assert_eq!(max_risk(&[]), None);
}
