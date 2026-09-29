//! Skill inputs normalised into an unsigned in-memory `.p1x` (spec 2026-09-27 §5.3; X1-R10; controller rulings X1-C1,
//! X1-C2): a folder holding `SKILL.md`, a `.zip`, or an Anthropic `.skill` (a ZIP with `SKILL.md` at its root or in
//! one top folder). The result then runs through the same pipeline as a real package.
use crate::manifest::P1xManifest;
use crate::pack::{checked_zip, collect_dir, entries_of, prepare, DirLimits, PayloadFile};
use crate::refusal::{reason, Refusal};
use crate::scripts::{has_script_extension, is_script};
use crate::skill::{is_excluded, is_skipped, parse_skill_md, validate_skill_md, SkillFront};
use crate::zipaudit::{audit_zip, read_entry, Limits};
use serde_json::{json, Value};
use std::io::{Seek, Write};
use std::path::{Component, Path, PathBuf};

/// A skill is at most this many bytes (`extensions.limits.skillBytes`, X1-R21) and this many files (the importer's
/// default, docs/import.md §9.3).
pub const MAX_SKILL_BYTES: u64 = 16 << 20;
pub const MAX_SKILL_FILES: usize = 2000;
/// Schema caps on the fields derived from the frontmatter.
const SUMMARY_MAX: usize = 280;
const TITLE_MAX: usize = 120;
const LICENCE_MAX: usize = 200;
const VERSION_MAX: usize = 64;

/// Where a skill comes from. A `.zip` or `.skill` holds `SKILL.md` at the root or in one top folder.
#[derive(Debug, Clone)]
pub enum SkillInput {
    Dir(PathBuf),
    Zip(PathBuf),
}

fn invalid(detail: impl Into<String>) -> Refusal {
    Refusal::invalid(reason::PACKAGE_INVALID, detail)
}

/// `Ok(false)` for a name the TS scan leaves out ([`is_skipped`]), an error for a credential or VCS file.
fn keep(rel: &str) -> Result<bool, Refusal> {
    if is_excluded(rel) {
        return Err(Refusal::invalid(
            reason::UNSAFE_ENTRY,
            format!("{rel:?} is a credential or VCS file that a skill never carries"),
        ));
    }
    Ok(!is_skipped(rel))
}

fn skipped_warnings(skipped: &[String]) -> Vec<String> {
    skipped
        .iter()
        .map(|p| format!("left out {p:?}: the importer's scan skips it too"))
        .collect()
}

/// Truncates to `max` characters, ending in `…` when it cut. Whitespace runs collapse to one space first.
fn truncate(s: &str, max: usize) -> (String, bool) {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= max {
        return (s, false);
    }
    let mut t: String = s.chars().take(max - 1).collect();
    t.truncate(t.trim_end().len());
    t.push('…');
    (t, true)
}

/// The name of the directory a skill folder path names, without following a symlink.
fn dir_name_of(path: &Path) -> Result<String, Refusal> {
    let abs = std::path::absolute(path).map_err(|e| Refusal::io(&e))?;
    let last = abs.components().next_back();
    let abs = match last {
        Some(Component::Normal(_)) => abs,
        _ => std::fs::canonicalize(&abs).map_err(|e| Refusal::io(&e))?,
    };
    abs.file_name()
        .and_then(|n| n.to_str())
        .map(str::to_string)
        .ok_or_else(|| invalid("the skill folder's name is not UTF-8"))
}

/// Files of a skill folder plus its directory name.
type Input = (Option<String>, Vec<PayloadFile>, Vec<String>);

fn read_dir_input(dir: &Path) -> Result<Input, Refusal> {
    let meta = std::fs::symlink_metadata(dir).map_err(|e| Refusal::io(&e))?;
    if meta.file_type().is_symlink() {
        return Err(Refusal::invalid(
            reason::UNSAFE_ENTRY,
            format!("{}: a symbolic link is not followed", dir.display()),
        ));
    }
    if !meta.is_dir() {
        return Err(invalid(format!("{} is not a directory", dir.display())));
    }
    let (files, skipped) = collect_dir(
        dir,
        &DirLimits {
            max_bytes: MAX_SKILL_BYTES,
            max_files: MAX_SKILL_FILES,
        },
        keep,
    )?;
    Ok((Some(dir_name_of(dir)?), files, skipped))
}

/// Audits the archive, finds the skill root, and reads its files. The top folder's name is the directory name; an
/// archive with `SKILL.md` at its root has none.
fn read_zip_input(path: &Path) -> Result<Input, Refusal> {
    let mut f = std::fs::File::open(path).map_err(|e| Refusal::io(&e))?;
    let limits = Limits {
        package_bytes: MAX_SKILL_BYTES,
        entry_bytes: MAX_SKILL_BYTES,
        max_entries: MAX_SKILL_FILES,
        ..Limits::default()
    };
    let audited = audit_zip(&mut f, &limits)?;
    let tops: std::collections::BTreeSet<&str> = audited
        .entries
        .iter()
        .map(|e| e.name.split_once('/').map_or("", |(t, _)| t))
        .collect();
    let (prefix, dir_name) = if audited.entries.iter().any(|e| e.name == "SKILL.md") {
        (String::new(), None)
    } else {
        let mut it = tops.iter().filter(|t| !t.is_empty());
        match (it.next(), it.next(), tops.contains("")) {
            (Some(top), None, false) => (format!("{top}/"), Some((*top).to_string())),
            _ => {
                return Err(invalid(
                    "the archive must hold SKILL.md at its root or in exactly one top folder holding everything",
                ))
            }
        }
    };
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    for e in &audited.entries {
        let rel = &e.name[prefix.len()..];
        if !keep(rel)? {
            skipped.push(rel.to_string());
            continue;
        }
        let bytes = read_entry(&mut f, e, MAX_SKILL_BYTES)?;
        files.push(PayloadFile {
            rel: rel.to_string(),
            bytes,
            exec: e.exec,
        });
    }
    if !files.iter().any(|f| f.rel == "SKILL.md") {
        return Err(invalid("the archive has no SKILL.md"));
    }
    Ok((dir_name, files, skipped))
}

