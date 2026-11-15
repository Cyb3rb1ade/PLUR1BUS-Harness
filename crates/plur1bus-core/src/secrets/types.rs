//! `secrets/types.ts`: what a secret's name, value and description may be, the constants, and the plain types the backends
//! and the store share. Nothing here ever holds a value longer than the call that was given it.
//!
//! JavaScript semantics, exactly: the name patterns are hand-coded over UTF-16 code units; the value limit is counted in
//! UTF-8 bytes as `Buffer.byteLength` counts them (a lone surrogate is three bytes, as U+FFFD); "at least eight" characters
//! are UTF-16 code units (`String.length`); the description limit and the eight-character fragment window are code points
//! (`[...text]`, a lone surrogate counts as one); `trim` is [`crate::js::trim_units`]. A string that may not be well-formed
//! UTF-16 has a `*_units` form over `&[u16]`; the `&str` forms wrap it.
use super::error::SecretError;
use crate::js::{trim_units, utf16};
use crate::rbac::surface::SurfaceTrustLevel;
use serde_json::{json, Map, Value};

/// `MAX_VALUE_BYTES`: a value is at most 64 KiB of UTF-8.
pub const MAX_VALUE_BYTES: usize = 64 * 1024;

/// `MIN_SECRET_SURFACE`: what a connection must have to write, delete or reveal a secret over RPC (T1, the token-authenticated
/// local connection).
pub const MIN_SECRET_SURFACE: SurfaceTrustLevel = SurfaceTrustLevel::T1;

/// `MAX_DESCRIPTION_CHARS`: at most this many code points of free text per secret.
pub const MAX_DESCRIPTION_CHARS: usize = 200;

/// `MIN_REDACTED_VALUE_CHARS`: the shortest value (in UTF-16 code units) the log redactor masks.
pub const MIN_REDACTED_VALUE_CHARS: usize = 8;

/// `MIN_DESCRIPTION_VALUE_CHARS`: a value shorter than this is not looked for in a description, and a fragment is this many
/// code points long.
pub const MIN_DESCRIPTION_VALUE_CHARS: usize = 8;

const NAME_MAX_UNITS: usize = 128;
const SLOT_PART_MAX_UNITS: usize = 64;

fn is_digit(u: u16) -> bool {
    (0x30..=0x39).contains(&u)
}

fn is_lower(u: u16) -> bool {
    (0x61..=0x7a).contains(&u)
}

fn is_upper(u: u16) -> bool {
    (0x41..=0x5a).contains(&u)
}

fn is_unit_of(u: u16, set: &[u8]) -> bool {
    u8::try_from(u).is_ok_and(|b| set.contains(&b))
}

/// `/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/`. (`$` without the `m` flag matches only at the end, so a trailing newline fails.)
fn is_generic_name(units: &[u16]) -> bool {
    let Some((&first, rest)) = units.split_first() else {
        return false;
    };
    units.len() <= NAME_MAX_UNITS
        && (is_digit(first) || is_lower(first) || is_upper(first))
        && rest
            .iter()
            .all(|&u| is_digit(u) || is_lower(u) || is_upper(u) || is_unit_of(u, b"._:/@-"))
}

/// `/^ext:[a-z0-9][a-z0-9._-]{0,63}:[A-Za-z][A-Za-z0-9_]{0,63}$/`: a canonical M-A7 extension slot.
fn is_extension_slot(units: &[u16]) -> bool {
    let Some(rest) = units.strip_prefix(&[0x65, 0x78, 0x74, 0x3a]) else {
        return false;
    };
    let Some(colon) = rest.iter().position(|&u| u == 0x3a) else {
        return false;
    };
    let (segment, slot) = (&rest[..colon], &rest[colon + 1..]);
    let (Some((&seg_first, seg_rest)), Some((&slot_first, slot_rest))) =
        (segment.split_first(), slot.split_first())
    else {
        return false;
    };
    segment.len() <= SLOT_PART_MAX_UNITS
        && slot.len() <= SLOT_PART_MAX_UNITS
        && (is_lower(seg_first) || is_digit(seg_first))
        && seg_rest
            .iter()
            .all(|&u| is_lower(u) || is_digit(u) || is_unit_of(u, b"._-"))
        && (is_lower(slot_first) || is_upper(slot_first))
        && slot_rest
            .iter()
            .all(|&u| is_lower(u) || is_upper(u) || is_digit(u) || u == 0x5f)
}

/// `isSecretName` over code units: a generic name (at most 128 characters) or a canonical extension slot.
pub fn is_secret_name_units(name: &[u16]) -> bool {
    is_generic_name(name) || is_extension_slot(name)
}

/// [`is_secret_name_units`] of a Rust string.
pub fn is_secret_name(name: &str) -> bool {
    is_secret_name_units(&utf16(name))
}

