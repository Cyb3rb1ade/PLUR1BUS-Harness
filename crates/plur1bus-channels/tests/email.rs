#![cfg(feature = "email")]
#![allow(clippy::unwrap_used)]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_channels::email::{imap, mime, smtp, Options, Ports, Security, TimedStream};
use plur1bus_wire_fixtures::{load_fixture, FakeServer};
use serde_json::{json, Value};
use std::cell::Cell;
use std::io;
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

const USER: &str = "fixture-sender@example.invalid";
const PASSWORD: &str = "synthetic-mail-marker";

struct Stub {
    addr: SocketAddr,
    upgrades: Cell<usize>,
}

impl Ports for Stub {
    fn connect(
        &self,
        host: &str,
        port: u16,
        _deadline: Instant,
    ) -> io::Result<Box<dyn TimedStream>> {
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, self.addr.port());
        Ok(Box::new(TcpStream::connect_timeout(
            &self.addr,
            Duration::from_secs(1),
        )?))
    }
    fn upgrade(
        &self,
        _: &str,
        stream: Box<dyn TimedStream>,
        _: Instant,
    ) -> io::Result<Box<dyn TimedStream>> {
        self.upgrades.set(self.upgrades.get() + 1);
        Ok(stream)
    }
}

fn recorded(name: &str) -> Value {
    let mut fixture = load_fixture("channels", name);
    let auth = STANDARD.encode(format!("\0{USER}\0{PASSWORD}"));
    for exchange in fixture["exchanges"].as_array_mut().unwrap() {
        for chunk in exchange["sendBase64"].as_array_mut().unwrap() {
            let decoded = String::from_utf8(bytes(chunk)).unwrap();
            *chunk = json!(STANDARD.encode(
                decoded
                    .replace("[FIXTURE:MAIL_PLAIN]", &auth)
                    .replace("[FIXTURE:MAIL_PASSWORD]", PASSWORD)
            ));
        }
    }
    fixture
}

fn bytes(value: &Value) -> Vec<u8> {
    STANDARD.decode(value.as_str().unwrap()).unwrap()
}

fn options(server: &FakeServer) -> Options<'_> {
    Options {
        host: "127.0.0.1",
        port: server.addr.port(),
        user: USER,
        password: PASSWORD,
        security: Security::StartTls,
        timeout: Duration::from_secs(2),
    }
}

fn verify(name: &str, ports: &Stub, server: &FakeServer, fixture: &Value, observed: &Value) {
    let recorded: Vec<_> = fixture["exchanges"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|e| e["sendBase64"].as_array().unwrap().iter().cloned())
        .collect();
    assert_eq!(*observed, fixture["expected"], "{name}");
    assert_eq!(
        ports.upgrades.get(),
        fixture["upgrades"].as_array().unwrap().len(),
        "{name}"
    );
    assert_eq!(server.received(), recorded, "{name}");
}

#[test]
fn smtp_replays_send_and_refuses_to_authenticate_before_tls() {
    for name in ["smtp-send", "smtp-deferred", "smtp-no-starttls"] {
        let fixture = recorded(name);
        let server = FakeServer::start(&fixture);
        let ports = Stub {
            addr: server.addr,
            upgrades: Cell::new(0),
        };
        let opt = options(&server);
        let input = &fixture["input"];
        let observed = smtp::send(
            &ports,
            &opt,
            "example.invalid",
            input["from"].as_str().unwrap(),
            input["to"].as_str().unwrap(),
            &bytes(&input["dataBase64"]),
        )
        .map_or_else(
            |error| json!({"error": error}),
            |()| json!({"result": null}),
        );
        verify(name, &ports, &server, &fixture, &observed);
    }
}

