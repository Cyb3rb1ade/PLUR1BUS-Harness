//! `parseCidr`, `inCidr` and `cidrContainsPublic` of `ip.ts` (spec §4.5).

use crate::classify::{mask, v4_nets, v6_nets};
use crate::parse::{canonical, parse_address};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// An address range: `addr` as written (host bits are kept; every function here ignores them) and the prefix length.
/// [`parse_cidr`] never produces a prefix above the family's width (32 or 128); a hand-built one above it is treated
/// as the full width, a host route.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cidr {
    pub addr: IpAddr,
    pub prefix: u8,
}

/// `addr` or `addr/prefix`, equal to `parseCidr` of `ip.ts`: the address part goes through [`parse_address`] in strict
/// mode (canonical dotted quad for IPv4), the prefix is one to three ASCII digits up to the family's width, and a bare
/// address is a host route. The address keeps its family as written (`::ffff:10.0.0.0/104` is an IPv6 range).
pub fn parse_cidr(input: &str) -> Option<Cidr> {
    let mut parts = input.split('/');
    let addr = parse_address(parts.next()?, true)?;
    let prefix_part = parts.next();
    if parts.next().is_some() {
        return None;
    }
    let width: u8 = if addr.is_ipv4() { 32 } else { 128 };
    let prefix = match prefix_part {
        None => width,
        Some(p) => {
            if p.is_empty() || p.len() > 3 || !p.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let n: u16 = p.parse().ok()?;
            if n > u16::from(width) {
                return None;
            }
            u8::try_from(n).ok()?
        }
    };
    Some(Cidr { addr, prefix })
}

/// Whether `a` lies in `c`, equal to `inCidr` of `ip.ts`: `a` is taken [`canonical`] first (an IPv4-mapped address
/// matches an IPv4 range), the range is not, and the families never cross (so an IPv4-mapped address does not match
/// `::ffff:0:0/96`, exactly as in `ip.ts`).
pub fn in_cidr(a: IpAddr, c: &Cidr) -> bool {
    match (canonical(a), c.addr) {
        (IpAddr::V4(x), IpAddr::V4(y)) => {
            let p = u32::from(c.prefix);
            mask(u128::from(u32::from(x)), 32, p) == mask(u128::from(u32::from(y)), 32, p)
        }
        (IpAddr::V6(x), IpAddr::V6(y)) => {
            let p = u32::from(c.prefix);
            mask(u128::from(x), 128, p) == mask(u128::from(y), 128, p)
        }
        _ => false,
    }
}

/// A prefix-aligned block: `base` has no host bits.
#[derive(Clone, Copy)]
struct Span {
    base: u128,
    prefix: u32,
}

