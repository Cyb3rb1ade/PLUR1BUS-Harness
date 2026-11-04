//! Observation side of the closed role transition table.
use super::model::*;
use super::validation::*;

struct Peer {
    epoch: u64,
    node_id: String,
    is_writer: bool,
    primary: Option<NodeRef>,
}

pub(super) fn step(
    rec: &RoleRecord,
    out: &mut RoleRecord,
    ev: Event,
    now: u64,
) -> Result<(), RoleError> {
    let name = ev.name();
    match ev {
        Event::Observed {
            cluster_id,
            epoch: e,
            peer_node_id,
            peer_is_writer,
            primary,
        } => {
            ensure(is_uuid(&cluster_id), "clusterId")?;
            ensure(is_uuid(&peer_node_id), "peerNodeId")?;
            if rec.cluster_id.as_deref() != Some(cluster_id.as_str()) {
                return Err(RoleError::ForeignCluster);
            }
            observe(
                rec,
                out,
                Peer {
                    epoch: e,
                    node_id: peer_node_id,
                    is_writer: peer_is_writer,
                    primary,
                },
                now,
            )?;
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

/// Contact that reveals the cluster's current epoch `e` (spec §4.6). Only ever removes writers.
fn observe(rec: &RoleRecord, out: &mut RoleRecord, peer: Peer, now: u64) -> Result<(), RoleError> {
    let Peer {
        epoch: e,
        node_id: peer_node_id,
        is_writer: peer_is_writer,
        primary,
    } = peer;
    let n = rec.epoch;
    let raise = |out: &mut RoleRecord| out.highest_seen_epoch = out.highest_seen_epoch.max(e);
    // The authenticated epoch/peer identity triggers fencing independently of optional display metadata.
    let primary = primary.filter(|p| check_ref(p, "primary").is_ok() && p.node_id != rec.node_id);
    match rec.role {
        Role::Primary | Role::HandingOver => {
            raise(out);
            if super::fence::compare(
                rec,
                rec.cluster_id.as_deref().unwrap_or_default(),
                e,
                &peer_node_id,
                peer_is_writer,
            ) == super::fence::EpochVerdict::LocalBehind
            {
                out.role = Role::Fenced;
                out.handover = None;
                out.primary = primary.or_else(|| rec.primary.clone());
            }
        }
        Role::Client => {
            if e >= n {
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
