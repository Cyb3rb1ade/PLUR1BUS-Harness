//! Pure MCPB setup validation and variable expansion; secret values never enter normalized output (M-A9).
use super::{invalid, McpbContext, McpbManifest};
use crate::refusal::{reason, Refusal};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const MAX_EXPANDED_BYTES: usize = 1 << 20;

pub(super) fn declarations(source: &Value) -> BTreeMap<String, Value> {
    source["user_config"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key.starts_with(|c: char| c.is_ascii_alphabetic())
        && key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

fn valid_scalar(value: &Value, kind: &str) -> bool {
    match kind {
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "string" | "file" | "directory" => value.as_str().is_some_and(|s| !s.contains('\0')),
        _ => false,
    }
}

fn validate_value(key: &str, declaration: &Value, value: &Value) -> Result<(), Refusal> {
    let kind = declaration["type"].as_str().unwrap_or("");
    let multiple = declaration["multiple"].as_bool().unwrap_or(false);
    let values: Vec<&Value> = if multiple {
        value
            .as_array()
            .ok_or_else(|| invalid(format!("MCPB user_config.{key} requires multiple values")))?
            .iter()
            .collect()
    } else {
        vec![value]
    };
    if !values.iter().all(|v| valid_scalar(v, kind)) {
        return Err(invalid(format!(
            "MCPB user_config.{key} value does not match declared type"
        )));
    }
    if kind == "number"
        && values.iter().any(|v| {
            let number = v.as_f64().unwrap_or(f64::NAN);
            !number.is_finite()
                || declaration["min"].as_f64().is_some_and(|min| number < min)
                || declaration["max"].as_f64().is_some_and(|max| number > max)
        })
    {
        return Err(invalid(format!(
            "MCPB user_config.{key} value exceeds declared bounds"
        )));
    }
    Ok(())
}

pub(super) fn validate_declarations(source: &Value) -> Result<(), Refusal> {
    for (key, declaration) in declarations(source) {
        if let (Some(min), Some(max)) = (declaration["min"].as_f64(), declaration["max"].as_f64()) {
            if min > max {
                return Err(invalid(format!("MCPB user_config.{key} min exceeds max")));
            }
        }
        if (declaration.get("min").is_some() || declaration.get("max").is_some())
            && declaration["type"] != "number"
        {
            return Err(invalid(format!(
                "MCPB user_config.{key} bounds require type number"
            )));
        }
        if let Some(default) = declaration.get("default") {
            validate_value(&key, &declaration, default)?;
        }
    }
    Ok(())
}

fn values(source: &Value, context: &McpbContext) -> Result<BTreeMap<String, Value>, Refusal> {
    let declarations = declarations(source);
    for (key, value) in &context.user_config {
        let declaration = declarations
            .get(key)
            .ok_or_else(|| invalid("MCPB context contains undeclared user_config"))?;
        if declaration["sensitive"] == true {
            return Err(invalid(format!(
                "MCPB user_config.{key} is sensitive; provide it through the secret store"
            )));
        }
        validate_value(key, declaration, value)?;
    }
    Ok(declarations
        .into_iter()
        .filter(|(_, d)| d["sensitive"] != true)
        .filter_map(|(key, d)| {
            context
                .user_config
                .get(&key)
                .or_else(|| d.get("default"))
                .cloned()
                .map(|v| (key, v))
        })
        .collect())
}

fn as_string(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn variables(source: &Value, context: &McpbContext) -> Result<BTreeMap<String, Value>, Refusal> {
    if !matches!(context.platform.as_str(), "linux" | "darwin" | "win32") {
        return Err(invalid(
            "MCPB context requires linux, darwin or win32 platform",
        ));
    }
    if !matches!(context.path_separator.as_str(), "/" | "\\") || context.extension_dir.is_empty() {
        return Err(invalid(
            "MCPB context requires an installed directory and native path separator",
        ));
    }
    if context.system_dirs.keys().any(|key| {
        key.is_empty()
            || !key
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
    }) {
        return Err(invalid("MCPB system directory variables require uppercase identifiers and cannot override reserved variables"));
    }
    let mut variables: BTreeMap<String, Value> = context
        .system_dirs
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    variables.insert(
        "__dirname".into(),
        Value::String(context.extension_dir.clone()),
    );
    variables.insert(
        "pathSeparator".into(),
        Value::String(context.path_separator.clone()),
    );
    variables.insert("/".into(), Value::String(context.path_separator.clone()));
    for (key, value) in values(source, context)? {
        let value = match value {
            Value::Array(items) => {
                Value::Array(items.iter().map(|v| Value::String(as_string(v))).collect())
            }
            scalar => Value::String(as_string(&scalar)),
        };
        variables.insert(format!("user_config.{key}"), value);
    }
    Ok(variables)
}

fn replacement<'a>(
    key: &str,
    variables: &'a BTreeMap<String, Value>,
    declarations: &BTreeMap<String, Value>,
) -> Result<Option<&'a Value>, Refusal> {
    if let Some(value) = variables.get(key) {
        return Ok(Some(value));
    }
    if key
        .strip_prefix("user_config.")
        .is_some_and(|k| declarations.contains_key(k))
    {
        return Ok(None);
    }
    Err(invalid("MCPB configuration references an unknown variable"))
}

fn expand_string(
    text: &str,
    variables: &BTreeMap<String, Value>,
    declarations: &BTreeMap<String, Value>,
) -> Result<String, Refusal> {
    let mut result = String::new();
    let mut remainder = text;
    while let Some(start) = remainder.find("${") {
        result.push_str(&remainder[..start]);
        let variable = &remainder[start + 2..];
        let end = variable
            .find('}')
            .ok_or_else(|| invalid("MCPB configuration contains an unterminated variable"))?;
        match replacement(&variable[..end], variables, declarations)? {
            Some(Value::String(value)) => result.push_str(value),
            Some(_) => {
                return Err(invalid(
                    "MCPB multiple user_config values must occupy a complete argument",
                ))
            }
            None => result.push_str(&remainder[start..start + 2 + end + 1]),
        }
        if result.len() > MAX_EXPANDED_BYTES {
            return Err(Refusal::invalid(
                reason::TOO_LARGE,
                "MCPB variable expansion exceeds 1 MiB",
            ));
        }
        remainder = &variable[end + 1..];
    }
    result.push_str(remainder);
    if result.len() > MAX_EXPANDED_BYTES {
        return Err(Refusal::invalid(
            reason::TOO_LARGE,
            "MCPB variable expansion exceeds 1 MiB",
        ));
    }
    Ok(result)
}

fn expand_args(
    args: &[Value],
    variables: &BTreeMap<String, Value>,
    declarations: &BTreeMap<String, Value>,
) -> Result<Value, Refusal> {
    let mut result = Vec::new();
    let mut bytes = 0usize;
    for arg in args {
        let text = arg
            .as_str()
            .ok_or_else(|| invalid("MCPB args must be strings"))?;
        let variable = text
            .strip_prefix("${user_config.")
            .and_then(|s| s.strip_suffix('}'));
        if let Some(Value::Array(values)) =
            variable.and_then(|k| variables.get(&format!("user_config.{k}")))
        {
            result.extend_from_slice(values);
            bytes = bytes.saturating_add(
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::len)
                    .sum::<usize>(),
            );
        } else {
            let value = expand_string(text, variables, declarations)?;
            bytes = bytes.saturating_add(value.len());
            result.push(Value::String(value));
        }
        if bytes > MAX_EXPANDED_BYTES {
            return Err(Refusal::invalid(
                reason::TOO_LARGE,
                "MCPB arguments exceed 1 MiB",
            ));
        }
    }
    Ok(Value::Array(result))
}

