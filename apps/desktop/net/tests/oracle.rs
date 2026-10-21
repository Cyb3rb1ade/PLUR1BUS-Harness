//! `cidr_first_public` against an independent oracle, over far more ranges than the vector file holds. Port of the
//! sweeps in `packages/core/test/tools/web/ip-vectors.test.ts`: a public run starts at the range start or right after
//! the end of a non-public interval, so the lowest public address is the first public one among those candidates,
//! judged by `classify`. The interval ends are written down here from the public API (`table()` and the spec §4.2
//! special cases), not read from the crate's internals.

use plur1bus_desktop_net::{cidr_first_public, classify, parse_address, parse_cidr, table, Cidr};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

fn bits(a: IpAddr) -> u128 {
    match a {
        IpAddr::V4(v4) => u128::from(u32::from(v4)),
        IpAddr::V6(v6) => u128::from(v6),
    }
}

fn from_bits(v4: bool, n: u128) -> IpAddr {
    if v4 {
        IpAddr::V4(Ipv4Addr::from(u32::try_from(n).expect("32 bits")))
    } else {
        IpAddr::V6(Ipv6Addr::from(n))
    }
}

fn range(v4: bool, n: u128, prefix: u8) -> (u128, u128) {
    let width: u32 = if v4 { 32 } else { 128 };
    let host = width - u32::from(prefix);
    let span = if host == 128 {
        u128::MAX
    } else {
        (1u128 << host) - 1
    };
    (n & !span, (n & !span) | span)
}

fn block(cidr: &str) -> (u128, u128) {
    let c = parse_cidr(cidr).unwrap_or_else(|| panic!("{cidr}"));
    range(c.addr.is_ipv4(), bits(c.addr), c.prefix)
}

/// The IPv4 non-public intervals: the IPv4 rows and limited broadcast (a special case, not a row).
fn v4_blocks() -> Vec<(u128, u128)> {
    let mut out: Vec<_> = table()
        .iter()
        .filter(|(c, _)| !c.contains(':'))
        .map(|(c, _)| block(c))
        .collect();
    out.push((0xffff_ffff, 0xffff_ffff));
    out
}

/// The last address of every interval at which a non-public IPv6 run can end: the IPv6 rows, the complement of
/// 2000::/3, the three embedded-IPv4 blocks, and every IPv4 interval lifted into each of them (IPv4-mapped and NAT64
/// at bit 0, 6to4 at bit 80). Sorted and unique.
fn v6_ends() -> Vec<u128> {
    let base = |s: &str| bits(parse_address(s, false).unwrap());
    let lifts = [
        (base("::ffff:0:0"), 0u32),
        (base("64:ff9b::"), 0),
        (base("2002::"), 80),
    ];
    let mut ends: Vec<u128> = table()
        .iter()
        .filter(|(c, _)| c.contains(':'))
        .map(|(c, _)| block(c).1)
        .collect();
    for c in [
        "::/3",
        "4000::/2",
        "8000::/1",
        "::ffff:0:0/96",
        "64:ff9b::/96",
        "2002::/16",
    ] {
        ends.push(block(c).1);
    }
    for (at, shift) in lifts {
        for (_, hi) in v4_blocks() {
            ends.push(at | (hi << shift) | ((1u128 << shift) - 1));
        }
    }
    ends.sort_unstable();
    ends.dedup();
    ends
}

fn v4_ends() -> Vec<u128> {
    let mut ends: Vec<u128> = v4_blocks().into_iter().map(|(_, hi)| hi).collect();
    ends.sort_unstable();
    ends.dedup();
    ends
}

/// The lowest public address of `[lo, hi]`, from the candidates `lo` and `end + 1` for every `end` in `(lo - 1, hi)`.
fn oracle(v4: bool, lo: u128, hi: u128, ends: &[u128]) -> Option<u128> {
    let from = ends.partition_point(|&e| e < lo);
    std::iter::once(lo)
        .chain(
            ends[from..]
                .iter()
                .filter_map(|e| e.checked_add(1))
                .filter(|&n| n > lo && n <= hi),
        )
        .find(|&n| classify(from_bits(v4, n)).public)
}

/// Asserts `cidr_first_public` equals the oracle; returns whether the range has a public address.
fn check(c: &Cidr, ends: &[u128]) -> bool {
    let v4 = c.addr.is_ipv4();
    let (lo, hi) = range(v4, bits(c.addr), c.prefix);
    let got = cidr_first_public(c);
    let want = oracle(v4, lo, hi, ends).map(|n| from_bits(v4, n));
    assert_eq!(got, want, "{}/{}", c.addr, c.prefix);
    got.is_some()
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn u128(&mut self) -> u128 {
        (u128::from(self.next()) << 64) | u128::from(self.next())
    }
}

