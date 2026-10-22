//! `plur1bus 1staid bundle`, beyond `firstaid_bundle.rs`: a marker search over every entry name and every byte of the zip in
//! the raw form and in each encoded form the redactor is meant to know (base64 with and without padding, base64url with and
//! without padding, percent encoding, hex in lower and upper case), what a bundle never reads (an env file, the secret store's files, agent workspaces, earlier bundles, backups, the
//! audit and payload logs), a secret in a file name (the whole bundle is refused), the home directory in plain and JSON-escaped
//! form, and the key-name rule against a list of credential names.
//!
//! The markers are readable strings, never token-shaped literals. Temp homes only, no supervisor, no network.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

/// A registered secret (read from `run/core.token`), with characters whose encodings differ from the raw text.
const RUN_TOKEN: &str = "redact+probe/run=token-Qz9Lm4Xk";
const ENV_MARKER: &str = "redact-probe-env-file";
const STORE_MARKER: &str = "redact-probe-secret-store";
const WORKSPACE_MARKER: &str = "redact-probe-agent-workspace";
const BUNDLE_MARKER: &str = "redact-probe-earlier-bundle";
const BACKUP_MARKER: &str = "redact-probe-backup";
const AUDIT_MARKER: &str = "redact-probe-audit-log";
const PAYLOAD_MARKER: &str = "redact-probe-payload-log";
const KEYED_MARKER: &str = "redact-probe-under-a-key-name";

fn bin() -> PathBuf {
    assert_cmd::cargo::cargo_bin("plur1bus")
}

fn write(p: &Path, text: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

fn b64(bytes: &[u8], url: bool, pad: bool) -> String {
    const STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let t = if url { URL } else { STD };
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        out.push(t[(n >> 18) as usize & 63] as char);
        out.push(t[(n >> 12) as usize & 63] as char);
        if c.len() > 1 {
            out.push(t[(n >> 6) as usize & 63] as char);
        } else if pad {
            out.push('=');
        }
        if c.len() > 2 {
            out.push(t[n as usize & 63] as char);
        } else if pad {
            out.push('=');
        }
    }
    out
}

fn percent(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

struct Home {
    _dir: tempfile::TempDir,
    root: PathBuf,
    /// The OS user's home directory, deliberately holding a user name marker.
    user: PathBuf,
    home: PathBuf,
}

impl Home {
    fn new() -> Home {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let user = root.join("Users").join("zz-probe-user");
        let home = user.join(".plur1bus");
        std::fs::create_dir_all(&home).unwrap();
        write(
            &home.join("config.json"),
            r#"{"schemaVersion":1,"supervisor":{"graceMs":900}}"#,
        );
        write(&home.join("run/core.token"), &format!("{RUN_TOKEN}\n"));
        Home {
            _dir: dir,
            root,
            user,
            home,
        }
    }

    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(bin());
        c.arg("--json")
            .arg("--home")
            .arg(&self.home)
            .args(args)
            .env("HOME", &self.user)
            .env("USERPROFILE", &self.user)
            .env_remove("PLUR1BUS_SERVICE_FAKE")
            .env_remove("PLUR1BUS_ALLOW_TEST_INTERNALS")
            .env_remove("PLUR1BUS_HOME")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c
    }

    fn bundle(&self, out: &Path) -> Output {
        self.cmd(&["1staid", "bundle", "--out", out.to_str().unwrap()])
            .output()
            .unwrap()
    }
}

fn unzip(path: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut out = BTreeMap::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let mut b = Vec::new();
        f.read_to_end(&mut b).unwrap();
        out.insert(f.name().expect("zip entry name").to_string(), b);
    }
    out
}

fn contains(hay: &[u8], needle: &str) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}

/// Every form of `secret` the redactor is meant to know.
fn known_forms(secret: &str) -> Vec<(&'static str, String)> {
    vec![
        ("raw", secret.to_string()),
        ("base64", b64(secret.as_bytes(), false, true)),
        (
            "base64 without padding",
            b64(secret.as_bytes(), false, false),
        ),
        ("base64url", b64(secret.as_bytes(), true, false)),
        ("base64url padded", b64(secret.as_bytes(), true, true)),
        ("percent-encoded", percent(secret)),
        ("hex", hex(secret)),
        ("HEX", hex(secret).to_uppercase()),
    ]
}