pub(super) fn resolve(manifest: &McpbManifest, context: &McpbContext) -> Result<Value, Refusal> {
    let source = &manifest.source;
    let declarations = declarations(source);
    let variables = variables(source, context)?;
    let base = &source["server"]["mcp_config"];
    let mut config = base
        .as_object()
        .ok_or_else(|| invalid("MCPB mcp_config missing"))?
        .clone();
    if let Some(overrides) = base["platform_overrides"][&context.platform].as_object() {
        // Upstream replaces command, args and env independently; env is a replacement, not a merge.
        for (key, value) in overrides {
            config.insert(key.clone(), value.clone());
        }
    }
    config.remove("platform_overrides");
    for (key, d) in &declarations {
        if d["sensitive"] == true {
            let placeholder = format!("${{user_config.{key}}}");
            if config
                .get("command")
                .is_some_and(|v| references(v, &placeholder))
                || config
                    .get("args")
                    .is_some_and(|v| references(v, &placeholder))
            {
                return Err(invalid("MCPB sensitive user_config in command or arguments is unsupported; secrets require environment slots"));
            }
        }
    }
    let mut resolved = Map::new();
    for (key, value) in config {
        let value = match key.as_str() {
            "command" => Value::String(expand_string(
                value.as_str().unwrap_or(""),
                &variables,
                &declarations,
            )?),
            "args" => expand_args(
                value
                    .as_array()
                    .ok_or_else(|| invalid("MCPB args must be an array"))?,
                &variables,
                &declarations,
            )?,
            "env" => expand_env(&value, &variables, &declarations)?,
            _ => return Err(invalid("MCPB mcp_config contains an unsupported field")),
        };
        resolved.insert(key, value);
    }
    let value = Value::Object(resolved);
    if serde_json::to_vec(&value)
        .map_err(|_| invalid("MCPB configuration serialization failed"))?
        .len()
        > MAX_EXPANDED_BYTES
    {
        return Err(Refusal::invalid(
            reason::TOO_LARGE,
            "MCPB expanded configuration exceeds 1 MiB",
        ));
    }
    Ok(value)
}

