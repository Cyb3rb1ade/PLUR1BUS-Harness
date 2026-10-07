//! `plur1bus audit verify`: forwards to the core's `audit.verify` (B5) and prints its answer. The CLI never reads
//! the chain files itself; the core owns them and the RBAC decision. Exit 1 when the chain is not intact.
use crate::cli::AuditCmd;
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::time::Duration;

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
    lines.join("\n")
}

pub fn run(out: &Out, layout: &Layout, cmd: AuditCmd) {
    match cmd {
        AuditCmd::Verify => {
            let mut client = connect_core(out, layout, "audit", Duration::from_secs(30));
            require_supports(out, &client, "audit.verify");
            match client.call("audit.verify", json!({})) {
                Ok(v) => {
                    out.ok("audit.verify/1", &v, || render(&v));
                    if v["ok"].as_bool() != Some(true) {
                        std::process::exit(1);
                    }
                }
                Err(e) => out.from_rpc_error(&e),
            }
        }
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
}
