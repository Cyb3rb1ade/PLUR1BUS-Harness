//! A single absolute deadline for direct reranking and caller-owned budgets.

use super::{ProviderError, ProviderErrorKind};
use crate::contract::{Cancel, CancelReason};
use std::time::{Duration, Instant};

pub(crate) fn check(cancel: &Cancel) -> Result<(), ProviderError> {
    cancel.check().map_err(|error| {
        ProviderError::simple(match error.reason {
            CancelReason::Caller => ProviderErrorKind::Aborted,
            CancelReason::Deadline => ProviderErrorKind::Timeout,
        })
    })
}

/// Use the caller's deadline when present, otherwise create one direct-call budget.
pub fn request_deadline(
    cancel: &Cancel,
    direct_timeout: Duration,
) -> Result<Instant, ProviderError> {
    check(cancel)?;
    let anchor = Instant::now();
    let budget = cancel.remaining().unwrap_or(direct_timeout);
    anchor
        .checked_add(budget)
        .ok_or_else(|| ProviderError::simple(ProviderErrorKind::InvalidRequest))
}
