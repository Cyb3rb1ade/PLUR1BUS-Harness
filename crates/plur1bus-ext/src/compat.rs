//! Compatibility of a manifest with this host (spec §5.2 `compat`, §8.4 step 5; X1-R20).
use crate::manifest::{Kind, P1xManifest};
use crate::refusal::{reason, Refusal};
use semver::{Version, VersionReq};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// What the host offers. `platform` is an `install::targets` id (`win-x64`); `None` means unknown and is not checked.
#[derive(Clone, Debug)]
pub struct HostFacts {
    pub harness_version: String,
    pub module_api_current: u32,
    pub rpc_version: String,
    pub platform: Option<String>,
    pub container: bool,
}

/// npm-style comparator sets (`">=0.2.0 <1.0.0"`, `"^1.4"`) to a `semver::VersionReq` (X1-R20): whitespace-separated
/// comparators are joined with `", "`. A bare version means exactly that version (npm), not a caret range (Cargo).
/// `||` ranges and anything else the schema does not allow are errors.
pub fn harness_req(range: &str) -> Result<VersionReq, String> {
    let parts: Vec<String> = range
        .split_whitespace()
        .map(|c| {
            if c.starts_with(|ch: char| ch.is_ascii_digit()) {
                format!("={c}")
            } else {
                c.to_string()
            }
        })
        .collect();
    if parts.is_empty() {
        return Err("empty version range".into());
    }
    for p in &parts {
        let body = p.trim_start_matches(['>', '<', '=', '^', '~']);
        if p.len() - body.len() > 2 || !body.starts_with(|c: char| c.is_ascii_digit()) {
            return Err(format!("unsupported comparator {p:?} in {range:?}"));
        }
    }
    VersionReq::parse(&parts.join(", ")).map_err(|e| format!("{range:?}: {e}"))
}

/// The host version reduced to its release triple. The `semver` crate never matches a pre-release against a range
/// whose comparators carry no pre-release tag, which would lock a dev build (`0.3.0-dev.4`) out of `>=0.2.0`. Dropping
/// pre-release and build metadata makes `0.3.0-dev` satisfy both `>=0.2.0` and `>=0.3.0`, because it is treated as
/// `0.3.0`: a dev build of a release counts as that release. Only the host side is reduced; ranges are untouched.
fn release(v: &str) -> Result<Version, String> {
    let mut v = Version::parse(v).map_err(|e| format!("{v:?}: {e}"))?;
    v.pre = semver::Prerelease::EMPTY;
    v.build = semver::BuildMetadata::EMPTY;
    Ok(v)
}

fn no(field: &str, why: String) -> Refusal {
    Refusal::invalid(reason::INCOMPATIBLE, format!("{field}: {why}"))
}

fn range_check(field: &str, range: &str, have: &str) -> Result<(), Refusal> {
    let req = harness_req(range).map_err(|e| no(field, e))?;
    let v = release(have).map_err(|e| no(field, format!("host version {e}")))?;
    if req.matches(&v) {
        Ok(())
    } else {
        Err(no(field, format!("needs {range}, this host has {have}")))
    }
}

/// `install::targets` ids to the §5.2 `platforms` spelling.
fn manifest_platform(id: &str) -> &str {
    match id {
        "win-x64" => "win32-x64",
        "win-arm64" => "win32-arm64",
        other => other,
    }
}

/// Refuses with `E_INVALID_PARAMS reason=incompatible`, the detail naming the first failing field (`compat.harness`,
/// `compat.moduleApi`, `compat.rpc`, `compat.platforms`, `compat.container`).
pub fn check_compat(m: &P1xManifest, host: &HostFacts) -> Result<(), Refusal> {
    let c = &m.compat;
    if let Some(r) = c.get("harness").and_then(Value::as_str) {
        range_check("compat.harness", r, &host.harness_version)?;
    }
    // `moduleApi` is only meaningful for kinds that speak the module API (§5.2); a skill's is ignored.
    let module_kind = matches!(m.kind, Kind::Module | Kind::Channel);
    if let Some(list) = c
        .get("moduleApi")
        .and_then(Value::as_array)
        .filter(|_| module_kind)
    {
        let cur = host.module_api_current.to_string();
        if !list.iter().any(|v| v.as_str() == Some(cur.as_str())) {
            return Err(no(
                "compat.moduleApi",
                format!("supports {list:?}, this host speaks module API {cur}"),
            ));
        }
    }
    if let Some(r) = c.get("rpc").and_then(Value::as_str) {
        range_check("compat.rpc", r, &host.rpc_version)?;
    }
    if let (Some(list), Some(p)) = (c.get("platforms").and_then(Value::as_array), &host.platform) {
        let p = manifest_platform(p);
        if !list.iter().any(|v| v.as_str() == Some(p)) {
            return Err(no("compat.platforms", format!("not built for {p}")));
        }
    }
    if c.get("container").and_then(Value::as_bool) == Some(false) && host.container {
        return Err(no(
            "compat.container",
            "does not work inside the harness container".into(),
        ));
    }
    Ok(())
}

fn canonical(v: &Value, out: &mut String) {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(k.clone()).to_string());
                out.push(':');
                canonical(&m[k], out);
            }
            out.push('}');
        }
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical(x, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// SHA-256 (lower-case hex) of the compact JSON with object keys sorted at every level. Recorded as
/// `capabilitiesAck` when a person acknowledges a capability set (X1-R13).
pub fn capability_hash(capabilities: &Value) -> String {
    let mut s = String::new();
    canonical(capabilities, &mut s);
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_versions_are_exact_and_operators_pass_through() {
        assert_eq!(harness_req("1.2.3").unwrap().to_string(), "=1.2.3");
        assert_eq!(
            harness_req(">=0.2.0 <1.0.0").unwrap().to_string(),
            ">=0.2.0, <1.0.0"
        );
        assert!(harness_req(">>1.0.0").is_err());
        assert!(harness_req("~").is_err());
    }

    #[test]
    fn platform_ids_map() {
        assert_eq!(manifest_platform("win-x64"), "win32-x64");
        assert_eq!(manifest_platform("linux-arm64"), "linux-arm64");
    }
}
