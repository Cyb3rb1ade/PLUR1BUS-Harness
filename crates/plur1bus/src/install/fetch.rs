//! The one download client (HB6, ⟂EXT 1): `ureq` over rustls with the OS trust store (`rustls-platform-verifier`),
//! so corporate CAs work and there is no async runtime. Reached only from `setup`, `update` and `1staid repair`,
//! never from `supervisor/` (scripts/lint-hygiene.mjs).
//!
//! A source is an `https://` URL, a `file://` URL or a plain path. Plain `http://` is accepted only for a loopback
//! host (a local mirror or a test server); anything else is refused. Every read is capped (`max_bytes`) while it
//! streams, and an HTTP call has one deadline for the whole exchange.
//!
//! This file uses nothing from the rest of the crate (`tests/install_archive.rs` includes it by path).
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// The source could not be reached or read: refused, no answer within the deadline, TLS failure, a missing
    /// local file, a refused scheme.
    Unreachable(String),
    /// The server answered with a non-success status.
    Http(u16),
    /// The source is larger than the caller's limit; nothing was kept.
    TooLarge { limit: u64 },
    /// The bytes do not have the pinned SHA-256; nothing was kept.
    DigestMismatch { expected: String, actual: String },
    /// Writing the local copy failed.
    Io(String),
}

impl FetchError {
    /// The `reason` a command reports (HB16). A frozen vocabulary (⟂EXT 2): extend, never rename.
    pub fn reason(&self) -> &'static str {
        match self {
            FetchError::Unreachable(_) | FetchError::Http(_) => "release-unreachable",
            FetchError::TooLarge { .. } => "download-too-large",
            FetchError::DigestMismatch { .. } => "digest-mismatch",
            FetchError::Io(_) => "io",
        }
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Unreachable(d) => write!(f, "unreachable: {d}"),
            FetchError::Http(code) => write!(f, "the server answered HTTP {code}"),
            FetchError::TooLarge { limit } => write!(f, "larger than the limit of {limit} bytes"),
            FetchError::DigestMismatch { expected, actual } => {
                write!(f, "SHA-256 mismatch: expected {expected}, got {actual}")
            }
            FetchError::Io(d) => f.write_str(d),
        }
    }
}

enum Source {
    Local(PathBuf),
    /// `(url, plain loopback http)`.
    Http(String, bool),
}

fn classify(src: &str) -> Result<Source, FetchError> {
    let lower = src.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(Source::Http(src.to_string(), false));
    }
    if let Some(rest) = lower.strip_prefix("http://") {
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        let host_port = authority.rsplit('@').next().unwrap_or("");
        let host = if host_port.starts_with('[') {
            host_port.split(']').next().map(|h| format!("{h}]"))
        } else {
            host_port.split(':').next().map(str::to_string)
        }
        .unwrap_or_default();
        if matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]") {
            return Ok(Source::Http(src.to_string(), true));
        }
        return Err(FetchError::Unreachable(format!(
            "plain http is refused for {host}: use https"
        )));
    }
    if lower.starts_with("file://") {
        return Ok(Source::Local(file_url_to_path(&src["file://".len()..])));
    }
    if src.contains("://") {
        return Err(FetchError::Unreachable(format!(
            "unsupported source scheme: {src}"
        )));
    }
    Ok(Source::Local(PathBuf::from(src)))
}

/// `file:///abs/path` or `file://localhost/abs/path` (percent-decoded); `file:///C:/x` is `C:/x` on Windows.
fn file_url_to_path(rest: &str) -> PathBuf {
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let decoded = percent_decode(rest);
    let b = decoded.as_bytes();
    if cfg!(windows) && b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        return PathBuf::from(&decoded[1..]);
    }
    PathBuf::from(decoded)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// An open source: its reader, its announced length, and whether a read error means "unreachable" (network) or
/// "io" (a local file).
struct Opened {
    reader: Box<dyn Read>,
    len: Option<u64>,
    remote: bool,
}

fn open(src: &str, deadline: Duration) -> Result<Opened, FetchError> {
    match classify(src)? {
        Source::Local(path) => {
            let f = fs::File::open(&path)
                .map_err(|e| FetchError::Unreachable(format!("{}: {e}", path.display())))?;
            let len = f.metadata().ok().map(|m| m.len());
            Ok(Opened {
                reader: Box::new(f),
                len,
                remote: false,
            })
        }
        Source::Http(url, loopback) => {
            let mut cfg = ureq::Agent::config_builder()
                .timeout_global(Some(deadline))
                .http_status_as_error(false)
                .user_agent(concat!("plur1bus/", env!("CARGO_PKG_VERSION")));
            cfg = if loopback {
                cfg.proxy(None).max_redirects(0).https_only(false)
            } else {
                cfg.https_only(true).tls_config(
                    ureq::tls::TlsConfig::builder()
                        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                        .build(),
                )
            };
            let agent: ureq::Agent = cfg.build().into();
            let resp = agent.get(&url).call().map_err(|e| match e {
                ureq::Error::Timeout(_) => {
                    FetchError::Unreachable(format!("no answer from {url} within {deadline:?}"))
                }
                e => FetchError::Unreachable(format!("{url}: {e}")),
            })?;
            let status = resp.status().as_u16();
            if !(200..300).contains(&status) {
                return Err(FetchError::Http(status));
            }
            let len = resp
                .headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok());
            Ok(Opened {
                reader: Box::new(resp.into_body().into_reader()),
                len,
                remote: true,
            })
        }
    }
}

