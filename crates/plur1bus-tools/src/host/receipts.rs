//! Private recovery metadata for an invoked native effect.

use crate::gate::Caller;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[cfg(test)]
use std::collections::{HashMap, VecDeque};

/// Maximum lifetime of a receipt from its first reservation (seven days).
pub const RECEIPT_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// Maximum number of retained receipts for one authenticated identity.
pub const RECEIPTS_PER_IDENTITY: usize = 10_000;

/// Fixed-size binding to the authenticated principal, agent and optional session.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ReceiptOwner([u8; 32]);

impl ReceiptOwner {
    /// Bind the recovery record to the same identity used for dispatch.
    pub fn of(caller: &Caller) -> Self {
        let mut hash = Sha256::new();
        for part in [
            Some(caller.principal.as_str()),
            Some(caller.agent_id.as_str()),
            caller.session_id.as_deref(),
        ] {
            match part {
                Some(value) => {
                    hash.update([1]);
                    hash.update((value.len() as u64).to_be_bytes());
                    hash.update(value.as_bytes());
                }
                None => hash.update([0]),
            }
        }
        Self(hash.finalize().into())
    }

    /// The fixed-width key for a durable host adapter.
    pub fn key(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Output-free recovery state. A confirmed native effect can still have a delivery error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    /// Server-issued ID allocated before dispatch.
    pub id: Uuid,
    /// True once the native adapter confirms that the effect completed.
    pub confirmed: bool,
    /// Opaque process registration for a start operation.
    pub process: Option<Uuid>,
    /// Explicit positive confirmation from the native cleanup port.
    pub stopped: bool,
}

/// Durable at the flip. All access and eviction are scoped to the owner.
/// A receipt expires at seven days from reservation or when more than 10,000
/// reservations for that owner would be retained, whichever comes first.
/// Evict the oldest reservations first. Completion does not extend retention.
/// Timestamps use the trusted Hostctl clock in milliseconds since the epoch.
pub trait Receipts {
    /// Reserve a unique ID with an uncertain outcome before invoking the effect.
    /// Apply retention and reserve atomically. Fail closed on collision or unavailable storage.
    fn reserve(&mut self, owner: ReceiptOwner, receipt: Receipt, now_ms: f64) -> bool;
    /// Replace only a matching, unexpired reservation. On failure keep the prior record.
    fn finish(&mut self, owner: ReceiptOwner, receipt: Receipt, now_ms: f64) -> bool;
    /// Return only an unexpired record belonging to this exact authenticated owner.
    fn get(&self, owner: ReceiptOwner, id: Uuid, now_ms: f64) -> Option<Receipt>;
}

#[cfg(test)]
struct TimedReceipt {
    receipt: Receipt,
    reserved_at: f64,
}

#[cfg(test)]
impl TimedReceipt {
    fn live_at(&self, now_ms: f64) -> bool {
        now_ms.is_finite() && now_ms - self.reserved_at < RECEIPT_TTL_MS as f64
    }
}

#[cfg(test)]
#[derive(Default)]
pub(super) struct MemoryReceipts(HashMap<ReceiptOwner, VecDeque<TimedReceipt>>);

#[cfg(test)]
impl Receipts for MemoryReceipts {
    fn reserve(&mut self, owner: ReceiptOwner, receipt: Receipt, now_ms: f64) -> bool {
        if !now_ms.is_finite() {
            return false;
        }
        let entries = self.0.entry(owner).or_default();
        entries.retain(|entry| entry.live_at(now_ms));
        if entries.iter().any(|entry| entry.receipt.id == receipt.id) {
            return false;
        }
        if entries.len() == RECEIPTS_PER_IDENTITY {
            entries.pop_front();
        }
        entries.push_back(TimedReceipt {
            receipt,
            reserved_at: now_ms,
        });
        true
    }

    fn finish(&mut self, owner: ReceiptOwner, receipt: Receipt, now_ms: f64) -> bool {
        let entry = self.0.get_mut(&owner).and_then(|entries| {
            entries
                .iter_mut()
                .find(|entry| entry.receipt.id == receipt.id && entry.live_at(now_ms))
        });
        if let Some(entry) = entry {
            entry.receipt = receipt;
            return true;
        }
        false
    }

    fn get(&self, owner: ReceiptOwner, id: Uuid, now_ms: f64) -> Option<Receipt> {
        self.0
            .get(&owner)?
            .iter()
            .find(|entry| entry.receipt.id == id && entry.live_at(now_ms))
            .map(|entry| entry.receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt(n: u128) -> Receipt {
        Receipt {
            id: Uuid::from_u128(n),
            confirmed: false,
            process: None,
            stopped: false,
        }
    }

    #[test]
    fn completion_keeps_the_original_expiration_time() {
        let mut store = MemoryReceipts::default();
        let owner = ReceiptOwner([1; 32]);
        let expires = RECEIPT_TTL_MS as f64;
        let mut pending = receipt(1);
        assert!(store.reserve(owner, pending, 10.0));
        pending.confirmed = true;
        assert!(store.finish(owner, pending, 100.0));
        assert_eq!(store.get(owner, pending.id, 9.0 + expires), Some(pending));
        assert_eq!(store.get(owner, pending.id, 10.0 + expires), None);
        assert!(!store.finish(owner, pending, 10.0 + expires));
        assert!(store.reserve(owner, pending, 11.0 + expires));
    }

    #[test]
    fn oldest_reservation_is_evicted_only_for_its_owner() {
        let mut store = MemoryReceipts::default();
        let owner = ReceiptOwner([1; 32]);
        let other = ReceiptOwner([2; 32]);
        let first = receipt(1);
        assert!(store.reserve(other, first, 0.0));
        for i in 1..=RECEIPTS_PER_IDENTITY {
            assert!(store.reserve(owner, receipt(i as u128), i as f64));
        }
        assert_eq!(store.get(owner, first.id, 10_001.0), Some(first));
        assert!(!store.reserve(owner, first, 10_001.0));
        assert_eq!(store.get(owner, first.id, 10_001.0), Some(first));
        assert!(store.reserve(owner, receipt(RECEIPTS_PER_IDENTITY as u128 + 1), 10_001.0));
        assert_eq!(store.get(owner, first.id, 10_001.0), None);
        assert_eq!(store.get(owner, receipt(2).id, 10_001.0), Some(receipt(2)));
        assert_eq!(store.get(other, first.id, 10_001.0), Some(first));
    }
}