/// Where, in the zip, `needle` occurs: entry names and entry bodies.
fn found_in(zip: &BTreeMap<String, Vec<u8>>, needle: &str) -> Vec<String> {
    let mut at = Vec::new();
    for (name, body) in zip {
        if contains(name.as_bytes(), needle) {
            at.push(format!("the name {name}"));
        }
        if contains(body, needle) {
            at.push(format!("the content of {name}"));
        }
    }
    at
}

/// An installation with a marker in every place a bundle might look, and in every place it must not.
fn prepared() -> Home {
    let h = Home::new();
    let user = h.user.to_string_lossy().into_owned();
    // The registered secret, in a log line in every known encoding and in two shapes of surrounding text.
    let forms: Vec<String> = known_forms(RUN_TOKEN).into_iter().map(|(_, f)| f).collect();
    let mut lines =
        vec![r#"{"at":1,"level":"info","role":"supervisor","msg":"early line"}"#.to_string()];
    for (i, f) in forms.iter().enumerate() {
        lines.push(format!(
            r#"{{"at":{},"level":"warn","role":"core","msg":"form {i}: {f} end"}}"#,
            i + 2
        ));
    }
    lines.push(format!(
        r#"{{"at":20,"level":"warn","role":"core","msg":"token={RUN_TOKEN}&x=1"}}"#
    ));
    lines.push(format!(
        r#"{{"at":21,"level":"warn","role":"core","msg":"path {user}/data and {escaped}/data"}}"#,
        escaped = user.replace('\\', "\\\\")
    ));
    lines.push(format!(
        r#"{{"at":22,"level":"warn","role":"core","msg":"state in {home}/state"}}"#,
        home = h.home.to_string_lossy().replace('\\', "\\\\")
    ));
    write(
        &h.home.join("logs/supervisor.log"),
        &(lines.join("\n") + "\n"),
    );
    write(&h.home.join("logs/core.out.log"), "plain stdout\n");
    // A secret under a credential-looking key name in the config.
    write(
        &h.home.join("config.json"),
        &format!(
            r#"{{"schemaVersion":1,"supervisor":{{"graceMs":900}},"engine":{{"apiKey":"{KEYED_MARKER}"}}}}"#
        ),
    );
    // Places a bundle never reads.
    write(&h.home.join(".env"), &format!("API_TOKEN={ENV_MARKER}\n"));
    write(&h.home.join("state/secrets/store.json"), STORE_MARKER);
    write(
        &h.home.join("state/secrets/store.key"),
        &format!("{STORE_MARKER}-key"),
    );
    write(
        &h.home.join("agents/bernd/workspace/.env"),
        &format!("TOKEN={WORKSPACE_MARKER}\n"),
    );
    write(&h.home.join("agents/bernd/persona.md"), WORKSPACE_MARKER);
    write(&h.home.join("bundles/earlier.zip"), BUNDLE_MARKER);
    write(&h.home.join("backups/b.tar.gz"), BACKUP_MARKER);
    write(
        &h.home.join("logs/audit.log"),
        &format!("{{\"detail\":\"{AUDIT_MARKER}\"}}\n"),
    );
    write(
        &h.home.join("logs/payload.log"),
        &format!("prompt {PAYLOAD_MARKER}\n"),
    );
    h
}

#[test]
fn no_known_form_of_a_registered_secret_is_in_any_entry_name_or_byte_of_the_bundle() {
    let h = prepared();
    let dest = h.root.join("b.zip");
    let o = h.bundle(&dest);
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    let zip = unzip(&dest);
    assert!(zip.len() >= 8, "{:?}", zip.keys());
    for (what, form) in known_forms(RUN_TOKEN) {
        let at = found_in(&zip, &form);
        assert!(
            at.is_empty(),
            "the {what} form of the registered secret is in {at:?}"
        );
    }
    // The redaction left its mark where the secret was, so the log is still a log.
    let log = String::from_utf8_lossy(&zip["logs/supervisor.log"]).into_owned();
    assert!(
        log.contains("early line") && log.matches("[REDACTED:").count() >= 5,
        "{log}"
    );
}

#[test]
fn a_value_under_a_credential_key_name_in_the_config_is_removed() {
    let h = prepared();
    let dest = h.root.join("b.zip");
    assert_eq!(h.bundle(&dest).status.code(), Some(0));
    let zip = unzip(&dest);
    assert!(found_in(&zip, KEYED_MARKER).is_empty());
    let cfg: Value = serde_json::from_slice(&zip["config.json"]).unwrap();
    assert_eq!(cfg["engine"]["apiKey"], "[REDACTED:key]");
    assert_eq!(cfg["supervisor"]["graceMs"], 900);
}

#[test]
fn what_a_bundle_never_reads_is_not_in_it_in_the_raw_base64_or_hex_form_nor_in_a_name() {
    let h = prepared();
    let dest = h.root.join("b.zip");
    assert_eq!(h.bundle(&dest).status.code(), Some(0));
    let zip = unzip(&dest);
    for marker in [
        ENV_MARKER,
        STORE_MARKER,
        WORKSPACE_MARKER,
        BUNDLE_MARKER,
        BACKUP_MARKER,
        AUDIT_MARKER,
        PAYLOAD_MARKER,
    ] {
        for form in [
            marker.to_string(),
            b64(marker.as_bytes(), false, true),
            b64(marker.as_bytes(), true, false),
            hex(marker),
            percent(marker),
        ] {
            let at = found_in(&zip, &form);
            assert!(at.is_empty(), "{marker} ({form}) is in {at:?}");
        }
    }
    for name in zip.keys() {
        for banned in [
            ".env", "secrets", "store.", "agents/", "bundles/", "backups/", "audit", "payload",
            "state/", "run/",
        ] {
            assert!(
                !name.contains(banned),
                "the entry {name:?} contains {banned:?}"
            );
        }
    }
}

#[test]
fn a_registered_secret_in_a_log_file_name_refuses_the_whole_bundle_and_writes_nothing() {
    let h = prepared();
    write(
        &h.home
            .join("logs")
            .join(format!("{RUN_TOKEN}.log").replace('/', "_")),
        "x\n",
    );
    // A name with the raw secret in it (the `/` of the marker cannot be in a file name, so use the token's own safe form too).
    let safe = "redact-probe-token-ABCDEFGH";
    write(&h.home.join("run/supervisor.token"), &format!("{safe}\n"));
    write(
        &h.home.join("logs").join(format!("{safe}.log")),
        "named after the secret\n",
    );
    let out = h.root.join("out");
    std::fs::create_dir_all(&out).unwrap();
    let o = h.bundle(&out);
    assert_eq!(
        o.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&o.stdout)
    );
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["schema"], "error/1");
    assert_eq!(v["reason"], "redaction-rescan", "{v}");
    assert!(
        std::fs::read_dir(&out).unwrap().next().is_none(),
        "a refused bundle leaves no file"
    );
    // The refusal does not echo the secret either.
    assert!(
        !String::from_utf8_lossy(&o.stdout).contains(safe),
        "{}",
        String::from_utf8_lossy(&o.stdout)
    );
    assert!(!String::from_utf8_lossy(&o.stderr).contains(safe));
}

