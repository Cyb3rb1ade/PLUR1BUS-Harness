//! The real loopback listener ([`TcpLoopback`]) over real 127.0.0.1 connections (review B, RB-4): no connection, however
//! slow or silent, holds a wait past its deadline or keeps the genuine callback from being read. The bounds are generous
//! (seconds where the listener needs milliseconds) so a loaded machine does not fail them; what they rule out is a wait
//! that lasts as long as a client wants.
use super::login::{Incoming, LoopbackListener, TcpLoopback};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const GENUINE: &[u8] = b"GET /auth/callback?code=c&state=s HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";

fn connect(port: u16) -> TcpStream {
    TcpStream::connect(("127.0.0.1", port)).unwrap()
}

/// A client that sends one byte of a request every `every`, until `stop` or `for_` has passed.
fn trickle(
    port: u16,
    every: Duration,
    for_: Duration,
    stop: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut c = connect(port);
        let end = Instant::now() + for_;
        for b in b"GET /auth/callback?state=x HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Slow: "
            .iter()
            .cycle()
        {
            if Instant::now() >= end || stop.load(Ordering::SeqCst) || c.write_all(&[*b]).is_err() {
                return;
            }
            thread::sleep(every);
        }
    })
}

/// Whether the listener closed `c`: the next read sees the end (0 bytes) or a reset, not a read timeout.
fn closed(c: &mut TcpStream) -> bool {
    // macOS refuses socket options on a connection the peer has reset.
    if c.set_read_timeout(Some(Duration::from_secs(5))).is_err() {
        return true;
    }
    let mut b = [0u8; 16];
    match c.read(&mut b) {
        Ok(n) => n == 0,
        Err(e) => matches!(
            e.kind(),
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
        ),
    }
}

fn target(r: &Incoming) -> Option<&str> {
    match r {
        Incoming::Request(req) => Some(req.target.as_str()),
        Incoming::Timeout => None,
    }
}

#[test]
fn complete_callback_heads_respect_the_inclusive_byte_limit() {
    const START: &[u8] = b"GET /auth/callback HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Fixture: ";
    const END: &[u8] = b"\r\n\r\n";
    for (bytes, expected) in [
        (16_383, Some("/auth/callback")),
        (16_384, Some("/auth/callback")),
        (16_385, None),
    ] {
        let mut listener = TcpLoopback::new();
        let port = listener.bind().unwrap();
        let mut client = connect(port);
        let mut head = START.to_vec();
        head.resize(bytes - END.len(), b'x');
        head.extend_from_slice(END);
        client.write_all(&head).unwrap();
        assert_eq!(target(&listener.next(1_000.0)), expected, "{bytes} bytes");
    }
}

#[test]
fn a_trickling_client_does_not_hold_the_wait_past_its_deadline() {
    let mut l = TcpLoopback::new();
    let port = l.bind().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let slow = trickle(
        port,
        Duration::from_millis(100),
        Duration::from_secs(8),
        stop.clone(),
    );
    thread::sleep(Duration::from_millis(100));
    let t0 = Instant::now();
    let r = l.next(300.0);
    let took = t0.elapsed();
    stop.store(true, Ordering::SeqCst);
    slow.join().unwrap();
    assert_eq!(r, Incoming::Timeout);
    assert!(took < Duration::from_secs(3), "next(300 ms) took {took:?}");
}

#[test]
fn a_silent_connection_does_not_hold_the_wait_past_its_deadline() {
    let mut l = TcpLoopback::new();
    let port = l.bind().unwrap();
    let _idle = connect(port);
    thread::sleep(Duration::from_millis(100));
    let t0 = Instant::now();
    let r = l.next(300.0);
    let took = t0.elapsed();
    assert_eq!(r, Incoming::Timeout);
    assert!(took < Duration::from_secs(3), "next(300 ms) took {took:?}");
}

#[test]
fn the_genuine_callback_is_read_while_slow_and_silent_clients_wait() {
    let mut l = TcpLoopback::new();
    let port = l.bind().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let slow = trickle(
        port,
        Duration::from_millis(100),
        Duration::from_secs(20),
        stop.clone(),
    );
    let _idle = connect(port);
    let genuine = thread::spawn(move || {
        thread::sleep(Duration::from_millis(300));
        let mut c = connect(port);
        c.write_all(GENUINE).unwrap();
        c
    });
    let t0 = Instant::now();
    let r = l.next(15_000.0);
    let took = t0.elapsed();
    stop.store(true, Ordering::SeqCst);
    slow.join().unwrap();
    let _c = genuine.join().unwrap();
    assert_eq!(target(&r), Some("/auth/callback?code=c&state=s"));
    assert!(
        took < Duration::from_secs(5),
        "the genuine callback waited {took:?}"
    );
}

