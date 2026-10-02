use serde_json::Value;
use std::collections::BTreeSet;

const FIRSTAID: &str = include_str!("../../../../crates/plur1bus/src/commands/firstaid.rs");
const DAEMON: &str = include_str!("../../../../crates/plur1bus/src/commands/daemon.rs");
const SERVICE: &str = include_str!("../../../../crates/plur1bus/src/service/mod.rs");

fn struct_fields(source: &str, name: &str) -> BTreeSet<String> {
    let file = syn::parse_file(source).unwrap();
    let item = file
        .items
        .iter()
        .find_map(|item| match item {
            syn::Item::Struct(item) if item.ident == name => Some(item),
            _ => None,
        })
        .expect("real harness output struct missing");
    item.fields
        .iter()
        .map(|field| field.ident.as_ref().unwrap().to_string())
        .collect()
}

fn keys(value: &Value) -> BTreeSet<String> {
    value.as_object().unwrap().keys().cloned().collect()
}

#[test]
fn daemon_fixture_matches_real_output_fields() {
    let fixture: Value =
        serde_json::from_str(include_str!("../fixtures/daemon-status.json")).unwrap();
    // daemon.rs constructs this envelope as JSON, then Out::ok adds the schema field.
    assert!(DAEMON.contains("\"supervisor\": supervisor, \"children\": children, \"service\": svc"));
    assert_eq!(
        keys(&fixture),
        ["schema", "supervisor", "children", "service"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    );
    assert!(fixture["supervisor"]["process"]["state"].is_string());
    assert!(fixture["children"].is_array());
    assert_eq!(
        keys(&fixture["service"]),
        struct_fields(SERVICE, "ServiceStatus")
    );
}

#[test]
fn firstaid_fixture_matches_real_check_struct_and_envelope() {
    let fixture: Value =
        serde_json::from_str(include_str!("../fixtures/firstaid-check.json")).unwrap();
    assert!(FIRSTAID.contains("&json!({ \"ok\": ok, \"checks\": checks })"));
    assert_eq!(
        keys(&fixture),
        ["schema", "ok", "checks"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    );
    assert!(fixture["ok"].is_boolean());
    let all_fields = struct_fields(FIRSTAID, "Check");
    let required = ["id", "status", "summary"]
        .into_iter()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    let checks = fixture["checks"].as_array().unwrap();
    assert!(!checks.is_empty());
    assert_eq!(
        keys(&checks[0]),
        all_fields,
        "one synthetic row exercises every current Check field"
    );
    for check in checks {
        let present = keys(check);
        assert!(required.is_subset(&present));
        assert!(present.is_subset(&all_fields));
        assert!(matches!(
            check["status"].as_str(),
            Some("ok" | "warn" | "fail" | "skip")
        ));
    }
}
