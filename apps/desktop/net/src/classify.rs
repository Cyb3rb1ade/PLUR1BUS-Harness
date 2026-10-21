//! `classifyAddress` and `classificationTable` of `ip.ts` (spec §4.2).

use crate::parse::canonical;
use std::net::IpAddr;

/// Why an address is not public: the stable short names of `ip.ts` ([`Reason::as_str`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Unspecified,
    Private,
    SharedAddressSpace,
    Loopback,
    LinkLocal,
    CloudMetadata,
    Reserved,
    Multicast,
}

impl Reason {
    /// The name `ip.ts` and the vector file use.
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Unspecified => "unspecified",
            Reason::Private => "private",
            Reason::SharedAddressSpace => "shared-address-space",
            Reason::Loopback => "loopback",
            Reason::LinkLocal => "link-local",
            Reason::CloudMetadata => "cloud-metadata",
            Reason::Reserved => "reserved",
            Reason::Multicast => "multicast",
        }
    }
}

/// The verdict on one address: public only when positively known to be (default deny). `reason` is `Some` exactly
/// when `public` is false.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub public: bool,
    pub reason: Option<Reason>,
}

const PUBLIC: Verdict = Verdict {
    public: true,
    reason: None,
};

const fn refused(reason: Reason) -> Verdict {
    Verdict {
        public: false,
        reason: Some(reason),
    }
}

/// One registered range as a number: the network address and the prefix length.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Net {
    V4(u32, u8),
    V6(u128, u8),
}

struct Row {
    cidr: &'static str,
    net: Net,
    reason: Reason,
}

const fn row(cidr: &'static str, net: Net, reason: Reason) -> Row {
    Row { cidr, net, reason }
}

use Net::{V4, V6};
use Reason::{
    CloudMetadata, LinkLocal, Loopback, Multicast, Private, Reserved, SharedAddressSpace,
    Unspecified,
};

/// The registered ranges in `ip.ts` registration (= evaluation) order, IPv4 first. Each literal sits beside its value;
/// the unit test `rows_are_their_literals` proves every value is what `parse_cidr` makes of the literal.
const ROWS: [Row; 28] = [
    row("0.0.0.0/8", V4(0x0000_0000, 8), Unspecified),
    row("10.0.0.0/8", V4(0x0a00_0000, 8), Private),
    row("100.64.0.0/10", V4(0x6440_0000, 10), SharedAddressSpace), // CGNAT; also Alibaba metadata 100.100.100.200
    row("127.0.0.0/8", V4(0x7f00_0000, 8), Loopback),
    row("169.254.0.0/16", V4(0xa9fe_0000, 16), LinkLocal), // includes the cloud metadata address 169.254.169.254
    row("168.63.129.16/32", V4(0xa83f_8110, 32), CloudMetadata), // Azure WireServer, answers only inside the VM
    row("172.16.0.0/12", V4(0xac10_0000, 12), Private),
    row("192.0.0.0/24", V4(0xc000_0000, 24), Reserved),
    row("192.0.2.0/24", V4(0xc000_0200, 24), Reserved),
    row("192.88.99.0/24", V4(0xc058_6300, 24), Reserved),
    row("192.168.0.0/16", V4(0xc0a8_0000, 16), Private),
    row("198.18.0.0/15", V4(0xc612_0000, 15), Reserved),
    row("198.51.100.0/24", V4(0xc633_6400, 24), Reserved),
    row("203.0.113.0/24", V4(0xcb00_7100, 24), Reserved),
    row("224.0.0.0/4", V4(0xe000_0000, 4), Multicast),
    row("240.0.0.0/4", V4(0xf000_0000, 4), Reserved),
    row("::/128", V6(0, 128), Unspecified),
    row("::1/128", V6(1, 128), Loopback),
    row("::/96", V6(0, 96), Reserved), // IPv4-compatible (deprecated)
    row(
        "64:ff9b:1::/48",
        V6(0x0064_ff9b_0001_0000_0000_0000_0000_0000, 48),
        Reserved,
    ),
    row(
        "100::/64",
        V6(0x0100_0000_0000_0000_0000_0000_0000_0000, 64),
        Reserved,
    ),
    row(
        "2001::/23",
        V6(0x2001_0000_0000_0000_0000_0000_0000_0000, 23),
        Reserved,
    ), // incl. Teredo
    row(
        "2001:db8::/32",
        V6(0x2001_0db8_0000_0000_0000_0000_0000_0000, 32),
        Reserved,
    ),
    row(
        "3fff::/20",
        V6(0x3fff_0000_0000_0000_0000_0000_0000_0000, 20),
        Reserved,
    ),
    row(
        "fc00::/7",
        V6(0xfc00_0000_0000_0000_0000_0000_0000_0000, 7),
        Private,
    ), // ULA, incl. fd00:ec2::254 (AWS)
    row(
        "fe80::/10",
        V6(0xfe80_0000_0000_0000_0000_0000_0000_0000, 10),
        LinkLocal,
    ),
    row(
        "fec0::/10",
        V6(0xfec0_0000_0000_0000_0000_0000_0000_0000, 10),
        Reserved,
    ), // deprecated site-local
    row(
        "ff00::/8",
        V6(0xff00_0000_0000_0000_0000_0000_0000_0000, 8),
        Multicast,
    ),
];

