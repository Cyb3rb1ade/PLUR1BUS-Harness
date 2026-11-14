//! Port of the pure parts of identity (`packages/core/src/identity/{principals,codes,invite-token,ratelimit,authorization,recall}.ts`
//! and the id validation of `service.ts`, ADR-007, P4-12 task 3).
//!
//! A library: nothing in the front door calls it yet (`route::NATIVE` stays empty). The vectors under `fixtures/parity/identity/`
//! (recorded by `scripts/parity/export-identity.ts`) are replayed by `vectors.rs`.
//!
//! - [`principals`]: the `user:v1|v2:<sha256>` shape and the v2 derivation;
//! - [`service`]: the pure helpers of `service.ts` (`v1PrincipalOf`, `isChannelName`, the id validation) and the `Actor` type;
//! - [`codes`]: pairing-code alphabet, normalisation, salted hash, constant-time compare, UUIDv7; randomness comes in through
//!   [`codes::RandomSource`] (R6), the clock as a parameter;
//! - [`invite_token`]: invite token mint, shape, hash, origin parser and link;
//! - [`ratelimit`]: the limiter arithmetic over a row and a clock, behind [`ratelimit::AttemptStore`] (the `attempts` table);
//! - [`authorization`]: the identity action gate on top of [`crate::rbac::authorize`];
//! - [`recall`]: the recall scope provider over [`recall::PrincipalResolver`].
//!
//! Lengths are UTF-16 code units, hash inputs are the UTF-8 bytes `Buffer.from(s, "utf8")` makes (a lone surrogate becomes
//! U+FFFD), so the helpers that can see such a string have a `*_units` form over `&[u16]` (see [`crate::js`]).
use sha2::{Digest, Sha256};

pub mod codes;
pub mod error;
pub mod invite_token;
pub mod principals;
pub mod service;

pub use error::{IdentityError, IdentityErrorCode};

/// Lower-case hexadecimal of `bytes` (`Buffer#toString("hex")`).
pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from(DIGITS[usize::from(b >> 4)]));
        out.push(char::from(DIGITS[usize::from(b & 15)]));
    }
    out
}

/// `createHash("sha256").update(a).update(b)....digest("hex")`.
pub(crate) fn sha256_hex(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hex(&hasher.finalize())
}

/// The bytes `Buffer.from(s, "utf8")` makes of a JavaScript string given as code units: a lone surrogate is U+FFFD.
pub(crate) fn utf8_of_units(units: &[u16]) -> Vec<u8> {
    String::from_utf16_lossy(units).into_bytes()
}
