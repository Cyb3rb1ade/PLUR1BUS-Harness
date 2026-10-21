//! Helpers shared by the integration tests (`parity.rs`, `oracle.rs`, `robustness.rs`). Each test binary compiles
//! its own copy and uses a subset, hence the `dead_code` allowance.
#![allow(dead_code)]

use plur1bus_desktop_net::Cidr;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// xorshift64*, deterministic.
pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    /// A value in `0..n`.
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    pub fn u128(&mut self) -> u128 {
        (u128::from(self.next()) << 64) | u128::from(self.next())
    }
}

/// The address as a number (32 significant bits for IPv4).
pub fn bits(a: IpAddr) -> u128 {
    match a {
        IpAddr::V4(v4) => u128::from(u32::from(v4)),
        IpAddr::V6(v6) => u128::from(v6),
    }
}

/// The address with the value `n`, IPv4 when `v4`.
pub fn from_bits(v4: bool, n: u128) -> IpAddr {
    if v4 {
        IpAddr::V4(Ipv4Addr::from(
            u32::try_from(n).expect("an IPv4 value fits 32 bits"),
        ))
    } else {
        IpAddr::V6(Ipv6Addr::from(n))
    }
}

/// The first and last address of the range as numbers, host bits ignored.
pub fn range(c: &Cidr) -> (u128, u128) {
    let width: u32 = if c.addr.is_ipv4() { 32 } else { 128 };
    let host = width - u32::from(c.prefix).min(width);
    let span = if host == 128 {
        u128::MAX
    } else {
        (1u128 << host) - 1
    };
    let lo = bits(c.addr) & !span;
    (lo, lo | span)
}
