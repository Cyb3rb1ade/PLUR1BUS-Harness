//! The code event connection retains notifications and partial frames across idle timeouts on every transport.
use plur1bus_rpc::transport::Stream;
use plur1bus_rpc::{Client, ConnectOptions, RpcError};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{self, Cursor, Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

enum Step {
    Bytes(Cursor<Vec<u8>>),
    Idle,
}
fn bytes(value: Vec<u8>) -> Step {
    Step::Bytes(Cursor::new(value))
}
fn frame(value: Value) -> Step {
    bytes(format!("{value}\n").into_bytes())
}
struct Script {
    steps: VecDeque<Step>,
    writes: Arc<AtomicUsize>,
}
impl Read for Script {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        loop {
            match self.steps.front_mut() {
                Some(Step::Bytes(input)) => {
                    let n = input.read(out)?;
                    if n > 0 {
                        return Ok(n);
                    }
                    self.steps.pop_front();
                }
                Some(Step::Idle) => {
                    self.steps.pop_front();
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "scripted idle interval",
                    ));
                }
                None => return Ok(0),
            }
        }
    }
}
impl Write for Script {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        self.writes.fetch_add(1, Ordering::Relaxed);
        Ok(input.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Stream for Script {
    fn set_read_timeout(&self, _: Option<Duration>) -> io::Result<()> {
        Ok(())
    }
    fn peer_pid(&self) -> Option<u32> {
        None
    }
    fn peer_uid(&self) -> Option<u32> {
        #[cfg(unix)]
        {
            // SAFETY: geteuid has no preconditions; this in-memory peer represents the current process.
            Some(unsafe { libc::geteuid() })
        }
        #[cfg(not(unix))]
        {
            None
        }
    }
}
fn client(steps: Vec<Step>) -> (Client, Arc<AtomicUsize>) {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../packages/rpc-schema/fixtures/methods/core.auth.json"
    ))
    .unwrap();
    let mut script = VecDeque::from([frame(
        json!({"jsonrpc":"2.0","id":1,"result":fixture["result"]}),
    )]);
    script.extend(steps);
    let writes = Arc::new(AtomicUsize::new(0));
    let client = Client::handshake(
        Box::new(Script {
            steps: script,
            writes: writes.clone(),
        }),
        "fixture-token",
        ConnectOptions::default(),
    )
    .unwrap();
    (client, writes)
}
fn event(seq: u64) -> Value {
    json!({"jsonrpc":"2.0","method":"session.event","params":{"event":{"sessionId":"s","seq":seq}},"future":{"preserved":true}})
}

#[test]
fn notifications_before_the_subscription_reply_are_retained_with_unknown_fields() {
    let (mut client, writes) = client(vec![
        frame(event(1)),
        frame(json!({"jsonrpc":"2.0","id":2,"result":{}})),
        frame(event(2)),
    ]);
    client.enable_notifications();
    client.call("events.subscribe", json!({})).unwrap();
    let before = writes.load(Ordering::Relaxed);
    assert_eq!(client.next_notification().unwrap(), Some(event(1)));
    assert_eq!(client.next_notification().unwrap(), Some(event(2)));
    assert_eq!(
        writes.load(Ordering::Relaxed),
        before,
        "listening never polls through a second RPC path"
    );
}

#[test]
fn idle_timeout_retains_a_partial_utf8_frame_and_does_not_poison_the_event_connection() {
    let value = json!({"jsonrpc":"2.0","method":"session.event","params":{"text":"snowman ☃"}});
    let line = format!("{value}\n").into_bytes();
    let split = line.iter().position(|byte| *byte == 0xe2).unwrap() + 1;
    let (mut client, _) = client(vec![
        bytes(line[..split].to_vec()),
        Step::Idle,
        bytes(line[split..].to_vec()),
        frame(json!({"jsonrpc":"2.0","id":2,"result":{"stillUsable":true}})),
    ]);
    client.enable_notifications();
    assert_eq!(client.next_notification().unwrap(), None);
    assert!(!client.is_poisoned());
    assert_eq!(client.next_notification().unwrap(), Some(value));
    assert_eq!(
        client.call("echo", json!({})).unwrap(),
        json!({"stillUsable":true})
    );
}

#[test]
fn oversized_notifications_poison_the_connection_and_a_closed_peer_is_reported() {
    let (mut oversized, _) = client(vec![bytes(vec![b'x'; plur1bus_rpc::client::MAX_LINE + 1])]);
    oversized.enable_notifications();
    assert!(matches!(
        oversized.next_notification(),
        Err(RpcError::Protocol(_))
    ));
    assert!(oversized.is_poisoned());
    let (mut closed, _) = client(vec![]);
    closed.enable_notifications();
    assert!(
        matches!(closed.next_notification(), Err(RpcError::Unavailable { reason, .. }) if reason == "closed")
    );
    assert!(closed.is_poisoned());
}

#[test]
fn a_complete_invalid_notification_cannot_become_an_event_but_keeps_the_frame_boundary() {
    let (mut client, _) = client(vec![
        frame(json!({"jsonrpc":"2.0","id":99,"result":{}})),
        frame(event(2)),
    ]);
    client.enable_notifications();
    assert!(matches!(
        client.next_notification(),
        Err(RpcError::Protocol(_))
    ));
    assert!(!client.is_poisoned());
    assert_eq!(client.next_notification().unwrap(), Some(event(2)));
}

#[test]
fn an_in_flight_call_can_be_polled_while_events_and_idle_intervals_keep_the_cli_responsive() {
    let result = json!({"futureField":{"kept":true}});
    let (mut client, writes) = client(vec![
        frame(event(1)),
        Step::Idle,
        frame(json!({"jsonrpc":"2.0","id":2,"result":result})),
        frame(event(2)),
    ]);
    client.enable_notifications();
    client.start_call("slow.check", json!({})).unwrap();
    let before = writes.load(Ordering::Relaxed);
    assert!(matches!(
        client.start_call("other", json!({})),
        Err(RpcError::Protocol(_))
    ));
    assert_eq!(
        writes.load(Ordering::Relaxed),
        before,
        "only one request can be in flight on a connection"
    );
    assert_eq!(client.poll_call().unwrap(), None);
    assert!(!client.is_poisoned());
    assert_eq!(client.take_notification().unwrap(), Some(event(1)));
    assert_eq!(client.poll_call().unwrap(), Some(result));
    assert_eq!(client.next_notification().unwrap(), Some(event(2)));
}

#[test]
fn a_subscription_flood_fails_closed_instead_of_silently_losing_notifications() {
    let steps = (0..257)
        .map(|seq| frame(event(seq)))
        .chain([frame(json!({"jsonrpc":"2.0","id":2,"result":{}}))])
        .collect();
    let (mut client, _) = client(steps);
    client.enable_notifications();
    assert!(matches!(
        client.call("events.subscribe", json!({})),
        Err(RpcError::Protocol(_))
    ));
    assert!(client.is_poisoned());
}
