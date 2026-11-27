use plur1bus_channels::websocket::{SocketPorts, TimedStream};
use std::io;
use std::net::SocketAddr;
use std::time::Instant;
use url::Url;

pub(crate) struct Loopback(pub(crate) SocketAddr);

impl SocketPorts for Loopback {
    fn wall_time(&self) -> std::time::SystemTime {
        std::time::UNIX_EPOCH
    }

    fn resolver(&self) -> plur1bus_providers::resolution::Resolver<Url, Option<SocketAddr>> {
        let address = self.0;
        std::sync::Arc::new(move |endpoint, _, _| {
            (endpoint.host_str() == Some("127.0.0.1") && endpoint.port() == Some(address.port()))
                .then_some(address)
        })
    }

    fn dial(
        &self,
        _: &Url,
        pin: SocketAddr,
        deadline: Instant,
    ) -> io::Result<Box<dyn TimedStream>> {
        plur1bus_providers::connect_pinned_tcp(pin, deadline, &|| self.cancelled())
            .map(|tcp| Box::new(tcp) as Box<dyn TimedStream>)
    }
}
