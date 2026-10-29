//! `plur1bus mcp serve`: the harness as an MCP server over stdio (M6-A, ADR-008).
//! Bridges stdin/stdout JSON-RPC to the harness MCP server behind agent-bound tokens.
//! Nothing is printed to stdout except MCP JSON-RPC; all diagnostics go to stderr.

use crate::cli::{InstallFlags, McpCmd, PluginCmd};
use crate::commands::core::{locate_core_js, locate_node};
use crate::commands::session::pick_agent;
use crate::output::Out;
use crate::paths::Layout;
use plur1bus_config as cfg;
use serde_json::json;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// `mcp.js`: `$PLUR1BUS_MCP_JS`, else `mcp.js` next to the core entry ([`locate_core_js`]).
pub(crate) fn locate_mcp_js(layout: &Layout) -> PathBuf {
    std::env::var_os("PLUR1BUS_MCP_JS")
        .map(PathBuf::from)
        .unwrap_or_else(|| locate_core_js(layout).with_file_name("mcp.js"))
}

/// The adapter's argv after the script path.
pub(crate) fn mcp_args(layout: &Layout, agent: &str) -> Vec<OsString> {
    vec![
        "--home".into(),
        layout.home.clone().into_os_string(),
        "--agent".into(),
        agent.into(),
    ]
}

pub fn run(out: &Out, layout: &Layout, sub: McpCmd) {
    match sub {
        McpCmd::Import { path, flags } => {
            crate::commands::plugin::run(
                out,
                layout,
                PluginCmd::Install {
                    path,
                    enable: None,
                    flags: InstallFlags { ..flags },
                },
            );
        }
        McpCmd::Serve { agent } => serve(out, layout, agent),
    }
}

fn serve(out: &Out, layout: &Layout, agent: Option<String>) {
    let token = std::env::var("PLUR1BUS_MCP_TOKEN").unwrap_or_default();
    if token.trim().is_empty() {
        out.fail(
            "E_UNAUTHORIZED",
            "PLUR1BUS_MCP_TOKEN environment variable required for mcp serve",
            json!({ "reason": "token-missing" }),
        );
    }

    let config = cfg::read_for_lookup(&layout.config_path(), &[])
        .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({})));

    let mcp_server_enabled = config
        .get("mcpServer")
        .and_then(|m| m.get("enabled"))
        .and_then(|e| e.as_bool())
        .unwrap_or(false);

    if !mcp_server_enabled {
        out.fail(
            "E_DENIED",
            "MCP server is disabled in configuration (mcpServer.enabled)",
            json!({ "reason": "mcp-server-disabled" }),
        );
    }

    let agent = pick_agent(out, &config, agent);

    let agent_exposed = config
        .get("agents")
        .and_then(|a| a.get(&agent))
        .and_then(|a| a.get("mcpServer"))
        .and_then(|m| m.get("exposed"))
        .and_then(|e| e.as_bool())
        .unwrap_or(false);

    if !agent_exposed {
        out.fail(
            "E_DENIED",
            &format!("Agent '{agent}' is not exposed on MCP server (agents.{agent}.mcpServer.exposed)"),
            json!({ "reason": "agent-not-exposed" }),
        );
    }

    let js = locate_mcp_js(layout);
    if !js.exists() {
        out.fail(
            "E_NOT_AVAILABLE",
            &format!(
                "mcp.js not found at {} (set PLUR1BUS_MCP_JS, or run build)",
                js.display()
            ),
            json!({ "reason": "mcp-missing" }),
        );
    }

    let node = locate_node(layout);
    let mut cmd = Command::new(&node);
    cmd.arg(&js)
        .args(mcp_args(layout, &agent))
        .env("PLUR1BUS_MCP_TOKEN", token)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    #[cfg(windows)]
    {
        // ADR-008 Action 11: avoid pipe-handle duplication / handle inheritance hangs on Windows
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let status = cmd.status();
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => crate::output::exit(crate::output::child_exit_code(&s)),
        Err(e) => out.fail(
            "E_NOT_AVAILABLE",
            &format!("cannot start {}: {e}", node.display()),
            json!({ "reason": "node-unavailable" }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv_names_home_and_agent() {
        let layout = Layout::new(PathBuf::from("/h"));
        let a: Vec<String> = mcp_args(&layout, "bernd")
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert_eq!(a, ["--home", "/h", "--agent", "bernd"]);
    }
}
