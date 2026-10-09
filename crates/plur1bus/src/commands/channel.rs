//! `plur1bus channel list|show|enable|disable|set|test|status|link-help` (R3): channel management over the core's
//! `channel.*` RPC, which is generic over the switchboard registry and the `channels.*` config schema. Nothing here
//! knows one channel from another.
//!
//! A secret never travels through this command: a `*Secret` key takes a secret NAME (`plur1bus secret set <name>` stores
//! the value, from stdin). When the core refuses a value that looks like a credential, the refusal names no part of
//! it and says to treat what was typed as exposed.
use crate::output::Out;
use crate::paths::Layout;
use clap::Subcommand;
use plur1bus_rpc::RpcError;
use serde_json::{json, Value};

#[derive(Debug, Subcommand)]
pub enum ChannelCmd {
    /// [experimental] List the channels: enabled, configured, state and health
    List,
    /// [experimental] Show one channel: effective configuration (secrets as names), health and its last error
    Show {
        /// the channel id, as `channel list` prints it
        id: String,
    },
    /// [experimental] Enable a channel (writes channels.<id>.enabled; its module restarts)
    Enable {
        /// the channel id
        id: String,
    },
    /// [experimental] Disable a channel (writes channels.<id>.enabled; its module restarts)
    Disable {
        /// the channel id
        id: String,
    },
    /// [experimental] Set one key of a channel, validated against the config schema
    ///
    /// The key is the path under channels.<id> (for example `allowlist` or `imap.host`); lists and objects are JSON.
    /// A key ending in `Secret` takes the NAME of a secret, never its value: store the value with
    /// `plur1bus secret set <name>` (it is read from stdin) and pass the name here.
    #[command(after_long_help = "\
Examples:
  plur1bus channel set discord allowlist '[\"123456789012345678\"]'
  plur1bus channel set discord replyPolicy mention
  plur1bus channel set discord tokenSecret channels.discord.token")]
    Set {
        /// the channel id
        id: String,
        /// the key path under channels.<id>
        key: String,
        /// the new value (a secret NAME for a `*Secret` key)
        #[arg(allow_hyphen_values = true)]
        value: String,
    },
    /// [experimental] Check a channel's health; --send-owner also sends a test message to your own linked identity
    Test {
        /// the channel id
        id: String,
        /// send one fixed test message to your own linked identity on this channel (never to anyone else)
        #[arg(long)]
        send_owner: bool,
    },
    /// [experimental] All channels, compact
    Status,
    /// [experimental] How /link pairing works on a channel
    LinkHelp {
        /// the channel id
        id: String,
    },
}

/// The RPC method and params of a subcommand (pure, so the mapping is unit-tested without a core).
pub fn request(cmd: &ChannelCmd) -> (&'static str, Value) {
    match cmd {
        ChannelCmd::List => ("channel.list", json!({})),
        ChannelCmd::Status => ("channel.status", json!({})),
        ChannelCmd::Show { id } | ChannelCmd::LinkHelp { id } => {
            ("channel.get", json!({ "id": id }))
        }
        ChannelCmd::Enable { id } => ("channel.enable", json!({ "id": id })),
        ChannelCmd::Disable { id } => ("channel.disable", json!({ "id": id })),
        // `text`, not `value`: the core reads the raw text by the key's schema type, so ids with leading zeros survive.
        ChannelCmd::Set { id, key, value } => (
            "channel.set",
            json!({ "id": id, "key": key, "text": value }),
        ),
        ChannelCmd::Test { id, send_owner } => {
            let mut p = json!({ "id": id });
            if *send_owner {
                p["sendOwner"] = json!(true);
            }
            ("channel.test", p)
        }
    }
}

const EXPOSED: &str =
    "treat the value you just typed as exposed (shell history, process list) and rotate it";

