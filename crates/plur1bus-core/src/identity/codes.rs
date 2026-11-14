//! `identity/codes.ts`: the pairing-code alphabet, `normalizeCode`, the salted hash, the constant-time compare and UUIDv7.
//! Randomness is a parameter (R6): [`RandomSource`] is what `node:crypto`'s `randomInt` and `randomBytes` are to the TypeScript.
use super::error::IdentityError;
use super::{hex, sha256_hex, utf8_of_units};
use crate::js::{is_js_space, utf16};

/// The 32 symbols without 0, O, 1 and I.
pub const CODE_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// A code is eight symbols long.
pub const CODE_LENGTH: usize = 8;

/// The random source the ported code draws from. The default implementation lives at the edge (the CSPRNG); the vectors feed
/// the values the TypeScript functions were driven with.
pub trait RandomSource {
    /// `crypto.randomInt(max)`: uniform in `[0, max)`. [`random_int_from_draws`] is Node's algorithm for a real source.
    fn random_int(&mut self, max: u32) -> u32;
    /// `crypto.randomBytes(out.len())`.
    fn fill_bytes(&mut self, out: &mut [u8]);
}

/// A fresh code: eight symbols, each `random_int(32)` indexing [`CODE_ALPHABET`].
pub fn generate_code(rng: &mut dyn RandomSource) -> String {
    let alphabet = CODE_ALPHABET.as_bytes();
    (0..CODE_LENGTH)
        .map(|_| {
            let i = rng.random_int(alphabet.len() as u32) as usize;
            char::from(alphabet[i % alphabet.len()])
        })
        .collect()
}

/// `raw.toUpperCase().replace(/[\s-]/g, "")` over code units. Upper-casing is the full Unicode mapping without locale (`ß`
/// becomes `SS`, `ı` becomes `I`, `ſ` becomes `S`); `\s` is [`is_js_space`]; a lone surrogate stays as it is.
pub fn normalize_code_units(raw: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(raw.len());
    let mut buf = [0u16; 2];
    for decoded in char::decode_utf16(raw.iter().copied()) {
        match decoded {
            Ok(c) => {
                for upper in c.to_uppercase() {
                    if !is_js_space(upper) && upper != '-' {
                        out.extend_from_slice(upper.encode_utf16(&mut buf));
                    }
                }
            }
            Err(e) => out.push(e.unpaired_surrogate()),
        }
    }
    out
}

/// [`normalize_code_units`] of a Rust string.
pub fn normalize_code(raw: &str) -> String {
    String::from_utf16_lossy(&normalize_code_units(&utf16(raw)))
}

/// `newSalt()`: 16 random bytes as 32 lower-case hex characters.
pub fn new_salt(rng: &mut dyn RandomSource) -> String {
    let mut bytes = [0u8; 16];
    rng.fill_bytes(&mut bytes);
    hex(&bytes)
}

/// `hashCode(salt, code)` over code units: SHA-256 of the UTF-8 of the salt, a NUL byte and the UTF-8 of the code, as hex.
pub fn hash_code_units(salt: &[u16], code: &[u16]) -> String {
    sha256_hex(&[&utf8_of_units(salt), &[0u8], &utf8_of_units(code)])
}

/// [`hash_code_units`] of Rust strings.
pub fn hash_code(salt: &str, code: &str) -> String {
    hash_code_units(&utf16(salt), &utf16(code))
}

/// `Buffer.from(text, "hex")`: pairs of hex digits; reading stops at the first pair that is not two hex digits, and an odd
/// trailing digit is dropped.
fn hex_decode_lenient(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 2);
    let mut chars = text.chars();
    while let (Some(a), Some(b)) = (chars.next(), chars.next()) {
        match (a.to_digit(16), b.to_digit(16)) {
            (Some(hi), Some(lo)) => out.push((hi * 16 + lo) as u8),
            _ => break,
        }
    }
    out
}

/// `hashesEqual(a, b)`: both decoded as hex (leniently, as Node does, so `"zz"` and `"yy"` are both empty and equal), equal
/// length and a comparison that does not stop at the first difference (`timingSafeEqual`).
pub fn hashes_equal(a: &str, b: &str) -> bool {
    let x = hex_decode_lenient(a);
    let y = hex_decode_lenient(b);
    x.len() == y.len() && {
        let diff = x.iter().zip(&y).fold(0u8, |acc, (p, q)| acc | (p ^ q));
        std::hint::black_box(diff) == 0
    }
}

/// `Buffer#writeUIntBE` refused the value (`ERR_OUT_OF_RANGE`): `uuidv7`'s only failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RangeError;

impl std::fmt::Display for RangeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the timestamp is out of range for 48 bits")
    }
}

impl std::error::Error for RangeError {}

impl From<RangeError> for IdentityError {
    fn from(e: RangeError) -> IdentityError {
        IdentityError::new(
            super::error::IdentityErrorCode::InvalidParams,
            e.to_string(),
        )
    }
}

/// The largest millisecond timestamp 48 bits hold.
const MAX_48_BITS: f64 = 281_474_976_710_655.0;

/// `uuidv7(nowMs)`: 16 random bytes, the first six replaced by the 48-bit big-endian timestamp, version 7 and variant `10`.
/// `writeUIntBE` throws for a value above 2^48-1 or below 0 (also for infinities), drops a fraction and writes zeros for NaN.
pub fn uuidv7(now_ms: f64, rng: &mut dyn RandomSource) -> Result<String, RangeError> {
    let mut b = [0u8; 16];
    rng.fill_bytes(&mut b);
    // Not `!(0.0..=MAX).contains(..)`: NaN passes here, as it passes `checkInt`'s two comparisons.
    #[allow(clippy::manual_range_contains)]
    let out_of_range = now_ms > MAX_48_BITS || now_ms < 0.0;
    if out_of_range {
        return Err(RangeError);
    }
    // NaN compares false above and truncates to 0 here, as the zeros `writeUIntBE` stores for it.
    let t = if now_ms.is_nan() {
        0
    } else {
        now_ms.trunc() as u64
    };
    let t = t.to_be_bytes();
    b[..6].copy_from_slice(&t[2..]);
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}

/// Node's `RAND_MAX` for `crypto.randomInt`: 2^48 - 1.
const RAND_MAX: u64 = 0xFFFF_FFFF_FFFF;

/// `crypto.randomInt(max)` over a stream of 48-bit draws (six bytes read big-endian): a draw is accepted when it is below
/// `RAND_MAX - (RAND_MAX % max)`, otherwise it is dropped and the next one is read (the rejection that keeps `x % max`
/// unbiased). `max` must be in `1..=RAND_MAX`; `0` returns `0`. For a power of two such as 32 only the 31 draws above
/// `2^48 - 32` are rejected.
pub fn random_int_from_draws(max: u64, mut draw: impl FnMut() -> u64) -> u64 {
    if max == 0 {
        return 0;
    }
    let limit = RAND_MAX - (RAND_MAX % max);
    loop {
        let x = draw();
        if x < limit {
            return x % max;
        }
    }
}

/// The 48-bit value `randomCache.readUIntBE(offset, 6)` reads from six bytes.
pub fn draw48(bytes: &[u8; 6]) -> u64 {
    bytes.iter().fold(0u64, |acc, b| (acc << 8) | u64::from(*b))
}
