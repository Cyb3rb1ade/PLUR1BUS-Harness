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
/// start order, and an unsupported `apiVersion`.
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
        let Some(schema) = &m.config_schema else {
            continue;
        };
        let section = &after["modules"][&i.name];
        if section.is_null() || *section == before["modules"][&i.name] {
            continue;
        }
        let mut value = section.clone();
        if let Some(o) = value.as_object_mut() {
            o.remove("enabled");
        }
        match jsonschema::options().build(schema) {
            Err(e) => errors.push(format!(
                "modules.{}: the module's configSchema is not a valid schema: {e}",
                i.name
            )),
            Ok(v) => errors.extend(v.iter_errors(&value).map(|e| {
                let path = e.instance_path.to_string().replace('/', ".");
                format!("modules.{}{path}: {e}", i.name)
            })),
        }
    }
    errors
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
        // Not installed: nothing to check against.
        assert!(config_errors(&[], &none, &bad).is_empty());
    }
}
