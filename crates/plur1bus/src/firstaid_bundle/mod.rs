//! `plur1bus 1staid bundle` (M8, logging and diagnostics spec §2.9): one redacted diagnostic zip a person can attach
//! to a report. Nothing is uploaded, nothing outside this list is read: versions, platform, the `1staid check`
//! document, the service status, `config.json` with its secrets removed and the last lines of the diagnostic and
//! captured-output logs. Never: the audit log, payload capture, `state/`, stores, the journal, the run-directory token
//! files (read only to be registered as secrets that must not appear), extensions' contents.
//!
//! Every text goes through [`redact::Redactor`] and is then scanned again; a hit refuses the whole bundle
//! ([`BundleError::Refused`], nothing is written). The file is created with `create_new` (never overwrites) and `0600`
//! on unix. A `manifest.json` with each entry's size and SHA-256 is the last entry of the archive.
pub mod redact;

use crate::commands::firstaid::Check;
use crate::paths::Layout;
use crate::service::{self, Runner};
use redact::Redactor;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// How many trailing lines of each log the bundle keeps unless `--lines` says otherwise.
pub const DEFAULT_LINES: usize = 500;
/// The most bytes read from the end of one log file, whatever `--lines` asks for.
const MAX_TAIL_BYTES: u64 = 2 * 1024 * 1024;
/// Logs that never go into a bundle (spec §2.9: `--include-audit` and `--include-payload` are not offered here).
const EXCLUDED_LOGS: [&str; 2] = ["audit.log", "payload.log"];
/// The `schema` id of the archive's own `manifest.json`.
pub const MANIFEST_SCHEMA: &str = "1staid.bundle.manifest/1";

#[derive(Debug)]
pub enum BundleError {
    /// The bundle's own re-scan found something the redactor should have removed: `(entry, rules)`.
    Refused(Vec<(String, Vec<&'static str>)>),
    ConfigPolicy(crate::config_redaction::ConfigRedactionError),
    Io(io::Error),
}

impl From<io::Error> for BundleError {
    fn from(e: io::Error) -> Self {
        BundleError::Io(e)
    }
}

pub struct Part {
    pub path: String,
    pub bytes: Vec<u8>,
}

pub struct Bundle {
    pub parts: Vec<Part>,
    /// Parts left out on purpose (an unparsable config), each `{ path, reason }`.
    pub omitted: Vec<Value>,
}

pub struct Options {
    pub lines: usize,
    /// Epoch milliseconds for `manifest.json`'s `createdAt`.
    pub now_ms: u64,
}

/// The `run/*.token` values: registered with the redactor so a token that leaked into a log line is caught even
/// without a key name next to it.
fn registered_secrets(layout: &Layout) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(dir) = fs::read_dir(layout.run()) {
        for e in dir.flatten() {
            if e.file_name().to_string_lossy().ends_with(".token") {
                if let Ok(t) = fs::read_to_string(e.path()) {
                    out.push(t.trim().to_string());
                }
            }
        }
    }
    out
}

/// Replaces the home directory and the user's own home with placeholders: a bundle names no one's account.
fn scrub_paths(text: &str, layout: &Layout) -> String {
    let mut s = text.to_string();
    let mut dirs: Vec<String> = vec![layout.home.to_string_lossy().into_owned()];
    if let Some(h) = home::home_dir() {
        dirs.push(h.to_string_lossy().into_owned());
    }
    let labels = ["<home>", "<user-home>"];
    // The longer path first, so a harness home inside the user's home keeps its own label.
    let mut pairs: Vec<(String, &str)> = dirs.into_iter().zip(labels).collect();
    pairs.sort_by_key(|(d, _)| std::cmp::Reverse(d.len()));
    for (d, label) in pairs {
        if d.len() > 3 {
            s = s.replace(&d, label);
            s = s.replace(&d.replace('\\', "\\\\"), label);
        }
    }
    s
}

/// The last `n` lines of `path`, reading at most [`MAX_TAIL_BYTES`] from the end.
fn tail(path: &Path, n: usize) -> io::Result<String> {
    let mut f = fs::File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(MAX_TAIL_BYTES);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.take(MAX_TAIL_BYTES).read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // a cut-off first line
    }
    let from = lines.len().saturating_sub(n);
    Ok(lines[from..].join("\n"))
}

