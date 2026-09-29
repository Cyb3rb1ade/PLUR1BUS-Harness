//! `module.json`: parsing against `packages/module-api/schema/manifest.schema.json` (the same file the
//! TypeScript `validateManifest` uses), the module API version policy (B12) and the registry scan.
use crate::paths::Layout;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, fs, io, path::PathBuf, sync::OnceLock};

pub const MODULE_API_VERSION: u32 = 1;
/// `core` and `supervisor` (the supervisor's own units), and the Windows device names (M8), refused on every OS so a
/// manifest is portable.
pub const RESERVED_NAMES: &[&str] = &[
    "core",
    "supervisor",
    "con",
    "prn",
    "aux",
    "nul",
    "com1",
    "com2",
    "com3",
    "com4",
    "com5",
    "com6",
    "com7",
    "com8",
    "com9",
    "lpt1",
    "lpt2",
    "lpt3",
    "lpt4",
    "lpt5",
    "lpt6",
    "lpt7",
    "lpt8",
    "lpt9",
];
pub const CORE_PROVIDES: &[&str] = &["memory", "agent", "jobs", "events"];
pub const SCHEMA_JSON: &str =
    include_str!("../../../../packages/module-api/schema/manifest.schema.json");

/// B12: the current module API major and the one before it (`n` and `n−1`, `n−1 ≥ 1`). `v` must be a
/// canonical decimal (the manifest pattern `^[1-9][0-9]*$`), so `"01"` or `"1.0"` never match.
pub fn api_version_supported(v: &str, current: u32) -> bool {
    let canonical = !v.starts_with('0') && !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit());
    match canonical.then(|| v.parse::<u32>().ok()).flatten() {
        Some(n) => n == current || current.checked_sub(1) == Some(n),
        None => false,
    }
}

/// `MODULE_API_VERSION`, or the test seam `PLUR1BUS_MODULE_API_CURRENT=<n ≥ 1>` when
/// `PLUR1BUS_ALLOW_TEST_INTERNALS=1` (proves two API versions run side by side, B12).
pub fn current_api_version() -> u32 {
    if std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Ok("1") {
        if let Some(n) = std::env::var("PLUR1BUS_MODULE_API_CURRENT")
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .filter(|n| *n >= 1)
        {
            return n;
        }
    }
    MODULE_API_VERSION
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub name: String,
    pub version: String,
    pub api_version: String,
    pub entry: String,
    #[serde(default)]
    pub needs: Vec<String>,
    #[serde(default)]
    pub provides: Vec<String>,
    #[serde(default)]
    pub consumes: Vec<String>,
    #[serde(default)]
    pub implements: Vec<String>,
    #[serde(default)]
    pub extension_points: BTreeMap<String, String>,
    pub scope: String,
    #[serde(default = "default_restart")]
    pub restart: String,
    #[serde(default = "default_lifeline")]
    pub lifeline: bool,
    pub priority: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_schema: Option<Value>,
    /// `module` or `channel` (X1-R22); absent means `module`. A packaged module's `module.json` must agree with its
    /// `.p1x` manifest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}
fn default_restart() -> String {
    "on-failure".into()
}
fn default_lifeline() -> bool {
    true
}

/// Built on first use, so commands that never read a manifest do not pay for it (B1).
fn validator() -> &'static jsonschema::Validator {
    static V: OnceLock<jsonschema::Validator> = OnceLock::new();
    V.get_or_init(|| {
        let schema: Value = serde_json::from_str(SCHEMA_JSON).expect("embedded manifest schema");
        jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .build(&schema)
            .expect("manifest schema compiles")
    })
}

/// Validates against the schema, which also carries the reserved names and the entry-path rules
/// (H3B-R11), then fills the schema defaults through serde.
pub fn parse_manifest(raw: &str) -> Result<Manifest, Vec<String>> {
    let v: Value = serde_json::from_str(raw).map_err(|e| vec![format!("not JSON: {e}")])?;
    let errs: Vec<String> = validator()
        .iter_errors(&v)
        .map(|e| {
            let path = e.instance_path.to_string();
            format!("{} {e}", if path.is_empty() { "/" } else { &path })
        })
        .collect();
    if !errs.is_empty() {
        return Err(errs);
    }
    serde_json::from_value(v).map_err(|e| vec![e.to_string()])
}

#[derive(Debug, Clone)]
pub struct Installed {
    pub name: String,
    pub dir: PathBuf,
    pub manifest: Result<Manifest, Vec<String>>,
}

