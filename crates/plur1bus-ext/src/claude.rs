//! Claude Code plugin inputs become inert unsigned bundles of normalized skills and MCP servers (M-A11).
//! Unsupported components are disclosed, never executed; source credentials and foreign trust do not propagate.
use crate::manifest::{valid_name, P1xManifest};
use crate::mcpb::McpbContext;
use crate::pack::{pack_files, PayloadFile};
use crate::refusal::{reason, Refusal};
use crate::zipaudit::Limits;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, Write};
use std::path::PathBuf;

mod inline;
mod members;
mod source;

fn invalid(detail: impl Into<String>) -> Refusal {
    Refusal::invalid(reason::PACKAGE_INVALID, detail)
}

fn inert_capabilities() -> Value {
    json!({"network":{"mode":"none"},"filesystem":[],"processes":{"spawn":false},"harness":{"authority":"none"}})
}

fn normalized_name(name: &str) -> String {
    if valid_name(name) {
        return name.to_owned();
    }
    let mut result = String::new();
    for ch in name.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            result.push(ch);
        } else if !result.is_empty() && !result.ends_with('-') {
            result.push('-');
        }
    }
    if !result.starts_with(|c: char| c.is_ascii_lowercase()) {
        result.insert_str(0, "plugin-");
    }
    result.truncate(result.len().min(62));
    result.truncate(result.trim_end_matches('-').len());
    result
}

fn text(value: Option<&str>, fallback: &str, cap: usize) -> String {
    value
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(fallback)
        .chars()
        .take(cap)
        .collect()
}

/// Directory or strictly audited ZIP containing a Claude Code plugin tree.
#[derive(Debug, Clone)]
pub enum ClaudeInput {
    /// A directory; symlinks and paths escaping it are refused.
    Dir(PathBuf),
    /// A ZIP with default layout or one enclosing top directory.
    Zip(PathBuf),
}

/// Network boundary: implementations must apply live egress policy to every hop and DNS resolution.
pub trait EgressFetch {
    /// Opens a credential-free HTTPS response under `max_bytes`; the normalizer independently caps reads.
    fn fetch(&mut self, url: &str, max_bytes: u64) -> Result<Box<dyn Read>, Refusal>;
}

/// A disabled network port, for callers that support local plugin sources only.
#[derive(Debug, Default)]
pub struct NoNetwork;

impl EgressFetch for NoNetwork {
    fn fetch(&mut self, _url: &str, _max_bytes: u64) -> Result<Box<dyn Read>, Refusal> {
        Err(Refusal {
            code: "E_NOT_AVAILABLE",
            reason: reason::KIND_UNSUPPORTED,
            detail: "HTTPS plugin sources require a configured egress fetch port".into(),
        })
    }
}

/// A component that was deliberately not imported. Only names and fixed reasons are retained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedComponent {
    /// Source component or entry name, never its configuration values.
    pub name: String,
    /// Why the Harness did not activate it.
    pub reason: String,
}

/// Complete member disclosure; bundle wrappers never claim operational rights for their children.
#[derive(Debug, Clone)]
pub struct ClaudeMember {
    /// The member's normalized package manifest, including capabilities, scripts and secret declarations.
    pub manifest: P1xManifest,
    /// Exact nested p1x SHA-256 bound by the root member table.
    pub sha256: String,
    /// Normalization warnings, including unverified MCPB signature disclosures.
    pub warnings: Vec<String>,
}

/// Inert bundle plus every child's disclosure and the unsupported-component report.
#[derive(Debug, Clone)]
pub struct ClaudeReport {
    /// Unsigned bundle manifest; children remain disabled.
    pub manifest: P1xManifest,
    /// Full child rights; callers must show these with the bundle before approval.
    pub members: Vec<ClaudeMember>,
    /// Unsupported source components, with no source configuration contents.
    pub skipped: Vec<SkippedComponent>,
    /// Bundle normalization warnings; children retain their own warnings as well.
    pub warnings: Vec<String>,
}

