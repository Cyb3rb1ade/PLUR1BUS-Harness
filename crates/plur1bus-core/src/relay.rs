//! P4-10: the relay. A method the Rust core does not serve natively (`DispatchError::NotServed`) is forwarded to
//! `core-legacy` on `run/core-legacy.sock` with the authenticated caller context (principal kind, identity, trust level);
//! the legacy core keeps its own RBAC guard until the cut. Empty in P4-03.
