//! `plur1bus_rpc::capabilities` must build the same `Capabilities` as the TypeScript `buildCapabilities`, whose output
//! for `features: []` is committed as packages/rpc-schema/fixtures/capabilities/<server>.json.
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

fn fixture(server: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/rpc-schema/fixtures/capabilities")
        .join(format!("{server}.json"));
    serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap()
}

#[test]
fn capabilities_match_the_typescript_fixtures() {
    for server in ["core", "supervisor"] {
        assert_eq!(
            plur1bus_rpc::capabilities(server, &[]),
            fixture(server),
            "{server}"
        );
    }
}

#[test]
fn supervisor_capabilities_list_only_supervisor_methods_and_sorted_features() {
    let caps = plur1bus_rpc::capabilities("supervisor", &["lifelines", "adoption"]);
    let methods: Vec<&String> = caps["methods"].as_object().unwrap().keys().collect();
    assert_eq!(
        methods,
        [
            "config.get",
            "config.set",
            "config.watch",
            "daemon.start",
            "daemon.status",
            "daemon.stop",
            "supervisor.auth"
        ]
    );
    assert_eq!(
        caps["notifications"],
        json!({ "config.changed": { "stability": "experimental", "since": "1.3.0" } })
    );
    assert_eq!(caps["extensionPoints"], json!({}));
    assert_eq!(caps["features"], json!(["adoption", "lifelines"]));
    assert_eq!(
        caps["methods"]["daemon.status"],
        json!({"stability": "experimental", "since": "1.2.0"})
    );
    let core = plur1bus_rpc::capabilities("core", &[]);
    assert!(core["methods"].get("core.adopt").is_some());
    assert!(core["methods"].get("daemon.status").is_none());
    assert!(core["notifications"]["engine.event"]["deprecated"].is_object());
    assert!(core["methods"].get("config.set").is_none());
    assert!(core["notifications"].get("config.changed").is_none());
}
