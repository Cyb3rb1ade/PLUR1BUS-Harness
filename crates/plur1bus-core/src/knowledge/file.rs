//! Bounded knowledge evidence and conditional offline file transitions.

use crate::budget::Clock;
use crate::collab::{CollabError, CollabErrorCode};
use crate::rbac::{
    audit::{AuditEvent, AuditSink},
    authorize::authorize,
    types::{AuthorizeContext, MemoryAgentScope, Principal, PrincipalKind, Resource},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

type R<T> = Result<T, CollabError>;

/// File roles rooted by the host in the approved workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Slot {
    /// Canonical knowledge file.
    Knowledge,
    /// First recognized legacy source.
    Pool,
    /// Second recognized legacy source.
    Memories,
    /// Original target saved for rollback.
    Before,
    /// Prepared target for idempotent resume.
    After,
    /// Durable, versioned migration ledger.
    Report,
}

/// Filesystem port bound to a workspace and the already acquired import lock.
pub trait Files {
    /// Check the current root, lock and filesystem confinement.
    fn trusted_root(&self, agent: &str) -> bool;
    /// Read an allowed regular file with a strict bound. Missing is distinct from refusal.
    fn read(&self, slot: Slot, max_bytes: usize) -> R<Option<Vec<u8>>>;
    /// Compare current SHA-256 and atomically replace or remove the one allowed target.
    fn compare_write(
        &mut self,
        slot: Slot,
        expected: Option<&str>,
        bytes: Option<&[u8]>,
    ) -> R<bool>;
}

/// The current human identity and target registry for offline operations.
pub trait Authority {
    /// Resolve present signed-in rights.
    fn current(&self, id: &str) -> Option<Principal>;
    /// Whether the agent and trusted workspace still admit this operation.
    fn active_agent(&self, agent: &str) -> bool;
}

/// Explicit offline operation context, owned by the importer.
pub struct Context<'a> {
    /// Authenticated person.
    pub who: &'a Principal,
    /// Authorized aligned agent.
    pub agent: &'a str,
    /// Current human and workspace rights.
    pub authority: &'a dyn Authority,
    /// Clock for RBAC and audit.
    pub clock: &'a dyn Clock,
    /// Metadata-only audit sink.
    pub audit: &'a mut dyn AuditSink,
}

/// Outcome for an evidence append.
#[derive(Debug, Serialize)]
pub struct Append {
    /// Whether the file gained a new evidence block.
    pub added: bool,
    /// Whether a new canonical file was created.
    pub created: bool,
    /// Digest after the operation.
    pub sha256: String,
    /// Total bytes after the operation.
    pub bytes: usize,
}

/// Progress of the durable migration.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    /// Copies are staged, target may have been atomically applied.
    Prepared,
    /// The prepared bytes are committed.
    Applied,
    /// The exact previous version is restored.
    RolledBack,
}

/// Recognized immutable legacy source name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum Legacy {
    /// The old pool path.
    #[serde(rename = "knowledgepool.md")]
    Pool,
    /// The old memories path.
    #[serde(rename = "memories.md")]
    Memories,
}

/// Digest of source evidence.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    /// Recognized fixed path.
    pub name: Legacy,
    /// Digest before migration.
    pub sha256: String,
}

/// Stable migration report stored separately from knowledge.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Report {
    /// Report protocol version.
    pub version: u32,
    /// Last durable progress.
    pub state: State,
    /// SHA when the target existed before migration.
    pub before_sha: Option<String>,
    /// Expected prepared file SHA after migration.
    pub after_sha: String,
    /// Exact recognized source digests.
    pub sources: Vec<Source>,
}

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_REPORT: usize = 64 * 1024;
const EMPTY: &str = "# Knowledge\n";

impl Slot {
    /// Fixed path inside the host-validated workspace.
    pub const fn relative_path(self) -> &'static str {
        match self {
            Self::Knowledge => "memory/KNOWLEDGE.md",
            Self::Pool => "knowledgepool.md",
            Self::Memories => "memories.md",
            Self::Before => ".knowledge-migration-v1/before.md",
            Self::After => ".knowledge-migration-v1/after.md",
            Self::Report => ".knowledge-migration-v1/report.json",
        }
    }
}

