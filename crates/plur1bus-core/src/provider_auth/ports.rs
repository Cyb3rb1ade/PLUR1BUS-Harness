//! The small ports every part of the package shares (R-K-2): the clock (`auth/clock.ts`), randomness, and the log sink
//! (`auth/log.ts`). Times are JavaScript numbers (milliseconds since the epoch as `f64`), because the TypeScript code adds
//! fractional `expires_in` seconds to them and the stored record keeps what it computed.
use serde_json::Value;

/// `Clock`: the engine never reads the wall clock directly.
pub trait Clock: Send + Sync {
    /// Milliseconds since the epoch.
    fn now(&self) -> f64;
}

/// `Math.random()` where the TypeScript code takes it as an option (refresh jitter, backoff, stored-expiry jitter).
pub trait RandomUnit: Send + Sync {
    /// A number in `[0, 1)`; values outside are clamped by the caller as TypeScript clamps them.
    fn next(&self) -> f64;
}

/// `crypto.randomBytes(n)`: the `state`, the PKCE verifier, the OpenAI nonce, the host key.
pub trait RandomBytes: Send + Sync {
    /// Fills `out` with fresh random bytes; `false` when there is no randomness (the caller refuses, never proceeds).
    fn fill(&self, out: &mut [u8]) -> bool;
}

/// `AuthLog`: events carry ids, codes and counts only; never a token, header or response body.
pub trait AuthLog: Send + Sync {
    /// One event with its fields, in the order the TypeScript code writes them.
    fn log(&self, event: &str, fields: &[(&str, Value)]);
}

/// A port that could not do what it was asked (a file that cannot be read, a browser that did not open, a cancelled wait).
/// It carries nothing: the caller turns it into its own constant error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PortFailure;

/// `noLog`.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoLog;

impl AuthLog for NoLog {
    fn log(&self, _event: &str, _fields: &[(&str, Value)]) {}
}

/// The operating system's randomness (`getrandom`, as the rest of the core draws it).
#[derive(Clone, Copy, Debug, Default)]
pub struct OsRandom;

impl RandomBytes for OsRandom {
    fn fill(&self, out: &mut [u8]) -> bool {
        getrandom::fill(out).is_ok()
    }
}

/// `String(n)` of JavaScript.
pub fn js_number(n: f64) -> String {
    crate::metrics::registry::js_number_to_string(n)
}

/// `base64url` without padding (`Buffer#toString("base64url")`).
pub fn base64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
