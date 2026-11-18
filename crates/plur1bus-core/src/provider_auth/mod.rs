//! `packages/core/src/auth/` and `packages/core/src/openai-auth/` (P4-K K4, plan P4-23): how the core holds and refreshes the
//! credentials of the model providers. The TypeScript code is the specification; a difference is a recorded `K4-D` finding.
//!
//! **What it is.** A provider profile ([`profile::AuthProfile`]) names how a provider authenticates (an API key, an OAuth
//! login with PKCE or a device code, Google's application-default credential, a vendor's own CLI, a federated token). The
//! login ladder ([`ladder::plan_login`]) picks the flow an environment allows. A credential pool ([`pool::CredentialPool`])
//! per profile chooses which stored credential a call uses and is the one authority on cooldowns. The refresh owner
//! ([`refresh::RefreshOwner`]) is the one place that spends a refresh token, once, however many callers ask at the same
//! moment. The credentials provider ([`credentials::CredentialsProvider`]) puts these together for a provider adapter: one
//! lease per request, one report per outcome.
//!
//! **Where the secrets are.** Tokens, refresh tokens, client secrets, authorization codes, PKCE verifiers and `state` live in
//! [`secret::Secret`] (no printable form, zeroed on drop) and go to disk only through the [`record::SecretStore`] port, whose
//! production implementation is the core's secret store (`secrets::`). No type of this module derives `Debug` over a secret;
//! errors carry codes and constant texts only.
//!
//! **Nothing here runs in the product.** No RPC method, no Front Door route and no supervisor hook reaches this module; the
//! flip wires it. What it needs from the rest of the core comes in as a port (R-K-2): the clock and randomness
//! ([`ports`]), the secret store, the HTTP transport ([`http::HttpTransport`], R-K-14: `plur1bus-core` has no HTTP client),
//! the loopback listener and the browser opener of the login flows, the environment snapshot, the files of Google ADC, the
//! timer of the refresh schedule and the log sink.
pub mod adc;
pub mod credentials;
pub mod env;
pub mod errors;
pub mod http;
pub mod ladder;
pub mod login;
pub mod openai;
pub mod pool;
pub mod ports;
pub mod profile;
pub mod record;
pub mod redact;
pub mod refresh;
pub mod secret;

#[cfg(test)]
mod loopback_tests;
#[cfg(test)]
mod testing;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;

pub use errors::{AuthError, AuthErrorCode};
pub use secret::Secret;
