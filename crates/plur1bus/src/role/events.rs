//! Verified input facts for the closed role transition table.
use super::model::NodeRef;

// ----
// Events
// ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Event {
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
    /// Authenticated peer epoch, identity and writer status; the optional primary is descriptive only.
    Observed {
        cluster_id: String,
        epoch: u64,
        peer_node_id: String,
        peer_is_writer: bool,
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
    pub(crate) fn name(&self) -> &'static str {
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
