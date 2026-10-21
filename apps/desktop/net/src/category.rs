//! The target category, the desktop layer on top of the shared verdict (spec §4.3). Rust only.

use crate::classify::{classify, mask, Reason};
use crate::parse::canonical;
use std::net::{IpAddr, Ipv4Addr};

/// What a connectable address is. The derived order is the aggregation order of spec §4.3,
/// `public ≻ special ≻ private ≻ tailnet ≻ loopback`: [`aggregate`] takes the maximum.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Category {
    Loopback,
    Tailnet,
    Private,
    Special,
    Public,
}

/// One resolved address: connectable with its [`Category`], or not connectable at all (`unspecified`, `multicast`,
/// `255.255.255.255`; the check reports `target-not-connectable` when nothing else remains).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddrClass {
    Connectable(Category),
    NotConnectable,
}

/// `100.64.0.0/10` as its top 10 bits.
const TAILNET_V4: (u128, u32) = (0x6440_0000, 10);
/// `fd7a:115c:a1e0::/48` as its top 48 bits.
const TAILNET_V6: (u128, u32) = (0xfd7a_115c_a1e0_0000_0000_0000_0000_0000, 48);

/// Whether the address lies in a Tailscale range, `100.64.0.0/10` or `fd7a:115c:a1e0::/48`. An IPv4-mapped address is
/// the IPv4 host and is taken [`canonical`] first (`::ffff:100.64.0.1` is in the range); a NAT64 or 6to4 address that
/// only carries such an address through a translator is not. `100.64.0.0/10` is also carrier-grade NAT space, so this
/// marks a candidate only; the Tailscale check (spec §5) decides.
pub fn is_tailnet(a: IpAddr) -> bool {
    match canonical(a) {
        IpAddr::V4(v4) => mask(u128::from(u32::from(v4)), 32, TAILNET_V4.1) == TAILNET_V4.0,
        IpAddr::V6(v6) => mask(u128::from(v6), 128, TAILNET_V6.1) == TAILNET_V6.0,
    }
}

/// The class of one resolved address (spec §4.3, rows in order): not connectable for `unspecified`, `multicast` and
/// `255.255.255.255`; `tailnet` in a Tailscale range ([`is_tailnet`]); `loopback`; `private` for `private` and
/// `link-local`; `special` for `reserved`, `cloud-metadata` and the `shared-address-space` a NAT64 or 6to4 address
/// carries (it reaches the translator's network, not the tailnet); `public` otherwise.
pub fn target_class(a: IpAddr) -> AddrClass {
    let a = canonical(a);
    if a == IpAddr::V4(Ipv4Addr::BROADCAST) {
        return AddrClass::NotConnectable;
    }
    let verdict = classify(a);
    let category = match verdict.reason {
        Some(Reason::Unspecified | Reason::Multicast) => return AddrClass::NotConnectable,
        _ if is_tailnet(a) => Category::Tailnet,
        Some(Reason::Loopback) => Category::Loopback,
        Some(Reason::Private | Reason::LinkLocal) => Category::Private,
        // After `canonical` and the tailnet check, `shared-address-space` is only reachable through NAT64 or 6to4.
        Some(Reason::SharedAddressSpace | Reason::Reserved | Reason::CloudMetadata) => {
            Category::Special
        }
        None => Category::Public,
    };
    AddrClass::Connectable(category)
}