/// `Some(message)` when the core refused a credential-shaped value; the message adds the exposure notice.
fn secret_refusal(e: &RpcError) -> Option<String> {
    match e {
        RpcError::Call {
            reason: Some(r),
            message,
            ..
        } if r == "secret-value" => Some(format!("{message}; {EXPOSED}")),
        _ => None,
    }
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}

fn yes_no(v: &Value) -> &'static str {
    if v.as_bool() == Some(true) {
        "yes"
    } else {
        "no"
    }
}

fn table(header: &[&str], rows: &[Vec<String>]) -> String {
    let mut widths: Vec<usize> = header.iter().map(|h| h.len()).collect();
    for r in rows {
        for (i, c) in r.iter().enumerate() {
            widths[i] = widths[i].max(c.chars().count());
        }
    }
    let line = |cells: Vec<&str>| {
        cells
            .iter()
            .enumerate()
            .map(|(i, c)| format!("{c:<w$}", w = widths[i]))
            .collect::<Vec<_>>()
            .join("  ")
            .trim_end()
            .to_string()
    };
    let mut out = vec![line(header.to_vec())];
    for r in rows {
        out.push(line(r.iter().map(String::as_str).collect()));
    }
    out.join("\n")
}

const NO_HOST: &str =
    "\nThis core runs no switchboard host, so no channel has a runtime state here.";

pub(crate) fn render_list(v: &Value) -> String {
    let rows: Vec<Vec<String>> = v["channels"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|c| {
                    vec![
                        s(c, "id").to_string(),
                        yes_no(&c["enabled"]).to_string(),
                        yes_no(&c["configured"]).to_string(),
                        s(c, "state").to_string(),
                        s(c, "health").to_string(),
                    ]
                })
                .collect()
        })
        .unwrap_or_default();
    let mut out = table(&["ID", "ENABLED", "CONFIGURED", "STATE", "HEALTH"], &rows);
    if v["host"] == json!(false) {
        out.push_str(NO_HOST);
    }
    out
}

pub(crate) fn render_status(v: &Value) -> String {
    let mut lines: Vec<String> = v["channels"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|c| {
                    let mut l = format!(
                        "{}: {} ({}{})",
                        s(c, "id"),
                        s(c, "state"),
                        s(c, "health"),
                        if c["enabled"] == json!(true) {
                            ", enabled"
                        } else {
                            ", disabled"
                        }
                    );
                    if let Some(e) = c["lastError"].as_str() {
                        l.push_str(&format!(" last error: {e}"));
                    }
                    l
                })
                .collect()
        })
        .unwrap_or_default();
    if v["host"] == json!(false) {
        lines.push(NO_HOST.trim_start().to_string());
    }
    lines.join("\n")
}

pub(crate) fn render_show(v: &Value) -> String {
    let mut out = vec![format!("{} ({})", s(v, "displayName"), s(v, "id"))];
    if let Some(d) = v["description"].as_str() {
        out.push(d.to_string());
    }
    out.push(format!("enabled: {}", yes_no(&v["enabled"])));
    out.push(format!("configured: {}", yes_no(&v["configured"])));
    out.push(format!(
        "state: {} (health {})",
        s(v, "state"),
        s(v, "health")
    ));
    if let Some(p) = v.get("probe").filter(|p| p.is_object()) {
        out.push(format!(
            "probe: {}{}",
            if p["ok"] == json!(true) {
                "ok"
            } else {
                "failing"
            },
            p["detail"]
                .as_str()
                .map(|d| format!(" ({d})"))
                .unwrap_or_default()
        ));
    }
    if let Some(e) = v["lastError"].as_str() {
        out.push(format!("last error: {e}"));
    }
    out.push(format!("restart class: {}", s(v, "restart")));
    if let Some(missing) = v["missing"].as_array().filter(|m| !m.is_empty()) {
        let names: Vec<&str> = missing.iter().filter_map(Value::as_str).collect();
        out.push(format!("missing: {}", names.join(", ")));
    }
    if let Some(secrets) = v["secrets"].as_array().filter(|m| !m.is_empty()) {
        out.push("secrets (names only):".to_string());
        for x in secrets {
            out.push(format!(
                "  {} -> {} ({})",
                s(x, "key"),
                s(x, "name"),
                if x["present"] == json!(true) {
                    "stored"
                } else {
                    "not stored"
                }
            ));
        }
    }
    out.push(format!(
        "config: {}",
        serde_json::to_string_pretty(&v["config"]).unwrap_or_default()
    ));
    out.join("\n")
}

