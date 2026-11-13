//! Daily strength decay with one conditional two-column write per bounded Lance row.
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, StoreError},
    ops::context::OperationContext,
    recall::{acl, tombstone_mask::TombstoneMask},
    store::Store,
    text::json::parse_json,
};
use std::time::{Duration, Instant};

pub(super) fn decay(
    store: &Store,
    ctx: &RequestContext,
    operations: &OperationContext,
    mask: &TombstoneMask,
    now: i64,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<usize, EngineError> {
    if now <= 0 {
        return Err(StoreError::InvalidInput.into());
    }
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut count = 0;
    let mut offset = 0;
    for _ in 0..10 {
        check()?;
        let rows = store.daily_decay_candidates(ctx, now, offset, 500)?;
        let size = rows.len();
        let mut updated = 0;
        for row in rows {
            cancel.check()?;
            if Instant::now() >= deadline {
                return Ok(count + updated);
            }
            if acl::allowed(&row, ctx).is_err() {
                continue;
            }
            if uuid::Uuid::parse_str(&row.id).is_err() {
                continue;
            }
            let row_json = serde_json::to_string(&row).map_err(|_| StoreError::Corrupt)?;
            let node_row = parse_json(&row_json).map_err(|_| StoreError::Corrupt)?;
            let strength =
                crate::capture::dynamics::compute_decayed_strength(&node_row, now as f64);
            let _mutation = operations.mutation()?;
            check()?;
            if mask.refreshed().masks(&row)? {
                continue;
            }
            updated += store.write_daily_decay(&row, strength, now)?;
            if updated + count >= 300 {
                return Ok(updated + count);
            }
        }
        count += updated;
        if size < 500 {
            break;
        }
        // Successful rows no longer match lastDynamicsAt on the next read.
        offset += size.saturating_sub(updated);
    }
    Ok(count)
}
