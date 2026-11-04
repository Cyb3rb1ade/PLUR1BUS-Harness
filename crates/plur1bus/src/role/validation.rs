//! Role-record validation, independent of transition dispatch.
use super::model::*;

// ----
// Validation
// ----

pub(super) fn is_uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|u| u.to_string() == s)
}

pub(super) fn is_fingerprint(s: &str) -> bool {
    s.strip_prefix("sha256:").is_some_and(|rest| {
        rest.len() == 43
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    })
}

pub(super) fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn text_ok(s: &str, max_chars: usize) -> bool {
    let n = s.chars().count();
    (1..=max_chars).contains(&n) && !s.chars().any(char::is_control)
}

pub(super) fn ensure(ok: bool, field: &'static str) -> Result<(), RoleError> {
    if ok {
        Ok(())
    } else {
        Err(RoleError::InvalidInput { field })
    }
}

/// The first invalid part of a node reference, as a camelCase path below the reference.
pub(super) fn node_ref_problem(n: &NodeRef) -> Option<&'static str> {
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
    pub(crate) fn standalone(
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
    pub(crate) fn validate(&self) -> Result<(), RoleError> {
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
