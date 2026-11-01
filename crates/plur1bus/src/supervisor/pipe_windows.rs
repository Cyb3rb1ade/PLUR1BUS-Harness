//! The supervisor uses the shared owner-only, overlapped RPC named-pipe listener.
use super::server::Accepted;
use std::io;

pub struct Listener(plur1bus_rpc::server_transport::Listener);

impl Listener {
    pub fn bind(address: &str) -> io::Result<Self> {
        plur1bus_rpc::server_transport::Listener::bind(address).map(Self)
    }

    pub fn accept(&self) -> io::Result<Accepted> {
        let connection = self.0.accept()?;
        Ok(Accepted {
            peer_pid: connection.peer_pid,
            reader: connection.reader,
            writer: connection.writer,
            closer: connection.closer,
            drain: connection.drain,
        })
    }
}
