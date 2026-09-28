//! The `.p1x` manifest `p1x.json` (spec 2026-09-27 §5.2): its closed JSON Schema, parsing, and the naming rules.
use crate::refusal::{reason, Refusal};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, sync::OnceLock};

/// The manifest schema (draft 2020-12, closed at every level, `x-stability: experimental`).
pub const P1X_SCHEMA_JSON: &str = include_str!("../schema/p1x.schema.json");

/// The manifest is at most this many bytes (§5.1).
pub const MAX_MANIFEST_BYTES: usize = 1 << 20;

/// What an extension is (§5.2).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Skill,
    Module,
    Channel,
    McpServer,
    Bundle,
}

/// One payload file: its SHA-256 (lower-case hex), size, and whether it is executable.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub exec: bool,
}

/// A parsed, schema-valid `p1x.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P1xManifest {
    pub format: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: Kind,
    pub title: BTreeMap<String, String>,
    pub summary: BTreeMap<String, String>,
    pub publisher: Value,
    pub licence: String,
    pub compat: Value,
    pub requires: Value,
    #[serde(default)]
    pub dependencies: Vec<Value>,
    pub capabilities: Value,
    #[serde(default)]
    pub default_enabled: bool,
    pub scripts: Vec<String>,
    pub files: BTreeMap<String, FileEntry>,
    /// `$schema`, `homepage`, `repository`, `notes`, `created`, `remote`, `members`, `upstream`.
    #[serde(flatten)]
    pub rest: serde_json::Map<String, Value>,
}

/// Built on first use, so commands that never read a manifest do not pay for it (B1).
fn validator() -> &'static jsonschema::Validator {
    static V: OnceLock<jsonschema::Validator> = OnceLock::new();
    V.get_or_init(|| {
        let schema: Value = serde_json::from_str(P1X_SCHEMA_JSON).expect("embedded p1x schema");
        jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .build(&schema)
            .expect("p1x schema compiles")
    })
}

/// `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, at most 62 characters: the intersection of the D14 module-name pattern and the
/// Agent Skills `name` rule (§5.2).
pub fn valid_name(n: &str) -> bool {
    if n.is_empty() || n.len() > 62 || !n.as_bytes()[0].is_ascii_lowercase() {
        return false;
    }
    n.split('-').all(|seg| {
        !seg.is_empty()
            && seg
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    })
}

/// `^[a-z][a-z0-9-]{0,31}(\.[a-z0-9-]{1,32})*$` (§5.2).
pub fn valid_publisher(p: &str) -> bool {
    let label_ok = |s: &str| {
        s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    };
    let mut parts = p.split('.');
    let first = parts.next().unwrap_or("");
    let first_ok = !first.is_empty()
        && first.len() <= 32
        && first.as_bytes()[0].is_ascii_lowercase()
        && label_ok(first);
    first_ok && parts.all(|s| !s.is_empty() && s.len() <= 32 && label_ok(s))
}

fn invalid(detail: impl Into<String>) -> Refusal {
    Refusal::invalid(reason::PACKAGE_INVALID, detail)
}

/// Parses and validates `p1x.json`. `reserved` are the names no package may take (the D14 reserved module names).
///
/// Refusals: a manifest over 1 MiB is `download-too-large` (a size cap, X1-R4); a BOM, non-UTF-8 bytes, invalid JSON,
/// any schema error (joined in `detail`), an `id` whose name part differs from `name` or whose publisher differs from
/// `publisher.id` are `package-invalid`; a `name` in `reserved` is `reserved-name`.
pub fn parse_manifest(raw: &[u8], reserved: &[&str]) -> Result<P1xManifest, Refusal> {
    if raw.len() > MAX_MANIFEST_BYTES {
        return Err(Refusal::invalid(
            reason::TOO_LARGE,
            format!(
                "p1x.json is {} bytes; the limit is {MAX_MANIFEST_BYTES}",
                raw.len()
            ),
        ));
    }
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Err(invalid("p1x.json starts with a byte-order mark"));
    }
    let text =
        std::str::from_utf8(raw).map_err(|e| invalid(format!("p1x.json is not UTF-8: {e}")))?;
    let v: Value =
        serde_json::from_str(text).map_err(|e| invalid(format!("p1x.json is not JSON: {e}")))?;
    let errs: Vec<String> = validator()
        .iter_errors(&v)
        .map(|e| {
            let path = e.instance_path.to_string();
            format!("{} {e}", if path.is_empty() { "/" } else { &path })
        })
        .collect();
    if !errs.is_empty() {
        return Err(invalid(errs.join("; ")));
    }
    let m: P1xManifest = serde_json::from_value(v).map_err(|e| invalid(e.to_string()))?;
    if reserved.contains(&m.name.as_str()) {
        return Err(Refusal::invalid(
            reason::RESERVED,
            format!("the name {:?} is reserved", m.name),
        ));
    }
    semver::Version::parse(&m.version)
        .map_err(|e| invalid(format!("version {:?} is not semver: {e}", m.version)))?;
    let (id_publisher, id_name) = m.id.split_once('/').unwrap_or(("", &m.id));
    if id_name != m.name {
        return Err(invalid(format!(
            "id {:?} names {id_name:?}, but name is {:?}",
            m.id, m.name
        )));
    }
    let publisher = m.publisher.get("id").and_then(Value::as_str).unwrap_or("");
    if !valid_publisher(publisher) || !valid_name(&m.name) {
        return Err(invalid("publisher.id or name breaks the naming rules"));
    }
    if id_publisher != publisher {
        return Err(invalid(format!(
            "id {:?} has publisher {id_publisher:?}, but publisher.id is {publisher:?}",
            m.id
        )));
    }
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_schema_is_closed_and_compiles() {
        let v: Value = serde_json::from_str(P1X_SCHEMA_JSON).unwrap();
        assert_eq!(
            v["$id"],
            "https://plur1bus.app/schema/p1x/1/p1x.schema.json"
        );
        assert_eq!(v["x-stability"], "experimental");
        assert_eq!(v["additionalProperties"], false);
        let _ = validator();
    }

    #[test]
    fn hand_written_rules_agree_with_the_schema_patterns() {
        let v: Value = serde_json::from_str(P1X_SCHEMA_JSON).unwrap();
        let name = regex_of(&v["properties"]["name"]["pattern"]);
        let publisher = regex_of(&v["properties"]["publisher"]["properties"]["id"]["pattern"]);
        assert_eq!(name, r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$");
        assert_eq!(publisher, r"^[a-z][a-z0-9-]{0,31}(\.[a-z0-9-]{1,32})*$");
        assert!(valid_name("a-b") && !valid_name("a--b"));
    }

    fn regex_of(v: &Value) -> String {
        v.as_str().unwrap().to_string()
    }
}
