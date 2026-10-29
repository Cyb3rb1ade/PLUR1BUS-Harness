//! B4: actual supervisor workers consume private API uploads once and bind disclosure/install to their person.
mod common;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn package() -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file("SKILL.md", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(
        b"---\nname: uploaded-skill\ndescription: Uploaded fixture\n---\nFixture instructions.\n",
    )
    .unwrap();
    zip.finish().unwrap().into_inner()
}

fn mcp_bundle() -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let manifest = json!({"manifest_version":"0.3","name":"uploaded-server","version":"1.0.0",
        "description":"Fixture","author":{"name":"Test"},"server":{"type":"node","entry_point":"main.js",
        "mcp_config":{"command":"node","args":["${__dirname}/main.js"]}}});
    for (name, bytes) in [
        ("manifest.json", serde_json::to_vec(&manifest).unwrap()),
        ("main.js", b"console.log('fixture');".to_vec()),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn call(home: &Path, method: &str, params: Value, person: Option<&str>) -> Value {
    let home = home.to_path_buf();
    let method = method.to_owned();
    let person = person.map(str::to_owned);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut conn = common::raw(&home);
        let delegation = person.map(|person| {
            json!({ "clientId": "harness-api",
            "token": std::fs::read_to_string(home.join("run/api-delegation.token")).unwrap().trim(),
            "principal": { "userId": person, "kind": "person", "role": "admin" } })
        });
        let mut auth = json!({"jsonrpc":"2.0","id":1,"method":"supervisor.auth",
            "params":{"token":common::token(&home)}});
        let mut request = json!({"jsonrpc":"2.0","id":2,"method":method,"params":params});
        if let Some(api) = delegation {
            auth["api"] = api.clone();
            request["api"] = api;
        }
        writeln!(conn, "{auth}\n{request}").unwrap();
        conn.flush().unwrap();
        let mut reader = BufReader::new(conn);
        let mut line = String::new();
        loop {
            line.clear();
            assert!(reader.read_line(&mut line).unwrap() > 0);
            let value: Value = serde_json::from_str(&line).unwrap();
            if value["id"] == 2 || value["id"] == 1 && value.get("error").is_some() {
                tx.send(value).unwrap();
                return;
            }
        }
    });
    rx.recv_timeout(Duration::from_secs(60))
        .expect("supervisor reply")
}

fn result(reply: Value) -> Value {
    assert!(reply.get("result").is_some(), "RPC failed: {reply}");
    reply["result"].clone()
}

fn denied(reply: Value, code: &str, reason: &str) {
    assert_eq!(reply["error"]["data"]["error"], code);
    assert_eq!(reply["error"]["data"]["reason"], reason);
}

fn private_write(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

fn upload(home: &Path, id: &str, person: &str, bytes: &[u8]) -> PathBuf {
    let dir = home.join("run/uploads");
    std::fs::create_dir_all(&dir).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let path = dir.join(id);
    private_write(&path, bytes);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    private_write(&dir.join(format!("{id}.json")), serde_json::to_string(&json!({
        "version":1,"userId":person,"expiresAt":now+600_000,"sha256":format!("{:x}",Sha256::digest(bytes)),
        "size":bytes.len()
    })).unwrap().as_bytes());
    path
}

#[test]
fn local_inspection_get_returns_only_the_public_disclosure() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let _supervisor = common::start(home);
    let path = home.join("source.skill");
    std::fs::write(&path, package()).unwrap();
    let inspection = result(call(
        home,
        "ext.inspect",
        json!({"source":{"path":path}}),
        None,
    ));
    let read = result(call(
        home,
        "ext.inspection.get",
        json!({"inspectionId":inspection["inspectionId"]}),
        None,
    ));
    assert_eq!(read, inspection);
    assert!(read.get("sourcePath").is_none());
}

