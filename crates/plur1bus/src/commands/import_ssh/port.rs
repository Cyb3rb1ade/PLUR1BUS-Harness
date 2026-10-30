//! Authenticated RPC transport for SSH setup and maintenance; no SSH identity leaves Core.
use crate::{output::Out, paths::Layout};
use plur1bus_rpc::{Client, ConnectOptions, Endpoint, RpcError};
use serde_json::Value;
use std::time::Duration;
#[derive(Debug)]
pub(super) enum Failure {
    Invalid(&'static str),
    Protocol,
    Unavailable(&'static str),
    Rpc(RpcError),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Server {
    Core,
    Supervisor,
}
pub(super) trait RpcPort {
    fn call(&mut self, server: Server, method: &str, params: Value) -> Result<Value, Failure>;
}
pub(super) struct LivePort<'a> {
    pub(super) out: &'a Out,
    pub(super) layout: &'a Layout,
}
impl RpcPort for LivePort<'_> {
    fn call(&mut self, server: Server, method: &str, params: Value) -> Result<Value, Failure> {
        let mut client = if server == Server::Core {
            crate::commands::memory_ops::connect_core(
                self.out,
                self.layout,
                "ssh-import",
                Duration::from_secs(900),
            )
        } else {
            let token = crate::commands::read_token_of(self.layout, Endpoint::Supervisor)
                .ok_or(Failure::Unavailable("ssh-supervisor-required"))?;
            let address = crate::paths::supervisor_address(
                &self.layout.home,
                if cfg!(windows) { "windows" } else { "posix" },
            );
            crate::commands::connect_recorded(
                self.layout,
                &address,
                &token,
                ConnectOptions {
                    endpoint: Endpoint::Supervisor,
                    connect_timeout: Duration::from_secs(2),
                    call_timeout: Duration::from_secs(30),
                    expected_server_pid: None,
                },
            )
            .map_err(Failure::Rpc)?
        };
        if server == Server::Core {
            crate::commands::memory_ops::require_supports(self.out, &client, method);
        } else if !client.supports(method) {
            return Err(Failure::Unavailable("ssh-supervisor-lacks-method"));
        }
        Client::call(&mut client, method, params).map_err(Failure::Rpc)
    }
}
