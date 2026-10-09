//! The install manifest `<home>/manifest.json` (HB9, `schema/install-manifest.schema.json`) and the harness's view of
//! a D78 release manifest (HB10, `schema/release-manifest.schema.json`: an open top level with a closed `native`).
//! Both validators are built on first use (B1).
use crate::paths::Layout;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::sync::OnceLock;

pub const INSTALL_SCHEMA_JSON: &str = include_str!("../../schema/install-manifest.schema.json");
pub const RELEASE_SCHEMA_JSON: &str = include_str!("../../schema/release-manifest.schema.json");
pub const INSTALL_SCHEMA_VERSION: u32 = 1;
pub const CORE_CONTRACT: &str = "1.12.0";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallManifest {
    pub schema_version: u32,
    pub installed_at: u64,
    pub updated_at: u64,
    pub channel: String,
    pub target: String,
    pub binary: Unit,
    pub node: NodeUnit,
    pub core: CoreUnit,
    pub modules: Vec<PackageUnit>,
    pub skills: Vec<PackageUnit>,
    /// The install profile (HM2-R9): `"host"` (supervisor and core only) or `"full"`. Absent in a manifest written
    /// before HM2, which reads as `full` ([`InstallManifest::profile`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

impl InstallManifest {
    /// The recorded install profile; a manifest without one is a `full` install.
    pub fn profile(&self) -> &str {
        self.profile.as_deref().unwrap_or(PROFILE_FULL)
    }
}

/// The install profiles `setup --profile` knows (HM2-R9).
pub const PROFILE_FULL: &str = "full";
pub const PROFILE_HOST: &str = "host";

/// The `plur1bus` binary itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unit {
    pub version: String,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeUnit {
    pub version: String,
    pub archive_sha256: String,
    pub binary_sha256: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoreUnit {
    pub version: String,
    pub contract: String,
    pub rpc: String,
    pub sha256: Option<String>,
    /// `"release"` or `"local"` (`--core-from`).
    pub source: String,
}

/// A module or skill: `source` is `"bundled"`, `"local"` or `"catalog"` (reserved for the extensions ecosystem,
/// ⟂EXT 4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageUnit {
    pub name: String,
    pub version: String,
    pub source: String,
    pub sha256: Option<String>,
}

fn build(schema_json: &str) -> jsonschema::Validator {
    let schema: Value = serde_json::from_str(schema_json).expect("embedded schema is JSON");
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .build(&schema)
        .expect("embedded schema compiles")
}

fn install_validator() -> &'static jsonschema::Validator {
    static V: OnceLock<jsonschema::Validator> = OnceLock::new();
    V.get_or_init(|| build(INSTALL_SCHEMA_JSON))
}

fn release_validator() -> &'static jsonschema::Validator {
    static V: OnceLock<jsonschema::Validator> = OnceLock::new();
    V.get_or_init(|| build(RELEASE_SCHEMA_JSON))
}

fn errors(v: &jsonschema::Validator, doc: &Value) -> Vec<String> {
    v.iter_errors(doc)
        .map(|e| format!("{}: {e}", e.instance_path))
        .collect()
}

/// Validates and parses an install manifest.
pub fn parse_install(raw: &[u8]) -> Result<InstallManifest, Vec<String>> {
    let doc: Value = serde_json::from_slice(raw).map_err(|e| vec![format!("not JSON: {e}")])?;
    let errs = errors(install_validator(), &doc);
    if !errs.is_empty() {
        return Err(errs);
    }
    serde_json::from_value(doc).map_err(|e| vec![e.to_string()])
}

/// `<home>/manifest.json`, schema-validated. `Ok(None)` when there is none (a dev setup that never ran `setup`).
pub fn read(layout: &Layout) -> Result<Option<InstallManifest>, String> {
    let path = layout.install_manifest();
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    parse_install(&raw)
        .map(Some)
        .map_err(|errs| format!("{} is invalid: {}", path.display(), errs.join("; ")))
}

