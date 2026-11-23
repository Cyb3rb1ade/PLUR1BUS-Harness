#![allow(clippy::unwrap_used, reason = "fixture assertions")]

use plur1bus_mcp::bridge_body::{read_json, Body, Error};
use std::{
    io::{self, Cursor, Read},
    time::{Duration, Instant},
};

const LIMIT: usize = 1024 * 1024;
const MARKER: &str = "synthetic-mcp-credential";

struct FixtureBody {
    cursor: Cursor<Vec<u8>>,
    reads: usize,
    simulated_deadline: Option<Instant>,
}

impl FixtureBody {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            cursor: Cursor::new(bytes),
            reads: 0,
            simulated_deadline: None,
        }
    }
}

impl Body for FixtureBody {
    fn read_until(&mut self, buf: &mut [u8], deadline: Instant) -> io::Result<usize> {
        self.reads += 1;
        if self.reads == 2 && self.simulated_deadline == Some(deadline) {
            return Err(io::Error::new(io::ErrorKind::TimedOut, MARKER));
        }
        let max = buf.len().min(4096);
        self.cursor.read(&mut buf[..max])
    }
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(2)
}

fn json_of_size(size: usize) -> Vec<u8> {
    let mut bytes = vec![b'x'; size];
    bytes[0] = b'"';
    bytes[size - 1] = b'"';
    bytes
}

#[test]
fn exact_decoded_ceiling_and_one_byte_over() {
    let mut exact = FixtureBody::new(json_of_size(LIMIT));
    let reply = read_json(200, &mut exact, deadline()).unwrap().unwrap();
    assert_eq!(reply.as_str().unwrap().len(), LIMIT - 2);

    let mut over = FixtureBody::new(json_of_size(LIMIT + 1));
    assert_eq!(read_json(200, &mut over, deadline()), Err(Error::TooLarge));
    assert_eq!(over.cursor.position(), (LIMIT + 1) as u64);
}

#[test]
fn the_same_deadline_reaches_each_successive_read() {
    let deadline = deadline();
    let mut body = FixtureBody::new(json_of_size(8192));
    body.simulated_deadline = Some(deadline);
    assert_eq!(read_json(200, &mut body, deadline), Err(Error::Timeout));
    assert_eq!(body.reads, 2);
}

#[test]
fn a_deadline_that_ended_before_the_body_refuses_the_first_read() {
    let mut body = FixtureBody::new(b"{}".to_vec());
    assert_eq!(
        read_json(200, &mut body, Instant::now()),
        Err(Error::Timeout)
    );
    assert_eq!(body.reads, 0);
}

#[test]
fn a_notification_and_an_http_error_discard_the_body() {
    let mut body = FixtureBody::new(MARKER.as_bytes().to_vec());
    assert_eq!(read_json(202, &mut body, deadline()), Ok(None));
    let error = read_json(403, &mut body, deadline()).unwrap_err();
    assert_eq!(error, Error::Status(403));
    assert!(!format!("{error:?}").contains(MARKER));
    assert_eq!(body.reads, 0);
}

#[test]
fn malformed_json_drops_the_parser_diagnostic() {
    let mut body = FixtureBody::new(MARKER.as_bytes().to_vec());
    let error = read_json(200, &mut body, deadline()).unwrap_err();
    assert_eq!(error, Error::InvalidJson);
    assert!(!format!("{error:?}").contains(MARKER));
}

#[test]
fn successful_replies_match_recorded_typescript_bridge_output() {
    let recording: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/mcp/bridge.json")).unwrap();
    for case in recording["cases"].as_array().unwrap() {
        let mut body = FixtureBody::new(case["body"].as_str().unwrap().as_bytes().to_vec());
        let status = u16::try_from(case["status"].as_u64().unwrap()).unwrap();
        let forwarded = read_json(status, &mut body, deadline()).unwrap();
        assert_eq!(serde_json::to_value(forwarded).unwrap(), case["result"]);
    }
}
