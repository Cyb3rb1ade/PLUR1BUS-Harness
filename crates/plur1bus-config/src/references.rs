//! Reference disclosure safety from canonical schema policy; targets and external schema resources are never read.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

struct NoExternalSchemas;

impl jsonschema::Retrieve for NoExternalSchemas {
    fn retrieve(
        &self,
        _: &jsonschema::Uri<&str>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        Err(std::io::Error::other("external reference metadata is unsupported").into())
    }
}

struct Policy {
    store: jsonschema::Validator,
    environment: jsonschema::Validator,
    prefix: jsonschema::Validator,
    max_name_length: usize,
    entropy_min_length: usize,
    entropy_min_bits: f64,
    hex_min_length: usize,
    hex_min_entropy_bits: f64,
}

fn string_pattern(pattern: &str, full: bool) -> Option<jsonschema::Validator> {
    // JSON Schema's `$` may also match before a final LF; reference names require the complete value to match.
    let pattern = if full {
        format!("^(?:{pattern})(?![\\s\\S])")
    } else {
        pattern.to_owned()
    };
    jsonschema::options()
        .with_retriever(NoExternalSchemas)
        .build(&json!({"type":"string","pattern":pattern}))
        .ok()
}

fn policy() -> Option<&'static Policy> {
    static POLICY: OnceLock<Option<Policy>> = OnceLock::new();
    POLICY
        .get_or_init(|| {
            let node = super::schema().get("x-secret-reference-policy")?;
            let size = |key| usize::try_from(node.get(key)?.as_u64()?).ok();
            let bits = |key| {
                node.get(key)?
                    .as_f64()
                    .filter(|bits| bits.is_finite() && *bits >= 0.0)
            };
            Some(Policy {
                store: string_pattern(node.get("storeNamePattern")?.as_str()?, true)?,
                environment: string_pattern(node.get("envNamePattern")?.as_str()?, true)?,
                prefix: string_pattern(
                    &format!("(?i:{})", node.get("tokenPrefixPattern")?.as_str()?),
                    false,
                )?,
                max_name_length: size("maxNameLength")?,
                entropy_min_length: size("entropyMinLength")?,
                entropy_min_bits: bits("entropyMinBits")?,
                hex_min_length: size("hexMinLength")?,
                hex_min_entropy_bits: bits("hexMinEntropyBits")?,
            })
        })
        .as_ref()
}

fn entropy(value: &str) -> f64 {
    let mut counts = HashMap::new();
    let mut size = 0usize;
    for character in value.chars() {
        *counts.entry(character).or_insert(0usize) += 1;
        size += 1;
    }
    counts
        .values()
        .map(|count| {
            let probability = *count as f64 / size as f64;
            -probability * probability.log2()
        })
        .sum()
}

#[derive(Clone, Copy)]
enum TokenContext {
    Name,
    SourcePath,
}

fn clear_source_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.starts_with(['/', '\\'])
        || ["./", ".\\", "../", "..\\", "~/", "~\\"]
            .iter()
            .any(|prefix| value.starts_with(prefix))
        || (bytes.first().is_some_and(u8::is_ascii_alphabetic)
            && bytes.get(1) == Some(&b':')
            && bytes
                .get(2)
                .is_some_and(|byte| matches!(byte, b'/' | b'\\')))
}

fn token_like(value: &str, policy: &Policy, context: TokenContext) -> bool {
    if policy.prefix.is_valid(&Value::String(value.to_owned())) {
        return true;
    }
    if matches!(context, TokenContext::SourcePath) && clear_source_path(value) {
        return false;
    }
    let size = value.chars().count();
    if size > policy.max_name_length {
        return true;
    }
    let hex = size >= policy.hex_min_length && value.bytes().all(|byte| byte.is_ascii_hexdigit());
    if hex && entropy(value) >= policy.hex_min_entropy_bits {
        return true;
    }
    size >= policy.entropy_min_length && entropy(value) >= policy.entropy_min_bits
}

/// Recognize pasted credential shapes without resolving references or returning the configured value.
pub fn looks_like_pasted_key(value: &Value) -> bool {
    let Some(policy) = policy() else { return false };
    if let Some(text) = value.as_str() {
        return token_like(text, policy, TokenContext::Name);
    }
    let source_path = matches!(
        value.get("source").and_then(Value::as_str),
        Some("file" | "exec")
    );
    value
        .get("provider")
        .and_then(Value::as_str)
        .is_some_and(|text| token_like(text, policy, TokenContext::Name))
        || value.get("id").and_then(Value::as_str).is_some_and(|text| {
            token_like(
                text,
                policy,
                if source_path {
                    TokenContext::SourcePath
                } else {
                    TokenContext::Name
                },
            )
        })
}

