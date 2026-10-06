//! `plur1bus 1staid bundle`: the CLI side of [`crate::firstaid_bundle`]. Local only: it reads files and runs the
//! read-only `1staid check` pass, and starts, signals and uploads nothing.
use super::firstaid::{self, GATHER_BUDGET};
use crate::cli::BundleArgs;
use crate::firstaid_bundle::{self as bundle, BundleError};
use crate::output::Out;
use crate::paths::Layout;
use serde_json::json;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub fn run(out: &Out, layout: &Layout, args: BundleArgs) -> ! {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let runner = super::service::runner(out);
    let checks = firstaid::collect(layout, runner.as_ref(), Instant::now() + GATHER_BUDGET);
    let opts = bundle::Options {
        lines: args.lines,
        now_ms,
    };
    let built = match bundle::build(layout, runner.as_ref(), &checks, &opts) {
        Ok(b) => b,
        Err(BundleError::Refused(hits)) => {
            let entries: Vec<_> = hits
                .iter()
                .map(|(p, rules)| json!({ "entry": p, "rules": rules }))
                .collect();
            out.fail(
                "E_INTERNAL",
                "the bundle's re-scan still found secret-like content; nothing was written",
                json!({ "reason": "redaction-rescan", "entries": entries }),
                1,
            )
        }
        Err(BundleError::Io(e)) => out.fail(
            "E_STORAGE",
            &format!("cannot read the installation: {e}"),
            json!({}),
            1,
        ),
    };
    let dest = bundle::destination(layout, args.out.as_deref(), now_ms)
        .unwrap_or_else(|e| out.fail("E_STORAGE", &format!("cannot prepare the output path: {e}"), json!({}), 1));
    if let Err(e) = bundle::write_zip(&built, &dest) {
        let code = if e.kind() == std::io::ErrorKind::AlreadyExists {
            "E_CONFLICT"
        } else {
            "E_STORAGE"
        };
        out.fail(
            code,
            &format!("cannot write {}: {e}", dest.display()),
            json!({ "path": dest }),
            1,
        );
    }
    let entries: Vec<_> = built.parts.iter().map(|p| p.path.as_str()).collect();
    out.ok(
        "1staid.bundle/1",
        &json!({ "path": dest, "entries": entries, "omitted": built.omitted }),
        || {
            format!(
                "wrote {} ({} files; nothing was uploaded)",
                dest.display(),
                entries.len()
            )
        },
    );
    std::process::exit(0)
}
