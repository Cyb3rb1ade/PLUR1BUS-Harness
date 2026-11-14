//! Port of the memory exposure resolution and the sensitivity scanner (`packages/core/src/memory-exposure/{types,config,
//! resolve,sensitivity}.ts`, `memory-sensitivity/{types,scanner}.ts`, P4-12 task 2). A library: nothing in the front door
//! calls it yet (`route::NATIVE` stays empty). Not here: `memory-exposure/{collab,external}.ts` (the turn path, P4-40) and
//! `memory-sensitivity/{service,store,rpc}.ts` (task 7).
//!
//! - [`types`]: channels, scope access, switches, the effective [`types::Exposure`] and the token binding the resolution reads;
//! - [`config`]: the channel defaults and [`config::channel_switches`] (a configured switch narrows or widens its default);
//! - [`resolve`]: [`resolve::resolve_exposure`], [`resolve::read_rights`] and [`resolve::can_capture`] over the RBAC decision;
//! - [`scanner`]: the five sensitivity categories, the five hand-written classifiers (no regular-expression crate) and
//!   `computeContentHash`;
//! - [`sensitivity`]: the refusal rules and the block filter over a small trait for the sensitivity service.
pub mod config;
pub mod resolve;
pub mod scanner;
pub mod sensitivity;
pub mod types;
#[cfg(test)]
mod vectors;
