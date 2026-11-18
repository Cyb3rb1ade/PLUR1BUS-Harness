//! IP address parsing and classification for the SSRF guard and the egress policy (TypeScript: `tools/web/ip.ts`, D94
//! "Safety"). Pure, no I/O.
//!
//! Rule: an address is public only when it is positively known to be (default deny). IPv4 spellings that `inet_aton`
//! accepts (decimal, octal, hexadecimal, one to four parts) are parsed the way a C resolver reads them, so a spelling that
//! reaches a socket as 127.0.0.1 is classified as 127.0.0.1; IPv6 forms that carry an IPv4 address (IPv4-mapped, NAT64,
//! 6to4) are judged by the address they carry.
//!
//! The same rules exist in Rust as `apps/desktop/net` (`plur1bus-desktop-net`), which is outside the workspace and so not
//! a dependency this crate may take (the card leaves `Cargo.toml` to the controller). This port reads the same shared
//! vector file (`packages/core/test/fixtures/net/ip-classification-vectors.json`) in its tests, so the three copies are held
//! to one answer; the ledger of P4-K K2 names the dependency line that would replace this file.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// The snapshot of the IANA special-purpose registries the tables follow (`IANA_SPECIAL_REGISTRY.id` in `ip.ts`).
pub const CLASSIFIER_ID: &str = "iana-special-2025-10-09";

/// `{ public, reason }` of `classifyAddress`: `reason` is set exactly when the address is not public.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Verdict {
    /// Whether the address is positively public.
    pub public: bool,
    /// The category when it is not public (`loopback`, `private`, ...).
    pub reason: Option<&'static str>,
}

/// An address range: the address (host bits kept, as `parseCidr` keeps them) and the prefix length.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cidr {
    /// The address as written (host bits kept).
    pub address: IpAddr,
    /// The prefix length.
    pub prefix: u8,
}

/// `parseInt` of one `inet_aton` part: `None` where the part is not a number, `Some(None)` where it is a number too large
/// for `u64` (every caller refuses that, as JavaScript refuses the inexact double it would have parsed).
fn parse_v4_part(s: &str) -> Option<Option<u64>> {
    let (digits, radix) = if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        if hex.is_empty() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        (hex, 16)
    } else if s.starts_with('0') {
        if !s.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
            return None;
        }
        if s.len() == 1 {
            return Some(Some(0));
        }
        (s, 8)
    } else {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        (s, 10)
    };
    Some(u64::from_str_radix(digits, radix).ok())
}

/// `^(0|[1-9][0-9]{0,2})$`.
fn strict_part(p: &str) -> bool {
    let b = p.as_bytes();
    p == "0"
        || (!b.is_empty()
            && b.len() <= 3
            && (b'1'..=b'9').contains(&b[0])
            && b.iter().all(u8::is_ascii_digit))
}

fn parse_v4(s: &str, strict: bool) -> Option<[u8; 4]> {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() > 4 || (strict && parts.len() != 4) {
        return None;
    }
    let mut nums = Vec::with_capacity(parts.len());
    for p in &parts {
        if strict && !strict_part(p) {
            return None;
        }
        // A part too large for u64 is larger than any part may be; `u64::MAX` stands in for it.
        nums.push(parse_v4_part(p)?.unwrap_or(u64::MAX));
    }
    let last = *nums.last()?;
    let last_bytes = 5 - nums.len() as u32;
    if u128::from(last) >= 256u128.pow(last_bytes) {
        return None;
    }
    let mut out = [0u8; 4];
    for (i, n) in nums[..nums.len() - 1].iter().enumerate() {
        out[i] = u8::try_from(*n).ok()?;
    }
    for i in 0..last_bytes as usize {
        out[3 - i] = ((last >> (8 * i)) & 0xff) as u8;
    }
    Some(out)
}

fn groups_of(part: &str) -> Option<Vec<u16>> {
    if part.is_empty() {
        return Some(Vec::new());
    }
    part.split(':')
        .map(|h| {
            if h.is_empty() || h.len() > 4 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            u16::from_str_radix(h, 16).ok()
        })
        .collect()
}

