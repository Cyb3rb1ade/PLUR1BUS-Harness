//! Replay of `fixtures/parity/js/*.json` (recorded by `scripts/parity/export-js.ts`).
use super::*;
use serde_json::Value;
use sha2::{Digest, Sha256};

fn load(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/parity/js/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A string of the fixtures: a JSON string, or `{"u16": [units]}` when it holds a lone surrogate.
fn decode(v: &Value) -> Vec<u16> {
    match v {
        Value::String(s) => s.encode_utf16().collect(),
        Value::Object(o) => o["u16"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as u16)
            .collect(),
        other => panic!("not a string: {other}"),
    }
}

fn units_of(v: &Value) -> Vec<u16> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_u64().unwrap() as u16)
        .collect()
}

fn all_units() -> impl Iterator<Item = u16> {
    0..=u16::MAX
}

#[test]
fn strings_length_trim_boundaries_json_and_case() {
    let file = load("strings");
    let cases = file["cases"].as_array().unwrap();
    assert!(cases.len() > 150);
    let mut fails = Vec::new();
    for case in cases {
        let s = decode(&case["s"]);
        let label = format!("{:?}", String::from_utf16_lossy(&s));
        if s.len() != case["length"].as_u64().unwrap() as usize {
            fails.push(format!("length {label}"));
        }
        if trim_units(&s) != decode(&case["trim"]).as_slice() {
            fails.push(format!("trim {label}"));
        }
        let boundaries: Vec<usize> = (0..=s.len()).filter(|i| is_boundary(&s, *i)).collect();
        let want: Vec<usize> = case["boundaries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as usize)
            .collect();
        if boundaries != want {
            fails.push(format!("boundaries {label}: {boundaries:?} vs {want:?}"));
        }
        if json_stringify_units(&s) != case["jsonStringify"].as_str().unwrap() {
            fails.push(format!("json {label}"));
        }
        if let Ok(text) = String::from_utf16(&s) {
            if utf16_len(&text) != s.len() {
                fails.push(format!("utf16_len {label}"));
            }
            if js_trim(&text).encode_utf16().collect::<Vec<_>>() != decode(&case["trim"]) {
                fails.push(format!("js_trim {label}"));
            }
            if json_stringify(&text) != case["jsonStringify"].as_str().unwrap() {
                fails.push(format!("json_stringify {label}"));
            }
            if let Some(upper) = case.get("upper") {
                if to_upper_case(&text) != upper.as_str().unwrap() {
                    fails.push(format!("upper {label}"));
                }
                if to_lower_case(&text) != case["lower"].as_str().unwrap() {
                    fails.push(format!("lower {label}"));
                }
            }
        }
    }
    assert!(
        fails.is_empty(),
        "{} differ: {:?}",
        fails.len(),
        &fails[..fails.len().min(8)]
    );
}

#[test]
fn space_and_word_classes_agree_over_every_code_unit() {
    let file = load("classes");
    let space = units_of(&file["space"]);
    let word = units_of(&file["word"]);
    assert_eq!(
        all_units()
            .filter(|u| is_space_unit(*u))
            .collect::<Vec<_>>(),
        space
    );
    assert_eq!(
        all_units().filter(|u| is_word_unit(*u)).collect::<Vec<_>>(),
        word
    );
    assert_eq!(space.len(), 25);
    assert_eq!(word.len(), 63);
}

#[test]
fn case_insensitive_matching_is_canonicalize_over_every_code_unit() {
    let file = load("classes");
    let probes = file["probes"].as_object().unwrap();
    assert!(probes.len() > 40);
    for (probe, matched) in probes {
        let want = units_of(matched);
        let got: Vec<u16> =
            if let Some(letter) = probe.chars().next().filter(|_| probe.chars().count() == 1) {
                let lit = letter as u16;
                all_units().filter(|u| eq_ignore_case(lit, *u)).collect()
            } else {
                // A class: the unit matches when its canonical form is the canonical form of a member.
                let members: Vec<u16> = match probe.as_str() {
                    "[A-Z]" => (b'A'..=b'Z').map(u16::from).collect(),
                    "[a-z]" => (b'a'..=b'z').map(u16::from).collect(),
                    "[0-9A-Z]" => (b'0'..=b'9').chain(b'A'..=b'Z').map(u16::from).collect(),
                    "[A-Za-z0-9]" => (b'0'..=b'9')
                        .chain(b'A'..=b'Z')
                        .chain(b'a'..=b'z')
                        .map(u16::from)
                        .collect(),
                    "[A-Za-z0-9_-]" => (b'0'..=b'9')
                        .chain(b'A'..=b'Z')
                        .chain(b'a'..=b'z')
                        .chain([b'_', b'-'])
                        .map(u16::from)
                        .collect(),
                    other => panic!("unknown probe {other}"),
                };
                all_units()
                    .filter(|u| members.iter().any(|m| eq_ignore_case(*m, *u)))
                    .collect()
            };
        assert_eq!(got, want, "probe {probe}");
    }
}

#[test]
fn named_characters_do_not_fold_into_ascii() {
    let file = load("classes");
    let chars: Vec<String> = file["namedChars"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().to_owned())
        .collect();
    let patterns: Vec<String> = file["namedPatterns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().to_owned())
        .collect();
    for row in file["namedMatrix"].as_array().unwrap() {
        let ch: Vec<u16> = row["ch"].as_str().unwrap().encode_utf16().collect();
        assert_eq!(ch.len(), 1);
        for (pattern, want) in patterns.iter().zip(row["matches"].as_array().unwrap()) {
            let got = match pattern.as_str() {
                "\\w" => is_word_unit(ch[0]),
                "\\b" => is_boundary(&ch, 0),
                "[A-Z]" | "[a-z]" => (b'A'..=b'Z').any(|m| eq_ignore_case(u16::from(m), ch[0])),
                p => {
                    let lit: Vec<u16> = p.encode_utf16().collect();
                    lit.len() == 1 && eq_ignore_case(lit[0], ch[0])
                }
            };
            // Two-letter patterns (`ss`) match a single character never.
            assert_eq!(
                got,
                want.as_bool().unwrap(),
                "{:?} against /{pattern}/i",
                row["ch"]
            );
        }
    }
    assert!(chars.iter().any(|c| c == "ſ") && chars.iter().any(|c| c == "\u{212a}"));
    // The two characters the task names: neither folds, in either direction.
    assert!(!eq_ignore_case(u16::from(b's'), 0x17f) && !eq_ignore_case(u16::from(b'S'), 0x17f));
    assert!(!eq_ignore_case(u16::from(b'k'), 0x212a) && !eq_ignore_case(u16::from(b'K'), 0x212a));
    assert!(!eq_ignore_case(u16::from(b'i'), 0x131) && !eq_ignore_case(u16::from(b'I'), 0x130));
    assert!(eq_ignore_case(0xfc, 0xdc), "ü matches Ü");
    assert!(
        !eq_ignore_case(0xdf, u16::from(b's')),
        "ß matches nothing but itself"
    );
}

#[test]
fn upper_and_lower_case_mapping_agree_over_every_scalar_value() {
    let digests = load("digests");
    let (mut upper, mut lower, mut n) = (Vec::new(), Vec::new(), 0usize);
    for cp in 0..=0x10ffffu32 {
        let Some(c) = char::from_u32(cp) else {
            continue;
        };
        let s = c.to_string();
        upper.push(to_upper_case(&s));
        lower.push(to_lower_case(&s));
        n += 1;
    }
    assert_eq!(n as u64, digests["scalars"].as_u64().unwrap());
    let sha = |parts: &[String]| format!("{:x}", Sha256::digest(parts.join("\n").as_bytes()));
    let (u, l) = (sha(&upper), sha(&lower));
    let mut diff = Vec::new();
    if u != digests["upperSha256"].as_str().unwrap() {
        diff.push("toUpperCase");
    }
    if l != digests["lowerSha256"].as_str().unwrap() {
        diff.push("toLowerCase");
    }
    assert!(
        diff.is_empty(),
        "case mapping differs from Node over the scalar values: {diff:?} (Unicode table versions)"
    );
}

#[test]
fn default_sort_order_is_utf16_code_unit_order() {
    for case in load("sort")["cases"].as_array().unwrap() {
        let mut got: Vec<String> = case["input"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| String::from_utf16_lossy(&decode(s)))
            .collect();
        // A lone surrogate cannot be a Rust string; those lists are compared on the units.
        let mut got_units: Vec<Vec<u16>> = case["input"]
            .as_array()
            .unwrap()
            .iter()
            .map(decode)
            .collect();
        got_units.sort();
        let want_units: Vec<Vec<u16>> = case["expected"]
            .as_array()
            .unwrap()
            .iter()
            .map(decode)
            .collect();
        assert_eq!(got_units, want_units, "{:?}", case["input"]);
        if got_units.iter().all(|u| String::from_utf16(u).is_ok()) {
            sort_default(&mut got);
            let want: Vec<String> = want_units
                .iter()
                .map(|u| String::from_utf16(u).unwrap())
                .collect();
            assert_eq!(got, want, "{:?}", case["input"]);
        }
    }
    // The order is not the UTF-8 order: U+FF5E sorts after a surrogate pair there, before it here.
    assert_eq!(compare_utf16("\u{1F600}", "\u{FF5E}"), Ordering::Less);
    assert_eq!("\u{1F600}".cmp("\u{FF5E}"), Ordering::Greater);
}
