//! A credential value in memory: an access or refresh token, a client secret, an authorization code, a PKCE verifier, a
//! `state`. TypeScript keeps such values in private class fields (`#value`) and gives `toJSON`, `String()` and
//! `util.inspect` a redacted form; here the type has no `Display`, its `Debug` prints `[redacted]`, and its buffer is zeroed
//! when it is dropped. Copies made to use it (a form body, a header line handed to the HTTP port) are the caller's.
use std::fmt;
use zeroize::Zeroizing;

/// A secret string. `==` compares in constant time, as [`Secret::matches`] does (review B, H-2).
#[derive(Clone)]
pub struct Secret(Zeroizing<String>);

impl PartialEq for Secret {
    fn eq(&self, other: &Secret) -> bool {
        self.matches(other.expose())
    }
}

impl Eq for Secret {}

impl Secret {
    /// Wraps a value.
    pub fn new(value: impl Into<String>) -> Secret {
        Secret(Zeroizing::new(value.into()))
    }

    /// The value, for the one place that must send or store it. Never log it.
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Whether the value is empty (JavaScript's falsy string).
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Equality in constant time over the bytes (`timingSafeEqual` after the length check TypeScript makes).
    pub fn matches(&self, other: &str) -> bool {
        crate::auth::constant_time_eq(self.0.as_bytes(), other.as_bytes())
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted]")
    }
}

/// SHA-256 of both sides, then a constant-time compare: the shape the loopback listeners use so that neither the length nor
/// the content of the expected `state` shows in the time a refusal takes.
pub fn digest_equal(a: &str, b: &str) -> bool {
    use sha2::{Digest, Sha256};
    let x = Sha256::digest(a.as_bytes());
    let y = Sha256::digest(b.as_bytes());
    crate::auth::constant_time_eq(&x, &y)
}
