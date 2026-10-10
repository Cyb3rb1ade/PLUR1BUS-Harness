//! `plur1bus approval list|pending|approve|deny|verify`: the CLI's path to the core's experimental `approval.*` RPC
//! (D109, D8).
//!
//! `approve` is the one command here that grants authority, so it never acts silently: it fetches the request,
//! prints exactly what the core recorded (redacted command line or diff summary, targets, risk), and asks a person at
//! a terminal; outside a terminal it needs `--yes`. There is no password path and no nonce argument: the nonce is for
//! channel relays, and the CLI's own connection carries its surface level. Raw tool arguments are not part of an
//! approval record and are never printed.
use crate::cli::ApprovalCmd;
use crate::commands::grant::clean;
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::io::{IsTerminal, Write};
use std::time::Duration;

/// What `approve` may do before it asks the core for anything.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Gate {
    /// `--yes`: the request is printed, then decided.
    Proceed,
    /// A person at a terminal confirms after reading the request.
    Prompt,
    /// No terminal (or `--json`) and no `--yes`: refuse without connecting.
    Refuse,
}

pub(crate) fn gate(yes: bool, stdin_is_terminal: bool, json: bool) -> Gate {
    if yes {
        Gate::Proceed
    } else if stdin_is_terminal && !json {
        Gate::Prompt
    } else {
        Gate::Refuse
    }
}

pub(crate) fn list_params(
    status: Option<&str>,
    agent: Option<&str>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let mut p = json!({});
    if let Some(s) = status {
        p["status"] = json!(s);
    }
    if let Some(a) = agent {
        p["agent"] = json!(a);
    }
    if let Some(l) = limit {
        if !(1..=500).contains(&l) {
            return Err("--limit must be between 1 and 500".into());
        }
        p["limit"] = json!(l);
    }
    Ok(p)
}

pub(crate) fn decide_params(
    id: &str,
    decision: &str,
    scope: Option<&str>,
    delegable: bool,
    attest: bool,
) -> Value {
    let mut p = json!({ "id": id, "decision": decision });
    if let Some(s) = scope {
        p["scope"] = json!(s);
    }
    if delegable {
        p["delegable"] = json!(true);
    }
    if attest {
        p["attest"] = json!(true);
    }
    p
}

/// Issue #192: the core answers `E_APPROVAL_REQUIRED reason=attestation-required` (detail: the method it will ask) when this
/// connection can decide the request only with one confirmation by the operating system.
pub(crate) fn attestation_needed(e: &plur1bus_rpc::RpcError) -> Option<String> {
    match e {
        plur1bus_rpc::RpcError::Call { reason, detail, .. }
            if e.code_name() == "E_APPROVAL_REQUIRED"
                && reason.as_deref() == Some("attestation-required") =>
        {
            Some(detail.clone().unwrap_or_default())
        }
        _ => None,
    }
}

/// What the person will be asked to do, in the words of their system.
pub(crate) fn method_label(method: &str) -> String {
    match method {
        "touch-id" => "Touch ID (or your Mac password)".into(),
        "macos-password" => "your Mac password".into(),
        "windows-hello" => "Windows Hello".into(),
        "uac" => "the Windows consent prompt (UAC)".into(),
        "polkit" => "your system password (polkit)".into(),
        "" => "the operating system".into(),
        other => clean(other),
    }
}

pub(crate) fn attestation_notice(method: &str) -> String {
    format!(
        "This decision needs one confirmation by the operating system: {}. Confirm in the dialog on this machine (it covers this approval only and expires after 60 s).",
        method_label(method)
    )
}

/// `Some(reason)` when `scope` is not among the request's `grantOptions` (an empty list offers no choice).
pub(crate) fn scope_not_offered(record: &Value, scope: &str) -> Option<String> {
    let opts = record["grantOptions"]
        .as_array()
        .filter(|a| !a.is_empty())?;
    let offered: Vec<&str> = opts.iter().filter_map(|o| o["scope"].as_str()).collect();
    if offered.contains(&scope) {
        None
    } else {
        Some(format!(
            "this request does not offer scope {scope}; it offers: {}",
            offered.join(", ")
        ))
    }
}

