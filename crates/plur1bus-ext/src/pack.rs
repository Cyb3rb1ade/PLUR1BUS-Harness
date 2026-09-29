//! `ext pack` (spec 2026-09-27 §5.1, §5.3): fills `files`, `scripts` and `created` in a manifest template, then writes
//! `p1x.json` first and `payload/…` sorted after it (deflate, no comment, fixed timestamps, so the same input packs to
//! the same bytes). The archive it emits is audited before it is handed out, so a name the strict audit would refuse is
//! refused here, and the manifest it carries passes [`parse_manifest`].
use crate::manifest::{parse_manifest, P1xManifest};
use crate::refusal::{reason, Refusal};
use crate::scripts::is_script;
use crate::zipaudit::{audit_zip, Limits};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Seek, Write};
use std::path::Path;

/// The deepest directory nesting a walk follows.
const MAX_DEPTH: usize = 32;

/// One payload file in memory: `rel` is the `/`-separated path below `payload/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayloadFile {
    pub rel: String,
    pub bytes: Vec<u8>,
    pub exec: bool,
}

/// One entry of the archive to write. `Symlink` exists for the testkit's tamper variants only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ZipKind {
    File {
        exec: bool,
    },
    #[cfg_attr(not(feature = "testkit"), allow(dead_code))]
    Symlink,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ZipEntry {
    pub name: String,
    pub bytes: Vec<u8>,
    pub kind: ZipKind,
}

fn io_refusal(e: impl std::fmt::Display) -> Refusal {
    Refusal {
        code: "E_INTERNAL",
        reason: "io",
        detail: e.to_string(),
    }
}

/// Writes the entries in order as a ZIP: deflate, fixed timestamp, Unix modes 0644/0755, no comment.
pub(crate) fn write_zip(entries: &[ZipEntry]) -> Result<Vec<u8>, Refusal> {
    use zip::write::SimpleFileOptions;
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let base = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .last_modified_time(zip::DateTime::default());
    for e in entries {
        match e.kind {
            ZipKind::File { exec } => {
                let o = base.unix_permissions(if exec { 0o755 } else { 0o644 });
                w.start_file(e.name.as_str(), o).map_err(io_refusal)?;
                w.write_all(&e.bytes).map_err(io_refusal)?;
            }
            ZipKind::Symlink => {
                let target = String::from_utf8_lossy(&e.bytes).into_owned();
                w.add_symlink(e.name.as_str(), target, base)
                    .map_err(io_refusal)?;
            }
        }
    }
    Ok(w.finish().map_err(io_refusal)?.into_inner())
}

fn hex(bytes: &[u8]) -> String {
    crate::zipaudit::hex(bytes)
}

/// A template filled in: the parsed manifest, its exact serialised bytes, and the sorted files.
pub(crate) struct Prepared {
    pub manifest: P1xManifest,
    pub raw: Vec<u8>,
    pub files: Vec<PayloadFile>,
}

/// Fills `files` (sorted), `scripts` (derived) and `created` into `template`, serialises it, and checks that the
/// result parses.
pub(crate) fn prepare(
    template: &Value,
    mut files: Vec<PayloadFile>,
    created: &str,
) -> Result<Prepared, Refusal> {
    let Some(obj) = template.as_object() else {
        return Err(Refusal::invalid(
            reason::PACKAGE_INVALID,
            "the manifest template is not a JSON object",
        ));
    };
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    let mut entries = Map::new();
    let mut scripts = Vec::new();
    for f in &files {
        let path = format!("payload/{}", f.rel);
        let mut e = Map::new();
        e.insert("sha256".into(), json!(hex(&Sha256::digest(&f.bytes))));
        e.insert("size".into(), json!(f.bytes.len()));
        if f.exec {
            e.insert("exec".into(), json!(true));
        }
        if is_script(&path, f.exec, &f.bytes[..f.bytes.len().min(4)]) {
            scripts.push(path.clone());
        }
        if entries.insert(path.clone(), Value::Object(e)).is_some() {
            return Err(Refusal::invalid(
                reason::UNSAFE_ENTRY,
                format!("{path:?} appears twice"),
            ));
        }
    }
    let mut m = obj.clone();
    m.insert("files".into(), Value::Object(entries));
    m.insert("scripts".into(), json!(scripts));
    m.insert("created".into(), json!(created));
    let mut raw = serde_json::to_vec_pretty(&Value::Object(m)).map_err(io_refusal)?;
    raw.push(b'\n');
    let manifest = parse_manifest(&raw, &[])?;
    Ok(Prepared {
        manifest,
        raw,
        files,
    })
}

/// The archive entries of a prepared package: `p1x.json`, the optional signature file, then `payload/…` sorted.
pub(crate) fn entries_of(p: &Prepared, minisig: Option<Vec<u8>>) -> Vec<ZipEntry> {
    let file = |name: &str, bytes: Vec<u8>| ZipEntry {
        name: name.to_string(),
        bytes,
        kind: ZipKind::File { exec: false },
    };
    let mut out = vec![file("p1x.json", p.raw.clone())];
    if let Some(sig) = minisig {
        out.push(file("p1x.json.minisig", sig));
    }
    out.extend(p.files.iter().map(|f| ZipEntry {
        name: format!("payload/{}", f.rel),
        bytes: f.bytes.clone(),
        kind: ZipKind::File { exec: f.exec },
    }));
    out
}