fn expand_env(
    env: &Value,
    variables: &BTreeMap<String, Value>,
    declarations: &BTreeMap<String, Value>,
) -> Result<Value, Refusal> {
    let mut result = Map::new();
    let mut bytes = 0usize;
    for (key, value) in env
        .as_object()
        .ok_or_else(|| invalid("MCPB env must be an object"))?
    {
        let expanded = expand_string(value.as_str().unwrap_or(""), variables, declarations)?;
        bytes = bytes
            .saturating_add(key.len())
            .saturating_add(expanded.len());
        if bytes > MAX_EXPANDED_BYTES {
            return Err(Refusal::invalid(
                reason::TOO_LARGE,
                "MCPB expanded environment exceeds 1 MiB",
            ));
        }
        result.insert(key.clone(), Value::String(expanded));
    }
    Ok(Value::Object(result))
}

fn references(value: &Value, placeholder: &str) -> bool {
    match value {
        Value::String(text) => text.contains(placeholder),
        Value::Array(items) => items.iter().any(|v| references(v, placeholder)),
        Value::Object(fields) => fields.values().any(|v| references(v, placeholder)),
        _ => false,
    }
}

pub(super) fn needs_setup(source: &Value, context: &McpbContext, resolved: &Value) -> Vec<String> {
    declarations(source)
        .into_iter()
        .filter(|(key, d)| {
            if d["required"] != true && !references(resolved, &format!("${{user_config.{key}}}")) {
                return false;
            }
            if d["sensitive"] == true {
                return true;
            }
            let value = context.user_config.get(key).or_else(|| d.get("default"));
            value.is_none_or(|v| {
                v.as_str() == Some("")
                    || v.as_array()
                        .is_some_and(|a| a.is_empty() || a.iter().any(|v| v.as_str() == Some("")))
            })
        })
        .map(|(key, _)| key)
        .collect()
}

pub(super) fn secret_slots(source: &Value) -> BTreeMap<String, String> {
    let keys: Vec<String> = declarations(source)
        .into_iter()
        .filter(|(_, d)| d["sensitive"] == true)
        .map(|(key, _)| key)
        .collect();
    // Reserve identity mappings first so an arbitrary source key cannot steal a valid existing slot.
    let mut used: BTreeSet<String> = keys.iter().filter(|key| valid_key(key)).cloned().collect();
    keys.into_iter()
        .map(|key| {
            if valid_key(&key) {
                return (key.clone(), key);
            }
            let slug: String = key
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() {
                        c.to_ascii_lowercase()
                    } else {
                        '_'
                    }
                })
                .take(36)
                .collect();
            let hash = crate::zipaudit::hex(&Sha256::digest(key.as_bytes()));
            let base = format!("mcpb_{slug}_{}", &hash[..16]);
            let mut slot = base.clone();
            let mut suffix = 0usize;
            while !used.insert(slot.clone()) {
                suffix += 1;
                slot = format!("{base}_{suffix}");
            }
            (key, slot)
        })
        .collect()
}

pub(super) fn sanitize(source: &mut Value, warnings: &mut Vec<String>) -> BTreeMap<String, Value> {
    if let Some(declarations) = source.get_mut("user_config").and_then(Value::as_object_mut) {
        for (key, declaration) in declarations {
            if declaration["sensitive"] == true
                && declaration
                    .as_object_mut()
                    .is_some_and(|d| d.remove("default").is_some())
            {
                warnings.push(format!(
                    "MCPB sensitive default for {key} removed; configure its secret slot"
                ));
            }
        }
    }
    declarations(source)
        .into_iter()
        .filter(|(_, d)| d["sensitive"] != true)
        .collect()
}