#[test]
fn many_empty_connections_neither_hold_the_deadline_nor_hide_the_callback() {
    let mut l = TcpLoopback::new();
    let port = l.bind().unwrap();
    let flood = thread::spawn(move || {
        let end = Instant::now() + Duration::from_millis(1500);
        let mut n = 0;
        let mut genuine = None;
        while Instant::now() < end {
            if let Ok(c) = TcpStream::connect(("127.0.0.1", port)) {
                drop(c);
                n += 1;
            }
            if n == 200 && genuine.is_none() {
                let mut c = connect(port);
                c.write_all(GENUINE).unwrap();
                let source_port = c.local_addr().unwrap().port();
                genuine = Some((c, source_port));
            }
        }
        (n, genuine)
    });
    l.wait_diagnostics = Some(Default::default());
    let t0 = Instant::now();
    let callback = l.next(10_000.0);
    let callback_time = t0.elapsed();
    let trace = l.wait_diagnostics.take().unwrap();

    let t1 = Instant::now();
    let timeout = l.next(300.0);
    let timeout_time = t1.elapsed();
    let (n, genuine) = flood.join().unwrap();
    let genuine_port = genuine.as_ref().map(|(_, source_port)| *source_port);
    let genuine_events: Vec<_> = trace
        .events
        .iter()
        .filter(|(port, _)| Some(*port) == genuine_port)
        .map(|(_, event)| *event)
        .collect();
    assert_eq!(
        target(&callback),
        Some("/auth/callback?code=c&state=s"),
        "callback wait {callback_time:?}, ended by {:?}, accept stopped at {:?}; \
         client connected {n} times, sent callback: {}, callback socket events: {genuine_events:?}; \
         listener accepted {}, evicted {}, omitted {} events; {} accept errors, last: {:?}",
        trace.end,
        trace.last_accept_stop,
        genuine.is_some(),
        trace.accepted,
        trace.evicted,
        trace.omitted_events,
        trace.accept_errors,
        trace.last_accept_error,
    );
    assert_eq!(
        trace.evicted_unread, 0,
        "each accepted connection must be polled before it can be displaced"
    );
    assert!(
        callback_time < Duration::from_secs(6),
        "the callback in the flood waited {callback_time:?}"
    );
    assert!(n >= 200, "only {n} connections were made");
    assert_eq!(timeout, Incoming::Timeout);
    assert!(
        timeout_time < Duration::from_secs(4),
        "next(300 ms) during the flood took {timeout_time:?}"
    );
}

/// A failed `accept` (Windows reports a connection its peer reset before it was accepted this way) ends neither the
/// wait nor the listener: the wait lasts until its deadline, and a callback after the failures is read.
#[test]
fn a_failed_accept_neither_ends_the_wait_nor_hides_the_callback() {
    use std::io::ErrorKind::{ConnectionAborted, ConnectionReset, Interrupted, Other};
    let mut l = TcpLoopback::new();
    let port = l.bind().unwrap();
    l.fail_accepts([ConnectionReset]);
    let t0 = Instant::now();
    assert_eq!(l.next(300.0), Incoming::Timeout);
    let took = t0.elapsed();
    assert!(
        took >= Duration::from_millis(300),
        "a reset connection ended the wait after {took:?}"
    );
    l.fail_accepts([
        ConnectionReset,
        ConnectionAborted,
        Interrupted,
        Other,
        ConnectionReset,
    ]);
    let genuine = thread::spawn(move || {
        thread::sleep(Duration::from_millis(200));
        let mut c = connect(port);
        c.write_all(GENUINE).unwrap();
        c
    });
    let t1 = Instant::now();
    let r = l.next(10_000.0);
    let took = t1.elapsed();
    let _c = genuine.join().unwrap();
    assert_eq!(target(&r), Some("/auth/callback?code=c&state=s"));
    assert!(
        took < Duration::from_secs(5),
        "the callback after failed accepts waited {took:?}"
    );
}

/// An `accept` that keeps failing, with a per-connection error or another one (a descriptor limit, say), neither holds
/// the wait past its deadline nor ends it early. The wait runs on its own thread so that a wait that never ends fails the
/// test instead of hanging it.
#[test]
fn an_accept_that_keeps_failing_holds_the_wait_to_its_deadline() {
    for kind in [
        std::io::ErrorKind::ConnectionReset,
        std::io::ErrorKind::Other,
    ] {
        let mut l = TcpLoopback::new();
        l.bind().unwrap();
        l.fail_accepts(std::iter::repeat(kind));
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let t0 = Instant::now();
            let r = l.next(300.0);
            let _ = tx.send((r, t0.elapsed()));
        });
        let (r, took) = rx.recv_timeout(Duration::from_secs(5)).unwrap_or_else(|_| {
            panic!("next(300 ms) with a failing accept ({kind:?}) did not return")
        });
        assert_eq!(r, Incoming::Timeout);
        assert!(
            took >= Duration::from_millis(300) && took < Duration::from_secs(4),
            "next(300 ms) with a failing accept ({kind:?}) took {took:?}"
        );
    }
}

