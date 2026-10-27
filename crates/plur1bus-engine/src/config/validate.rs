//! Startup configuration validation and normalization at the pinned Node boundary.

use super::Embedded;
use super::{
    child_path, error, get_path, resolved_schema, schema, set_path, ConfigError, EngineConfig,
};
use serde_json::{json, Value};
use std::sync::OnceLock;

const TIMEZONES: &[&[&str]] = &[
    &["timezone"],
    &["styleDirective", "timezone"],
    &["afterthought", "timezone"],
    &["skillMiner", "timezone"],
    &["morningReview", "timezone"],
    &["eveningReview", "timezone"],
    &["obsidianBridge", "morningReview", "timezone"],
    &["obsidianBridge", "eveningReview", "timezone"],
];
const SECRETS: &[&[&str]] = &[
    &["embedding", "apiKey"],
    &["embedding", "fallback", "apiKey"],
    &["reranker", "apiKey"],
    &["merging", "apiKey"],
    &["schicht15", "apiKey"],
    &["skillMiner", "apiKey"],
    &["criticalPush", "apiKey"],
    &["emotion", "t3", "apiKey"],
];

// ICU retains these legacy identifiers beyond the IANA database exposed by chrono-tz.
// Accepted names are recorded against Node 24.21 in the timezone reference fixture.
const ICU_LEGACY_TIMEZONES: &[&str] = &[
    "ACT",
    "AET",
    "AGT",
    "ART",
    "AST",
    "BET",
    "BST",
    "CAT",
    "CNT",
    "CST",
    "CTT",
    "Canada/East-Saskatchewan",
    "EAT",
    "ECT",
    "IET",
    "IST",
    "JST",
    "MIT",
    "NET",
    "NST",
    "PLT",
    "PNT",
    "PRT",
    "PST",
    "SST",
    "SystemV/AST4",
    "SystemV/AST4ADT",
    "SystemV/CST6",
    "SystemV/CST6CDT",
    "SystemV/EST5",
    "SystemV/EST5EDT",
    "SystemV/HST10",
    "SystemV/MST7",
    "SystemV/MST7MDT",
    "SystemV/PST8",
    "SystemV/PST8PDT",
    "SystemV/YST9",
    "SystemV/YST9YDT",
    "US/Pacific-New",
    "VST",
];

/// Validate and compatibility-normalize an engine configuration without adding defaults.
/// The first rejected path follows the pinned Node startup validator.
/// Sibling failures follow the supplied JSON value's iteration order: original text
/// insertion order is unavailable after parsing into a sorted JSON object map.
pub fn validate(raw: &Value) -> Result<EngineConfig, Vec<ConfigError>> {
    let normalized = normalize(raw)?;
    serde_json::from_value(normalized)
        .map_err(|cause| vec![error("", format!("generated configuration type: {cause}"))])
}

/// Return the private normalized JSON value, retaining every explicit setting and review alias.
pub fn normalize(raw: &Value) -> Result<Value, Vec<ConfigError>> {
    normalize_one(raw).map_err(|cause| vec![cause])
}

fn normalize_one(raw: &Value) -> Result<Value, ConfigError> {
    validate_node(raw, schema(), "")?;
    let mut normalized = raw.clone();
    for review in ["morningReview", "eveningReview"] {
        let Some(legacy) = raw.get(review) else {
            continue;
        };
        let nested = get_path(raw, &["obsidianBridge", review]);
        if nested.is_some_and(|nested| nested != legacy) {
            return Err(error(
                &format!("obsidianBridge.{review}"),
                format!("conflicting review aliases at {review} and obsidianBridge.{review}"),
            ));
        }
        if nested.is_none() {
            set_path(&mut normalized, &["obsidianBridge", review], legacy.clone());
        }
    }
    validate_node(&normalized, schema(), "")?;
    validate_secrets(&normalized)?;
    validate_timezones(&normalized)?;
    if let Some(cause) = validator().iter_errors(&normalized).next() {
        return Err(error(
            &pointer_path(&cause.instance_path.to_string(), &normalized),
            cause.to_string(),
        ));
    }
    Ok(normalized)
}

