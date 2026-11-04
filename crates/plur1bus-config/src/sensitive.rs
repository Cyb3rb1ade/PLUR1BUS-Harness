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
    unknown_public: bool,
    unclassified: bool,
    text_parts: bool,
}

pub(super) fn field<'a>(schema: &'a Value, name: &str) -> Option<&'a Value> {
    let outer = schema.get(name);
    let inner = schema
        .get("x-value-schema")
        .and_then(|metadata| metadata.get(name));
    if matches!(name, "x-sensitive" | "x-url-credentials") {
        if outer.and_then(Value::as_bool) == Some(true) {
            return outer;
        }
        if inner.and_then(Value::as_bool) == Some(true) {
            return inner;
        }
    }
    if name == "x-secret-reference"
        && inner.and_then(Value::as_bool) == Some(false)
        && outer.is_some_and(|value| value.as_bool() != Some(false))
    {
        return outer;
    }
    inner.or(outer)
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
    let modeled = [
        "type",
        "enum",
        "const",
        "x-sensitive",
        "x-url-credentials",
        "x-secret-reference",
    ]
    .iter()
    .any(|name| field(schema, name).is_some());
    let unknown_public = match field(schema, "x-unknown-members").and_then(Value::as_str) {
        Some("public") => true,
        Some("sensitive") => false,
        _ => inherited.unknown_public,
    };
    Flags {
        sensitive: inherited.sensitive || marked("x-sensitive"),
        url_credentials: inherited.url_credentials || marked("x-url-credentials"),
        unclassified: !modeled && !unknown_public,
        unknown_public,
        text_parts: inherited.text_parts
            || field(schema, "x-text-credentials").and_then(Value::as_str) == Some("parts"),
    }
}

fn value_flags(schema: &Value, inherited: Flags) -> Flags {
    let flags = annotated(schema, inherited);
    if field(schema, "type").and_then(Value::as_str) == Some("array") || homogeneous_map(schema) {
        let item = annotated(item_schema(schema), flags);
        Flags {
            sensitive: flags.sensitive || item.sensitive,
            url_credentials: flags.url_credentials || item.url_credentials,
            unclassified: flags.unclassified || item.unclassified,
            ..flags
        }
    } else {
        flags
    }
}

#[derive(Clone, Copy)]
enum Output<'a> {
    Display,
    Archive(&'a str),
}

struct Projection<'a, 's> {
    output: Output<'s>,
    references: Matcher<'a>,
    keys: BTreeSet<String>,
}

impl<'a> Projection<'a, '_> {
    fn project(&mut self, value: &Value, schema: &'a Value, inherited: Flags, key: &str) -> Value {
        let mut flags = value_flags(schema, inherited);
        if !flags.url_credentials {
            if self.references.matches(value, schema) {
                return value.clone();
            }
            flags.sensitive |= Matcher::declared(schema);
        }
        let wrong_string_shape = match field(schema, "type") {
            Some(Value::String(kind)) => kind != "string",
            Some(Value::Array(kinds)) => !kinds.iter().any(|kind| kind == "string"),
            _ => false,
        };
        let secret_string = flags.sensitive || flags.unclassified || wrong_string_shape;
        if let Output::Archive(placeholder) = self.output {
            let collection = flags.text_parts
                || matches!(
                    field(schema, "type").and_then(Value::as_str),
                    Some("array" | "object")
                );
            if flags.sensitive
                && !(collection && (value.is_object() || value.is_array()))
                && !value.is_null()
                && value.as_str() != Some("")
            {
                self.keys.insert(key.to_owned());
                return Value::String(placeholder.into());
            }
        }
        match value {
            Value::String(text) if secret_string && !text.is_empty() => {
                self.keys.insert(key.to_owned());
                Value::String(
                    match self.output {
                        Output::Display => MASK,
                        Output::Archive(mask) => mask,
                    }
                    .into(),
                )
            }
            Value::Number(_) if flags.sensitive => Value::from(0),
            Value::Bool(_) if flags.sensitive => Value::Bool(false),
            Value::String(text) if flags.url_credentials => {
                let mask = match self.output {
                    Output::Display => MASK,
                    Output::Archive(_) => "REDACTED",
                };
                let masked = mask_url_credentials_with(text, mask);
                if masked != *text
                    || (matches!(self.output, Output::Archive(_)) && url_credentials_present(text))
                {
                    self.keys.insert(key.to_owned());
                }
                Value::String(masked)
            }
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .enumerate()
                    .map(|(index, child)| {
                        self.project(
                            child,
                            item_schema(schema),
                            flags,
                            &child_key(key, &index.to_string()),
                        )
                    })
                    .collect(),
            ),
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(name, child)| {
                        (
                            name.clone(),
                            self.project(
                                child,
                                property(schema, name),
                                flags,
                                &child_key(key, name),
                            ),
                        )
                    })
                    .collect(),
            ),
            _ => value.clone(),
        }
    }
}

