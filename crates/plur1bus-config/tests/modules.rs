//! The `modules.<name>` namespace (B13): `x-restart: "module:$key"` resolves to `module:<name>`.
use plur1bus_config::{defaults, restart_class_of, restart_plan, validate, RestartClass};
use serde_json::json;

#[test]
fn module_keys_resolve_to_their_module() {
    assert_eq!(restart_class_of("modules"), RestartClass::Live);
    assert_eq!(restart_class_of("modules.x.enabled"), RestartClass::Module);
    assert_eq!(defaults()["modules"], json!({}));

    let mut before = defaults();
    before["modules"]["fixture"] = json!({ "enabled": true, "greeting": "hello" });
    validate(&before).expect("an open per-module object validates");
    let mut after = before.clone();
    after["modules"]["fixture"]["greeting"] = json!("hi");
    let plan = restart_plan(&before, &after);
    assert_eq!(plan.restart.modules, vec!["fixture".to_string()]);
    assert!(!plan.restart.core);
    assert!(plan.restart.live.is_empty());

    let mut added = before.clone();
    added["modules"]["fixture-b"] = json!({ "enabled": false });
    assert_eq!(
        restart_plan(&before, &added).restart.modules,
        vec!["fixture-b".to_string()]
    );

    let mut bad = before.clone();
    bad["modules"]["fixture"]["enabled"] = json!("yes");
    assert!(validate(&bad).is_err(), "enabled is a boolean");
}
