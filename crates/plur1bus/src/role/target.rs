//! Target side of the closed role transition table.
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
                expected_epoch: Some(
                    bundle_epoch
                        .checked_add(1)
                        .ok_or(RoleError::EpochExhausted)?,
                ),
                started_at_ms: now,
                lease_expires_at_ms: super::fence::Lease::grant(now, lease_ttl_ms).expires_at_ms(),
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
        _ => {
            return Err(RoleError::InvalidTransition {
                from: rec.role,
                event: name,
            })
        }
    }
    Ok(())
}
