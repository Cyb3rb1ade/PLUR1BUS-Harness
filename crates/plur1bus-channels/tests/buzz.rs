#![cfg(feature = "buzz")]
#![allow(clippy::unwrap_used, clippy::panic)]

use nostr::prelude::{Event, Keys, SecretKey, Tag};
use plur1bus_channels::buzz::{open_gift, Buzz, Entropy, Error, Relay, RelayEvent, Seen};
use plur1bus_channels::websocket::{Limits, Peer, Socket};
use plur1bus_wire_fixtures::{load_fixture, FakeServer};
use serde_json::{json, Value};
use std::time::Duration;
use url::Url;

#[path = "support/socket.rs"]
mod socket;
use socket::Loopback;

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
fn receive_persists_only_fresh_messages_from_permitted_peers() {
    let relay_url = "wss://fixture.invalid";
    let own = Keys::new(SecretKey::from_slice(&[1; 32]).unwrap());
    let permitted = Keys::new(SecretKey::from_slice(&[2; 32]).unwrap());
    let unlisted = Keys::new(SecretKey::from_slice(&[3; 32]).unwrap());
    let now = 1_800_000_000;
    let mut receiver = Buzz::new(&own, &[relay_url], &[permitted.public_key()], &[]).unwrap();
    let mut relay = Relay::new(Url::parse(relay_url).unwrap());
    let mut random = Random(10);
    let mut store = Store::default();
    let announcement = receiver.announce(now, &mut random).unwrap();
    let metadata = json!(["EVENT", "buzz-relays", announcement]).to_string();

    for (author, sent_at, expected) in [
        (&unlisted, now, false),
        (&permitted, now - 30 * 24 * 60 * 60, false),
        (&permitted, now, true),
    ] {
        let mut sender = Buzz::new(author, &[relay_url], &[own.public_key()], &[]).unwrap();
        assert!(matches!(
            sender
                .receive(&mut relay, &metadata, now, &mut random, &mut Store::default())
                .unwrap(),
            RelayEvent::Metadata(peer) if peer == own.public_key()
        ));
        let outgoing = sender
            .wrap(own.public_key(), "Fixture message", sent_at, &mut random)
            .unwrap();
        let raw = json!(["EVENT", "buzz-inbox", &outgoing[0]]).to_string();
        let event = receiver
            .receive(&mut relay, &raw, now, &mut random, &mut store)
            .unwrap();
        if expected {
            let RelayEvent::Message(message) = event else {
                panic!("expected a message from the permitted peer");
            };
            assert_eq!(message.sender, permitted.public_key());
            assert_eq!(message.text, "Fixture message");
            assert!(store.0.contains(&message.id));
            let saved = store.0.clone();
            assert!(matches!(
                receiver
                    .receive(&mut relay, &raw, now, &mut random, &mut store)
                    .unwrap(),
                RelayEvent::Ignored
            ));
            assert_eq!(store.0, saved);
        } else {
            assert!(matches!(event, RelayEvent::Ignored));
            assert!(store.0.is_empty());
        }
    }
}

#[test]
fn replays_buzz_subscriptions_encrypted_delivery_and_authentication() {
    let fixture = load_fixture("channels", "buzz-relay");
    let server = FakeServer::start(&fixture);
    let endpoint = Url::parse(&format!("ws://{}", server.addr)).unwrap();
    let port = Loopback(server.addr);
    let mut ws = Socket::connect(&endpoint, &[], &port, Limits::default(), true).unwrap();
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
