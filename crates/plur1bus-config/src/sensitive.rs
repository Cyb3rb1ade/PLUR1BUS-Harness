//! Schema-owned public projection and endpoint credential extraction. No configuration is modified in place.
use super::references::Matcher;
use serde_json::Value;
use std::collections::BTreeSet;

const MASK: &str = "••••";
static EMPTY_SCHEMA: Value = Value::Null;

#[derive(Clone, Copy, Default)]
struct Flags {
    sensitive: bool,
    url_credentials: bool,
}

pub(super) fn field<'a>(schema: &'a Value, name: &str) -> Option<&'a Value> {
    schema
        .get("x-value-schema")
        .and_then(|metadata| metadata.get(name))
        .or_else(|| schema.get(name))
}

fn object_schema(value: Option<&Value>) -> &Value {
    value
        .filter(|node| node.is_object())
        .unwrap_or(&EMPTY_SCHEMA)
}

fn property<'a>(schema: &'a Value, name: &str) -> &'a Value {
    schema
        .get("x-value-schema")
        .and_then(|metadata| metadata.get("properties"))
        .and_then(|properties| properties.get(name))
        .or_else(|| {
            schema
                .get("properties")
                .and_then(|properties| properties.get(name))
        })
        .unwrap_or_else(|| {
            if field(schema, "type").and_then(Value::as_str) == Some("array")
                && !name.is_empty()
                && name.bytes().all(|byte| byte.is_ascii_digit())
            {
                item_schema(schema)
            } else {
                object_schema(field(schema, "additionalProperties"))
            }
        })
}

fn homogeneous_map(schema: &Value) -> bool {
    field(schema, "type").and_then(Value::as_str) == Some("object")
        && schema
            .get("properties")
            .and_then(Value::as_object)
            .is_none_or(|properties| properties.is_empty())
        && schema
            .get("x-value-schema")
            .and_then(|metadata| metadata.get("properties"))
            .and_then(Value::as_object)
            .is_none_or(|properties| properties.is_empty())
}

fn item_schema(schema: &Value) -> &Value {
    object_schema(field(schema, "items").or_else(|| {
        homogeneous_map(schema)
            .then(|| field(schema, "additionalProperties"))
            .flatten()
    }))
}

fn annotated(schema: &Value, inherited: Flags) -> Flags {
    let marked = |name: &str| field(schema, name).and_then(Value::as_bool) == Some(true);
    Flags {
        sensitive: inherited.sensitive || marked("x-sensitive"),
        url_credentials: inherited.url_credentials || marked("x-url-credentials"),
    }
}

fn value_flags(schema: &Value, inherited: Flags) -> Flags {
    let flags = annotated(schema, inherited);
    if field(schema, "type").and_then(Value::as_str) == Some("array") || homogeneous_map(schema) {
        annotated(item_schema(schema), flags)
    } else {
        flags
    }
}

