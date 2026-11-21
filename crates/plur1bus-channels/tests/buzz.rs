#![cfg(feature = "buzz")]
#![allow(clippy::unwrap_used, clippy::panic)]

use nostr::prelude::{Event, Keys, SecretKey, Tag};
use plur1bus_channels::buzz::{open_gift, Buzz, Entropy, Error, Relay, RelayEvent, Seen};
use plur1bus_channels::websocket::{Limits, Peer, Socket, SocketPorts, TimedStream};
use plur1bus_wire_fixtures::{load_fixture, FakeServer};
use serde_json::{json, Value};
use std::io;
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};
use url::Url;

struct Loopback(SocketAddr);
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

struct Random(u8);
impl Entropy for Random {
    fn bytes(&mut self) -> Result<[u8; 32], Error> {
        self.0 += 1;
        Ok([self.0; 32])
    }
}

#[derive(Default)]
struct Store(Vec<String>);
impl Seen for Store {
    fn save(&mut self, ids: &[String]) -> Result<(), Error> {
        self.0 = ids.to_vec();
        Ok(())
    }
}

fn normalized(signed: &Event) -> Value {
    signed.verify().unwrap();
    let mut value: Value = serde_json::from_str(&signed.as_json()).unwrap();
    value.as_object_mut().unwrap().remove("sig");
    value
}

#[test]
fn replays_buzz_subscriptions_encrypted_delivery_and_authentication() {
    let fixture = load_fixture("channels", "buzz-relay");
    let server = FakeServer::start(&fixture);
    let endpoint = Url::parse(&format!("ws://{}", server.addr)).unwrap();
    let mut ws = Socket::connect(
        &endpoint,
        &[],
        &Loopback(server.addr),
        Limits::default(),
        true,
    )
    .unwrap();
    let own = Keys::new(SecretKey::from_slice(&[1; 32]).unwrap());
    let peer = Keys::new(SecretKey::from_slice(&[2; 32]).unwrap());
    let relay_url = fixture["relay"].as_str().unwrap();
    let wanted = Url::parse(relay_url).unwrap();
    let now = fixture["now"].as_u64().unwrap();
    let mut adapter = Buzz::new(&own, &[relay_url], &[peer.public_key()], &[]).unwrap();
    let mut relay = Relay::new(wanted.clone());
    let mut random = Random(10);
    let mut store = Store::default();
    let frames = adapter.subscriptions(now).unwrap();
    assert_eq!(json!(&frames), fixture["requestTexts"]);
    for raw in &frames {
        ws.send_text(raw).unwrap();
    }
    let mut messages = Vec::new();
    for _ in fixture["exchanges"][0]["receive"].as_array().unwrap() {
        let Peer::Text(raw) = ws.receive(Duration::from_secs(1)).unwrap() else {
            panic!("expected relay text")
        };
        if let RelayEvent::Message(message) = adapter
            .receive(&mut relay, &raw, now, &mut random, &mut store)
            .unwrap()
        {
            messages.push(json!({
                "text": message.text, "senderId": message.sender.to_hex(), "messageId": message.id,
                "persisted": store.0.contains(&message.id),
            }));
        }
    }
    assert_eq!(
        store.0,
        serde_json::from_value::<Vec<String>>(fixture["expected"]["saved"].clone()).unwrap()
    );
    assert_eq!(json!(messages), fixture["expected"]["messages"]);
    assert_eq!(adapter.destinations(peer.public_key()), &[wanted]);
    let announcement = adapter.announce(now, &mut random).unwrap();
    assert_eq!(
        normalized(&announcement),
        fixture["expected"]["announcement"]
    );
    let auth: Vec<_> = fixture["auth"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|challenge| {
            let raw = json!(["AUTH", challenge]).to_string();
            match adapter
                .receive(&mut relay, &raw, now, &mut random, &mut store)
                .unwrap()
            {
                RelayEvent::Authenticate(event) => Some(normalized(&event)),
                _ => None,
            }
        })
        .collect();
    assert_eq!(json!(auth), fixture["expected"]["authentication"]);

    let outbound = adapter
        .wrap(
            peer.public_key(),
            fixture["response"].as_str().unwrap(),
            now,
            &mut random,
        )
        .unwrap();
    let published: Vec<_> = outbound.iter().enumerate().map(|(i, evt)| {
        let recipient = if i == 0 { &peer } else { &own };
        let rumor = open_gift(recipient, evt).unwrap();
        let tags: Vec<_> = rumor.tags.iter().map(Tag::as_slice).collect();
        json!({"toPeer": i == 0, "id": rumor.compute_id().to_hex(), "text": rumor.content, "kind": u16::from(rumor.kind), "tags":tags})
    }).collect();
    assert_eq!(json!(published), fixture["expected"]["published"]);
    for event in outbound {
        assert!(relay.begin_publish(&event, 1000).is_ok());
        let received = json!(["OK", event.id.to_hex(), true, ""]).to_string();
        assert!(matches!(
            adapter
                .receive(&mut relay, &received, now, &mut random, &mut store)
                .unwrap(),
            RelayEvent::Receipt { accepted: true, .. }
        ));
    }
}
