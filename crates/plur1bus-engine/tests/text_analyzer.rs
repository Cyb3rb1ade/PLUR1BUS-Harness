//! Retrieval field compatibility and identifier handling.
use plur1bus_engine::text::analyzer::{analyze_de, analyze_en, analyze_ngrams};

#[test]
fn stop_words_are_removed_before_stemming() {
    assert!(analyze_de("den dass und").is_empty());
    assert!(analyze_en("was are and").is_empty());
}
#[test]
fn mueller_and_mueller_with_umlaut_share_a_term() {
    for word in ["Müller", "Mueller", "Muller"] {
        assert_eq!(analyze_de(word), ["mull"]);
    }
}
#[test]
fn an_identifier_is_kept_whole_and_split() {
    let terms = analyze_en("memory_ops.rs");
    for word in ["memory_ops.rs", "memori", "op", "rs"] {
        assert!(terms.iter().any(|t| t == word), "{terms:?}");
    }
}
#[test]
fn the_english_field_never_applies_german_folding() {
    assert_eq!(analyze_en("Michael blue"), ["michael", "blue"]);
}
#[test]
fn a_44_char_compound_is_indexed() {
    assert!(!analyze_de(&"abcd".repeat(11)).is_empty());
    assert_eq!(analyze_ngrams("ab cd"), Vec::<String>::new());
}

#[test]
fn analyzer_terms_equal_the_golden_vectors() {
    assert_eq!(
        analyze_de("DASS Müllers messen 1.024,75"),
        ["mull", "mess", "1.024,75"]
    );
    assert_eq!(
        analyze_en("Connections remain 1.024,75"),
        ["connect", "remain", "1.024,75"]
    );
    assert_eq!(analyze_ngrams("Übung ABCD"), ["ubun", "bung", "abcd"]);
}
