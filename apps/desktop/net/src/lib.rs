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

    /// xorshift64*, deterministic.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    /// Single characters (ASCII, digits, the address punctuation, non-ASCII digits and white space) and fragments that
    /// steer the strings into the deeper parser paths.
    const PIECES: &[&str] = &[
        "0",
        "1",
        "7",
        "8",
        "9",
        "a",
        "f",
        "F",
        "g",
        "x",
        "X",
        ".",
        ":",
        "[",
        "]",
        "%",
        "/",
        " ",
        "-",
        "+",
        "e",
        "\t",
        "é",
        "１",
        "٣",
        "\u{FEFF}",
        "\u{3000}",
        "\u{0085}",
        "\u{200B}",
        "💥",
        "::",
        "ffff",
        "0x",
        "00",
        "255",
        "256",
        "4294967295",
        "1.2.3.4",
        "::ffff:",
        "64:ff9b::",
        "2002:",
        "fe80::",
        "/0",
        "/32",
        "/128",
        "/999",
    ];

    #[test]
    fn no_panic_on_arbitrary_input() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        let mut parsed = 0usize;
        let mut cidrs = 0usize;
        let mut s = String::with_capacity(4096);
        for i in 0..200_000 {
            s.clear();
            // Mostly short strings; every 1000th is long, to show the parser stays linear and allocation-free.
            let pieces = if i % 1000 == 0 { 2000 } else { rng.below(14) };
            for _ in 0..pieces {
                s.push_str(PIECES[rng.below(PIECES.len())]);
            }
            let lenient = parse_address(&s, false);
            let strict = parse_address(&s, true);
            if let Some(a) = strict {
                assert_eq!(
                    lenient,
                    Some(a),
                    "{s:?}: strict accepts only what lenient accepts, as the same address"
                );
            }
            if let Some(a) = lenient {
                parsed += 1;
                let v = classify(a);
                assert_eq!(v.public, v.reason.is_none(), "{s:?}");
                let _ = target_class(a);
                let _ = is_tailnet(a);
                let _ = canonical(a);
            }
            if let Some(c) = parse_cidr(&s) {
                cidrs += 1;
                let width = if c.addr.is_ipv4() { 32 } else { 128 };
                assert!(c.prefix <= width, "{s:?}");
                if let Some(first) = cidr_first_public(&c) {
                    assert!(classify(first).public, "{s:?}");
                    assert_eq!(first.is_ipv4(), c.addr.is_ipv4(), "{s:?}");
                }
                let _ = in_cidr(c.addr, &c);
            }
        }
        assert!(
            parsed > 1_000,
            "the strings reach valid addresses ({parsed})"
        );
        assert!(cidrs > 100, "the strings reach valid ranges ({cidrs})");
    }

    #[test]
    fn registry_constants() {
        assert_eq!(CLASSIFIER_ID, "iana-special-2025-10-09");
        assert_eq!(IANA_IPV4_SPECIAL.updated, "2025-10-09");
        assert_eq!(IANA_IPV6_SPECIAL.updated, "2025-10-09");
        assert!(IANA_IPV4_SPECIAL.url.contains("ipv4"));
        assert!(IANA_IPV6_SPECIAL.url.contains("ipv6"));
    }
}
