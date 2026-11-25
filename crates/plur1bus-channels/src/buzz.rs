//! Buzz relay messages, NIP-42 authentication, and signed NIP-59 direct messages.
use nostr::nips::nip44::{self, Nonce};
use nostr::prelude::{
    Event, EventId, Keys, Kind, PublicKey, SecretKey, Tag, Timestamp, UnsignedEvent,
};
use secp256k1::{All, Secp256k1};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::LazyLock;
use url::{Host, Url};
use zeroize::Zeroizing;

const FRESHNESS: u64 = 172_800;
const FUTURE: u64 = 300;
const MAX_TEXT: usize = 16_384;
const MAX_FRAME: usize = 131_072;
const MAX_SEEN: usize = 4096;
const MAX_PENDING: usize = 128;
const RECEIPT_MS: u64 = 8000;
const INBOX: &str = "buzz-inbox";
const METADATA: &str = "buzz-relays";
static SECP: LazyLock<Secp256k1<All>> = LazyLock::new(Secp256k1::new);

pub trait Entropy {
    /// Fill from a cryptographically secure host source in production.
    fn bytes(&mut self) -> Result<[u8; 32], Error>;
}

pub trait Seen {
    /// Atomically persist the new ordered replay window before a message is handed to the caller.
    fn save(&mut self, ids: &[String]) -> Result<(), Error>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Configuration,
    Crypto,
    Destination,
    Entropy,
    Protocol,
    ReplayStore,
    Size,
    NoPermit,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Configuration => "invalid Buzz relay configuration",
            Self::Crypto => "invalid Buzz event",
            Self::Destination => "Buzz recipient has no permitted DM relay",
            Self::Entropy => "Buzz entropy unavailable",
            Self::Protocol => "invalid Buzz relay frame",
            Self::ReplayStore => "Buzz replay store unavailable",
            Self::Size => "Buzz message too large",
            Self::NoPermit => "Buzz relay not authorized",
        })
    }
}

impl std::error::Error for Error {}

pub struct Incoming {
    pub sender: PublicKey,
    pub id: String,
    pub text: String,
}

pub enum RelayEvent {
    Ignored,
    EndOfStored(String),
    Authenticate(Event),
    Receipt { id: EventId, accepted: bool },
    Message(Incoming),
    Metadata(PublicKey),
}

pub struct Relay {
    url: Url,
    challenges: u8,
    pending: HashMap<EventId, u64>,
}

impl Relay {
    pub fn new(url: Url) -> Self {
        Self {
            url,
            challenges: 0,
            pending: HashMap::new(),
        }
    }

    pub fn begin_publish(&mut self, signed: &Event, now_ms: u64) -> Result<String, Error> {
        if self.pending.len() >= MAX_PENDING || self.pending.contains_key(&signed.id) {
            return Err(Error::Protocol);
        }
        let wire = serde_json::to_string(&("EVENT", signed)).map_err(|_| Error::Protocol)?;
        if wire.len() > MAX_FRAME {
            return Err(Error::Size);
        }
        self.pending
            .insert(signed.id, now_ms.saturating_add(RECEIPT_MS));
        Ok(wire)
    }

    pub fn expire(&mut self, now_ms: u64) -> Vec<EventId> {
        let mut expired = Vec::new();
        self.pending.retain(|id, deadline| {
            if *deadline <= now_ms {
                expired.push(*id);
                false
            } else {
                true
            }
        });
        expired.sort_unstable();
        expired
    }

    pub fn closed(&mut self) -> Vec<EventId> {
        self.challenges = 0;
        self.expire(u64::MAX)
    }

    pub fn backoff(failures: u32, random: f64) -> u64 {
        let base = (1000u64 << failures.min(6)).min(60_000);
        (base as f64 * (0.75 + random.clamp(0., 1.) * 0.5)).round() as u64
    }
}

struct Metadata {
    timestamp: u64,
    relays: Vec<Url>,
}

pub struct Buzz<'a> {
    keys: &'a Keys,
    relays: Vec<Url>,
    permitted: Vec<PublicKey>,
    seen: HashSet<EventId>,
    order: VecDeque<EventId>,
    metadata: HashMap<PublicKey, Metadata>,
}

