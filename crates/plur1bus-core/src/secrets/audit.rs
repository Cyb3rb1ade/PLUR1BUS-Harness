//! The pure parts of `secrets/audit.ts`: the action names, `sanitizeDetail` and how the actor's `user` string is derived from
//! a principal. The sinks (`createFileAuditSink`, `createMemoryAuditSink`) come with the store.
//!
//! `sanitizeDetail` keeps only eight keys and only primitives, so the audit detail cannot carry a value even by mistake; a
//! string is cut at 128 code units, which can split a surrogate pair, so a detail string is code units ([`DetailValue::Str`]).
use super::types::SecretPrincipal;
use crate::js::utf16;
use serde_json::{Map, Number, Value};

/// `AuditAction`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuditAction {
    /// `secret.describe`
    Describe,
    /// `secret.set`
    Set,
    /// `secret.get`
    Get,
    /// `secret.reveal`
    Reveal,
    /// `secret.delete`
    Delete,
    /// `secret.list`
    List,
    /// `secret.lease`
    Lease,
    /// `secret.lease.read`
    LeaseRead,
    /// `secret.lease.revoke`
    LeaseRevoke,
    /// `secret.denied`
    Denied,
}

impl AuditAction {
    /// Every action, in the order of the TypeScript union.
    pub const ALL: [AuditAction; 10] = [
        AuditAction::Describe,
        AuditAction::Set,
        AuditAction::Get,
        AuditAction::Reveal,
        AuditAction::Delete,
        AuditAction::List,
        AuditAction::Lease,
        AuditAction::LeaseRead,
        AuditAction::LeaseRevoke,
        AuditAction::Denied,
    ];

    /// The wire name written to the audit log.
    pub fn as_str(self) -> &'static str {
        match self {
            AuditAction::Describe => "secret.describe",
            AuditAction::Set => "secret.set",
            AuditAction::Get => "secret.get",
            AuditAction::Reveal => "secret.reveal",
            AuditAction::Delete => "secret.delete",
            AuditAction::List => "secret.list",
            AuditAction::Lease => "secret.lease",
            AuditAction::LeaseRead => "secret.lease.read",
            AuditAction::LeaseRevoke => "secret.lease.revoke",
            AuditAction::Denied => "secret.denied",
        }
    }

    /// The action a wire name stands for.
    pub fn from_wire(name: &str) -> Option<AuditAction> {
        AuditAction::ALL.into_iter().find(|a| a.as_str() == name)
    }
}

/// `DETAIL_KEYS`: the only keys an audit detail keeps, in the order `sanitizeDetail` reads them.
pub const DETAIL_KEYS: [&str; 8] = [
    "backend",
    "purpose",
    "profileId",
    "leaseId",
    "ttlMs",
    "reason",
    "count",
    "method",
];

/// The longest a detail string or an actor id stays (UTF-16 code units).
pub const DETAIL_STRING_MAX_UNITS: usize = 128;

/// A value of an audit detail as the caller supplied it.
#[derive(Clone, Debug, PartialEq)]
pub enum DetailValue {
    /// A string, as UTF-16 code units (a cut at 128 can leave half of a pair).
    Str(Vec<u16>),
    /// A number (JSON cannot hold `NaN` or an infinity, so neither can this).
    Num(Number),
    /// A boolean.
    Bool(bool),
    /// Anything else (`null`, an array, an object, `undefined`): dropped.
    Other,
}

/// `sanitizeDetail(d)`: for each of [`DETAIL_KEYS`] in order, a string (cut at 128 code units), number or boolean the caller
/// gave under that key; everything else, and every other key, is dropped. `None` is `undefined`; the first of two equal keys
/// wins (a JavaScript object has no duplicates).
pub fn sanitize_detail(
    detail: Option<&[(String, DetailValue)]>,
) -> Vec<(&'static str, DetailValue)> {
    let mut out = Vec::new();
    for key in DETAIL_KEYS {
        let given = detail.and_then(|d| d.iter().find(|(k, _)| k == key).map(|(_, v)| v));
        match given {
            Some(DetailValue::Str(units)) => out.push((
                key,
                DetailValue::Str(units[..units.len().min(DETAIL_STRING_MAX_UNITS)].to_vec()),
            )),
            Some(v @ (DetailValue::Num(_) | DetailValue::Bool(_))) => out.push((key, v.clone())),
            _ => {}
        }
    }
    out
}

/// A sanitized detail as a JSON object (a string with half of a pair becomes U+FFFD, as `Buffer` would write it).
pub fn detail_to_json(detail: &[(&'static str, DetailValue)]) -> Value {
    let mut out = Map::new();
    for (key, value) in detail {
        let json = match value {
            DetailValue::Str(units) => Value::String(String::from_utf16_lossy(units)),
            DetailValue::Num(n) => Value::Number(n.clone()),
            DetailValue::Bool(b) => Value::Bool(*b),
            DetailValue::Other => continue,
        };
        out.insert((*key).to_owned(), json);
    }
    Value::Object(out)
}

/// `idOf(v)`: a non-empty string capped at 128 code units, else nothing.
fn id_of(id: Option<&str>) -> Option<Vec<u16>> {
    let units = utf16(id?);
    (!units.is_empty()).then(|| units[..units.len().min(DETAIL_STRING_MAX_UNITS)].to_vec())
}

/// The `user` of the audit record's actor, as code units: an owner is its capped id (else the OS user name `os_user`, which
/// `userInfo().username` supplies in TypeScript), an agent is `agent:` and its capped id (else `unknown`), the core is
/// `core`. Caller-supplied ids are capped at 128 code units.
pub fn actor_user_units(principal: &SecretPrincipal, os_user: &[u16]) -> Vec<u16> {
    match principal {
        SecretPrincipal::Owner { id, .. } => {
            id_of(id.as_deref()).unwrap_or_else(|| os_user.to_vec())
        }
        SecretPrincipal::Agent { agent_id } => {
            let mut user = utf16("agent:");
            user.extend(id_of(agent_id.as_deref()).unwrap_or_else(|| utf16("unknown")));
            user
        }
        SecretPrincipal::Core => utf16("core"),
    }
}

/// [`actor_user_units`] as a string (half of a cut pair becomes U+FFFD).
pub fn actor_user(principal: &SecretPrincipal, os_user: &str) -> String {
    String::from_utf16_lossy(&actor_user_units(principal, &utf16(os_user)))
}
