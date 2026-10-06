//! `plur1bus secret status|set|get|rm|ls`: the CLI's path to the core's experimental `secret.*` RPC (M2, ADR-005).
//!
//! A value never appears in an argument, an error, a log line or a `--json` document, except as the result of an
//! explicit `get --reveal`. `set` takes it from stdin only; `get` without `--reveal` shows metadata.
use crate::cli::SecretCmd;
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::io::{IsTerminal, Read, Write};
use std::time::Duration;

/// The core's bound on a value (`secret.set`'s `maxLength`, in characters; bytes are checked again by the store).
const MAX_VALUE_BYTES: u64 = 64 * 1024;

pub fn run(out: &Out, layout: &Layout, cmd: SecretCmd) {
    match cmd {
        SecretCmd::Status => {
            let v = call(out, layout, "secret.status", json!({}));
            out.ok("secret.status/1", &v, || render_status(&v));
        }
        SecretCmd::Ls => {
            let v = call(out, layout, "secret.list", json!({}));
            out.ok("secret.ls/1", &v, || render_list(&v));
        }
        SecretCmd::Set { name, rest } => {
            if !rest.is_empty() {
                // clap would echo an unknown argument in its own error; this refusal names nothing the user typed.
                out.fail(
                    "E_INVALID_PARAMS",
                    "a secret value is read from stdin and never from an argument; treat the value you just typed as exposed (shell history, process list) and rotate it",
                    json!({ "reason": "value-in-argument" }),
                    2,
                );
            }
            let value = read_value(out, &mut std::io::stdin());
            // `value` leaves this scope with the request; nothing below formats it.
            let v = call(
                out,
                layout,
                "secret.set",
                json!({ "name": name, "value": value }),
            );
            out.ok("secret.set/1", &v, || {
                format!(
                    "stored {} in the {}",
                    v["name"].as_str().unwrap_or(&name),
                    backend_label(&v["backend"])
                )
            });
        }
        SecretCmd::Get { name, reveal } => {
            let v = call(
                out,
                layout,
                "secret.get",
                json!({ "name": name, "reveal": reveal }),
            );
            out.ok("secret.get/1", &v, || match v["value"].as_str() {
                Some(value) if reveal => value.to_string(),
                _ => render_meta(&v["secret"]),
            });
        }
        SecretCmd::Rm { name, yes } => {
            confirm_remove(out, &name, yes);
            let v = call(out, layout, "secret.delete", json!({ "name": name }));
            out.ok("secret.rm/1", &v, || format!("removed {name}"));
        }
    }
}

fn call(out: &Out, layout: &Layout, method: &str, params: Value) -> Value {
    let mut client = connect_core(out, layout, "secrets", Duration::from_secs(30));
    require_supports(out, &client, method);
    match client.call(method, params) {
        Ok(v) => v,
        Err(e) => out.from_rpc_error(&e),
    }
}

/// The value from `input` (stdin): one trailing newline removed, never empty, never longer than the core accepts.
/// A terminal is refused: there is no echo-free prompt here, and a typed secret would be shown on screen.
fn read_value(out: &Out, input: &mut impl Read) -> String {
    if std::io::stdin().is_terminal() {
        out.fail(
            "E_INVALID_PARAMS",
            "the value is read from stdin and never from an argument: pipe it, e.g. `printf %s \"$VALUE\" | plur1bus secret set NAME`",
            json!({ "reason": "value-from-stdin" }),
            2,
        );
    }
    let mut buf = Vec::new();
    if input
        .take(MAX_VALUE_BYTES + 1)
        .read_to_end(&mut buf)
        .is_err()
    {
        out.fail(
            "E_INVALID_PARAMS",
            "cannot read the value from stdin",
            json!({ "reason": "stdin-unreadable" }),
            2,
        );
    }
    match parse_value(buf) {
        Ok(v) => v,
        Err(why) => out.fail("E_INVALID_PARAMS", why, json!({ "detail": "value" }), 2),
    }
}

/// Pure part of [`read_value`]: strips one trailing `\n` or `\r\n` and validates. The messages never echo the input.
pub(crate) fn parse_value(mut buf: Vec<u8>) -> Result<String, &'static str> {
    if buf.len() as u64 > MAX_VALUE_BYTES {
        return Err("the value is longer than 65536 bytes");
    }
    if buf.ends_with(b"\n") {
        buf.pop();
        if buf.ends_with(b"\r") {
            buf.pop();
        }
    }
    let s = String::from_utf8(buf).map_err(|_| "the value is not valid UTF-8")?;
    if s.is_empty() {
        return Err("the value is empty");
    }
    if s.contains('\0') {
        return Err("the value contains a NUL byte");
    }
    Ok(s)
}