/// Writes `<home>/manifest.json` atomically (`manifest.json.tmp-<pid>`, fsync, rename), private to the user (0600;
/// user and SYSTEM on Windows). Refuses a manifest the schema rejects.
pub fn write(layout: &Layout, m: &InstallManifest) -> io::Result<()> {
    let doc = serde_json::to_value(m).map_err(io::Error::other)?;
    let errs = errors(install_validator(), &doc);
    if !errs.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("install manifest rejected: {}", errs.join("; ")),
        ));
    }
    let mut text = serde_json::to_string_pretty(&doc).map_err(io::Error::other)?;
    text.push('\n');
    let path = layout.install_manifest();
    fs::create_dir_all(&layout.home)?;
    let tmp = layout
        .home
        .join(format!("manifest.json.tmp-{}", std::process::id()));
    let written = (|| {
        let mut f = crate::audit::create_private(&tmp, true)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, &path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written?;
    #[cfg(unix)]
    fs::File::open(&layout.home)?.sync_all()?;
    Ok(())
}

/// The D78 fields the harness reads from any release manifest.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseHead {
    pub version: String,
    pub channel: String,
    pub min_from_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ReleaseAsset {
    pub url: String,
    pub sha256: String,
    /// Download size in bytes, when the release says (additive, optional).
    #[serde(default)]
    pub size: Option<u64>,
}

/// What a release offers add-ons (`native.provides`, additive and optional).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseProvides {
    /// The module API majors the release speaks.
    #[serde(default)]
    pub module_api: Option<Vec<String>>,
    #[serde(default)]
    pub rpc: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ReleaseCore {
    pub version: String,
    pub contract: String,
    pub rpc: String,
    /// Target id → core payload.
    pub payload: BTreeMap<String, ReleaseAsset>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ReleaseNode {
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseModule {
    pub name: String,
    pub version: String,
    pub api_version: String,
}

/// The `native` object of a release manifest (HB10, produced as `release-native.json` by the harness release
/// workflow, HB18).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNative {
    /// Target id → `plur1bus` binary.
    pub binary: BTreeMap<String, ReleaseAsset>,
    pub core: ReleaseCore,
    pub node: ReleaseNode,
    pub modules: Vec<ReleaseModule>,
    pub config_schema_version: u32,
    #[serde(default)]
    pub provides: Option<ReleaseProvides>,
}

/// Validates a release manifest and returns its head and its `native` object (absent in an app-only release).
pub fn parse_release(raw: &[u8]) -> Result<(ReleaseHead, Option<ReleaseNative>), Vec<String>> {
    let doc: Value = serde_json::from_slice(raw).map_err(|e| vec![format!("not JSON: {e}")])?;
    let errs = errors(release_validator(), &doc);
    if !errs.is_empty() {
        return Err(errs);
    }
    let head: ReleaseHead = serde_json::from_value(doc.clone()).map_err(|e| vec![e.to_string()])?;
    let native = match doc.get("native") {
        Some(n) => Some(serde_json::from_value(n.clone()).map_err(|e| vec![e.to_string()])?),
        None => None,
    };
    Ok((head, native))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const RELEASE_FIXTURE: &str = include_str!("../../tests/fixtures/release/stable.json");

    #[test]
    fn core_contract_matches_the_typescript_core_contract() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/core/src/engine.ts");
        let text =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let contract = text
            .lines()
            .find_map(|line| {
                line.strip_prefix("export const CORE_CONTRACT = \"")
                    .and_then(|value| value.strip_suffix("\";"))
            })
            .unwrap_or_else(|| panic!("CORE_CONTRACT not found in {}", path.display()));
        assert_eq!(CORE_CONTRACT, contract);
    }

    fn sample() -> InstallManifest {
        let h = "a".repeat(64);
        InstallManifest {
            schema_version: 1,
            installed_at: 1_790_000_000_000,
            updated_at: 1_790_000_000_001,
            channel: "stable".into(),
            target: "linux-x64".into(),
            binary: Unit {
                version: "0.1.0".into(),
                sha256: None,
            },
            node: NodeUnit {
                version: "24.21.0".into(),
                archive_sha256: h.clone(),
                binary_sha256: h.clone(),
                path: "/tmp/p1b A/Jürgen/runtime/node-24.21.0/bin/node".into(),
            },
            core: CoreUnit {
                version: "0.1.0".into(),
                contract: CORE_CONTRACT.into(),
                rpc: "1.3.0".into(),
                sha256: Some(h.clone()),
                source: "local".into(),
            },
            modules: vec![PackageUnit {
                name: "fixture".into(),
                version: "0.1.0".into(),
                source: "bundled".into(),
                sha256: None,
            }],
            skills: vec![PackageUnit {
                name: "plur1bus-ops".into(),
                version: "1".into(),
                source: "bundled".into(),
                sha256: Some(h),
            }],
            profile: None,
        }
    }

    #[test]
    fn install_manifest_round_trips_and_validates() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().join("home"));
        assert_eq!(read(&layout).unwrap(), None);
        let m = sample();
        write(&layout, &m).unwrap();
        assert_eq!(read(&layout).unwrap(), Some(m.clone()));
        let names: Vec<String> = fs::read_dir(&layout.home)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["manifest.json"], "no temp file is left");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(layout.install_manifest())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let doc: Value =
            serde_json::from_slice(&fs::read(layout.install_manifest()).unwrap()).unwrap();
        assert_eq!(doc["schemaVersion"], 1);
        assert_eq!(doc["node"]["binarySha256"], "a".repeat(64));

        // The schema is closed and typed: an unknown key, a bad hash or a bad source is refused, both on read and
        // on write.
        for (ptr, bad) in [
            ("/extra", json!(1)),
            ("/node/binarySha256", json!("ABC")),
            ("/modules/0/source", json!("npm")),
            ("/target", json!("darwin-x64")),
            ("/schemaVersion", json!(2)),
        ] {
            let mut d = doc.clone();
            if ptr == "/extra" {
                d["extra"] = bad;
            } else {
                *d.pointer_mut(ptr).unwrap() = bad;
            }
            assert!(parse_install(d.to_string().as_bytes()).is_err(), "{ptr}");
        }
        let mut bad = m;
        bad.core.source = "npm".into();
        assert!(write(&layout, &bad).is_err());
        fs::write(layout.install_manifest(), "{").unwrap();
        assert!(read(&layout).is_err());
    }

    #[test]
    fn the_profile_is_optional_reads_as_full_when_absent_and_is_closed() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().join("home"));
        let m = sample();
        assert_eq!(m.profile(), PROFILE_FULL, "absent reads as full");
        let doc = serde_json::to_value(&m).unwrap();
        assert!(doc.get("profile").is_none(), "absent stays absent");
        assert_eq!(
            parse_install(doc.to_string().as_bytes()).unwrap().profile(),
            "full"
        );
        let host = InstallManifest {
            profile: Some(PROFILE_HOST.into()),
            ..m
        };
        write(&layout, &host).unwrap();
        let back = read(&layout).unwrap().unwrap();
        assert_eq!(back.profile(), "host");
        assert_eq!(back, host);
        let mut bad = doc;
        bad["profile"] = json!("minimal");
        assert!(parse_install(bad.to_string().as_bytes()).is_err());
    }

    #[test]
    fn release_fixture_validates_and_unknown_top_level_fields_pass() {
        let (head, native) = parse_release(RELEASE_FIXTURE.as_bytes()).unwrap();
        assert_eq!(head.version, "0.2.0");
        assert_eq!(head.channel, "stable");
        assert_eq!(head.min_from_version, "0.1.0");
        let native = native.expect("the fixture carries `native`");
        for t in super::super::targets::Target::ALL {
            assert!(native.binary.contains_key(t.id()), "binary {}", t.id());
            assert!(
                native.core.payload.contains_key(t.id()),
                "payload {}",
                t.id()
            );
        }
        assert_eq!(native.node.version, "24.21.0");
        assert_eq!(native.modules[0].api_version, "1");
        assert_eq!(native.config_schema_version, 1);

        let mut doc: Value = serde_json::from_str(RELEASE_FIXTURE).unwrap();
        doc["someFutureD78Field"] = json!({ "any": ["thing"] });
        doc.as_object_mut().unwrap().remove("native");
        let (_, native) = parse_release(doc.to_string().as_bytes()).unwrap();
        assert_eq!(native, None, "an app-only release has no native section");

        for key in ["version", "channel", "minFromVersion"] {
            let mut d: Value = serde_json::from_str(RELEASE_FIXTURE).unwrap();
            d.as_object_mut().unwrap().remove(key);
            assert!(
                parse_release(d.to_string().as_bytes()).is_err(),
                "{key} is required"
            );
        }
        assert!(parse_release(b"{").is_err());
    }

    #[test]
    fn the_native_section_is_closed() {
        let base: Value = serde_json::from_str(RELEASE_FIXTURE).unwrap();
        for ptr in [
            "/native",
            "/native/core",
            "/native/node",
            "/native/modules/0",
            "/native/binary/linux-x64",
            "/native/core/payload/win-arm64",
        ] {
            let mut d = base.clone();
            d.pointer_mut(ptr).unwrap()["unexpected"] = json!(true);
            assert!(
                parse_release(d.to_string().as_bytes()).is_err(),
                "{ptr} is closed"
            );
        }
        let mut d = base.clone();
        d["native"]["binary"]["darwin-x64"] = d["native"]["binary"]["linux-x64"].clone();
        assert!(
            parse_release(d.to_string().as_bytes()).is_err(),
            "unknown target"
        );
        let mut d = base;
        d["native"]["core"]["payload"]["linux-x64"]["sha256"] = json!("not-a-hash");
        assert!(
            parse_release(d.to_string().as_bytes()).is_err(),
            "hash pattern"
        );
    }

    #[test]
    fn asset_size_and_native_provides_are_optional_additions() {
        let base: Value = serde_json::from_str(RELEASE_FIXTURE).unwrap();
        // The committed fixture has neither: older manifests keep validating.
        let (_, native) = parse_release(base.to_string().as_bytes()).unwrap();
        let native = native.unwrap();
        assert_eq!(native.provides, None);
        assert_eq!(native.binary["linux-x64"].size, None);

        let mut d = base.clone();
        d["native"]["binary"]["linux-x64"]["size"] = json!(1234);
        d["native"]["provides"] = json!({ "moduleApi": ["1", "2"], "rpc": "1.5.0" });
        let (_, native) = parse_release(d.to_string().as_bytes()).unwrap();
        let native = native.unwrap();
        assert_eq!(native.binary["linux-x64"].size, Some(1234));
        let p = native.provides.unwrap();
        assert_eq!(p.module_api, Some(vec!["1".to_string(), "2".to_string()]));
        assert_eq!(p.rpc.as_deref(), Some("1.5.0"));

        for (ptr, bad) in [
            ("/native/binary/linux-x64/size", json!(-1)),
            ("/native/binary/linux-x64/size", json!("big")),
            ("/native/provides/moduleApi", json!([])),
            ("/native/provides/moduleApi", json!(["01"])),
            ("/native/provides/moduleApi", json!(["1", "1"])),
            ("/native/provides/extra", json!(true)),
        ] {
            let mut d = base.clone();
            d["native"]["provides"] = json!({ "moduleApi": ["1"] });
            d["native"]["binary"]["linux-x64"]["size"] = json!(1);
            let parts: Vec<&str> = ptr.trim_start_matches('/').split('/').collect();
            let (last, dirs) = parts.split_last().unwrap();
            let mut node = &mut d;
            for p in dirs {
                node = node.get_mut(*p).unwrap();
            }
            node[*last] = bad;
            assert!(parse_release(d.to_string().as_bytes()).is_err(), "{ptr}");
        }
    }
}
