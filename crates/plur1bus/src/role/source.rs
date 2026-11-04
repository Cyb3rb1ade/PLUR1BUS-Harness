//! Source side of the closed role transition table.
use super::model::*;
use super::validation::*;

pub(super) fn step(
    rec: &RoleRecord,
    out: &mut RoleRecord,
    ev: Event,
    now: u64,
) -> Result<(), RoleError> {
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
                lease_expires_at_ms: super::fence::Lease::grant(now, lease_ttl_ms).expires_at_ms(),
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
                ho.lease_expires_at_ms =
                    super::fence::Lease::grant(now, lease_ttl_ms).expires_at_ms();
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
            let epoch = n.checked_add(1).ok_or(RoleError::EpochExhausted)?;
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
        _ => {
            return Err(RoleError::InvalidTransition {
                from: rec.role,
                event: name,
            })
        }
    }
    Ok(())
}
