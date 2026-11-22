#![cfg(any(feature = "http", feature = "websocket"))]
#![allow(clippy::unwrap_used)]

#[cfg(feature = "websocket")]
#[path = "support/socket.rs"]
mod socket;

#[test]
fn dependency_logging_excludes_trace() {
    assert!(
        log::STATIC_MAX_LEVEL <= log::LevelFilter::Debug,
        "standalone channel transport compiles in dependency wire diagnostics"
    );
}

#[cfg(feature = "websocket")]
mod websocket {
    use super::socket::Loopback;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use plur1bus_channels::websocket::{Limits, Peer, Socket};
    use plur1bus_wire_fixtures::{frame, FakeServer};
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use url::Url;

    const MARKER: &str = "synthetic-close-reason-marker";
    static LOG: MarkerLog = MarkerLog {
        filtered: AtomicBool::new(false),
        recorded: AtomicBool::new(false),
    };

    struct MarkerLog {
        filtered: AtomicBool,
        recorded: AtomicBool,
    }

    impl log::Log for MarkerLog {
        fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
            !self.filtered.load(Ordering::Relaxed) || plur1bus_wire_log::allows(metadata)
        }

        fn log(&self, record: &log::Record<'_>) {
            if self.enabled(record.metadata()) && record.args().to_string().contains(MARKER) {
                self.recorded.store(true, Ordering::Relaxed);
            }
        }

        fn flush(&self) {}
    }

    fn receive_close() {
        let mut payload = 1000u16.to_be_bytes().to_vec();
        payload.extend_from_slice(MARKER.as_bytes());
        let server = FakeServer::start(&json!({"transport": "websocket", "exchanges": [{
            "send": [], "receive": [], "rawFramesBase64": [STANDARD.encode(frame(0x8, &payload, None))]
        }]}));
        let url = Url::parse(&format!("ws://{}/gateway", server.addr)).unwrap();
        let mut socket =
            Socket::connect(&url, &[], &Loopback(server.addr), Limits::default(), true).unwrap();
        assert!(matches!(
            socket.receive(Duration::from_secs(1)),
            Ok(Peer::Closed(Some(1000)))
        ));
    }

    #[test]
    fn logger_boundary_filters_peer_close_reason() {
        log::set_logger(&LOG).unwrap();
        log::set_max_level(log::LevelFilter::Trace);

        receive_close();
        assert!(
            LOG.recorded.swap(false, Ordering::Relaxed),
            "missing positive control"
        );

        LOG.filtered.store(true, Ordering::Relaxed);
        receive_close();
        assert!(
            !LOG.recorded.load(Ordering::Relaxed),
            "the logger exposed the peer's close reason"
        );
    }
}
