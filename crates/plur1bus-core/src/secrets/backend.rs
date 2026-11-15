//! `SecretBackend` of `secrets/types.ts`, the order `list` gives, and the ISO timestamps a backend writes.
//!
//! The TypeScript interface is asynchronous (a keyring or a helper process may take time); this is its faithful synchronous
//! translation: `&mut self` and `Result<_, SecretError>`, times as epoch milliseconds (`new Date(ms)`), the optional
//! `register` callback as an optional `&mut dyn FnMut(&str)`. A backend holds well-formed strings: a name, a value or a
//! description with a lone surrogate (which JavaScript can hold, and which the `*_units` checks of [`super::types`] still
//! judge) cannot reach it from Rust.
use super::error::SecretError;
use super::types::{BackendKind, BackendProbe, SecretMeta};
use crate::logs::query::iso_string;
use std::cmp::Ordering;
use std::collections::BTreeMap;

/// `new Date(ms).toISOString()`. A time value outside `TimeClip`'s range is [`SecretError::invalid_time`] (V8 throws a
/// `RangeError` there).
pub fn iso_timestamp(ms: i64) -> Result<String, SecretError> {
    iso_string(ms).ok_or_else(SecretError::invalid_time)
}

/// The primary weight and the tertiary (case) weight of one character, ICU root collation as `localeCompare` applies it.
///
/// A secret name holds only ASCII letters, digits and `. _ : / @ -` (and, in an extension slot, the same). In the CLDR root
/// order punctuation sorts before digits and digits before letters, with `_ - : . @ /` in that order among themselves; a
/// letter's case is a tertiary difference (lower case first), so it only decides when everything else ties. A character
/// outside that set sorts after the letters by code point (the order of no real name; the function is total, not ICU for
/// them).
fn collation_weights(c: char) -> (u32, u8) {
    match c {
        '_' => (1, 0),
        '-' => (2, 0),
        ':' => (3, 0),
        '.' => (4, 0),
        '@' => (5, 0),
        '/' => (6, 0),
        '0'..='9' => (100 + u32::from(c) - u32::from('0'), 0),
        'a'..='z' => (200 + u32::from(c) - u32::from('a'), 0),
        'A'..='Z' => (200 + u32::from(c) - u32::from('A'), 1),
        other => (1000 + u32::from(other), 0),
    }
}

/// `a.localeCompare(b)` for secret names (what `list` sorts by): primary weights compared position by position (a prefix
/// first), then the case weights. The vector `fixtures/parity/secrets/name-order.json` pins it to the machine's ICU.
pub fn compare_names(a: &str, b: &str) -> Ordering {
    a.chars()
        .map(|c| collation_weights(c).0)
        .cmp(b.chars().map(|c| collation_weights(c).0))
        .then_with(|| {
            a.chars()
                .map(|c| collation_weights(c).1)
                .cmp(b.chars().map(|c| collation_weights(c).1))
        })
}

/// Names and values held by a backend, with the tombstones some of them keep.
pub trait SecretBackend {
    /// `kind`.
    fn kind(&self) -> BackendKind;

    /// Whether the backend can serve right now.
    fn probe(&mut self) -> Result<BackendProbe, SecretError>;

    /// The value, or `None` when the name is absent. Raises `corrupt`, `storage` or `backend-unavailable`.
    fn get(&mut self, name: &str) -> Result<Option<String>, SecretError>;

    /// Creates or replaces; keeps `createdAt` of an existing entry, and its description unless one is given (an empty one
    /// clears it). `register` is told the values this call has to mask (the replaced value).
    fn put(
        &mut self,
        name: &str,
        value: &str,
        now_ms: i64,
        updated_by: Option<&str>,
        description: Option<&str>,
        register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, SecretError>;

    /// Changes only metadata, validating inside the backend's serialized operation. Values never leave this call.
    fn describe(
        &mut self,
        name: &str,
        description: &str,
        now_ms: i64,
        updated_by: Option<&str>,
        register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, SecretError>;

    /// True when something was removed. A backend that keeps tombstones (the file backend) also records `tombstone_at_ms`
    /// for a name it removed.
    fn delete(&mut self, name: &str, tombstone_at_ms: Option<i64>) -> Result<bool, SecretError>;

    /// Names deleted while another backend could not be reached, with the time of the delete (ISO). `None` is "not
    /// supported": the backend keeps no tombstones (TypeScript: the optional method is absent).
    fn tombstones(&mut self) -> Option<Result<BTreeMap<String, String>, SecretError>> {
        None
    }

    /// Forgets one tombstone. `None` is "not supported" (the optional method is absent).
    fn clear_tombstone(&mut self, name: &str) -> Option<Result<(), SecretError>> {
        let _ = name;
        None
    }

    /// Names and metadata, sorted by [`compare_names`]; never decrypts.
    fn list(&mut self) -> Result<Vec<SecretMeta>, SecretError>;
}
