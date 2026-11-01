//! SH2 runtime canaries for Supervisor structured logs and captured child stdout/stderr.
mod common;

use common::{client, start_with_core, wait_until, WAIT};
use serde_json::{json, Value};
use std::path::Path;

fn configure(home: &Path) -> (String, String, String) {
    let root = uuid::Uuid::new_v4().to_string();
    let module = uuid::Uuid::new_v4().to_string();
    let credential = uuid::Uuid::new_v4().to_string();
    let directory = home.join("modules/fixture");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("index.js"), "export {};\n").unwrap();
    std::fs::write(
        directory.join("module.json"),
        json!({
            "name":"fixture", "version":"0.1.0", "apiVersion":"1", "entry":"index.js",
            "scope":"installation", "priority":500,
            "configSchema":{"type":"object","properties":{
                "ordinary":{"type":"string","x-sensitive":true},
                "endpoint":{"type":"string","x-url-credentials":true}
            }}
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(home.join("config.json"), json!({
        "schemaVersion":1,
        "channels":{"telegram":{"webhook":{"url":"https://relay.example.test/hook","secret":root}}},
        "modules":{"fixture":{"enabled":false,"ordinary":module,
            "endpoint":format!("https://public-user:{credential}@relay.example.test/public/path?token={credential}")}}
    }).to_string()).unwrap();
    (root, module, credential)
}

fn log(home: &Path, name: &str) -> String {
    std::fs::read_to_string(home.join("logs").join(name)).unwrap_or_default()
}

fn wrapper(home: &Path) -> std::path::PathBuf {
    let path = home.join("wrapper.mjs");
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-core.mjs");
    std::fs::write(&path, format!(r#"
import {{ readFileSync, existsSync, rmSync }} from "node:fs";
import {{ pathToFileURL }} from "node:url";
const home = process.argv[process.argv.indexOf("--home") + 1];
let previous = JSON.parse(readFileSync(`${{home}}/config.json`, "utf8"));
function emit(label, config) {{
  const values = config.modules.fixture;
  const value = Buffer.from(values.ordinary);
  const text = `${{label}} root=${{config.channels.telegram.webhook.secret}} ordinary=${{values.ordinary}} endpoint=${{values.endpoint}} base64=${{value.toString("base64")}} base64url=${{value.toString("base64url")}} hex=${{value.toString("hex")}}`;
  for (const stream of [process.stdout, process.stderr]) {{
    stream.write(`${{text}}\n${{".".repeat(8192)}}\n${{label}}-complete\n${{".".repeat(1024)}}\n`);
  }}
}}
emit("startup", previous);
setInterval(() => {{
  const trigger = `${{home}}/emit-current`;
  if (!existsSync(trigger)) return;
  rmSync(trigger);
  const current = JSON.parse(readFileSync(`${{home}}/config.json`, "utf8"));
  emit("retired", previous);
  emit("live", current);
  previous = current;
}}, 20).unref();
await import(pathToFileURL({}).href);
"#, serde_json::to_string(&fixture).unwrap())).unwrap();
    path
}

#[test]
fn structured_startup_logs_mask_root_and_installed_module_values() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let (root, module, credential) = configure(home);
    let config: Value =
        serde_json::from_slice(&std::fs::read(home.join("config.json")).unwrap()).unwrap();
    let manager = format!(
        "root={root} ordinary={module} {}",
        config["modules"]["fixture"]["endpoint"].as_str().unwrap()
    );
    let _supervisor = start_with_core(
        home,
        &home.join("events.jsonl"),
        "0.2",
        &[("PLUR1BUS_SERVICE_MANAGER", &manager)],
    );
    let text = log(home, "supervisor.log");
    assert!(
        text.contains("supervisor started"),
        "startup record missing"
    );
    assert!(
        text.contains("relay.example.test/public/path"),
        "public URL host/path lost"
    );
    for secret in [&root, &module, &credential] {
        assert!(
            !text.contains(secret),
            "structured startup log leaked a classified value"
        );
    }
}

#[test]
fn captured_stdout_and_stderr_mask_startup_live_and_retired_config_values() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let initial = configure(home);
    let wrapper = wrapper(home);
    let _supervisor = start_with_core(
        home,
        &home.join("events.jsonl"),
        "0.2",
        &[("PLUR1BUS_CORE_JS", wrapper.to_str().unwrap())],
    );
    wait_until("captured startup output", WAIT, || {
        log(home, "core.out.log")
            .matches("startup-complete")
            .count()
            >= 2
    });
    let replacement = uuid::Uuid::new_v4().to_string();
    let mut connection = client(home);
    connection
        .call(
            "config.set",
            json!({"changes":[
                {"key":"modules.fixture.ordinary","value":replacement}
            ]}),
        )
        .unwrap();
    std::fs::write(home.join("emit-current"), "").unwrap();
    wait_until("captured live output", WAIT, || {
        log(home, "core.out.log").matches("live-complete").count() >= 2
    });
    let text = log(home, "core.out.log");
    assert!(
        text.matches("startup root=").count() >= 2,
        "both output streams must be captured"
    );
    assert!(
        text.matches("live root=").count() >= 2,
        "both output streams must apply live registration"
    );
    assert!(
        text.contains("retired root="),
        "retired canary was not emitted"
    );
    assert!(
        text.contains("relay.example.test/public/path"),
        "public URL host/path lost"
    );
    for label in ["base64", "base64url", "hex"] {
        assert!(
            text.contains(&format!("{label}=[REDACTED:secret]")),
            "encoded child value was not masked"
        );
    }
    for secret in [&initial.0, &initial.1, &initial.2, &replacement] {
        assert!(
            !text.contains(secret),
            "captured child output leaked a classified value"
        );
    }
    let private: Value = connection.call("config.watch", json!({})).unwrap();
    assert_eq!(
        private["config"]["modules"]["fixture"]["ordinary"],
        replacement
    );
}

#[test]
fn unavailable_module_metadata_keeps_structured_and_captured_logs_private() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let values = configure(home);
    let wrapper = wrapper(home);
    std::fs::remove_file(home.join("modules/fixture/module.json")).unwrap();
    let manager = format!("{} {} {}", values.0, values.1, values.2);
    let _supervisor = start_with_core(
        home,
        &home.join("events.jsonl"),
        "0.2",
        &[
            ("PLUR1BUS_CORE_JS", wrapper.to_str().unwrap()),
            ("PLUR1BUS_SERVICE_MANAGER", &manager),
        ],
    );
    wait_until(
        "captured startup with private metadata fallback",
        WAIT,
        || {
            log(home, "core.out.log")
                .matches("startup-complete")
                .count()
                >= 2
        },
    );
    for name in ["supervisor.log", "core.out.log"] {
        let output = log(home, name);
        assert!(
            output.contains(if name == "supervisor.log" {
                "supervisor started"
            } else {
                "startup root="
            }),
            "metadata repair diagnostics must remain available in {name}"
        );
        assert!(
            !output.contains("payload withheld"),
            "metadata fallback stopped logging in {name}"
        );
        assert!(!output.contains("restart the Supervisor"));
        for value in [&values.0, &values.1, &values.2] {
            assert!(
                !output.contains(value),
                "unavailable policy released a raw payload"
            );
        }
    }
}

#[test]
fn installing_module_annotations_registers_preconfigured_values_before_first_output() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let (_, secret, _) = configure(home);
    let source = home.join("candidate");
    std::fs::rename(home.join("modules/fixture"), &source).unwrap();
    let mut manifest: Value =
        serde_json::from_slice(&std::fs::read(source.join("module.json")).unwrap()).unwrap();
    manifest["entry"] = json!("index.mjs");
    std::fs::write(source.join("module.json"), manifest.to_string()).unwrap();
    std::fs::write(source.join("index.mjs"), r#"
import { readFileSync } from "node:fs";
const home = process.argv[process.argv.indexOf("--home") + 1];
const config = JSON.parse(readFileSync(`${home}/config.json`, "utf8"));
for (const stream of [process.stdout, process.stderr]) {
  stream.write(`installed ordinary=${config.modules.fixture.ordinary}\n${".".repeat(8192)}\ninstalled-complete\n`);
}
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
"#).unwrap();
    let mut config: Value =
        serde_json::from_slice(&std::fs::read(home.join("config.json")).unwrap()).unwrap();
    config["modules"]["fixture"]["enabled"] = json!(true);
    std::fs::write(home.join("config.json"), config.to_string()).unwrap();
    let _supervisor = start_with_core(home, &home.join("events.jsonl"), "0.2", &[]);
    let mut connection = client(home);
    connection
        .call("module.install", json!({"path":source}))
        .unwrap();
    wait_until("newly installed module output", WAIT, || {
        log(home, "module-fixture.out.log")
            .matches("installed-complete")
            .count()
            >= 2
    });
    let output = log(home, "module-fixture.out.log");
    assert!(
        !output.contains(&secret),
        "module installation did not register new sensitivity annotations"
    );
    assert_eq!(output.matches("ordinary=[REDACTED:secret]").count(), 2);
}
