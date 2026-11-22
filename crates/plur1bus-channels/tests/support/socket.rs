use plur1bus_channels::websocket::{SocketPorts, TimedStream};
use std::io;
use std::net::{SocketAddr, TcpStream};
use std::time::Instant;
use url::Url;

pub(crate) struct Loopback(pub(crate) SocketAddr);

impl SocketPorts for Loopback {
    fn pin(&self, endpoint: &Url, _: Instant) -> Option<SocketAddr> {
        (endpoint.host_str() == Some("127.0.0.1") && endpoint.port() == Some(self.0.port()))
            .then_some(self.0)
    }

    fn dial(
        &self,
        _: &Url,
        pin: SocketAddr,
        deadline: Instant,
    ) -> io::Result<Box<dyn TimedStream>> {
        TcpStream::connect_timeout(&pin, deadline.saturating_duration_since(Instant::now()))
            .map(|tcp| Box::new(tcp) as Box<dyn TimedStream>)
    }
}
