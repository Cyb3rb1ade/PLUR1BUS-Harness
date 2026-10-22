//! `plur1bus audit verify`: forwards to the core's `audit.verify` (B5) and prints its answer. The CLI never reads
//! the chain files itself; the core owns them and the RBAC decision. Exit 1 when the chain is not intact.
//!
//! `plur1bus audit reanchor --reason <text>`: the repair for a chain that writers refuse for good. It works on the files
//! directly (it must run while the core is stopped, and takes the writers' own lock when the core is running), so the
//! owner check is the one offline commands have: the home belongs to the calling OS user (see [`require_owner`]).
use crate::audit::chain::{Disagreement, ReanchorError, Reanchored};
use crate::cli::AuditCmd;
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::firstaid_bundle::redact::Redactor;
use crate::output::Out;
use crate::paths::Layout;
use plur1bus_rpc::RpcError;
use serde_json::{json, Value};
use std::time::Duration;

/// The reason is a sentence for the next reader of the chain, not a log: longer input is cut.
const MAX_REASON_CHARS: usize = 500;

fn render(v: &Value) -> String {
    let n = |k: &str| v[k].as_u64().unwrap_or(0);
    let head = if v["ok"].as_bool() == Some(true) {
        "audit chain intact"
    } else {
        "AUDIT CHAIN BROKEN"
    };
    let mut lines = vec![format!(
        "{head}: {} records in {} file(s), last seq {}, anchor {}",
        n("records"),
        n("files"),
        n("lastSeq"),
        v["anchor"]["status"].as_str().unwrap_or("?")
    )];
    if let Some(h) = v["lastHash"].as_str() {
        lines.push(format!("last hash {h}"));
    }
    for f in v["findings"].as_array().into_iter().flatten() {
        let at = match (f["line"].as_u64(), f["seq"].as_u64()) {
            (Some(l), _) => format!(" line {l}"),
            (None, Some(s)) => format!(" seq {s}"),
            _ => String::new(),
        };
        lines.push(format!(
            "  {} {}{at}",
            f["code"].as_str().unwrap_or("?"),
            f["file"].as_str().unwrap_or("?")
        ));
    }
    let total = n("findingsTotal");
    let shown = v["findings"].as_array().map_or(0, |a| a.len() as u64);
    if total > shown {
        lines.push(format!("  ... and {} more", total - shown));
    }
    // Era boundaries (absent from a core that predates `audit reanchor`): notes, not findings.
    for r in v["reanchors"].as_array().into_iter().flatten() {
        lines.push(format!(
            "  note: the chain was re-anchored at seq {} ({} line {}, {})",
            r["seq"].as_u64().unwrap_or(0),
            r["file"].as_str().unwrap_or("?"),
            r["line"].as_u64().unwrap_or(0),
            r["suffix"].as_str().unwrap_or("no set-aside files named")
        ));
    }
    for p in v["previousChains"].as_array().into_iter().flatten() {
        let state = match (p["intact"].as_bool(), p["firstBreak"]["code"].as_str()) {
            (Some(true), _) => "intact".to_string(),
            (_, Some(code)) => format!(
                "first deviation {code} at {} line {}",
                p["firstBreak"]["file"].as_str().unwrap_or("?"),
                p["firstBreak"]["line"].as_u64().unwrap_or(0)
            ),
            _ => format!("anchor {}", p["anchor"]["status"].as_str().unwrap_or("?")),
        };
        lines.push(format!(
            "  previous chain {}{}: {} valid record(s) in {} file(s), last seq {}, {state}",
            p["suffix"].as_str().unwrap_or("?"),
            if p["announced"].as_bool() == Some(false) {
                " (no reanchor event names it)"
            } else {
                ""
            },
            n_of(p, "records"),
            n_of(p, "files"),
            n_of(p, "lastSeq")
        ));
    }
    lines.join("\n")
}

fn n_of(v: &Value, k: &str) -> u64 {
    v[k].as_u64().unwrap_or(0)
}

/// Owner only, as far as an offline command can tell: the home is the calling OS user's (`logs/` is a real directory of the
/// current uid that group and others cannot write to; the same trust rule the CLI applies to `run/` before it sends a
/// token). The core's RBAC does not apply here: nothing is asked of the core, and the command runs while it is stopped.
fn require_owner(out: &Out, layout: &Layout) {
    // No `logs/` yet (or one that cannot be inspected) is not a refusal: the chain code answers.
    if let Err(RpcError::Call { detail, .. }) = plur1bus_rpc::trust::verify_run_dir(&layout.logs())
    {
        out.fail(
            "E_UNAUTHORIZED",
            &format!(
                "only the owner of this installation may re-anchor the audit chain: {}",
                detail.unwrap_or_default()
            ),
            json!({ "reason": "not-owner" }),
        )
    }
}