fn parse_v6(s: &str) -> Option<[u8; 16]> {
    if !s.contains(':')
        || !s
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.')
    {
        return None; // no zone ids, no junk
    }
    let mut head = s;
    let mut tail: Vec<u16> = Vec::new();
    let last_colon = s.rfind(':')?;
    if s[last_colon + 1..].contains('.') {
        let v4 = parse_v4(&s[last_colon + 1..], true)?;
        tail = vec![
            u16::from(v4[0]) << 8 | u16::from(v4[1]),
            u16::from(v4[2]) << 8 | u16::from(v4[3]),
        ];
        head = &s[..=last_colon];
        if !head.ends_with("::") {
            head = &head[..head.len() - 1];
        }
    }
    let dbl = head.find("::");
    if dbl != head.rfind("::") {
        return None;
    }
    let groups: Vec<u16> = match dbl {
        Some(at) => {
            let a = groups_of(&head[..at])?;
            let b = groups_of(&head[at + 2..])?;
            let fill = 8i64 - a.len() as i64 - b.len() as i64 - tail.len() as i64;
            if fill < 1 {
                return None;
            }
            let mut g = a;
            g.extend(std::iter::repeat_n(0, fill as usize));
            g.extend(b);
            g.extend(tail);
            g
        }
        None => {
            let mut g = groups_of(head)?;
            g.extend(tail);
            g
        }
    };
    if groups.len() != 8 {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, g) in groups.iter().enumerate() {
        out[i * 2] = (g >> 8) as u8;
        out[i * 2 + 1] = (g & 0xff) as u8;
    }
    Some(out)
}

/// `parseAddress(input, { strict })`: an IP literal (brackets allowed); `strict` takes only the dotted quad for IPv4.
pub fn parse_address(input: &str, strict: bool) -> Option<IpAddr> {
    let mut s = input.trim_matches(crate::js::is_js_space);
    if s.len() >= 2 && s.starts_with('[') && s.ends_with(']') {
        s = &s[1..s.len() - 1];
    }
    if s.is_empty() {
        return None;
    }
    if s.contains(':') {
        return parse_v6(s).map(|b| IpAddr::V6(Ipv6Addr::from(b)));
    }
    parse_v4(s, strict).map(|b| IpAddr::V4(Ipv4Addr::from(b)))
}

/// `canonical`: an IPv4-mapped IPv6 address becomes the IPv4 address it carries; anything else is unchanged.
pub fn canonical(a: IpAddr) -> IpAddr {
    match a {
        IpAddr::V6(v6) => {
            let b = v6.octets();
            if b[..10].iter().all(|x| *x == 0) && b[10] == 0xff && b[11] == 0xff {
                IpAddr::V4(Ipv4Addr::new(b[12], b[13], b[14], b[15]))
            } else {
                a
            }
        }
        IpAddr::V4(_) => a,
    }
}

/// The registered ranges in registration (= evaluation) order, with the CIDR literal each was registered under.
pub const TABLE: &[(&str, &str)] = &[
    ("0.0.0.0/8", "unspecified"),
    ("10.0.0.0/8", "private"),
    ("100.64.0.0/10", "shared-address-space"),
    ("127.0.0.0/8", "loopback"),
    ("169.254.0.0/16", "link-local"),
    ("168.63.129.16/32", "cloud-metadata"),
    ("172.16.0.0/12", "private"),
    ("192.0.0.0/24", "reserved"),
    ("192.0.2.0/24", "reserved"),
    ("192.88.99.0/24", "reserved"),
    ("192.168.0.0/16", "private"),
    ("198.18.0.0/15", "reserved"),
    ("198.51.100.0/24", "reserved"),
    ("203.0.113.0/24", "reserved"),
    ("224.0.0.0/4", "multicast"),
    ("240.0.0.0/4", "reserved"),
    ("::/128", "unspecified"),
    ("::1/128", "loopback"),
    ("::/96", "reserved"),
    ("64:ff9b:1::/48", "reserved"),
    ("100::/64", "reserved"),
    ("2001::/23", "reserved"),
    ("2001:db8::/32", "reserved"),
    ("3fff::/20", "reserved"),
    ("fc00::/7", "private"),
    ("fe80::/10", "link-local"),
    ("fec0::/10", "reserved"),
    ("ff00::/8", "multicast"),
];

fn octets(a: IpAddr) -> Vec<u8> {
    match a {
        IpAddr::V4(v) => v.octets().to_vec(),
        IpAddr::V6(v) => v.octets().to_vec(),
    }
}