/// `checkName` over code units: the name itself, or `invalid-name`.
pub fn check_name_units(name: &[u16]) -> Result<String, SecretError> {
    if is_secret_name_units(name) {
        Ok(String::from_utf16_lossy(name))
    } else {
        Err(SecretError::invalid_name())
    }
}

/// [`check_name_units`] of a Rust string.
pub fn check_name(name: &str) -> Result<String, SecretError> {
    check_name_units(&utf16(name))
}

/// `Buffer.byteLength(text, "utf8")` of a string given as code units: a pair is four bytes, a lone surrogate three (U+FFFD).
pub fn utf8_len_units(units: &[u16]) -> usize {
    let mut bytes = 0;
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        bytes += match u {
            0..=0x7f => 1,
            0x80..=0x7ff => 2,
            0xd800..=0xdbff
                if units
                    .get(i + 1)
                    .is_some_and(|l| (0xdc00..=0xdfff).contains(l)) =>
            {
                i += 1;
                4
            }
            _ => 3,
        };
        i += 1;
    }
    bytes
}

/// `checkValue` over code units: a non-empty string without NUL of at most [`MAX_VALUE_BYTES`] UTF-8 bytes. The value itself
/// is the caller's; nothing is copied.
pub fn check_value_units(value: &[u16]) -> Result<(), SecretError> {
    if value.is_empty() {
        return Err(SecretError::value_not_text());
    }
    if value.contains(&0) {
        return Err(SecretError::value_has_nul());
    }
    if utf8_len_units(value) > MAX_VALUE_BYTES {
        return Err(SecretError::value_too_large());
    }
    Ok(())
}

/// [`check_value_units`] of a Rust string.
pub fn check_value(value: &str) -> Result<(), SecretError> {
    check_value_units(&utf16(value))
}

/// What `secret.set` returns beside the metadata when the value is too short for the redactor to mask (never the value).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretWarning {
    /// Always `short-value-unmasked`.
    pub code: &'static str,
    /// [`MIN_REDACTED_VALUE_CHARS`].
    pub min_masked_chars: usize,
    /// The fixed text.
    pub message: String,
}

impl SecretWarning {
    /// `{ code, minMaskedChars, message }`.
    pub fn to_json(&self) -> Value {
        json!({ "code": self.code, "minMaskedChars": self.min_masked_chars, "message": self.message })
    }
}

/// `shortValueWarning` over code units: `value.length < 8` (UTF-16 code units).
pub fn short_value_warning_units(value: &[u16]) -> Option<SecretWarning> {
    if value.len() >= MIN_REDACTED_VALUE_CHARS {
        return None;
    }
    Some(SecretWarning {
        code: "short-value-unmasked",
        min_masked_chars: MIN_REDACTED_VALUE_CHARS,
        message: format!("The value has fewer than {MIN_REDACTED_VALUE_CHARS} characters: it was stored, but the log redactor does not mask values this short, so it could appear in a log line."),
    })
}

/// [`short_value_warning_units`] of a Rust string.
pub fn short_value_warning(value: &str) -> Option<SecretWarning> {
    short_value_warning_units(&utf16(value))
}

/// `[\u0000-\u001f\u007f-\u009f  ]` (a regexp without `u`: one code unit at a time).
fn is_control_unit(u: u16) -> bool {
    matches!(u, 0..=0x1f | 0x7f..=0x9f | 0x2028 | 0x2029)
}

/// `haystack.includes(needle)` over code units.
fn includes_units(haystack: &[u16], needle: &[u16]) -> bool {
    needle.is_empty() || haystack.windows(needle.len()).any(|w| w == needle)
}

/// Where each code point of `units` starts (`[...text]`: a pair is one, a lone surrogate is one), and the end.
fn code_point_bounds(units: &[u16]) -> Vec<usize> {
    let mut bounds = Vec::with_capacity(units.len() + 1);
    let mut i = 0;
    while i < units.len() {
        bounds.push(i);
        let pair = (0xd800..=0xdbff).contains(&units[i])
            && units
                .get(i + 1)
                .is_some_and(|l| (0xdc00..=0xdfff).contains(l));
        i += if pair { 2 } else { 1 };
    }
    bounds.push(units.len());
    bounds
}