fn validator() -> &'static jsonschema::Validator {
    static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
    VALIDATOR.get_or_init(|| {
        let mut compatible = schema().clone();
        strip_node_ignored_constraints(&mut compatible);
        jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .build(&compatible)
            .embedded("embedded Node-compatible config schema compiles")
    })
}

fn strip_node_ignored_constraints(node: &mut Value) {
    if let Some(object) = node.as_object_mut() {
        // Node ignores propertyNames and counts UTF-16 code units for lengths, checked below.
        for key in ["propertyNames", "minLength", "maxLength"] {
            object.remove(key);
        }
        for child in object.values_mut() {
            strip_node_ignored_constraints(child);
        }
    } else if let Some(array) = node.as_array_mut() {
        for child in array {
            strip_node_ignored_constraints(child);
        }
    }
}

fn validate_node(value: &Value, node: &Value, path: &str) -> Result<(), ConfigError> {
    let node = resolved_schema(node);
    if let Some(kind) = node.get("type") {
        let kinds = kind
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![kind.clone()]);
        if !kinds
            .iter()
            .any(|kind| type_matches(value, kind.as_str().embedded("schema type")))
        {
            return Err(error(
                path,
                format!(
                    "expected {}, received {}",
                    kinds
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" or "),
                    value_type(value)
                ),
            ));
        }
    }
    if node.get("const").is_some_and(|constant| constant != value) {
        return Err(error(path, format!("must equal {}", node["const"])));
    }
    if let Some(choices) = node.get("enum").and_then(Value::as_array) {
        if !choices.contains(value) {
            return Err(error(
                path,
                format!(
                    "must be one of {}",
                    choices
                        .iter()
                        .map(Value::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ));
        }
    }
    if let (Some(value), Some(pattern)) =
        (value.as_str(), node.get("pattern").and_then(Value::as_str))
    {
        if !regex::Regex::new(pattern)
            .embedded("config pattern")
            .is_match(value)
        {
            return Err(error(path, format!("must match pattern {pattern}")));
        }
    }
    validate_bounds(value, &node, path)?;
    if let Some(array) = value.as_array() {
        if let Some(items) = node.get("items") {
            for (index, value) in array.iter().enumerate() {
                validate_node(value, items, &format!("{path}[{index}]"))?;
            }
        }
        return Ok(());
    }
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    for key in object.keys() {
        if ["__proto__", "prototype", "constructor"].contains(&key.as_str()) {
            return Err(error(&child_path(path, key), "unsafe property name"));
        }
    }
    if let Some(required) = node.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            if !object.contains_key(key) {
                return Err(error(&child_path(path, key), "required value is missing"));
            }
        }
    }
    for (key, value) in object {
        let path = child_path(path, key);
        if let Some(child) = node
            .get("properties")
            .and_then(|properties| properties.get(key))
        {
            validate_node(value, child, &path)?;
        } else if node.get("additionalProperties") == Some(&json!(false)) {
            let detail = if path == "captureChunkingJev.apiKey" {
                "unknown property; configure the credential in the secret store"
            } else {
                "unknown property"
            };
            return Err(error(&path, detail));
        } else if let Some(additional) = node
            .get("additionalProperties")
            .filter(|additional| additional.is_object())
        {
            validate_node(value, additional, &path)?;
        }
    }
    Ok(())
}

