//! The host field of a remote connection or an SSH host (spec §4.4).

use super::TransportError;
use crate::connections::Origin;
use plur1bus_desktop_net::parse_address;
use std::net::IpAddr;

/// A validated host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostInput {
    /// A DNS name in its ASCII (punycode) form, lower case, as the `url` crate's IDNA mapping writes it; a trailing
    /// dot the person typed is kept, so the name stays the one TLS and the resolver see.
    Name(String),
    /// A canonical IPv4 dotted quad or an IPv6 literal (no zone id), as written.
    Ip(IpAddr),
    /// `localhost`: loopback without a DNS query (RFC 6761).
    Localhost,
}

/// Longest input looked at before IDNA mapping; anything longer cannot become a valid name.
const MAX_INPUT: usize = 1024;
/// RFC 1035 limits for the name without its optional trailing dot.
const MAX_NAME: usize = 253;
const MAX_LABEL: usize = 63;

impl HostInput {
    /// Validates host input (spec §4.4): a DNS name (IDNA → punycode, LDH labels of 1–63 bytes, at most 253 bytes,
    /// one optional trailing dot), a canonical dotted-quad IPv4, an IPv6 literal with or without brackets and without
    /// a zone id, or `localhost`.
    ///
    /// An IPv4 address in a legacy `inet_aton` spelling (or one the IDNA mapping turns into an address, such as
    /// full-width digits or `1.2.3.4.`) is refused with [`TransportError::NonCanonicalIpv4`]: the OS resolver would
    /// turn it into an address the person did not write. Every other invalid string is refused with
    /// [`TransportError::HostInvalid`]: empty or over 1024 bytes; white space, control characters, U+FEFF or `%` (zone
    /// ids, percent-encoding); a `[`-prefixed or `:`-containing string that is not a strict IPv6 literal (`host:22`,
    /// `[::1]:22`, `[192.168.1.1]`); a URL host error; a name that fails the LDH rules after IDNA. A canonical
    /// unspecified, multicast or broadcast literal is valid syntax; [`super::check_target`] refuses it.
    pub fn parse(input: &str) -> Result<Self, TransportError> {
        const INVALID: TransportError = TransportError::HostInvalid;
        // White space, control characters and `%` (a zone id, or percent-encoding the URL host parser would decode)
        // are refused before any parser sees the string; `parse_address` alone would trim white space.
        if input.is_empty()
            || input.len() > MAX_INPUT
            || input
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || c == '%' || c == '\u{FEFF}')
        {
            return Err(INVALID);
        }
        if input.starts_with('[') || input.contains(':') {
            return match parse_address(input, true) {
                Some(ip @ IpAddr::V6(_)) => Ok(Self::Ip(ip)),
                _ => Err(INVALID),
            };
        }
        if let Some(ip) = parse_address(input, true) {
            return Ok(Self::Ip(ip));
        }
        if parse_address(input, false).is_some() {
            return Err(TransportError::NonCanonicalIpv4);
        }
        match url::Host::parse(input) {
            Ok(url::Host::Domain(name)) => {
                let bare = name.strip_suffix('.').unwrap_or(&name);
                if bare == "localhost" {
                    return Ok(Self::Localhost);
                }
                if is_ldh_name(bare) {
                    Ok(Self::Name(name))
                } else {
                    Err(INVALID)
                }
            }
            // The URL parser reads the last label as a number and found an IPv4 spelling the strict and the legacy
            // parsers did not (`1.2.3.4.`): not the canonical form either.
            Ok(url::Host::Ipv4(_)) => Err(TransportError::NonCanonicalIpv4),
            Ok(url::Host::Ipv6(_)) | Err(_) => Err(INVALID),
        }
    }

    /// The host and effective port of an origin, with the same §4.4 checks as [`HostInput::parse`] applied to the
    /// host the URL parser normalised. `Origin::parse` admits names spec §4.4 does not (`_`, a label over 63 bytes, a
    /// name over 253 bytes); such a stored origin is refused with [`TransportError::HostInvalid`].
    pub fn from_origin(origin: &Origin) -> Result<(Self, u16), TransportError> {
        let url = url::Url::parse(origin.as_str()).map_err(|_| TransportError::HostInvalid)?;
        let host = Self::parse(url.host_str().ok_or(TransportError::HostInvalid)?)?;
        let port = url
            .port_or_known_default()
            .ok_or(TransportError::HostInvalid)?;
        Ok((host, port))
    }

    /// The host as a pin names it: exactly the host string the `url` crate writes for this host in an origin
    /// (without brackets), which is what the client compares and overrides. For an IPv4-mapped IPv6 literal that is
    /// `::ffff:102:304`, not Rust's `::ffff:1.2.3.4`.
    pub fn pin_host(&self) -> String {
        match self {
            Self::Name(name) => name.clone(),
            Self::Ip(IpAddr::V4(ip)) => url::Host::<String>::Ipv4(*ip).to_string(),
            Self::Ip(IpAddr::V6(ip)) => url::Host::<String>::Ipv6(*ip)
                .to_string()
                .trim_matches(['[', ']'])
                .to_owned(),
            Self::Localhost => "localhost".to_owned(),
        }
    }

    /// Whether this is a `*.ts.net` name (case-insensitive, trailing dot allowed; spec §5.1).
    pub fn is_ts_net(&self) -> bool {
        match self {
            Self::Name(name) => {
                let bare = name.strip_suffix('.').unwrap_or(name).to_ascii_lowercase();
                bare.len() > ".ts.net".len() && bare.ends_with(".ts.net")
            }
            Self::Ip(_) | Self::Localhost => false,
        }
    }
}

/// The host as clients use it: the ASCII name, the address without brackets, or `localhost`.
impl std::fmt::Display for HostInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Name(name) => f.write_str(name),
            Self::Ip(ip) => write!(f, "{ip}"),
            Self::Localhost => f.write_str("localhost"),
        }
    }
}

/// LDH labels (letters, digits, hyphen; no hyphen at either end) of 1–63 bytes, at most 253 bytes in all.
fn is_ldh_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME
        && name.split('.').all(|label| {
            let b = label.as_bytes();
            !b.is_empty()
                && b.len() <= MAX_LABEL
                && b.iter()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
                && b.first() != Some(&b'-')
                && b.last() != Some(&b'-')
        })
}
