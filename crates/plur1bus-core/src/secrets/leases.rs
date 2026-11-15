//! `secrets/leases.ts`: short-lived, revocable, in-memory-only leases on a secret's value (ADR-005 action 6).
//!
//! Expiry is checked against the injected clock on every use; an expired or revoked lease drops its value at once. A lease is
//! never persisted and never logged: its [`Debug`] form and its JSON forms show `"[redacted]"` where the value is, as
//! `toJSON` and `util.inspect` do in TypeScript, while [`Lease::value`] stays readable. The id is `lse_` and 16 bytes of
//! hex from the injected [`RandomSource`] (R6); the clock is read exactly as often as the TypeScript table reads it (a sweep
//! reads it once, `issue` once more for the expiry, `read` only for a lease that exists), so a scripted clock sees the same
//! calls.
use super::error::SecretError;
use crate::identity::codes::RandomSource;
use crate::identity::hex;
use crate::js::json_stringify;
use serde_json::{json, Value};

/// `DEFAULT_LEASE_TTL_MS`.
pub const DEFAULT_LEASE_TTL_MS: i64 = 60_000;
/// `MAX_LEASE_TTL_MS`.
pub const MAX_LEASE_TTL_MS: i64 = 5 * 60_000;

/// ADR-005 action 6: `{ value, expiresAt, purpose, profileId }` plus the id that revokes it.
#[derive(Clone, PartialEq, Eq)]
pub struct Lease {
    /// `lse_` and 32 hex digits.
    pub lease_id: String,
    /// The secret's name.
    pub name: String,
    /// The secret's value: the one field that never appears in a printed or serialized lease.
    pub value: String,
    /// Epoch milliseconds.
    pub expires_at: i64,
    /// What the lease is for.
    pub purpose: String,
    /// The profile that asked.
    pub profile_id: String,
}

impl Lease {
    /// The lease without its value.
    pub fn info(&self) -> LeaseInfo {
        LeaseInfo {
            lease_id: self.lease_id.clone(),
            name: self.name.clone(),
            expires_at: self.expires_at,
            purpose: self.purpose.clone(),
            profile_id: self.profile_id.clone(),
        }
    }

    /// `JSON.stringify(lease)`: the keys in the order `toJSON` gives them (the info keys, then `value`), the value redacted.
    pub fn to_json_string(&self) -> String {
        format!(
            "{{\"leaseId\":{},\"name\":{},\"expiresAt\":{},\"purpose\":{},\"profileId\":{},\"value\":\"[redacted]\"}}",
            json_stringify(&self.lease_id),
            json_stringify(&self.name),
            self.expires_at,
            json_stringify(&self.purpose),
            json_stringify(&self.profile_id),
        )
    }

    /// The same as a JSON value (its object keys are sorted).
    pub fn to_json(&self) -> Value {
        json!({
            "leaseId": self.lease_id, "name": self.name, "expiresAt": self.expires_at,
            "purpose": self.purpose, "profileId": self.profile_id, "value": "[redacted]",
        })
    }
}

impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lease")
            .field("leaseId", &self.lease_id)
            .field("name", &self.name)
            .field("expiresAt", &self.expires_at)
            .field("purpose", &self.purpose)
            .field("profileId", &self.profile_id)
            .field("value", &"[redacted]")
            .finish()
    }
}

/// `LeaseInfo`: a lease without its value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaseInfo {
    /// `lse_` and 32 hex digits.
    pub lease_id: String,
    /// The secret's name.
    pub name: String,
    /// Epoch milliseconds.
    pub expires_at: i64,
    /// What the lease is for.
    pub purpose: String,
    /// The profile that asked.
    pub profile_id: String,
}

/// The options of `issue` (`{ purpose, profileId, ttlMs? }`).
#[derive(Clone, Copy, Debug)]
pub struct IssueOptions<'a> {
    /// What the lease is for.
    pub purpose: &'a str,
    /// The profile that asked.
    pub profile_id: &'a str,
    /// `ttlMs` as a JavaScript number; `None` is `undefined` (or `null`) and means [`DEFAULT_LEASE_TTL_MS`].
    pub ttl_ms: Option<f64>,
}

/// `createLeaseTable(clock)`, with the randomness injected too.
pub struct LeaseTable {
    clock: Box<dyn FnMut() -> i64 + Send>,
    random: Box<dyn RandomSource + Send>,
    /// Insertion order, as the TypeScript `Map` keeps it.
    held: Vec<Lease>,
}

impl LeaseTable {
    /// An empty table over `clock` (epoch milliseconds) and `random`.
    pub fn new(
        clock: Box<dyn FnMut() -> i64 + Send>,
        random: Box<dyn RandomSource + Send>,
    ) -> LeaseTable {
        LeaseTable {
            clock,
            random,
            held: Vec::new(),
        }
    }

    /// Drops every lease that has expired (`expiresAt <= now`); reads the clock once.
    fn sweep(&mut self) {
        let now = (self.clock)();
        self.held.retain(|l| l.expires_at > now);
    }

    /// A new lease on `value`: `invalid-ttl` unless the ttl is an integer in `1..=MAX_LEASE_TTL_MS`.
    pub fn issue(
        &mut self,
        name: &str,
        value: &str,
        options: IssueOptions<'_>,
    ) -> Result<Lease, SecretError> {
        self.sweep();
        let ttl = options.ttl_ms.unwrap_or(DEFAULT_LEASE_TTL_MS as f64);
        // `Number.isInteger(ttl) && ttl >= 1 && ttl <= MAX_LEASE_TTL_MS`; the range makes the cast exact.
        if !(ttl.fract() == 0.0 && (1.0..=MAX_LEASE_TTL_MS as f64).contains(&ttl)) {
            return Err(SecretError::invalid_ttl());
        }
        let mut id = [0u8; 16];
        self.random.fill_bytes(&mut id);
        let lease = Lease {
            lease_id: format!("lse_{}", hex(&id)),
            name: name.to_owned(),
            value: value.to_owned(),
            expires_at: (self.clock)() + ttl as i64,
            purpose: options.purpose.to_owned(),
            profile_id: options.profile_id.to_owned(),
        };
        self.held.push(lease.clone());
        Ok(lease)
    }

    /// The lease while it is live; `lease-invalid` once it expired, was revoked, or never existed (an expired one is dropped).
    pub fn read(&mut self, lease_id: &str) -> Result<Lease, SecretError> {
        let at = self.held.iter().position(|l| l.lease_id == lease_id);
        if let Some(at) = at {
            if self.held[at].expires_at > (self.clock)() {
                return Ok(self.held[at].clone());
            }
            self.held.remove(at);
        }
        Err(SecretError::lease_invalid())
    }

    /// Revokes one lease; false when there was none.
    pub fn revoke(&mut self, lease_id: &str) -> bool {
        match self.held.iter().position(|l| l.lease_id == lease_id) {
            Some(at) => {
                self.held.remove(at);
                true
            }
            None => false,
        }
    }

    /// A rotated or deleted secret invalidates every lease on it; the number revoked.
    pub fn revoke_name(&mut self, name: &str) -> usize {
        let before = self.held.len();
        self.held.retain(|l| l.name != name);
        before - self.held.len()
    }

    /// The live leases, without values, in the order they were issued.
    pub fn active(&mut self) -> Vec<LeaseInfo> {
        self.sweep();
        self.held.iter().map(Lease::info).collect()
    }
}
