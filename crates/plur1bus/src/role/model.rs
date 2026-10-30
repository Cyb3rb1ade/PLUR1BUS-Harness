//! The role record, its validation and the pure transition function [`apply`].
//!
//! Nothing here reads a clock, touches the disk or draws randomness: `apply` gets `now_ms` and `actor` from the caller
//! and the events carry facts that were verified elsewhere (signatures, bundles and receipts are not this module's
//! concern). Automatic transitions (`Observed`) only ever remove writers.
use serde::{Deserialize, Serialize};
use std::fmt;

/// The `schema` value of every role record.
pub const ROLE_SCHEMA: &str = "plur1bus.role/1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    Standalone,
    Primary,
    Client,
    HandingOver,
    Pending,
    Fenced,
}

impl Role {
    /// Only a standalone node and a primary may run channels, schedulers and memory writes.
    pub fn writers_allowed(self) -> bool {
        matches!(self, Role::Standalone | Role::Primary)
    }

    /// The wire value (the serde representation).
    pub fn as_str(self) -> &'static str {
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
pub enum ReachKind {
    Ssh,
    Tailnet,
    Network,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HandoverSide {
    Source,
    Target,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reach {
    pub kind: ReachKind,
    #[serde(rename = "ref")]
    pub reference: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRef {
    pub node_id: String,
    pub node_key_fingerprint: String,
    pub display_name: String,
    pub reach: Reach,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Handover {
    pub id: String,
    pub side: HandoverSide,
    pub peer_node_id: String,
    pub peer_key_fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_epoch: Option<u64>,
    pub started_at_ms: u64,
    pub lease_expires_at_ms: u64,
    pub previous_role: Role,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_cluster_id: Option<String>,
    pub previous_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Frozen {
    pub epoch: u64,
    pub bundle_sha256: String,
    pub frozen_at_ms: u64,
    pub rollback_until_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleRecord {
    pub schema: String,
    pub role: Role,
    pub epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cluster_id: Option<String>,
    pub node_id: String,
    pub node_key_fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary: Option<NodeRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handover: Option<Handover>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frozen: Option<Frozen>,
    pub highest_seen_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_primary_contact_at_ms: Option<u64>,
    pub changed_at_ms: u64,
    pub changed_by: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoleError {
    InvalidTransition { from: Role, event: &'static str },
    InvalidInput { field: &'static str },
    StaleEpoch { got: u64, highest: u64 },
    ForeignCluster,
    TargetNotEmpty,
    LeaseExpired,
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
    pub fn reason(&self) -> &'static str {
        match self {
            RoleError::InvalidTransition { .. } => "role-invalid-transition",
            RoleError::InvalidInput { .. } => "role-invalid-input",
            RoleError::StaleEpoch { .. } => "role-stale-epoch",
            RoleError::ForeignCluster => "role-bundle-foreign-cluster",
            RoleError::TargetNotEmpty => "role-target-not-empty",
            RoleError::LeaseExpired => "role-lease-expired",
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
    pub fn code(&self) -> &'static str {
        match self {
            RoleError::InvalidTransition { .. }
            | RoleError::TargetNotEmpty
            | RoleError::RollbackExpired => "E_CONFLICT",
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

// ----
// Validation
// ----

fn is_uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|u| u.to_string() == s)
}

fn is_fingerprint(s: &str) -> bool {
    s.strip_prefix("sha256:").is_some_and(|rest| {
        rest.len() == 43
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    })
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn text_ok(s: &str, max_chars: usize) -> bool {
    let n = s.chars().count();
    (1..=max_chars).contains(&n) && !s.chars().any(char::is_control)
}

fn ensure(ok: bool, field: &'static str) -> Result<(), RoleError> {
    if ok {
        Ok(())
    } else {
        Err(RoleError::InvalidInput { field })
    }
}

/// The first invalid part of a node reference, as a camelCase path below the reference.
fn node_ref_problem(n: &NodeRef) -> Option<&'static str> {
    if !is_uuid(&n.node_id) {
        Some("nodeId")
    } else if !is_fingerprint(&n.node_key_fingerprint) {
        Some("nodeKeyFingerprint")
    } else if !text_ok(&n.display_name, 128) {
        Some("displayName")
    } else if !text_ok(&n.reach.reference, 256) {
        Some("reach.ref")
    } else {
        None
    }
}

fn validate_primary(n: &NodeRef) -> Result<(), RoleError> {
    let field = match node_ref_problem(n) {
        None => return Ok(()),
        Some("nodeId") => "primary.nodeId",
        Some("nodeKeyFingerprint") => "primary.nodeKeyFingerprint",
        Some("displayName") => "primary.displayName",
        Some(_) => "primary.reach.ref",
    };
    Err(RoleError::InvalidInput { field })
}

impl RoleRecord {
    /// A valid standalone record: epoch 0, no cluster, every option unset.
    pub fn standalone(
        node_id: &str,
        node_key_fingerprint: &str,
        now_ms: u64,
        actor: &str,
    ) -> RoleRecord {
        RoleRecord {
            schema: ROLE_SCHEMA.to_string(),
            role: Role::Standalone,
            epoch: 0,
            cluster_id: None,
            node_id: node_id.to_string(),
            node_key_fingerprint: node_key_fingerprint.to_string(),
            primary: None,
            handover: None,
            frozen: None,
            highest_seen_epoch: 0,
            last_primary_contact_at_ms: None,
            changed_at_ms: now_ms,
            changed_by: actor.to_string(),
        }
    }

    /// Every rule of the record format. A failure names the offending field in camelCase.
    pub fn validate(&self) -> Result<(), RoleError> {
        ensure(self.schema == ROLE_SCHEMA, "schema")?;
        ensure(is_uuid(&self.node_id), "nodeId")?;
        ensure(
            is_fingerprint(&self.node_key_fingerprint),
            "nodeKeyFingerprint",
        )?;
        if let Some(c) = &self.cluster_id {
            ensure(is_uuid(c), "clusterId")?;
        }
        ensure(text_ok(&self.changed_by, 128), "changedBy")?;
        if let Some(p) = &self.primary {
            validate_primary(p)?;
            ensure(p.node_id != self.node_id, "primary.nodeId")?;
        }
        if let Some(h) = &self.handover {
            ensure(is_uuid(&h.id), "handover.id")?;
            ensure(is_uuid(&h.peer_node_id), "handover.peerNodeId")?;
            ensure(
                is_fingerprint(&h.peer_key_fingerprint),
                "handover.peerKeyFingerprint",
            )?;
            if let Some(b) = &h.bundle_sha256 {
                ensure(is_sha256(b), "handover.bundleSha256")?;
            }
            ensure(h.peer_node_id != self.node_id, "handover.peerNodeId")?;
        }
        if let Some(f) = &self.frozen {
            ensure(is_sha256(&f.bundle_sha256), "frozen.bundleSha256")?;
            ensure(
                f.rollback_until_ms >= f.frozen_at_ms,
                "frozen.rollbackUntilMs",
            )?;
        }
        ensure(self.highest_seen_epoch >= self.epoch, "highestSeenEpoch")?;
        self.validate_role()
    }

    fn validate_role(&self) -> Result<(), RoleError> {
        let clustered = |want: bool| ensure(self.cluster_id.is_some() == want, "clusterId");
        let no_primary = || ensure(self.primary.is_none(), "primary");
        let no_handover = || ensure(self.handover.is_none(), "handover");
        let no_frozen = || ensure(self.frozen.is_none(), "frozen");
        let min_epoch = |min: u64| ensure(self.epoch >= min, "epoch");
        match self.role {
            Role::Standalone => {
                clustered(false)?;
                ensure(self.epoch == 0, "epoch")?;
                no_primary()?;
                no_handover()?;
                no_frozen()?;
                ensure(self.highest_seen_epoch == 0, "highestSeenEpoch")?;
                ensure(
                    self.last_primary_contact_at_ms.is_none(),
                    "lastPrimaryContactAtMs",
                )
            }
            Role::Primary => {
                clustered(true)?;
                min_epoch(1)?;
                no_primary()?;
                no_handover()?;
                no_frozen()
            }
            Role::Client => {
                clustered(true)?;
                min_epoch(1)?;
                ensure(self.primary.is_some(), "primary")?;
                no_handover()
            }
            Role::HandingOver => {
                clustered(true)?;
                min_epoch(1)?;
                no_primary()?;
                let h = self
                    .handover
                    .as_ref()
                    .ok_or(RoleError::InvalidInput { field: "handover" })?;
                ensure(h.side == HandoverSide::Source, "handover.side")?;
                no_frozen()
            }
            Role::Pending => {
                clustered(true)?;
                let h = self
                    .handover
                    .as_ref()
                    .ok_or(RoleError::InvalidInput { field: "handover" })?;
                ensure(h.side == HandoverSide::Target, "handover.side")?;
                ensure(h.bundle_sha256.is_some(), "handover.bundleSha256")?;
                ensure(h.expected_epoch.is_some(), "handover.expectedEpoch")
            }
            Role::Fenced => {
                clustered(true)?;
                min_epoch(1)?;
                no_handover()?;
                no_frozen()
            }
        }
    }
}

// ----
// Events
// ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Prepare {
        handover_id: String,
        target_node_id: String,
        target_key_fingerprint: String,
        new_cluster_id: Option<String>,
        lease_ttl_ms: u64,
    },
    BundleReady {
        bundle_sha256: String,
    },
    RenewLease {
        lease_ttl_ms: u64,
    },
    Abort,
    Commit {
        receipt_handover_id: String,
        receipt_bundle_sha256: String,
        receipt_target_node_id: String,
        primary: NodeRef,
        rollback_window_ms: u64,
    },
    Accept {
        handover_id: String,
        cluster_id: String,
        bundle_epoch: u64,
        bundle_sha256: String,
        source_node_id: String,
        source_key_fingerprint: String,
        target_is_fresh: bool,
        replace: bool,
        lease_ttl_ms: u64,
    },
    Activate {
        token_handover_id: String,
        token_cluster_id: String,
        token_epoch: u64,
        token_bundle_sha256: String,
        token_target_node_id: String,
    },
    Discard,
    ForceTakeover {
        min_unreachable_ms: u64,
        confirmed: bool,
    },
    RestoreFrozen {
        confirmed: bool,
        server_demoted_epoch: u64,
    },
    Observed {
        cluster_id: String,
        epoch: u64,
        primary: Option<NodeRef>,
    },
    ResolveAsClient {
        epoch: u64,
        primary: NodeRef,
    },
    Join {
        cluster_id: String,
        epoch: u64,
        primary: NodeRef,
        node_is_fresh: bool,
    },
    Leave {
        confirmed: bool,
    },
}

impl Event {
    pub fn name(&self) -> &'static str {
        match self {
            Event::Prepare { .. } => "prepare",
            Event::BundleReady { .. } => "bundle-ready",
            Event::RenewLease { .. } => "renew-lease",
            Event::Abort => "abort",
            Event::Commit { .. } => "commit",
            Event::Accept { .. } => "accept",
            Event::Activate { .. } => "activate",
            Event::Discard => "discard",
            Event::ForceTakeover { .. } => "force-takeover",
            Event::RestoreFrozen { .. } => "restore-frozen",
            Event::Observed { .. } => "observed",
            Event::ResolveAsClient { .. } => "resolve-as-client",
            Event::Join { .. } => "join",
            Event::Leave { .. } => "leave",
        }
    }
}

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

fn need(rec: &RoleRecord, event: &'static str, roles: &[Role]) -> Result<(), RoleError> {
    if roles.contains(&rec.role) {
        Ok(())
    } else {
        Err(RoleError::InvalidTransition {
            from: rec.role,
            event,
        })
    }
}

fn handover_of(rec: &RoleRecord) -> Result<&Handover, RoleError> {
    rec.handover
        .as_ref()
        .ok_or(RoleError::InvalidInput { field: "handover" })
}

fn cluster_of(rec: &RoleRecord) -> Result<String, RoleError> {
    rec.cluster_id
        .clone()
        .ok_or(RoleError::InvalidInput { field: "clusterId" })
}

fn check_ref(n: &NodeRef, field: &'static str) -> Result<(), RoleError> {
    ensure(node_ref_problem(n).is_none(), field)
}

/// Back to the role held before a handover began (`Abort`, `Discard`, `Observed` on a pending node).
fn restore_previous(out: &mut RoleRecord, ho: &Handover) {
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
fn become_standalone(out: &mut RoleRecord) {
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
pub fn apply(
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
    use Role::*;
    let name = ev.name();
    let n = rec.epoch;
    let h = rec.highest_seen_epoch;
    match ev {
        Event::Prepare {
            handover_id,
            target_node_id,
            target_key_fingerprint,
            new_cluster_id,
            lease_ttl_ms,
        } => {
            need(rec, name, &[Standalone, Primary])?;
            ensure(is_uuid(&handover_id), "handoverId")?;
            ensure(is_uuid(&target_node_id), "targetNodeId")?;
            ensure(
                is_fingerprint(&target_key_fingerprint),
                "targetKeyFingerprint",
            )?;
            if let Some(c) = &new_cluster_id {
                ensure(is_uuid(c), "newClusterId")?;
            }
            let (cluster, epoch) = if rec.role == Standalone {
                (
                    new_cluster_id.ok_or(RoleError::InvalidInput {
                        field: "newClusterId",
                    })?,
                    1,
                )
            } else {
                ensure(new_cluster_id.is_none(), "newClusterId")?;
                (cluster_of(rec)?, n)
            };
            ensure(target_node_id != rec.node_id, "targetNodeId")?;
            out.role = HandingOver;
            out.cluster_id = Some(cluster.clone());
            out.epoch = epoch;
            out.highest_seen_epoch = h.max(epoch);
            out.handover = Some(Handover {
                id: handover_id,
                side: HandoverSide::Source,
                peer_node_id: target_node_id,
                peer_key_fingerprint: target_key_fingerprint,
                bundle_sha256: None,
                expected_epoch: None,
                started_at_ms: now,
                lease_expires_at_ms: now.saturating_add(lease_ttl_ms),
                previous_role: Primary,
                previous_cluster_id: Some(cluster),
                previous_epoch: epoch,
            });
        }
        Event::BundleReady { bundle_sha256 } => {
            need(rec, name, &[HandingOver])?;
            ensure(is_sha256(&bundle_sha256), "bundleSha256")?;
            if handover_of(rec)?.bundle_sha256.is_some() {
                return Err(RoleError::InvalidTransition {
                    from: rec.role,
                    event: name,
                });
            }
            if let Some(ho) = out.handover.as_mut() {
                ho.bundle_sha256 = Some(bundle_sha256);
            }
        }
        Event::RenewLease { lease_ttl_ms } => {
            need(rec, name, &[HandingOver, Pending])?;
            if now > handover_of(rec)?.lease_expires_at_ms {
                return Err(RoleError::LeaseExpired);
            }
            if let Some(ho) = out.handover.as_mut() {
                ho.lease_expires_at_ms = now.saturating_add(lease_ttl_ms);
            }
        }
        Event::Abort => {
            need(rec, name, &[HandingOver])?;
            restore_previous(out, handover_of(rec)?);
        }
        Event::Commit {
            receipt_handover_id,
            receipt_bundle_sha256,
            receipt_target_node_id,
            primary,
            rollback_window_ms,
        } => {
            need(rec, name, &[HandingOver])?;
            let ho = handover_of(rec)?;
            if now > ho.lease_expires_at_ms {
                return Err(RoleError::LeaseExpired);
            }
            let bundle = ho.bundle_sha256.clone().ok_or(RoleError::ReceiptInvalid {
                field: "bundleSha256",
            })?;
            let receipt = |ok: bool, field: &'static str| {
                if ok {
                    Ok(())
                } else {
                    Err(RoleError::ReceiptInvalid { field })
                }
            };
            receipt(receipt_handover_id == ho.id, "handoverId")?;
            receipt(receipt_bundle_sha256 == bundle, "bundleSha256")?;
            receipt(receipt_target_node_id == ho.peer_node_id, "targetNodeId")?;
            receipt(
                primary.node_id == ho.peer_node_id
                    && primary.node_key_fingerprint == ho.peer_key_fingerprint,
                "primary",
            )?;
            check_ref(&primary, "primary")?;
            let epoch = n.saturating_add(1);
            out.role = Client;
            out.epoch = epoch;
            out.highest_seen_epoch = h.max(epoch);
            out.primary = Some(primary);
            out.frozen = Some(Frozen {
                epoch: n,
                bundle_sha256: bundle,
                frozen_at_ms: now,
                rollback_until_ms: now.saturating_add(rollback_window_ms),
            });
            out.handover = None;
            out.last_primary_contact_at_ms = Some(now);
        }
        Event::Accept {
            handover_id,
            cluster_id,
            bundle_epoch,
            bundle_sha256,
            source_node_id,
            source_key_fingerprint,
            target_is_fresh,
            replace,
            lease_ttl_ms,
        } => {
            need(rec, name, &[Standalone, Client])?;
            ensure(is_uuid(&handover_id), "handoverId")?;
            ensure(is_uuid(&cluster_id), "clusterId")?;
            ensure(is_sha256(&bundle_sha256), "bundleSha256")?;
            ensure(is_uuid(&source_node_id), "sourceNodeId")?;
            ensure(
                is_fingerprint(&source_key_fingerprint),
                "sourceKeyFingerprint",
            )?;
            ensure(source_node_id != rec.node_id, "sourceNodeId")?;
            if rec.role == Standalone {
                if !(target_is_fresh || replace) {
                    return Err(RoleError::TargetNotEmpty);
                }
            } else if rec.cluster_id.as_deref() != Some(cluster_id.as_str()) {
                return Err(RoleError::ForeignCluster);
            }
            if bundle_epoch < h {
                return Err(RoleError::StaleEpoch {
                    got: bundle_epoch,
                    highest: h,
                });
            }
            out.role = Pending;
            out.cluster_id = Some(cluster_id);
            out.highest_seen_epoch = h.max(bundle_epoch);
            out.handover = Some(Handover {
                id: handover_id,
                side: HandoverSide::Target,
                peer_node_id: source_node_id,
                peer_key_fingerprint: source_key_fingerprint,
                bundle_sha256: Some(bundle_sha256),
                expected_epoch: Some(bundle_epoch.saturating_add(1)),
                started_at_ms: now,
                lease_expires_at_ms: now.saturating_add(lease_ttl_ms),
                previous_role: rec.role,
                previous_cluster_id: rec.cluster_id.clone(),
                previous_epoch: n,
            });
        }
        Event::Activate {
            token_handover_id,
            token_cluster_id,
            token_epoch,
            token_bundle_sha256,
            token_target_node_id,
        } => {
            need(rec, name, &[Pending])?;
            let ho = handover_of(rec)?;
            let token = |ok: bool, field: &'static str| {
                if ok {
                    Ok(())
                } else {
                    Err(RoleError::CommitInvalid { field })
                }
            };
            token(token_handover_id == ho.id, "handoverId")?;
            token(
                rec.cluster_id.as_deref() == Some(token_cluster_id.as_str()),
                "clusterId",
            )?;
            token(token_target_node_id == rec.node_id, "targetNodeId")?;
            token(
                ho.bundle_sha256.as_deref() == Some(token_bundle_sha256.as_str()),
                "bundleSha256",
            )?;
            token(ho.expected_epoch == Some(token_epoch), "epoch")?;
            if token_epoch < h {
                return Err(RoleError::StaleEpoch {
                    got: token_epoch,
                    highest: h,
                });
            }
            out.role = Primary;
            out.epoch = token_epoch;
            out.highest_seen_epoch = h.max(token_epoch);
            out.primary = None;
            out.handover = None;
            out.frozen = None;
            out.last_primary_contact_at_ms = None;
        }
        Event::Discard => {
            need(rec, name, &[Pending])?;
            restore_previous(out, handover_of(rec)?);
        }
        Event::ForceTakeover {
            min_unreachable_ms,
            confirmed,
        } => {
            need(rec, name, &[Client])?;
            if !confirmed {
                return Err(RoleError::Unconfirmed);
            }
            let remaining_ms = takeover_remaining_ms(rec, now, min_unreachable_ms);
            if remaining_ms > 0 {
                return Err(RoleError::TakeoverTooEarly { remaining_ms });
            }
            let epoch = h.saturating_add(1);
            out.role = Primary;
            out.epoch = epoch;
            out.highest_seen_epoch = epoch;
            out.primary = None;
            out.frozen = None;
            out.last_primary_contact_at_ms = None;
        }
        Event::RestoreFrozen {
            confirmed,
            server_demoted_epoch,
        } => {
            need(rec, name, &[Client])?;
            let frozen = rec.frozen.as_ref().ok_or(RoleError::InvalidTransition {
                from: rec.role,
                event: name,
            })?;
            if !confirmed {
                return Err(RoleError::Unconfirmed);
            }
            if now > frozen.rollback_until_ms {
                return Err(RoleError::RollbackExpired);
            }
            if server_demoted_epoch < n {
                return Err(RoleError::StaleEpoch {
                    got: server_demoted_epoch,
                    highest: n,
                });
            }
            let epoch = h.max(server_demoted_epoch).saturating_add(1);
            out.role = Primary;
            out.epoch = epoch;
            out.highest_seen_epoch = epoch;
            out.primary = None;
            out.frozen = None;
            out.last_primary_contact_at_ms = None;
        }
        Event::Observed {
            cluster_id,
            epoch: e,
            primary,
        } => {
            ensure(is_uuid(&cluster_id), "clusterId")?;
            if let Some(p) = &primary {
                check_ref(p, "primary")?;
            }
            if rec.cluster_id.as_deref() != Some(cluster_id.as_str()) {
                return Err(RoleError::ForeignCluster);
            }
            observed(rec, out, e, primary, now)?;
        }
        Event::ResolveAsClient { epoch, primary } => {
            need(rec, name, &[Fenced])?;
            check_ref(&primary, "primary")?;
            if epoch < h {
                return Err(RoleError::StaleEpoch {
                    got: epoch,
                    highest: h,
                });
            }
            ensure(primary.node_id != rec.node_id, "primary")?;
            out.role = Client;
            out.epoch = epoch;
            out.highest_seen_epoch = h.max(epoch);
            out.primary = Some(primary);
            out.frozen = None;
            out.last_primary_contact_at_ms = Some(now);
        }
        Event::Join {
            cluster_id,
            epoch,
            primary,
            node_is_fresh,
        } => {
            need(rec, name, &[Standalone])?;
            ensure(is_uuid(&cluster_id), "clusterId")?;
            check_ref(&primary, "primary")?;
            if !node_is_fresh {
                return Err(RoleError::TargetNotEmpty);
            }
            ensure(epoch >= 1, "epoch")?;
            ensure(primary.node_id != rec.node_id, "primary")?;
            out.role = Client;
            out.cluster_id = Some(cluster_id);
            out.epoch = epoch;
            out.highest_seen_epoch = epoch;
            out.primary = Some(primary);
            out.last_primary_contact_at_ms = Some(now);
        }
        Event::Leave { confirmed } => {
            need(rec, name, &[Client])?;
            if rec
                .frozen
                .as_ref()
                .is_some_and(|f| now < f.rollback_until_ms)
                && !confirmed
            {
                return Err(RoleError::Unconfirmed);
            }
            become_standalone(out);
        }
    }
    Ok(())
}

/// Contact that reveals the cluster's current epoch `e` (spec §4.6). Only ever removes writers.
fn observed(
    rec: &RoleRecord,
    out: &mut RoleRecord,
    e: u64,
    primary: Option<NodeRef>,
    now: u64,
) -> Result<(), RoleError> {
    let n = rec.epoch;
    let raise = |out: &mut RoleRecord| out.highest_seen_epoch = out.highest_seen_epoch.max(e);
    let named_primary = |p: Option<NodeRef>| -> Result<Option<NodeRef>, RoleError> {
        if let Some(p) = &p {
            ensure(p.node_id != rec.node_id, "primary")?;
        }
        Ok(p)
    };
    match rec.role {
        Role::Primary | Role::HandingOver => {
            raise(out);
            if e > n {
                let primary = named_primary(primary)?;
                out.role = Role::Fenced;
                out.handover = None;
                out.primary = primary.or_else(|| rec.primary.clone());
            }
        }
        Role::Client => {
            if e >= n {
                let primary = named_primary(primary)?;
                if e > n {
                    out.epoch = e;
                    raise(out);
                }
                if let Some(p) = primary {
                    out.primary = Some(p);
                }
                out.last_primary_contact_at_ms = Some(now);
            }
        }
        Role::Pending => {
            let expected = handover_of(rec)?.expected_epoch.unwrap_or(u64::MAX);
            if e > expected {
                restore_previous(out, handover_of(rec)?);
                if out.role != Role::Standalone {
                    raise(out);
                }
            } else {
                raise(out);
            }
        }
        Role::Fenced => raise(out),
        // A standalone node has no cluster, so the caller's cluster check already refused it.
        Role::Standalone => return Err(RoleError::ForeignCluster),
    }
    Ok(())
}
