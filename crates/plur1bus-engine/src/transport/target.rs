//! URL target validation and address classification for outbound policy.

use super::TransportError;
use crate::contract::{AddressRules, Scheme, Target};
use std::net::{IpAddr, Ipv4Addr};

pub(crate) fn parse_url(value: &str) -> Result<(url::Url, Target), TransportError> {
    let mut url = url::Url::parse(value).map_err(|_| TransportError::InvalidRequest)?;
    let scheme = match url.scheme() {
        "http" => Scheme::Http,
        "https" => Scheme::Https,
        _ => return Err(TransportError::InvalidRequest),
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err(TransportError::InvalidRequest);
    }
    let host = url
        .host_str()
        .ok_or(TransportError::InvalidRequest)?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    let port = url
        .port_or_known_default()
        .ok_or(TransportError::InvalidRequest)?;
    url.set_fragment(None);
    Ok((url, Target { scheme, host, port }))
}

/// Apply the independent loopback/private/metadata grants to a parsed address.
/// Unspecified, multicast, documentation and reserved ranges remain forbidden.
pub fn address_allowed(address: IpAddr, rules: AddressRules) -> bool {
    match address {
        IpAddr::V4(ip) => allowed_v4(ip, rules),
        IpAddr::V6(ip) => {
            let bytes = ip.octets();
            if let Some(ip) = ip.to_ipv4_mapped() {
                return allowed_v4(ip, rules);
            }
            if bytes[..12] == [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0] {
                return allowed_v4(
                    Ipv4Addr::new(bytes[12], bytes[13], bytes[14], bytes[15]),
                    rules,
                );
            }
            if bytes[..2] == [0x20, 2] {
                return allowed_v4(Ipv4Addr::new(bytes[2], bytes[3], bytes[4], bytes[5]), rules);
            }
            if ip.is_loopback() {
                return rules.allow_loopback;
            }
            if ip.segments() == [0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254] {
                return rules.allow_metadata;
            }
            if bytes[0] & 0xfe == 0xfc || (bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80) {
                return rules.allow_private;
            }
            let bits = u128::from(ip);
            // Mirror the web guard's IANA special-purpose ranges and global-unicast default deny.
            bytes[0] & 0xe0 == 0x20
                && bits >> (128 - 23)
                    != 0x2001_0000_0000_0000_0000_0000_0000_0000_u128 >> (128 - 23)
                && bits >> 96 != 0x2001_0db8
                && bits >> 108 != 0x3fff0
        }
    }
}

fn allowed_v4(ip: Ipv4Addr, rules: AddressRules) -> bool {
    let bytes = ip.octets();
    if matches!(
        bytes,
        [169, 254, 169, 254] | [169, 254, 170, 2] | [100, 100, 100, 200] | [168, 63, 129, 16]
    ) {
        return rules.allow_metadata;
    }
    if bytes[0] == 127 {
        return rules.allow_loopback;
    }
    if ip.is_private() || ip.is_link_local() {
        return rules.allow_private;
    }
    let bits = u32::from(ip);
    ![
        (0x0000_0000, 8),
        (0x6440_0000, 10),
        (0xc000_0000, 24),
        (0xc000_0200, 24),
        (0xc058_6300, 24),
        (0xc612_0000, 15),
        (0xc633_6400, 24),
        (0xcb00_7100, 24),
        (0xe000_0000, 4),
        (0xf000_0000, 4),
    ]
    .iter()
    .any(|(base, prefix)| bits >> (32 - prefix) == base >> (32 - prefix))
}
