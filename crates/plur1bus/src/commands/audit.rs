//! `plur1bus audit verify`: forwards to the core's `audit.verify` (B5) and prints its document. The chain files are
//! the core's; nothing is read or hashed here. Exit 0 when the chain verifies, 1 when it has findings.
use crate::cli::AuditCmd;
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::time::Duration;

fn render(v: &Value) -> String {
    let mut lines = vec![
        format!(
            "audit chain: {}",
            if v["ok"] == true { "ok" } else { "FAILED" }
        ),
        format!(
            "files {}, lines {}, last seq {}, anchor {}",
            v["files"],
            v["lines"],
            v["lastSeq"],
            v["anchor"].as_str().unwrap_or("?")
        ),
    ];
    if let Some(fs) = v["findings"].as_array() {
        for f in fs {
            lines.push(format!(
                "  {} {}:{} {}",
                f["code"].as_str().unwrap_or("?"),
                f["file"].as_str().unwrap_or("?"),
                f["line"],
                f["detail"].as_str().unwrap_or("")
            ));
        }
    }
    if v["findingsTruncated"] == true {
        lines.push("  (more findings than listed)".into());
    }
    lines.join("\n")
}

pub fn run(out: &Out, layout: &Layout, cmd: AuditCmd) {
    match cmd {
        AuditCmd::Verify => {
            let mut client = connect_core(out, layout, "audit", Duration::from_secs(60));
            require_supports(out, &client, "audit.verify");
            match client.call("audit.verify", json!({})) {
                Ok(v) => {
                    out.ok("audit.verify/1", &v, || render(&v));
                    if v["ok"] != true {
                        std::process::exit(1);
                    }
                }
                Err(e) => out.from_rpc_error(&e),
            }
        }
    }
}
