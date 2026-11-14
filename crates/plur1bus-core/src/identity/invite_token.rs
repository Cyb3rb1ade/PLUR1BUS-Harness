//! `identity/invite-token.ts`: shareable invitation links: a 256-bit one-time token, stored only as a hash, and the link around it.
use super::codes::RandomSource;
use super::{sha256_hex, utf8_of_units};
use crate::config::endpoint::Url;
use crate::logs::query::base64url_encode;

/// `INVITE_TTL_DEFAULT_MINUTES`.
pub const INVITE_TTL_DEFAULT_MINUTES: u32 = 60;
/// `INVITE_TTL_MAX_MINUTES`: 30 days.
pub const INVITE_TTL_MAX_MINUTES: u32 = 30 * 24 * 60;
/// `INVITE_CODE_MAX_MINUTES`: the pairing code that rides along keeps the identity service's own ceiling.
pub const INVITE_CODE_MAX_MINUTES: u32 = 60;

const TOKEN_BYTES: usize = 32;
const TOKEN_LEN: usize = 43;
const HASH_DOMAIN: &[u8] = b"plur1bus-invite-v1\0";

/// `mintInviteToken()`: 32 random bytes as unpadded base64url (43 characters).
pub fn mint_invite_token(rng: &mut dyn RandomSource) -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rng.fill_bytes(&mut bytes);
    base64url_encode(&bytes)
}

/// `isInviteTokenShape`: `/^[A-Za-z0-9_-]{43}$/` (no trailing line break passes).
pub fn is_invite_token_shape(raw: &str) -> bool {
    raw.len() == TOKEN_LEN
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `hashInviteToken`: unsalted SHA-256 over the domain string `plur1bus-invite-v1`, a NUL byte and the token.
pub fn hash_invite_token(token: &str) -> String {
    sha256_hex(&[HASH_DOMAIN, token.as_bytes()])
}

/// [`hash_invite_token`] over code units (a lone surrogate hashes as U+FFFD).
pub fn hash_invite_token_units(token: &[u16]) -> String {
    sha256_hex(&[HASH_DOMAIN, &utf8_of_units(token)])
}

/// `parseOrigin(raw)`: `scheme://host[:port]` only, in the one spelling `URL.origin` prints, or `None`.
///
/// The TypeScript accepts `raw` when `new URL(raw)` parses, the scheme is `http:` or `https:`, there is no userinfo, query,
/// fragment or path beyond `/`, and `u.origin` equals `raw` without one trailing slash. The last condition is what this port
/// builds on: it needs no path, query or fragment reader, only the parser of `config::endpoint::Url` (scheme, credentials, host
/// as `URL.hostname` prints it, port) and the comparison of its `origin()` with the input. A non-ASCII input can never equal
/// an origin (the host is Punycode), so it is refused before parsing, as is anything over 256 units.
///
/// Stricter than `URL` in one place: a host with a label that starts `xn--` is refused. `URL` accepts it when the label is
/// valid Punycode that passes UTS 46 validity, and checking that needs the IDNA tables this crate does not carry; the vectors
/// mark those cases as class `punycode`.
pub fn parse_origin(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len() > 256 || !raw.is_ascii() {
        return None;
    }
    let url = Url::parse(raw)?;
    if !url.is_http() || !url.username.is_empty() || !url.password.is_empty() {
        return None;
    }
    if url
        .hostname
        .split('.')
        .any(|label| label.starts_with("xn--"))
    {
        return None;
    }
    let origin = url.origin();
    let wanted = raw.strip_suffix('/').unwrap_or(raw);
    (origin == wanted).then_some(origin)
}

/// `inviteLink(origin, token)`: the token travels in the URL fragment, which a browser never sends to the server.
pub fn invite_link(origin: &str, token: &str) -> String {
    format!("{origin}/#/invite/{token}")
}
