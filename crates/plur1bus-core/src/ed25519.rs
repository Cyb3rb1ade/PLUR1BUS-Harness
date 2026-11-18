//! Ed25519 verification with the acceptance set of Node's verifier.
//!
//! The TypeScript core verifies Ed25519 through `node:crypto`, which is OpenSSL. `ring` and OpenSSL agree on the
//! verification equation (no cofactor, the recomputed R compared as bytes, S below the group order), but OpenSSL also
//! refuses a public key and a signature half R that encode a point of small order, and `ring` does not. With such a key
//! the equation holds for signatures nobody needed a private key for (P4-K review B, RB-1). The port therefore refuses
//! those encodings before `ring` is asked, so it accepts what the TypeScript verifier accepts and nothing more.
//!
//! Nothing here is curve arithmetic. The eight points of small order have fourteen encodings between them (the canonical
//! ones, a sign bit on x = 0, y not below the field prime), told apart by seven values of y; they are compared as bytes,
//! the list libsodium keeps for the same purpose. A key whose y is not below the field prime is refused as well: every
//! such encoding of small order is on the list, and for the others nobody holds a private key, so no vector can show
//! which way OpenSSL decides there; refusing is the direction that can never accept more than Node.
//!
//! The comparisons are not constant-time on purpose: keys and signatures are public.
//!
//! Vectors: `fixtures/parity/approvals/ed25519.json` (decision signatures) and the `eddsa` cases of
//! `fixtures/parity/openai-auth/jwks.json` (id tokens), both built by `scripts/parity/ed25519-cases.ts`.
use ring::signature::{UnparsedPublicKey, ED25519};

/// The y coordinates (little endian, the sign bit cleared) of every encoding of a point of small order.
const SMALL_ORDER_Y: [[u8; 32]; 7] = [
    // y = 0, order 4.
    [0; 32],
    // y = 1, the neutral point.
    [
        0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0,
    ],
    // Order 8.
    [
        0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0, 0x45, 0xc3, 0xf4, 0x89, 0xf2, 0xef, 0x98,
        0xf0, 0xd5, 0xdf, 0xac, 0x05, 0xd3, 0xc6, 0x33, 0x39, 0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53,
        0xfc, 0x05,
    ],
    // Order 8.
    [
        0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b, 0x76, 0x0d, 0x10, 0x67,
        0x0f, 0x2a, 0x20, 0x53, 0xfa, 0x2c, 0x39, 0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac,
        0x03, 0x7a,
    ],
    // y = p - 1, order 2.
    [
        0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x7f,
    ],
    // y = p, which is 0 again (order 4), not canonical.
    [
        0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x7f,
    ],
    // y = p + 1, which is 1 again (the neutral point), not canonical.
    [
        0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x7f,
    ],
];

/// The y of an encoded point: the encoding without its sign bit.
fn y_of(point: &[u8; 32]) -> [u8; 32] {
    let mut y = *point;
    y[31] &= 0x7f;
    y
}

/// Whether `point` encodes one of the eight points of small order, in any of its encodings.
pub fn has_small_order(point: &[u8; 32]) -> bool {
    let y = y_of(point);
    SMALL_ORDER_Y.contains(&y)
}

/// Whether the y of `point` is below the field prime 2^255 - 19 (the sign bit is not part of y).
pub fn has_canonical_y(point: &[u8; 32]) -> bool {
    // p is ed ff .. ff 7f in little endian: y reaches it only with every byte above the lowest at its maximum.
    let [low, middle @ .., high] = y_of(point);
    !(high == 0x7f && middle.iter().all(|b| *b == 0xff) && low >= 0xed)
}