fn child_key(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}.{name}")
    }
}

/// Invalid reference metadata cannot grant an archive disclosure exemption.
#[derive(Debug, Clone, Copy)]
pub struct DisclosurePolicyError;

impl std::fmt::Display for DisclosurePolicyError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(
            "configuration secret-reference metadata is invalid; repair the installed schema",
        )
    }
}
impl std::error::Error for DisclosurePolicyError {}

/// Archive projection using exactly the display resolver, flags and reference matcher.
/// URL credentials use URI-safe ASCII placeholders; replaced paths identify settings to re-enter.
pub fn placeholder_with_schema(
    value: &Value,
    schema: &Value,
    placeholder: &str,
) -> Result<(Value, Vec<String>), DisclosurePolicyError> {
    fn validate<'a>(node: &'a Value, matcher: &mut Matcher<'a>) -> bool {
        if Matcher::declared(node) && !matcher.valid_metadata(node) {
            return false;
        }
        match node {
            Value::Object(fields) => fields.values().all(|child| validate(child, matcher)),
            Value::Array(items) => items.iter().all(|child| validate(child, matcher)),
            _ => true,
        }
    }
    let resolved = super::resolution::policy_schema(schema, value);
    let schema = resolved.as_ref();
    let mut projection = Projection {
        output: Output::Archive(placeholder),
        references: Matcher::new(schema),
        keys: BTreeSet::new(),
    };
    if !validate(schema, &mut projection.references) {
        return Err(DisclosurePolicyError);
    }
    let value = projection.project(value, schema, Flags::default(), "");
    Ok((value, projection.keys.into_iter().collect()))
}

/// A public configuration copy retaining JSON types, unknown members and public endpoint host/path material.
pub fn redact_config(value: &Value) -> Value {
    redact_with_schema(value, super::schema())
}