impl Legacy {
    fn slot(self) -> Slot {
        match self {
            Self::Pool => Slot::Pool,
            Self::Memories => Slot::Memories,
        }
    }
}

fn error(code: CollabErrorCode, reason: &'static str) -> CollabError {
    CollabError::with_reason(code, "knowledge operation refused", reason)
}

fn changed() -> CollabError {
    error(CollabErrorCode::Conflict, "knowledge-changed")
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn confident(files: &dyn Files, context: &Context<'_>) -> R<()> {
    let now = context.clock.now();
    if now < 0
        || !files.trusted_root(context.agent)
        || !context.authority.active_agent(context.agent)
    {
        return Err(error(
            CollabErrorCode::Unauthorized,
            "knowledge-path-outside-home",
        ));
    }
    let scope = Resource::MemoryAgent {
        scope: MemoryAgentScope::AgentPrivate,
        agent_id: context.agent.into(),
    };
    let auth = AuthorizeContext {
        now: Some(now as f64),
    };
    let allowed = |p: &Principal| {
        p.kind == Some(PrincipalKind::Person)
            && p.user_id == context.who.user_id
            && authorize(Some(p), "imports.manage", &Resource::System, &auth).is_allow()
            && authorize(Some(p), "memory.agent-private.write", &scope, &auth).is_allow()
    };
    if allowed(context.who)
        && context
            .authority
            .current(&context.who.user_id)
            .is_some_and(|p| allowed(&p))
    {
        return Ok(());
    }
    Err(error(
        CollabErrorCode::Unauthorized,
        "knowledge-rights-changed",
    ))
}

fn audit(context: &mut Context<'_>, action: &str, digest: &str) -> R<()> {
    context
        .audit
        .append(&AuditEvent {
            at: context.clock.now(),
            user: context.who.user_id.clone(),
            host: String::new(),
            action: action.into(),
            target: context.agent.into(),
            detail: vec![("sha256".into(), json!(digest))],
        })
        .map_err(|_| error(CollabErrorCode::Unauthorized, "audit-unavailable"))
}

fn read(files: &dyn Files, slot: Slot, max: usize) -> R<Option<Vec<u8>>> {
    let bytes = files.read(slot, max)?;
    if bytes.as_ref().is_some_and(|v| v.len() > max) {
        return Err(error(CollabErrorCode::Invalid, "knowledge-too-large"));
    }
    Ok(bytes)
}

fn put(
    files: &mut dyn Files,
    context: &Context<'_>,
    slot: Slot,
    expected: Option<&str>,
    data: Option<&[u8]>,
) -> R<()> {
    confident(files, context)?;
    if files.compare_write(slot, expected, data)? {
        Ok(())
    } else {
        Err(changed())
    }
}

fn size(text: &str) -> R<()> {
    if text.len() > MAX_BYTES {
        Err(error(CollabErrorCode::Invalid, "knowledge-too-large"))
    } else {
        Ok(())
    }
}

fn quote(text: &str) -> String {
    let escaped = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    escaped
        .split('\n')
        .map(|line| format!("> {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn encoding_error() -> CollabError {
    error(CollabErrorCode::Invalid, "invalid-text-encoding")
}

fn target_text(bytes: &[u8]) -> R<&str> {
    std::str::from_utf8(bytes).map_err(|_| encoding_error())
}

fn legacy_text(bytes: &[u8]) -> R<String> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let le = bytes[0] == 0xff;
        let chunks = bytes[2..].chunks_exact(2);
        if !chunks.remainder().is_empty() {
            return Err(encoding_error());
        }
        let units = chunks
            .map(|c| {
                if le {
                    u16::from_le_bytes([c[0], c[1]])
                } else {
                    u16::from_be_bytes([c[0], c[1]])
                }
            })
            .collect::<Vec<_>>();
        return String::from_utf16(&units).map_err(|_| encoding_error());
    }
    let body = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    target_text(body).map(str::to_owned)
}

/// Encode text as a stable, quoted evidence block.
pub fn format_imported(text: &str, source: &str) -> String {
    let check = sha(format!("{source}\0{text}").as_bytes());
    format!(
        "<!-- plur1bus-imported-knowledge:{check} -->\n## Imported agent knowledge\n\n{}\n",
        quote(text)
    )
}

/// Append a source block once to the canonical knowledge file.
pub fn append(
    files: &mut dyn Files,
    context: &mut Context<'_>,
    text: &str,
    source: &str,
) -> R<Append> {
    confident(files, context)?;
    size(text)?;
    if source.len() > MAX_REPORT {
        return Err(error(
            CollabErrorCode::Invalid,
            "knowledge-source-too-large",
        ));
    }
    let before = read(files, Slot::Knowledge, MAX_BYTES)?;
    let raw = before.as_deref().unwrap_or(EMPTY.as_bytes());
    let prior = target_text(raw)?;
    let entry = format_imported(text, source);
    let marker = entry.lines().next().ok_or_else(encoding_error)?;
    if prior.contains(marker) {
        return Ok(Append {
            added: false,
            created: false,
            sha256: sha(raw),
            bytes: raw.len(),
        });
    }
    let content = format!("{prior}\n{entry}");
    size(&content)?;
    let digest = sha(content.as_bytes());
    audit(context, "knowledge.append", &digest)?;
    let expected = before.as_ref().map(|bytes| sha(bytes));
    put(
        files,
        context,
        Slot::Knowledge,
        expected.as_deref(),
        Some(content.as_bytes()),
    )?;
    Ok(Append {
        added: true,
        created: before.is_none(),
        sha256: digest,
        bytes: content.len(),
    })
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn bad_report() -> CollabError {
    error(
        CollabErrorCode::Invalid,
        "invalid-knowledge-migration-report",
    )
}

fn load(files: &dyn Files) -> R<Option<(Report, String)>> {
    let Some(bytes) = read(files, Slot::Report, MAX_REPORT)? else {
        return Ok(None);
    };
    let text = legacy_text(&bytes)?;
    let report: Report = serde_json::from_str(&text).map_err(|_| bad_report())?;
    if report.version != 1
        || !valid_hash(&report.after_sha)
        || !report.before_sha.as_deref().is_none_or(valid_hash)
        || report.sources.is_empty()
        || report.sources.len() > 2
        || report.sources.iter().any(|s| !valid_hash(&s.sha256))
        || (report.sources.len() == 2 && report.sources[0].name == report.sources[1].name)
    {
        return Err(bad_report());
    }
    Ok(Some((report, sha(&bytes))))
}

fn report_bytes(report: &Report) -> R<String> {
    serde_json::to_string_pretty(report)
        .map(|text| text + "\n")
        .map_err(|_| bad_report())
}

fn prove_stage(files: &dyn Files, slot: Slot, digest: &str) -> R<Vec<u8>> {
    read(files, slot, MAX_BYTES)?
        .filter(|bytes| sha(bytes) == digest)
        .ok_or_else(|| error(CollabErrorCode::Conflict, "knowledge-backup-changed"))
}

fn stage(files: &mut dyn Files, context: &Context<'_>, slot: Slot, bytes: &[u8]) -> R<()> {
    match read(files, slot, MAX_BYTES)? {
        Some(saved) if saved == bytes => Ok(()),
        Some(_) => Err(error(CollabErrorCode::Conflict, "knowledge-backup-changed")),
        None => put(files, context, slot, None, Some(bytes)),
    }
}

fn prepare(files: &mut dyn Files, context: &mut Context<'_>) -> R<Option<(Report, String)>> {
    let mut sources = Vec::new();
    for name in [Legacy::Pool, Legacy::Memories] {
        if let Some(bytes) = read(files, name.slot(), MAX_BYTES)? {
            let digest = sha(&bytes);
            sources.push((
                Source {
                    name,
                    sha256: digest,
                },
                legacy_text(&bytes)?,
            ));
        }
    }
    if sources.is_empty() {
        return Ok(None);
    }
    let before = read(files, Slot::Knowledge, MAX_BYTES)?;
    let mut output = target_text(before.as_deref().unwrap_or(EMPTY.as_bytes()))?.to_owned();
    for (source, text) in &sources {
        if crate::js::js_trim(text).is_empty() {
            continue;
        }
        let name = source.name.slot().relative_path();
        use std::fmt::Write as _;
        writeln!(
            output,
            "\n<!-- plur1bus-legacy:{name}:{} -->\n## Imported agent knowledge ({name})\n\n{}",
            source.sha256,
            quote(text)
        )
        .map_err(|_| bad_report())?;
        size(&output)?;
    }
    let report = Report {
        version: 1,
        state: State::Prepared,
        before_sha: before.as_ref().map(|b| sha(b)),
        after_sha: sha(output.as_bytes()),
        sources: sources.into_iter().map(|(source, _)| source).collect(),
    };
    audit(context, "knowledge.migrate.prepare", &report.after_sha)?;
    if let Some(before) = &before {
        stage(files, context, Slot::Before, before)?;
    }
    stage(files, context, Slot::After, output.as_bytes())?;
    let written = report_bytes(&report)?;
    put(files, context, Slot::Report, None, Some(written.as_bytes()))?;
    Ok(Some((report, sha(written.as_bytes()))))
}

fn commit_report(
    files: &mut dyn Files,
    context: &Context<'_>,
    report: &Report,
    old: &str,
) -> R<()> {
    let bytes = report_bytes(report)?;
    put(
        files,
        context,
        Slot::Report,
        Some(old),
        Some(bytes.as_bytes()),
    )
}

/// Resume or begin an offline migration from the recognized legacy slots.
pub fn migrate(files: &mut dyn Files, context: &mut Context<'_>) -> R<Option<Report>> {
    confident(files, context)?;
    let prior = if let Some(saved) = load(files)? {
        Some(saved)
    } else {
        prepare(files, context)?
    };
    let Some((mut report, old_report)) = prior else {
        return Ok(None);
    };
    if report.state != State::Prepared {
        return Ok(Some(report));
    }
    let current = read(files, Slot::Knowledge, MAX_BYTES)?.map(|bytes| sha(&bytes));
    if current.as_deref() != Some(report.after_sha.as_str()) {
        if current != report.before_sha {
            return Err(changed());
        }
        let payload = prove_stage(files, Slot::After, &report.after_sha)?;
        put(
            files,
            context,
            Slot::Knowledge,
            current.as_deref(),
            Some(&payload),
        )?;
    }
    report.state = State::Applied;
    commit_report(files, context, &report, &old_report)?;
    Ok(Some(report))
}

/// Roll back only a target that still matches the recorded proof.
pub fn rollback(files: &mut dyn Files, context: &mut Context<'_>) -> R<Report> {
    confident(files, context)?;
    let (mut report, old) = load(files)?
        .ok_or_else(|| error(CollabErrorCode::NotFound, "knowledge-migration-missing"))?;
    if report.state == State::RolledBack {
        return Ok(report);
    }
    let current = read(files, Slot::Knowledge, MAX_BYTES)?.map(|bytes| sha(&bytes));
    if current != report.before_sha && current.as_deref() != Some(report.after_sha.as_str()) {
        return Err(changed());
    }
    let replacement = report
        .before_sha
        .as_deref()
        .map(|digest| prove_stage(files, Slot::Before, digest))
        .transpose()?;
    audit(context, "knowledge.migrate.rollback", &report.after_sha)?;
    if current.is_some() || replacement.is_some() {
        put(
            files,
            context,
            Slot::Knowledge,
            current.as_deref(),
            replacement.as_deref(),
        )?;
    }
    report.state = State::RolledBack;
    commit_report(files, context, &report, &old)?;
    Ok(report)
}

#[cfg(test)]
#[path = "file_vectors.rs"]
mod vectors;
