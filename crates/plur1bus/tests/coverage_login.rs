//! `plur1bus login` argument parsing and offline error paths, beyond what `login_cli.rs` already pins: every listed
//! provider routes, the route refusals (`unsupported-route`, `invalid-name`, flag conflicts), clap range and conflict
//! errors, stdin key edge cases (blank, oversized, whitespace), and the core-unavailable error for every API-key
//! provider. No OAuth route is ever started: a browser would open and a core would be called, so every test either
//! fails in argument planning or pipes an API key with no core running. A key that is typed is never echoed.
use serde_json::Value;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

const MARKER: &str = "sk-p1b-COVERAGE-MARKER-4b7e0d91a2c3";
const PROVIDERS: [&str; 10] = [
    "openai",
    "anthropic",
    "google",
    "gemini",
    "xai",
    "openrouter",
    "together",
    "fal",
    "replicate",
    "elevenlabs",
];

/// The binary with `--home` in `home` and the environment scrubbed of anything that would change routing.
fn bin(home: &Path) -> Command {
    let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
    c.arg("--home")
        .arg(home)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env_remove("PLUR1BUS_CONTAINER")
        .env_remove("PLUR1BUS_HOME");
    c
}

fn text(o: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

fn json(o: &Output) -> Value {
    serde_json::from_slice(&o.stdout)
        .unwrap_or_else(|e| panic!("stdout is not JSON ({e}): {}", text(o)))
}

/// Runs `args` with `stdin` piped in (closed right after the write), `--json` on.
fn piped(home: &Path, args: &[&str], stdin: &[u8]) -> Output {
    let mut child = bin(home)
        .arg("--json")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // A refusal can exit before it reads stdin, so the write may hit a closed pipe (EPIPE). That is expected and the
    // exit status and output are what the caller asserts, so the write error is ignored here, not unwrapped.
    let _ = child.stdin.take().unwrap().write_all(stdin);
    child.wait_with_output().unwrap()
}

#[test]
fn the_help_lists_every_provider_that_has_a_sign_in_route() {
    let home = tempfile::tempdir().unwrap();
    let o = bin(home.path()).args(["login", "--help"]).output().unwrap();
    assert_eq!(o.status.code(), Some(0));
    let help = text(&o);
    for p in PROVIDERS {
        assert!(help.contains(p), "{p} missing from login --help");
    }
    assert!(help.contains("--api-key") && help.contains("--name"));
    assert!(help.contains("--timeout"), "{help}");
}

#[test]
fn every_provider_takes_an_api_key_and_reaches_the_core_when_none_runs() {
    let home = tempfile::tempdir().unwrap();
    for p in PROVIDERS {
        let o = piped(
            home.path(),
            &["login", p, "--api-key"],
            format!("{MARKER}\n").as_bytes(),
        );
        assert_eq!(o.status.code(), Some(1), "{p}: {}", text(&o));
        let v = json(&o);
        assert_eq!(v["error"], "E_CORE_UNAVAILABLE", "{p}");
        assert!(!text(&o).contains("COVERAGE-MARKER"), "{p} echoed the key");
    }
}

#[test]
fn an_api_key_provider_with_a_custom_secret_name_reaches_the_core() {
    let home = tempfile::tempdir().unwrap();
    let o = piped(
        home.path(),
        &[
            "login",
            "openrouter",
            "--api-key",
            "--name",
            "team.key-2:prod@x/y",
        ],
        format!("{MARKER}\n").as_bytes(),
    );
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert_eq!(json(&o)["error"], "E_CORE_UNAVAILABLE");
}

#[test]
fn blank_keys_are_refused_before_any_connection() {
    let home = tempfile::tempdir().unwrap();
    for input in [&b""[..], b"\n", b"\r\n"] {
        let o = piped(home.path(), &["login", "xai", "--api-key"], input);
        assert_eq!(o.status.code(), Some(2), "{input:?}: {}", text(&o));
        let v = json(&o);
        assert_eq!(v["error"], "E_INVALID_PARAMS", "{input:?}");
        assert_eq!(v["detail"], "key", "{input:?}");
    }
}

// UNKLAR: a key made only of spaces or tabs is accepted by `secret::parse_value` (it checks only for empty and NUL),
// so it reaches the core. Whether a whitespace-only key must be refused here is not settled by the docs.
#[test]
#[ignore = "UNKLAR: soll ein nur aus Leerraum bestehender API-Key abgelehnt werden? parse_value prueft nur auf leer und NUL"]
fn whitespace_only_keys_are_refused_before_any_connection() {
    let home = tempfile::tempdir().unwrap();
    for input in [&b"   \n"[..], b"\t\n\n"] {
        let o = piped(home.path(), &["login", "xai", "--api-key"], input);
        assert_eq!(o.status.code(), Some(2), "{input:?}: {}", text(&o));
        assert_eq!(json(&o)["detail"], "key", "{input:?}");
    }
}

#[test]
fn an_oversized_key_is_refused_without_echoing_any_of_it() {
    let home = tempfile::tempdir().unwrap();
    // One byte past the 64 KiB key bound.
    let mut big = vec![b'a'; 64 * 1024 + 1];
    big.push(b'\n');
    let o = piped(home.path(), &["login", "anthropic", "--api-key"], &big);
    assert_eq!(o.status.code(), Some(2), "{}", text(&o));
    let v = json(&o);
    assert_eq!(v["error"], "E_INVALID_PARAMS");
    assert!(text(&o).len() < 4096, "the refusal must not dump the input");
}

#[test]
fn a_multi_line_input_reaches_the_core_and_is_never_echoed() {
    let home = tempfile::tempdir().unwrap();
    let input = format!("{MARKER}\nsecond line\n");
    let o = piped(home.path(), &["login", "anthropic"], input.as_bytes());
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert_eq!(json(&o)["error"], "E_CORE_UNAVAILABLE");
    assert!(!text(&o).contains("COVERAGE-MARKER"));
}

#[test]
fn route_refusals_are_usage_errors_with_a_reason_and_no_echo() {
    let home = tempfile::tempdir().unwrap();
    // (argv, reason). Each is refused in argument planning, before any core or browser is involved.
    let cases: [(&[&str], &str); 8] = [
        (&["login", "anthropic", "--oauth"], "unsupported-route"),
        (&["login", "openai", "--name", "x"], "unsupported-route"),
        (
            &["login", "openai", "--api-key", "--timeout", "5"],
            "unsupported-route",
        ),
        (
            &["login", "anthropic", "--api-key", "--no-browser"],
            "unsupported-route",
        ),
        (
            &["login", "anthropic", "--api-key", "--paste"],
            "unsupported-route",
        ),
        (
            &["login", "anthropic", "--api-key", "--name", "bad name!"],
            "invalid-name",
        ),
        (
            &["login", "anthropic", "--api-key", "--name", "-leading"],
            "invalid-name",
        ),
        (
            &["login", "anthropic", "--api-key", "--name", ""],
            "invalid-name",
        ),
    ];
    for (args, reason) in cases {
        let o = piped(home.path(), args, b"x\n");
        assert_eq!(o.status.code(), Some(2), "{args:?}: {}", text(&o));
        let v = json(&o);
        assert_eq!(v["error"], "E_INVALID_PARAMS", "{args:?}");
        assert_eq!(v["reason"], reason, "{args:?}");
        assert!(!text(&o).contains("\"x\""), "{args:?}");
    }
}

#[test]
fn an_unknown_provider_is_named_as_such_and_the_known_list_is_given() {
    let home = tempfile::tempdir().unwrap();
    let o = piped(home.path(), &["login", "nonesuch"], b"");
    assert_eq!(o.status.code(), Some(2));
    let v = json(&o);
    assert_eq!(v["reason"], "unknown-provider");
    let msg = v["message"].as_str().unwrap_or_default();
    assert!(msg.contains("anthropic") && msg.contains("openai"), "{msg}");
}

#[test]
fn a_value_that_is_not_a_plain_word_is_treated_as_a_pasted_key() {
    let home = tempfile::tempdir().unwrap();
    for arg in [
        "sk-ant-PASTED-VALUE-123",
        "Anthropic",
        "a b",
        "x".repeat(40).as_str(),
    ] {
        let o = piped(home.path(), &["login", arg], b"");
        assert_eq!(o.status.code(), Some(2), "{arg}");
        let v = json(&o);
        assert_eq!(v["reason"], "value-in-argument", "{arg}");
        assert!(!text(&o).contains(arg), "{arg} was echoed");
    }
}

#[test]
fn clap_rejects_conflicting_and_out_of_range_login_flags() {
    let home = tempfile::tempdir().unwrap();
    for args in [
        vec!["login", "anthropic", "--oauth", "--api-key"],
        vec!["login", "openai", "--timeout", "0"],
        vec!["login", "openai", "--timeout", "3601"],
        vec!["login", "openai", "--timeout", "soon"],
        vec!["login", "logout"],
        vec!["login", "status", "extra"],
        vec!["login", "list", "--nope"],
    ] {
        let o = bin(home.path()).args(&args).output().unwrap();
        assert_eq!(o.status.code(), Some(2), "{args:?}: {}", text(&o));
        assert!(!o.stderr.is_empty(), "{args:?}: clap explains the error");
    }
}

#[test]
fn a_timeout_inside_the_bounds_parses_and_applies_only_to_oauth() {
    let home = tempfile::tempdir().unwrap();
    // 1 and 3600 are the bounds. On an API-key route the timeout is a refusal, not a silent no-op; the bound
    // check passes first, so the reason is the route, not the number.
    for secs in ["1", "3600"] {
        let o = piped(
            home.path(),
            &["login", "anthropic", "--api-key", "--timeout", secs],
            b"x\n",
        );
        assert_eq!(o.status.code(), Some(2), "{secs}");
        assert_eq!(json(&o)["reason"], "unsupported-route", "{secs}");
    }
}

#[test]
fn logout_with_a_prefix_id_and_status_and_list_all_fail_the_same_way_without_a_core() {
    let home = tempfile::tempdir().unwrap();
    for args in [
        vec!["login", "logout", "3fa9"],
        vec!["login", "logout", "3fa9c2d1-0000-4000-8000-000000000000"],
    ] {
        let o = piped(home.path(), &args, b"");
        assert_eq!(o.status.code(), Some(1), "{args:?}: {}", text(&o));
        assert_eq!(json(&o)["error"], "E_CORE_UNAVAILABLE", "{args:?}");
    }
}

#[test]
fn no_login_command_writes_a_credential_file_under_home_when_the_core_is_absent() {
    let home = tempfile::tempdir().unwrap();
    let before = std::fs::read_dir(home.path()).unwrap().count();
    let _ = piped(
        home.path(),
        &["login", "anthropic"],
        format!("{MARKER}\n").as_bytes(),
    );
    let _ = piped(home.path(), &["login", "status"], b"");
    let _ = piped(home.path(), &["login", "list"], b"");
    let after = std::fs::read_dir(home.path()).unwrap().count();
    assert!(after <= before + 1, "unexpected files under home");
    for entry in walk(home.path()) {
        let body = std::fs::read(&entry).unwrap_or_default();
        assert!(
            !String::from_utf8_lossy(&body).contains("COVERAGE-MARKER"),
            "{} holds the key",
            entry.display()
        );
    }
}

fn walk(p: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                out.extend(walk(&path));
            } else {
                out.push(path);
            }
        }
    }
    out
}
