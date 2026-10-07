//! `plur1bus acp serve`: the harness as an ACP agent over stdio (ADR-008, A1). The protocol work runs in Node —
//! `acp.js`, shipped beside `core.js` — as a peer client of the running core; this side resolves the agent and the
//! caller identity, then hands over stdin/stdout unchanged. Nothing is printed here once Node runs: stdout belongs to
//! ACP JSON-RPC (ADR-008 stdout rule), so even `--json` changes nothing.
use crate::cli::AcpCmd;
use crate::commands::core::{locate_core_js, locate_node};
use crate::commands::session::pick_agent;
use crate::identity;
use crate::output::Out;
use crate::paths::Layout;
use plur1bus_config as cfg;
use serde_json::json;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// `acp.js`: `$PLUR1BUS_ACP_JS`, else `acp.js` next to the core entry ([`locate_core_js`]).
pub(crate) fn locate_acp_js(layout: &Layout) -> PathBuf {
    std::env::var_os("PLUR1BUS_ACP_JS")
        .map(PathBuf::from)
        .unwrap_or_else(|| locate_core_js(layout).with_file_name("acp.js"))
}

/// The adapter's argv after the script path. The caller identity is the CLI's own (`identity::caller()`), exactly as
/// `chat` sends it; the core derives the session owner from it.
pub(crate) fn acp_args(layout: &Layout, agent: &str) -> Vec<OsString> {
    let caller = identity::caller();
    vec![
        "--home".into(),
        layout.home.clone().into_os_string(),
        "--agent".into(),
        agent.into(),
        "--account".into(),
        caller.account_id.into(),
        "--user".into(),
        caller.user_id.into(),
    ]
}

pub fn run(out: &Out, layout: &Layout, sub: AcpCmd) {
    match sub {
        AcpCmd::Serve { agent } => serve(out, layout, agent),
    }
}

fn serve(out: &Out, layout: &Layout, agent: Option<String>) {
    let config = cfg::read(&layout.config_path())
        .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1));
    let agent = pick_agent(out, &config, agent);
    let js = locate_acp_js(layout);
    if !js.exists() {
        out.fail(
            "E_NOT_AVAILABLE",
            &format!(
                "acp.js not found at {} (set PLUR1BUS_ACP_JS, or PLUR1BUS_CORE_JS to a built core, or run setup)",
                js.display()
            ),
            json!({ "reason": "acp-missing" }),
            1,
        );
    }
    let node = locate_node(layout);
    let status = Command::new(&node)
        .arg(&js)
        .args(acp_args(layout, &agent))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => crate::output::exit(s.code().unwrap_or(1)),
        Err(e) => out.fail(
            "E_NOT_AVAILABLE",
            &format!("cannot start {}: {e}", node.display()),
            json!({ "reason": "node-unavailable" }),
            1,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv_names_home_agent_and_the_cli_identity_and_nothing_else() {
        let layout = Layout::new(PathBuf::from("/h"));
        let a: Vec<String> = acp_args(&layout, "bernd")
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert_eq!(a[..4], ["--home", "/h", "--agent", "bernd"]);
        assert_eq!((a[4].as_str(), a[6].as_str()), ("--account", "--user"));
        assert_eq!(a.len(), 8);
    }
}