fn s(v: &Value, k: &str) -> String {
    clean(v[k].as_str().unwrap_or("?"))
}

/// The request as a person must see it before deciding: the recorded, redacted content first, the model's own words
/// (unverified) last. Only whitelisted fields are printed; a nonce or raw arguments never are.
pub(crate) fn render_request(r: &Value) -> String {
    let mut l = vec![format!(
        "{}  [{}]  {}{}",
        s(r, "id"),
        s(r, "status"),
        s(r, "capability"),
        r["tool"]
            .as_str()
            .map(|t| format!(" via {}", clean(t)))
            .unwrap_or_default()
    )];
    l.push(format!(
        "  for {} {}",
        clean(r["subject"]["kind"].as_str().unwrap_or("?")),
        clean(r["subject"]["id"].as_str().unwrap_or("?"))
    ));
    let mut risk = vec![format!(
        "risk {}",
        r["risk"]
            .as_str()
            .map(clean)
            .unwrap_or_else(|| "unrated".into())
    )];
    if r["reversible"].as_bool() == Some(false) {
        risk.push("irreversible".into());
    }
    if r["tainted"].as_bool() == Some(true) {
        risk.push("tainted (influenced by untrusted content)".into());
    }
    l.push(format!("  {}", risk.join(", ")));
    if let Some(x) = r["summary"].as_str() {
        l.push("  what it does:".into());
        l.extend(x.lines().map(|ln| format!("    {}", clean(ln))));
    }
    if let Some(t) = r["targets"].as_array().filter(|t| !t.is_empty()) {
        l.push("  targets:".into());
        l.extend(
            t.iter()
                .filter_map(|x| x.as_str())
                .map(|x| format!("    {}", clean(x))),
        );
    }
    if let Some(o) = r["grantOptions"].as_array().filter(|o| !o.is_empty()) {
        let names: Vec<String> = o
            .iter()
            .filter_map(|x| x["scope"].as_str())
            .map(clean)
            .collect();
        l.push(format!(
            "  scopes offered (narrowest first): {}",
            names.join(", ")
        ));
    }
    if let Some(x) = r["agentReason"].as_str() {
        l.push(format!("  agent says (unverified): {}", clean(x)));
    }
    l.push(format!(
        "  asked {}, expires {}",
        s(r, "createdAt"),
        s(r, "expiresAt")
    ));
    l.join("\n")
}

pub(crate) fn render_list(v: &Value) -> String {
    let rows = v["approvals"].as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        return "no approval requests".into();
    }
    let mut out: Vec<String> = rows
        .iter()
        .map(|r| {
            let what = r["summary"]
                .as_str()
                .and_then(|x| x.lines().next())
                .map(|x| format!("  {}", clean(x)))
                .unwrap_or_default();
            format!(
                "{}  {}  {}  {}  risk {}{what}",
                s(r, "id"),
                s(r, "status"),
                s(r, "capability"),
                clean(r["subject"]["id"].as_str().unwrap_or("?")),
                r["risk"].as_str().map(clean).unwrap_or_else(|| "-".into())
            )
        })
        .collect();
    if v["nextCursor"].as_str().is_some() {
        out.push("... more requests exist (narrow with --status or --agent)".into());
    }
    out.join("\n")
}

pub(crate) fn verify_intact(v: &Value) -> bool {
    v["ok"].as_bool() == Some(true)
}

pub(crate) fn render_verify(v: &Value) -> String {
    let n = v["entries"].as_u64().unwrap_or(0);
    let head = match (v["head"]["seq"].as_u64(), v["head"]["mac"].as_str()) {
        (Some(seq), Some(mac)) => format!(", head seq {seq} mac {}", clean(mac)),
        _ => String::new(),
    };
    if verify_intact(v) {
        format!("approval chain intact: {n} entries{head}")
    } else {
        format!(
            "APPROVAL CHAIN BROKEN at seq {} ({}): {n} entries{head}; grants after the break are suspended",
            v["brokenAt"].as_u64().map_or("?".to_string(), |x| x.to_string()),
            clean(v["reason"].as_str().unwrap_or("unknown reason"))
        )
    }
}

