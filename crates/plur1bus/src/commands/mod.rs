pub mod admin;
pub mod agent;
pub mod backup;
pub mod budget;
pub mod config;
pub mod core;
pub mod daemon;
pub mod dreams;
pub mod ext;
pub mod firstaid;
pub(crate) mod firstaid_bundle;
pub(crate) mod firstaid_ext;
pub(crate) mod firstaid_install;
pub mod import;
pub mod memory;
pub mod memory_ops;
pub mod memory_reembed;
pub mod model;
pub mod module;
pub mod plugin;
pub mod repair;
pub mod secret;
pub mod service;
pub mod setup;
pub mod skill;
pub mod stubs;
pub mod update;
pub(crate) mod update_apply;
pub mod user;

use crate::output::Out;
use crate::paths::Layout;
use plur1bus_rpc::types::ErrorCode;
use plur1bus_rpc::{Client, ConnectOptions, Endpoint, RpcError};

/// `E_NOT_AVAILABLE reason=container-managed`, exit 1, when `PLUR1BUS_CONTAINER=1` (HB14): in the harness image the
/// image owns the installation, so `setup` and `update --check` never run there. Returns otherwise.
pub(crate) fn refuse_in_container(out: &Out, cmd: &str) {
    if crate::container::container_mode() {
        out.fail(
            "E_NOT_AVAILABLE",
            &format!("`plur1bus {cmd}` is not available in container mode: the image manages the installation"),
            serde_json::json!({ "reason": "container-managed", "command": cmd }),
            1,
        );
    }
}

/// Whether `e` is the S11 refusal of a pipe served by another process than the recorded one.
fn is_server_mismatch(e: &RpcError) -> bool {
    matches!(
        e,
        RpcError::Call { error: ErrorCode::EUnauthorized, reason: Some(r), .. } if r == "pipe-server-mismatch"
    )
}

/// Turns a token read into an `Option` for call sites that treat "no token" as "core unavailable", but says why when the
/// cause is a refusal (an untrusted `run/`, audit M2) instead of leaving it looking like an absent core. The line goes
/// to stderr, so `--json` output stays clean.
pub(crate) fn token_or_say_why<T>(read: Result<T, RpcError>) -> Option<T> {
    match read {
        Ok(v) => Some(v),
        Err(RpcError::Call { reason, detail, .. }) => {
            eprintln!(
                "plur1bus: refusing to use run/ ({}): {}",
                reason.unwrap_or_default(),
                detail.unwrap_or_default()
            );
            None
        }
        Err(_) => None,
    }
}

/// The token file of `endpoint`, trimmed.
fn read_token_of(layout: &Layout, endpoint: Endpoint) -> Option<String> {
    let path = match endpoint {
        Endpoint::Core => layout.core_token(),
        Endpoint::Supervisor => layout.supervisor_token(),
        // A module's token file is per module (`Layout::endpoints`); nothing reads one through this helper.
        Endpoint::Module => return None,
    };
    let t = token_or_say_why(layout.read_token_file(&path))?
        .trim()
        .to_string();
    (!t.is_empty()).then_some(t)
}

/// [`Client::connect`] expecting the server pid recorded in `run/` for `opts.endpoint` (ruling S11). A process that
/// restarted between the caller's read of the token and the connect has a new pid and a new token, and shows as
/// `pipe-server-mismatch`: then both files are read again and the connect is retried once, so a restart is never
/// reported as `E_UNAUTHORIZED` (and callers such as `memory add` keep their unavailable-core fallback).
pub(crate) fn connect_recorded(
    layout: &Layout,
    address: &str,
    token: &str,
    mut opts: ConnectOptions,
) -> Result<Client, RpcError> {
    opts.expected_server_pid = layout.recorded_pid(opts.endpoint);
    match Client::connect(address, token, opts.clone()) {
        Err(e) if is_server_mismatch(&e) => {
            let Some(token) = read_token_of(layout, opts.endpoint) else {
                return Err(e);
            };
            opts.expected_server_pid = layout.recorded_pid(opts.endpoint);
            Client::connect(address, &token, opts)
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_pipe_server_mismatch_refusal_triggers_the_reread() {
        let call = |error, reason: Option<&str>| RpcError::Call {
            error,
            jsonrpc: -32000,
            message: String::new(),
            reason: reason.map(str::to_string),
            detail: None,
            ids: None,
            ext: None,
        };
        assert!(is_server_mismatch(&call(
            ErrorCode::EUnauthorized,
            Some("pipe-server-mismatch")
        )));
        assert!(!is_server_mismatch(&call(
            ErrorCode::EUnauthorized,
            Some("bad-token")
        )));
        assert!(!is_server_mismatch(&call(ErrorCode::EInternal, None)));
        assert!(!is_server_mismatch(&RpcError::Unavailable {
            reason: "closed".into(),
            detail: String::new(),
        }));
    }

    #[test]
    fn a_refused_token_read_is_none_and_a_good_one_passes_through() {
        assert_eq!(token_or_say_why::<u8>(Ok(7)), Some(7));
        let refusal = RpcError::Call {
            error: ErrorCode::EUnauthorized,
            jsonrpc: -32000,
            message: "not trusted".into(),
            reason: Some("run-dir-untrusted".into()),
            detail: Some("run is a symlink".into()),
            ids: None,
            ext: None,
        };
        assert_eq!(token_or_say_why::<u8>(Err(refusal)), None);
        let absent = RpcError::Unavailable {
            reason: "core-unavailable".into(),
            detail: String::new(),
        };
        assert_eq!(token_or_say_why::<u8>(Err(absent)), None);
    }

    #[test]
    fn the_token_of_each_endpoint_is_read_trimmed() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        assert_eq!(read_token_of(&layout, Endpoint::Core), None);
        std::fs::create_dir_all(layout.run()).unwrap();
        std::fs::write(layout.core_token(), "abc\n").unwrap();
        std::fs::write(layout.supervisor_token(), " def ").unwrap();
        assert_eq!(
            read_token_of(&layout, Endpoint::Core).as_deref(),
            Some("abc")
        );
        assert_eq!(
            read_token_of(&layout, Endpoint::Supervisor).as_deref(),
            Some("def")
        );
    }
}
