//! The role record, its validation and the pure transition function [`apply`].
//!
//! Nothing here reads a clock, touches the disk or draws randomness: `apply` gets `now_ms` and `actor` from the caller
//! and the events carry facts that were verified elsewhere (signatures, bundles and receipts are not this module's
//! concern). Automatic transitions (`Observed`) only ever remove writers.
use serde::{Deserialize, Serialize};
use std::fmt;

/// The `schema` value of every role record.
pub(crate) const ROLE_SCHEMA: &str = "plur1bus.role/1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Role {
    Standalone,
    Primary,
    Client,
    HandingOver,
    Pending,
    Fenced,
}

impl Role {
    /// Only a standalone node and a primary may run channels, schedulers and memory writes.
    pub(crate) fn writers_allowed(self) -> bool {
        matches!(self, Role::Standalone | Role::Primary)
    }

    /// The wire value (the serde representation).
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Role::Standalone => "standalone",
            Role::Primary => "primary",
            Role::Client => "client",
            Role::HandingOver => "handing-over",
            Role::Pending => "pending",
            Role::Fenced => "fenced",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ReachKind {
    Ssh,
    Tailnet,
    Network,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum HandoverSide {
    Source,
    Target,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Reach {
    pub(crate) kind: ReachKind,
    #[serde(rename = "ref")]
    pub(crate) reference: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NodeRef {
    pub(crate) node_id: String,
    pub(crate) node_key_fingerprint: String,
    pub(crate) display_name: String,
    pub(crate) reach: Reach,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Handover {
    pub(crate) id: String,
    pub(crate) side: HandoverSide,
    pub(crate) peer_node_id: String,
    pub(crate) peer_key_fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) bundle_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) expected_epoch: Option<u64>,
    pub(crate) started_at_ms: u64,
    pub(crate) lease_expires_at_ms: u64,
    pub(crate) previous_role: Role,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) previous_cluster_id: Option<String>,
    pub(crate) previous_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Frozen {
    pub(crate) epoch: u64,
    pub(crate) bundle_sha256: String,
    pub(crate) frozen_at_ms: u64,
    pub(crate) rollback_until_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RoleRecord {
    pub(crate) schema: String,
    pub(crate) role: Role,
    pub(crate) epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cluster_id: Option<String>,
    pub(crate) node_id: String,
    pub(crate) node_key_fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) primary: Option<NodeRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) handover: Option<Handover>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) frozen: Option<Frozen>,
    pub(crate) highest_seen_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_primary_contact_at_ms: Option<u64>,
    pub(crate) changed_at_ms: u64,
    pub(crate) changed_by: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RoleError {
    InvalidTransition { from: Role, event: &'static str },
    InvalidInput { field: &'static str },
    StaleEpoch { got: u64, highest: u64 },
    ForeignCluster,
    TargetNotEmpty,
    LeaseExpired,
    EpochExhausted,
    ReceiptInvalid { field: &'static str },
    CommitInvalid { field: &'static str },
    TakeoverTooEarly { remaining_ms: u64 },
    Unconfirmed,
    RollbackExpired,
    RecordCorrupt { detail: String },
    Io { detail: String },
}

impl RoleError {
    /// The stable machine-readable reason.
    pub(crate) fn reason(&self) -> &'static str {
        match self {
            RoleError::InvalidTransition { .. } => "role-invalid-transition",
            RoleError::InvalidInput { .. } => "role-invalid-input",
            RoleError::StaleEpoch { .. } => "role-stale-epoch",
            RoleError::ForeignCluster => "role-bundle-foreign-cluster",
            RoleError::TargetNotEmpty => "role-target-not-empty",
            RoleError::LeaseExpired => "role-lease-expired",
            RoleError::EpochExhausted => "role-epoch-exhausted",
            RoleError::ReceiptInvalid { .. } => "role-receipt-invalid",
            RoleError::CommitInvalid { .. } => "role-commit-invalid",
            RoleError::TakeoverTooEarly { .. } => "role-takeover-too-early",
            RoleError::Unconfirmed => "role-unconfirmed",
            RoleError::RollbackExpired => "role-rollback-expired",
            RoleError::RecordCorrupt { .. } => "role-record-corrupt",
            RoleError::Io { .. } => "io",
        }
    }

    /// The RPC error code the reason maps to.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            RoleError::InvalidTransition { .. }
            | RoleError::TargetNotEmpty
            | RoleError::RollbackExpired
            | RoleError::EpochExhausted => "E_CONFLICT",
            RoleError::InvalidInput { .. }
            | RoleError::StaleEpoch { .. }
            | RoleError::ForeignCluster
            | RoleError::ReceiptInvalid { .. }
            | RoleError::CommitInvalid { .. } => "E_INVALID_PARAMS",
            RoleError::LeaseExpired => "E_NOT_AVAILABLE",
            RoleError::TakeoverTooEarly { .. } | RoleError::Unconfirmed => "E_DENIED",
            RoleError::RecordCorrupt { .. } | RoleError::Io { .. } => "E_STORAGE",
        }
    }
}

impl fmt::Display for RoleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = self.reason();
        match self {
            RoleError::InvalidTransition { from, event } => {
                write!(
                    f,
                    "{reason}: `{event}` is not allowed while {}",
                    from.as_str()
                )
            }
            RoleError::InvalidInput { field } => write!(f, "{reason}: invalid `{field}`"),
            RoleError::StaleEpoch { got, highest } => {
                write!(f, "{reason}: epoch {got} is behind {highest}")
            }
            RoleError::ForeignCluster => {
                write!(f, "{reason}: the value belongs to another cluster")
            }
            RoleError::TargetNotEmpty => {
                write!(f, "{reason}: this node already holds data of its own")
            }
            RoleError::LeaseExpired => write!(f, "{reason}: the handover lease has expired"),
            RoleError::ReceiptInvalid { field } => {
                write!(f, "{reason}: the receipt does not match (`{field}`)")
            }
            RoleError::CommitInvalid { field } => {
                write!(f, "{reason}: the commit token does not match (`{field}`)")
            }
            RoleError::EpochExhausted => write!(f, "{reason}"),
            RoleError::TakeoverTooEarly { remaining_ms } => {
                write!(f, "{reason}: wait another {remaining_ms} ms")
            }
            RoleError::Unconfirmed => write!(f, "{reason}: explicit confirmation is required"),
            RoleError::RollbackExpired => write!(f, "{reason}: the rollback window has closed"),
            RoleError::RecordCorrupt { detail } | RoleError::Io { detail } => {
                write!(f, "{reason}: {detail}")
            }
        }
    }
}

impl std::error::Error for RoleError {}

pub(crate) use super::events::Event;
use super::validation::*;

// ----
// Transitions
// ----

/// Milliseconds a client still has to wait before a forced takeover is allowed (0: allowed now). The reference point
/// is the last primary contact, or the time of the last change when there was none.
pub(crate) fn takeover_remaining_ms(rec: &RoleRecord, now_ms: u64, min_unreachable_ms: u64) -> u64 {
    let since = rec.last_primary_contact_at_ms.unwrap_or(rec.changed_at_ms);
    since
        .saturating_add(min_unreachable_ms)
        .saturating_sub(now_ms)
}

pub(super) fn need(rec: &RoleRecord, event: &'static str, roles: &[Role]) -> Result<(), RoleError> {
    if roles.contains(&rec.role) {
        Ok(())
    } else {
        Err(RoleError::InvalidTransition {
            from: rec.role,
            event,
        })
    }
}

pub(super) fn handover_of(rec: &RoleRecord) -> Result<&Handover, RoleError> {
    rec.handover
        .as_ref()
        .ok_or(RoleError::InvalidInput { field: "handover" })
}

pub(super) fn cluster_of(rec: &RoleRecord) -> Result<String, RoleError> {
    rec.cluster_id
        .clone()
        .ok_or(RoleError::InvalidInput { field: "clusterId" })
}

pub(super) fn check_ref(n: &NodeRef, field: &'static str) -> Result<(), RoleError> {
    ensure(node_ref_problem(n).is_none(), field)
}

/// Back to the role held before a handover began (`Abort`, `Discard`, `Observed` on a pending node).
pub(super) fn restore_previous(out: &mut RoleRecord, ho: &Handover) {
    out.role = ho.previous_role;
    out.epoch = ho.previous_epoch;
    out.cluster_id = ho.previous_cluster_id.clone();
    out.handover = None;
    if out.role == Role::Standalone {
        out.highest_seen_epoch = 0;
        out.primary = None;
        out.frozen = None;
        out.last_primary_contact_at_ms = None;
    }
}

/// The standalone shape of a record: node identity kept, everything about a cluster gone.
pub(super) fn become_standalone(out: &mut RoleRecord) {
    out.role = Role::Standalone;
    out.cluster_id = None;
    out.epoch = 0;
    out.highest_seen_epoch = 0;
    out.primary = None;
    out.handover = None;
    out.frozen = None;
    out.last_primary_contact_at_ms = None;
}

/// Applies one event to a record. Pure: the caller supplies the time and the actor. The result always validates; when
/// the event changes nothing the result equals the input (including `changed_at_ms` and `changed_by`), so callers can
/// skip the write.
pub(crate) fn apply(
    rec: &RoleRecord,
    ev: Event,
    now_ms: u64,
    actor: &str,
) -> Result<RoleRecord, RoleError> {
    rec.validate()?;
    let mut out = rec.clone();
    step(rec, &mut out, ev, now_ms)?;
    if out == *rec {
        return Ok(out);
    }
    out.changed_at_ms = now_ms;
    out.changed_by = actor.to_string();
    out.validate()?;
    Ok(out)
}

fn step(rec: &RoleRecord, out: &mut RoleRecord, ev: Event, now: u64) -> Result<(), RoleError> {
    match &ev {
        Event::Prepare { .. }
        | Event::BundleReady { .. }
        | Event::RenewLease { .. }
        | Event::Abort
        | Event::Commit { .. } => super::source::step(rec, out, ev, now),
        Event::Accept { .. } | Event::Activate { .. } | Event::Discard => {
            super::target::step(rec, out, ev, now)
        }
        Event::ForceTakeover { .. }
        | Event::RestoreFrozen { .. }
        | Event::ResolveAsClient { .. }
        | Event::Join { .. }
        | Event::Leave { .. } => super::membership::step(rec, out, ev, now),
        Event::Observed { .. } => super::observation::step(rec, out, ev, now),
    }
}