/// The registry: every directory `modules/<dir>/` (B14), sorted by directory name. A directory with a
/// missing, unreadable or invalid `module.json`, or whose name differs from the manifest's
/// (`name-mismatch`), is listed with its errors. Skipped: plain files, symlinks, hidden directories
/// and install staging directories (`<name>.tmp-<pid>`).
pub fn scan(layout: &Layout) -> Vec<Installed> {
    let Ok(entries) = fs::read_dir(layout.home.join("modules")) else {
        return Vec::new();
    };
    let mut out: Vec<Installed> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            if name.starts_with('.') || name.contains(".tmp-") {
                return None;
            }
            let dir = e.path();
            let manifest = match fs::read_to_string(dir.join("module.json")) {
                Ok(raw) => parse_manifest(&raw).and_then(|m| {
                    if m.name == name {
                        Ok(m)
                    } else {
                        Err(vec![format!(
                            "name-mismatch: directory {name:?}, manifest {:?}",
                            m.name
                        )])
                    }
                }),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    Err(vec!["manifest-missing: no module.json".to_string()])
                }
                Err(e) => Err(vec![format!("manifest-unreadable: {e}")]),
            };
            Some(Installed {
                name,
                dir,
                manifest,
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn manifest_cases_match_the_shared_fixture() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../packages/module-api/fixtures/manifest-cases.json"
        ))
        .unwrap();
        assert!(cases.len() >= 9);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let raw = serde_json::to_string(&case["manifest"]).unwrap();
            let got = parse_manifest(&raw);
            assert_eq!(
                got.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{name}: {got:?}"
            );
        }
    }

    #[test]
    fn defaults_fill_restart_lifeline_and_lists() {
        let m = parse_manifest(
            r#"{"name":"fixture","version":"0.1.0","apiVersion":"1","entry":"index.js","scope":"installation","priority":500}"#,
        )
        .unwrap();
        assert_eq!(m.restart, "on-failure");
        assert!(m.lifeline);
        assert!(m.needs.is_empty() && m.consumes.is_empty() && m.extension_points.is_empty());
        assert!(parse_manifest("{").unwrap_err()[0].starts_with("not JSON"));
    }

    #[test]
    fn reserved_names_match_the_schema() {
        let schema: Value = serde_json::from_str(SCHEMA_JSON).unwrap();
        assert_eq!(
            schema["properties"]["name"]["not"]["enum"],
            serde_json::json!(RESERVED_NAMES)
        );
    }

    #[test]
    fn api_version_policy() {
        assert_eq!(MODULE_API_VERSION, 1);
        assert!(api_version_supported("1", 1));
        assert!(!api_version_supported("2", 1));
        assert!(api_version_supported("1", 2));
        assert!(api_version_supported("2", 2));
        for v in ["0", "3", "01", "x", "", "1.0", "99999999999"] {
            assert!(!api_version_supported(v, 2), "{v}");
        }
    }

    fn write(dir: &std::path::Path, manifest: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("module.json"), manifest).unwrap();
    }
    fn manifest(name: &str) -> String {
        format!(
            r#"{{"name":"{name}","version":"0.1.0","apiVersion":"1","entry":"index.js","scope":"installation","priority":500}}"#
        )
    }

    #[test]
    fn directory_name_must_match() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(tmp.path().to_path_buf());
        assert!(
            scan(&layout).is_empty(),
            "no modules/ directory is an empty registry"
        );
        let root = tmp.path().join("modules");
        write(&root.join("fixture"), &manifest("fixture"));
        write(&root.join("foo"), &manifest("bar"));
        write(&root.join("broken"), "{ nope");
        fs::create_dir_all(root.join("empty")).unwrap();
        write(&root.join("fixture.tmp-42"), &manifest("fixture")); // install staging (B14)
        write(&root.join(".hidden"), &manifest("hidden"));
        fs::write(root.join("stray.json"), "{}").unwrap();

        let got = scan(&layout);
        let names: Vec<&str> = got.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, ["broken", "empty", "fixture", "foo"]);
        assert_eq!(got[2].manifest.as_ref().unwrap().name, "fixture");
        assert_eq!(got[2].dir, root.join("fixture"));
        let mismatch = got[3].manifest.as_ref().unwrap_err();
        assert!(mismatch[0].starts_with("name-mismatch"), "{mismatch:?}");
        assert!(got[0].manifest.as_ref().unwrap_err()[0].starts_with("not JSON"));
        assert!(got[1].manifest.as_ref().unwrap_err()[0].starts_with("manifest-missing"));
    }
}
