//! D14 module registry: the `module.json` manifest (schema, reserved names, API-version policy B12), the dependency
//! graph with its start order, install and uninstall (B14), and the `module.list` entries. Used by the supervisor and
//! the `module` commands.
pub mod graph;
pub mod install;
pub mod manifest;
pub use graph::{band, graph, start_order, Graph};
#[allow(unused_imports)]
pub use manifest::{
    api_version_supported, current_api_version, parse_manifest, scan, Installed, Manifest,
    CORE_PROVIDES, MODULE_API_VERSION, RESERVED_NAMES,
};
use serde_json::{json, Value};

/// Why a module with a valid manifest is not in the start order: its needs-cycle, its unresolved `needs`, or a
/// `needs` on a module that cannot start itself.
pub fn excluded_because(name: &str, m: &Manifest, graph: &Graph, order: &[String]) -> Vec<String> {
    let mut errors: Vec<String> = graph
        .cycles
        .iter()
        .filter(|c| c.iter().any(|n| n == name))
        .map(|c| format!("needs-cycle: {}", c.join(", ")))
        .collect();
    errors.extend(
        graph
            .unresolved
            .iter()
            .filter(|u| u["from"] == name && u["kind"] == "needs")
            .map(|u| format!("unresolved needs: {}", u["name"].as_str().unwrap_or(""))),
    );
    if errors.is_empty() {
        errors.extend(
            m.needs
                .iter()
                .filter(|n| n.as_str() != "core" && !order.contains(n))
                .map(|n| format!("needs {n}, which cannot start")),
        );
    }
    errors
}

/// Whether `modules.<name>.enabled` lets the module run (absent means enabled).
pub fn enabled(modules_config: &Value, name: &str) -> bool {
    modules_config[name]["enabled"] != false
}

/// The `$defs/ModuleListEntry` of every installed module, in scan order, with `child: null` (the supervisor fills in
/// its child and the last polled `detail`). `errors`: the manifest's errors, why a valid module is left out of the
/// start order, an unsupported `apiVersion`, and a `modules.<name>` that does not satisfy its `configSchema` (M7).
pub fn list_entries(installed: &[Installed], modules_config: &Value) -> Vec<Value> {
    let order = start_order(installed);
    let graph = graph(installed);
    let current = current_api_version();
    installed
        .iter()
        .map(|i| {
            let enabled = enabled(modules_config, &i.name);
            match &i.manifest {
                Ok(m) => {
                    let mut errors = if order.contains(&i.name) {
                        Vec::new()
                    } else {
                        excluded_because(&i.name, m, &graph, &order)
                    };
                    let section = without_enabled(&modules_config[&i.name]);
                    if !section.is_null() {
                        errors.extend(section_errors(&i.name, m, &section));
                    }
                    if !api_version_supported(&m.api_version, current) {
                        errors.push(format!(
                            "apiVersion {} is not supported (current {current}, previous {})",
                            m.api_version,
                            current.saturating_sub(1)
                        ));
                    }
                    json!({
                        "name": i.name, "version": m.version, "apiVersion": m.api_version,
                        "priority": m.priority, "band": band(m.priority), "scope": m.scope,
                        "provides": m.provides, "consumes": m.consumes, "needs": m.needs,
                        "enabled": enabled, "errors": errors, "child": null,
                    })
                }
                Err(errors) => json!({
                    "name": i.name, "version": null, "apiVersion": null, "priority": null, "band": null,
                    "scope": null, "provides": [], "consumes": [], "needs": [], "enabled": enabled,
                    "errors": errors, "child": null,
                }),
            }
        })
        .collect()
}

