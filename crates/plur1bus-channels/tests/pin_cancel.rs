#![cfg(all(feature = "telegram", feature = "websocket"))]
use plur1bus_channels::http::{Http, HttpPorts, Kind};
use plur1bus_channels::telegram::Telegram;
use plur1bus_channels::websocket::{Error, Limits, Socket, SocketPorts, TimedStream};
use std::{
    io,
    net::SocketAddr,
    sync::atomic::{AtomicBool, Ordering},
    time::{Instant, SystemTime},
};
use url::Url;

#[derive(Default)]
struct CancelOnPin(
    std::sync::Arc<AtomicBool>,
    Option<std::sync::mpsc::Sender<()>>,
);
impl CancelOnPin {
    fn lookup(&self) -> plur1bus_providers::resolution::Resolver<Url, Option<SocketAddr>> {
        let stop = self.0.clone();
        let entered = self.1.clone();
        std::sync::Arc::new(move |_, _, _| {
            if let Some(entered) = &entered {
                let _ = entered.send(());
                std::thread::sleep(std::time::Duration::from_millis(750));
            } else {
                stop.store(true, Ordering::Release);
            }
            None
        })
    }
}

impl HttpPorts for CancelOnPin {
    fn resolver(&self) -> plur1bus_providers::resolution::Resolver<Url, Option<SocketAddr>> {
        self.lookup()
    }
    fn cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

impl SocketPorts for CancelOnPin {
    fn resolver(&self) -> plur1bus_providers::resolution::Resolver<Url, Option<SocketAddr>> {
        self.lookup()
    }
    fn cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
    fn wall_time(&self) -> SystemTime {
        SystemTime::UNIX_EPOCH
    }
    fn dial(&self, _: &Url, _: SocketAddr, _: Instant) -> io::Result<Box<dyn TimedStream>> {
        Err(io::Error::other("denied address was dialled"))
    }
}

#[test]
fn telegram_reports_cancellation_during_address_admission() -> Result<(), Box<dyn std::error::Error>>
{
    let host = CancelOnPin::default();
    let api = Telegram::new(
        Http::new(&host, true),
        Url::parse("http://127.0.0.1:9876")?,
        "123:test",
        &[],
    )?;
    assert_eq!(
        api.get_updates(None, 0).err().map(|e| e.kind),
        Some(Kind::Aborted)
    );
    Ok(())
}

#[test]
fn websocket_reports_cancellation_during_address_admission() -> Result<(), url::ParseError> {
    let host = CancelOnPin::default();
    let url = Url::parse("ws://127.0.0.1:9876")?;
    assert_eq!(
        Socket::connect(&url, &[], &host, Limits::default(), true).err(),
        Some(Error::Aborted)
    );
    Ok(())
}

// The review fixture's port is shared with the resolver worker. Its endpoints and delay are unchanged.
#[test]
fn abandoned_channel_lookup_returns_before_the_host() -> Result<(), Box<dyn std::error::Error>> {
    use std::time::Duration;
    for websocket in [false, true] {
        let (entered, rx) = std::sync::mpsc::channel();
        let host = CancelOnPin(Default::default(), Some(entered));
        std::thread::scope(|scope| -> Result<(), Box<dyn std::error::Error>> {
            let stop = host.0.clone();
            let waiter = scope.spawn(move || {
                rx.recv_timeout(Duration::from_secs(2))?;
                let at = Instant::now();
                stop.store(true, Ordering::Release);
                Ok::<_, std::sync::mpsc::RecvTimeoutError>(at)
            });
            if websocket {
                let url = Url::parse("ws://127.0.0.1:9876")?;
                assert_eq!(
                    Socket::connect(&url, &[], &host, Limits::default(), true).err(),
                    Some(Error::Aborted)
                );
            } else {
                let api = Telegram::new(
                    Http::new(&host, true),
                    Url::parse("http://127.0.0.1:9876")?,
                    "123:test",
                    &[],
                )?;
                assert_eq!(
                    api.get_updates(None, 0).err().map(|e| e.kind),
                    Some(Kind::Aborted)
                );
            }
            let end = Instant::now();
            let elapsed = end.duration_since(waiter.join().map_err(|_| "waiter panicked")??);
            eprintln!("websocket={websocket} cancellation {elapsed:?}");
            assert!(elapsed < Duration::from_millis(500));
            Ok(())
        })?;
    }
    Ok(())
}