fn type_matches(value: &Value, kind: &str) -> bool {
    match kind {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "null" => value.is_null(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "number" => value.is_number(),
        "integer" => value.as_f64().is_some_and(|number| number.fract() == 0.0),
        _ => false,
    }
}

fn value_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn validate_bounds(value: &Value, node: &Value, path: &str) -> Result<(), ConfigError> {
    if let Some(value) = value.as_f64() {
        for (key, description, fails) in [
            ("minimum", "at least", f64::lt as fn(&f64, &f64) -> bool),
            ("maximum", "at most", f64::gt),
            ("exclusiveMinimum", "greater than", f64::le),
            ("exclusiveMaximum", "less than", f64::ge),
        ] {
            if let Some(limit) = node.get(key).and_then(Value::as_f64) {
                if fails(&value, &limit) {
                    return Err(error(path, format!("must be {description} {limit}")));
                }
            }
        }
    }
    let count = value
        .as_str()
        .map(|text| (text.encode_utf16().count(), "Length", "characters"))
        .or_else(|| {
            value
                .as_array()
                .map(|array| (array.len(), "Items", "items"))
        });
    if let Some((count, suffix, unit)) = count {
        for (prefix, description, fails) in [
            ("min", "at least", usize::lt as fn(&usize, &usize) -> bool),
            ("max", "at most", usize::gt),
        ] {
            if let Some(limit) = node
                .get(format!("{prefix}{suffix}"))
                .and_then(Value::as_u64)
            {
                if fails(&count, &(limit as usize)) {
                    return Err(error(
                        path,
                        format!("must contain {description} {limit} {unit}"),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_secrets(config: &Value) -> Result<(), ConfigError> {
    static ENV_ID: OnceLock<regex::Regex> = OnceLock::new();
    static EXEC_ID: OnceLock<regex::Regex> = OnceLock::new();
    let env_id = ENV_ID
        .get_or_init(|| regex::Regex::new("^[A-Z][A-Z0-9_]{0,127}$").embedded("env id pattern"));
    let exec_id = EXEC_ID.get_or_init(|| {
        regex::Regex::new("^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$").embedded("exec id pattern")
    });
    for parts in SECRETS {
        let Some(value) = get_path(config, parts).filter(|value| !value.is_string()) else {
            continue;
        };
        let source = value["source"].as_str().embedded("schema validated source");
        let id = value["id"].as_str().embedded("schema validated id");
        let valid = match source {
            "env" | "store" => env_id.is_match(id),
            "exec" => {
                exec_id.is_match(id) && !id.split('/').any(|part| part == "." || part == "..")
            }
            "file" => id == "value" || id.strip_prefix('/').is_some_and(valid_file_pointer),
            _ => false,
        };
        if !valid {
            return Err(error(
                &parts.join("."),
                format!("invalid {source} SecretRef id"),
            ));
        }
    }
    Ok(())
}

fn valid_file_pointer(value: &str) -> bool {
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character == '~' && !matches!(chars.next(), Some('0' | '1')) {
            return false;
        }
    }
    true
}

fn validate_timezones(config: &Value) -> Result<(), ConfigError> {
    for parts in TIMEZONES {
        let Some(value) = get_path(config, parts).and_then(Value::as_str) else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        let path = parts.join(".");
        if value.trim().is_empty() {
            return Err(error(&path, "expected a non-whitespace IANA timezone"));
        }
        // Intl accepts IANA identifiers case-insensitively, plus ISO offset identifiers.
        if !chrono_tz::TZ_VARIANTS
            .iter()
            .any(|timezone| timezone.name().eq_ignore_ascii_case(value))
            && !ICU_LEGACY_TIMEZONES
                .iter()
                .any(|timezone| timezone.eq_ignore_ascii_case(value))
            && !valid_offset(value)
        {
            return Err(error(&path, format!("invalid timezone: {value}")));
        }
    }
    Ok(())
}

fn valid_offset(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !matches!(bytes.first(), Some(b'+' | b'-')) {
        return false;
    }
    let digits = match bytes.len() {
        3 => &bytes[1..],
        5 => &bytes[1..],
        6 if bytes[3] == b':' => &bytes[1..3],
        _ => return false,
    };
    if !digits.iter().all(u8::is_ascii_digit) {
        return false;
    }
    let hour = (bytes[1] - b'0') * 10 + bytes[2] - b'0';
    if hour >= 24 {
        return false;
    }
    let minutes = if bytes.len() == 3 {
        return true;
    } else if bytes.len() == 5 {
        &bytes[3..]
    } else {
        &bytes[4..]
    };
    minutes.iter().all(u8::is_ascii_digit) && (minutes[0] - b'0') * 10 + minutes[1] - b'0' < 60
}

fn pointer_path(pointer: &str, instance: &Value) -> String {
    let mut path = String::new();
    let mut node = instance;
    for escaped in pointer.split('/').skip(1) {
        let part = escaped.replace("~1", "/").replace("~0", "~");
        if node.is_array() {
            path.push_str(&format!("[{part}]"));
            node = &node[part.parse::<usize>().embedded("array pointer")];
        } else {
            path = child_path(&path, &part);
            node = &node[&part];
        }
    }
    path
}