#[test]
fn real_core_delegation_binds_one_use_uploads_and_inspections_to_the_current_person() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("h");
    std::fs::create_dir_all(&home).unwrap();
    let mut config = serde_json::to_value(plur1bus_config::defaults()).unwrap();
    config["agents"]["main"] = json!({});
    config["engine"] =
        json!({"neo":{"enabled":false},"reranker":{"enabled":false},"dreaming":{"enabled":false}});
    std::fs::write(
        home.join("config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    let core_js = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/dist/core.js");
    let _supervisor = common::start_with_core(
        &home,
        &dir.path().join("events.jsonl"),
        "0.2",
        &[
            ("PLUR1BUS_CORE_JS", core_js.to_str().unwrap()),
            ("PLUR1BUS_TEST_INTERNALS", "flat-embedder"),
            ("PLUR1BUS_TEST_EXT_WORKER_ARGS", "inspect:--sleep-ms 400"),
        ],
    );
    common::wait_until("real Core", Duration::from_secs(30), || {
        home.join("run/api-delegation.token").is_file()
    });
    let address = if cfg!(windows) {
        let address = common::address(&home);
        format!("{}-core", address.strip_suffix("-supervisor").unwrap())
    } else {
        home.join("run/core.sock").to_string_lossy().into_owned()
    };
    let token = std::fs::read_to_string(home.join("run/core.token")).unwrap();
    let pid = std::fs::read_to_string(home.join("run/core.pid"))
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let options = plur1bus_rpc::ConnectOptions {
        endpoint: plur1bus_rpc::Endpoint::Core,
        expected_server_pid: Some(pid),
        ..Default::default()
    };
    let mut core = None;
    common::wait_until("Core listener", Duration::from_secs(30), || {
        core = plur1bus_rpc::Client::connect(&address, token.trim(), options.clone()).ok();
        core.is_some()
    });
    let mut core = core.unwrap();
    let invite = core
        .call(
            "user.invite.create",
            json!({"displayName":"Other Admin","role":"admin","channel":"web"}),
        )
        .unwrap();
    let other = invite["userId"].as_str().unwrap();
    let path = upload(&home, &"A".repeat(43), "local-owner", &package());
    denied(
        call(
            &home,
            "ext.inspect",
            json!({"source":{"path":path}}),
            Some("local-owner"),
        ),
        "E_DENIED",
        "upload-required",
    );
    denied(
        call(
            &home,
            "ext.inspect",
            json!({"source":{"upload":"A".repeat(43)}}),
            Some(other),
        ),
        "E_NOT_FOUND",
        "upload-expired",
    );
    assert!(
        path.exists(),
        "a foreign person must not consume the owner's upload"
    );
    let inspection = std::thread::scope(|scope| {
        let inspecting = scope.spawn(|| {
            call(
                &home,
                "ext.inspect",
                json!({"source":{"upload":"A".repeat(43)}}),
                Some("local-owner"),
            )
        });
        let mut pending = None;
        common::wait_until(
            "ownership reserved before the worker publishes its record",
            Duration::from_secs(2),
            || {
                pending = std::fs::read_dir(home.join("run/inspect"))
                    .ok()
                    .and_then(|entries| {
                        entries.flatten().find_map(|entry| {
                            let name = entry.file_name().to_string_lossy().into_owned();
                            let id = name.strip_suffix(".owner.json")?;
                            (!home.join("run/inspect").join(format!("{id}.json")).exists())
                                .then(|| id.to_string())
                        })
                    });
                pending.is_some()
            },
        );
        let pending = json!({"inspectionId":pending.unwrap()});
        denied(
            call(&home, "ext.inspection.get", pending.clone(), None),
            "E_NOT_FOUND",
            "inspection-expired",
        );
        denied(
            call(
                &home,
                "ext.inspection.get",
                pending.clone(),
                Some("local-owner"),
            ),
            "E_NOT_FOUND",
            "inspection-expired",
        );
        denied(
            call(&home, "ext.inspection.get", pending, None),
            "E_NOT_FOUND",
            "inspection-expired",
        );
        let claims: Vec<_> = std::fs::read_dir(home.join("run/uploads"))
            .unwrap()
            .flatten()
            .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
            .filter(|name| name.contains(".claim-"))
            .collect();
        assert_eq!(claims.len(), 1);
        let nonce = claims[0]
            .strip_prefix(&format!(".{}.claim-", "A".repeat(43)))
            .unwrap()
            .strip_suffix(".json")
            .unwrap();
        assert_eq!(nonce.len(), 32);
        assert!(nonce.bytes().all(|byte| byte.is_ascii_hexdigit()));
        result(inspecting.join().unwrap())
    });
    assert!(!path.exists());
    assert!(!path.with_extension("json").exists());
    denied(
        call(
            &home,
            "ext.inspect",
            json!({"source":{"upload":"A".repeat(43)}}),
            Some("local-owner"),
        ),
        "E_NOT_FOUND",
        "upload-expired",
    );
    let params = json!({"inspectionId":inspection["inspectionId"]});
    denied(
        call(&home, "ext.inspection.get", params.clone(), Some(other)),
        "E_NOT_FOUND",
        "inspection-expired",
    );
    denied(
        call(&home, "ext.inspection.get", params.clone(), None),
        "E_NOT_FOUND",
        "inspection-expired",
    );
    assert_eq!(
        result(call(
            &home,
            "ext.inspection.get",
            params.clone(),
            Some("local-owner")
        )),
        inspection
    );
    let second_path = home.join("second.skill");
    std::fs::write(&second_path, package()).unwrap();
    result(call(
        &home,
        "ext.inspect",
        json!({"source":{"path":second_path}}),
        None,
    ));
    assert_eq!(
        result(call(
            &home,
            "ext.inspection.get",
            params.clone(),
            Some("local-owner")
        )),
        inspection,
        "a later worker's pruning must preserve live inspection ownership"
    );
    let raw_p1x = std::fs::read(home.join("run/inspect").join(format!(
        "{}.p1x",
        inspection["inspectionId"].as_str().unwrap()
    )))
    .unwrap();
    for (id, bytes, kind) in [
        ("G".repeat(43), raw_p1x, "skill"),
        ("H".repeat(43), mcp_bundle(), "mcp-server"),
    ] {
        let path = upload(&home, &id, "local-owner", &bytes);
        let discovered = result(call(
            &home,
            "ext.inspect",
            json!({"source":{"upload":id}}),
            Some("local-owner"),
        ));
        assert_eq!(
            discovered["manifest"]["kind"], kind,
            "format detection comes from verified bytes, not a browser filename"
        );
        assert!(!path.exists());
    }
    denied(
        call(&home, "ext.install", params.clone(), Some(other)),
        "E_NOT_FOUND",
        "inspection-expired",
    );
    let installed = result(call(
        &home,
        "ext.install",
        json!({"inspectionId":inspection["inspectionId"],"acknowledge":["unsigned"]}),
        Some("local-owner"),
    ));
    assert_eq!(installed["name"], "uploaded-skill");
    denied(
        call(&home, "ext.inspection.get", params, Some("local-owner")),
        "E_NOT_FOUND",
        "inspection-expired",
    );

    for (character, reason) in [('B', "expiry"), ('C', "size"), ('D', "digest")] {
        let id = character.to_string().repeat(43);
        let path = upload(&home, &id, "local-owner", &package());
        if reason == "expiry" {
            let metadata = path.with_extension("json");
            let mut value: Value =
                serde_json::from_slice(&std::fs::read(&metadata).unwrap()).unwrap();
            value["expiresAt"] = json!(0);
            private_write(&metadata, &serde_json::to_vec(&value).unwrap());
        } else {
            let mut bytes = std::fs::read(&path).unwrap();
            if reason == "size" {
                bytes.push(0);
            } else {
                bytes[0] ^= 1;
            }
            private_write(&path, &bytes);
        }
        let reply = call(
            &home,
            "ext.inspect",
            json!({"source":{"upload":id}}),
            Some("local-owner"),
        );
        if reason == "digest" {
            denied(reply, "E_INVALID_PARAMS", "digest-mismatch");
        } else {
            denied(reply, "E_NOT_FOUND", "upload-expired");
        }
        assert!(
            !path.exists() && !path.with_extension("json").exists(),
            "a claimed upload is removed on every refusal"
        );
        assert!(!std::fs::read_dir(home.join("run/uploads"))
            .unwrap()
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .contains(&format!(".{id}.claim-"))));
    }
    #[cfg(unix)]
    {
        let id = "E".repeat(43);
        let path = upload(&home, &id, "local-owner", &package());
        let outside = dir.path().join("outside.bin");
        std::fs::write(&outside, package()).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        denied(
            call(
                &home,
                "ext.inspect",
                json!({"source":{"upload":id}}),
                Some("local-owner"),
            ),
            "E_NOT_FOUND",
            "upload-expired",
        );
        assert_eq!(
            std::fs::read(outside).unwrap(),
            package(),
            "a symlink target is never consumed or removed"
        );
    }
    let id = "F".repeat(43);
    let path = upload(&home, &id, "local-owner", &package());
    let source = json!({"source":{"upload":id}});
    let (first, second) = std::thread::scope(|scope| {
        let first = scope.spawn(|| call(&home, "ext.inspect", source.clone(), Some("local-owner")));
        let second =
            scope.spawn(|| call(&home, "ext.inspect", source.clone(), Some("local-owner")));
        (first.join().unwrap(), second.join().unwrap())
    });
    assert_eq!(
        [&first, &second]
            .iter()
            .filter(|reply| reply.get("result").is_some())
            .count(),
        1,
        "concurrent requests must atomically consume exactly one inspection"
    );
    let refused = if first.get("error").is_some() {
        first
    } else {
        second
    };
    denied(refused, "E_NOT_FOUND", "upload-expired");
    assert!(!path.exists());
    assert!(
        !std::fs::read_dir(home.join("run/inspect"))
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp-source")),
        "verified temporary source copies are always removed"
    );
}
