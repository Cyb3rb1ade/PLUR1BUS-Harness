//! The ordered inspect pipeline (spec 2026-09-27 §8.4 steps 1–7; X1-R3, X1-R4, X1-R7, X1-R10, X1-R14). It reads a
//! `.p1x` through a `Read + Seek` handle, writes nothing, and either refuses it with the first failing step's reason
//! or returns an [`Inspection`] with one [`CheckRow`] per step, in the binding order:
//!
//! | id | step |
//! |---|---|
//! | `size` | 1. the file is at most `limits.package_bytes` |
//! | `zip` | 2–3. whole-file SHA-256 and the strict ZIP audit; the root holds exactly `p1x.json`, optionally `p1x.json.minisig`, and `payload/…` |
//! | `signature` | 4. both read (≤ 1 MiB each) and the signature checked over the manifest bytes → the trust tier |
//! | `manifest` | 5. schema and naming rules; the trusted comment names this id and version |
//! | `compat` | 5. `compat` against this host |
//! | `files` | 6. kind (X1-R10), a skill's forbidden names (X1-R14) and size cap, then the payload entry set equals `files` and every entry's SHA-256, size and exec bit match |
//! | `scripts` | 6. the derived script set equals `scripts` (signed: refusal; unsigned: a warning) |
//! | `revocation` | 7. the id and version are not revoked |
use crate::compat::{check_compat, HostFacts};
use crate::manifest::{parse_manifest, Kind, P1xManifest};
use crate::refusal::{reason, Refusal};
use crate::scripts::is_script;
use crate::skill::{is_excluded, is_skipped};
use crate::trust::{check_names, check_signature, Tier, Trust, TrustStore};
use crate::zipaudit::{audit_zip, hash_entry_head, read_entry, Entry, Limits};
use serde::Serialize;
use std::collections::BTreeSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// How far into a script the inspection reads for its first line: 120 characters of up to 4 bytes each, and a
/// line end.
const HEAD_BYTES: usize = 512;
/// The longest first line the inspection shows, in characters.
const FIRST_LINE_CHARS: usize = 120;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pass,
    Warn,
    Fail,
}

/// One step's outcome, for the inspection document and the CLI.
#[derive(Clone, Debug, Serialize)]
pub struct CheckRow {
    pub id: &'static str,
    pub status: Status,
    pub detail: String,
}

/// One file of the derived script set (§8.3): path, size and first line (the shebang) when it is printable text.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInfo {
    pub path: String,
    pub size: u64,
    pub first_line: Option<String>,
}

/// What the pipeline found in a package it did not refuse.
#[derive(Clone, Debug)]
pub struct Inspection {
    /// SHA-256 of the whole file, lower-case hex.
    pub sha256: String,
    pub size: u64,
    pub manifest: P1xManifest,
    /// The exact `p1x.json` bytes (the signed ones when the package is signed).
    pub manifest_raw: Vec<u8>,
    pub trust: Trust,
    pub checks: Vec<CheckRow>,
    /// The derived script set (not the manifest's claim), sorted by path.
    pub scripts: Vec<ScriptInfo>,
    pub entries: Vec<Entry>,
}

/// What a package is checked against.
pub struct Policy<'a> {
    pub limits: Limits,
    /// A skill's payload cap (`extensions.limits.skillBytes`, 16 MiB by default).
    pub skill_bytes: u64,
    pub store: &'a TrustStore,
    pub host: &'a HostFacts,
    /// Names no package may take.
    pub reserved: &'a [&'a str],
    /// `(id, version)` → the revocation's reason, if revoked.
    pub revoked: &'a dyn Fn(&str, &str) -> Option<String>,
}

fn row(id: &'static str, status: Status, detail: impl Into<String>) -> CheckRow {
    CheckRow {
        id,
        status,
        detail: detail.into(),
    }
}

fn package_invalid(detail: impl Into<String>) -> Refusal {
    Refusal::invalid(reason::PACKAGE_INVALID, detail)
}

fn size_refusal(size: u64, limit: u64) -> Refusal {
    Refusal::invalid(
        reason::TOO_LARGE,
        format!("the package is {size} bytes; the limit is {limit}"),
    )
}

