//! Configuration disclosure policy: embedded declarations plus the installed modules' own schemas.
use crate::{modules, paths::Layout};
use serde_json::Value;
use std::collections::BTreeSet;
use std::{fmt, fs, io};

/// Metadata failures must never turn a public view into an unmasked fallback.
#[derive(Debug)]
pub enum ConfigRedactionError {
    RegistryUnavailable,
    ModulePolicyUnavailable(String),
}

impl fmt::Display for ConfigRedactionError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RegistryUnavailable => out.write_str(
                "configuration sensitivity metadata is unavailable; repair the installed module registry",
            ),
            Self::ModulePolicyUnavailable(name) => write!(
                out,
                "sensitivity metadata for module {name} is unavailable; repair its manifest or use direct property, map and item annotations"
            ),
        }
    }
}

impl std::error::Error for ConfigRedactionError {}

#[derive(Clone, Copy)]
enum Edge {
    Direct,
    Conditional,
    Definition,
}

fn schema_children(node: &Value) -> Vec<(&Value, Edge)> {
    let mut children = Vec::new();
    for (name, edge) in [
        ("properties", Edge::Direct),
        ("patternProperties", Edge::Conditional),
        ("dependentSchemas", Edge::Conditional),
        ("dependencies", Edge::Conditional),
        ("$defs", Edge::Definition),
        ("definitions", Edge::Definition),
    ] {
        if let Some(map) = node.get(name).and_then(Value::as_object) {
            children.extend(map.values().map(|child| (child, edge)));
        }
    }
    for name in ["items", "additionalProperties", "x-value-schema"] {
        if let Some(child) = node.get(name) {
            match child.as_array() {
                Some(items) => children.extend(items.iter().map(|item| (item, Edge::Conditional))),
                None => children.push((child, Edge::Direct)),
            }
        }
    }
    for name in [
        "if",
        "then",
        "else",
        "not",
        "contains",
        "propertyNames",
        "unevaluatedProperties",
        "unevaluatedItems",
        "additionalItems",
    ] {
        if let Some(child) = node.get(name) {
            children.push((child, Edge::Conditional));
        }
    }
    for name in ["allOf", "anyOf", "oneOf", "prefixItems"] {
        if let Some(items) = node.get(name).and_then(Value::as_array) {
            children.extend(items.iter().map(|item| (item, Edge::Conditional)));
        }
    }
    children
}

fn declaration<'a>(node: &'a Value, name: &str) -> Option<&'a Value> {
    node.get("x-value-schema")
        .and_then(|metadata| metadata.get(name))
        .or_else(|| node.get(name))
}

fn has_nested_resource(node: &Value) -> bool {
    schema_children(node)
        .into_iter()
        .any(|(child, _)| child.get("$id").is_some() || has_nested_resource(child))
}

/// Refuse descriptors the direct-member projection cannot interpret, rather than ignoring their privacy markers.
fn direct_policy(
    node: &Value,
    root: &Value,
    direct: bool,
    references: &mut BTreeSet<String>,
) -> bool {
    for name in ["x-sensitive", "x-url-credentials"] {
        if declaration(node, name).is_some_and(|value| !value.is_boolean()) {
            return false;
        }
    }
    let sensitive = declaration(node, "x-sensitive").and_then(Value::as_bool) == Some(true);
    let endpoint = declaration(node, "x-url-credentials").and_then(Value::as_bool) == Some(true);
    if sensitive && endpoint {
        return false;
    }
    if !direct && (sensitive || endpoint) {
        return false;
    }
    if node.get("$dynamicRef").is_some() || node.get("$recursiveRef").is_some() {
        return false;
    }
    if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
        // Root JSON pointers do not resolve nested resources. Refuse those scopes rather than guessing.
        if has_nested_resource(root) {
            return false;
        }
        let target = if reference == "#" {
            Some(root)
        } else {
            reference
                .strip_prefix('#')
                .and_then(|pointer| root.pointer(pointer))
        };
        let Some(target) = target else { return false };
        if references.insert(reference.to_string()) {
            let supported = direct_policy(target, root, false, references);
            references.remove(reference);
            if !supported {
                return false;
            }
        }
    }
    schema_children(node)
        .into_iter()
        .all(|(child, edge)| match edge {
            Edge::Direct => direct_policy(child, root, direct, references),
            Edge::Conditional => direct_policy(child, root, false, references),
            Edge::Definition => true, // Definitions only apply when referenced.
        })
}

fn interpretable(schema: &Value) -> bool {
    // Always inspect references: a target may be stored under an otherwise opaque keyword such as `default`.
    direct_policy(schema, schema, true, &mut BTreeSet::new())
}

/// One immutable policy snapshot used by public output and, later, by the log/bundle registry.
pub struct ConfigDisclosurePolicy {
    modules: Vec<(String, Value)>,
}

impl ConfigDisclosurePolicy {
    pub fn load(layout: &Layout, config: &Value) -> Result<Self, ConfigRedactionError> {
        let Some(configured) = config
            .get("modules")
            .and_then(Value::as_object)
            .filter(|map| !map.is_empty())
        else {
            return Ok(Self {
                modules: Vec::new(),
            });
        };
        let entries = match fs::read_dir(layout.home.join("modules")) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Self {
                    modules: Vec::new(),
                })
            }
            Err(_) => return Err(ConfigRedactionError::RegistryUnavailable),
        };
        let mut policies = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|_| ConfigRedactionError::RegistryUnavailable)?;
            if !entry
                .file_type()
                .map_err(|_| ConfigRedactionError::RegistryUnavailable)?
                .is_dir()
            {
                continue;
            }
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if name.starts_with('.') || name.contains(".tmp-") || !configured.contains_key(&name) {
                continue;
            }
            let unavailable = || ConfigRedactionError::ModulePolicyUnavailable(name.clone());
            let raw =
                fs::read_to_string(entry.path().join("module.json")).map_err(|_| unavailable())?;
            let manifest = modules::parse_manifest(&raw).map_err(|_| unavailable())?;
            if manifest.name != name {
                return Err(unavailable());
            }
            if let Some(schema) = manifest.config_schema {
                if !interpretable(&schema) {
                    return Err(unavailable());
                }
                jsonschema::options()
                    .build(&schema)
                    .map_err(|_| unavailable())?;
                policies.push((name, schema));
            }
        }
        Ok(Self { modules: policies })
    }

    pub fn project(&self, config: &Value) -> Value {
        let mut public = plur1bus_config::redact_config(config);
        for (name, schema) in &self.modules {
            if let Some(value) = public
                .get_mut("modules")
                .and_then(|modules| modules.get_mut(name))
            {
                *value = plur1bus_config::redact_with_schema(value, schema);
            }
        }
        public
    }

    /// Known values for unstructured output. Endpoint hosts and paths are never registered.
    pub fn secret_values(&self, config: &Value) -> Vec<String> {
        let mut values: BTreeSet<String> = plur1bus_config::config_secret_values(config)
            .into_iter()
            .collect();
        for (name, schema) in &self.modules {
            if let Some(value) = config.get("modules").and_then(|modules| modules.get(name)) {
                values.extend(plur1bus_config::secret_values_with_schema(value, schema));
            }
        }
        values.into_iter().collect()
    }
}
