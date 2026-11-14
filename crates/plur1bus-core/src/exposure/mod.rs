//! Port of the memory exposure resolution and the sensitivity scanner (`packages/core/src/memory-exposure/{types,config,
//! resolve,sensitivity}.ts`, `memory-sensitivity/{types,scanner}.ts`, P4-12 task 2). A library: nothing in the front door
//! calls it yet (`route::NATIVE` stays empty). Not here: `memory-exposure/{collab,external}.ts` (the turn path, P4-40) and
//! `memory-sensitivity/rpc.ts` (the flip PR of P4-12).
//!
//! - [`types`]: channels, scope access, switches, the effective [`types::Exposure`] and the token binding the resolution reads;
//! - [`config`]: the channel defaults and [`config::channel_switches`] (a configured switch narrows or widens its default);
//! - [`resolve`]: [`resolve::resolve_exposure`], [`resolve::read_rights`] and [`resolve::can_capture`] over the RBAC decision;
//! - [`scanner`]: the five sensitivity categories, the five hand-written classifiers (no regular-expression crate) and
//!   `computeContentHash`;
//! - [`sensitivity`]: the refusal rules and the block filter over a small trait for the sensitivity service;
//! - [`sensitivity_store`]: `memory-sensitivity/store.ts`, `memory-sensitivity.sqlite` opened as TypeScript opens it (task 7);
//! - [`sensitivity_service`]: `memory-sensitivity/service.ts`, the service over that store and the scanner, implementing the
//!   trait of [`sensitivity`] (task 7).
pub mod config;
pub mod resolve;
pub mod scanner;
pub mod sensitivity;
pub mod sensitivity_store;
pub mod types;
#[cfg(test)]
mod vectors;
