//! Terms shared by lexical indexing and query analysis.
use super::js::{nfkc, nfkd};
use frostem::{Algorithm, Stemmer};
use std::{collections::HashSet, sync::LazyLock};
use unicode_casefold::UnicodeCaseFold;
use unicode_segmentation::UnicodeSegmentation;

/// Stored alongside derived terms; changing their meaning requires rebuilding.
pub const ANALYZER_ID: &str = "snowball-de-en-20260804-v1";
static DE: LazyLock<HashSet<&str>> =
    LazyLock::new(|| include_str!("stopwords/german.txt").lines().collect());
static EN: LazyLock<HashSet<&str>> =
    LazyLock::new(|| include_str!("stopwords/english.txt").lines().collect());

fn german_fold(word: &str) -> String {
    nfkd(word).chars().filter(|c| c.is_alphanumeric()).collect()
}

fn analyze(text: &str, german: bool) -> Vec<String> {
    let folded: String = nfkc(text).case_fold().collect();
    let mut terms = Vec::new();
    let stops = if german { &*DE } else { &*EN };
    let stemmer = Stemmer::new(if german {
        Algorithm::German
    } else {
        Algorithm::English
    });
    for token in folded.split_whitespace() {
        let token =
            token.trim_matches(|c: char| !c.is_alphanumeric() && !matches!(c, '-' | '/' | '_'));
        let identifier = token.contains(['.', '-', '@', '_', '/', '\\', ':']);
        if identifier && token.len() <= 128 {
            terms.push(token.to_owned());
        }
        for word in token
            .split(['.', '-', '@', '_', '/', '\\', ':'])
            .flat_map(UnicodeSegmentation::unicode_words)
        {
            if word.len() <= 128 && !stops.contains(word) {
                let word = if german {
                    german_fold(word)
                } else {
                    word.to_owned()
                };
                if !word.is_empty() {
                    terms.push(stemmer.stem(&word).into_owned());
                }
            }
        }
    }
    terms
}

/// Analyze a German field with folded diacritics and Snowball German.
pub fn analyze_de(text: &str) -> Vec<String> {
    analyze(text, true)
}
/// Analyze an English field with Porter2.
pub fn analyze_en(text: &str) -> Vec<String> {
    analyze(text, false)
}
/// Emit word-internal four-character grams for the compound comparison.
pub fn analyze_ngrams(text: &str) -> Vec<String> {
    let folded: String = nfkc(text).case_fold().collect();
    let mut grams = Vec::new();
    for word in folded.unicode_words() {
        let chars: Vec<char> = german_fold(word).chars().collect();
        grams.extend(chars.windows(4).map(|gram| gram.iter().collect::<String>()));
    }
    grams
}
