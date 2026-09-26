//! Supervisor: process lifecycle for the core (and, later, modules).
//!
//! `state` is the pure state machine (health, backoff, crash classification) with no I/O; the
//! threads, sockets and process spawning that drive it land in later tasks of this plan and are
//! this module's only planned callers, so its public surface is unused for now.
#![allow(dead_code)]
pub mod state;
