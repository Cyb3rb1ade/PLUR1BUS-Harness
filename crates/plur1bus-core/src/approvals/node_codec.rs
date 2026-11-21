//! `Buffer.from(text, "base64")` and `Buffer.from(text, "hex")` as Node reads them. Both are lenient, and the approval code
//! relies on what they return: the chain key and the signing identity are base64 in the secret store, a stored signature
//! and public key are base64 in `approval_signatures`, and the signed message is the hex MAC. A stricter decoder would call
//! a signature bad that TypeScript calls good (or a key corrupt that it accepts), so these follow Node, not RFC 4648.
//!
//! Base64 (`nbytes::Base64Decode`, the decoder Node falls back to whenever the forgiving decoder refuses; the two agree on
//! every input the forgiving one accepts): the output length is fixed first from the text (`base64ByteLength`: one or two
//! trailing `=` dropped, then three bytes per four characters); both alphabets are read (`+/` and `-_`); any other character
//! is skipped; a `=` ends the decoding; a UTF-16 unit is read by its low byte. Hex: two digits per byte, case-insensitive,
//! up to the first pair that is not hex; an odd last digit is dropped.

fn unbase64(c: u8) -> u8 {
    match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' | b'-' => 62,
        b'/' | b'_' => 63,
        _ => 255,
    }
}

/// `Buffer.from(text, "base64")`.
pub fn base64_decode(text: &str) -> Vec<u8> {
    let src: Vec<u8> = text.encode_utf16().map(|u| u as u8).collect();
    let units: Vec<u16> = text.encode_utf16().collect();
    // base64ByteLength works on the string's code units.
    let mut bytes = units.len();
    if bytes > 0 && units[bytes - 1] == 0x3d {
        bytes -= 1;
    }
    if bytes > 1 && units[bytes - 1] == 0x3d {
        bytes -= 1;
    }
    let dstlen = (bytes * 3) >> 2;
    let mut dst = vec![0u8; dstlen];
    let k = decode_into(&mut dst, &src);
    dst.truncate(k);
    dst
}

fn decode_into(dst: &mut [u8], src: &[u8]) -> usize {
    let srclen = src.len();
    let max_k = dst.len() / 3 * 3;
    let mut max_i = srclen / 4 * 4;
    let mut i = 0;
    let mut k = 0;
    while i < max_i && k < max_k {
        let t = [
            unbase64(src[i]),
            unbase64(src[i + 1]),
            unbase64(src[i + 2]),
            unbase64(src[i + 3]),
        ];
        if t.iter().any(|b| b & 0x80 != 0) {
            if !group_slow(dst, src, &mut i, &mut k) {
                return k;
            }
            max_i = i + (srclen - i) / 4 * 4;
        } else {
            let v = u32::from_be_bytes(t);
            dst[k] = (((v >> 22) & 0xfc) | ((v >> 20) & 0x03)) as u8;
            dst[k + 1] = (((v >> 12) & 0xf0) | ((v >> 10) & 0x0f)) as u8;
            dst[k + 2] = (((v >> 2) & 0xc0) | (v & 0x3f)) as u8;
            i += 4;
            k += 3;
        }
    }
    if i < srclen && k < dst.len() {
        group_slow(dst, src, &mut i, &mut k);
    }
    k
}

/// `Base64DecodeGroupSlow`: one group of four legal characters, skipping illegal ones; `false` ends the decoding.
fn group_slow(dst: &mut [u8], src: &[u8], i: &mut usize, k: &mut usize) -> bool {
    let srclen = src.len();
    let mut hi = 0u8;
    for step in 0..4 {
        let lo = loop {
            let c = src[*i];
            let lo = unbase64(c);
            *i += 1;
            if lo < 64 {
                break lo;
            }
            if c == b'=' || *i >= srclen {
                return false;
            }
        };
        match step {
            1 => {
                dst[*k] = ((hi & 0x3f) << 2) | ((lo & 0x30) >> 4);
                *k += 1;
            }
            2 => {
                dst[*k] = ((hi & 0x0f) << 4) | ((lo & 0x3c) >> 2);
                *k += 1;
            }
            3 => {
                dst[*k] = ((hi & 0x03) << 6) | (lo & 0x3f);
                *k += 1;
            }
            _ => {}
        }
        if *i >= srclen || *k >= dst.len() {
            return false;
        }
        hi = lo;
    }
    true
}

/// `Buffer.from(text, "hex")`.
pub fn hex_decode(text: &str) -> Vec<u8> {
    let digit = |u: u16| char::from_u32(u32::from(u)).and_then(|c| c.to_digit(16));
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut out = Vec::with_capacity(units.len() / 2);
    for pair in units.chunks_exact(2) {
        match (digit(pair[0]), digit(pair[1])) {
            (Some(a), Some(b)) => out.push((a * 16 + b) as u8),
            _ => break,
        }
    }
    out
}

/// Lower-case hex, as `digest("hex")` writes it.
pub fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn base64_reads_what_node_reads() {
        let std = base64::engine::general_purpose::STANDARD;
        for bytes in [
            &b""[..],
            b"a",
            b"ab",
            b"abc",
            b"abcd",
            &[0xff, 0xfe, 0xfd, 0x00][..],
        ] {
            assert_eq!(base64_decode(&std.encode(bytes)), bytes);
        }
        assert_eq!(
            base64_decode("YWJj ZA=="),
            b"abcd",
            "white space is skipped"
        );
        assert_eq!(
            base64_decode("_-8"),
            [0xff, 0xef],
            "the URL alphabet is read too"
        );
        assert_eq!(
            base64_decode("YWJj=ZGVm"),
            b"abc",
            "a `=` ends the decoding"
        );
        assert_eq!(base64_decode("YQ"), b"a", "padding is optional");
        assert_eq!(base64_decode("Y"), b"", "one character is nothing");
    }

    #[test]
    fn hex_stops_at_the_first_pair_that_is_not_hex() {
        assert_eq!(hex_decode("0aFFzz00"), [0x0a, 0xff]);
        assert_eq!(hex_decode("abc"), [0xab]);
        assert_eq!(hex_encode(&[0, 255, 16]), "00ff10");
    }
}
