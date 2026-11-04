//! Epoch comparison, lease timing, the forced-takeover wait and the writer decision. All arithmetic saturates.
use super::model::{takeover_remaining_ms, Role, RoleRecord};
use super::store::Loaded;

/// Default lease lifetime in wall-clock milliseconds.
pub(crate) const DEFAULT_LEASE_TTL_MS: u64 = 120_000;
/// Default heartbeat interval in milliseconds.
pub(crate) const DEFAULT_HEARTBEAT_MS: u64 = 30_000;
/// Minimum unreachable duration before a confirmed forced takeover, in milliseconds.
pub(crate) const DEFAULT_TAKEOVER_MIN_UNREACHABLE_MS: u64 = 600_000;
/// Default frozen-state rollback window in milliseconds.
pub(crate) const DEFAULT_ROLLBACK_WINDOW_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// Environment variable through which the supervisor tells the core that writers are held back.
pub(crate) const HOLD_ENV: &str = "PLUR1BUS_ROLE_HOLD";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// Ordering of authenticated peer authority: epoch first; lowest node id wins an equal-epoch writer conflict.
pub(crate) enum EpochVerdict {
    /// Equal authority, including contact with a non-writer at the same epoch.
    Same,
    /// The other side is at a higher epoch than this node.
    LocalBehind,
    /// This node is at a higher epoch than the other side.
    LocalAhead,
    /// Peer facts name another cluster and cannot affect this record.
    ForeignCluster,
}

/// Compare verified peer facts; equal-epoch non-writers never fence a writer.
pub(crate) fn compare(
    local: &RoleRecord,
    cluster_id: &str,
    epoch: u64,
    peer_node_id: &str,
    peer_is_writer: bool,
) -> EpochVerdict {
    if local.cluster_id.as_deref() != Some(cluster_id) {
        EpochVerdict::ForeignCluster
    } else if epoch == local.epoch {
        if peer_is_writer
            && peer_node_id != local.node_id
            && matches!(local.role, Role::Primary | Role::HandingOver)
        {
            if peer_node_id < local.node_id.as_str() {
                EpochVerdict::LocalBehind
            } else {
                EpochVerdict::LocalAhead
            }
        } else {
            EpochVerdict::Same
        }
    } else if epoch > local.epoch {
        EpochVerdict::LocalBehind
    } else {
        EpochVerdict::LocalAhead
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// Caller-supplied wall-clock lease. RS4 owns clock-skew checks before applying remote facts.
pub(crate) struct Lease {
    pub(crate) granted_at_ms: u64,
    pub(crate) ttl_ms: u64,
}

impl Lease {
    /// Grant at the supplied wall-clock millisecond without reading a host clock.
    pub(crate) fn grant(now_ms: u64, ttl_ms: u64) -> Lease {
        Lease {
            granted_at_ms: now_ms,
            ttl_ms,
        }
    }

    /// Saturating absolute wall-clock expiry in milliseconds.
    pub(crate) fn expires_at_ms(&self) -> u64 {
        self.granted_at_ms.saturating_add(self.ttl_ms)
    }

    /// Live up to and including the expiry instant.
    pub(crate) fn is_live(&self, now_ms: u64) -> bool {
        now_ms <= self.expires_at_ms()
    }

    /// Whether at least one heartbeat interval elapsed since the grant.
    pub(crate) fn renew_due(&self, now_ms: u64, heartbeat_ms: u64) -> bool {
        now_ms >= self.granted_at_ms.saturating_add(heartbeat_ms)
    }

    /// A fresh grant at `now_ms`, or `None` once the lease has expired.
    pub(crate) fn renew(&self, now_ms: u64) -> Option<Lease> {
        self.is_live(now_ms)
            .then(|| Lease::grant(now_ms, self.ttl_ms))
    }
}

/// 0 when a forced takeover is allowed now, else the milliseconds still to wait. `u64::MAX` for a record that is not
/// a client (it can never take over).
pub(crate) fn takeover_wait_ms(rec: &RoleRecord, now_ms: u64, min_unreachable_ms: u64) -> u64 {
    if rec.role != Role::Client {
        return u64::MAX;
    }
    takeover_remaining_ms(rec, now_ms, min_unreachable_ms)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// Whether the supervisor may admit writer units under the stored role.
pub(crate) enum WriterDecision {
    Allowed,
    Denied { reason: &'static str },
}

/// Whether this node may run channels, schedulers and memory writes. A missing record means standalone; a corrupt one
/// never fails open.
pub(crate) fn writer_decision(loaded: &Loaded) -> WriterDecision {
    match loaded {
        Loaded::Missing => WriterDecision::Allowed,
        Loaded::Valid(r) if r.role.writers_allowed() => WriterDecision::Allowed,
        Loaded::Valid(_) => WriterDecision::Denied {
            reason: "role-hold",
        },
        Loaded::Corrupt { .. } => WriterDecision::Denied {
            reason: "role-record-corrupt",
        },
    }
}

/// The value of [`HOLD_ENV`] for a record whose role holds writers back (`<role>:<epoch>`), `None` otherwise.
pub(crate) fn hold_env_value(rec: &RoleRecord) -> Option<String> {
    if rec.role.writers_allowed() {
        None
    } else {
        Some(format!("{}:{}", rec.role.as_str(), rec.epoch))
    }
}