/// The root layout (§5.1): exactly one `p1x.json`, at most one `p1x.json.minisig`, everything else under `payload/`.
fn layout(entries: &[Entry]) -> Result<(&Entry, Option<&Entry>, Vec<&Entry>), Refusal> {
    let (mut manifest, mut sig, mut payload) = (None, None, Vec::new());
    for e in entries {
        match e.name.as_str() {
            "p1x.json" if manifest.is_none() => manifest = Some(e),
            "p1x.json.minisig" if sig.is_none() => sig = Some(e),
            n if n.starts_with("payload/") && n.len() > "payload/".len() => payload.push(e),
            n => {
                return Err(package_invalid(format!(
                    "{n:?} is not allowed at the package root (only p1x.json, p1x.json.minisig and payload/)"
                )))
            }
        }
    }
    let manifest = manifest.ok_or_else(|| package_invalid("the package has no p1x.json"))?;
    Ok((manifest, sig, payload))
}

fn kind_name(k: Kind) -> &'static str {
    match k {
        Kind::Skill => "skill",
        Kind::Module => "module",
        Kind::Channel => "channel",
        Kind::McpServer => "mcp-server",
        Kind::Bundle => "bundle",
    }
}

/// A script's first line for the inspection: the bytes up to the first line end, as UTF-8 (a leading BOM dropped),
/// cut to 120 characters. `None` when it is empty or holds a control, bidirectional or other invisible formatting
/// character (a binary, or a line that would display as something else).
pub fn first_line(head: &[u8]) -> Option<String> {
    let newline = head.iter().position(|b| *b == b'\n');
    let line = &head[..newline.unwrap_or(head.len())];
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let text = match std::str::from_utf8(line) {
        Ok(t) => t,
        // The head ended inside a character before any line end: keep the valid prefix. A sequence cut short by
        // the line end itself is not text.
        Err(e) if e.error_len().is_none() && newline.is_none() => {
            std::str::from_utf8(&line[..e.valid_up_to()]).ok()?
        }
        Err(_) => return None,
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if text.is_empty() || text.chars().any(invisible) {
        return None;
    }
    Some(text.chars().take(FIRST_LINE_CHARS).collect())
}

fn invisible(c: char) -> bool {
    c.is_control()
        || matches!(c,
            '\u{00ad}' | '\u{061c}' | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}'
            | '\u{2060}'..='\u{2069}' | '\u{feff}' | '\u{fff9}'..='\u{fffb}')
}