impl<'a> Buzz<'a> {
    pub fn new(
        keys: &'a Keys,
        relays: &[&str],
        peers: &[PublicKey],
        prior: &[String],
    ) -> Result<Self, Error> {
        if relays.is_empty() || relays.len() > 16 || peers.len() > 256 || prior.len() > MAX_SEEN {
            return Err(Error::Configuration);
        }
        let mut allowed_relays = Vec::new();
        for value in relays {
            let url = relay_url(value)?;
            if !allowed_relays.contains(&url) {
                allowed_relays.push(url);
            }
        }
        let mut permitted = Vec::new();
        for key in peers {
            if !permitted.contains(key) {
                permitted.push(*key);
            }
        }
        let mut seen = HashSet::new();
        let mut order = VecDeque::new();
        for raw in prior {
            let id = EventId::from_hex(raw).map_err(|_| Error::ReplayStore)?;
            if seen.insert(id) {
                order.push_back(id);
            }
        }
        Ok(Self {
            keys,
            relays: allowed_relays,
            permitted,
            seen,
            order,
            metadata: HashMap::new(),
        })
    }

    pub fn subscriptions(&self, now: u64) -> Result<Vec<String>, Error> {
        #[derive(Serialize)]
        struct InboxFilter {
            kinds: [u16; 1],
            #[serde(rename = "#p")]
            recipients: [PublicKey; 1],
            since: i64,
        }
        #[derive(Serialize)]
        struct RelayFilter<'a> {
            kinds: [u16; 1],
            authors: &'a [PublicKey],
        }
        let inbox = InboxFilter {
            kinds: [1059],
            recipients: [self.keys.public_key()],
            since: i64::try_from(now).unwrap_or(i64::MAX) - FRESHNESS as i64,
        };
        let mut lines =
            vec![serde_json::to_string(&("REQ", INBOX, inbox)).map_err(|_| Error::Protocol)?];
        if !self.permitted.is_empty() {
            let metadata = RelayFilter {
                kinds: [10050],
                authors: &self.permitted,
            };
            lines.push(
                serde_json::to_string(&("REQ", METADATA, metadata)).map_err(|_| Error::Protocol)?,
            );
        }
        Ok(lines)
    }

    pub fn announce(&self, now: u64, random: &mut dyn Entropy) -> Result<Event, Error> {
        let tags = self
            .relays
            .iter()
            .map(|url| Tag::parse(["relay", url.as_str()]).map_err(|_| Error::Protocol))
            .collect::<Result<Vec<_>, _>>()?;
        sign(self.keys, Kind::from(10050), now, tags, "", random)
    }

    pub fn destinations(&self, peer: PublicKey) -> &[Url] {
        self.metadata
            .get(&peer)
            .map_or(&[], |metadata| &metadata.relays)
    }

    /// Produces the recipient envelope followed by the sender's archive envelope. The
    /// host waits for at least one recipient relay's acceptance and treats archive errors separately.
    pub fn wrap(
        &self,
        peer: PublicKey,
        content: &str,
        now: u64,
        random: &mut dyn Entropy,
    ) -> Result<[Event; 2], Error> {
        if !self.permitted.contains(&peer) || self.destinations(peer).is_empty() {
            return Err(Error::Destination);
        }
        if content.len() > MAX_TEXT {
            return Err(Error::Size);
        }
        let mut rumor = UnsignedEvent::new(
            self.keys.public_key(),
            Timestamp::from_secs(now),
            Kind::from(14),
            [Tag::public_key(peer)],
            content,
        );
        rumor.ensure_id();
        Ok([
            wrap_for(self.keys, peer, &rumor, now, random)?,
            wrap_for(self.keys, self.keys.public_key(), &rumor, now, random)?,
        ])
    }

    pub fn receive(
        &mut self,
        relay: &mut Relay,
        raw: &str,
        now: u64,
        random: &mut dyn Entropy,
        store: &mut dyn Seen,
    ) -> Result<RelayEvent, Error> {
        if !self.relays.contains(&relay.url) {
            return Err(Error::NoPermit);
        }
        if raw.encode_utf16().take(MAX_FRAME + 1).count() > MAX_FRAME {
            return Ok(RelayEvent::Ignored);
        }
        let Ok(Value::Array(frame)) = serde_json::from_str(raw) else {
            return Ok(RelayEvent::Ignored);
        };
        let Some(command) = frame.first().and_then(Value::as_str) else {
            return Ok(RelayEvent::Ignored);
        };
        let data = frame.get(1).and_then(Value::as_str);
        match (command, data) {
            ("OK", Some(raw)) => {
                if let Ok(id) = EventId::from_hex(raw) {
                    if relay.pending.remove(&id).is_some() {
                        return Ok(RelayEvent::Receipt {
                            id,
                            accepted: frame.get(2) == Some(&Value::Bool(true)),
                        });
                    }
                }
                Ok(RelayEvent::Ignored)
            }
            ("AUTH", Some(challenge))
                if challenge.encode_utf16().take(1025).count() <= 1024 && relay.challenges < 3 =>
            {
                relay.challenges += 1;
                let tags = [
                    Tag::parse(["relay", relay.url.as_str()]).map_err(|_| Error::Protocol)?,
                    Tag::parse(["challenge", challenge]).map_err(|_| Error::Protocol)?,
                ];
                sign(self.keys, Kind::from(22242), now, tags, "", random)
                    .map(RelayEvent::Authenticate)
            }
            ("EOSE", Some(sub @ (INBOX | METADATA))) => Ok(RelayEvent::EndOfStored(sub.to_owned())),
            ("EVENT", Some(sub @ (INBOX | METADATA))) => {
                let sub = if sub == INBOX { INBOX } else { METADATA };
                let event = frame
                    .into_iter()
                    .nth(2)
                    .and_then(|v| serde_json::from_value::<Event>(v).ok());
                if let Some(event) = event {
                    self.handle(sub, &event, now, store)
                } else {
                    Ok(RelayEvent::Ignored)
                }
            }
            _ => Ok(RelayEvent::Ignored),
        }
    }

    fn handle(
        &mut self,
        subscription: &str,
        event: &Event,
        now: u64,
        store: &mut dyn Seen,
    ) -> Result<RelayEvent, Error> {
        if event.created_at.as_secs() > now.saturating_add(FUTURE) {
            return Ok(RelayEvent::Ignored);
        }
        if subscription == METADATA && u16::from(event.kind) == 10050 {
            return Ok(self.record_metadata(event));
        }
        if !self.accepts_wrapper(subscription, event, now) {
            return Ok(RelayEvent::Ignored);
        }
        let Ok(rumor) = open_gift(self.keys, event) else {
            return Ok(RelayEvent::Ignored);
        };
        let Some(id) = rumor.id else {
            return Ok(RelayEvent::Ignored);
        };
        if !self.accepts_rumor(&rumor, id, now) {
            return Ok(RelayEvent::Ignored);
        }
        let mut next = self.order.clone();
        next.extend([event.id, id]);
        while next.len() > MAX_SEEN {
            next.pop_front();
        }
        let values: Vec<_> = next.iter().map(EventId::to_hex).collect();
        store.save(&values)?;
        self.seen = next.iter().copied().collect();
        self.order = next;
        Ok(RelayEvent::Message(Incoming {
            sender: rumor.pubkey,
            id: id.to_hex(),
            text: rumor.content,
        }))
    }

    fn accepts_wrapper(&self, subscription: &str, event: &Event, now: u64) -> bool {
        subscription == INBOX
            && event.kind == Kind::GiftWrap
            && fresh(event.created_at, now)
            && !self.seen.contains(&event.id)
            && addressed(event.tags.iter(), self.keys.public_key())
    }

    fn accepts_rumor(&self, rumor: &UnsignedEvent, id: EventId, now: u64) -> bool {
        u16::from(rumor.kind) == 14
            && self.permitted.contains(&rumor.pubkey)
            && rumor.pubkey != self.keys.public_key()
            && !self.seen.contains(&id)
            && rumor.content.len() <= MAX_TEXT
            && fresh(rumor.created_at, now)
            && addressed(rumor.tags.iter(), self.keys.public_key())
    }

    fn record_metadata(&mut self, event: &Event) -> RelayEvent {
        if !self.permitted.contains(&event.pubkey)
            || self
                .metadata
                .get(&event.pubkey)
                .is_some_and(|prior| prior.timestamp >= event.created_at.as_secs())
            || event.verify().is_err()
        {
            return RelayEvent::Ignored;
        }
        let relays = event
            .tags
            .iter()
            .filter_map(|tag| {
                let [first, candidate, ..] = tag.as_slice() else {
                    return None;
                };
                (first == "relay")
                    .then(|| relay_url(candidate).ok())
                    .flatten()
            })
            .filter(|url| self.relays.contains(url))
            .collect();
        self.metadata.insert(
            event.pubkey,
            Metadata {
                timestamp: event.created_at.as_secs(),
                relays,
            },
        );
        RelayEvent::Metadata(event.pubkey)
    }
}