/// Keep complete references intact while applying key-name and URL defenses to projected strings.
fn clean_config_values(
    v: &mut Value,
    r: &Redactor,
    references: &std::collections::BTreeSet<String>,
    path: &str,
    private_key: bool,
) {
    if references.contains(path) {
        return;
    }
    match v {
        Value::Object(map) => {
            for (name, child) in map {
                let path = format!("{path}/{}", name.replace('~', "~0").replace('/', "~1"));
                clean_config_values(
                    child,
                    r,
                    references,
                    &path,
                    private_key || redact::credential_key(name),
                );
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter_mut().enumerate() {
                clean_config_values(
                    child,
                    r,
                    references,
                    &format!("{path}/{index}"),
                    private_key,
                );
            }
        }
        Value::String(s)
            if private_key && !s.is_empty() && s != "••••" && !s.starts_with("[REDACTED:") =>
        {
            *s = "[REDACTED:key]".into()
        }
        Value::String(s) => *s = r.redact_config_value(s),
        _ => {}
    }
}

/// Cleans each text with `clean` and scans the result again; any hit refuses the whole set.
fn seal(
    texts: Vec<(String, String)>,
    r: &Redactor,
    clean: impl Fn(&str, &str) -> String,
) -> Result<Vec<Part>, BundleError> {
    let mut parts = Vec::new();
    let mut refused = Vec::new();
    for (path, text) in texts {
        let clean = clean(&path, &text);
        let hits = if path == "config.json" {
            r.scan_config_value(&clean)
        } else {
            r.scan(&clean)
        };
        if !hits.is_empty() {
            refused.push((path.clone(), hits));
        }
        parts.push(Part {
            path,
            bytes: clean.into_bytes(),
        });
    }
    if refused.is_empty() {
        Ok(parts)
    } else {
        Err(BundleError::Refused(refused))
    }
}

pub fn build(
    layout: &Layout,
    runner: &dyn Runner,
    checks: &[Check],
    opts: &Options,
) -> Result<Bundle, BundleError> {
    let mut secrets = registered_secrets(layout);
    let mut omitted = Vec::new();
    let config = match fs::read_to_string(layout.config_path()) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(value) => {
                let policy = crate::config_redaction::ConfigDisclosurePolicy::load(layout, &value)
                    .map_err(BundleError::ConfigPolicy)?;
                secrets.extend(policy.secret_values(&value));
                Some((policy.project(&value), policy.reference_paths(&value)))
            }
            Err(_) => {
                omitted.push(json!({"path":"config.json","reason":"not valid JSON"}));
                None
            }
        },
        Err(error) => {
            let reason = if error.kind() == io::ErrorKind::NotFound {
                "no config file".to_string()
            } else {
                format!("unreadable: {error}")
            };
            omitted.push(json!({"path":"config.json","reason":reason}));
            None
        }
    };
    // Register before versions, checks, service output and logs are cleaned, including values never read from the store.
    let r = Redactor::new(secrets);
    let mut texts: Vec<(String, String)> = Vec::new();

    let install: Value = fs::read_to_string(layout.install_manifest())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    texts.push((
        "versions.json".into(),
        serde_json::to_string_pretty(&json!({
            "harness": env!("CARGO_PKG_VERSION"),
            "installManifest": install,
        }))
        .unwrap_or_default(),
    ));
    texts.push((
        "platform.json".into(),
        serde_json::to_string_pretty(&json!({
            "os": std::env::consts::OS,
            "family": std::env::consts::FAMILY,
            "arch": std::env::consts::ARCH,
            "platform": if cfg!(windows) { "windows" } else { "posix" },
        }))
        .unwrap_or_default(),
    ));
    let ok = !checks
        .iter()
        .any(|c| c.status == crate::commands::firstaid::Status::Fail);
    texts.push((
        "check.json".into(),
        serde_json::to_string_pretty(
            &json!({ "schema": "1staid.check/1", "ok": ok, "checks": checks }),
        )
        .unwrap_or_default(),
    ));
    texts.push((
        "service.json".into(),
        serde_json::to_string_pretty(&service::status(runner, layout)).unwrap_or_default(),
    ));

    if let Some((mut value, references)) = config {
        clean_config_values(&mut value, &r, &references, "", false);
        texts.push((
            "config.json".into(),
            serde_json::to_string_pretty(&value).unwrap_or_default(),
        ));
    }

    let mut logs: Vec<PathBuf> = fs::read_dir(layout.logs())
        .map(|d| {
            d.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    let n = p
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    n.ends_with(".log") && !EXCLUDED_LOGS.contains(&n.as_str()) && p.is_file()
                })
                .collect()
        })
        .unwrap_or_default();
    logs.sort();
    for p in logs {
        let name = p
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        match tail(&p, opts.lines) {
            Ok(t) => texts.push((format!("logs/{name}"), t)),
            Err(e) => omitted.push(
                json!({ "path": format!("logs/{name}"), "reason": format!("unreadable: {e}") }),
            ),
        }
    }

    let mut parts = seal(texts, &r, |path, text| {
        let text = scrub_paths(text, layout);
        if path == "config.json" {
            text
        } else {
            r.redact(&text)
        }
    })?;

    let entries: Vec<Value> = parts
        .iter()
        .map(|p| json!({ "path": p.path, "size": p.bytes.len(), "sha256": hex(&Sha256::digest(&p.bytes)) }))
        .collect();
    let mut manifest = Map::new();
    manifest.insert("schema".into(), json!(MANIFEST_SCHEMA));
    manifest.insert("createdAt".into(), json!(opts.now_ms));
    manifest.insert("harness".into(), json!(env!("CARGO_PKG_VERSION")));
    manifest.insert("entries".into(), json!(entries));
    manifest.insert("omitted".into(), json!(omitted));
    manifest.insert(
        "excluded".into(),
        json!([
            "audit log",
            "payload capture",
            "transcripts",
            "stores",
            "journal",
            "secret store",
            "run tokens"
        ]),
    );
    let manifest_text = serde_json::to_string_pretty(&Value::Object(manifest)).unwrap_or_default();
    let hits = r.scan(&manifest_text);
    if !hits.is_empty() {
        return Err(BundleError::Refused(vec![("manifest.json".into(), hits)]));
    }
    parts.push(Part {
        path: "manifest.json".into(),
        bytes: manifest_text.into_bytes(),
    });
    Ok(Bundle { parts, omitted })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Writes the archive to `dest`, which must not exist; the file is private (`0600` on unix) from its creation.