#[test]
fn oracle_every_ipv4_slash8_and_slash16() {
    let ends = v4_ends();
    let mut hits = 0;
    for n in 0u32..=0xffff {
        let addr = IpAddr::V4(Ipv4Addr::from(n << 16));
        if n & 0xff == 0 {
            check(&Cidr { addr, prefix: 8 }, &ends);
        }
        if check(&Cidr { addr, prefix: 16 }, &ends) {
            hits += 1;
        }
    }
    assert!(hits > 50_000, "the sweep reaches public space ({hits})");
}

#[test]
fn oracle_ipv4_any_prefix_near_block_edges() {
    let ends = v4_ends();
    let mut rng = Rng(0x0123_4567_89ab_cdef);
    for i in 0..8192 {
        let n = if i % 2 == 0 {
            u128::from(rng.next() as u32)
        } else {
            let e = ends[(rng.next() % ends.len() as u64) as usize];
            (e + (rng.next() % 5) as u128).wrapping_sub(2) & 0xffff_ffff
        };
        let prefix = (rng.next() % 33) as u8;
        check(
            &Cidr {
                addr: from_bits(true, n),
                prefix,
            },
            &ends,
        );
    }
}

#[test]
fn oracle_every_ipv6_slash16_and_random_slash32() {
    let ends = v6_ends();
    let mut hits = 0;
    for n in 0u128..=0xffff {
        if check(
            &Cidr {
                addr: from_bits(false, n << 112),
                prefix: 16,
            },
            &ends,
        ) {
            hits += 1;
        }
    }
    assert!(
        hits > 8_000,
        "every /16 inside 2000::/3 reaches public space ({hits})"
    );
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut hits = 0;
    for i in 0..4096 {
        let mut top = rng.next() as u32;
        if i % 2 == 0 {
            top = (top & 0x1fff_ffff) | 0x2000_0000; // half of the samples inside 2000::/3
        }
        if check(
            &Cidr {
                addr: from_bits(false, u128::from(top) << 96),
                prefix: 32,
            },
            &ends,
        ) {
            hits += 1;
        }
    }
    assert!(hits > 1500, "the sweep reaches public space ({hits})");
}

#[test]
fn oracle_ipv6_any_prefix_near_block_edges() {
    let ends = v6_ends();
    let mut rng = Rng(0xfeed_face_cafe_beef);
    let mut edge_hits = 0;
    for i in 0..8192 {
        let n = if i % 2 == 0 {
            rng.u128()
        } else {
            let e = ends[(rng.next() % ends.len() as u64) as usize];
            e.wrapping_add((rng.next() % 5) as u128).wrapping_sub(2)
        };
        let prefix = (rng.next() % 129) as u8;
        if check(
            &Cidr {
                addr: from_bits(false, n),
                prefix,
            },
            &ends,
        ) && i % 2 == 1
        {
            edge_hits += 1;
        }
    }
    assert!(
        edge_hits > 500,
        "the edge samples reach public space ({edge_hits})"
    );
}

/// Inside the embedded-IPv4 blocks the IPv6 answer is the IPv4 answer lifted into the same block.
#[test]
fn embedded_blocks_lift_the_ipv4_answer() {
    let v4ends = v4_ends();
    let v6ends = v6_ends();
    for n in 0u32..=0xff {
        let v4 = Cidr {
            addr: IpAddr::V4(Ipv4Addr::from(n << 24)),
            prefix: 8,
        };
        let want = cidr_first_public(&v4).map(bits);
        assert_eq!(
            want,
            oracle(
                true,
                u128::from(n) << 24,
                (u128::from(n) << 24) | 0xff_ffff,
                &v4ends
            )
        );
        for (at, shift, prefix) in [
            ("::ffff:0:0", 0, 104u8),
            ("64:ff9b::", 0, 104),
            ("2002::", 80, 24),
        ] {
            let base = bits(parse_address(at, false).unwrap()) | ((u128::from(n) << 24) << shift);
            let c = Cidr {
                addr: from_bits(false, base),
                prefix,
            };
            check(&c, &v6ends);
            let got = cidr_first_public(&c).map(bits);
            assert_eq!(
                got,
                want.map(|w| bits(parse_address(at, false).unwrap()) | (w << shift)),
                "{at} {n}/8"
            );
        }
    }
}