pub fn open_gift(keys: &Keys, wrap: &Event) -> Result<UnsignedEvent, Error> {
    if wrap.kind != Kind::GiftWrap || wrap.verify().is_err() {
        return Err(Error::Crypto);
    }
    let crypto = |_| Error::Crypto;
    let seal = nip44::decrypt(keys.secret_key(), &wrap.pubkey, &wrap.content).map_err(crypto)?;
    let seal = Event::from_json(seal).map_err(crypto)?;
    if seal.kind != Kind::Seal || seal.verify().is_err() {
        return Err(Error::Crypto);
    }
    let rumor = nip44::decrypt(keys.secret_key(), &seal.pubkey, &seal.content).map_err(crypto)?;
    let rumor = UnsignedEvent::from_json(rumor).map_err(crypto)?;
    validate_rumor_sender(&rumor, seal.pubkey)?;
    Ok(rumor)
}

fn validate_rumor_sender(rumor: &UnsignedEvent, author: PublicKey) -> Result<(), Error> {
    if rumor.pubkey != author || rumor.id != Some(rumor.compute_id()) {
        return Err(Error::Crypto);
    }
    #[cfg(test)]
    tests::VERIFIED_SENDERS.set(tests::VERIFIED_SENDERS.get() + 1);
    Ok(())
}

