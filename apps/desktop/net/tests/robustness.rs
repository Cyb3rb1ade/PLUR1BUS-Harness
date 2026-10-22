//! No input makes the parser or the classifier panic, and the parser stays linear and allocation-free on long input.

use plur1bus_desktop_net::{
    canonical, cidr_first_public, classify, in_cidr, is_tailnet, parse_address, parse_cidr,
    target_class,
};

mod common;
use common::Rng;

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
