//! MCPB/DXT inputs normalized into unsigned p1x packages (M-A9). Signature framing is not verification.
use crate::manifest::{valid_name, P1xManifest};
use crate::pack::{checked_zip, entries_of, prepare, PayloadFile};
use crate::refusal::{reason, Refusal};
use crate::zipaudit::{audit_zip, read_entry, Limits};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Seek, Write};

mod config;
mod signature;
mod validation;

/// Hashed wrapper metadata inside the normalized payload; source archives cannot supply this path.
pub const MCPB_METADATA_PATH: &str = ".plur1bus/mcpb.json";

/// Explicit, caller-owned environment for path and platform expansion; never reads process globals.
#[derive(Debug, Clone, Default)]
pub struct McpbContext {
    /// Node platform identifier (`linux`, `darwin`, `win32`).
    pub platform: String,
    /// Absolute installed payload directory, supplied by the caller.
    pub extension_dir: String,
    /// Native separator for `${/}` and `${pathSeparator}`.
    pub path_separator: String,
    /// Explicit system-directory variables such as HOME, DOCUMENTS and DESKTOP.
    pub system_dirs: BTreeMap<String, String>,
    /// Nonsecret user values only; sensitive values use the secret-store lease at runtime.
    pub user_config: BTreeMap<String, Value>,
}

/// Validated MCPB manifest retaining source field names for downstream consumers.
#[derive(Debug, Clone)]
pub struct McpbManifest {
    /// Closed source-format manifest.
    pub source: Value,
    /// Source manifest version, including the deprecated dxt_version alias.
    pub manifest_version: String,
}

/// Source-signature disclosure. Neither variant asserts authenticity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignatureStatus {
    /// No appended signature block exists.
    Unsigned,
    /// Structurally framed signature exists, but no approved verifier checked it.
    NotChecked,
}

/// A normalized package and setup declarations, containing no leased secret values.
#[derive(Debug, Clone)]
pub struct McpbReport {
    /// Generated unsigned p1x manifest.
    pub manifest: P1xManifest,
    /// Explicit source signature disclosure.
    pub signature: SignatureStatus,
    /// Normalization and unsupported-source-field disclosures.
    pub warnings: Vec<String>,
    /// Nonsecret input declarations, retaining path, multiple and bounds metadata.
    pub config: BTreeMap<String, Value>,
    /// Required settings or secret slots that still need setup.
    pub needs_setup: Vec<String>,
    /// Resolved command/args/env; sensitive variables remain lease placeholders.
    pub mcp_config: Value,
    /// Source user_config keys mapped to unique p1x secret-slot identifiers.
    pub secret_slots: BTreeMap<String, String>,
}

/// Parses bounded, version-specific closed MCPB manifests without I/O.
pub fn parse_mcpb_manifest(raw: &[u8]) -> Result<McpbManifest, Refusal> {
    validation::parse(raw)
}

/// Resolves platform overrides and variables using explicit context without exposing sensitive values.
pub fn resolve_mcp_config(
    manifest: &McpbManifest,
    context: &McpbContext,
) -> Result<Value, Refusal> {
    config::resolve(manifest, context)
}

/// Checks that a p1x runtime agrees with its validated MCPB source; uv requires Python through uv.
pub fn check_mcpb_runtime(manifest: &McpbManifest, requires: &Value) -> Result<(), Refusal> {
    let source = manifest.source["server"]["type"].as_str().unwrap_or("");
    let expected = if source == "uv" { "python" } else { source };
    if requires["runtime"]["type"].as_str() != Some(expected)
        || (source == "uv" && requires["runtime"]["via"] != "uv")
    {
        return Err(invalid(
            "MCPB server.type does not agree with requires.runtime",
        ));
    }
    Ok(())
}

