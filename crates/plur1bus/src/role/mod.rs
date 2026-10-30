//! Primary/client role model: the single-writer role record of one node, the pure transition function over it, the
//! on-disk store and the epoch/lease helpers. No I/O except `store`, no clock, no network, no cryptography: events
//! carry facts the caller already verified.
// Wired by RS1 (supervisor gate) and RS4 (handover commands); remove then.
#![allow(dead_code)]
pub mod fence;
pub mod model;
pub mod store;

#[allow(unused_imports)]
pub use fence::{
    compare, hold_env_value, takeover_wait_ms, writer_decision, EpochVerdict, Lease, WriterDecision,
};
#[allow(unused_imports)]
pub use model::{
    apply, Event, Frozen, Handover, HandoverSide, NodeRef, Reach, ReachKind, Role, RoleError,
    RoleRecord, ROLE_SCHEMA,
};
#[allow(unused_imports)]
pub use store::{load, save, Loaded, MAX_RECORD_BYTES};

#[cfg(test)]
mod tests;
