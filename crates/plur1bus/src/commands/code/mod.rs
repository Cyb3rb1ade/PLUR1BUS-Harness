//! CLI-1 coding frontend. The session pump owns the two RPC connections; frontends own input and presentation.
mod approve;
mod binding;
mod commands;
mod input;
mod lang;
mod pump;
mod render;
mod runtime;
mod signals;
mod stream;
#[cfg(feature = "tui")]
mod tui;

use plur1bus_rpc::Client;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug)]
pub(super) struct CodeError {
    pub code: String,
    pub message: String,
    pub reason: Option<String>,
    pub detail: Option<String>,
}
impl CodeError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            reason: None,
            detail: None,
        }
    }
}
impl std::fmt::Display for CodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for CodeError {}
impl From<plur1bus_rpc::RpcError> for CodeError {
    fn from(error: plur1bus_rpc::RpcError) -> Self {
        let mut result = Self::new(&error.code_name(), error.to_string());
        if let plur1bus_rpc::RpcError::Call { reason, detail, .. } = error {
            result.reason = reason;
            result.detail = detail;
        }
        result
    }
}
impl From<std::io::Error> for CodeError {
    fn from(error: std::io::Error) -> Self {
        Self::new("E_IO", error.to_string())
    }
}
impl From<serde_json::Error> for CodeError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("E_RPC_PROTOCOL", error.to_string())
    }
}
pub(super) fn connect(layout: &crate::paths::Layout) -> Result<Client, CodeError> {
    Ok(crate::commands::memory::connect(
        layout,
        Duration::from_millis(100),
    )?)
}

pub fn run(out: &crate::output::Out, layout: &crate::paths::Layout, args: CodeArgs) {
    // Every terminal/thread guard has dropped before Out's exiting error path runs.
    if let Err(error) = runtime::run(out, layout, args) {
        out.fail(
            &error.code,
            &render::safe(&error.message, false),
            serde_json::json!({"capability":"coding"}),
        );
    }
}

#[derive(clap::Args, Debug)]
pub struct CodeArgs {
    /// Git worktree root (default: the current directory)
    #[arg(value_name = "PATH", default_value = ".")]
    pub path: PathBuf,
    /// One task; use `code . "task"` to keep the default working directory
    #[arg(value_name = "MESSAGE")]
    pub message: Option<String>,
    /// Registered agent (default: the only agent)
    #[arg(long)]
    pub agent: Option<String>,
    /// D115 project, together with --card
    #[arg(long, requires = "card")]
    pub project: Option<String>,
    /// D115 coding card, together with --project
    #[arg(long, requires = "project")]
    pub card: Option<String>,
    /// Resume a bound coding session
    #[arg(long)]
    pub session: Option<String>,
    /// Configured model profile; the switch requires confirmation
    #[arg(long)]
    pub model: Option<String>,
    /// Reasoning level (default leaves control to the provider)
    #[arg(long, value_parser = ["default", "off", "minimal", "low", "medium", "high", "xhigh"])]
    pub reasoning: Option<String>,
    /// Confirm a model switch for scripts; never approves a folder or tool
    #[arg(long)]
    pub yes: bool,
    /// Keep the session and its transcript only in memory
    #[arg(long)]
    pub no_memory: bool,
    /// Use the fullscreen terminal UI (line mode for pipes and dumb terminals)
    #[arg(long)]
    pub tui: bool,
}