#[test]
fn the_home_directory_is_replaced_in_plain_and_escaped_form_and_the_longer_path_wins() {
    let h = prepared();
    let dest = h.root.join("b.zip");
    assert_eq!(h.bundle(&dest).status.code(), Some(0));
    let zip = unzip(&dest);
    let home = h.home.to_string_lossy().into_owned();
    let user = h.user.to_string_lossy().into_owned();
    for (name, body) in &zip {
        for p in [
            &home,
            &user,
            &home.replace('\\', "\\\\"),
            &user.replace('\\', "\\\\"),
        ] {
            assert!(!contains(body, p), "{p} is in {name}");
        }
    }
    // The harness home sits inside the user's home: it keeps its own label, the rest of the user's home is the other one.
    let log = String::from_utf8_lossy(&zip["logs/supervisor.log"]).into_owned();
    assert!(log.contains("<user-home>/data"), "{log}");
    assert!(
        log.contains("<home>/state"),
        "the harness home keeps its own label: {log}"
    );
    assert!(!log.contains("<user-home>/.plur1bus"), "{log}");
}

/// The bare account name is not replaced: only paths are (the module's own comment says "a bundle names no one's account" and
/// means the home paths). A log line that mentions the user name without a path keeps it. Pinned as it is, not as a promise.
#[test]
fn a_bare_user_name_outside_a_path_is_not_replaced_which_is_what_the_code_does_today() {
    let h = prepared();
    let mut log = std::fs::read_to_string(h.home.join("logs/supervisor.log")).unwrap();
    log.push_str(r#"{"at":30,"level":"info","role":"core","msg":"started for zz-probe-user"}"#);
    log.push('\n');
    write(&h.home.join("logs/supervisor.log"), &log);
    let dest = h.root.join("b.zip");
    assert_eq!(h.bundle(&dest).status.code(), Some(0));
    let zip = unzip(&dest);
    let log = String::from_utf8_lossy(&zip["logs/supervisor.log"]).into_owned();
    assert!(
        log.contains("started for zz-probe-user"),
        "if this fails the bundle now replaces account names: update this test and the docs"
    );
    assert!(
        !log.contains("Users/zz-probe-user"),
        "the path form is replaced"
    );
}

/// SICHERHEIT (low), closed. The redactor knows a registered secret raw, in base64 (padded, unpadded), base64url (padded,
/// unpadded), percent-encoded and in hex (lower and upper case). A secret logged in hex used to be none of them, so it passed
/// the redactor and the bundle's own re-scan, which uses the same rules.
#[test]
fn a_registered_secret_logged_in_hex_is_redacted_too() {
    for form in [hex(RUN_TOKEN), hex(RUN_TOKEN).to_uppercase()] {
        let h = Home::new();
        write(
            &h.home.join("logs/supervisor.log"),
            &format!(
                "{{\"at\":1,\"level\":\"info\",\"role\":\"core\",\"msg\":\"digest {form}\"}}\n"
            ),
        );
        let dest = h.root.join("b.zip");
        assert_eq!(h.bundle(&dest).status.code(), Some(0));
        let zip = unzip(&dest);
        let at = found_in(&zip, &form);
        assert!(
            at.is_empty(),
            "the hex form {form} of the registered secret is in {at:?}"
        );
        let log = String::from_utf8_lossy(&zip["logs/supervisor.log"]).into_owned();
        assert!(log.contains("[REDACTED:secret]"), "{log}");
    }
}

/// The counterpart: hex that is not the registered secret's (a digest, an id) stays readable.
#[test]
fn hex_that_is_not_a_registered_secrets_stays_in_the_bundle() {
    let h = Home::new();
    let other = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    write(
        &h.home.join("logs/supervisor.log"),
        &format!("{{\"at\":1,\"level\":\"info\",\"role\":\"core\",\"msg\":\"sha256 {other}\"}}\n"),
    );
    let dest = h.root.join("b.zip");
    assert_eq!(h.bundle(&dest).status.code(), Some(0));
    let zip = unzip(&dest);
    let log = String::from_utf8_lossy(&zip["logs/supervisor.log"]).into_owned();
    assert!(log.contains(other), "{log}");
}

#[test]
fn credential_key_names_in_every_common_spelling_are_removed_from_the_config() {
    let names = [
        "authorization",
        "Authorization",
        "AUTHORIZATION",
        "proxy-authorization",
        "cookie",
        "Set-Cookie",
        "token",
        "Token",
        "access_token",
        "accessToken",
        "id_token_hint",
        "refresh_token",
        "refreshToken",
        "password",
        "passwd",
        "api_key",
        "apiKey",
        "api-key",
        "x-api-key",
        "apikey",
        "client_secret",
        "clientSecret",
        "secret",
        "code_verifier",
        "codeVerifier",
        "ticket",
        "csrf",
        "private_key",
        "privateKey",
        "session_key",
        "sessionKey",
        "botTokenSecret",
        "passwordSecret",
        "x-csrf-token",
    ];
    for chunk in names.chunks(12) {
        let h = Home::new();
        let mut engine = serde_json::Map::new();
        for n in chunk {
            engine.insert((*n).to_string(), json!(format!("{KEYED_MARKER}-{n}")));
        }
        write(
            &h.home.join("config.json"),
            &json!({ "schemaVersion": 1, "engine": engine }).to_string(),
        );
        let dest = h.root.join("b.zip");
        assert_eq!(h.bundle(&dest).status.code(), Some(0));
        let zip = unzip(&dest);
        let left = found_in(&zip, KEYED_MARKER);
        assert!(left.is_empty(), "values under {chunk:?} are in {left:?}");
        let cfg: Value = serde_json::from_slice(&zip["config.json"]).unwrap();
        for n in chunk {
            assert_eq!(cfg["engine"][n], "[REDACTED:key]", "{n}");
        }
    }
}

#[test]
fn a_bundle_is_never_written_over_an_existing_file_and_the_zip_is_private() {
    let h = prepared();
    let dest = h.root.join("b.zip");
    assert_eq!(h.bundle(&dest).status.code(), Some(0));
    let first = std::fs::read(&dest).unwrap();
    let o = h.bundle(&dest);
    assert_ne!(
        o.status.code(),
        Some(0),
        "a second bundle over the same path must be refused"
    );
    assert_eq!(
        std::fs::read(&dest).unwrap(),
        first,
        "the first bundle is untouched"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