fn wrap_for(
    keys: &Keys,
    receiver: PublicKey,
    rumor: &UnsignedEvent,
    now: u64,
    random: &mut dyn Entropy,
) -> Result<Event, Error> {
    let encrypt = |keys: &Keys, content: &str, nonce| {
        nip44::encrypt_with_nonce(keys.secret_key(), &receiver, content, Nonce::V2(nonce))
            .map_err(|_| Error::Crypto)
    };
    let message = rumor.try_as_json().map_err(|_| Error::Crypto)?;
    let ciphertext = encrypt(keys, &message, random.bytes()?)?;
    let timestamp = obscured_time(now, random.bytes()?);
    let seal = sign(keys, Kind::Seal, timestamp, [], ciphertext, random)?;
    let ephemeral = ephemeral(random)?;
    let message = seal.try_as_json().map_err(|_| Error::Crypto)?;
    let ciphertext = encrypt(&ephemeral, &message, random.bytes()?)?;
    let timestamp = obscured_time(now, random.bytes()?);
    sign(
        &ephemeral,
        Kind::GiftWrap,
        timestamp,
        [Tag::public_key(receiver)],
        ciphertext,
        random,
    )
}

fn obscured_time(now: u64, random: [u8; 32]) -> u64 {
    let mut prefix = [0; 8];
    prefix.copy_from_slice(&random[..8]);
    now.saturating_sub(u64::from_be_bytes(prefix) % FRESHNESS)
}

fn ephemeral(random: &mut dyn Entropy) -> Result<Keys, Error> {
    for _ in 0..8 {
        let secret = Zeroizing::new(random.bytes()?);
        if let Ok(key) = SecretKey::from_slice(secret.as_slice()) {
            return Ok(Keys::new(key));
        }
    }
    Err(Error::Entropy)
}

fn sign(
    keys: &Keys,
    kind: Kind,
    now: u64,
    tags: impl IntoIterator<Item = Tag>,
    text: impl Into<String>,
    random: &mut dyn Entropy,
) -> Result<Event, Error> {
    let event = UnsignedEvent::new(
        keys.public_key(),
        Timestamp::from_secs(now),
        kind,
        tags,
        text,
    );
    let id = event.compute_id();
    let sig = keys.sign_schnorr_with_aux_rand(&SECP, id.as_bytes(), &random.bytes()?);
    Ok(Event::new(
        id,
        event.pubkey,
        event.created_at,
        event.kind,
        event.tags,
        event.content,
        sig,
    ))
}

fn fresh(timestamp: Timestamp, now: u64) -> bool {
    (now.saturating_sub(FRESHNESS)..=now.saturating_add(FUTURE)).contains(&timestamp.as_secs())
}

fn addressed<'a>(tags: impl Iterator<Item = &'a Tag>, recipient: PublicKey) -> bool {
    let mut recipients = tags
        .map(Tag::as_slice)
        .filter(|tag| tag.first().is_some_and(|key| key == "p"));
    recipients
        .next()
        .and_then(|tag| tag.get(1))
        .is_some_and(|key| *key == recipient.to_hex())
        && recipients.next().is_none()
}