#[test]
fn a_connection_that_does_not_finish_its_request_in_time_is_closed() {
    let mut l = TcpLoopback::with_request_timeout(Duration::from_millis(300));
    let port = l.bind().unwrap();
    let client = thread::spawn(move || {
        let mut c = connect(port);
        c.write_all(b"GET /auth/callback HTTP/1.1\r\n").unwrap();
        c.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let t0 = Instant::now();
        // The listener answers nothing to an unfinished request: the next read sees the close (0 bytes or a reset).
        (closed(&mut c), t0.elapsed())
    });
    let r = l.next(3000.0);
    let (was_closed, closed_after) = client.join().unwrap();
    assert_eq!(r, Incoming::Timeout);
    assert!(was_closed);
    assert!(
        closed_after < Duration::from_millis(2500),
        "closed after {closed_after:?}"
    );
}

#[test]
fn the_request_deadline_never_outlasts_the_wait() {
    // A request timeout far beyond the wait: the connection is closed with the wait, not after the timeout.
    let mut l = TcpLoopback::with_request_timeout(Duration::from_secs(60));
    let port = l.bind().unwrap();
    let mut c = connect(port);
    c.write_all(b"GET /").unwrap();
    let t0 = Instant::now();
    assert_eq!(l.next(300.0), Incoming::Timeout);
    assert!(t0.elapsed() < Duration::from_secs(3));
    // The next wait finds the connection gone: its deadline was the end of the first wait.
    assert_eq!(l.next(300.0), Incoming::Timeout);
    assert!(
        closed(&mut c),
        "the connection outlived the wait it came in"
    );
}

#[test]
fn an_oversized_request_head_is_dropped_and_the_callback_still_read() {
    let mut l = TcpLoopback::new();
    let port = l.bind().unwrap();
    let big = thread::spawn(move || {
        let mut c = connect(port);
        let _ = c.write_all(&vec![b'a'; 20 * 1024]);
        thread::sleep(Duration::from_millis(300));
        let mut g = connect(port);
        g.write_all(GENUINE).unwrap();
        (c, g)
    });
    let r = l.next(10_000.0);
    let (mut c, _g) = big.join().unwrap();
    assert_eq!(target(&r), Some("/auth/callback?code=c&state=s"));
    // Dropped at once, not after its request timeout.
    let t0 = Instant::now();
    assert!(closed(&mut c), "the oversized connection is still open");
    assert!(t0.elapsed() < Duration::from_secs(4));
}

#[test]
fn the_answer_reaches_the_client() {
    let mut l = TcpLoopback::new();
    let port = l.bind().unwrap();
    let mut c = connect(port);
    c.write_all(GENUINE).unwrap();
    assert!(target(&l.next(5000.0)).is_some());
    l.respond(&super::login::CallbackResponse {
        status: 200,
        headers: vec![],
        body: "ok",
    });
    c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut out = String::new();
    let _ = c.read_to_string(&mut out);
    assert!(out.starts_with("HTTP/1.1 200 OK\r\n"), "{out:?}");
    assert!(out.ends_with("\r\n\r\nok"), "{out:?}");
}

#[test]
fn a_request_and_what_the_listener_delivered_print_no_query() {
    // Review B, RB-7: the target carries the authorization code and the state.
    let req = super::login::CallbackRequest {
        method: "GET".into(),
        target: "/auth/callback?code=the-code&state=the-state#f".into(),
        host: Some("127.0.0.1:1".into()),
        ..Default::default()
    };
    for text in [
        format!("{req:?}"),
        format!("{:?}", Incoming::Request(req.clone())),
    ] {
        assert!(
            !text.contains("the-code") && !text.contains("the-state") && !text.contains('?'),
            "{text}"
        );
        assert!(
            text.contains("/auth/callback") && text.contains("127.0.0.1:1") && text.contains("GET"),
            "{text}"
        );
    }
}

#[test]
fn secrets_compare_by_value() {
    // Review B, H-2: `==` is the constant-time comparison of `matches`, and still an equality.
    use super::secret::Secret;
    assert_eq!(Secret::new("abc"), Secret::new("abc"));
    assert_ne!(Secret::new("abc"), Secret::new("abd"));
    assert_ne!(Secret::new("abc"), Secret::new("abcd"));
    assert_ne!(Secret::new(""), Secret::new("a"));
}
