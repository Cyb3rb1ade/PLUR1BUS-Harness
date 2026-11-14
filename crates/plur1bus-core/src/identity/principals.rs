//! `identity/principals.ts`: the `user:v1|v2:<sha256>` shape and the v2 derivation.
use super::{error::IdentityError, error::IdentityErrorCode, sha256_hex, utf8_of_units};
use crate::js::utf16;

/// The longest harness user id, in UTF-16 code units (`harnessUserId.length > 128`).
pub const MAX_HARNESS_USER_ID_UNITS: usize = 128;

/// `USER_PRINCIPAL.test(value)`: `/^user:v(1|2):[a-f0-9]{64}$/` (JavaScript's `$` without the `m` flag matches only at the end,
/// so a trailing line break does not pass).
pub fn is_user_principal(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 72
        && b.starts_with(b"user:v")
        && matches!(b.get(6), Some(b'1' | b'2'))
        && b.get(7) == Some(&b':')
        && b.iter()
            .skip(8)
            .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// `deriveUserPrincipal` over code units: `user:v2:` plus the SHA-256 of the exact UTF-8 bytes of the id. Never trims, folds case
/// or normalises. Refused as `invalid-params`: the empty id, more than 128 units, any unit of U+0000 to U+001F or U+007F.
pub fn derive_user_principal_units(id: &[u16]) -> Result<String, IdentityError> {
    if id.is_empty()
        || id.len() > MAX_HARNESS_USER_ID_UNITS
        || id.iter().any(|u| *u <= 0x1f || *u == 0x7f)
    {
        return Err(IdentityError::new(
            IdentityErrorCode::InvalidParams,
            "invalid harness user id",
        ));
    }
    Ok(format!("user:v2:{}", sha256_hex(&[&utf8_of_units(id)])))
}

/// [`derive_user_principal_units`] of a Rust string.
pub fn derive_user_principal(id: &str) -> Result<String, IdentityError> {
    derive_user_principal_units(&utf16(id))
}
