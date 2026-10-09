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
            // Resolved before the agent exists: a bad bundle is a clear refusal, not a TLS failure later.
            let roots = if loopback { None } else { root_certs()? };
            let mut cfg = ureq::Agent::config_builder()
                .timeout_global(Some(deadline))
                .http_status_as_error(false)
                .user_agent(concat!("plur1bus/", env!("CARGO_PKG_VERSION")));
            cfg = if loopback {
                cfg.proxy(None).max_redirects(0).https_only(false)
            } else {
                let proxy = proxy_for_url(&url, &|k| std::env::var(k).ok())?;
                cfg.proxy(proxy).https_only(true).tls_config(
                    ureq::tls::TlsConfig::builder()
                        .root_certs(roots.unwrap_or(ureq::tls::RootCerts::PlatformVerifier))
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

/// The host part of an `https://` URL, lower-cased, without userinfo, port or brackets.
fn url_host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit('@').next()?;
    let host = if let Some(v6) = host_port.strip_prefix('[') {
        v6.split(']').next()?
    } else {
        host_port.split(':').next()?
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Whether `host` is excluded by a `NO_PROXY` list: comma separated, blanks ignored, case-insensitive; `*` is
/// everything; `.corp.example` and `*.corp.example` match the subdomains; a bare `corp.example` matches itself and its
/// subdomains (the curl convention); an optional `:port` on an entry is ignored.
pub fn no_proxy_matches(host: &str, list: &str) -> bool {
    let host = host.to_ascii_lowercase();
    list.split(',')
        .map(|e| e.trim().to_ascii_lowercase())
        .filter(|e| !e.is_empty())
        .any(|e| {
            if e == "*" {
                return true;
            }
            let e = match e.rsplit_once(':') {
                Some((h, port)) if port.bytes().all(|b| b.is_ascii_digit()) && !h.contains(':') => {
                    h.to_string()
                }
                _ => e,
            };
            let suffix = e.trim_start_matches('*');
            if suffix.starts_with('.') {
                host.ends_with(suffix)
            } else {
                host == suffix || host.ends_with(&format!(".{suffix}"))
            }
        })
}

/// The proxy for an `https://` request, from `HTTPS_PROXY`, `ALL_PROXY` (either case) unless `NO_PROXY` excludes the
/// host. `env` is the lookup (the process environment; a closure in tests). A value without a scheme is an `http://`
/// proxy. An unusable value is an error, never a silent direct connection.
fn proxy_for_url(
    url: &str,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<ureq::Proxy>, FetchError> {
    let get = |names: &[&str]| {
        names
            .iter()
            .find_map(|n| {
                env(n)
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
            })
            .map(|v| (v,))
    };
    let Some((value,)) = get(&["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) else {
        return Ok(None);
    };
    if let (Some(host), Some((list,))) = (url_host(url), get(&["NO_PROXY", "no_proxy"])) {
        if no_proxy_matches(&host, &list) {
            return Ok(None);
        }
    }
    let spec = if value.contains("://") {
        value
    } else {
        format!("http://{value}")
    };
    ureq::Proxy::new(&spec)
        .map(Some)
        .map_err(|e| FetchError::Unreachable(format!("the proxy setting is not usable: {e}")))
}

/// The environment variable naming a PEM file of extra trust anchors (a corporate CA). `update --ca-bundle` sets it.
pub const CA_BUNDLE_ENV: &str = "PLUR1BUS_CA_BUNDLE";

/// The PEM bundle `PLUR1BUS_CA_BUNDLE` names, as the only trust anchors for https (like `curl --cacert`: it replaces
/// the OS store, so a TLS-inspecting proxy that re-signs everything with its own CA works, and nothing else does).
/// `Ok(None)`: not set, the OS trust store applies. An unreadable file or one without a certificate is an error.
/// Proxies come from `HTTPS_PROXY`/`ALL_PROXY`/`HTTP_PROXY` and `NO_PROXY` (ureq reads them for every request).
fn root_certs() -> Result<Option<ureq::tls::RootCerts>, FetchError> {
    match std::env::var_os(CA_BUNDLE_ENV).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(path) => load_ca_bundle(Path::new(&path)).map(Some),
    }
}

/// Parses `path` as a PEM bundle (one or more certificates).
pub fn load_ca_bundle(path: &Path) -> Result<ureq::tls::RootCerts, FetchError> {
    let pem = fs::read(path)
        .map_err(|e| FetchError::Unreachable(format!("CA bundle {}: {e}", path.display())))?;
    let mut certs = Vec::new();
    for item in ureq::tls::parse_pem(&pem) {
        match item {
            Ok(ureq::tls::PemItem::Certificate(c)) => certs.push(c),
            Ok(_) => {}
            Err(e) => {
                return Err(FetchError::Unreachable(format!(
                    "CA bundle {}: {e}",
                    path.display()
                )))
            }
        }
    }
    if certs.is_empty() {
        return Err(FetchError::Unreachable(format!(
            "CA bundle {} holds no PEM certificate",
            path.display()
        )));
    }
    Ok(ureq::tls::RootCerts::Specific(std::sync::Arc::new(certs)))
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

    const TEST_CA: &str = include_str!("../../tests/fixtures/ca/test-ca.pem");

    /// The environment is process-wide: the tests that set proxy variables or the CA bundle run one at a time.
    static ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct EnvGuard(Vec<(&'static str, Option<std::ffi::OsString>)>);
    impl EnvGuard {
        fn set(vars: &[(&'static str, Option<&str>)]) -> Self {
            let saved = vars
                .iter()
                .map(|(k, _)| (*k, std::env::var_os(k)))
                .collect();
            for (k, v) in vars {
                match v {
                    Some(v) => std::env::set_var(k, v),
                    None => std::env::remove_var(k),
                }
            }
            EnvGuard(saved)
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (k, v) in &self.0 {
                match v {
                    Some(v) => std::env::set_var(k, v),
                    None => std::env::remove_var(k),
                }
            }
        }
    }

    const PROXY_VARS: [&str; 7] = [
        "ALL_PROXY",
        "all_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "NO_PROXY",
    ];

    /// A listener that records the first request line of the first connection and hangs up.
    fn fake_proxy() -> (u16, std::sync::mpsc::Receiver<String>) {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((s, _)) = l.accept() {
                let mut line = String::new();
                let _ = io::BufRead::read_line(&mut io::BufReader::new(&s), &mut line);
                let _ = tx.send(line);
            }
        });
        (port, rx)
    }

    #[test]
    fn https_goes_through_https_proxy_and_no_proxy_bypasses_it() {
        let _lock = ENV.lock().unwrap_or_else(|p| p.into_inner());
        let (port, rx) = fake_proxy();
        let url = format!("http://127.0.0.1:{port}");
        let mut vars: Vec<(&'static str, Option<&str>)> =
            PROXY_VARS.iter().map(|k| (*k, None)).collect();
        vars.iter_mut()
            .find(|(k, _)| *k == "HTTPS_PROXY")
            .unwrap()
            .1 = Some(url.as_str());
        let _g = EnvGuard::set(&vars);
        let err = fetch_bytes(
            "https://updates.example.invalid/stable.json",
            1024,
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(matches!(err, FetchError::Unreachable(_)), "{err}");
        let line = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the proxy was contacted");
        assert!(
            line.starts_with("CONNECT updates.example.invalid:443"),
            "{line:?}"
        );

        // NO_PROXY lists the host: the proxy is not used (the name does not resolve, so the call fails without it).
        let (port, rx) = fake_proxy();
        let url = format!("http://127.0.0.1:{port}");
        vars.iter_mut()
            .find(|(k, _)| *k == "HTTPS_PROXY")
            .unwrap()
            .1 = Some(url.as_str());
        vars.iter_mut().find(|(k, _)| *k == "NO_PROXY").unwrap().1 =
            Some("example.invalid,localhost");
        let _g2 = EnvGuard::set(&vars);
        let err = fetch_bytes(
            "https://updates.example.invalid/stable.json",
            1024,
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(matches!(err, FetchError::Unreachable(_)), "{err}");
        assert!(
            rx.recv_timeout(Duration::from_millis(500)).is_err(),
            "NO_PROXY was ignored"
        );
    }

    #[test]
    fn no_proxy_follows_the_curl_conventions_and_a_proxy_value_is_checked() {
        assert!(no_proxy_matches("localhost", "localhost,127.0.0.1"));
        assert!(no_proxy_matches(
            "updates.corp.example",
            " Corp.Example , other"
        ));
        assert!(no_proxy_matches("updates.corp.example", ".corp.example"));
        assert!(no_proxy_matches("updates.corp.example", "*.corp.example"));
        assert!(!no_proxy_matches("corp.example", ".corp.example"));
        assert!(!no_proxy_matches("evilcorp.example", "corp.example"));
        assert!(no_proxy_matches("anything.test", "*"));
        assert!(no_proxy_matches("a.test", "a.test:8443"));
        assert!(!no_proxy_matches("a.test", ""));
        assert_eq!(
            url_host("https://User:pw@Updates.Example:8443/x?y#z").as_deref(),
            Some("updates.example")
        );

        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        let u = "https://updates.corp.example/stable.json";
        assert!(proxy_for_url(u, &env(&[])).unwrap().is_none());
        assert!(
            proxy_for_url(u, &env(&[("HTTPS_PROXY", "proxy.corp:3128")]))
                .unwrap()
                .is_some()
        );
        assert!(proxy_for_url(u, &env(&[("all_proxy", "http://p:1")]))
            .unwrap()
            .is_some());
        assert!(proxy_for_url(
            u,
            &env(&[("HTTPS_PROXY", "http://p:1"), ("NO_PROXY", ".corp.example")])
        )
        .unwrap()
        .is_none());
        assert!(proxy_for_url(u, &env(&[("HTTPS_PROXY", "nope://p:1")])).is_err());
    }

    #[test]
    fn a_ca_bundle_is_parsed_and_a_bad_one_is_refused_before_any_request() {
        let _lock = ENV.lock().unwrap_or_else(|p| p.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("ca.pem");
        fs::write(&good, format!("# corporate\n{TEST_CA}\n{TEST_CA}")).unwrap();
        match load_ca_bundle(&good).unwrap() {
            ureq::tls::RootCerts::Specific(c) => assert_eq!(c.len(), 2),
            _ => panic!("specific roots"),
        }
        let empty = dir.path().join("empty.pem");
        fs::write(&empty, "nothing here\n").unwrap();
        assert!(load_ca_bundle(&empty).is_err());
        assert!(load_ca_bundle(&dir.path().join("missing.pem")).is_err());

        // Through the env: unset => OS store; set => the bundle; a bad path fails the https fetch with a clear error.
        {
            let _g = EnvGuard::set(&[(CA_BUNDLE_ENV, None)]);
            assert!(root_certs().unwrap().is_none());
        }
        {
            let g = good.to_string_lossy().into_owned();
            let _g = EnvGuard::set(&[(CA_BUNDLE_ENV, Some(g.as_str()))]);
            assert!(matches!(
                root_certs().unwrap(),
                Some(ureq::tls::RootCerts::Specific(_))
            ));
        }
        let bad = dir.path().join("nope.pem").to_string_lossy().into_owned();
        let _g = EnvGuard::set(&[(CA_BUNDLE_ENV, Some(bad.as_str()))]);
        let err = fetch_bytes(
            "https://updates.example.invalid/x",
            10,
            Duration::from_secs(2),
        )
        .unwrap_err();
        assert!(err.to_string().contains("CA bundle"), "{err}");
    }
}