impl Span {
    const fn v6(base: u128, prefix: u32) -> Span {
        Span { base, prefix }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Family {
    V4,
    V6,
}

/// Outside `2000::/3` nothing is public: `2000::/3` is `001` followed by anything, its complement is `000`, `01`, `1`.
const V6_NOT_GLOBAL: [Span; 3] = [
    Span::v6(0, 3),                                         // ::/3
    Span::v6(0x4000_0000_0000_0000_0000_0000_0000_0000, 2), // 4000::/2
    Span::v6(0x8000_0000_0000_0000_0000_0000_0000_0000, 1), // 8000::/1
];

/// The blocks whose verdict is the verdict of the IPv4 address carried in the 32 bits right after the prefix.
const V6_EMBEDDED: [Span; 3] = [
    Span::v6(0x0000_0000_0000_0000_0000_ffff_0000_0000, 96), // ::ffff:0:0/96, IPv4-mapped
    Span::v6(0x0064_ff9b_0000_0000_0000_0000_0000_0000, 96), // 64:ff9b::/96, NAT64
    Span::v6(0x2002_0000_0000_0000_0000_0000_0000_0000, 16), // 2002::/16, 6to4
];

/// `0xffff_ffff/32`, limited broadcast: non-public beside the IPv4 rows.
const V4_BROADCAST: Span = Span {
    base: 0xffff_ffff,
    prefix: 32,
};

impl Family {
    fn width(self) -> u32 {
        match self {
            Family::V4 => 32,
            Family::V6 => 128,
        }
    }

    /// Whether `pred` holds for any block in which every address is non-public. The blocks restate what `classify`
    /// refuses (the rows, 255.255.255.255, the complement of 2000::/3) and must mirror it; the oracle sweeps in
    /// `tests/oracle.rs` guard that.
    fn any_closed(self, pred: impl FnMut(Span) -> bool) -> bool {
        match self {
            Family::V4 => v4_nets()
                .map(|(b, p)| Span {
                    base: u128::from(b),
                    prefix: u32::from(p),
                })
                .chain(std::iter::once(V4_BROADCAST))
                .any(pred),
            Family::V6 => v6_nets()
                .map(|(b, p)| Span {
                    base: b,
                    prefix: u32::from(p),
                })
                .chain(V6_NOT_GLOBAL)
                .any(pred),
        }
    }

    fn embedded(self) -> &'static [Span] {
        match self {
            Family::V4 => &[],
            Family::V6 => &V6_EMBEDDED,
        }
    }

    fn covers(self, outer: Span, inner: Span) -> bool {
        outer.prefix <= inner.prefix && mask(inner.base, self.width(), outer.prefix) == outer.base
    }
}

/// `firstPublic` of `ip.ts`: the lowest public address of the range `base/prefix` (host bits ignored), or `None`.
/// The depth is bounded by the width: each step either answers or halves the range.
fn first_public(f: Family, base: u128, prefix: u32) -> Option<u128> {
    let width = f.width();
    let prefix = prefix.min(width);
    let range = Span {
        base: mask(base, width, prefix),
        prefix,
    };
    // Inside an embedded-IPv4 block: the answer is the IPv4 answer for the carried range, put back in place.
    if let Some(e) = f.embedded().iter().find(|e| f.covers(**e, range)) {
        let shift = width - e.prefix - 32;
        let carried_prefix = (prefix - e.prefix).min(32);
        let carried = mask((range.base >> shift) & 0xffff_ffff, 32, carried_prefix);
        let found = first_public(Family::V4, carried, carried_prefix)?;
        return Some((range.base & !(0xffff_ffff_u128 << shift)) | (found << shift));
    }
    let holds_embedded = f.embedded().iter().any(|e| f.covers(range, *e));
    if !holds_embedded {
        if f.any_closed(|c| f.covers(c, range)) {
            return None; // wholly inside a non-public block
        }
        if !f.any_closed(|c| f.covers(range, c)) {
            return Some(range.base); // touches no block at all
        }
    }
    // The range holds some block(s) and more: the lowest public address is in the lower half or in the upper one.
    if prefix >= width {
        return None; // unreachable: a single address is inside a block or touches none
    }
    first_public(f, range.base, prefix + 1)
        .or_else(|| first_public(f, range.base | (1u128 << (width - prefix - 1)), prefix + 1))
}

/// The lowest public address of the range, or `None` when it has none; equal to `cidrContainsPublic` of `ip.ts`
/// (spec §4.5). The range's host bits are ignored (`172.16.0.0/11` is `172.0.0.0/11`). The result has the family of
/// the range; for a range inside an IPv4-mapped, NAT64 or 6to4 block it is the IPv6 address that carries the lowest
/// public IPv4 address (`64:ff9b::/96` gives `64:ff9b::100:0`, `::/0` gives `::ffff:100:0`).
pub fn cidr_first_public(c: &Cidr) -> Option<IpAddr> {
    let prefix = u32::from(c.prefix);
    match c.addr {
        IpAddr::V4(a) => first_public(Family::V4, u128::from(u32::from(a)), prefix)
            .and_then(|n| u32::try_from(n).ok())
            .map(|n| IpAddr::V4(Ipv4Addr::from(n))),
        IpAddr::V6(a) => {
            first_public(Family::V6, u128::from(a), prefix).map(|n| IpAddr::V6(Ipv6Addr::from(n)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        parse_address(s, false).unwrap_or_else(|| panic!("{s}"))
    }

    fn cidr(s: &str) -> Cidr {
        parse_cidr(s).unwrap_or_else(|| panic!("{s}"))
    }

    // Ported from packages/core/test/tools/web/ip.test.ts ("ip: CIDR allowlist matching"); these cases are not in the
    // vector file.
    #[test]
    fn in_cidr_matches_v4_and_v6_and_never_crosses_families() {
        let c4 = cidr("127.0.0.0/8");
        let c6 = cidr("fd00::/8");
        assert!(in_cidr(ip("127.9.9.9"), &c4));
        assert!(!in_cidr(ip("128.0.0.1"), &c4));
        assert!(in_cidr(ip("fd12::1"), &c6));
        assert!(!in_cidr(ip("fe00::1"), &c6));
        assert!(!in_cidr(ip("::1"), &c4));
    }

    #[test]
    fn a_bare_address_is_a_host_route_and_junk_is_refused() {
        assert_eq!(cidr("100.64.1.2").prefix, 32);
        assert_eq!(cidr("::1").prefix, 128);
        assert!(!in_cidr(ip("100.64.1.3"), &cidr("100.64.1.2")));
        assert!(in_cidr(ip("100.64.1.2"), &cidr("100.64.1.2")));
        for bad in [
            "10.0.0.0/33",
            "10.0.0.0/-1",
            "nope/8",
            "::/129",
            "10.0.0.0/8/8",
        ] {
            assert_eq!(parse_cidr(bad), None, "{bad}");
        }
    }

    #[test]
    fn parse_cidr_follows_parse_cidr_of_ip_ts() {
        for bad in [
            "",
            "/8",
            "10.0.0.0/",
            "10.0.0.0/0008",
            "10.0.0.0/+8",
            "10.0.0.0/ 8",
            "10.0.0.0/8 ",
            "10.0.0.0/１",
            "10.0.0.0/256",
            "127.1/8",
            "0x7f000001/8",
            "10.1/8",
            "::ffff:127.00.0.1/104",
            "fe80::1%eth0/64",
        ] {
            assert_eq!(parse_cidr(bad), None, "{bad:?}");
        }
        assert_eq!(
            cidr("10.0.0.0/008").prefix,
            8,
            "up to three digits, leading zeros allowed"
        );
        assert_eq!(cidr("10.0.0.0/0").prefix, 0);
        assert_eq!(cidr("::/128").prefix, 128);
        // The address part is trimmed and unbracketed like any address; the prefix is not.
        assert_eq!(cidr(" 10.0.0.0/8"), cidr("10.0.0.0/8"));
        assert_eq!(cidr("[2001:db8::]/32"), cidr("2001:db8::/32"));
        // Host bits and the written family are kept.
        assert_eq!(cidr("10.1.2.3/8").addr, ip("10.1.2.3"));
        assert!(cidr("::ffff:10.0.0.0/104").addr.is_ipv6());
    }

    #[test]
    fn in_cidr_takes_the_address_canonical_but_not_the_range() {
        assert!(in_cidr(ip("::ffff:10.1.2.3"), &cidr("10.0.0.0/8")));
        assert!(
            !in_cidr(ip("::ffff:10.1.2.3"), &cidr("::ffff:0:0/96")),
            "as in ip.ts: mapped is IPv4 here"
        );
        assert!(in_cidr(ip("8.8.8.8"), &cidr("0.0.0.0/0")));
        assert!(!in_cidr(ip("::1"), &cidr("0.0.0.0/0")));
        assert!(in_cidr(ip("::1"), &cidr("::/0")));
        assert!(
            in_cidr(ip("10.255.255.255"), &cidr("10.9.9.9/8")),
            "the range's host bits are ignored"
        );
    }

    #[test]
    fn an_oversized_hand_built_prefix_is_a_host_route() {
        let c = Cidr {
            addr: ip("8.8.8.8"),
            prefix: 200,
        };
        assert!(in_cidr(ip("8.8.8.8"), &c));
        assert!(!in_cidr(ip("8.8.8.9"), &c));
        assert_eq!(cidr_first_public(&c), Some(ip("8.8.8.8")));
        let c = Cidr {
            addr: ip("10.0.0.1"),
            prefix: 33,
        };
        assert_eq!(cidr_first_public(&c), None);
        let c = Cidr {
            addr: ip("2606:4700::1"),
            prefix: 255,
        };
        assert_eq!(cidr_first_public(&c), Some(ip("2606:4700::1")));
        assert!(in_cidr(ip("2606:4700::1"), &c));
    }
}