const fn literals() -> [(&'static str, Reason); ROWS.len()] {
    let mut out = [("", Reserved); ROWS.len()];
    let mut i = 0;
    while i < ROWS.len() {
        out[i] = (ROWS[i].cidr, ROWS[i].reason);
        i += 1;
    }
    out
}

static TABLE: [(&str, Reason); ROWS.len()] = literals();

/// The registered ranges (IPv4 first, then IPv6) with the CIDR literals they were registered under, in the order
/// [`classify`] evaluates them; equal to `classificationTable()` of `ip.ts`. Beside the table, [`classify`] treats
/// `255.255.255.255` (limited broadcast) as `reserved` (it is inside `240.0.0.0/4` anyway), judges IPv4-mapped, NAT64
/// (`64:ff9b::/96`) and 6to4 (`2002::/16`) addresses by the IPv4 address they carry, and calls everything outside
/// `2000::/3` `reserved`. The shared vector file pins all of it.
pub fn table() -> &'static [(&'static str, Reason)] {
    &TABLE
}

/// The `width - prefix` low bits of `n` cleared. A prefix above `width` counts as `width`.
pub(crate) fn mask(n: u128, width: u32, prefix: u32) -> u128 {
    let host = width - prefix.min(width);
    u128::MAX.checked_shl(host).map_or(0, |m| n & m)
}

pub(crate) fn v4_nets() -> impl Iterator<Item = (u32, u8)> {
    ROWS.iter().filter_map(|r| match r.net {
        V4(base, prefix) => Some((base, prefix)),
        V6(..) => None,
    })
}

pub(crate) fn v6_nets() -> impl Iterator<Item = (u128, u8)> {
    ROWS.iter().filter_map(|r| match r.net {
        V6(base, prefix) => Some((base, prefix)),
        V4(..) => None,
    })
}

/// `64:ff9b::/96`, the NAT64 well-known prefix (RFC 6052), as its top 96 bits.
const NAT64_TOP96: u128 = 0x0064_ff9b_0000_0000_0000_0000;
/// `2002::/16`, 6to4, as its top 16 bits.
const SIX_TO_FOUR_TOP16: u128 = 0x2002;

/// The verdict on an address, equal to `classifyAddress` of `ip.ts` (spec §4.2). An IPv4-mapped address is judged as
/// the IPv4 address it is; NAT64 and 6to4 addresses by the IPv4 address they carry; other IPv6 addresses are public
/// only inside `2000::/3` and outside the registered ranges.
pub fn classify(a: IpAddr) -> Verdict {
    match canonical(a) {
        IpAddr::V4(v4) => classify_v4(u32::from(v4)),
        IpAddr::V6(v6) => classify_v6(u128::from(v6)),
    }
}

fn classify_v4(n: u32) -> Verdict {
    if n == u32::MAX {
        return refused(Reserved); // limited broadcast
    }
    for r in &ROWS {
        if let V4(base, prefix) = r.net {
            let p = u32::from(prefix);
            if mask(u128::from(n), 32, p) == mask(u128::from(base), 32, p) {
                return refused(r.reason);
            }
        }
    }
    PUBLIC
}

fn classify_v6(n: u128) -> Verdict {
    // NAT64 (RFC 6052) and 6to4 carry an IPv4 address: judge that one. The `as u32` keeps exactly the carried bits.
    if n >> 32 == NAT64_TOP96 {
        return classify_v4(n as u32);
    }
    if n >> 112 == SIX_TO_FOUR_TOP16 {
        return classify_v4((n >> 80) as u32);
    }
    for r in &ROWS {
        if let V6(base, prefix) = r.net {
            let p = u32::from(prefix);
            if mask(n, 128, p) == mask(base, 128, p) {
                return refused(r.reason);
            }
        }
    }
    // Only global unicast 2000::/3 is public; everything else is unassigned or special.
    if n >> 125 != 0b001 {
        return refused(Reserved);
    }
    PUBLIC
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cidr::parse_cidr;

    #[test]
    fn rows_are_their_literals() {
        for r in &ROWS {
            let c = parse_cidr(r.cidr).unwrap_or_else(|| panic!("{} parses", r.cidr));
            let parsed = match c.addr {
                IpAddr::V4(a) => V4(u32::from(a), c.prefix),
                IpAddr::V6(a) => V6(u128::from(a), c.prefix),
            };
            assert_eq!(parsed, r.net, "{}", r.cidr);
            // Every row is written as its network address: no host bits.
            let (n, width, prefix) = match r.net {
                V4(b, p) => (u128::from(b), 32, u32::from(p)),
                V6(b, p) => (b, 128, u32::from(p)),
            };
            assert_eq!(mask(n, width, prefix), n, "{}: host bits", r.cidr);
        }
        assert_eq!(table().len(), ROWS.len());
        assert_eq!(v4_nets().count(), 16);
        assert_eq!(v6_nets().count(), 12);
    }

    #[test]
    fn reason_names_are_distinct() {
        let all = [
            Unspecified,
            Private,
            SharedAddressSpace,
            Loopback,
            LinkLocal,
            CloudMetadata,
            Reserved,
            Multicast,
        ];
        let names: std::collections::BTreeSet<&str> = all.iter().map(|r| r.as_str()).collect();
        assert_eq!(names.len(), all.len());
    }

    #[test]
    fn mask_edges() {
        assert_eq!(mask(u128::MAX, 128, 0), 0);
        assert_eq!(mask(u128::MAX, 128, 128), u128::MAX);
        assert_eq!(
            mask(u128::MAX, 128, 200),
            u128::MAX,
            "an oversized prefix counts as the full width"
        );
        assert_eq!(mask(0xffff_ffff, 32, 0), 0);
        assert_eq!(mask(0xffff_ffff, 32, 8), 0xff00_0000);
        assert_eq!(mask(0xffff_ffff, 32, 32), 0xffff_ffff);
    }

    #[test]
    fn broadcast_is_reserved_beside_the_table() {
        let v = classify(IpAddr::V4(std::net::Ipv4Addr::BROADCAST));
        assert_eq!(v, refused(Reserved));
        assert!(!table().iter().any(|(c, _)| *c == "255.255.255.255/32"));
    }
}