/// `inCidr`: whether the canonical form of `a` lies in `c` (a family mismatch is never inside).
pub fn in_cidr(a: IpAddr, c: &Cidr) -> bool {
    let addr = canonical(a);
    if addr.is_ipv4() != c.address.is_ipv4() {
        return false;
    }
    let (x, y) = (octets(addr), octets(c.address));
    let mut bits = i32::from(c.prefix);
    let mut i = 0;
    while bits > 0 {
        let mask: u8 = if bits >= 8 {
            0xff
        } else {
            (0xffu16 << (8 - bits)) as u8
        };
        if x[i] & mask != y[i] & mask {
            return false;
        }
        bits -= 8;
        i += 1;
    }
    true
}

/// `parseCidr`: `addr` or `addr/prefix` (a bare address is a host route); the dotted quad only for IPv4.
pub fn parse_cidr(input: &str) -> Option<Cidr> {
    let parts: Vec<&str> = input.split('/').collect();
    if parts.len() > 2 {
        return None;
    }
    let address = parse_address(parts[0], true)?;
    let max: u8 = if address.is_ipv4() { 32 } else { 128 };
    let mut prefix = max;
    if let Some(p) = parts.get(1) {
        if p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let n: u16 = p.parse().ok()?;
        if n > u16::from(max) {
            return None;
        }
        prefix = n as u8;
    }
    Some(Cidr { address, prefix })
}

fn ranges(v4: bool) -> impl Iterator<Item = (Cidr, &'static str)> {
    TABLE
        .iter()
        .filter(move |(c, _)| c.contains(':') != v4)
        // Every row is a constant that parses (`every_table_row_parses` below and the shared vectors prove it).
        .filter_map(|(c, r)| parse_cidr(c).map(|cidr| (cidr, *r)))
}

fn classify_v4(b: [u8; 4]) -> Verdict {
    if b.iter().all(|x| *x == 255) {
        return Verdict {
            public: false,
            reason: Some("reserved"),
        }; // limited broadcast
    }
    let a = IpAddr::V4(Ipv4Addr::from(b));
    for (c, reason) in ranges(true) {
        if in_cidr(a, &c) {
            return Verdict {
                public: false,
                reason: Some(reason),
            };
        }
    }
    Verdict {
        public: true,
        reason: None,
    }
}

/// `classifyAddress`.
pub fn classify(input: IpAddr) -> Verdict {
    let a = canonical(input);
    let b = match a {
        IpAddr::V4(v) => return classify_v4(v.octets()),
        IpAddr::V6(v) => v.octets(),
    };
    let w = |i: usize| u16::from(b[i]) << 8 | u16::from(b[i + 1]);
    // NAT64 (RFC 6052) and 6to4 carry an IPv4 address: judge that one.
    if w(0) == 0x64 && w(2) == 0xff9b && b[4..12].iter().all(|x| *x == 0) {
        return classify_v4([b[12], b[13], b[14], b[15]]);
    }
    if w(0) == 0x2002 {
        return classify_v4([b[2], b[3], b[4], b[5]]);
    }
    for (c, reason) in ranges(false) {
        if in_cidr(a, &c) {
            return Verdict {
                public: false,
                reason: Some(reason),
            };
        }
    }
    // Only global unicast 2000::/3 is public; everything else is unassigned or special.
    if b[0] & 0xe0 != 0x20 {
        return Verdict {
            public: false,
            reason: Some("reserved"),
        };
    }
    Verdict {
        public: true,
        reason: None,
    }
}

/// `formatAddress` of `tools/web/guard.ts`: the canonical form, IPv4 dotted, IPv6 as eight unpadded hex groups (no `::`).
pub fn format_address(a: IpAddr) -> String {
    match canonical(a) {
        IpAddr::V4(v) => v.to_string(),
        IpAddr::V6(v) => v
            .segments()
            .iter()
            .map(|g| format!("{g:x}"))
            .collect::<Vec<_>>()
            .join(":"),
    }
}

/// The family number of an address, `4` or `6` (the `family` of a resolved address).
pub fn family(a: IpAddr) -> u8 {
    if a.is_ipv4() {
        4
    } else {
        6
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_table_row_parses() {
        for (c, _) in TABLE {
            assert!(parse_cidr(c).is_some(), "{c}");
        }
        assert_eq!(ranges(true).count() + ranges(false).count(), TABLE.len());
    }
}
