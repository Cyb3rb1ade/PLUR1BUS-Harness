//! `auth/env.ts`: the two predicates every login flow consults (ADR-005 "Headless / SSH"). They read an injected snapshot,
//! never the process environment, so a test (and the flip) decides what they see.
use std::collections::BTreeMap;

/// `EnvSnapshot`: the variables, the platform as Node names it (`process.platform`), and whether stdout is a terminal.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EnvSnapshot {
    /// The environment variables.
    pub env: BTreeMap<String, String>,
    /// `darwin`, `linux`, `win32`, ...
    pub platform: String,
    /// `process.stdout.isTTY`.
    pub stdout_is_tty: bool,
}

/// Remote-IDE and cloud-shell markers. The list always lags reality, so it is only one of the signals.
const REMOTE_ENV_MARKERS: [&str; 9] = [
    "SSH_CONNECTION",
    "SSH_CLIENT",
    "SSH_TTY",
    "CODESPACES",
    "CLOUD_SHELL",
    "GITPOD_WORKSPACE_ID",
    "VSCODE_IPC_HOOK_CLI",
    "REMOTE_CONTAINERS",
    "CLAUDE_CODE_REMOTE",
];

fn set(s: &EnvSnapshot, key: &str) -> bool {
    s.env.get(key).is_some_and(|v| !v.is_empty())
}

/// `isRemoteSession`.
pub fn is_remote_session(s: &EnvSnapshot) -> bool {
    REMOTE_ENV_MARKERS.iter().any(|k| set(s, k))
}

/// `canOpenGraphicalBrowser`: true only when a browser can plausibly open on the machine the person sits at.
pub fn can_open_graphical_browser(s: &EnvSnapshot) -> bool {
    if is_remote_session(s) {
        return false;
    }
    if s.platform == "darwin" || s.platform == "win32" {
        return true;
    }
    set(s, "DISPLAY") || set(s, "WAYLAND_DISPLAY")
}