/// The explicit capability block of an unsigned skill (X1-C1). All four keys are always present, so a missing key can
/// never read as "none" in the disclosure. A skill without scripts asks for nothing; one with scripts may use the
/// network, spawn processes and write in the agent workspace, because its scripts run through the agent's own tools
/// (§8.6).
fn capabilities(has_scripts: bool) -> Value {
    if has_scripts {
        json!({
            "network": { "mode": "any" },
            "filesystem": [{ "scope": "agent-workspace", "access": "read-write" }],
            "processes": { "spawn": true },
            "harness": { "authority": "none" }
        })
    } else {
        json!({
            "network": { "mode": "none" },
            "filesystem": [],
            "processes": { "spawn": false },
            "harness": { "authority": "none" }
        })
    }
}

fn template(front: &SkillFront, has_scripts: bool, warnings: &mut Vec<String>) -> Value {
    let mut version = front.version.clone().unwrap_or_else(|| "0.0.0".into());
    if front.version.is_some()
        && (version.len() > VERSION_MAX || semver::Version::parse(&version).is_err())
    {
        warnings.push(format!(
            "version {version:?} is not semver; the package uses 0.0.0"
        ));
        version = "0.0.0".into();
    }
    let (summary, cut) = truncate(&front.description, SUMMARY_MAX);
    if cut {
        warnings.push(format!("summary truncated to {SUMMARY_MAX} characters"));
    }
    let (title, cut) = truncate(&front.name, TITLE_MAX);
    if cut {
        warnings.push(format!("title truncated to {TITLE_MAX} characters"));
    }
    let licence = match front.license.as_deref().map(str::trim) {
        Some(l) if !l.is_empty() => {
            let (l, cut) = truncate(l, LICENCE_MAX);
            if cut {
                warnings.push(format!("licence truncated to {LICENCE_MAX} characters"));
            }
            l
        }
        _ => "unspecified".to_string(),
    };
    json!({
        "$schema": "https://plur1bus.app/schema/p1x/1/p1x.schema.json",
        "format": 1,
        "id": format!("local/{}", front.name),
        "name": front.name,
        "version": version,
        "kind": "skill",
        "title": { "en": title },
        "summary": { "en": summary },
        "publisher": { "id": "local", "name": "Local" },
        "licence": licence,
        "compat": { "harness": ">=0.0.0" },
        "requires": { "runtime": { "type": "none" } },
        "capabilities": capabilities(has_scripts)
    })
}

/// [`normalise_skill`], and the warnings the normalisation raised (a non-semver version mapped to `0.0.0`, a truncated
/// summary, title or licence).
pub fn normalise_skill_with_warnings(
    input: &SkillInput,
    created: &str,
    out: &mut (impl Write + Seek),
) -> Result<(P1xManifest, Vec<String>), Refusal> {
    let (dir_name, files, skipped) = match input {
        SkillInput::Dir(d) => read_dir_input(d)?,
        SkillInput::Zip(z) => read_zip_input(z)?,
    };
    let skill_md = files
        .iter()
        .find(|f| f.rel == "SKILL.md")
        .ok_or_else(|| invalid("no SKILL.md at the root of the skill"))?;
    let raw = std::str::from_utf8(&skill_md.bytes)
        .map_err(|e| invalid(format!("SKILL.md is not UTF-8: {e}")))?;
    let front = match &dir_name {
        Some(d) => validate_skill_md(raw, d)?,
        None => parse_skill_md(raw)?,
    };
    // The capability disclosure is wider than `scripts`: it also counts the importer's script extensions (X1-C4).
    let has_scripts = files.iter().any(|f| {
        has_script_extension(&f.rel)
            || is_script(
                &format!("payload/{}", f.rel),
                f.exec,
                &f.bytes[..f.bytes.len().min(4)],
            )
    });
    let mut warnings = skipped_warnings(&skipped);
    let template = template(&front, has_scripts, &mut warnings);
    let p = prepare(&template, files, created)?;
    let bytes = checked_zip(&entries_of(&p, None))?;
    out.write_all(&bytes).map_err(|e| Refusal::io(&e))?;
    Ok((p.manifest, warnings))
}

/// Normalises a skill folder, `.zip` or `.skill` into an unsigned `.p1x` written to `out`: id `local/<name>`,
/// publisher `local`, version from the frontmatter `version` or `metadata.version` (else `0.0.0`), licence from
/// `license` (else `unspecified`), `compat.harness` `>=0.0.0`, no runtime, and an explicit capability block by the
/// derived script set (X1-C1). A `.zip` is audited with [`audit_zip`] first; a symlink or special file is refused and
/// never followed; a credential or VCS file ([`crate::skill::EXCLUDED`]) is refused.
pub fn normalise_skill(
    input: &SkillInput,
    created: &str,
    out: &mut (impl Write + Seek),
) -> Result<P1xManifest, Refusal> {
    normalise_skill_with_warnings(input, created, out).map(|(m, _)| m)
}