/// Checks entry-point existence and uv tree rules against regular payload paths relative to the MCPB root.
pub fn check_mcpb_tree(manifest: &McpbManifest, paths: &[&str]) -> Result<(), Refusal> {
    let server = &manifest.source["server"];
    let entry_point = server["entry_point"].as_str().unwrap_or("");
    if !paths.contains(&entry_point) {
        return Err(invalid(
            "MCPB server.entry_point must name a regular file in the archive",
        ));
    }
    if server["type"] == "uv" {
        if !paths.contains(&"pyproject.toml") {
            return Err(invalid(
                "MCPB uv requires pyproject.toml at the archive root",
            ));
        }
        if paths.iter().any(|path| {
            ["server/lib", "server/venv"].iter().any(|prefix| {
                path == prefix
                    || path
                        .strip_prefix(prefix)
                        .is_some_and(|rest| rest.starts_with('/'))
            })
        }) {
            return Err(invalid(
                "MCPB uv forbids bundled server/lib and server/venv",
            ));
        }
    }
    Ok(())
}

fn invalid(detail: impl Into<String>) -> Refusal {
    Refusal::invalid(reason::PACKAGE_INVALID, detail)
}

fn payload(
    input: &mut (impl Read + Seek),
    limits: &Limits,
) -> Result<(McpbManifest, Vec<PayloadFile>, SignatureStatus), Refusal> {
    let (mut zip, signature) = signature::zip_prefix(input, limits)?;
    let audited = audit_zip(&mut zip, limits)?;
    if audited.entries.iter().any(|e| e.name == MCPB_METADATA_PATH) {
        return Err(invalid(
            "MCPB source uses reserved wrapper metadata path .plur1bus/mcpb.json",
        ));
    }
    let entry = audited
        .entries
        .iter()
        .find(|e| e.name == "manifest.json")
        .ok_or_else(|| invalid("MCPB requires manifest.json at the archive root"))?;
    let source = parse_mcpb_manifest(&read_entry(&mut zip, entry, limits.manifest_bytes)?)?;
    let mut files = Vec::with_capacity(audited.entries.len());
    for entry in &audited.entries {
        files.push(PayloadFile {
            rel: entry.name.clone(),
            bytes: read_entry(&mut zip, entry, limits.entry_bytes)?,
            exec: entry.exec,
        });
    }
    check_mcpb_tree(
        &source,
        &files.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(),
    )?;
    Ok((source, files, signature))
}

fn bounded_text(
    value: Option<&str>,
    fallback: &str,
    cap: usize,
    field: &str,
    warnings: &mut Vec<String>,
) -> String {
    let text = value.filter(|s| !s.trim().is_empty()).unwrap_or(fallback);
    if text.chars().count() > cap {
        warnings.push(format!("MCPB {field} truncated to {cap} characters"));
    }
    text.chars().take(cap).collect()
}

fn package_name(source: &str, warnings: &mut Vec<String>) -> String {
    if valid_name(source) {
        return source.to_owned();
    }
    let mut name = String::new();
    for ch in source.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            name.push(ch);
        } else if !name.is_empty() && !name.ends_with('-') {
            name.push('-');
        }
    }
    if !name.starts_with(|c: char| c.is_ascii_lowercase()) {
        name.insert_str(0, "mcp-");
    }
    name.truncate(name.len().min(62));
    name.truncate(name.trim_end_matches('-').len());
    warnings.push(format!(
        "MCPB name normalized to {name:?}; publisher is unverified"
    ));
    name
}

fn runtime(source: &Value) -> Value {
    let kind = source["server"]["type"].as_str().unwrap_or("");
    match kind {
        "node" => {
            json!({"type":"node", "range":source["compatibility"]["runtimes"]["node"].as_str().unwrap_or(">=0.0.0")})
        }
        "python" | "uv" => {
            json!({"type":"python", "range":source["compatibility"]["runtimes"]["python"].as_str().unwrap_or(">=0.0.0"), "via":"uv"})
        }
        _ => json!({"type":"binary"}),
    }
}