fn kind(schema: &Value) -> Option<&str> {
    match schema.get("x-secret-reference-kind") {
        None => Some("store-name"),
        Some(Value::String(kind))
            if matches!(
                kind.as_str(),
                "store-name" | "env-name" | "env-template" | "file-path" | "engine-input"
            ) =>
        {
            Some(kind)
        }
        _ => None,
    }
}

/// Guard an already schema-matched reference using canonical name/token policy; runtime validation remains unchanged.
pub fn reference_safety(value: &Value, reference_schema: &Value) -> bool {
    let (Some(policy), Some(kind)) = (policy(), kind(reference_schema)) else {
        return false;
    };
    let name = |text: &str, pattern: &jsonschema::Validator| {
        pattern.is_valid(&Value::String(text.to_owned()))
            && !token_like(text, policy, TokenContext::Name)
    };
    if let Some(text) = value.as_str() {
        return match kind {
            "file-path" => !text.is_empty() && !token_like(text, policy, TokenContext::SourcePath),
            "env-name" => name(text, &policy.environment),
            "env-template" | "engine-input" => text
                .strip_prefix("${")
                .and_then(|text| text.strip_suffix('}'))
                .is_some_and(|text| name(text, &policy.environment)),
            "store-name" => name(text, &policy.store),
            _ => false,
        };
    }
    if kind != "engine-input" {
        return false;
    }
    let (Some(source), Some(provider), Some(id)) = (
        value.get("source").and_then(Value::as_str),
        value.get("provider").and_then(Value::as_str),
        value.get("id").and_then(Value::as_str),
    ) else {
        return false;
    };
    if !name(provider, &policy.store) {
        return false;
    }
    match source {
        "store" => name(id, &policy.store),
        "env" => name(id, &policy.environment),
        "file" | "exec" => !id.is_empty() && !token_like(id, policy, TokenContext::SourcePath),
        _ => false,
    }
}

#[derive(Clone, Copy, Hash, PartialEq, Eq)]
enum CacheKey<'a> {
    Local(&'a str),
    Direct(*const Value),
}

/// One immutable schema pass; compiled local forms are reused, configured values are never cached.
pub(crate) struct Matcher<'a> {
    root: &'a Value,
    validators: HashMap<CacheKey<'a>, Option<jsonschema::Validator>>,
}

impl<'a> Matcher<'a> {
    pub(crate) fn new(root: &'a Value) -> Self {
        Self {
            root,
            validators: HashMap::new(),
        }
    }

    /// A reference slot stays protected even when its form is malformed; only explicit false disables it.
    pub(crate) fn declared(node: &Value) -> bool {
        super::sensitive::field(node, "x-secret-reference")
            .is_some_and(|metadata| metadata.as_bool() != Some(false))
    }

    fn definition(&self, node: &'a Value) -> Option<(&'a Value, CacheKey<'a>)> {
        let metadata = super::sensitive::field(node, "x-secret-reference")?;
        if metadata.as_bool() == Some(true) && kind(node).is_some() {
            return Some((node, CacheKey::Direct(node)));
        }
        let reference = metadata
            .as_object()
            .filter(|metadata| metadata.len() == 1)?
            .get("$ref")?
            .as_str()?
            .strip_prefix("#/$defs/")?;
        let local = metadata.get("$ref")?.as_str()?;
        if reference.is_empty() {
            return None;
        }
        let definition = self.root.pointer(&local[1..])?;
        kind(definition)?;
        Some((definition, CacheKey::Local(local)))
    }

    pub(crate) fn matches(&mut self, value: &Value, node: &'a Value) -> bool {
        let Some((definition, key)) = self.definition(node) else {
            return false;
        };
        if !reference_safety(value, definition) {
            return false;
        }
        let root = self.root;
        self.validators
            .entry(key)
            .or_insert_with(|| {
                let mut schema = match key {
                    CacheKey::Local(reference) => json!({"$ref":reference}),
                    CacheKey::Direct(_) => json!({"allOf":[definition]}),
                };
                if let Some(definitions) = root.get("$defs") {
                    schema["$defs"] = definitions.clone();
                }
                jsonschema::options()
                    .with_retriever(NoExternalSchemas)
                    .build(&schema)
                    .ok()
            })
            .as_ref()
            .is_some_and(|validator| validator.is_valid(value))
    }

    pub(crate) fn suspicious(&mut self, value: &Value, node: &'a Value) -> bool {
        self.definition(node).is_some()
            && !self.matches(value, node)
            && looks_like_pasted_key(value)
    }
}
