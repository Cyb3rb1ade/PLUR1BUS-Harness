//! `parseAddress` and `canonical` of `ip.ts`, step for step. The parser allocates nothing.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Parses an IP literal the way `parseAddress` in `ip.ts` does.
///
/// Surrounding white space (exactly what JavaScript's `String.prototype.trim` removes) and one level of brackets are
/// accepted. A string with a `:` is IPv6 (no zone id; an embedded dotted IPv4 tail must be a canonical dotted quad),
/// anything else IPv4. With `strict` only a canonical dotted quad is IPv4; without it the legacy `inet_aton` spellings
/// are accepted too (decimal, octal, hex, one to four parts: `127.1`, `0x7f000001`, `017700000001`), so a spelling that
/// reaches a socket as `127.0.0.1` parses as `127.0.0.1`. The address is returned as written: an IPv4-mapped IPv6
/// address stays IPv6 (see [`canonical`]).
pub fn parse_address(input: &str, strict: bool) -> Option<IpAddr> {
    let mut s = input.trim_matches(is_js_whitespace);
    if let Some(inner) = s.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
        s = inner;
    }
    if s.is_empty() {
        return None;
    }
    if s.contains(':') {
        return parse_v6(s).map(|b| IpAddr::V6(Ipv6Addr::from(b)));
    }
    parse_v4(s, strict).map(|b| IpAddr::V4(Ipv4Addr::from(b)))
}

/// An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) becomes the IPv4 address it carries; everything else, including
/// NAT64 and 6to4 addresses, is returned unchanged.
pub fn canonical(a: IpAddr) -> IpAddr {
    match a {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(a, IpAddr::V4),
        IpAddr::V4(_) => a,
    }
}

/// ECMAScript *WhiteSpace* and *LineTerminator*, the set `String.prototype.trim` removes. It differs from Rust's
/// `char::is_whitespace`: U+FEFF is trimmed here, U+0085 is not.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `parseV4Part`: `0x`/`0X` + hex digits, `0` + octal digits, or decimal without a leading zero. A value too large for
/// `u64` saturates; every caller rejects anything at or above 2^32 anyway, as `ip.ts` rejects it after `parseInt`.
fn parse_v4_part(p: &str) -> Option<u64> {
    let b = p.as_bytes();
    let accumulate = |digits: &[u8], radix: u32| -> Option<u64> {
        let mut n: u64 = 0;
        for &d in digits {
            let v = char::from(d).to_digit(radix)?;
            n = n
                .saturating_mul(u64::from(radix))
                .saturating_add(u64::from(v));
        }
        Some(n)
    };
    match b {
        [b'0', b'x' | b'X', rest @ ..]
            if !rest.is_empty() && rest.iter().all(u8::is_ascii_hexdigit) =>
        {
            accumulate(rest, 16)
        }
        [b'0', rest @ ..] if rest.iter().all(|d| (b'0'..=b'7').contains(d)) => accumulate(rest, 8),
        [b'1'..=b'9', rest @ ..] if rest.iter().all(u8::is_ascii_digit) => accumulate(b, 10),
        _ => None,
    }
}

/// The strict form of one dotted-quad part: `0` or one to three decimal digits without a leading zero.
fn is_strict_part(p: &str) -> bool {
    match p.as_bytes() {
        [b'0'] => true,
        [b'1'..=b'9', rest @ ..] => rest.len() <= 2 && rest.iter().all(u8::is_ascii_digit),
        _ => false,
    }
}

/// `parseV4`: one to four parts (exactly four when `strict`); the last part fills the bytes the others leave.
fn parse_v4(s: &str, strict: bool) -> Option<[u8; 4]> {
    let mut nums = [0u64; 4];
    let mut count = 0usize;
    for part in s.split('.') {
        if count == nums.len() {
            return None; // more than four parts
        }
        if strict && !is_strict_part(part) {
            return None;
        }
        nums[count] = parse_v4_part(part)?;
        count += 1;
    }
    if count == 0 || (strict && count != 4) {
        return None;
    }
    let last = nums[count - 1];
    let last_bytes = 5 - count; // 1..=4
    if last >= 1u64 << (8 * last_bytes) {
        return None;
    }
    let mut out = [0u8; 4];
    for (slot, &n) in out.iter_mut().zip(&nums[..count - 1]) {
        *slot = u8::try_from(n).ok()?;
    }
    for i in 0..last_bytes {
        out[3 - i] = (last >> (8 * i)) as u8; // the truncation is the `% 256` of ip.ts
    }
    Some(out)
}