/// A failure removes the partial file.
pub fn write_zip(bundle: &Bundle, dest: &Path) -> io::Result<()> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(dest)?;
    let result = (|| -> io::Result<()> {
        use zip::write::SimpleFileOptions;
        let mut w = zip::ZipWriter::new(file);
        let o = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .last_modified_time(zip::DateTime::default());
        for p in &bundle.parts {
            w.start_file(&p.path, o).map_err(io::Error::other)?;
            w.write_all(&p.bytes)?;
        }
        w.finish().map_err(io::Error::other)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(dest);
    }
    result
}

/// Where the bundle goes: `out` as a file path, or inside `out` when that is an existing directory; by default
/// `<home>/bundles/1staid-bundle-<epoch ms>.zip` (the directory is created `0700`).
pub fn destination(layout: &Layout, out: Option<&Path>, now_ms: u64) -> io::Result<PathBuf> {
    let name = format!("1staid-bundle-{now_ms}.zip");
    let dest = match out {
        Some(p) if p.is_dir() => p.join(name),
        Some(p) => p.to_path_buf(),
        None => {
            let dir = layout.home.join("bundles");
            fs::create_dir_all(&dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
            }
            dir.join(name)
        }
    };
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_defective_redactor_is_caught_by_the_rescan_and_nothing_is_sealed() {
        let r = Redactor::new(["tok-0123456789".to_string()]);
        let texts = vec![
            ("a.txt".to_string(), "fine".to_string()),
            ("b.txt".to_string(), "leak tok-0123456789 here".to_string()),
        ];
        // a redactor that does nothing stands for a bug in the real one
        match seal(texts.clone(), &r, |_, t| t.to_string()) {
            Err(BundleError::Refused(hits)) => {
                assert_eq!(hits.len(), 1);
                assert_eq!(hits[0].0, "b.txt");
                assert_eq!(hits[0].1, vec![redact::RULE_SECRET]);
            }
            other => panic!("expected a refusal, got ok={}", other.is_ok()),
        }
        assert!(seal(texts, &r, |_, t| r.redact(t)).is_ok());
    }

    #[test]
    fn tail_keeps_the_last_lines_only() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.log");
        fs::write(&p, "1\n2\n3\n4\n5\n").unwrap();
        assert_eq!(tail(&p, 2).unwrap(), "4\n5");
        assert_eq!(tail(&p, 99).unwrap(), "1\n2\n3\n4\n5");
    }
}