/// The reason as it goes into the chain: trimmed, secrets redacted by the diagnostic-bundle redactor, cut to a sentence.
fn clean_reason(raw: &str) -> String {
    let redacted = Redactor::new(Vec::new()).redact(raw.trim());
    let mut text: String = redacted.chars().take(MAX_REASON_CHARS).collect();
    if redacted.chars().count() > MAX_REASON_CHARS {
        text.push('…');
    }
    text
}

fn render_reanchor(r: &Reanchored, reason: &str, dir: &str, warnings: &[String]) -> String {
    let ins = &r.inspection;
    let mut lines = Vec::new();
    let finding = ins.disagreement().map_or("none", Disagreement::code);
    lines.push(if r.dry_run {
        format!("the audit chain is refused by its writers ({finding}); a reanchor would change the following (dry run, nothing was changed)")
    } else {
        format!("audit chain re-anchored (writers refused it: {finding})")
    });
    let anchor = ins.anchor_json();
    lines.push(match anchor["status"].as_str() {
        Some("ok") => format!(
            "  old anchor: seq {} hash {}",
            anchor["seq"],
            anchor["hash"].as_str().unwrap_or("?")
        ),
        Some(other) => format!("  old anchor: {other}"),
        None => "  old anchor: ?".into(),
    });
    lines.push(match &ins.end {
        Some((seq, hash)) => format!("  old end: seq {seq} hash {hash}"),
        None if ins.end_malformed => "  old end: the last line is not a chain line".into(),
        None => "  old end: no lines".into(),
    });
    lines.push(format!(
        "  {} line(s) in {} file(s), {} valid up to the first deviation{}",
        ins.lines,
        ins.files.len(),
        ins.valid_lines,
        ins.first_break.as_ref().map_or(String::new(), |b| format!(
            " ({} at {} line {})",
            b.code, b.file, b.line
        ))
    ));
    if !r.dry_run {
        lines.push(format!("  reason: {reason}"));
    }
    lines.push(format!(
        "  {} in {dir}:",
        if r.dry_run {
            "would be set aside"
        } else {
            "set aside"
        }
    ));
    for name in &r.aside {
        lines.push(format!("    {name}"));
    }
    if !r.dry_run {
        lines.push("  a new chain begins with the event audit.chain.reanchored".into());
    }
    for w in warnings {
        lines.push(format!("  warning: {w}"));
    }
    lines.join("\n")
}

fn reanchor(out: &Out, layout: &Layout, reason: Option<String>, dry_run: bool) {
    require_owner(out, layout);
    let reason = clean_reason(reason.as_deref().unwrap_or(""));
    if reason.is_empty() && !dry_run {
        out.fail(
            "E_INVALID_PARAMS",
            "--reason must say why the audit chain is re-anchored",
            json!({ "reason": "reason-empty" }),
        );
    }
    match crate::audit::reanchor(layout, &reason, dry_run) {
        Err(ReanchorError::NothingToRepair(heals)) => out.fail(
            "E_NOT_AVAILABLE",
            if heals {
                "nothing to repair: the anchor trails the chain by one complete line, and the next audit write moves it up by itself"
            } else {
                "nothing to repair: writers accept the audit chain and its anchor"
            },
            json!({ "reason": "nothing-to-repair" }),
        ),
        Err(ReanchorError::Io(e)) if e.kind() == std::io::ErrorKind::TimedOut => out.fail(
            "E_LOCKED",
            "the audit chain is locked by another process (the core is writing); try again",
            json!({ "reason": "audit-chain-locked" }),
        ),
        Err(ReanchorError::Io(e)) => out.fail(
            "E_STORAGE",
            &format!("the audit chain could not be re-anchored: {e}"),
            json!({ "reason": "audit-reanchor-failed" }),
        ),
        Ok((done, mirrored)) => {
            let dir = layout.logs().display().to_string();
            let warnings: Vec<String> = mirrored
                .map(|e| format!("the event could not be copied to audit.log: {e}"))
                .into_iter()
                .collect();
            let doc = json!({
                "dryRun": done.dry_run,
                "reanchored": !done.dry_run,
                "disagreement": done.inspection.disagreement().map(Disagreement::code),
                "dir": dir,
                "reason": if done.dry_run { Value::Null } else { json!(reason) },
                "inspection": done.inspection.json(),
                "asideSuffix": if done.dry_run { Value::Null } else { json!(done.suffix) },
                "aside": done.aside,
                "warnings": warnings,
            });
            out.ok("audit.reanchor/1", &doc, || {
                render_reanchor(&done, &reason, &dir, &warnings)
            });
        }
    }
}

