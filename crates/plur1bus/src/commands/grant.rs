//! `plur1bus grant list|add|revoke`: the CLI's path to the core's experimental `grant.*` RPC (D109, D8).
//!
//! The CLI builds parameters and prints what the core answers; every decision (RBAC, ceilings, never-grantable
//! capabilities, the surface level) is the core's. `once` grants are made only by `approval approve`.
use crate::cli::{GrantAccessArg, GrantAddArgs, GrantCmd, GrantScopeArg};
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::time::Duration;

pub fn run(out: &Out, layout: &Layout, cmd: GrantCmd) {
    match cmd {
        GrantCmd::List {
            agent,
            capability,
            state,
            limit,
        } => {
            let params = list_params(
                agent.as_deref(),
                capability.as_deref(),
                state.map(|s| s.as_str()),
                limit,
            );
            if let Err(why) = &params {
                out.fail("E_INVALID_PARAMS", why, json!({}), 2);
            }
            let v = call(out, layout, "grant.list", params.unwrap_or_default());
            out.ok("grant.list/1", &v, || render_list(&v));
        }
        GrantCmd::Add(args) => {
            let params = match add_params(&args, now_secs()) {
                Ok(p) => p,
                Err(why) => out.fail("E_INVALID_PARAMS", &why, json!({}), 2),
            };
            let v = call(out, layout, "grant.create", params);
            out.ok("grant.add/1", &v, || {
                format!("granted\n{}", render_grant(&v))
            });
        }
        GrantCmd::Revoke { id, reason } => {
            let v = call(out, layout, "grant.revoke", json!({ "id": id }));
            // `grant.revoke` takes only an id: the note is echoed, never sent.
            let doc = match &reason {
                Some(r) => {
                    let mut d = v.clone();
                    d["note"] = json!(clean(r));
                    d
                }
                None => v.clone(),
            };
            out.ok("grant.revoke/1", &doc, || {
                format!(
                    "revoked {}{}",
                    clean(v["id"].as_str().unwrap_or(&id)),
                    reason
                        .as_deref()
                        .map(|r| format!(" ({})", clean(r)))
                        .unwrap_or_default()
                )
            });
        }
    }
}