/// Streams `opened` into `sink`, hashing, and refuses (before writing the excess) anything over `max_bytes`.
fn pump(opened: Opened, max_bytes: u64, sink: &mut dyn Write) -> Result<String, FetchError> {
    if opened.len.is_some_and(|l| l > max_bytes) {
        return Err(FetchError::TooLarge { limit: max_bytes });
    }
    let remote = opened.remote;
    let mut reader = opened.reader;
    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) if remote => return Err(FetchError::Unreachable(format!("reading: {e}"))),
            Err(e) => return Err(FetchError::Io(format!("reading: {e}"))),
        };
        total += n as u64;
        if total > max_bytes {
            return Err(FetchError::TooLarge { limit: max_bytes });
        }
        hasher.update(&buf[..n]);
        sink.write_all(&buf[..n])
            .map_err(|e| FetchError::Io(format!("writing: {e}")))?;
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// `<dest>.tmp-<pid>`.
fn temp_of(dest: &Path) -> PathBuf {
    let mut name = dest.as_os_str().to_owned();
    name.push(format!(".tmp-{}", std::process::id()));
    PathBuf::from(name)
}

/// Downloads `src` to `dest` if and only if its SHA-256 is `sha256` (hex, any case). The bytes stream into
/// `<dest>.tmp-<pid>` while they are hashed; the temp file is fsynced and renamed onto `dest` only on a match. On any
/// failure nothing is left: no `dest` change, no temp file.
pub fn fetch_verified(
    src: &str,
    dest: &Path,
    sha256: &str,
    max_bytes: u64,
    deadline: Duration,
) -> Result<(), FetchError> {
    let expected = sha256.trim().to_ascii_lowercase();
    if let Some(parent) = dest.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)
            .map_err(|e| FetchError::Io(format!("{}: {e}", parent.display())))?;
    }
    let opened = open(src, deadline)?;
    let tmp = temp_of(dest);
    let result = (|| {
        let mut f = fs::File::create(&tmp)
            .map_err(|e| FetchError::Io(format!("{}: {e}", tmp.display())))?;
        let actual = pump(opened, max_bytes, &mut f)?;
        if actual != expected {
            return Err(FetchError::DigestMismatch { expected, actual });
        }
        f.sync_all()
            .map_err(|e| FetchError::Io(format!("{}: {e}", tmp.display())))?;
        drop(f);
        fs::rename(&tmp, dest).map_err(|e| FetchError::Io(format!("{}: {e}", dest.display())))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Reads `src` into memory (release manifests, signatures), capped at `max_bytes` and bounded by `deadline`.
pub fn fetch_bytes(src: &str, max_bytes: u64, deadline: Duration) -> Result<Vec<u8>, FetchError> {
    let opened = open(src, deadline)?;
    let mut out = Vec::new();
    pump(opened, max_bytes, &mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_are_classified_and_plain_http_is_loopback_only() {
        assert!(matches!(
            classify("https://nodejs.org/dist"),
            Ok(Source::Http(_, false))
        ));
        assert!(matches!(
            classify("http://127.0.0.1:9/x"),
            Ok(Source::Http(_, true))
        ));
        assert!(matches!(
            classify("http://localhost/x"),
            Ok(Source::Http(_, true))
        ));
        assert!(matches!(
            classify("http://[::1]:80/x"),
            Ok(Source::Http(_, true))
        ));
        assert!(matches!(
            classify("http://example.com/x"),
            Err(FetchError::Unreachable(_))
        ));
        assert!(matches!(
            classify("http://127.0.0.1.example.com/x"),
            Err(FetchError::Unreachable(_))
        ));
        assert!(matches!(
            classify("ftp://x/y"),
            Err(FetchError::Unreachable(_))
        ));
        assert!(matches!(classify("/tmp/a b"), Ok(Source::Local(p)) if p == Path::new("/tmp/a b")));
        match classify("file:///tmp/p1b%20A/J%C3%BCrgen") {
            Ok(Source::Local(p)) => assert_eq!(p, PathBuf::from("/tmp/p1b A/Jürgen")),
            _ => panic!("file URL"),
        }
    }

    #[test]
    fn reasons_are_the_frozen_strings() {
        assert_eq!(
            FetchError::Unreachable(String::new()).reason(),
            "release-unreachable"
        );
        assert_eq!(FetchError::Http(404).reason(), "release-unreachable");
        assert_eq!(
            FetchError::TooLarge { limit: 1 }.reason(),
            "download-too-large"
        );
        assert_eq!(
            FetchError::DigestMismatch {
                expected: String::new(),
                actual: String::new()
            }
            .reason(),
            "digest-mismatch"
        );
        assert_eq!(FetchError::Io(String::new()).reason(), "io");
    }
}
