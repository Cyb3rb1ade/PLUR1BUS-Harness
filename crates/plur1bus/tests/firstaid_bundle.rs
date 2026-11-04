//! `plur1bus 1staid bundle` (M8, logging and diagnostics spec §2.9): the archive has the expected parts, its manifest
//! checksums match, it is private, it never overwrites, and a marker test over every file of the zip finds none of
//! the canaries planted in the config, the logs, the token files and the files a bundle must never read. Temp homes
//! only; no supervisor runs, so nothing here depends on the core.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const CANARIES: [&str; 9] = [
    "CANARY-CONFIG-APIKEY-7731",
    "CANARY-OTLP-HEADER-5521",
    "CANARY-LOG-BEARER-9913",
    "CANARY-URL-CODE-4410",
    "CANARY-RUN-TOKEN-0f3a9c2b77e1",
    "CANARY-CONFIG-VENDOR-8841",
    "CANARY-AUDIT-ONLY-2209",
    "CANARY-PAYLOAD-ONLY-3318",
    "CANARY-STATE-FILE-6620",
];

struct Home {
    _dir: tempfile::TempDir,
    home: PathBuf,
}

fn bin() -> PathBuf {
    assert_cmd::cargo::cargo_bin("plur1bus")
}

fn write(p: &Path, text: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

impl Home {
    fn new() -> Home {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("h");
        std::fs::create_dir_all(&home).unwrap();
        // config: secrets by key name, a vendor key inside a plain string, the OTLP headers
        write(
            &home.join("config.json"),
            &format!(
                r#"{{"schemaVersion":1,"logs":{{"otlp":{{"endpoint":"http://127.0.0.1:4318","headers":{{"x-api":"{}"}}}}}},
"engine":{{"embedding":{{"apiKey":"{}"}},"note":"uses {}"}},"supervisor":{{"graceMs":900}}}}"#,
                CANARIES[1], CANARIES[0], "sk-CANARY-CONFIG-VENDOR-8841-abcdefgh"
            ),
        );
        // a registered secret: it must go even where no key name stands next to it
        write(&home.join("run/core.token"), &format!("{}\n", CANARIES[4]));
        write(
            &home.join("logs/supervisor.log"),
            &format!(
                "{{\"at\":1,\"level\":\"info\",\"role\":\"supervisor\",\"msg\":\"early line\"}}\n\
                 {{\"at\":2,\"level\":\"warn\",\"role\":\"supervisor\",\"msg\":\"call failed Authorization: Bearer {}\"}}\n\
                 {{\"at\":3,\"level\":\"warn\",\"role\":\"core\",\"msg\":\"open https://example.test/cb?code={}&state=ok\"}}\n\
                 {{\"at\":4,\"level\":\"info\",\"role\":\"core\",\"msg\":\"leaked {} bare\"}}\n",
                CANARIES[2], CANARIES[3], CANARIES[4]
            ),
        );
        write(
            &home.join("logs/core.out.log"),
            "plain stdout line\nsecond line\n",
        );
        write(
            &home.join("logs/audit.log"),
            &format!(
                "{{\"at\":1,\"action\":\"x\",\"detail\":\"{}\"}}\n",
                CANARIES[6]
            ),
        );
        write(
            &home.join("logs/payload.log"),
            &format!("prompt {}\n", CANARIES[7]),
        );
        write(&home.join("state/store.db"), CANARIES[8]);
        Home { _dir: dir, home }
    }

    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(bin());
        c.arg("--json")
            .arg("--home")
            .arg(&self.home)
            .args(args)
            .env_remove("PLUR1BUS_SERVICE_FAKE")
            .env_remove("PLUR1BUS_ALLOW_TEST_INTERNALS")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c
    }

    fn bundle(&self, args: &[&str]) -> Output {
        let mut a = vec!["1staid", "bundle"];
        a.extend_from_slice(args);
        self.cmd(&a).output().unwrap()
    }
}

fn doc(o: &Output) -> Value {
    serde_json::from_slice(&o.stdout)
        .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&o.stdout)))
}