fn restart_note(v: &Value) -> String {
    let mods: Vec<&str> = v["restart"]["modules"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut parts: Vec<String> = mods
        .iter()
        .map(|m| format!("restarts module {m}"))
        .collect();
    if v["restart"]["core"] == json!(true) {
        parts.push("restarts the core".to_string());
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" ({})", parts.join(", "))
    }
}

fn missing_hint(v: &Value) -> String {
    let names: Vec<&str> = v["missing"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if names.is_empty() {
        return String::new();
    }
    let hints: Vec<String> = names
        .iter()
        .filter_map(|n| n.strip_prefix("secret:"))
        .map(|n| format!("  store it: plur1bus secret set {n}"))
        .collect();
    format!(
        "\nnot configured yet, missing: {}\n{}",
        names.join(", "),
        hints.join("\n")
    )
}

pub(crate) fn render_toggle(v: &Value) -> String {
    let state = if v["enabled"] == json!(true) {
        "enabled"
    } else {
        "disabled"
    };
    if v["changed"] == json!(false) {
        return format!("{} is already {state}", s(v, "id"));
    }
    format!(
        "{} {state}{}{}",
        s(v, "id"),
        restart_note(v),
        missing_hint(v)
    )
}

pub(crate) fn render_set(v: &Value) -> String {
    let what = format!("{}.{}", s(v, "id"), s(v, "key"));
    if v["changed"] == json!(false) {
        return format!("{what} already has that value");
    }
    if let Some(sec) = v.get("secret").filter(|x| x.is_object()) {
        return format!(
            "{what} now refers to secret {} ({}){}",
            s(sec, "name"),
            if sec["present"] == json!(true) {
                "stored"
            } else {
                "not stored yet: plur1bus secret set"
            },
            restart_note(v)
        );
    }
    format!(
        "{what} set to {}{}",
        serde_json::to_string(&v["value"]).unwrap_or_default(),
        restart_note(v)
    )
}

pub(crate) fn render_test(v: &Value) -> String {
    let mut l = format!(
        "{}: {} (state {}{})",
        s(v, "id"),
        if v["ok"] == json!(true) {
            "ok"
        } else {
            "failing"
        },
        s(v, "state"),
        v["detail"]
            .as_str()
            .map(|d| format!(", {d}"))
            .unwrap_or_default()
    );
    if v["sent"] == json!(true) {
        l.push_str("\ntest message sent to your linked identity");
    }
    l
}

pub fn run(out: &Out, layout: &Layout, cmd: ChannelCmd) {
    let (method, params) = request(&cmd);
    let value = match try_call(out, layout, method, params) {
        Ok(v) => v,
        Err(e) => match secret_refusal(&e) {
            Some(message) => out.fail(
                "E_INVALID_PARAMS",
                &message,
                json!({ "reason": "secret-value" }),
                2,
            ),
            None => out.from_rpc_error(&e),
        },
    };
    match cmd {
        ChannelCmd::List => out.ok("channel.list/1", &value, || render_list(&value)),
        ChannelCmd::Status => out.ok("channel.status/1", &value, || render_status(&value)),
        ChannelCmd::Show { .. } => out.ok("channel.get/1", &value, || render_show(&value)),
        ChannelCmd::Enable { .. } | ChannelCmd::Disable { .. } => {
            out.ok(&format!("{method}/1"), &value, || render_toggle(&value))
        }
        ChannelCmd::Set { .. } => out.ok("channel.set/1", &value, || render_set(&value)),
        ChannelCmd::Test { .. } => {
            out.ok("channel.test/1", &value, || render_test(&value));
            // A failing check is a failing command, so a script can branch on it.
            if value["ok"] != json!(true) {
                crate::output::exit(1);
            }
        }
        ChannelCmd::LinkHelp { .. } => {
            let help = json!({ "id": value["id"], "linkHelp": value["linkHelp"] });
            out.ok("channel.link-help/1", &help, || {
                s(&value, "linkHelp").to_string()
            });
        }
    }
}

/// [`call`] keeping the error, so a refused secret can be reported with its exposure notice.
fn try_call(out: &Out, layout: &Layout, method: &str, params: Value) -> Result<Value, RpcError> {
    use crate::commands::memory_ops::{connect_core, require_supports};
    let mut client = connect_core(out, layout, method, std::time::Duration::from_secs(30));
    require_supports(out, &client, method);
    client.call(method, params)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Cmd};
    use clap::Parser;

    fn parse(args: &[&str]) -> ChannelCmd {
        let mut v = vec!["plur1bus", "--json", "channel"];
        v.extend_from_slice(args);
        match Cli::try_parse_from(v).unwrap().cmd {
            Cmd::Channel { sub } => sub,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn every_subcommand_maps_to_its_rpc_method() {
        let cases: &[(&[&str], &str, Value)] = &[
            (&["list"], "channel.list", json!({})),
            (&["status"], "channel.status", json!({})),
            (&["show", "discord"], "channel.get", json!({"id":"discord"})),
            (
                &["link-help", "slack"],
                "channel.get",
                json!({"id":"slack"}),
            ),
            (
                &["enable", "discord"],
                "channel.enable",
                json!({"id":"discord"}),
            ),
            (
                &["disable", "discord"],
                "channel.disable",
                json!({"id":"discord"}),
            ),
            (
                &["test", "discord"],
                "channel.test",
                json!({"id":"discord"}),
            ),
            (
                &["test", "discord", "--send-owner"],
                "channel.test",
                json!({"id":"discord","sendOwner":true}),
            ),
            (
                &["set", "discord", "locale", "de"],
                "channel.set",
                json!({"id":"discord","key":"locale","text":"de"}),
            ),
        ];
        for (args, method, params) in cases {
            let (m, p) = request(&parse(args));
            assert_eq!((m, &p), (*method, params), "{args:?}");
        }
    }

    #[test]
    fn set_keeps_the_raw_text_and_takes_a_leading_hyphen() {
        let (_, p) = request(&parse(&["set", "signal", "account", "+4915112345678"]));
        assert_eq!(p["text"], "+4915112345678");
        let (_, p) = request(&parse(&["set", "discord", "applicationId", "0001234567"]));
        assert_eq!(p["text"], "0001234567");
        let (_, p) = request(&parse(&["set", "discord", "allowlist", "-1"]));
        assert_eq!(p["text"], "-1");
    }

    #[test]
    fn arguments_are_required_and_closed() {
        for bad in [
            vec!["plur1bus", "channel", "show"],
            vec!["plur1bus", "channel", "set", "discord", "locale"],
            vec!["plur1bus", "channel", "enable", "a", "b"],
            vec!["plur1bus", "channel", "test", "discord", "--to", "x"],
            vec!["plur1bus", "channel", "frobnicate"],
        ] {
            assert!(Cli::try_parse_from(bad.clone()).is_err(), "{bad:?}");
        }
        // The plain `channel` without a subcommand is a usage error, not a stub.
        assert!(Cli::try_parse_from(["plur1bus", "channel"]).is_err());
        // `test` has no recipient argument at all.
        let (_, p) = request(&parse(&["test", "discord", "--send-owner"]));
        assert_eq!(p.as_object().unwrap().len(), 2);
    }

    #[test]
    fn a_refused_credential_is_reported_without_the_value() {
        let value = "xoxb-not-a-real-token";
        let e = RpcError::Call {
            error: plur1bus_rpc::types::ErrorCode::EInvalidParams,
            jsonrpc: -32000,
            message: "tokenSecret takes the NAME of a secret, not its value".into(),
            reason: Some("secret-value".into()),
            detail: None,
            ids: None,
            ext: None,
        };
        let m = secret_refusal(&e).unwrap();
        assert!(m.contains("NAME of a secret") && m.contains("rotate it"));
        assert!(!m.contains(value));
        let other = RpcError::Protocol("x".into());
        assert!(secret_refusal(&other).is_none());
    }

    #[test]
    fn list_and_status_render_a_table_and_the_no_host_note() {
        let v = json!({"host": false, "channels": [
            {"id":"discord","displayName":"Discord","enabled":true,"configured":false,"state":"not-registered","health":"unknown"},
            {"id":"email","displayName":"Email","enabled":false,"configured":true,"state":"running","health":"ok"}]});
        let t = render_list(&v);
        let lines: Vec<&str> = t.lines().collect();
        assert_eq!(
            lines[0],
            "ID       ENABLED  CONFIGURED  STATE           HEALTH"
        );
        assert_eq!(
            lines[1],
            "discord  yes      no          not-registered  unknown"
        );
        assert!(t.contains("no switchboard host"));
        let st = json!({"host": true, "channels": [
            {"id":"slack","enabled":true,"state":"backoff","health":"failing","lastError":"boom"}]});
        assert_eq!(
            render_status(&st),
            "slack: backoff (failing, enabled) last error: boom"
        );
    }

    #[test]
    fn show_prints_secret_names_never_values() {
        let v = json!({"id":"discord","displayName":"Discord","enabled":true,"configured":false,"state":"running","health":"ok",
            "restart":"module:discord","missing":["secret:channels.discord.token"],
            "secrets":[{"key":"tokenSecret","name":"channels.discord.token","present":false}],
            "config":{"enabled":true,"tokenSecret":{"secret":"channels.discord.token","present":false}},
            "probe":{"ok":false,"detail":"gateway down"},"lastError":"boom","attempts":1,"linkHelp":"x"});
        let t = render_show(&v);
        assert!(t.contains("tokenSecret -> channels.discord.token (not stored)"));
        assert!(t.contains("missing: secret:channels.discord.token"));
        assert!(t.contains("probe: failing (gateway down)"));
        assert!(t.contains("restart class: module:discord"));
    }

    #[test]
    fn toggle_set_and_test_results_read_plainly() {
        let on = json!({"id":"discord","enabled":true,"changed":true,"restart":{"live":[],"core":false,"modules":["discord"]},"missing":["secret:channels.discord.token"]});
        let t = render_toggle(&on);
        assert!(t.starts_with("discord enabled (restarts module discord)"));
        assert!(t.contains("plur1bus secret set channels.discord.token"));
        let same = json!({"id":"discord","enabled":false,"changed":false,"restart":{"live":[],"core":false,"modules":[]},"missing":[]});
        assert_eq!(render_toggle(&same), "discord is already disabled");
        let set = json!({"id":"discord","key":"allowlist","changed":true,"restart":{"live":[],"core":false,"modules":["discord"]},"value":["1"]});
        assert_eq!(
            render_set(&set),
            "discord.allowlist set to [\"1\"] (restarts module discord)"
        );
        let sec = json!({"id":"discord","key":"tokenSecret","changed":true,"restart":{"live":[],"core":false,"modules":[]},"secret":{"name":"a.b","present":true}});
        assert_eq!(
            render_set(&sec),
            "discord.tokenSecret now refers to secret a.b (stored)"
        );
        let test = json!({"id":"discord","ok":false,"state":"running","detail":"gateway down","sent":false});
        assert_eq!(
            render_test(&test),
            "discord: failing (state running, gateway down)"
        );
        let sent = json!({"id":"discord","ok":true,"state":"running","sent":true});
        assert!(render_test(&sent).ends_with("test message sent to your linked identity"));
    }
}