pub fn relay_url(raw: &str) -> Result<Url, Error> {
    let url = Url::parse(raw).map_err(|_| Error::Configuration)?;
    let loopback = match url.host() {
        Some(Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
        Some(Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
        _ => false,
    };
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "wss" || (url.scheme() == "ws" && loopback))
    {
        return Err(Error::Configuration);
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    thread_local! {
        pub(super) static VERIFIED_SENDERS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    #[test]
    fn receiving_a_recorded_message_checks_the_wrapper_and_verified_sender() -> Result<(), Error> {
        struct NoRandom;
        impl Entropy for NoRandom {
            fn bytes(&mut self) -> Result<[u8; 32], Error> {
                Err(Error::Entropy)
            }
        }
        struct Saved(usize);
        impl Seen for Saved {
            fn save(&mut self, _: &[String]) -> Result<(), Error> {
                self.0 += 1;
                Ok(())
            }
        }
        let fixture = plur1bus_wire_fixtures::load_fixture("channels", "buzz-relay");
        let frame = &fixture["exchanges"][0]["receive"][2];
        let raw = frame.to_string();
        let created = frame[2]["created_at"].as_u64().ok_or(Error::Protocol)?;
        let now = fixture["now"].as_u64().ok_or(Error::Protocol)?;
        let own = keys(1)?;
        let relay_url = Url::parse("wss://fixture.invalid").map_err(|_| Error::Configuration)?;
        let mut receiver = Buzz::new(&own, &[relay_url.as_str()], &[keys(2)?.public_key()], &[])?;
        let mut relay = Relay::new(relay_url);
        let mut saved = Saved(0);
        let verified = VERIFIED_SENDERS.get();
        assert!(matches!(
            receiver.receive(
                &mut relay,
                &raw,
                created + FRESHNESS + 1,
                &mut NoRandom,
                &mut saved
            )?,
            RelayEvent::Ignored
        ));
        assert_eq!(saved.0, 0);
        assert_eq!(VERIFIED_SENDERS.get(), verified);
        assert!(matches!(
            receiver.receive(&mut relay, &raw, now, &mut NoRandom, &mut saved)?,
            RelayEvent::Message(_)
        ));
        assert_eq!(saved.0, 1);
        assert_eq!(VERIFIED_SENDERS.get(), verified + 1);
        Ok(())
    }

    fn keys(seed: u8) -> Result<Keys, Error> {
        SecretKey::from_slice(&[seed; 32])
            .map(Keys::new)
            .map_err(|_| Error::Crypto)
    }

    fn text(author: PublicKey, recipient: PublicKey, now: u64) -> Result<UnsignedEvent, Error> {
        let tag = Tag::parse(["p", &recipient.to_hex()]).map_err(|_| Error::Protocol)?;
        let mut rumor = UnsignedEvent::new(
            author,
            Timestamp::from_secs(now),
            Kind::from(14),
            [tag],
            "Report",
        );
        rumor.id = Some(rumor.compute_id());
        Ok(rumor)
    }

    #[test]
    fn the_rumor_author_matches_the_validated_seal_author() -> Result<(), Error> {
        let author = keys(1)?.public_key();
        let other = keys(2)?.public_key();
        let rumor = text(author, other, 100)?;
        assert_eq!(validate_rumor_sender(&rumor, author), Ok(()));
        assert_eq!(validate_rumor_sender(&rumor, other), Err(Error::Crypto));
        Ok(())
    }

    #[test]
    fn only_a_permitted_peer_passes_rumor_admission() -> Result<(), Error> {
        let own = keys(1)?;
        let permitted = keys(2)?.public_key();
        let other = keys(3)?.public_key();
        let adapter = Buzz::new(&own, &["wss://example.invalid"], &[permitted], &[])?;
        for (author, expected) in [(permitted, true), (other, false)] {
            let rumor = text(author, own.public_key(), 100)?;
            assert_eq!(
                adapter.accepts_rumor(&rumor, rumor.compute_id(), 100),
                expected
            );
        }
        Ok(())
    }

    #[test]
    fn wrapper_age_is_checked_before_opening_it() -> Result<(), Error> {
        struct FixedEntropy;
        impl Entropy for FixedEntropy {
            fn bytes(&mut self) -> Result<[u8; 32], Error> {
                Ok([5; 32])
            }
        }
        let own = keys(1)?;
        let peer = keys(2)?;
        let adapter = Buzz::new(&own, &["wss://example.invalid"], &[peer.public_key()], &[])?;
        let recipient =
            Tag::parse(["p", &own.public_key().to_hex()]).map_err(|_| Error::Protocol)?;
        let event = sign(
            &peer,
            Kind::GiftWrap,
            100,
            [recipient],
            "",
            &mut FixedEntropy,
        )?;
        assert!(adapter.accepts_wrapper(INBOX, &event, 100 + FRESHNESS));
        assert!(!adapter.accepts_wrapper(INBOX, &event, 101 + FRESHNESS));
        Ok(())
    }
}