/// `checkDescription` over code units. `None` (`undefined`) means "not given" and stays `None`; otherwise the trimmed text.
/// `value` is the secret being written: the text may not contain it (when it has eight or more code units) nor any
/// contiguous fragment of eight or more code points of it.
pub fn check_description_units(
    description: Option<&[u16]>,
    value: Option<&[u16]>,
) -> Result<Option<Vec<u16>>, SecretError> {
    let Some(description) = description else {
        return Ok(None);
    };
    let text = trim_units(description);
    let bounds = code_point_bounds(text);
    let points = bounds.len() - 1;
    if points > MAX_DESCRIPTION_CHARS {
        return Err(SecretError::description_too_long());
    }
    if text.iter().any(|&u| is_control_unit(u)) {
        return Err(SecretError::description_not_plain());
    }
    if let Some(value) = value {
        if value.len() >= MIN_DESCRIPTION_VALUE_CHARS && includes_units(text, value) {
            return Err(SecretError::description_has_value());
        }
        if points >= MIN_DESCRIPTION_VALUE_CHARS {
            for i in 0..=(points - MIN_DESCRIPTION_VALUE_CHARS) {
                let fragment = &text[bounds[i]..bounds[i + MIN_DESCRIPTION_VALUE_CHARS]];
                if includes_units(value, fragment) {
                    return Err(SecretError::description_has_fragment());
                }
            }
        }
    }
    Ok(Some(text.to_vec()))
}

/// [`check_description_units`] of Rust strings (the text of a `&str` is well-formed, so is the result).
pub fn check_description(
    description: Option<&str>,
    value: Option<&str>,
) -> Result<Option<String>, SecretError> {
    let description = description.map(utf16);
    let value = value.map(utf16);
    Ok(
        check_description_units(description.as_deref(), value.as_deref())?
            .map(|text| String::from_utf16_lossy(&text)),
    )
}

/// `nextDescription`: what a backend stores after a write: `given` replaces, `None` keeps `old`, an empty string removes it.
pub fn next_description(old: Option<&str>, given: Option<&str>) -> Option<String> {
    match given {
        None => old.map(str::to_owned),
        Some("") => None,
        Some(text) => Some(text.to_owned()),
    }
}

/// The kinds of backend (`BackendKind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendKind {
    /// `keyring`
    Keyring,
    /// `file`
    File,
    /// `memory`
    Memory,
}

impl BackendKind {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            BackendKind::Keyring => "keyring",
            BackendKind::File => "file",
            BackendKind::Memory => "memory",
        }
    }
}

/// `SecretMeta`: names and metadata; never a value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretMeta {
    /// The secret's name.
    pub name: String,
    /// The backend that holds it.
    pub backend: BackendKind,
    /// ISO time of the first write.
    pub created_at: String,
    /// ISO time of the last write.
    pub updated_at: String,
    /// Who wrote last, when known.
    pub updated_by: Option<String>,
    /// What the secret is for, in the owner's words (at most 200 code points); never a value.
    pub description: Option<String>,
}

impl SecretMeta {
    /// The JSON object of the TypeScript (`updatedBy` and `description` only when present).
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("name".into(), json!(self.name));
        out.insert("backend".into(), json!(self.backend.as_str()));
        out.insert("createdAt".into(), json!(self.created_at));
        out.insert("updatedAt".into(), json!(self.updated_at));
        if let Some(by) = &self.updated_by {
            out.insert("updatedBy".into(), json!(by));
        }
        if let Some(text) = &self.description {
            out.insert("description".into(), json!(text));
        }
        Value::Object(out)
    }
}

/// Who is asking (`SecretPrincipal`). The RPC layer derives it from the connection; `Core` is the in-process engine lease
/// path; `Agent` is any agent-side caller. (A principal of an unknown kind, which TypeScript files as `unknown`, cannot
/// be built in Rust.)
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SecretPrincipal {
    /// A person. `surface` is the trust level of the connection; an owner without one is an in-process caller and passes
    /// the surface floor. Whoever builds a principal for a connection (the RPC layer, with the flip) therefore always gives
    /// the level, and refuses a connection whose level it cannot tell rather than leaving it out.
    Owner {
        /// The owner's id, when the connection has one.
        id: Option<String>,
        /// The trust level of the connection the owner came in on.
        surface: Option<SurfaceTrustLevel>,
    },
    /// The core itself.
    Core,
    /// An agent-side caller.
    Agent {
        /// The agent's id, when known.
        agent_id: Option<String>,
    },
}

/// A backend's answer to "can you serve right now" (`BackendProbe`); `reason` is a short code, never a platform message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackendProbe {
    /// Whether the backend can serve.
    pub available: bool,
    /// A short code when it cannot.
    pub reason: Option<String>,
}

/// What `backendFailure` is given: a `SecretError` passes through, anything else is reduced to its `code` property.
#[derive(Clone, Debug)]
pub enum BackendCause {
    /// A `SecretError` the backend raised itself.
    Secret(SecretError),
    /// Anything else: the `code` property when it is a string (`ENOENT`), else `None` (`"error"` is used).
    Other {
        /// The string `code` of the thrown value.
        code: Option<String>,
    },
}

/// `backendFailure(err, what)`: reduces anything a backend or the OS threw to a code; platform messages are not forwarded.
pub fn backend_failure(cause: BackendCause, what: &str) -> SecretError {
    match cause {
        BackendCause::Secret(e) => e,
        BackendCause::Other { code } => {
            SecretError::storage_failed(what, code.as_deref().unwrap_or("error"))
        }
    }
}
