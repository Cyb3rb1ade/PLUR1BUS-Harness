//! Private recovery metadata for an invoked native effect.

use crate::gate::Caller;
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Fixed-size binding to the authenticated principal, agent and optional session.
#[derive(Clone, Copy, PartialEq, Eq)]
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

/// Durable at the flip. All access, including updates, is scoped to the owner.
pub trait Receipts {
    /// Reserve a unique ID with an uncertain outcome before invoking the effect.
    /// Fail closed on collision, unavailable storage or exhausted retention.
    fn reserve(&mut self, owner: ReceiptOwner, receipt: Receipt) -> bool;
    /// Replace only a matching existing reservation. On failure keep the prior record.
    fn finish(&mut self, owner: ReceiptOwner, receipt: Receipt) -> bool;
    /// Return only a record belonging to this exact authenticated owner.
    fn get(&self, owner: ReceiptOwner, id: Uuid) -> Option<Receipt>;
}

#[cfg(test)]
#[derive(Default)]
pub(super) struct MemoryReceipts(Vec<(ReceiptOwner, Receipt)>);

#[cfg(test)]
impl Receipts for MemoryReceipts {
    fn reserve(&mut self, owner: ReceiptOwner, receipt: Receipt) -> bool {
        if self.0.len() >= 128 || self.0.iter().any(|(_, r)| r.id == receipt.id) {
            return false;
        }
        self.0.push((owner, receipt));
        true
    }
    fn finish(&mut self, owner: ReceiptOwner, receipt: Receipt) -> bool {
        if let Some(entry) = self
            .0
            .iter_mut()
            .find(|(key, r)| *key == owner && r.id == receipt.id)
        {
            entry.1 = receipt;
            return true;
        }
        false
    }
    fn get(&self, owner: ReceiptOwner, id: Uuid) -> Option<Receipt> {
        self.0
            .iter()
            .find(|(key, r)| *key == owner && r.id == id)
            .map(|(_, r)| *r)
    }
}