fn template(
    source: &Value,
    secret_slots: &BTreeMap<String, String>,
    warnings: &mut Vec<String>,
) -> Value {
    let name = package_name(source["name"].as_str().unwrap_or(""), warnings);
    let mut version = source["version"].as_str().unwrap_or("0.0.0").to_owned();
    if version.len() > 64 || semver::Version::parse(&version).is_err() {
        warnings.push("MCPB version is not supported semver; package uses 0.0.0".into());
        version = "0.0.0".into();
    }
    let title = bounded_text(
        source["display_name"].as_str().or(source["name"].as_str()),
        &name,
        120,
        "display_name",
        warnings,
    );
    let summary = bounded_text(
        source["description"].as_str(),
        "Imported MCP server",
        280,
        "description",
        warnings,
    );
    let licence = bounded_text(
        source["license"].as_str(),
        "unspecified",
        200,
        "license",
        warnings,
    );
    let publisher = bounded_text(
        source["author"]["name"].as_str(),
        "Unverified publisher",
        120,
        "author.name",
        warnings,
    );
    let secrets: Vec<Value> = config::declarations(source).iter().filter(|(_, d)| d["sensitive"] == true)
        .map(|(key, d)| json!({"slot":secret_slots[key], "label":{"en": d["title"].as_str().filter(|s| !s.is_empty()).unwrap_or("Secret").chars().take(120).collect::<String>()}, "required":d["required"].as_bool().unwrap_or(false)})).collect();
    let tools: Vec<Value> = source["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|tool| json!({"name":tool["name"], "effect":"write"}))
        .collect();
    json!({
        "$schema":"https://plur1bus.app/schema/p1x/1/p1x.schema.json", "format":1,
        "id":format!("local/{name}"), "name":name, "version":version, "kind":"mcp-server",
        "title":{"en":title}, "summary":{"en":summary}, "publisher":{"id":"local","name":publisher},
        "licence":licence, "compat":{"harness":">=0.0.0"}, "requires":{"runtime":runtime(source)}, "defaultEnabled":false,
        // The MCPB format supplies no confinement declaration. Local servers are arbitrary processes (§13 Q16).
        "capabilities":{"network":{"mode":"any"}, "filesystem":[{"scope":"home","access":"read-write"}],
            "processes":{"spawn":true}, "harness":{"authority":"none"}, "tools":tools, "secrets":secrets}
    })
}

fn disclosures(source: &McpbManifest, signature: SignatureStatus) -> Vec<String> {
    let mut warnings = vec!["MCPB publisher is unverified; normalized package is unsigned".into(),
        "MCPB supplies no confinement guarantees; local server requests network, home filesystem and process access".into()];
    if signature == SignatureStatus::NotChecked {
        warnings.push(
            "MCPB signature not checked: no approved PKCS#7 verifier; trust remains unsigned"
                .into(),
        );
    }
    if source.source.get("dxt_version").is_some() {
        warnings.push("dxt_version is a deprecated alias for manifest_version".into());
    }
    if source.source["server"]["type"] == "uv" {
        warnings.push("MCPB 0.4 uv uses the executable schema requiring mcp_config; upstream documentation differs".into());
    }
    for field in [
        "prompts",
        "prompts_generated",
        "tools_generated",
        "localization",
        "_meta",
    ] {
        if source.source.get(field).is_some() {
            warnings.push(format!(
                "MCPB {field} retained as source metadata; not activated by normalization"
            ));
        }
    }
    warnings
}

/// Audits an MCPB/DXT archive and writes an unsigned p1x only after complete validation.
/// The date argument remains for caller compatibility; source identity uses an undated canonical creation field.
pub fn normalise_mcpb(
    input: &mut (impl Read + Seek),
    context: &McpbContext,
    limits: &Limits,
    created: &str,
    out: &mut (impl Write + Seek),
) -> Result<McpbReport, Refusal> {
    normalise_mcpb_with_context(input, |_| Ok(context.clone()), limits, created, out)
}

/// Normalizes using a context port called with the validated, normalized package name before path expansion.
/// The port can select the final installation directory without reading or parsing package bytes itself.
/// The compatibility date argument does not affect normalized source bytes.
pub fn normalise_mcpb_with_context(
    input: &mut (impl Read + Seek),
    context: impl FnOnce(&str) -> Result<McpbContext, Refusal>,
    limits: &Limits,
    _created: &str,
    out: &mut (impl Write + Seek),
) -> Result<McpbReport, Refusal> {
    let package = payload(input, limits)?;
    let name = package_name(
        package.0.source["name"].as_str().unwrap_or(""),
        &mut Vec::new(),
    );
    let context = context(&name)?;
    finish_normalise_mcpb(package, &context, limits, VersionPolicy::Upstream, out)
}

/// An unsigned normalized source has no authenticated creation time. A stable format epoch keeps repeated input
/// byte-identical; install/inspection timestamps remain separate records. Ordinary packers still use their caller date.
pub(crate) const NORMALIZED_CREATED: &str = "1970-01-01T00:00:00.000Z";

enum VersionPolicy<'a> {
    Upstream,
    Inline(Option<&'a str>),
}

pub(crate) fn normalise_inline_mcpb(
    input: &mut (impl Read + Seek),
    context: impl FnOnce(&str) -> Result<McpbContext, Refusal>,
    limits: &Limits,
    version: Option<&str>,
    out: &mut (impl Write + Seek),
) -> Result<McpbReport, Refusal> {
    let package = payload(input, limits)?;
    let name = package_name(
        package.0.source["name"].as_str().unwrap_or(""),
        &mut Vec::new(),
    );
    let context = context(&name)?;
    finish_normalise_mcpb(
        package,
        &context,
        limits,
        VersionPolicy::Inline(version),
        out,
    )
}

fn finish_normalise_mcpb(
    package: (McpbManifest, Vec<PayloadFile>, SignatureStatus),
    context: &McpbContext,
    limits: &Limits,
    version: VersionPolicy<'_>,
    out: &mut (impl Write + Seek),
) -> Result<McpbReport, Refusal> {
    let (mut source, mut files, signature) = package;
    let mcp_config = resolve_mcp_config(&source, context)?;
    let needs_setup = config::needs_setup(&source.source, context, &mcp_config);
    let mut warnings = disclosures(&source, signature);
    let config = config::sanitize(&mut source.source, &mut warnings);
    let secret_slots = config::secret_slots(&source.source);
    // Bind __dirname to the authenticated installed directory at launch, not to an inspection spool path.
    let normalized_source = serde_json::to_vec_pretty(&source.source)
        .map_err(|_| invalid("MCPB serialization failed"))?;
    // Revalidate sensitive-default removal against the same source version before packaging.
    parse_mcpb_manifest(&normalized_source)?;
    let entry = files
        .iter_mut()
        .find(|f| f.rel == "manifest.json")
        .ok_or_else(|| invalid("MCPB manifest missing"))?;
    entry.bytes = normalized_source;
    let metadata =
        json!({"format":1, "manifestVersion":source.manifest_version, "secretSlots":secret_slots});
    files.push(PayloadFile {
        rel: MCPB_METADATA_PATH.into(),
        bytes: serde_json::to_vec_pretty(&metadata)
            .map_err(|_| invalid("MCPB metadata serialization failed"))?,
        exec: false,
    });
    let mut template = template(&source.source, &secret_slots, &mut warnings);
    if let VersionPolicy::Inline(version) = version {
        template["version"] = match version {
            Some(version) => version.into(),
            None => crate::pack::content_version(&template, &files)?.into(),
        };
    }
    let prepared = prepare(&template, files, NORMALIZED_CREATED)?;
    let bytes = checked_zip(&entries_of(&prepared, None))?;
    audit_zip(&mut std::io::Cursor::new(&bytes), limits)?;
    check_mcpb_runtime(&source, &prepared.manifest.requires)?;
    out.write_all(&bytes).map_err(|e| Refusal::io(&e))?;
    Ok(McpbReport {
        manifest: prepared.manifest,
        signature,
        warnings,
        config,
        needs_setup,
        mcp_config,
        secret_slots,
    })
}
