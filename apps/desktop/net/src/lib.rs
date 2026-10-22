#![forbid(unsafe_code)]
//! IP address parsing and classification for the desktop transport choice (spec
//! `docs/superpowers/specs/2026-10-21-desktop-transport-choice-design.md` §4). Pure, std only, no I/O.
//!
//! The address verdict ([`parse_address`], [`canonical`], [`classify`], [`parse_cidr`], [`in_cidr`],
//! [`cidr_first_public`], [`table`]) agrees exactly with `packages/core/src/tools/web/ip.ts`; the shared vector file
//! `packages/core/test/fixtures/net/ip-classification-vectors.json` pins both sides (`tests/parity.rs`). The target
//! category ([`target_class`], [`aggregate`], [`is_tailnet`]) is the desktop layer on top of it (spec §4.3) and exists
//! in Rust only.

mod category;
mod cidr;
mod classify;
mod parse;

pub use category::{aggregate, is_tailnet, target_class, AddrClass, Category};
pub use cidr::{cidr_first_public, in_cidr, parse_cidr, Cidr};
pub use classify::{classify, table, Reason, Verdict};
pub use parse::{canonical, parse_address};

/// The IANA special-purpose registry snapshot the classification follows (spec §4.1). It equals
/// `IANA_SPECIAL_REGISTRY.id` in `ip.ts` and the `classifier` field of the shared vector file; moving to a newer
/// snapshot is one reviewed change of the tables, this constant, the vector file and `ip.ts`. No runtime download.
pub const CLASSIFIER_ID: &str = "iana-special-2025-10-09";

/// One IANA registry the snapshot was read from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Registry {
    pub url: &'static str,
    pub updated: &'static str,
}

/// *IANA IPv4 Special-Purpose Address Space*, as of the snapshot [`CLASSIFIER_ID`].
pub const IANA_IPV4_SPECIAL: Registry = Registry {
    url: "https://www.iana.org/assignments/iana-ipv4-special-registry/",
    updated: "2025-10-09",
};

/// *IANA IPv6 Special-Purpose Address Space*, as of the snapshot [`CLASSIFIER_ID`].
pub const IANA_IPV6_SPECIAL: Registry = Registry {
    url: "https://www.iana.org/assignments/iana-ipv6-special-registry/",
    updated: "2025-10-09",
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_constants() {
        assert_eq!(CLASSIFIER_ID, "iana-special-2025-10-09");
        assert_eq!(IANA_IPV4_SPECIAL.updated, "2025-10-09");
        assert_eq!(IANA_IPV6_SPECIAL.updated, "2025-10-09");
        assert!(IANA_IPV4_SPECIAL.url.contains("ipv4"));
        assert!(IANA_IPV6_SPECIAL.url.contains("ipv6"));
    }
}