/// B13: every `modules.<name>` that differs between `before` and `after` is validated against its installed
/// manifest's `configSchema` (without `enabled`, which is the supervisor's switch, H3B-R16). Returns the errors as
/// `modules.<name>.<path>: <message>`; a module without a valid manifest or without a `configSchema` is not checked.
pub fn config_errors(installed: &[Installed], before: &Value, after: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    for i in installed {
        let Ok(m) = &i.manifest else { continue };
        let section = without_enabled(&after["modules"][&i.name]);
        // I1: `enabled` is compared away too, so flipping only the switch never re-validates the section.
        if section.is_null() || section == without_enabled(&before["modules"][&i.name]) {
            continue;
        }
        errors.extend(section_errors(&i.name, m, &section));
    }
    errors
}

/// A `modules.<name>` section without `enabled` (the supervisor's switch, never the module's).
fn without_enabled(section: &Value) -> Value {
    let mut value = section.clone();
    if let Some(o) = value.as_object_mut() {
        o.remove("enabled");
    }
    value
}

/// Why `section` (without `enabled`) does not satisfy module `name`'s `configSchema`; nothing without one.
fn section_errors(name: &str, m: &Manifest, section: &Value) -> Vec<String> {
    let Some(schema) = &m.config_schema else {
        return Vec::new();
    };
    match jsonschema::options().build(schema) {
        Err(e) => vec![format!(
            "modules.{name}: the module's configSchema is not a valid schema: {e}"
        )],
        Ok(v) => v
            .iter_errors(section)
            .map(|e| {
                let path = e.instance_path.to_string().replace('/', ".");
                format!("modules.{name}{path}: {e}")
            })
            .collect(),
    }
}

/// M7: every `modules.<name>` that does not satisfy its module's `configSchema` now, whether it changed or not (a hand
/// edit made while no supervisor ran, or a reinstall with a stricter schema). Reported, never refused.
pub fn current_config_errors(installed: &[Installed], config: &Value) -> Vec<String> {
    config_errors(installed, &json!({}), config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(schema: Value) -> Installed {
        let m = json!({ "name": "fixture", "version": "0.1.0", "apiVersion": "1", "entry": "index.js",
            "scope": "installation", "priority": 500, "configSchema": schema });
        Installed {
            name: "fixture".into(),
            dir: std::path::PathBuf::from("modules/fixture"),
            manifest: parse_manifest(&m.to_string()),
        }
    }

    #[test]
    fn config_errors_check_changed_sections_without_enabled() {
        let closed = json!({ "type": "object", "additionalProperties": false,
            "properties": { "crashAfterMs": { "type": "integer", "minimum": 0 } } });
        let mods = [fixture(closed)];
        let cfg = |v: Value| json!({ "modules": { "fixture": v } });
        let none = json!({ "modules": {} });
        assert!(config_errors(&mods, &none, &cfg(json!({ "crashAfterMs": 5 }))).is_empty());
        // `enabled` is stripped, so a closed configSchema still accepts it.
        assert!(config_errors(&mods, &none, &cfg(json!({ "enabled": false }))).is_empty());
        let errs = config_errors(&mods, &none, &cfg(json!({ "crashAfterMs": -1 })));
        assert_eq!(errs.len(), 1, "{errs:?}");
        assert!(
            errs[0].starts_with("modules.fixture.crashAfterMs: "),
            "{errs:?}"
        );
        // An unchanged section is not checked again (a module installed later cannot block unrelated sets).
        let bad = cfg(json!({ "crashAfterMs": -1 }));
        assert!(config_errors(&mods, &bad, &bad).is_empty());
        // I1: flipping only `enabled` over a section that is already invalid is not validated again.
        let off = cfg(json!({ "crashAfterMs": -1, "enabled": false }));
        assert!(config_errors(&mods, &bad, &off).is_empty());
        assert!(config_errors(&mods, &off, &bad).is_empty());
        // …but changing anything else in it is.
        let other = cfg(json!({ "crashAfterMs": -2, "enabled": false }));
        assert_eq!(config_errors(&mods, &off, &other).len(), 1);
        // M7: the current configuration is checked whole.
        assert_eq!(current_config_errors(&mods, &off).len(), 1);
        // Not installed: nothing to check against.
        assert!(config_errors(&[], &none, &bad).is_empty());
    }
}
