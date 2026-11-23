//! A2A 1.0 peer client. Core supplies the trust registry, consent and outbound leases.
mod http;
mod operation;
mod reply;

pub use operation::{Message, Operation, PushRequest};
pub use reply::Stream;

use std::net::SocketAddr;

use sha2::{Digest, Sha256};
use ureq::http::{header, Response};
use url::Url;

use crate::{
    endpoint::Window,
    peer_card::{self, PublicKey, Verified},
};

const MAX_REQUEST: usize = 64 * 1024;
const MAX_REPLY: usize = 64 * 1024;
const MAX_CARD: usize = 128 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    InvalidPeer,
    InvalidRequest,
    Denied,
    Untrusted,
    Revoked,
    Aborted,
    Deadline,
    TooLarge,
    CardSignature,
    RequestFailed,
    Remote(i32),
}

pub struct Peer {
    id: String,
    revision: String,
    card: Url,
    kid: String,
    key: PublicKey,
    credential_slot: Option<String>,
}

fn valid_peer_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

fn valid_slot(slot: &str, id: &str) -> bool {
    if slot.len() > 128 {
        return false;
    }
    let Some((peer, name)) = slot
        .strip_prefix("a2a/")
        .and_then(|slot| slot.split_once('/'))
    else {
        return false;
    };
    peer == id
        && name
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._@-".contains(&b))
}

impl Peer {
    pub fn new(
        id: &str,
        revision: &str,
        card: &str,
        kid: &str,
        key: PublicKey,
        credential_slot: Option<&str>,
    ) -> Result<Self, Error> {
        if !valid_peer_id(id)
            || revision.is_empty()
            || revision.len() > 128
            || revision.bytes().any(|b| b.is_ascii_control())
            || kid.is_empty()
            || kid.encode_utf16().count() > 128
            || kid.bytes().any(|b| b.is_ascii_control())
            || credential_slot.is_some_and(|slot| !valid_slot(slot, id))
        {
            return Err(Error::InvalidPeer);
        }
        Ok(Self {
            id: id.into(),
            revision: revision.into(),
            card: peer_card::peer_url(card).ok_or(Error::InvalidPeer)?,
            kid: kid.into(),
            key,
            credential_slot: credential_slot.map(str::to_owned),
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn revision(&self) -> &str {
        &self.revision
    }
    pub fn fingerprint(&self) -> &str {
        self.key.fingerprint()
    }
    pub fn credential_slot(&self) -> Option<&str> {
        self.credential_slot.as_deref()
    }
}

pub struct Execution<'a> {
    pub person: &'a str,
    pub agent: &'a str,
    pub session: &'a str,
    pub turn: &'a str,
    pub project: &'a str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Purpose {
    Card,
    Operation(&'static str),
}

pub struct Hop<'a> {
    pub peer: &'a Peer,
    pub execution: &'a Execution<'a>,
    pub url: &'a Url,
    pub purpose: Purpose,
    pub body_hash: [u8; 32],
    pub input_bytes: usize,
    pub max_reply_bytes: usize,
}

/// On Drop, release the credential lease. A lease dropped after an attempted write and
/// before settlement accounts for uncertain usage. Before the attempt it releases the reserve.
pub trait Authorization {
    fn pin(&self) -> SocketAddr;
    fn bearer(&self) -> Option<&str>;
    fn mark_attempted(&mut self);
    fn settle(&mut self, response_bytes: usize);
}

pub trait Policy {
    /// Verify the feature switch, owner execution, local agent/turn binding and current peer revision.
    fn current(&self, peer: &Peer, execution: &Execution<'_>) -> bool;
    /// Endpoint of the current explicitly trusted (peer, revision, fingerprint), from the private registry.
    fn trusted_endpoint(&self, peer: &Peer) -> Option<Url>;
    fn local_only(&self, agent: &str) -> bool;
    /// Obtain fresh human confirmation for exactly this endpoint, revision and public key.
    fn confirm_trust(
        &self,
        peer: &Peer,
        card: &Verified,
        execution: &Execution<'_>,
        window: Window<'_>,
    ) -> Result<(), Error>;
    /// Admit this hop through Core consent, budget enforcement, guarded DNS/Egress, and the agent's
    /// local-only policy. Lease only the requested credential slot after admission succeeds.
    fn admit(&self, request: Hop<'_>, window: Window<'_>) -> Result<Box<dyn Authorization>, Error>;
}

#[derive(Clone, Copy)]
pub struct Limits {
    pub card_bytes: usize,
    pub request_bytes: usize,
    pub reply_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            card_bytes: MAX_CARD,
            request_bytes: 16 * 1024,
            reply_bytes: 16 * 1024,
        }
    }
}

pub struct Client<'a> {
    policy: &'a dyn Policy,
    limits: Limits,
}

#[derive(Clone, Copy)]
pub struct Call<'a> {
    pub peer: &'a Peer,
    pub execution: &'a Execution<'a>,
    pub window: Window<'a>,
}

pub enum Output<'a> {
    Json(serde_json::Value),
    Stream(Box<Stream<'a>>),
}

struct Exchange {
    response: Response<ureq::Body>,
    grant: Box<dyn Authorization>,
}

impl<'a> Client<'a> {
    pub fn new(policy: &'a dyn Policy, limits: Limits) -> Result<Self, Error> {
        if limits.card_bytes == 0
            || limits.card_bytes > MAX_CARD
            || limits.request_bytes == 0
            || limits.request_bytes > MAX_REQUEST
            || limits.reply_bytes == 0
            || limits.reply_bytes > MAX_REPLY
        {
            return Err(Error::InvalidRequest);
        }
        Ok(Self { policy, limits })
    }