/// Writes `entries` and audits the result, so nothing the strict audit refuses is handed out.
pub(crate) fn checked_zip(entries: &[ZipEntry]) -> Result<Vec<u8>, Refusal> {
    let bytes = write_zip(entries)?;
    audit_zip(&mut Cursor::new(&bytes), &Limits::default())?;
    Ok(bytes)
}

/// Packs in-memory payload files: see [`pack_dir`].
pub fn pack_files(
    template: &Value,
    files: Vec<PayloadFile>,
    created: &str,
    out: &mut (impl Write + Seek),
) -> Result<P1xManifest, Refusal> {
    let p = prepare(template, files, created)?;
    let bytes = checked_zip(&entries_of(&p, None))?;
    out.write_all(&bytes).map_err(io_refusal)?;
    Ok(p.manifest)
}

/// Packs the directory `payload` under `template` (a manifest without `files`, `scripts` and `created`): fills `files`
/// (sorted), `scripts` (derived, [`is_script`]) and `created`, and writes `p1x.json` first, then `payload/…` sorted,
/// deflated, with no archive comment. Returns the manifest it wrote.
///
/// Refusals: a symlink, a special file or a name that is not UTF-8 in `payload` is `archive-unsafe-entry` (a symlink
/// is never followed); a template that does not pass [`parse_manifest`] is `package-invalid`.
pub fn pack_dir(
    template: &Value,
    payload: &Path,
    created: &str,
    out: &mut (impl Write + Seek),
) -> Result<P1xManifest, Refusal> {
    let files = collect_dir(payload, &DirLimits::default(), |_| Ok(()))?;
    pack_files(template, files, created, out)
}

/// Caps on a directory walk.
pub(crate) struct DirLimits {
    pub max_bytes: u64,
    pub max_files: usize,
}

impl Default for DirLimits {
    fn default() -> Self {
        DirLimits {
            max_bytes: Limits::default().package_bytes,
            max_files: Limits::default().max_entries - 2,
        }
    }
}

/// Reads every regular file below `root` into memory, sorted by path. `check` sees each entry's relative path (files
/// and directories) and may refuse it. A symlink or special file is `archive-unsafe-entry`; an empty directory is
/// dropped, as a ZIP holds no directory entries.
pub(crate) fn collect_dir(
    root: &Path,
    limits: &DirLimits,
    check: impl Fn(&str) -> Result<(), Refusal>,
) -> Result<Vec<PayloadFile>, Refusal> {
    let mut out = Vec::new();
    let mut total = 0u64;
    walk(root, "", 0, limits, &check, &mut total, &mut out)?;
    out.sort_by(|a: &PayloadFile, b| a.rel.cmp(&b.rel));
    Ok(out)
}

fn unsafe_entry(rel: &str, why: &str) -> Refusal {
    Refusal::invalid(reason::UNSAFE_ENTRY, format!("{rel:?}: {why}"))
}

fn walk(
    dir: &Path,
    rel: &str,
    depth: usize,
    limits: &DirLimits,
    check: &dyn Fn(&str) -> Result<(), Refusal>,
    total: &mut u64,
    out: &mut Vec<PayloadFile>,
) -> Result<(), Refusal> {
    if depth > MAX_DEPTH {
        return Err(Refusal::invalid(
            reason::TOO_LARGE,
            format!("{rel:?}: nested deeper than {MAX_DEPTH} directories"),
        ));
    }
    let mut names = Vec::new();
    for e in std::fs::read_dir(dir).map_err(|e| Refusal::io(&e))? {
        let e = e.map_err(|e| Refusal::io(&e))?;
        let name = e
            .file_name()
            .into_string()
            .map_err(|n| unsafe_entry(&n.to_string_lossy(), "the name is not UTF-8"))?;
        names.push(name);
    }
    names.sort();
    for name in names {
        let path = dir.join(&name);
        let r = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        check(&r)?;
        let meta = std::fs::symlink_metadata(&path).map_err(|e| Refusal::io(&e))?;
        let ft = meta.file_type();
        if ft.is_symlink() {
            return Err(unsafe_entry(&r, "a symbolic link"));
        } else if ft.is_dir() {
            walk(&path, &r, depth + 1, limits, check, total, out)?;
        } else if ft.is_file() {
            *total += meta.len();
            if *total > limits.max_bytes || out.len() >= limits.max_files {
                return Err(Refusal::invalid(
                    reason::TOO_LARGE,
                    format!(
                        "more than {} bytes or {} files",
                        limits.max_bytes, limits.max_files
                    ),
                ));
            }
            let bytes = std::fs::read(&path).map_err(|e| Refusal::io(&e))?;
            out.push(PayloadFile {
                rel: r,
                bytes,
                exec: exec_bit(&meta),
            });
        } else {
            return Err(unsafe_entry(&r, "not a regular file"));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn exec_bit(m: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    m.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn exec_bit(_: &std::fs::Metadata) -> bool {
    false
}