/// The category of a target over all its connectable addresses: the highest one, so any public address makes the
/// target public. `None` for no addresses (the caller reports `target-not-connectable`).
pub fn aggregate<I: IntoIterator<Item = Category>>(it: I) -> Option<Category> {
    it.into_iter().max()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse_address;

    fn ip(s: &str) -> IpAddr {
        parse_address(s, false).unwrap_or_else(|| panic!("{s}"))
    }

    fn class(s: &str) -> AddrClass {
        target_class(ip(s))
    }

    #[test]
    fn aggregate_any_public_wins() {
        use Category::*;
        assert_eq!(
            aggregate([Loopback, Tailnet, Private, Special, Public]),
            Some(Public)
        );
        assert_eq!(aggregate([Public, Loopback]), Some(Public));
        assert_eq!(aggregate([Tailnet, Public, Private]), Some(Public));
        assert_eq!(aggregate([Loopback, Special, Tailnet]), Some(Special));
        assert_eq!(aggregate([Tailnet, Private]), Some(Private));
        assert_eq!(aggregate([Loopback, Tailnet]), Some(Tailnet));
        assert_eq!(aggregate([Loopback]), Some(Loopback));
        assert!(Loopback < Tailnet && Tailnet < Private && Private < Special && Special < Public);
    }

    #[test]
    fn aggregate_empty_is_none() {
        assert_eq!(aggregate(std::iter::empty()), None);
        assert_eq!(aggregate(Vec::new()), None);
    }

    #[test]
    fn not_connectable_unspecified_multicast_broadcast() {
        for s in [
            "0.0.0.0",
            "0.255.255.255",
            "::",
            "::ffff:0.0.0.0",
            "64:ff9b::",
            "2002::",
            "224.0.0.0",
            "239.255.255.255",
            "ff00::",
            "ff02::1",
            "::ffff:224.0.0.1",
            "64:ff9b::e000:1",
            "255.255.255.255",
            "::ffff:255.255.255.255",
        ] {
            assert_eq!(class(s), AddrClass::NotConnectable, "{s}");
        }
        // Neighbours stay connectable; a translator carrying 255.255.255.255 is a reserved address, not broadcast.
        assert_eq!(
            class("255.255.255.254"),
            AddrClass::Connectable(Category::Special)
        );
        assert_eq!(
            class("240.0.0.0"),
            AddrClass::Connectable(Category::Special)
        );
        assert_eq!(
            class("64:ff9b::ffff:ffff"),
            AddrClass::Connectable(Category::Special)
        );
        assert_eq!(class("1.0.0.0"), AddrClass::Connectable(Category::Public));
    }

    #[test]
    fn tailnet_bounds() {
        assert!(!is_tailnet(ip("100.63.255.255")));
        assert!(is_tailnet(ip("100.64.0.0")));
        assert!(is_tailnet(ip("100.127.255.255")));
        assert!(!is_tailnet(ip("100.128.0.0")));
        assert!(is_tailnet(ip("fd7a:115c:a1e0::")));
        assert!(is_tailnet(ip("fd7a:115c:a1e0:ffff::1")));
        assert!(!is_tailnet(ip("fd7a:115c:a1e1::")));
        assert!(!is_tailnet(ip("fd7a:115c:a1df:ffff:ffff:ffff:ffff:ffff")));
        // Mapped is the IPv4 host; a translator is not.
        assert!(is_tailnet(ip("::ffff:100.64.0.1")));
        assert!(!is_tailnet(ip("64:ff9b::6440:1")));
        assert!(!is_tailnet(ip("2002:6440:1::1")));
        assert_eq!(
            class("100.64.0.0"),
            AddrClass::Connectable(Category::Tailnet)
        );
        assert_eq!(
            class("fd7a:115c:a1e0::1"),
            AddrClass::Connectable(Category::Tailnet)
        );
        assert_eq!(
            class("fd7a:115c:a1e1::1"),
            AddrClass::Connectable(Category::Private)
        );
        assert_eq!(
            class("64:ff9b::6440:1"),
            AddrClass::Connectable(Category::Special)
        );
    }

    #[test]
    fn every_reason_maps_to_its_category() {
        let cases = [
            ("127.0.0.1", Category::Loopback),
            ("::1", Category::Loopback),
            ("10.0.0.1", Category::Private),
            ("169.254.169.254", Category::Private),
            ("fe80::1", Category::Private),
            ("192.0.2.1", Category::Special),
            ("168.63.129.16", Category::Special),
            ("fec0::1", Category::Special),
            ("8.8.8.8", Category::Public),
            ("2606:4700:4700::1111", Category::Public),
        ];
        for (s, want) in cases {
            assert_eq!(class(s), AddrClass::Connectable(want), "{s}");
        }
    }
}