#[test]
fn imap_replays_size_literal_and_uid_operations_over_starttls() {
    for name in ["imap-fetch", "imap-no-starttls"] {
        let mut fixture = recorded(name);
        if name == "imap-fetch" {
            // R-W-28 changes only the SEARCH interval in this TypeScript recording.
            let expected = STANDARD.encode("A0007 UID SEARCH UID 1:*\r\n");
            let replacement = STANDARD.encode("A0007 UID SEARCH UID 1:1\r\n");
            let commands = fixture["exchanges"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .flat_map(|exchange| exchange["sendBase64"].as_array_mut().unwrap());
            let mut changed = 0;
            for command in commands {
                if command == &expected {
                    *command = json!(replacement);
                    changed += 1;
                }
            }
            assert_eq!(changed, 1);
        }
        let server = FakeServer::start(&fixture);
        let ports = Stub {
            addr: server.addr,
            upgrades: Cell::new(0),
        };
        let observed = (|| {
            let (mut connection, caps, select) = imap::open(&ports, &options(&server), "INBOX")?;
            let uids = connection.uids_above(0)?;
            let size = connection.fetch_size(1)?;
            let data = connection.fetch_raw(1)?;
            connection.mark_seen(1)?;
            Ok(json!({"caps": caps, "select": select, "uids": uids, "size": size, "dataBase64": STANDARD.encode(data)}))
        })().map_or_else(|error: plur1bus_channels::email::Error| json!({"error": error}), |result| json!({"result": result}));
        verify(name, &ports, &server, &fixture, &observed);
    }
}

#[test]
fn mime_replays_build_bytes_and_parser_envelopes() {
    // MIME documents are raw exported byte vectors without a socket transcript.
    let raw = include_str!("../../../fixtures/parity/channels/email-mime.json");
    let fixture: Value = serde_json::from_str(raw).unwrap();
    let input: mime::BuildInput =
        serde_json::from_value(fixture["build"]["input"].clone()).unwrap();
    let mut boundaries = fixture["build"]["input"]["boundaries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap());
    let built = mime::build(&input, || boundaries.next().unwrap().to_owned()).unwrap();
    assert_eq!(built, bytes(&fixture["build"]["bytesBase64"]));
    for variant in fixture["variants"].as_array().unwrap() {
        let options = serde_json::from_value(
            variant["options"]
                .as_object()
                .map_or_else(|| json!({}), |m| json!(m)),
        )
        .unwrap();
        let parsed = mime::parse(&bytes(&variant["bytesBase64"]), options);
        let mut output = json!(parsed);
        for key in ["from", "to", "date", "content-type", "return-path"] {
            output["headers"][key] = json!(parsed.headers.get_all(key));
        }
        assert_eq!(output, variant["expected"], "{}", variant["name"]);
    }
}

#[test]
fn a_zero_part_budget_does_not_render_the_root_entity() {
    let message = b"From: test@example.invalid\r\n\r\nReport";
    assert_eq!(
        mime::parse(
            message,
            mime::ParseOptions {
                max_parts: 0,
                ..Default::default()
            }
        )
        .text,
        ""
    );
    assert_eq!(
        mime::parse(
            message,
            mime::ParseOptions {
                max_parts: 1,
                ..Default::default()
            }
        )
        .text,
        "Report"
    );
}

#[test]
fn imap_reduces_a_limited_search_and_checkpoints_completed_pages() {
    let mut fixture = recorded("imap-fetch");
    let exchanges = fixture["exchanges"].as_array_mut().unwrap();
    exchanges.truncate(8);
    exchanges[7]["receiveChunksBase64"] = json!([
        STANDARD.encode("* 3 EXISTS\r\n* OK [UIDVALIDITY 1] mailbox\r\nA0006 OK selected\r\n")
    ]);
    for (tag, command, result) in [
        (7, "UID SEARCH *", "* SEARCH 8\r\nA0007 OK last"),
        (
            8,
            "UID SEARCH UID 1:8",
            "A0008 NO [LIMIT] narrower search required",
        ),
        (
            9,
            "UID SEARCH UID 1:4",
            "* SEARCH 4 2 2\r\nA0009 OK first page",
        ),
        (
            10,
            "UID SEARCH UID 5:8",
            "* SEARCH 8\r\nA0010 OK second page",
        ),
        (11, "UID SEARCH *", "* SEARCH 8\r\nA0011 OK last"),
        (12, "UID SEARCH UID 5:8", "* SEARCH 8\r\nA0012 OK resumed"),
    ] {
        exchanges.push(json!({
            "sendBase64":[STANDARD.encode(format!("A{tag:04} {command}\r\n"))],
            "receiveChunksBase64":[STANDARD.encode(format!("{result}\r\n"))]
        }));
    }
    let server = FakeServer::start(&fixture);
    let ports = Stub {
        addr: server.addr,
        upgrades: Cell::default(),
    };
    let (mut connection, _, _) = imap::open(&ports, &options(&server), "INBOX").unwrap();
    let mut cursor = 0;
    let mut delivered = Vec::new();
    let pause = connection.for_each_uid_page(&mut cursor, |_, uids| {
        if !delivered.is_empty() {
            return Err(plur1bus_channels::email::Error {
                kind: plur1bus_channels::email::Kind::State,
                message: "consumer paused",
            });
        }
        delivered.extend_from_slice(uids);
        Ok(())
    });
    assert!(pause.is_err());
    assert_eq!(cursor, 4);
    assert_eq!(delivered, [2, 4]);
    connection
        .for_each_uid_page(&mut cursor, |_, uids| {
            delivered.extend_from_slice(uids);
            Ok(())
        })
        .unwrap();
    assert_eq!(cursor, 8);
    assert_eq!(delivered, [2, 4, 8]);
    let expected: Vec<_> = fixture["exchanges"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|ex| ex["sendBase64"].as_array().unwrap().iter().cloned())
        .collect();
    assert_eq!(server.received(), expected);
}

#[test]
fn imap_returns_large_mailbox_in_order_over_the_wire() {
    let first = 1_000_001;
    let last = first + 19_999;
    let mut fixture = recorded("imap-fetch");
    let exchanges = fixture["exchanges"].as_array_mut().unwrap();
    exchanges.truncate(8);
    exchanges[7]["receiveChunksBase64"] = json!([STANDARD.encode(format!(
        "* 20000 EXISTS\r\n* OK [UIDVALIDITY 1] mailbox\r\n* OK [UIDNEXT {}] next\r\nA0006 OK selected\r\n",
        last + 1
    ))]);
    for (page, start) in (first..=last).step_by(4096).enumerate() {
        let end = (start + 4095).min(last);
        let tag = page + 7;
        let ids = (start..=end)
            .map(|uid| uid.to_string())
            .collect::<Vec<_>>()
            .join(" ");
        let reply = format!("* SEARCH {ids}\r\nA{tag:04} OK searched\r\n");
        assert!(reply.len() < 65_536);
        exchanges.push(json!({
            "sendBase64": [STANDARD.encode(format!("A{tag:04} UID SEARCH UID {start}:{end}\r\n"))],
            "receiveChunksBase64": [STANDARD.encode(reply)]
        }));
    }
    let server = FakeServer::start(&fixture);
    let ports = Stub {
        addr: server.addr,
        upgrades: Cell::default(),
    };
    let (mut connection, _, _) = imap::open(&ports, &options(&server), "INBOX").unwrap();
    let mut cursor = first - 1;
    let mut received = Vec::new();
    connection
        .for_each_uid_page(&mut cursor, |_, uids| {
            received.extend_from_slice(uids);
            Ok(())
        })
        .unwrap();
    assert_eq!(received, (first..=last).collect::<Vec<_>>());
    assert_eq!(cursor, last);
}

#[test]
fn parsed_attachment_names_drop_leading_periods() {
    let input = b"From: reader@example.invalid\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=...edition.txt\r\n\r\nNews";
    let parsed = mime::parse(input, Default::default());
    assert_eq!(parsed.attachments.len(), 1);
    assert_eq!(
        parsed.attachments[0].filename.as_deref(),
        Some("edition.txt")
    );
}
