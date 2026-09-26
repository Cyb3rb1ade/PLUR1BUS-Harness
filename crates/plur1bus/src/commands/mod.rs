pub mod agent;
pub mod config;
pub mod core;
pub mod daemon;
pub mod dreams;
pub mod memory;
pub mod memory_ops;
pub mod service;
pub mod stubs;

use crate::paths::Layout;
use plur1bus_rpc::types::ErrorCode;
use plur1bus_rpc::{Client, ConnectOptions, Endpoint, RpcError};

/// Whether `e` is the S11 refusal of a pipe served by another process than the recorded one.
fn is_server_mismatch(e: &RpcError) -> bool {
    matches!(
        e,
        RpcError::Call { error: ErrorCode::EUnauthorized, reason: Some(r), .. } if r == "pipe-server-mismatch"
    )
}

/// The token file of `endpoint`, trimmed.
fn read_token_of(layout: &Layout, endpoint: Endpoint) -> Option<String> {
    let path = match endpoint {
        Endpoint::Core => layout.core_token(),
        Endpoint::Supervisor => layout.supervisor_token(),
    };
    let t = std::fs::read_to_string(path).ok()?.trim().to_string();
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