fn project<'a>(
    value: &Value,
    schema: &'a Value,
    inherited: Flags,
    references: &mut Matcher<'a>,
) -> Value {
    let mut flags = value_flags(schema, inherited);
    if !flags.url_credentials {
        if references.matches(value, schema) {
            return value.clone();
        }
        flags.sensitive |= Matcher::declared(schema);
    }
    match value {
        Value::String(text) if flags.sensitive && !text.is_empty() => Value::String(MASK.into()),
        Value::Number(_) if flags.sensitive => Value::from(0),
        Value::Bool(_) if flags.sensitive => Value::Bool(false),
        Value::String(text) if flags.url_credentials => Value::String(mask_url_credentials(text)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| project(item, item_schema(schema), flags, references))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(name, child)| {
                    (
                        name.clone(),
                        project(child, property(schema, name), flags, references),
                    )
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

/// A public configuration copy retaining JSON types, unknown members and public endpoint host/path material.
pub fn redact_config(value: &Value) -> Value {
    redact_with_schema(value, super::schema())
}

/// Apply an explicit configuration schema, for example an installed module's own declarations.
pub fn redact_with_schema(value: &Value, schema: &Value) -> Value {
    project(value, schema, Flags::default(), &mut Matcher::new(schema))
}

/// JSON pointers to complete safe references, for downstream schema-aware output; targets are never read.
pub fn reference_paths_with_schema(value: &Value, schema: &Value) -> Vec<String> {
    fn visit<'a>(
        value: &Value,
        schema: &'a Value,
        path: &str,
        inherited: Flags,
        matcher: &mut Matcher<'a>,
        out: &mut Vec<String>,
    ) {
        let flags = value_flags(schema, inherited);
        if !flags.url_credentials && matcher.matches(value, schema) {
            out.push(path.to_owned());
            return;
        }
        match value {
            Value::Object(map) => {
                for (name, child) in map {
                    let path = format!("{path}/{}", name.replace('~', "~0").replace('/', "~1"));
                    visit(child, property(schema, name), &path, flags, matcher, out);
                }
            }
            Value::Array(items) => {
                for (index, child) in items.iter().enumerate() {
                    visit(
                        child,
                        item_schema(schema),
                        &format!("{path}/{index}"),
                        flags,
                        matcher,
                        out,
                    );
                }
            }
            _ => {}
        }
    }
    let mut paths = Vec::new();
    visit(
        value,
        schema,
        "",
        Flags::default(),
        &mut Matcher::new(schema),
        &mut paths,
    );
    paths
}

fn normalized_url(value: &str) -> String {
    value
        .trim_matches(|c: char| c <= '\u{20}')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect()
}

/// Userinfo bounds in normalized input, without mistaking special-scheme backslash paths for credentials.
fn userinfo_range(value: &str) -> Option<(usize, usize)> {
    let bytes = value.as_bytes();
    let colon = value.find(':').filter(|&at| {
        at > 0
            && bytes[0].is_ascii_alphabetic()
            && bytes[1..at]
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
    });
    let scheme = colon.map(|at| value[..at].to_ascii_lowercase());
    let special = scheme
        .as_deref()
        .is_none_or(|scheme| matches!(scheme, "http" | "https" | "ftp" | "ws" | "wss"));
    let slash = |b: &u8| matches!(b, b'/' | b'\\');
    if colon.is_none() && !(bytes.first().is_some_and(slash) && bytes.get(1).is_some_and(slash)) {
        return None;
    }
    let mut start = colon.map_or(0, |at| at + 1);
    if special {
        while bytes.get(start).is_some_and(slash) {
            start += 1;
        }
    } else if value[start..].starts_with("//") {
        start += 2;
    } else {
        return None;
    }
    let backslash_separator = special || scheme.as_deref() == Some("file");
    let end = value[start..]
        .find(|c| matches!(c, '/' | '?' | '#') || (backslash_separator && c == '\\'))
        .map_or(value.len(), |at| start + at);
    let separator = value[start..end].rfind('@')?;
    Some((start, start + separator))
}

/// Hide userinfo and all query values; parameter names, host, path and fragment remain visible.
pub fn mask_url_credentials(value: &str) -> String {
    let normalized = normalized_url(value);
    let output = match userinfo_range(&normalized) {
        Some((start, end)) => format!("{}{MASK}@{}", &normalized[..start], &normalized[end + 1..]),
        None => value.to_string(),
    };
    let Some(query) = output.find('?') else {
        return output;
    };
    let fragment = output.find('#');
    if fragment.is_some_and(|at| at < query) {
        return output;
    }
    let end = fragment.unwrap_or(output.len());
    let parameters = output[query + 1..end]
        .split('&')
        .map(|parameter| match parameter.split_once('=') {
            Some((name, _)) => format!("{name}={MASK}"),
            None => parameter.to_string(),
        })
        .collect::<Vec<_>>()
        .join("&");
    format!("{}{}{}", &output[..query + 1], parameters, &output[end..])
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn decode_component(value: &str, query: bool) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                out.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        out.push(if query && bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn add_part(values: &mut BTreeSet<String>, value: &str, query: bool) {
    if !value.is_empty() {
        values.insert(value.to_string());
        values.insert(decode_component(value, query));
    }
}

fn add_userinfo(values: &mut BTreeSet<String>, value: &str) {
    add_part(values, value, false);
    match value.split_once(':') {
        Some((user, password)) => {
            add_part(values, user, false);
            add_part(values, password, false);
        }
        None => add_part(values, value, false),
    }
}

fn literal_offset(value: &str, normalized_offset: usize) -> usize {
    let mut offset = 0;
    let mut index = 0;
    for byte in value.bytes() {
        if offset >= normalized_offset {
            break;
        }
        if !matches!(byte, b'\t' | b'\n' | b'\r') {
            offset += 1;
        }
        index += 1;
    }
    index
}

fn url_parts(value: &str, values: &mut BTreeSet<String>) {
    let literal = value.trim_matches(|c: char| c <= '\u{20}');
    let normalized = normalized_url(value);
    if let Some((start, end)) = userinfo_range(&normalized) {
        let raw_start = literal_offset(literal, start);
        let mut raw_end = literal_offset(literal, end);
        while literal
            .as_bytes()
            .get(raw_end)
            .is_some_and(|b| matches!(b, b'\t' | b'\n' | b'\r'))
        {
            raw_end += 1;
        }
        add_userinfo(values, &literal[raw_start..raw_end]);
        add_userinfo(values, &normalized[start..end]);
    }
    for text in [value, normalized.as_str()] {
        let Some(query) = text.find('?') else {
            continue;
        };
        let fragment = text.find('#');
        if fragment.is_some_and(|at| at < query) {
            continue;
        }
        for parameter in text[query + 1..fragment.unwrap_or(text.len())].split('&') {
            if let Some((_, value)) = parameter.split_once('=') {
                add_part(values, value, true);
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReferenceValues {
    Include,
    Omit,
}

struct References<'a> {
    values: ReferenceValues,
    matcher: Matcher<'a>,
}

fn collect<'a>(
    value: &Value,
    schema: &'a Value,
    inherited: Flags,
    out: &mut BTreeSet<String>,
    references: &mut References<'a>,
) {
    let mut flags = value_flags(schema, inherited);
    if references.values == ReferenceValues::Omit && !flags.url_credentials {
        if references.matcher.matches(value, schema) {
            return;
        }
        flags.sensitive |= Matcher::declared(schema);
    }
    match value {
        Value::String(text) if flags.sensitive && !text.is_empty() => {
            out.insert(text.clone());
            if references.values == ReferenceValues::Omit && flags.url_credentials {
                url_parts(text, out);
            }
        }
        Value::Number(_) | Value::Bool(_) if flags.sensitive => {
            out.insert(value.to_string());
        }
        Value::String(text) if flags.url_credentials => url_parts(text, out),
        Value::Array(items) => {
            for item in items {
                collect(item, item_schema(schema), flags, out, references);
            }
        }
        Value::Object(map) => {
            for (name, child) in map {
                collect(child, property(schema, name), flags, out, references);
            }
        }
        _ => {}
    }
}

/// All declared sensitive strings, including reference metadata; endpoints contribute only credential components.
pub fn config_secret_values(value: &Value) -> Vec<String> {
    secret_values_with_schema(value, super::schema())
}

/// Declared strings from an explicit schema, including supported module configuration declarations.
pub fn secret_values_with_schema(value: &Value, schema: &Value) -> Vec<String> {
    extract(value, schema, ReferenceValues::Include)
}

/// Literal credentials and endpoint parts for unstructured text; valid declared references are never resolved or registered.
pub fn config_text_secret_values(value: &Value) -> Vec<String> {
    secret_text_values_with_schema(value, super::schema())
}

/// Text-context extraction with per-pass local validator caching; malformed reference forms remain protected as literals.
pub fn secret_text_values_with_schema(value: &Value, schema: &Value) -> Vec<String> {
    extract(value, schema, ReferenceValues::Omit)
}

fn extract(value: &Value, schema: &Value, reference_values: ReferenceValues) -> Vec<String> {
    let mut values = BTreeSet::new();
    let mut references = References {
        values: reference_values,
        matcher: Matcher::new(schema),
    };
    collect(
        value,
        schema,
        Flags::default(),
        &mut values,
        &mut references,
    );
    values.into_iter().collect()
}

/// A bounded read-only notice; it contains a configuration key and guidance, never a configured value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigReferenceWarning {
    /// Dotted configuration key; it never contains the configured value.
    pub key: String,
    /// Fixed guidance suitable for stderr or an existing warning log record.
    pub message: &'static str,
}

const REFERENCE_WARNING_LIMIT: usize = 50;
const REFERENCE_WARNING: &str =
    "Reference looks like a pasted key; use a secret-store reference name.";

/// Read-only warnings for token-shaped inputs in declared reference slots; no backend or target is read.
pub fn config_reference_warnings(value: &Value) -> Vec<ConfigReferenceWarning> {
    reference_warnings_with_schema(value, super::schema())
}

/// Read-only reference warnings for an explicit module schema, with a maximum of 50 key-only notices.
pub fn reference_warnings_with_schema(
    value: &Value,
    schema: &Value,
) -> Vec<ConfigReferenceWarning> {
    fn visit<'a>(
        value: &Value,
        schema: &'a Value,
        key: &str,
        references: &mut Matcher<'a>,
        out: &mut Vec<ConfigReferenceWarning>,
    ) {
        if out.len() >= REFERENCE_WARNING_LIMIT {
            return;
        }
        if references.suspicious(value, schema) {
            out.push(ConfigReferenceWarning {
                key: key.to_owned(),
                message: REFERENCE_WARNING,
            });
            return;
        }
        if references.matches(value, schema) {
            return;
        }
        match value {
            Value::Object(map) => {
                for (name, child) in map {
                    let child_key = if key.is_empty() {
                        name.clone()
                    } else {
                        format!("{key}.{name}")
                    };
                    visit(child, property(schema, name), &child_key, references, out);
                }
            }
            Value::Array(items) => {
                for (index, child) in items.iter().enumerate() {
                    let child_key = if key.is_empty() {
                        index.to_string()
                    } else {
                        format!("{key}.{index}")
                    };
                    visit(child, item_schema(schema), &child_key, references, out);
                }
            }
            _ => {}
        }
    }
    let mut warnings = Vec::new();
    visit(value, schema, "", &mut Matcher::new(schema), &mut warnings);
    warnings
}