/// G18: destructive. A terminal (and not `--json`) is asked; a script needs `--yes`.
fn confirm_remove(out: &Out, name: &str, yes: bool) {
    if yes {
        return;
    }
    if std::io::stdin().is_terminal() && !out.json {
        eprint!("remove secret {name}? [y/N] ");
        std::io::stderr().flush().ok();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).ok();
        if !line.trim().eq_ignore_ascii_case("y") {
            out.fail(
                "E_INVALID_PARAMS",
                "not applied",
                json!({ "applied": false }),
                2,
            );
        }
    } else {
        out.fail(
            "E_INVALID_PARAMS",
            &format!("re-run with --yes to remove {name}"),
            json!({ "applied": false }),
            2,
        );
    }
}

fn backend_label(b: &Value) -> &'static str {
    match b.as_str() {
        Some("keyring") => "OS keyring",
        Some("file") => "encrypted file store",
        Some("memory") => "in-memory store",
        _ => "secret store",
    }
}

fn render_meta(m: &Value) -> String {
    format!(
        "{}\n  backend:  {}\n  created:  {}\n  updated:  {}\n  (the value is shown only by `plur1bus secret get {} --reveal`)",
        m["name"].as_str().unwrap_or("?"),
        backend_label(&m["backend"]),
        m["createdAt"].as_str().unwrap_or("?"),
        m["updatedAt"].as_str().unwrap_or("?"),
        m["name"].as_str().unwrap_or("NAME"),
    )
}

fn render_list(v: &Value) -> String {
    let rows: Vec<String> = v["secrets"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|m| {
                    format!(
                        "{}  ({}, updated {})",
                        m["name"].as_str().unwrap_or("?"),
                        backend_label(&m["backend"]),
                        m["updatedAt"].as_str().unwrap_or("?")
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    if rows.is_empty() {
        "no secrets".to_string()
    } else {
        rows.join("\n")
    }
}

fn render_status(v: &Value) -> String {
    let backend = v["backend"].as_str().unwrap_or("none");
    let mut lines = vec![match backend {
        "keyring" => "backend: OS keyring".to_string(),
        "file" => "backend: encrypted file (degraded: the OS keyring is not available)".to_string(),
        _ => "backend: none (degraded: no backend can store secrets)".to_string(),
    }];
    let kr = &v["keyring"];
    lines.push(format!(
        "keyring: {}{}",
        if kr["available"].as_bool() == Some(true) {
            "available"
        } else {
            "unavailable"
        },
        kr["reason"]
            .as_str()
            .map(|r| format!(" ({r})"))
            .unwrap_or_default()
    ));
    let f = &v["file"];
    lines.push(format!(
        "encrypted-file fallback: {}{}",
        if f["enabled"].as_bool() == Some(true) {
            "enabled"
        } else {
            "disabled"
        },
        f["reason"]
            .as_str()
            .map(|r| format!(" ({r})"))
            .unwrap_or_default()
    ));
    if let Some(n) = v["count"].as_u64() {
        lines.push(format!("secrets: {n}"));
    }
    if let Some(n) = v["activeLeases"].as_u64().filter(|n| *n > 0) {
        lines.push(format!("active leases: {n}"));
    }
    if let Some(r) = v["remedy"].as_str() {
        lines.push(format!("fix: {r}"));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_strips_one_trailing_newline_only() {
        assert_eq!(parse_value(b"abc\n".to_vec()).unwrap(), "abc");
        assert_eq!(parse_value(b"abc\r\n".to_vec()).unwrap(), "abc");
        assert_eq!(parse_value(b"abc\n\n".to_vec()).unwrap(), "abc\n");
        assert_eq!(parse_value(b"a b".to_vec()).unwrap(), "a b");
    }

    #[test]
    fn value_refuses_empty_oversized_binary_and_nul_without_echoing_it() {
        for bad in [
            b"".to_vec(),
            b"\n".to_vec(),
            vec![b'x'; 64 * 1024 + 1],
            vec![0xff, 0xfe],
            b"a\0b".to_vec(),
        ] {
            let e = parse_value(bad).unwrap_err();
            assert!(!e.contains('x') || e.contains("longer"), "{e}");
        }
        assert_eq!(parse_value(vec![b'x'; 64 * 1024]).unwrap().len(), 64 * 1024);
    }

    #[test]
    fn render_never_prints_a_value_field() {
        let m = json!({"name":"k","backend":"file","createdAt":"a","updatedAt":"b","value":"TOPSECRET"});
        assert!(!render_meta(&m).contains("TOPSECRET"));
        assert!(!render_list(&json!({"secrets":[m]})).contains("TOPSECRET"));
    }

    #[test]
    fn status_text_names_the_remedy_when_nothing_can_serve() {
        let v = json!({"backend":"none","degraded":true,"keyring":{"available":false,"reason":"keyring-unavailable"},"file":{"enabled":false,"available":null},"count":null,"activeLeases":0,"remedy":"set secrets.fileFallback.enabled"});
        let t = render_status(&v);
        assert!(
            t.contains("backend: none")
                && t.contains("keyring-unavailable")
                && t.contains("fix: set secrets.fileFallback.enabled"),
            "{t}"
        );
    }
}