fn unzip(path: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut out = BTreeMap::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let mut b = Vec::new();
        f.read_to_end(&mut b).unwrap();
        out.insert(f.name().expect("zip entry name").to_string(), b);
    }
    out
}

#[test]
fn the_bundle_has_the_expected_parts_and_a_matching_manifest() {
    let h = Home::new();
    let out_dir = h._dir.path().join("out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let o = h.bundle(&["--out", out_dir.to_str().unwrap()]);
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    let d = doc(&o);
    assert_eq!(d["schema"], "1staid.bundle/1");
    let path = PathBuf::from(d["path"].as_str().unwrap());
    assert!(path.starts_with(&out_dir), "{path:?}");

    let files = unzip(&path);
    let names: Vec<&str> = files.keys().map(String::as_str).collect();
    for want in [
        "versions.json",
        "platform.json",
        "check.json",
        "service.json",
        "config.json",
        "logs/supervisor.log",
        "logs/core.out.log",
        "manifest.json",
    ] {
        assert!(names.contains(&want), "{want} missing from {names:?}");
    }
    for never in ["logs/audit.log", "logs/payload.log"] {
        assert!(!names.contains(&never), "{never} must not be bundled");
    }
    assert!(
        !names
            .iter()
            .any(|n| n.starts_with("state/") || n.starts_with("run/")),
        "{names:?}"
    );

    let manifest: Value = serde_json::from_slice(&files["manifest.json"]).unwrap();
    assert_eq!(manifest["schema"], "1staid.bundle.manifest/1");
    let entries = manifest["entries"].as_array().unwrap();
    assert_eq!(
        entries.len(),
        files.len() - 1,
        "every file but the manifest is listed"
    );
    for e in entries {
        let body = &files[e["path"].as_str().unwrap()];
        assert_eq!(e["size"].as_u64().unwrap() as usize, body.len());
        let hex: String = Sha256::digest(body)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(e["sha256"], hex.as_str(), "{}", e["path"]);
    }
    let check: Value = serde_json::from_slice(&files["check.json"]).unwrap();
    assert_eq!(check["schema"], "1staid.check/1");
    assert!(check["checks"].as_array().unwrap().len() >= 20);
}

#[test]
fn no_marker_secret_survives_in_any_file_of_the_bundle() {
    let h = Home::new();
    let dest = h._dir.path().join("b.zip");
    let o = h.bundle(&["--out", dest.to_str().unwrap()]);
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    for (name, body) in unzip(&dest) {
        let text = String::from_utf8_lossy(&body);
        for c in CANARIES {
            assert!(!text.contains(c), "{c} found in {name}:\n{text}");
        }
        let home = h.home.to_string_lossy();
        assert!(!text.contains(&*home), "the home path leaked into {name}");
    }
    // the diagnostics themselves are still there
    let files = unzip(&dest);
    let log = String::from_utf8_lossy(&files["logs/supervisor.log"]).into_owned();
    assert!(
        log.contains("early line") && log.contains("[REDACTED:"),
        "{log}"
    );
    let cfg: Value = serde_json::from_slice(&files["config.json"]).unwrap();
    assert_eq!(cfg["supervisor"]["graceMs"], 900);
    assert_eq!(cfg["engine"]["embedding"]["apiKey"], "••••");
    assert_eq!(cfg["logs"]["otlp"]["headers"]["x-api"], "••••");
}

#[test]
fn schema_secrets_and_endpoint_parts_are_removed_from_every_bundle_text_before_the_first_store_read(
) {
    let h = Home::new();
    let secret = uuid::Uuid::new_v4().to_string();
    let user = uuid::Uuid::new_v4().to_string();
    let query = uuid::Uuid::new_v4().to_string();
    let endpoint = format!("https://{user}:{secret}@relay.example.test/public/path?token={query}");
    let configured = serde_json::json!({"schemaVersion":1,
        "engine":{"embedding":{"apiKey":secret}},
        "voice":{"providers":{"elevenlabs":{"baseUrl":endpoint}}},
        "modelProfiles":{"primary":{"params":{"maxTokens":4096}}}});
    write(&h.home.join("config.json"), &configured.to_string());
    write(
        &h.home.join("logs/core.out.log"),
        &format!("ordinary {secret} {user} {query}\npublic relay.example.test/public/path\n"),
    );
    let dest = h._dir.path().join("schema.zip");
    let result = h.bundle(&["--out", dest.to_str().unwrap()]);
    assert_eq!(
        result.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let files = unzip(&dest);
    for body in files.values() {
        let text = String::from_utf8_lossy(body);
        for value in [&secret, &query] {
            assert!(
                !text.contains(value),
                "a declared credential escaped the support bundle"
            );
        }
    }
    assert!(
        String::from_utf8_lossy(&files["logs/core.out.log"]).contains(&user),
        "public username was globally masked"
    );
    let public: Value = serde_json::from_slice(&files["config.json"]).unwrap();
    assert_eq!(
        public["voice"]["providers"]["elevenlabs"]["baseUrl"],
        "https://[REDACTED:url]@relay.example.test/public/path?token=[REDACTED:key]"
    );
    assert_eq!(
        public["modelProfiles"]["primary"]["params"]["maxTokens"],
        4096
    );
    assert!(String::from_utf8_lossy(&files["logs/core.out.log"])
        .contains("relay.example.test/public/path"));
    assert_eq!(
        serde_json::from_str::<Value>(
            &std::fs::read_to_string(h.home.join("config.json")).unwrap()
        )
        .unwrap(),
        configured
    );
}

#[test]
fn reference_metadata_stays_readable_in_bundle_views_and_texts_while_literals_stay_masked() {
    let h = Home::new();
    let name = uuid::Uuid::new_v4().to_string();
    let provider = format!(
        "public-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    let id = uuid::Uuid::new_v4().to_string();
    let literal = uuid::Uuid::new_v4().to_string();
    let user = uuid::Uuid::new_v4().to_string();
    let query = uuid::Uuid::new_v4().to_string();
    let configured = serde_json::json!({"schemaVersion":1,
        "channels":{"telegram":{"tokenSecret":name}},
        "engine":{"embedding":{"apiKey":{"source":"store","provider":provider,"id":id}},
            "reranker":{"apiKey":literal}},
        "voice":{"providers":{"elevenlabs":{"apiKeyRef":name,
            "baseUrl":format!("https://{user}:{literal}@relay.example.test/public?token={query}")}}}
    });
    write(&h.home.join("config.json"), &configured.to_string());
    write(&h.home.join("logs/core.out.log"),
        &format!("provisioning {name} provider {provider} id {id} present=true literal {literal} {user} {query}\n"));
    let dest = h._dir.path().join("reference-metadata.zip");
    let result = h.bundle(&["--out", dest.to_str().unwrap()]);
    assert_eq!(
        result.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let files = unzip(&dest);
    let output = String::from_utf8_lossy(&files["logs/core.out.log"]);
    for reference in [&name, &provider, &id] {
        assert!(
            output.contains(reference),
            "provisioning metadata was hidden by the text registry"
        );
    }
    assert!(output.contains("present=true"));
    assert!(
        output.contains(&user),
        "public username was globally masked"
    );
    for body in files.values() {
        let text = String::from_utf8_lossy(body);
        for secret in [&literal, &query] {
            assert!(
                !text.contains(secret),
                "a literal or URL credential escaped the bundle"
            );
        }
    }
    let public: Value = serde_json::from_slice(&files["config.json"]).unwrap();
    assert_eq!(public["channels"]["telegram"]["tokenSecret"], name);
    assert_eq!(
        public["voice"]["providers"]["elevenlabs"]["apiKeyRef"],
        name
    );
    assert_eq!(
        public["engine"]["embedding"]["apiKey"]["provider"],
        provider
    );
    assert_eq!(public["engine"]["embedding"]["apiKey"]["id"], id);
}

#[test]
fn module_declarations_protect_bundle_texts_and_missing_policy_refuses_the_archive() {
    let h = Home::new();
    let secret = uuid::Uuid::new_v4().to_string();
    let module = h.home.join("modules/fixture");
    write(&module.join("index.js"), "export {};\n");
    write(&module.join("module.json"), &serde_json::json!({
        "name":"fixture","version":"0.1.0","apiVersion":"1","entry":"index.js","scope":"installation","priority":500,
        "configSchema":{"properties":{"ordinary":{"type":"string","x-sensitive":true}}}
    }).to_string());
    write(&h.home.join("config.json"), &serde_json::json!({"schemaVersion":1,"modules":{"fixture":{"enabled":false,"ordinary":secret}}}).to_string());
    write(
        &h.home.join("logs/core.out.log"),
        &format!("ordinary {secret}\n"),
    );
    let dest = h._dir.path().join("module.zip");
    let result = h.bundle(&["--out", dest.to_str().unwrap()]);
    assert_eq!(
        result.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    for body in unzip(&dest).values() {
        assert!(!String::from_utf8_lossy(body).contains(&secret));
    }
    std::fs::remove_file(module.join("module.json")).unwrap();
    let refused = h._dir.path().join("refused.zip");
    let result = h.bundle(&["--out", refused.to_str().unwrap()]);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stdout).contains("config-policy-unavailable"));
    assert!(!String::from_utf8_lossy(&result.stdout).contains(&secret));
    assert!(
        !refused.exists(),
        "no archive may escape when classification metadata is unavailable"
    );
}

#[test]
fn the_last_lines_option_keeps_the_end_of_each_log() {
    let h = Home::new();
    let dest = h._dir.path().join("b.zip");
    assert_eq!(
        h.bundle(&["--out", dest.to_str().unwrap(), "--lines", "1"])
            .status
            .code(),
        Some(0)
    );
    let files = unzip(&dest);
    let log = String::from_utf8_lossy(&files["logs/supervisor.log"]).into_owned();
    assert_eq!(log.lines().count(), 1, "{log}");
    assert!(!log.contains("early line"));
}

#[cfg(unix)]
#[test]
fn the_default_destination_and_the_file_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let h = Home::new();
    let o = h.bundle(&[]);
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    let path = PathBuf::from(doc(&o)["path"].as_str().unwrap());
    assert!(path.starts_with(h.home.join("bundles")), "{path:?}");
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(h.home.join("bundles"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}

#[test]
fn an_existing_file_is_never_overwritten() {
    let h = Home::new();
    let dest = h._dir.path().join("keep.zip");
    std::fs::write(&dest, "precious").unwrap();
    let o = h.bundle(&["--out", dest.to_str().unwrap()]);
    assert_eq!(o.status.code(), Some(1));
    assert_eq!(doc(&o)["error"], "E_CONFLICT");
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "precious");
}

#[test]
fn an_unparsable_config_is_left_out_not_copied() {
    let h = Home::new();
    write(
        &h.home.join("config.json"),
        &format!("{{ broken {} ", CANARIES[0]),
    );
    let dest = h._dir.path().join("b.zip");
    assert_eq!(
        h.bundle(&["--out", dest.to_str().unwrap()]).status.code(),
        Some(0)
    );
    let files = unzip(&dest);
    assert!(!files.contains_key("config.json"));
    let manifest: Value = serde_json::from_slice(&files["manifest.json"]).unwrap();
    assert_eq!(manifest["omitted"][0]["path"], "config.json");
    for (n, b) in files {
        assert!(!String::from_utf8_lossy(&b).contains(CANARIES[0]), "{n}");
    }
}

#[test]
fn an_empty_home_still_bundles() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("h");
    std::fs::create_dir_all(&home).unwrap();
    let h = Home { _dir: dir, home };
    let dest = h._dir.path().join("b.zip");
    let o = h.bundle(&["--out", dest.to_str().unwrap()]);
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    assert!(unzip(&dest).contains_key("check.json"));
}