fn call(out: &Out, layout: &Layout, method: &str, params: Value) -> Value {
    let mut client = connect_core(out, layout, "grants", Duration::from_secs(30));
    require_supports(out, &client, method);
    match client.call(method, params) {
        Ok(v) => v,
        Err(e) => out.from_rpc_error(&e),
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Text from the core for a terminal: control characters (escape sequences) become spaces.
pub(crate) fn clean(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

pub(crate) fn list_params(
    agent: Option<&str>,
    capability: Option<&str>,
    state: Option<&str>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let mut p = json!({});
    if let Some(a) = agent {
        p["agent"] = json!(a);
    }
    if let Some(c) = capability {
        p["capability"] = json!(c);
    }
    if let Some(s) = state {
        p["state"] = json!(s);
    }
    if let Some(l) = limit {
        if !(1..=500).contains(&l) {
            return Err("--limit must be between 1 and 500".into());
        }
        p["limit"] = json!(l);
    }
    Ok(p)
}

/// `grant.create` params from the flags, or the reason they are refused (exit 2, before any connection).
pub(crate) fn add_params(a: &GrantAddArgs, now: u64) -> Result<Value, String> {
    if a.capability.is_empty() || a.capability.len() > 64 {
        return Err("the capability must be 1-64 characters".into());
    }
    if a.agent.is_empty() || a.agent.len() > 128 {
        return Err("--agent must be 1-128 characters".into());
    }
    let mut p = json!({ "capability": a.capability, "agent": a.agent, "scope": a.scope.as_str() });
    match (a.scope, &a.task_id, &a.session_id) {
        (GrantScopeArg::Task, Some(t), None) => p["taskId"] = json!(t),
        (GrantScopeArg::Task, None, _) => return Err("--scope task needs --task-id".into()),
        (GrantScopeArg::Session, None, Some(s)) => p["sessionId"] = json!(s),
        (GrantScopeArg::Session, _, None) => return Err("--scope session needs --session-id".into()),
        (GrantScopeArg::Always, None, None) => {}
        _ => {
            return Err(
                "--task-id belongs to --scope task and --session-id to --scope session, one of them at most"
                    .into(),
            )
        }
    }
    if let Some(path) = &a.path {
        if path.is_empty() || path.len() > 4096 {
            return Err("--path must be 1-4096 characters".into());
        }
        p["match"] = json!({
            "kind": "path",
            "path": path,
            "access": a.access.unwrap_or(GrantAccessArg::Read).as_str(),
            "recursive": a.recursive,
        });
    }
    if let Some(e) = &a.expires {
        p["expiresAt"] = json!(parse_expires(e, now)?);
    }
    if a.delegable {
        p["delegable"] = json!(true);
    }
    Ok(p)
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = i64::from((m + 9) % 12);
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn format_rfc3339(secs: u64) -> String {
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let r = secs % 86_400;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        r / 3600,
        r % 3600 / 60,
        r % 60
    )
}

/// `30m`, `12h`, `7d` (from `now`) or an RFC 3339 UTC time `YYYY-MM-DDTHH:MM:SSZ` to an RFC 3339 UTC string.
/// A time that is not in the future is refused.
pub(crate) fn parse_expires(s: &str, now: u64) -> Result<String, String> {
    let bad = || {
        "--expires takes a duration (30m, 12h, 7d) or an RFC 3339 UTC time such as 2026-12-31T23:59:59Z, in the future"
            .to_string()
    };
    let b = s.as_bytes();
    let at = if let Some(unit) = s.chars().last().filter(|c| matches!(c, 'm' | 'h' | 'd')) {
        let n: u64 = s[..s.len() - 1]
            .parse()
            .ok()
            .filter(|n| *n > 0 && *n <= 36_500)
            .ok_or_else(bad)?;
        let mult = match unit {
            'm' => 60,
            'h' => 3600,
            _ => 86_400,
        };
        now + n * mult
    } else {
        let shape = b.len() == 20
            && b[4] == b'-'
            && b[7] == b'-'
            && b[10] == b'T'
            && b[13] == b':'
            && b[16] == b':'
            && b[19] == b'Z'
            && b.iter()
                .enumerate()
                .all(|(i, c)| matches!(i, 4 | 7 | 10 | 13 | 16 | 19) || c.is_ascii_digit());
        if !shape {
            return Err(bad());
        }
        let n = |r: std::ops::Range<usize>| s[r].parse::<u32>().unwrap_or(99);
        let (y, mo, d, h, mi, se) = (n(0..4), n(5..7), n(8..10), n(11..13), n(14..16), n(17..19));
        let leap =
            |y: u32| (y.is_multiple_of(4) && !y.is_multiple_of(100)) || y.is_multiple_of(400);
        let dim = match mo {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 if leap(y) => 29,
            2 => 28,
            _ => 0,
        };
        if d == 0 || d > dim || h > 23 || mi > 59 || se > 59 {
            return Err(bad());
        }
        let t = days_from_civil(i64::from(y), mo, d) * 86_400
            + i64::from(h) * 3600
            + i64::from(mi) * 60
            + i64::from(se);
        u64::try_from(t).map_err(|_| bad())?
    };
    if at <= now {
        return Err(bad());
    }
    Ok(format_rfc3339(at))
}

pub(crate) fn render_grant(g: &Value) -> String {
    let s = |k: &str| clean(g[k].as_str().unwrap_or("?"));
    let mut head = format!(
        "{}  {}  agent {}  {}  {}",
        s("id"),
        s("capability"),
        s("agent"),
        s("scope"),
        s("state")
    );
    if let Some(t) = g["taskId"].as_str() {
        head.push_str(&format!("  task {}", clean(t)));
    }
    if let Some(t) = g["sessionId"].as_str() {
        head.push_str(&format!("  session {}", clean(t)));
    }
    let mut lines = vec![head];
    let m = &g["match"];
    if m["kind"].as_str() == Some("path") {
        lines.push(format!(
            "  path {} ({}{})",
            clean(m["path"].as_str().unwrap_or("?")),
            clean(m["access"].as_str().unwrap_or("?")),
            if m["recursive"].as_bool() == Some(true) {
                ", recursive"
            } else {
                ""
            }
        ));
    }
    let mut tail = vec![format!("created {}", s("createdAt"))];
    if let Some(e) = g["expiresAt"].as_str() {
        tail.push(format!("expires {}", clean(e)));
    }
    if let Some(e) = g["lastUsedAt"].as_str() {
        tail.push(format!("last used {}", clean(e)));
    }
    if let Some(e) = g["revokedAt"].as_str() {
        tail.push(format!("revoked {}", clean(e)));
    }
    if g["delegable"].as_bool() == Some(true) {
        tail.push("delegable".into());
    }
    lines.push(format!("  {}", tail.join(", ")));
    lines.join("\n")
}

pub(crate) fn render_list(v: &Value) -> String {
    let grants = v["grants"].as_array().cloned().unwrap_or_default();
    if grants.is_empty() {
        return "no grants".into();
    }
    let mut out: Vec<String> = grants.iter().map(render_grant).collect();
    if v["nextCursor"].as_str().is_some() {
        out.push("... more grants exist (narrow with --agent, --capability or --state)".into());
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Cmd};
    use clap::Parser;

    fn add(args: &[&str]) -> Result<GrantAddArgs, clap::Error> {
        let mut v = vec!["plur1bus", "grant", "add"];
        v.extend(args);
        match Cli::try_parse_from(v)?.cmd {
            Cmd::Grant {
                sub: GrantCmd::Add(a),
            } => Ok(a),
            other => panic!("not grant add: {other:?}"),
        }
    }

    #[test]
    fn list_parses_filters() {
        let c = Cli::try_parse_from([
            "plur1bus",
            "grant",
            "list",
            "--agent",
            "main",
            "--capability",
            "fs.write",
            "--state",
            "active",
        ])
        .unwrap();
        match c.cmd {
            Cmd::Grant {
                sub:
                    GrantCmd::List {
                        agent,
                        capability,
                        state,
                        ..
                    },
            } => {
                assert_eq!(agent.as_deref(), Some("main"));
                assert_eq!(capability.as_deref(), Some("fs.write"));
                assert_eq!(state.unwrap().as_str(), "active");
            }
            o => panic!("{o:?}"),
        }
        assert!(Cli::try_parse_from(["plur1bus", "grant", "list", "--state", "bogus"]).is_err());
    }

    #[test]
    fn list_params_only_carry_given_filters() {
        assert_eq!(list_params(None, None, None, None).unwrap(), json!({}));
        assert_eq!(
            list_params(Some("a"), Some("c"), Some("active"), Some(5)).unwrap(),
            json!({"agent":"a","capability":"c","state":"active","limit":5})
        );
        assert!(list_params(None, None, None, Some(0)).is_err());
        assert!(list_params(None, None, None, Some(501)).is_err());
    }

    #[test]
    fn add_requires_agent_and_scope_and_refuses_once() {
        assert!(add(&["fs.write", "--scope", "always"]).is_err());
        assert!(add(&["fs.write", "--agent", "a"]).is_err());
        assert!(add(&["fs.write", "--agent", "a", "--scope", "once"]).is_err());
        assert!(add(&["fs.write", "--agent", "a", "--scope", "always"]).is_ok());
    }

    #[test]
    fn add_access_and_recursive_need_a_path() {
        assert!(add(&["c", "--agent", "a", "--scope", "always", "--access", "read"]).is_err());
        assert!(add(&["c", "--agent", "a", "--scope", "always", "--recursive"]).is_err());
        assert!(
            add(&["c", "--agent", "a", "--scope", "always", "--path", "/x", "--access", "rw"])
                .is_err()
        );
    }

    #[test]
    fn add_params_for_each_scope() {
        let a = add(&["fs.write", "--agent", "main", "--scope", "always"]).unwrap();
        assert_eq!(
            add_params(&a, 0).unwrap(),
            json!({"capability":"fs.write","agent":"main","scope":"always"})
        );
        let a = add(&[
            "c",
            "--agent",
            "m",
            "--scope",
            "task",
            "--task-id",
            "t1",
            "--delegable",
        ])
        .unwrap();
        assert_eq!(
            add_params(&a, 0).unwrap(),
            json!({"capability":"c","agent":"m","scope":"task","taskId":"t1","delegable":true})
        );
        let a = add(&[
            "c",
            "--agent",
            "m",
            "--scope",
            "session",
            "--session-id",
            "s1",
        ])
        .unwrap();
        assert_eq!(add_params(&a, 0).unwrap()["sessionId"], "s1");
    }

    #[test]
    fn add_params_refuse_missing_or_stray_ids() {
        let a = add(&["c", "--agent", "m", "--scope", "task"]).unwrap();
        assert!(add_params(&a, 0).unwrap_err().contains("--task-id"));
        let a = add(&["c", "--agent", "m", "--scope", "session"]).unwrap();
        assert!(add_params(&a, 0).unwrap_err().contains("--session-id"));
        let a = add(&["c", "--agent", "m", "--scope", "always", "--task-id", "t"]).unwrap();
        assert!(add_params(&a, 0).is_err());
        let a = add(&[
            "c",
            "--agent",
            "m",
            "--scope",
            "task",
            "--task-id",
            "t",
            "--session-id",
            "s",
        ])
        .unwrap();
        assert!(add_params(&a, 0).is_err());
    }

    #[test]
    fn add_params_path_match() {
        let a = add(&[
            "fs.write",
            "--agent",
            "m",
            "--scope",
            "always",
            "--path",
            "/srv/data",
            "--access",
            "write",
            "--recursive",
        ])
        .unwrap();
        assert_eq!(
            add_params(&a, 0).unwrap()["match"],
            json!({"kind":"path","path":"/srv/data","access":"write","recursive":true})
        );
        // a path without --access means read, and is not recursive unless asked
        let a = add(&[
            "fs.read", "--agent", "m", "--scope", "always", "--path", "/srv",
        ])
        .unwrap();
        assert_eq!(
            add_params(&a, 0).unwrap()["match"],
            json!({"kind":"path","path":"/srv","access":"read","recursive":false})
        );
        let a = add(&["fs.read", "--agent", "m", "--scope", "always", "--path", ""]).unwrap();
        assert!(add_params(&a, 0).is_err());
    }

    #[test]
    fn expires_relative_and_absolute() {
        // 2026-10-07T00:00:00Z
        let now = 1_791_331_200;
        assert_eq!(parse_expires("30m", now).unwrap(), "2026-10-07T00:30:00Z");
        assert_eq!(parse_expires("12h", now).unwrap(), "2026-10-07T12:00:00Z");
        assert_eq!(parse_expires("7d", now).unwrap(), "2026-10-14T00:00:00Z");
        assert_eq!(
            parse_expires("2026-12-31T23:59:59Z", now).unwrap(),
            "2026-12-31T23:59:59Z"
        );
        for bad in [
            "",
            "0m",
            "5x",
            "m",
            "-1h",
            "2026-13-01T00:00:00Z",
            "2026-12-31",
            "2026-12-31T23:59:59+01:00",
            "2026-10-06T00:00:00Z",
        ] {
            assert!(parse_expires(bad, now).is_err(), "{bad}");
        }
    }

    #[test]
    fn render_names_the_essentials_and_strips_escapes() {
        let g = json!({"id":"grt_1","capability":"fs.write","agent":"main","scope":"always","state":"active",
            "match":{"kind":"path","path":"/srv\u{1b}[31m","access":"write","recursive":true},
            "createdAt":"2026-10-07T00:00:00Z","expiresAt":"2027-01-01T00:00:00Z","delegable":false});
        let t = render_grant(&g);
        assert!(
            t.contains("grt_1")
                && t.contains("fs.write")
                && t.contains("main")
                && t.contains("always")
        );
        assert!(t.contains("write") && t.contains("recursive") && t.contains("expires 2027-01-01"));
        assert!(!t.contains('\u{1b}'));
        assert_eq!(render_list(&json!({"grants":[]})), "no grants");
        let l = render_list(&json!({"grants":[g],"nextCursor":"c"}));
        assert!(l.contains("grt_1") && l.contains("more"));
    }
}