/// Normalizes a bounded plugin tree without extracting archives or executing any source component.
/// `context` supplies each MCP member's final installation context; `fetch` is the only network boundary.
/// The compatibility date argument does not affect the canonical unsigned source identity.
pub fn normalise_claude(
    input: &ClaudeInput,
    mut context: impl FnMut(&str) -> Result<McpbContext, Refusal>,
    fetch: &mut impl EgressFetch,
    limits: &Limits,
    _created: &str,
    out: &mut (impl Write + Seek),
) -> Result<ClaudeReport, Refusal> {
    let mut tree = source::read(input, limits)?;
    let mut skipped = tree.skipped.clone();
    let metadata = source::manifest(&tree, limits, &mut skipped)?;
    let created = crate::mcpb::NORMALIZED_CREATED;
    let source_version = metadata["version"]
        .as_str()
        .filter(|s| s.len() <= 64 && semver::Version::parse(s).is_ok());
    source::exclude_components(&mut tree, &metadata);
    let mut builder =
        members::Builder::new(&tree, &mut context, fetch, limits, created, source_version);
    builder.skills(&metadata)?;
    if tree.files.contains_key(".mcp.json") {
        builder.reference("./.mcp.json")?;
    }
    if let Some(mcp) = metadata.get("mcpServers") {
        builder.servers(mcp)?;
    }
    let mut children = builder.finish()?;
    children.sort_by(|a, b| a.manifest.name.cmp(&b.manifest.name));
    let mut name = normalized_name(metadata["name"].as_str().unwrap_or(&tree.name_hint));
    let mut warnings=vec!["Claude Code plugin publisher is unverified; bundle and normalized members are unsigned".into(),
        "Bundle wrapper is inert; inspect every member's capabilities, runtime, scripts and secret slots before approval".into()];
    if children.iter().any(|c| c.manifest.name == name) {
        let base = name.clone();
        // At most N member names can occupy N+1 distinct bounded suffixes.
        for counter in 0..=children.len() {
            let suffix = if counter == 0 {
                "-bundle".into()
            } else {
                format!("-bundle-{counter}")
            };
            let prefix = &base[..base.len().min(62 - suffix.len())];
            let candidate = format!("{}{suffix}", prefix.trim_end_matches('-'));
            if !children
                .iter()
                .any(|child| child.manifest.name == candidate)
            {
                name = candidate;
                break;
            }
        }
        warnings.push("Bundle name uses a suffix to avoid colliding with its member".into());
    }
    let version = source_version.unwrap_or("0.0.0");
    let mut table = Vec::new();
    let mut files = Vec::new();
    let mut reports = Vec::new();
    for child in children {
        let sha256 = crate::zipaudit::hex(&Sha256::digest(&child.bytes));
        table.push(json!({"name":child.manifest.name,"path":format!("payload/members/{}.p1x",child.manifest.name),"sha256":sha256,"optional":false}));
        files.push(PayloadFile {
            rel: format!("members/{}.p1x", child.manifest.name),
            bytes: child.bytes,
            exec: false,
        });
        reports.push(ClaudeMember {
            manifest: child.manifest,
            sha256,
            warnings: child.warnings,
        });
    }
    let template = json!({"format":1,"id":format!("local/{name}"),"name":name,"version":version,"kind":"bundle",
        "title":{"en":text(metadata["name"].as_str(),"Imported plugin",120)},"summary":{"en":text(metadata["description"].as_str(),"Imported Claude Code plugin",280)},
        "publisher":{"id":"local","name":"Local"},"licence":text(metadata["license"].as_str(),"unspecified",200),
        "compat":{"harness":">=0.0.0"},"requires":{"runtime":{"type":"none"}},"defaultEnabled":false,
        "capabilities":inert_capabilities(),"members":table});
    let mut output = std::io::Cursor::new(Vec::new());
    let manifest = pack_files(&template, files, created, &mut output)?;
    crate::zipaudit::audit_zip(&mut std::io::Cursor::new(output.get_ref()), limits)?;
    out.write_all(output.get_ref())
        .map_err(|e| Refusal::io(&e))?;
    skipped.sort_by(|a, b| a.name.cmp(&b.name));
    skipped.dedup_by(|a, b| a.name == b.name);
    Ok(ClaudeReport {
        manifest,
        members: reports,
        skipped,
        warnings,
    })
}
