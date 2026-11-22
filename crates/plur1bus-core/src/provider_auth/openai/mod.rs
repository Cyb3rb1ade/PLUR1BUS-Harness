//! `packages/core/src/openai-auth/` (D110): the OpenAI credentials of the harness. "Sign in with ChatGPT" (the plan login with
//! dynamic client registration, OIDC and PKCE, and its single-use rotating refresh), the installation's host identity, the
//! workload-identity token exchange, a federated supplier, the closed wire guard of the plan route, the plan usage book, and
//! the in-process service that owns the logins.
//!
//! Not ported: `provider.ts` (the streaming adapter belongs to the provider crate of P4-W) and `runtime.ts` (the composition
//! of the flip). The promise plumbing of `AuthService.startLogin`/`awaitLogin` is replaced by a synchronous login through the
//! PKCE port and the [`service::PendingLogins`] bookkeeping.
pub mod federated;
pub mod http;
pub mod identity;
pub mod loopback;
pub mod plan;
pub mod ports;
pub mod profiles;
pub mod service;
pub mod usage;
pub mod wire;
pub mod workload;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;