/// Apply an explicit configuration schema, for example an installed module's own declarations.
pub fn redact_with_schema(value: &Value, schema: &Value) -> Value {
    let resolved = super::resolution::policy_schema(schema, value);
    let schema = resolved.as_ref();
    Projection {
        output: Output::Display,
        references: Matcher::new(schema),
        keys: BTreeSet::new(),
    }
    .project(value, schema, Flags::default(), "")
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
    let resolved = super::resolution::policy_schema(schema, value);
    let schema = resolved.as_ref();
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

fn scheme_separator(value: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    value.find(':').filter(|&at| {
        at > 0
            && bytes[0].is_ascii_alphabetic()
            && bytes[1..at]
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
    })
}

fn endpoint_prefix(value: &str) -> bool {
    let value = value.trim_matches(|character: char| character <= '\u{20}');
    if value.starts_with("//") || value.starts_with("\\\\") {
        return true;
    }
    scheme_separator(value).is_some_and(|colon| {
        value[colon + 1..].starts_with("//")
            || matches!(
                value[..colon].to_ascii_lowercase().as_str(),
                "http" | "https" | "ftp" | "ws" | "wss"
            )
    })
}

/// Userinfo bounds in normalized input, without mistaking special-scheme backslash paths for credentials.
fn userinfo_range(value: &str) -> Option<(usize, usize)> {
    let bytes = value.as_bytes();
    let colon = scheme_separator(value);
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

fn url_credentials_present(value: &str) -> bool {
    let normalized = normalized_url(value);
    if userinfo_range(&normalized).is_some() {
        return true;
    }
    let (body, fragment) = normalized
        .split_once('#')
        .map_or((normalized.as_str(), None), |(body, fragment)| {
            (body, Some(fragment))
        });
    fragment.is_some_and(|fragment| !fragment.is_empty())
        || body
            .split_once('?')
            .is_some_and(|(_, parameters)| parameters.contains('='))
}

/// Hide userinfo and all query/fragment values, preserving public host and path material.
pub fn mask_url_credentials(value: &str) -> String {
    mask_url_credentials_with(value, MASK)
}

fn mask_parameters(value: &str, mask: &str, bare_private: bool) -> String {
    value
        .split('&')
        .map(|parameter| match parameter.split_once('=') {
            Some((name, _)) => format!("{name}={mask}"),
            None if bare_private && !parameter.is_empty() => mask.to_owned(),
            None => parameter.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn mask_url_credentials_with(value: &str, mask: &str) -> String {
    let normalized = normalized_url(value);
    let output = match userinfo_range(&normalized) {
        Some((start, end)) => format!("{}{mask}@{}", &normalized[..start], &normalized[end + 1..]),
        None => value.to_owned(),
    };
    let (body, fragment) = output
        .split_once('#')
        .map_or((output.as_str(), None), |(body, fragment)| {
            (body, Some(fragment))
        });
    let mut out = match body.split_once('?') {
        Some((prefix, parameters)) => {
            format!("{prefix}?{}", mask_parameters(parameters, mask, false))
        }
        None => body.to_owned(),
    };
    if let Some(fragment) = fragment {
        out.push('#');
        out.push_str(&mask_parameters(fragment, mask, true));
    }
    out
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
    let username = value
        .split_once(':')
        .map_or(value, |(username, _)| username);
    if super::references::looks_like_text_credential(username)
        || super::references::looks_like_text_credential(&decode_component(username, false))
    {
        add_part(values, username, false);
    }
    if let Some((_, password)) = value.split_once(':') {
        add_part(values, password, false);
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
        let (body, fragment) = text
            .split_once('#')
            .map_or((text, None), |(body, fragment)| (body, Some(fragment)));
        for parameters in body
            .split_once('?')
            .map(|(_, query)| query)
            .into_iter()
            .chain(fragment)
        {
            for parameter in parameters
                .strip_prefix('?')
                .unwrap_or(parameters)
                .split('&')
            {
                if let Some((name, value)) = parameter.split_once('=') {
                    if credential_name(&decode_component(name, true))
                        || token_text(&decode_component(value, true))
                    {
                        add_part(values, value, true);
                    }
                } else if token_text(&decode_component(parameter, true)) {
                    add_part(values, parameter, true);
                }
            }
        }
    }
}

fn normalized_name(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut previous_lower = false;
    for character in value.chars() {
        if previous_lower && character.is_ascii_uppercase() {
            normalized.push('_');
        }
        normalized.push(character.to_ascii_lowercase());
        previous_lower = character.is_ascii_lowercase();
    }
    normalized
}

fn source_path_name(value: &str) -> bool {
    let value = normalized_name(value);
    ["file", "path", "dir", "directory", "cwd", "root"]
        .iter()
        .any(|suffix| value.ends_with(suffix))
}

fn credential_name(value: &str) -> bool {
    normalized_name(value).split(['_', '.', '-']).any(|part| {
        matches!(
            part,
            "token"
                | "key"
                | "secret"
                | "password"
                | "passwd"
                | "pwd"
                | "sig"
                | "signature"
                | "auth"
                | "authorization"
                | "credential"
                | "credentials"
                | "apikey"
                | "accesskey"
                | "clientsecret"
                | "code"
                | "verifier"
                | "csrf"
                | "ticket"
                | "sessionkey"
                | "accountkey"
        )
    })
}

fn source_path_text(value: &str) -> bool {
    super::references::clear_source_path(value)
        || (value.contains(['/', '\\'])
            && value
                .split(['/', '\\'])
                .any(|part| part.contains(['.', '_', '-']))
            && !super::references::starts_with_credential_prefix(value))
}

fn token_text(value: &str) -> bool {
    if endpoint_prefix(value) || source_path_text(value) {
        return false;
    }
    super::references::looks_like_text_credential(value)
}

fn assignment_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn text_parts(value: &Value, out: &mut BTreeSet<String>, credential: bool, path: bool) {
    match value {
        Value::String(text) => {
            // URL parts and source paths are handled before a named literal is registered in full.
            if endpoint_prefix(text) {
                url_parts(text, out);
                return;
            }
            if !credential {
                if let Some((name, part)) = text.split_once('=') {
                    if name.starts_with('-')
                        || credential_name(name)
                        || (assignment_name(name) && endpoint_prefix(part))
                    {
                        text_parts(
                            &Value::String(part.to_owned()),
                            out,
                            credential_name(name),
                            path || source_path_name(name),
                        );
                        return;
                    }
                }
            }
            let source = source_path_text(text);
            let token = super::references::looks_like_text_credential(text);
            if (path && (source || !token)) || (!credential && (source || text.starts_with('-'))) {
                return;
            }
            if credential || token {
                add_part(out, text, false);
            }
        }
        Value::Array(items) => {
            let mut next_credential = false;
            let mut next_path = false;
            for item in items {
                let option = item
                    .as_str()
                    .is_some_and(|text| text.starts_with('-') && !text.contains('='));
                text_parts(
                    item,
                    out,
                    credential || (next_credential && !option),
                    path || (next_path && !option),
                );
                next_credential = option && item.as_str().is_some_and(credential_name);
                next_path = option && item.as_str().is_some_and(source_path_name);
            }
        }
        Value::Object(fields) => {
            for (name, child) in fields {
                text_parts(
                    child,
                    out,
                    credential || credential_name(name),
                    path || source_path_name(name),
                );
            }
        }
        _ => {}
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReferenceValues {
    #[cfg(test)]
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
    name: &str,
) {
    let mut flags = value_flags(schema, inherited);
    if references.values == ReferenceValues::Omit && !flags.url_credentials {
        if references.matcher.matches(value, schema) {
            return;
        }
        flags.sensitive |= Matcher::declared(schema);
    }
    if flags.text_parts && references.values == ReferenceValues::Omit {
        text_parts(value, out, false, false);
        return;
    }
    let wrong_string_shape = field(schema, "type")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind != "string");
    if references.values == ReferenceValues::Omit
        && !flags.sensitive
        && (flags.unclassified || wrong_string_shape)
        && value.is_string()
    {
        text_parts(value, out, credential_name(name), source_path_name(name));
        return;
    }
    match value {
        Value::String(text)
            if (flags.sensitive || flags.unclassified || wrong_string_shape)
                && !text.is_empty() =>
        {
            out.insert(text.clone());
            if references.values == ReferenceValues::Omit
                && (flags.url_credentials || endpoint_prefix(text))
            {
                url_parts(text, out);
            }
        }
        Value::Number(_) | Value::Bool(_) if flags.sensitive => {
            out.insert(value.to_string());
        }
        Value::String(text) if flags.url_credentials => url_parts(text, out),
        Value::Array(items) => {
            for item in items {
                collect(item, item_schema(schema), flags, out, references, name);
            }
        }
        Value::Object(map) => {
            for (name, child) in map {
                collect(child, property(schema, name), flags, out, references, name);
            }
        }
        _ => {}
    }
}

/// All declared sensitive strings, including reference metadata; endpoints contribute only credential components.
#[cfg(test)]
pub(crate) fn config_secret_values(value: &Value) -> Vec<String> {
    secret_values_with_schema(value, super::schema())
}

/// Declared strings from an explicit schema, including supported module configuration declarations.
#[cfg(test)]
pub(crate) fn secret_values_with_schema(value: &Value, schema: &Value) -> Vec<String> {
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
    let resolved = super::resolution::policy_schema(schema, value);
    let schema = resolved.as_ref();
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
        "",
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
    let resolved = super::resolution::policy_schema(schema, value);
    let schema = resolved.as_ref();
    let mut warnings = Vec::new();
    visit(value, schema, "", &mut Matcher::new(schema), &mut warnings);
    warnings
}