    fn check(&self, call: &Call<'_>) -> Result<(), Error> {
        http::check(call.window)?;
        if [
            call.execution.person,
            call.execution.agent,
            call.execution.session,
            call.execution.turn,
        ]
        .iter()
        .any(|v| v.is_empty())
        {
            return Err(Error::Denied);
        }
        if !self.policy.current(call.peer, call.execution) {
            return Err(Error::Revoked);
        }
        Ok(())
    }

    fn exchange(
        &self,
        call: &Call<'_>,
        url: &Url,
        request: Option<(&'static str, &str, bool)>,
        cap: usize,
        secrets: &mut reply::Secrets,
    ) -> Result<Exchange, Error> {
        self.check(call)?;
        if url.origin() != call.peer.card.origin() {
            return Err(Error::Denied);
        }
        let (purpose, body, stream) = request
            .map_or((Purpose::Card, None, false), |(op, body, stream)| {
                (Purpose::Operation(op), Some(body.as_bytes()), stream)
            });
        let payload = body.unwrap_or_default();
        let mut grant = self.policy.admit(
            Hop {
                peer: call.peer,
                execution: call.execution,
                url,
                purpose,
                body_hash: Sha256::digest(payload).into(),
                input_bytes: payload.len(),
                max_reply_bytes: cap,
            },
            call.window,
        )?;
        self.check(call)?;
        if self.policy.local_only(call.execution.agent) && !http::local_address(grant.pin().ip()) {
            return Err(Error::Denied);
        }
        let token = grant.bearer().map(str::to_owned);
        if token.is_some() != call.peer.credential_slot.is_some() {
            return Err(Error::Denied);
        }
        if let Some(token) = &token {
            secrets.insert(token)?;
        }
        let response = http::send(
            url,
            body,
            stream,
            call.window,
            grant.as_mut(),
            token.as_deref(),
        )?;
        self.check(call)?;
        Ok(Exchange { response, grant })
    }

    fn card(&self, call: &Call<'_>, secrets: &mut reply::Secrets) -> Result<Verified, Error> {
        let mut url = call.peer.card.clone();
        for hop in 0..=3 {
            let Exchange {
                mut response,
                mut grant,
            } = self.exchange(call, &url, None, self.limits.card_bytes, secrets)?;
            if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) && hop < 3 {
                let location = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or(Error::RequestFailed)?;
                let next = url.join(location).map_err(|_| Error::Denied)?;
                url = peer_card::peer_url(next.as_str())
                    .filter(|u| u.origin() == call.peer.card.origin())
                    .ok_or(Error::Denied)?;
                grant.settle(0);
                continue;
            }
            http::check_media(&response, false, self.limits.card_bytes)?;
            let body = http::read_json(
                response.body_mut(),
                self.limits.card_bytes,
                call.window,
                || self.policy.current(call.peer, call.execution),
            )?;
            grant.settle(body.len());
            return peer_card::verify(
                &body,
                &call.peer.key,
                &call.peer.kid,
                call.peer.card.as_str(),
            )
            .map_err(|_| Error::CardSignature);
        }
        Err(Error::RequestFailed)
    }

    pub fn confirm(&self, call: Call<'_>) -> Result<Verified, Error> {
        let mut secrets = reply::Secrets::default();
        let verified = self.card(&call, &mut secrets)?;
        if secrets.contains(verified.endpoint.as_str())
            || secrets.contains(&verified.fingerprint)
            || secrets.contains(call.peer.revision())
            || secrets.contains(call.peer.id())
        {
            return Err(Error::Denied);
        }
        self.check(&call)?;
        self.policy
            .confirm_trust(call.peer, &verified, call.execution, call.window)?;
        self.check(&call)?;
        Ok(verified)
    }

    pub fn perform(
        &'a self,
        call: Call<'a>,
        operation: Operation<'_>,
        id: &str,
    ) -> Result<Output<'a>, Error> {
        self.check(&call)?;
        let endpoint = self
            .policy
            .trusted_endpoint(call.peer)
            .ok_or(Error::Untrusted)?;
        let body = operation.body(id)?;
        if body.len() > self.limits.request_bytes {
            return Err(Error::TooLarge);
        }
        let mut secrets = reply::Secrets::default();
        let card = self.card(&call, &mut secrets)?;
        if card.endpoint != endpoint
            || self.policy.trusted_endpoint(call.peer).as_ref() != Some(&endpoint)
        {
            return Err(Error::Untrusted);
        }
        let Exchange {
            mut response,
            mut grant,
        } = self.exchange(
            &call,
            &endpoint,
            Some((operation.method(), &body, operation.streams())),
            self.limits.reply_bytes,
            &mut secrets,
        )?;
        http::check_media(&response, operation.streams(), self.limits.reply_bytes)?;
        if operation.streams() {
            return Ok(Output::Stream(Box::new(Stream::new(
                reply::Wire {
                    body: response.into_body(),
                    grant,
                },
                self.policy,
                call,
                operation,
                id,
                secrets,
                self.limits.reply_bytes,
            ))));
        }
        let raw = http::read_json(
            response.body_mut(),
            self.limits.reply_bytes,
            call.window,
            || self.policy.current(call.peer, call.execution),
        )?;
        grant.settle(raw.len());
        let result = reply::rpc_result(&raw, id)?;
        let mut result = reply::operation_result(result, operation)?;
        let mut remaining = self.limits.reply_bytes;
        secrets.redact(&mut result, &mut remaining)?;
        self.check(&call)?;
        Ok(Output::Json(result))
    }
}