pub(crate) fn render_decision(v: &Value) -> String {
    let a = &v["approval"];
    let mut t = format!("{} {}", s(a, "id"), s(a, "status"));
    if let Some(via) = v["grant"]["attestedVia"].as_str() {
        t.push_str(&format!(
            "\nconfirmed by the operating system ({})",
            clean(via)
        ));
    }
    if v["grant"].is_object() {
        t.push_str(&format!(
            "\ngrant created: {}",
            crate::commands::grant::render_grant(&v["grant"])
        ));
    }
    t
}

fn call(out: &Out, client: &mut plur1bus_rpc::Client, method: &str, params: Value) -> Value {
    require_supports(out, client, method);
    match client.call(method, params) {
        Ok(v) => v,
        Err(e) => out.from_rpc_error(&e),
    }
}

fn connect(out: &Out, layout: &Layout) -> plur1bus_rpc::Client {
    // Longer than the 60 s an OS confirmation dialog may stay open (issue #192).
    connect_core(out, layout, "approvals", Duration::from_secs(90))
}

pub fn run(out: &Out, layout: &Layout, cmd: ApprovalCmd) {
    match cmd {
        ApprovalCmd::List {
            status,
            agent,
            limit,
        } => {
            let p = list_params(status.map(|x| x.as_str()), agent.as_deref(), limit)
                .unwrap_or_else(|why| out.fail("E_INVALID_PARAMS", &why, json!({}), 2));
            let v = call(out, &mut connect(out, layout), "approval.list", p);
            out.ok("approval.list/1", &v, || render_list(&v));
        }
        ApprovalCmd::Pending => {
            let v = call(
                out,
                &mut connect(out, layout),
                "approval.list",
                json!({ "status": "pending" }),
            );
            out.ok("approval.pending/1", &v, || {
                if v["approvals"].as_array().is_some_and(|a| a.is_empty()) {
                    "no pending approval requests".to_string()
                } else {
                    render_list(&v)
                }
            });
        }
        ApprovalCmd::Approve {
            id,
            scope,
            delegable,
            yes,
        } => {
            // Decided before any connection: a script that forgot `--yes` learns it without touching the core.
            let g = gate(yes, std::io::stdin().is_terminal(), out.json);
            if g == Gate::Refuse {
                out.fail(
                    "E_INVALID_PARAMS",
                    "approving needs a person: run it in a terminal and confirm, or pass --yes after reading the request (`plur1bus approval pending`)",
                    json!({ "reason": "confirmation-required", "applied": false }),
                    2,
                );
            }
            let mut client = connect(out, layout);
            let rec = call(out, &mut client, "approval.get", json!({ "id": id }));
            // Always on stderr: stdout stays a single `--json` document or the result line.
            eprintln!("{}", render_request(&rec));
            if rec["status"].as_str() != Some("pending") {
                out.fail(
                    "E_CONFLICT",
                    &format!(
                        "request {} is {}, not pending",
                        clean(&id),
                        s(&rec, "status")
                    ),
                    json!({ "reason": "not-pending", "applied": false }),
                    1,
                );
            }
            let scope = scope.map(|x| x.as_str());
            if let Some(why) = scope.and_then(|sc| scope_not_offered(&rec, sc)) {
                out.fail(
                    "E_INVALID_PARAMS",
                    &why,
                    json!({ "reason": "scope-not-offered", "applied": false }),
                    2,
                );
            }
            if g == Gate::Prompt {
                eprint!(
                    "approve this request{}? [y/N] ",
                    scope
                        .map(|x| format!(" with scope {x}"))
                        .unwrap_or_default()
                );
                std::io::stderr().flush().ok();
                let mut line = String::new();
                std::io::stdin().read_line(&mut line).ok();
                if !line.trim().eq_ignore_ascii_case("y") {
                    out.fail(
                        "E_INVALID_PARAMS",
                        "not approved",
                        json!({ "applied": false }),
                        2,
                    );
                }
            }
            let v = match client.call(
                "approval.decide",
                decide_params(&id, "approve", scope, delegable, false),
            ) {
                Ok(v) => v,
                Err(e) => match attestation_needed(&e) {
                    // The person said yes above; the OS now asks the one thing a stolen token cannot answer.
                    Some(method) => {
                        eprintln!("{}", attestation_notice(&method));
                        call(
                            out,
                            &mut client,
                            "approval.decide",
                            decide_params(&id, "approve", scope, delegable, true),
                        )
                    }
                    None => out.from_rpc_error(&e),
                },
            };
            out.ok("approval.decide/1", &v, || render_decision(&v));
        }
        ApprovalCmd::Deny { id } => {
            let v = call(
                out,
                &mut connect(out, layout),
                "approval.decide",
                decide_params(&id, "deny", None, false, false),
            );
            out.ok("approval.decide/1", &v, || render_decision(&v));
        }
        ApprovalCmd::Verify => {
            let v = call(out, &mut connect(out, layout), "approval.verify", json!({}));
            out.ok("approval.verify/1", &v, || render_verify(&v));
            if !verify_intact(&v) {
                std::process::exit(1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Cmd};
    use clap::Parser;

    fn parse(args: &[&str]) -> Result<ApprovalCmd, clap::Error> {
        let mut v = vec!["plur1bus", "approval"];
        v.extend(args);
        match Cli::try_parse_from(v)?.cmd {
            Cmd::Approval { sub } => Ok(sub),
            o => panic!("{o:?}"),
        }
    }

    fn record() -> Value {
        json!({"id":"apr_ab12","status":"pending","capability":"shell.exec","tool":"bash","risk":"high","reversible":false,
            "principal":"christian","subject":{"kind":"agent","id":"main"},"actionHash":"a".repeat(64),
            "requiredSurface":"trusted","originSurface":"trusted",
            "grantOptions":[{"scope":"once","requiredSurface":"trusted"},{"scope":"task","requiredSurface":"trusted"}],
            "tainted":true,"targets":["/srv/data/a.txt","/srv/data/b\u{1b}[2J.txt"],
            "summary":"rm -rf /srv/data/old","agentReason":"cleanup\u{7}",
            "createdAt":"2026-10-07T00:00:00Z","expiresAt":"2026-10-08T00:00:00Z","delegable":false})
    }

    #[test]
    fn parses_the_commands_and_their_flags() {
        assert!(matches!(parse(&["pending"]).unwrap(), ApprovalCmd::Pending));
        assert!(matches!(parse(&["verify"]).unwrap(), ApprovalCmd::Verify));
        match parse(&["list", "--status", "denied", "--agent", "a", "--limit", "7"]).unwrap() {
            ApprovalCmd::List {
                status,
                agent,
                limit,
            } => {
                assert_eq!(status.unwrap().as_str(), "denied");
                assert_eq!((agent.as_deref(), limit), (Some("a"), Some(7)));
            }
            o => panic!("{o:?}"),
        }
        match parse(&[
            "approve",
            "apr_1",
            "--scope",
            "task",
            "--delegable",
            "--yes",
        ])
        .unwrap()
        {
            ApprovalCmd::Approve {
                id,
                scope,
                delegable,
                yes,
            } => {
                assert_eq!(
                    (id.as_str(), scope.unwrap().as_str(), delegable, yes),
                    ("apr_1", "task", true, true)
                );
            }
            o => panic!("{o:?}"),
        }
        assert!(matches!(
            parse(&["deny", "apr_1"]).unwrap(),
            ApprovalCmd::Deny { .. }
        ));
    }

    #[test]
    fn refuses_bad_input_at_parse_time() {
        assert!(parse(&["list", "--status", "waiting"]).is_err());
        assert!(parse(&["approve"]).is_err());
        assert!(parse(&["approve", "apr_1", "--scope", "forever"]).is_err());
        assert!(parse(&["deny"]).is_err());
        // no nonce and no password on the command line, ever
        assert!(parse(&["approve", "apr_1", "--nonce", "x"]).is_err());
        assert!(parse(&["approve", "apr_1", "--password", "x"]).is_err());
        assert!(parse(&["deny", "apr_1", "--nonce", "x"]).is_err());
    }

    #[test]
    fn approve_gate_never_approves_silently() {
        assert_eq!(gate(false, false, false), Gate::Refuse);
        assert_eq!(gate(false, false, true), Gate::Refuse);
        assert_eq!(
            gate(false, true, true),
            Gate::Refuse,
            "--json cannot prompt"
        );
        assert_eq!(gate(false, true, false), Gate::Prompt);
        assert_eq!(gate(true, false, false), Gate::Proceed);
        assert_eq!(gate(true, true, true), Gate::Proceed);
    }

    #[test]
    fn params_are_minimal() {
        assert_eq!(list_params(None, None, None).unwrap(), json!({}));
        assert_eq!(
            list_params(Some("pending"), Some("a"), Some(3)).unwrap(),
            json!({"status":"pending","agent":"a","limit":3})
        );
        assert!(list_params(None, None, Some(501)).is_err());
        assert_eq!(
            decide_params("apr_1", "approve", None, false, false),
            json!({"id":"apr_1","decision":"approve"})
        );
        assert_eq!(
            decide_params("apr_1", "approve", Some("session"), true, false),
            json!({"id":"apr_1","decision":"approve","scope":"session","delegable":true})
        );
        assert_eq!(
            decide_params("apr_1", "deny", None, false, false),
            json!({"id":"apr_1","decision":"deny"})
        );
        assert_eq!(
            decide_params("apr_1", "approve", Some("session"), false, true),
            json!({"id":"apr_1","decision":"approve","scope":"session","attest":true})
        );
    }

    fn call_error(
        code: plur1bus_rpc::types::ErrorCode,
        reason: &str,
        detail: Option<&str>,
    ) -> plur1bus_rpc::RpcError {
        plur1bus_rpc::RpcError::Call {
            error: code,
            jsonrpc: -32000,
            message: "m".into(),
            reason: Some(reason.into()),
            detail: detail.map(String::from),
            ids: None,
            ext: None,
        }
    }

    #[test]
    fn only_attestation_required_starts_the_confirmation_flow() {
        use plur1bus_rpc::types::ErrorCode as C;
        assert_eq!(
            attestation_needed(&call_error(
                C::EApprovalRequired,
                "attestation-required",
                Some("touch-id")
            )),
            Some("touch-id".to_string())
        );
        for e in [
            call_error(C::EApprovalRequired, "acknowledge-unsigned", None),
            call_error(C::EDenied, "attestation-failed", Some("cancelled")),
            call_error(C::EDenied, "surface-untrusted", None),
            call_error(C::ENotAvailable, "attestation-unavailable", None),
        ] {
            assert_eq!(attestation_needed(&e), None, "{e:?}");
        }
    }

    #[test]
    fn the_notice_names_what_the_person_will_be_asked_to_do() {
        for (m, words) in [
            ("touch-id", "Touch ID"),
            ("windows-hello", "Windows Hello"),
            ("uac", "UAC"),
            ("polkit", "polkit"),
            ("", "the operating system"),
        ] {
            let n = attestation_notice(m);
            assert!(n.contains(words), "{m}: {n}");
            assert!(n.contains("this approval only"), "{n}");
        }
        assert!(!attestation_notice("x\u{1b}[2J").contains('\u{1b}'));
    }

    #[test]
    fn a_decision_confirmed_by_the_os_says_so() {
        let v = json!({"approval":{"id":"apr_1","status":"approved"},"grant":null});
        assert!(!render_decision(&v).contains("operating system"));
        let mut g = json!({"approval":{"id":"apr_1","status":"approved"},"grant":{"id":"grt_1","capability":"shell.exec","agent":"a","scope":"session","match":{"kind":"capability"},"state":"active","createdBy":"p","createdAt":"2026-10-10T00:00:00Z","delegable":false,"surface":2}});
        g["grant"]["attestedVia"] = json!("attested:touch-id");
        assert!(
            render_decision(&g).contains("confirmed by the operating system (attested:touch-id)")
        );
    }

    #[test]
    fn a_scope_the_request_does_not_offer_is_caught_before_deciding() {
        let r = record();
        assert!(scope_not_offered(&r, "task").is_none());
        assert!(scope_not_offered(&r, "once").is_none());
        assert!(scope_not_offered(&r, "always").is_some());
        assert!(scope_not_offered(&json!({"grantOptions":[]}), "always").is_none());
        assert!(scope_not_offered(&json!({}), "always").is_none());
    }

    #[test]
    fn request_text_shows_the_exact_content_and_strips_escapes() {
        let t = render_request(&record());
        for needle in [
            "apr_ab12",
            "shell.exec",
            "high",
            "agent main",
            "rm -rf /srv/data/old",
            "/srv/data/a.txt",
            "irreversible",
            "tainted",
            "once",
            "task",
            "agent says (unverified)",
            "cleanup",
        ] {
            assert!(t.contains(needle), "{needle} missing in:\n{t}");
        }
        assert!(!t.contains('\u{1b}') && !t.contains('\u{7}'));
        // the model's own words come after the recorded summary
        assert!(t.find("rm -rf").unwrap() < t.find("cleanup").unwrap());
        // never a nonce, whatever the document carries
        let mut r = record();
        r["nonce"] = json!("NONCE-SECRET");
        r["args"] = json!({"token":"RAW-ARG"});
        let t = render_request(&r);
        assert!(!t.contains("NONCE-SECRET") && !t.contains("RAW-ARG"));
    }

    #[test]
    fn list_text_and_empty_queue() {
        assert_eq!(
            render_list(&json!({"approvals":[]})),
            "no approval requests"
        );
        let t = render_list(&json!({"approvals":[record()],"nextCursor":"c"}));
        assert!(
            t.contains("apr_ab12")
                && t.contains("pending")
                && t.contains("shell.exec")
                && t.contains("more")
        );
        assert!(t.contains("rm -rf /srv/data/old"));
    }

    #[test]
    fn verify_text_names_the_first_broken_position_and_exit_follows_ok() {
        let ok = json!({"ok":true,"entries":3,"head":{"seq":3,"mac":"b".repeat(64)}});
        assert!(verify_intact(&ok));
        let t = render_verify(&ok);
        assert!(t.contains("intact") && t.contains("3 entries") && t.contains("seq 3"));
        assert!(render_verify(&json!({"ok":true,"entries":0,"head":null})).contains("0 entries"));
        let bad = json!({"ok":false,"entries":9,"head":{"seq":9,"mac":"c".repeat(64)},"brokenAt":4,"reason":"mac-mismatch"});
        assert!(!verify_intact(&bad));
        let t = render_verify(&bad);
        assert!(
            t.contains("BROKEN") && t.contains("seq 4") && t.contains("mac-mismatch"),
            "{t}"
        );
        assert!(
            !verify_intact(&json!({})),
            "an answer without ok is not intact"
        );
    }

    #[test]
    fn decision_text() {
        let a = json!({"approval":{"id":"apr_1","status":"approved","capability":"c"},"grant":{"id":"grt_9","capability":"c","agent":"a","scope":"task","state":"active","createdAt":"t"}});
        let t = render_decision(&a);
        assert!(t.contains("apr_1") && t.contains("approved") && t.contains("grt_9"));
        let d = json!({"approval":{"id":"apr_1","status":"denied","capability":"c"},"grant":null});
        assert!(render_decision(&d).contains("denied"));
    }
}