/// Runs §8.4 steps 1–7 on the package in `r` (from its start, whatever the handle's position).
pub fn inspect_reader<R: Read + Seek>(r: &mut R, p: &Policy) -> Result<Inspection, Refusal> {
    let mut checks = Vec::with_capacity(8);

    // 1. Size.
    let size = r.seek(SeekFrom::End(0)).map_err(|e| Refusal::io(&e))?;
    if size > p.limits.package_bytes {
        return Err(size_refusal(size, p.limits.package_bytes));
    }
    checks.push(row(
        "size",
        Status::Pass,
        format!("{size} bytes (at most {})", p.limits.package_bytes),
    ));

    // 2–3. Whole-file hash and the strict ZIP audit, then the root layout.
    let audited = audit_zip(r, &p.limits)?;
    let (manifest_entry, sig_entry, payload) = layout(&audited.entries)?;
    checks.push(row(
        "zip",
        Status::Pass,
        format!(
            "{} entries, sha256 {}",
            audited.entries.len(),
            audited.sha256
        ),
    ));

    // 4. Read the manifest and its signature; verify the signature over the exact bytes.
    let raw = read_entry(r, manifest_entry, p.limits.manifest_bytes)?;
    let minisig = sig_entry
        .map(|e| read_entry(r, e, p.limits.manifest_bytes))
        .transpose()?;
    let checked = check_signature(&raw, minisig.as_deref(), p.store)?;
    let trust = checked.trust.clone();
    checks.push(match (&trust.tier, &trust.key_id, &trust.key_label) {
        (Tier::FirstParty, Some(id), Some(label)) => row(
            "signature",
            Status::Pass,
            format!("first-party: signed by trusted key {id} ({label})"),
        ),
        (Tier::UnknownSigner, Some(id), _) => row(
            "signature",
            Status::Warn,
            format!("unknown-signer: signed by key {id}, which this harness does not trust"),
        ),
        _ => row(
            "signature",
            Status::Warn,
            "unsigned: the package carries no signature",
        ),
    });

    // 5. The manifest, then compatibility.
    let m = parse_manifest(&raw, p.reserved)?;
    check_names(&checked, &m)?;
    checks.push(row(
        "manifest",
        Status::Pass,
        format!("{} {} ({})", m.id, m.version, kind_name(m.kind)),
    ));
    check_compat(&m, p.host)?;
    checks.push(row("compat", Status::Pass, "compatible with this harness"));

    // 6. Kind, a skill's names and size, then the entry set against `files`.
    if matches!(m.kind, Kind::McpServer | Kind::Bundle) {
        return Err(Refusal {
            code: "E_NOT_AVAILABLE",
            reason: reason::KIND_UNSUPPORTED,
            detail: format!("{} packages arrive in X2", kind_name(m.kind)),
        });
    }
    let payload_bytes: u64 = payload.iter().map(|e| e.uncompressed).sum();
    if m.kind == Kind::Skill {
        let names = m
            .files
            .keys()
            .map(String::as_str)
            .chain(payload.iter().map(|e| e.name.as_str()));
        for n in names {
            if is_excluded(n) || is_skipped(n) {
                return Err(package_invalid(format!(
                    "{n:?} is a credential, VCS or cache file; a skill package never carries it"
                )));
            }
        }
        if payload_bytes > p.skill_bytes {
            return Err(Refusal::invalid(
                reason::TOO_LARGE,
                format!(
                    "the skill's payload is {payload_bytes} bytes; a skill may have at most {}",
                    p.skill_bytes
                ),
            ));
        }
    }
    let in_archive: BTreeSet<&str> = payload.iter().map(|e| e.name.as_str()).collect();
    if let Some(extra) = in_archive.iter().find(|n| !m.files.contains_key(**n)) {
        return Err(package_invalid(format!(
            "{extra:?} is in the archive but not in p1x.json files"
        )));
    }
    if let Some(missing) = m.files.keys().find(|n| !in_archive.contains(n.as_str())) {
        return Err(package_invalid(format!(
            "{missing:?} is in p1x.json files but not in the archive"
        )));
    }
    let mut derived = Vec::new();
    for e in &payload {
        let fe = &m.files[&e.name];
        let d = hash_entry_head(r, e, HEAD_BYTES)?;
        if d.size != fe.size || d.sha256 != fe.sha256 {
            return Err(Refusal::invalid(
                reason::DIGEST,
                format!(
                    "{:?}: {} bytes with sha256 {}, p1x.json says {} bytes with sha256 {}",
                    e.name, d.size, d.sha256, fe.size, fe.sha256
                ),
            ));
        }
        if e.exec != fe.exec {
            return Err(package_invalid(format!(
                "{:?}: the archive's exec bit is {}, p1x.json says {}",
                e.name, e.exec, fe.exec
            )));
        }
        if is_script(&e.name, e.exec, &d.head) {
            derived.push(ScriptInfo {
                path: e.name.clone(),
                size: d.size,
                first_line: first_line(&d.head),
            });
        }
    }
    derived.sort_by(|a, b| a.path.cmp(&b.path));
    checks.push(row(
        "files",
        Status::Pass,
        format!(
            "{} payload files, {payload_bytes} bytes, all match p1x.json",
            payload.len()
        ),
    ));

    // 6. The script set.
    let found: BTreeSet<&str> = derived.iter().map(|s| s.path.as_str()).collect();
    let declared: BTreeSet<&str> = m.scripts.iter().map(String::as_str).collect();
    if found == declared {
        checks.push(row(
            "scripts",
            Status::Pass,
            format!("{} scripts or executables, as p1x.json lists", found.len()),
        ));
    } else {
        let list = |s: &BTreeSet<&str>| s.iter().copied().collect::<Vec<_>>().join(", ");
        let detail = format!(
            "p1x.json lists [{}], the package holds [{}]",
            list(&declared),
            list(&found)
        );
        if minisig.is_some() {
            return Err(Refusal::invalid(reason::SCRIPTS_MISMATCH, detail));
        }
        checks.push(row("scripts", Status::Warn, detail));
    }

    // 7. Revocation.
    if let Some(why) = (p.revoked)(&m.id, &m.version) {
        return Err(Refusal {
            code: "E_DENIED",
            reason: reason::REVOKED,
            detail: format!("{} {} is revoked: {why}", m.id, m.version),
        });
    }
    checks.push(row("revocation", Status::Pass, "not revoked"));

    Ok(Inspection {
        sha256: audited.sha256,
        size: audited.size,
        manifest: m,
        manifest_raw: raw,
        trust,
        checks,
        scripts: derived,
        entries: audited.entries,
    })
}

/// [`inspect_reader`] on a file. The size is checked on its metadata before the file is opened.
pub fn inspect_file(path: &Path, p: &Policy) -> Result<Inspection, Refusal> {
    let meta = std::fs::metadata(path).map_err(|e| Refusal::io(&e))?;
    if !meta.is_file() {
        return Err(package_invalid(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    if meta.len() > p.limits.package_bytes {
        return Err(size_refusal(meta.len(), p.limits.package_bytes));
    }
    let file = std::fs::File::open(path).map_err(|e| Refusal::io(&e))?;
    inspect_reader(&mut std::io::BufReader::new(file), p)
}
