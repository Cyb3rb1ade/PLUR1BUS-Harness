//! Parity with `packages/core/src/tools/web/ip.ts` through the shared, hand-committed vector file (desktop transport
//! choice spec §4.6). The TypeScript side is `packages/core/test/tools/web/ip-vectors.test.ts`; both suites read the
//! same rows and must agree on every one. The `categories` rows are read by this crate only (spec §4.3).

use plur1bus_desktop_net::{
    canonical, cidr_first_public, classify, parse_address, parse_cidr, table, target_class,
    AddrClass, Category, CLASSIFIER_ID, IANA_IPV4_SPECIAL, IANA_IPV6_SPECIAL,
};
use serde::Deserialize;
use std::collections::BTreeSet;
use std::net::IpAddr;

mod common;
use common::{bits, from_bits, range};

/// Located from this crate's manifest directory (`apps/desktop/net` → repository root), so the path is the same on
/// every OS and is compiled into the test binary.
const VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/core/test/fixtures/net/ip-classification-vectors.json"
));

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Vectors {
    classifier: String,
    registries: Registries,
    table: Vec<TableRow>,
    addresses: Vec<AddressRow>,
    #[serde(rename = "parseRejects")]
    parse_rejects: Vec<RejectRow>,
    #[serde(rename = "strictRejects")]
    strict_rejects: Vec<String>,
    cidrs: Vec<CidrRow>,
    categories: Vec<CategoryRow>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registries {
    ipv4: RegistryRef,
    ipv6: RegistryRef,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryRef {
    url: String,
    updated: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TableRow {
    cidr: String,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddressRow {
    input: String,
    canonical: String,
    public: bool,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RejectRow {
    input: String,
    strict: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CidrRow {
    input: String,
    #[serde(rename = "firstPublic")]
    first_public: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CategoryRow {
    input: String,
    category: String,
}

fn vectors() -> Vectors {
    serde_json::from_str(VECTORS).expect("the vector file is valid JSON of the spec §4.6 shape")
}

fn parse(s: &str) -> IpAddr {
    parse_address(s, false).unwrap_or_else(|| panic!("parseable: {s:?}"))
}

fn class_name(c: AddrClass) -> &'static str {
    match c {
        AddrClass::NotConnectable => "not-connectable",
        AddrClass::Connectable(Category::Loopback) => "loopback",
        AddrClass::Connectable(Category::Tailnet) => "tailnet",
        AddrClass::Connectable(Category::Private) => "private",
        AddrClass::Connectable(Category::Special) => "special",
        AddrClass::Connectable(Category::Public) => "public",
    }
}

#[test]
fn parity_classifier_id() {
    let v = vectors();
    assert_eq!(v.classifier, CLASSIFIER_ID);
    assert_eq!(CLASSIFIER_ID, "iana-special-2025-10-09");
    assert_eq!(v.registries.ipv4.url, IANA_IPV4_SPECIAL.url);
    assert_eq!(v.registries.ipv4.updated, IANA_IPV4_SPECIAL.updated);
    assert_eq!(v.registries.ipv6.url, IANA_IPV6_SPECIAL.url);
    assert_eq!(v.registries.ipv6.updated, IANA_IPV6_SPECIAL.updated);
}

#[test]
fn parity_table() {
    let v = vectors();
    let code = table();
    // 28 rows: 255.255.255.255 is a special case of the IPv4 verdict (inside 240.0.0.0/4), not a row.
    assert_eq!(code.len(), 28);
    assert_eq!(code.len(), v.table.len());
    for (i, ((cidr, reason), row)) in code.iter().zip(&v.table).enumerate() {
        assert_eq!(*cidr, row.cidr, "row {i} cidr");
        assert_eq!(reason.as_str(), row.reason, "row {i} reason");
        let c = parse_cidr(cidr).unwrap_or_else(|| panic!("row {i} parses: {cidr}"));
        // Every row is a non-public block, and none holds an embedded-IPv4 block.
        assert_eq!(
            cidr_first_public(&c),
            None,
            "row {i} {cidr}: no public address"
        );
    }
}

#[test]
fn parity_addresses() {
    let v = vectors();
    assert!(v.addresses.len() >= 200, "the file is not hollowed out");
    let mut seen = BTreeSet::new();
    for row in &v.addresses {
        assert!(
            seen.insert(row.input.as_str()),
            "duplicate input {:?}",
            row.input
        );
        let a = parse(&row.input);
        let verdict = classify(a);
        assert_eq!(verdict.public, row.public, "{:?}: public", row.input);
        assert_eq!(
            verdict.reason.map(|r| r.as_str()),
            row.reason.as_deref(),
            "{:?}: reason",
            row.input
        );
        if !row.public {
            assert!(
                row.reason.is_some(),
                "{:?}: a non-public row names its reason",
                row.input
            );
        }
        // Compared as addresses (family and bits), never as text: "::ffff:7f00:1" and "127.0.0.1" are one address.
        assert_eq!(
            canonical(a),
            parse(&row.canonical),
            "{:?}: canonical",
            row.input
        );
    }
}

/// A public row carries no `reason` key at all (not `null`); a non-public row carries a string. Checked on the raw
/// JSON because the typed row cannot tell a missing key from `null`.
#[test]
fn parity_address_rows_shape() {
    let raw: serde_json::Value = serde_json::from_str(VECTORS).expect("valid JSON");
    let rows = raw["addresses"].as_array().expect("addresses is an array");
    for row in rows {
        let obj = row.as_object().expect("an address row is an object");
        let public = obj["public"].as_bool().expect("public is a boolean");
        let keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        if public {
            assert!(
                !obj.contains_key("reason"),
                "{row}: a public row has no reason key"
            );
            assert_eq!(keys.len(), 3, "{row}");
        } else {
            assert!(obj["reason"].is_string(), "{row}: reason is a string");
            assert_eq!(keys.len(), 4, "{row}");
        }
    }
}

/// Every cidr row carries the `firstPublic` key, a string or `null`. The typed row reads a missing key as `None`
/// ("no public address"), so an omission would pass silently without this raw check.
#[test]
fn parity_cidr_rows_shape() {
    let raw: serde_json::Value = serde_json::from_str(VECTORS).expect("valid JSON");
    let rows = raw["cidrs"].as_array().expect("cidrs is an array");
    assert!(!rows.is_empty());
    for row in rows {
        let obj = row.as_object().expect("a cidr row is an object");
        assert!(obj["input"].is_string(), "{row}: input is a string");
        let first = obj
            .get("firstPublic")
            .unwrap_or_else(|| panic!("{row}: the firstPublic key is present"));
        assert!(
            first.is_string() || first.is_null(),
            "{row}: firstPublic is a string or null"
        );
        assert_eq!(obj.len(), 2, "{row}");
    }
}

#[test]
fn parity_parse_rejects() {
    let v = vectors();
    assert!(v.parse_rejects.len() >= 30);
    for row in &v.parse_rejects {
        assert_eq!(
            parse_address(&row.input, row.strict),
            None,
            "{:?} strict={}",
            row.input,
            row.strict
        );
    }
}

#[test]
fn parity_strict_rejects() {
    let v = vectors();
    assert!(v.strict_rejects.len() >= 10);
    for input in &v.strict_rejects {
        assert_eq!(parse_address(input, true), None, "{input:?}: strict");
        assert!(
            parse_address(input, false).is_some(),
            "{input:?}: still a legacy spelling in lenient mode"
        );
    }
}

#[test]
fn parity_cidrs() {
    let v = vectors();
    assert!(v.cidrs.len() >= 40);
    for row in &v.cidrs {
        let c = parse_cidr(&row.input).unwrap_or_else(|| panic!("parseable cidr: {:?}", row.input));
        let got = cidr_first_public(&c);
        let want = row.first_public.as_deref().map(parse);
        assert_eq!(got, want, "{:?}: lowest public address", row.input);
        if let Some(g) = got {
            // Family-preserving: an IPv6 range answers with an IPv6 address, also inside the embedded-IPv4 blocks.
            assert_eq!(g.is_ipv4(), c.addr.is_ipv4(), "{:?}: family", row.input);
        }
    }
}

#[test]
fn parity_categories() {
    let v = vectors();
    assert!(v.categories.len() >= 30);
    let mut seen = BTreeSet::new();
    let mut exercised = BTreeSet::new();
    for row in &v.categories {
        assert!(seen.insert(row.input.as_str()), "duplicate {:?}", row.input);
        let got = class_name(target_class(parse(&row.input)));
        assert_eq!(got, row.category, "{:?}: category", row.input);
        exercised.insert(got);
    }
    for c in [
        "loopback",
        "tailnet",
        "private",
        "special",
        "public",
        "not-connectable",
    ] {
        assert!(exercised.contains(c), "every category is exercised: {c}");
    }
}

/// For each vector range: the answer is public, inside the range, and the address just below it (when that one is
/// inside the range too) is not public. A range without an answer does not start with a public address.
#[test]
fn cidr_first_public_is_public_and_minimal() {
    let v = vectors();
    let mut answered = 0;
    for row in &v.cidrs {
        let c = parse_cidr(&row.input).unwrap_or_else(|| panic!("parseable cidr: {:?}", row.input));
        let v4 = c.addr.is_ipv4();
        let (lo, hi) = range(&c);
        match cidr_first_public(&c) {
            None => assert!(
                !classify(from_bits(v4, lo)).public,
                "{:?}: none, so the first is not public",
                row.input
            ),
            Some(got) => {
                answered += 1;
                assert!(
                    classify(got).public,
                    "{:?}: the answer is public",
                    row.input
                );
                let n = bits(got);
                assert_eq!(got.is_ipv4(), v4, "{:?}: family", row.input);
                assert!(
                    lo <= n && n <= hi,
                    "{:?}: the answer lies in the range",
                    row.input
                );
                if n > lo {
                    assert!(
                        !classify(from_bits(v4, n - 1)).public,
                        "{:?}: nothing public just below",
                        row.input
                    );
                }
            }
        }
    }
    assert!(answered >= 20, "the rows reach public space ({answered})");
}
