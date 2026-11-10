//! `lib/query-refiner.js` parity at the Node pin (RE-D151).
//!
//! `fixtures/recall/query-refiner.json` was recorded twice by `record-query-refiner.mjs`
//! from the SHA-checked pin source; both recordings were byte-identical.
#![allow(clippy::unwrap_used, reason = "parity fixtures fail immediately")]

use plur1bus_engine::recall::query_refiner::{
    expand_query, refine_query, remove_stopwords, should_refine, RefinementTop, STOPWORDS, SYNONYMS,
};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/recall/query-refiner.json")).unwrap()
}

#[test]
fn the_fixture_binds_the_pinned_source() {
    let source = &fixture()["source"];
    assert_eq!(source["commit"], "9f34008c143c5da87b2194b5a28442b407ff8ba7");
    assert_eq!(source["path"], "lib/query-refiner.js");
    assert_eq!(
        source["sha256"],
        "136e4aa6b2408bffbe6a02791b118818abb5ae4e1c3a25d1565b27373453c389"
    );
}

#[test]
fn the_tables_are_the_pinned_tables() {
    let tables = &fixture()["tables"];
    let stopwords = tables["stopwords"]
        .as_array()
        .unwrap()
        .iter()
        .map(|word| word.as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(stopwords, STOPWORDS);
    let synonyms = tables["synonyms"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| (pair[0].as_str().unwrap(), pair[1].as_str().unwrap()))
        .collect::<Vec<_>>();
    assert_eq!(synonyms, SYNONYMS);
}

fn top(results: &Value) -> Option<RefinementTop<'_>> {
    let first = results.as_array()?.first()?;
    Some(RefinementTop {
        score: first["score"].as_f64(),
        entry: first.get("entry").map(|entry| {
            (
                entry["summary"].as_str().unwrap_or(""),
                entry["text"].as_str().unwrap_or(""),
            )
        }),
    })
}

#[test]
fn every_recorded_input_matches_node() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 40);
    for case in cases {
        let input = case["input"].as_str().unwrap();
        assert_eq!(
            remove_stopwords(input),
            case["removeStopwords"].as_str().unwrap(),
            "removeStopwords({input:?})"
        );
        assert_eq!(
            expand_query(input),
            case["expandQuery"].as_str().unwrap(),
            "expandQuery({input:?})"
        );
        for refined in case["refineQuery"].as_array().unwrap() {
            assert_eq!(
                refine_query(input, top(&refined["results"])),
                refined["output"].as_str().unwrap(),
                "refineQuery({input:?}, {})",
                refined["results"]
            );
        }
    }
}

#[test]
fn refinement_fires_only_without_a_hit_at_the_minimum() {
    assert!(should_refine(&[], 0.2));
    assert!(should_refine(&[0.1, 0.19], 0.2));
    assert!(!should_refine(&[0.1, 0.2], 0.2));
}

/// RE-D151 exception (T1 re-review N2): the pin's `SYNONYM_MAP[w.toLowerCase()]` also reads
/// inherited `Object.prototype` members; the native port gives such words no synonym.
/// `record-query-refiner-exceptions.mjs` recorded Node's output next to the native expectation.
#[test]
fn inherited_object_members_are_a_recorded_native_exception() {
    let marker: Value = serde_json::from_str(include_str!(
        "fixtures/recall/query-refiner-native-exceptions.json"
    ))
    .unwrap();
    assert_eq!(marker["exception"], "RE-D151");
    assert_eq!(marker["source"], fixture()["source"]);
    let cases = marker["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let input = case["input"].as_str().unwrap();
        assert_eq!(
            expand_query(input),
            case["native"]["expandQuery"],
            "{input}"
        );
        assert_eq!(
            refine_query(input, None),
            case["native"]["refineQuery"],
            "{input}"
        );
        assert_ne!(case["node"]["expandQuery"], case["native"]["expandQuery"]);
        assert!(case["node"]["expandQuery"]
            .as_str()
            .unwrap()
            .contains("[native code]"));
    }
}