pub fn run(out: &Out, layout: &Layout, cmd: AuditCmd) {
    match cmd {
        AuditCmd::Verify { pin } => {
            let mut client = connect_core(out, layout, "audit", Duration::from_secs(30));
            require_supports(out, &client, "audit.verify");
            let params =
                pin.map_or_else(|| json!({}), |p| json!({"pin":{"seq":p.seq,"hash":p.hash}}));
            match client.call("audit.verify", params) {
                Ok(v) => {
                    if v["ok"].as_bool() != Some(true) {
                        out.ok_but_failed(
                            "audit.verify/1",
                            &v,
                            || render(&v),
                            crate::output::Failure::new(
                                "E_STORAGE",
                                "audit-verify-failed",
                                "the audit log did not verify (see the findings)",
                            ),
                        );
                    }
                    out.ok("audit.verify/1", &v, || render(&v));
                }
                Err(e) => out.from_rpc_error(&e),
            }
        }
        AuditCmd::Reanchor { reason, dry_run } => reanchor(out, layout, reason, dry_run),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_an_intact_chain_and_a_broken_one() {
        let ok = json!({"ok": true, "records": 3, "files": 1, "lastSeq": 3, "lastHash": "ab", "anchor": {"status": "match", "seq": 3}, "findings": [], "findingsTotal": 0});
        assert!(render(&ok)
            .starts_with("audit chain intact: 3 records in 1 file(s), last seq 3, anchor match"));
        let bad = json!({"ok": false, "records": 1, "files": 1, "lastSeq": 1, "lastHash": null, "anchor": {"status": "ahead", "seq": 5},
            "findings": [{"code": "truncated", "file": "audit-chain.jsonl", "line": null, "seq": 5}], "findingsTotal": 3});
        let t = render(&bad);
        assert!(t.starts_with("AUDIT CHAIN BROKEN"));
        assert!(t.contains("truncated audit-chain.jsonl seq 5"));
        assert!(t.contains("and 2 more"));
    }

    #[test]
    fn renders_the_era_boundary_and_the_set_aside_chains() {
        let v = json!({"ok": true, "records": 2, "files": 1, "lastSeq": 2, "lastHash": "ab", "anchor": {"status": "match", "seq": 2}, "findings": [], "findingsTotal": 0,
            "reanchors": [{"seq": 1, "file": "audit-chain.jsonl", "line": 1, "at": 5, "suffix": "pre-reanchor-5"}],
            "previousChains": [
                {"suffix": "pre-reanchor-5", "announced": true, "files": 1, "records": 2, "lastSeq": 2, "lastHash": "cd", "intact": false,
                 "firstBreak": {"code": "hash-mismatch", "file": "audit-chain.jsonl.pre-reanchor-5", "line": 3, "seq": 3}, "anchor": {"status": "mismatch", "seq": 3}},
                {"suffix": "pre-reanchor-9", "announced": false, "files": 2, "records": 4, "lastSeq": 4, "lastHash": "ef", "intact": true,
                 "firstBreak": null, "anchor": {"status": "match", "seq": 4}}]});
        let t = render(&v);
        assert!(t.starts_with("audit chain intact: 2 records"), "{t}");
        assert!(t.contains(
            "note: the chain was re-anchored at seq 1 (audit-chain.jsonl line 1, pre-reanchor-5)"
        ));
        assert!(t.contains("previous chain pre-reanchor-5: 2 valid record(s) in 1 file(s), last seq 2, first deviation hash-mismatch at audit-chain.jsonl.pre-reanchor-5 line 3"));
        assert!(t.contains("previous chain pre-reanchor-9 (no reanchor event names it): 4 valid record(s) in 2 file(s), last seq 4, intact"));
        // A core that predates the fields renders as before.
        let old = json!({"ok": true, "records": 1, "files": 1, "lastSeq": 1, "lastHash": "ab", "anchor": {"status": "match", "seq": 1}, "findings": [], "findingsTotal": 0});
        assert!(!render(&old).contains("previous chain"));
    }

    #[test]
    fn the_reason_is_trimmed_redacted_and_cut() {
        assert_eq!(clean_reason("  disk failure  "), "disk failure");
        let secret = clean_reason("lost it; token=abc123def456ghi789");
        assert!(!secret.contains("abc123def456ghi789"), "{secret}");
        assert!(secret.starts_with("lost it"));
        let long = clean_reason(&"disk failure. ".repeat(60));
        assert_eq!(long.chars().count(), MAX_REASON_CHARS + 1);
        assert!(long.ends_with('…'));
        assert_eq!(clean_reason("   "), "");
    }
}
