//! Membership side of the closed role transition table.
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
            let epoch = h.checked_add(1).ok_or(RoleError::EpochExhausted)?;
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
            let epoch = h
                .max(server_demoted_epoch)
                .checked_add(1)
                .ok_or(RoleError::EpochExhausted)?;
            out.role = Primary;
            out.epoch = epoch;
            out.highest_seen_epoch = epoch;
            out.primary = None;
            out.frozen = None;
            out.last_primary_contact_at_ms = None;
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
        _ => {
            return Err(RoleError::InvalidTransition {
                from: rec.role,
                event: name,
            })
        }
    }
    Ok(())
}