/// Whether `signature` is an Ed25519 signature of `message` under `public_key` that Node's verifier accepts. `false` for
/// anything else, a key or a signature of the wrong length included; never an error.
pub fn verify(public_key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let Ok(key) = <&[u8; 32]>::try_from(public_key) else {
        return false;
    };
    let Some(r) = signature
        .get(..32)
        .and_then(|r| <&[u8; 32]>::try_from(r).ok())
    else {
        return false;
    };
    if !has_canonical_y(key) || has_small_order(key) || has_small_order(r) {
        return false;
    }
    UnparsedPublicKey::new(&ED25519, key)
        .verify(message, signature)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../fixtures/parity/approvals/ed25519.json"
        ))
        .unwrap()
    }

    fn point(hex: &str) -> [u8; 32] {
        let bytes = crate::approvals::node_codec::hex_decode(hex);
        <[u8; 32]>::try_from(bytes.as_slice()).unwrap()
    }

    #[test]
    fn every_encoding_of_a_point_of_small_order_is_told() {
        let f = fixture();
        let list = f["smallOrder"].as_array().unwrap();
        assert_eq!(list.len(), 14);
        for e in list {
            assert!(
                has_small_order(&point(e["hex"].as_str().unwrap())),
                "{}",
                e["name"]
            );
        }
        // One list entry per value of y, and every entry is needed: without it one of the fourteen is missed.
        for skip in 0..SMALL_ORDER_Y.len() {
            let missed = list.iter().any(|e| {
                let y = y_of(&point(e["hex"].as_str().unwrap()));
                !SMALL_ORDER_Y
                    .iter()
                    .enumerate()
                    .any(|(i, s)| i != skip && *s == y)
            });
            assert!(missed, "entry {skip} is redundant");
        }
    }

    #[test]
    fn honest_points_are_not_of_small_order_and_canonical() {
        let f = fixture();
        let mut accepted = 0;
        for c in f["verify"].as_array().unwrap() {
            if c["ok"] != Value::Bool(true) {
                continue;
            }
            accepted += 1;
            let der = crate::approvals::node_codec::base64_decode(c["publicKey"].as_str().unwrap());
            let key = <[u8; 32]>::try_from(&der[12..44]).unwrap();
            let sig = crate::approvals::node_codec::base64_decode(c["signature"].as_str().unwrap());
            let r = <[u8; 32]>::try_from(&sig[..32]).unwrap();
            assert!(has_canonical_y(&key), "{}", c["name"]);
            assert!(!has_small_order(&key), "{}", c["name"]);
            assert!(!has_small_order(&r), "{}", c["name"]);
        }
        assert!(accepted >= 17, "{accepted}");
    }

    #[test]
    fn canonical_y_ends_just_below_the_field_prime() {
        let mut p = [0xff_u8; 32];
        p[0] = 0xed;
        p[31] = 0x7f;
        assert!(!has_canonical_y(&p), "y = p");
        let mut below = p;
        below[0] = 0xec;
        assert!(has_canonical_y(&below), "y = p - 1");
        let mut above = p;
        above[0] = 0xee;
        assert!(!has_canonical_y(&above), "y = p + 1");
        let mut top = p;
        top[0] = 0xff;
        assert!(!has_canonical_y(&top), "y = 2^255 - 1");
        // The sign bit is not part of y.
        let mut signed = below;
        signed[31] = 0xff;
        assert!(has_canonical_y(&signed), "y = p - 1 with the sign bit");
        let mut signed_p = p;
        signed_p[31] = 0xff;
        assert!(!has_canonical_y(&signed_p), "y = p with the sign bit");
        // Any byte below 0xff further up keeps y below p, whatever the lowest byte is.
        for i in 1..31 {
            let mut y = p;
            y[0] = 0xff;
            y[i] = 0xfe;
            assert!(has_canonical_y(&y), "byte {i}");
        }
        let mut high = p;
        high[0] = 0xff;
        high[31] = 0x7e;
        assert!(has_canonical_y(&high), "top byte");
        assert!(has_canonical_y(&[0; 32]));
    }

    #[test]
    fn a_key_or_signature_of_the_wrong_length_is_refused() {
        let f = fixture();
        let c = &f["verify"][0];
        assert_eq!(c["ok"], Value::Bool(true));
        let der = crate::approvals::node_codec::base64_decode(c["publicKey"].as_str().unwrap());
        let key = &der[12..44];
        let sig = crate::approvals::node_codec::base64_decode(c["signature"].as_str().unwrap());
        let mac = crate::approvals::node_codec::hex_decode(c["mac"].as_str().unwrap());
        assert!(verify(key, &mac, &sig));
        assert!(!verify(&key[..31], &mac, &sig));
        assert!(!verify(&der[11..44], &mac, &sig));
        assert!(!verify(key, &mac, &sig[..63]));
        assert!(!verify(key, &mac, &sig[..31]));
        assert!(!verify(key, &mac, &[]));
        let mut long = sig.clone();
        long.push(0);
        assert!(!verify(key, &mac, &long));
    }

    /// The whole corpus at the level of the raw key: Node's verdict for every case.
    #[test]
    fn every_case_of_the_corpus_gets_nodes_verdict() {
        let f = fixture();
        let mut wrong = Vec::new();
        let cases = f["verify"].as_array().unwrap();
        for c in cases {
            let der = crate::approvals::node_codec::base64_decode(c["publicKey"].as_str().unwrap());
            let sig = crate::approvals::node_codec::base64_decode(c["signature"].as_str().unwrap());
            let mac = crate::approvals::node_codec::hex_decode(c["mac"].as_str().unwrap());
            let got = verify(&der[12..], &mac, &sig);
            if got != c["ok"].as_bool().unwrap() {
                wrong.push(format!(
                    "{} / {}: node {} rust {got}",
                    c["group"], c["name"], c["ok"]
                ));
            }
        }
        assert!(
            wrong.is_empty(),
            "{} of {} cases differ:\n{}",
            wrong.len(),
            cases.len(),
            wrong.join("\n")
        );
    }
}