/// `toGroups`: colon-separated groups of one to four hex digits, written to `out`. Returns how many were written, or
/// `None` for a malformed group or more groups than an address holds (`ip.ts` refuses those later, when the group
/// count is not eight).
fn to_groups(part: &str, out: &mut [u16; 8]) -> Option<usize> {
    if part.is_empty() {
        return Some(0);
    }
    let mut n = 0usize;
    for h in part.split(':') {
        if h.is_empty() || h.len() > 4 || !h.bytes().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let slot = out.get_mut(n)?;
        *slot = u16::from_str_radix(h, 16).ok()?;
        n += 1;
    }
    Some(n)
}

/// First and last start index of `::` in an ASCII string, overlapping matches included (`:::` gives 0 and 1), as
/// `indexOf("::")` and `lastIndexOf("::")` report them.
fn double_colons(s: &str) -> (Option<usize>, Option<usize>) {
    let b = s.as_bytes();
    let mut first = None;
    let mut last = None;
    for i in 0..b.len().saturating_sub(1) {
        if b[i] == b':' && b[i + 1] == b':' {
            first.get_or_insert(i);
            last = Some(i);
        }
    }
    (first, last)
}

/// `parseV6`: hex groups with at most one `::`, optionally ending in a canonical dotted-quad IPv4 tail. Only
/// `[0-9a-fA-F:.]` is allowed, so zone ids and junk are refused and every slice below is on an ASCII boundary.
fn parse_v6(s: &str) -> Option<[u8; 16]> {
    if !s
        .bytes()
        .all(|c| c.is_ascii_hexdigit() || c == b':' || c == b'.')
        || !s.contains(':')
    {
        return None;
    }
    let mut tail = [0u16; 2];
    let mut tail_len = 0usize;
    let mut head = s;
    let last_colon = s.rfind(':')?;
    let after = &s[last_colon + 1..];
    if after.contains('.') {
        let v4 = parse_v4(after, true)?;
        tail = [
            (u16::from(v4[0]) << 8) | u16::from(v4[1]),
            (u16::from(v4[2]) << 8) | u16::from(v4[3]),
        ];
        tail_len = 2;
        head = &s[..last_colon + 1];
        if !head.ends_with("::") {
            head = &head[..head.len() - 1];
        }
    }
    let mut groups = [0u16; 8];
    match double_colons(head) {
        (Some(first), Some(last)) if first != last => return None,
        (Some(at), _) => {
            let mut before = [0u16; 8];
            let mut behind = [0u16; 8];
            let a = to_groups(&head[..at], &mut before)?;
            let b = to_groups(&head[at + 2..], &mut behind)?;
            let used = a + b + tail_len;
            if used >= 8 {
                return None; // `::` stands for at least one zero group
            }
            let fill = 8 - used;
            groups[..a].copy_from_slice(&before[..a]);
            groups[a + fill..a + fill + b].copy_from_slice(&behind[..b]);
        }
        (None, _) => {
            let a = to_groups(head, &mut groups)?;
            if a + tail_len != 8 {
                return None;
            }
        }
    }
    groups[8 - tail_len..].copy_from_slice(&tail[..tail_len]);
    let mut out = [0u8; 16];
    for (pair, g) in out.chunks_exact_mut(2).zip(groups) {
        pair.copy_from_slice(&g.to_be_bytes());
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4(s: &str, strict: bool) -> Option<String> {
        match parse_address(s, strict)? {
            IpAddr::V4(a) => Some(a.to_string()),
            IpAddr::V6(a) => Some(format!("v6 {a}")),
        }
    }

    #[test]
    fn trims_exactly_what_javascript_trim_removes() {
        for s in [
            "\u{FEFF}8.8.8.8",
            "\u{3000}8.8.8.8\u{2029}",
            "\t\n\u{000B}\u{000C}\r 8.8.8.8\u{00A0}\u{1680}\u{2000}\u{200A}\u{2028}\u{202F}\u{205F}",
        ] {
            assert_eq!(v4(s, false).as_deref(), Some("8.8.8.8"), "{s:?}");
        }
        // NEL is white space to Rust's `trim`, not to JavaScript's.
        assert_eq!(parse_address("\u{0085}8.8.8.8", false), None);
        assert_eq!(
            parse_address("\u{200B}8.8.8.8", false),
            None,
            "a zero-width space is not white space"
        );
    }

    #[test]
    fn one_level_of_brackets_and_no_trim_inside_them() {
        assert!(parse_address("[::1]", false).is_some());
        assert!(parse_address(" [::1] ", false).is_some());
        assert_eq!(parse_address("[[::1]]", false), None);
        assert_eq!(parse_address("[ ::1 ]", false), None);
        assert_eq!(parse_address("[ 1.2.3.4]", false), None);
        assert_eq!(parse_address("[", false), None);
        assert_eq!(parse_address("[]", false), None);
    }

    #[test]
    fn legacy_ipv4_forms_only_when_not_strict() {
        let cases = [
            ("2130706433", "127.0.0.1"),
            ("017700000001", "127.0.0.1"),
            ("0x7f000001", "127.0.0.1"),
            ("0x7f.0.0.1", "127.0.0.1"),
            ("0177.0.0.1", "127.0.0.1"),
            ("127.1", "127.0.0.1"),
            ("127.0.1", "127.0.0.1"),
            ("0", "0.0.0.0"),
            ("00", "0.0.0.0"),
            ("0x0", "0.0.0.0"),
            ("0xFFffFFff", "255.255.255.255"),
            ("192.168.257", "192.168.1.1"),
            ("1.65535", "1.0.255.255"),
            ("1.65536", "1.1.0.0"),
            ("1.2.65535", "1.2.255.255"),
            ("1.16777215", "1.255.255.255"),
        ];
        for (spelling, dotted) in cases {
            assert_eq!(v4(spelling, false).as_deref(), Some(dotted), "{spelling}");
            assert_eq!(parse_address(spelling, true), None, "{spelling}: strict");
        }
        assert_eq!(v4("1.2.3.4", true).as_deref(), Some("1.2.3.4"));
        assert_eq!(
            v4("255.255.255.255", true).as_deref(),
            Some("255.255.255.255")
        );
    }

    #[test]
    fn out_of_range_and_overlong_parts_are_refused_without_overflow() {
        for bad in [
            "1.16777216",
            "1.2.65536",
            "1.2.3.256",
            "4294967296",
            "0x100000000",
            "040000000000",
            "256.0.0.1",
            "1.256.0.1",
            "0x100.1",
            "999999999999999999999999999999",
            "0xfffffffffffffffffffffffffffffffffffffff",
            "07777777777777777777777777777777777777777",
        ] {
            assert_eq!(parse_address(bad, false), None, "{bad}");
        }
        let long_hex = format!("0x{}", "f".repeat(10_000));
        assert_eq!(parse_address(&long_hex, false), None);
        let long_zeros = format!("0x{}1", "0".repeat(10_000));
        assert_eq!(
            v4(&long_zeros, false).as_deref(),
            Some("0.0.0.1"),
            "leading zeros do not overflow"
        );
    }

    #[test]
    fn only_ascii_digits() {
        for bad in [
            "１２７.0.0.1",
            "١٢٧.0.0.1",
            "127.0.0.１",
            "::ffff:127.0.0.１",
            "１::1",
        ] {
            assert_eq!(parse_address(bad, false), None, "{bad}");
        }
    }

    #[test]
    fn ipv6_forms() {
        let ok = [
            ("::", "::"),
            ("::1", "::1"),
            ("1::", "1::"),
            ("1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8"),
            ("1:2:3:4:5:6::8", "1:2:3:4:5:6:0:8"),
            ("::2:3:4:5:6:7:8", "0:2:3:4:5:6:7:8"),
            ("1:2:3:4:5:6:1.2.3.4", "1:2:3:4:5:6:102:304"),
            ("::1.2.3.4", "::102:304"),
            ("::ffff:1.2.3.4", "::ffff:102:304"),
            ("1::1.2.3.4", "1::102:304"),
            ("ABCD::EF01", "abcd::ef01"),
            ("0000:0000:0000:0000:0000:0000:0000:0001", "::1"),
        ];
        for (input, want) in ok {
            let got = parse_address(input, false).unwrap_or_else(|| panic!("{input}"));
            assert_eq!(got, IpAddr::V6(want.parse().unwrap()), "{input}");
        }
        for bad in [
            ":::",
            ":",
            ":1",
            "1:",
            "1::2::3",
            ":1::",
            "::1:2:3:4:5:6:7:8",
            "1:2:3:4:5:6:7::8",
            "1:2:3:4:5:6:7:8::",
            "1:2:3:4:5:6::1.2.3.4",
            "1:2:3:4:5:6:7:1.2.3.4",
            ":1.2.3.4",
            ":::1.2.3.4",
            "::1.2.3",
            "::01.2.3.4",
            "::1.2.3.4.5",
            "::1.2.3.4:5",
            "1.2.3.4::",
            "00000::1",
            "fe80::1%eth0",
            "::1/128",
        ] {
            assert_eq!(parse_address(bad, false), None, "{bad}");
        }
    }

    #[test]
    fn canonical_maps_only_ipv4_mapped() {
        let c = |s: &str| canonical(parse_address(s, false).unwrap());
        assert_eq!(c("::ffff:7f00:1"), IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)));
        assert_eq!(c("::ffff:0:0"), IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        assert!(c("::7f00:1").is_ipv6(), "IPv4-compatible stays IPv6");
        assert!(c("64:ff9b::7f00:1").is_ipv6(), "NAT64 stays IPv6");
        assert!(c("2002:7f00:1::1").is_ipv6(), "6to4 stays IPv6");
        assert!(
            c("::ffff:0:7f00:1").is_ipv6(),
            "the SIIT form is not mapped"
        );
        assert_eq!(c("10.0.0.1"), IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)));
    }
}
