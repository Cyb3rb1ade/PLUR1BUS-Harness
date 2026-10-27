//! Parity tests for JavaScript text semantics, `JsString`, tolerant JSON, and `text-utils`
//! against Node 24.21 vectors recorded in `tests/fixtures/text/`.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::path::PathBuf;

use plur1bus_engine::text::js::{
    icu_unicode_version, is_js_whitespace, js_ascii_regex, js_regex, js_to_lower_case, js_trim,
    locale_compare, locale_compare_with_locale, nfc, nfkc, nfkd, utf16_len, utf16_slice, JsString,
    ASCII_DIGIT, ASCII_WORD_BOUNDARY, ASCII_WORD_CHAR,
};
use plur1bus_engine::text::json::{parse_json, parse_json_str, write_json};
use plur1bus_engine::text::legacy::text_utils::{
    compress_memory_slots_for_prompt, generate_summary, jaccard_similarity, tokenize,
    PromptMemoryEntry, PromptMemorySlot,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("text")
        .join(name)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsVectorsFile {
    runtime: RuntimeInfo,
    whitespace: Vec<WhitespaceVector>,
    strings: Vec<StringSampleVector>,
    locale_compare: Vec<LocaleCompareSiteVector>,
    ascii_boundaries: Vec<AsciiBoundaryVector>,
    lookarounds: Vec<LookaroundVector>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    #[allow(dead_code)]
    node: String,
    unicode: String,
    #[allow(dead_code)]
    icu: String,
    collator_locale: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WhitespaceVector {
    code_point: u32,
    hex: String,
    matches_js_whitespace: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StringSampleVector {
    name: String,
    input: String,
    utf16_len: usize,
    trimmed: String,
    lowered: String,
    nfkd: String,
    nfc: String,
    nfkc: String,
    slices: Vec<SliceVector>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SliceVector {
    end: usize,
    utf16_units: Vec<u16>,
    json: String,
    utf8_lossy: String,
    sha256_raw: String,
    sha256_json_material: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocaleCompareSiteVector {
    site: String,
    args: Vec<String>,
    keys: Vec<String>,
    sorted: Vec<String>,
    pairs: Vec<LocaleComparePairVector>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocaleComparePairVector {
    a: String,
    b: String,
    sign: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AsciiBoundaryVector {
    name: String,
    pattern: String,
    flags: String,
    results: Vec<AsciiBoundaryResult>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AsciiBoundaryResult {
    input: String,
    matched: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LookaroundVector {
    name: String,
    pattern: String,
    flags: String,
    results: Vec<LookaroundResult>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LookaroundResult {
    input: String,
    matched: bool,
    matches: Vec<LookaroundMatch>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LookaroundMatch {
    #[serde(rename = "match")]
    matched_text: String,
    byte_start: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextUtilsFile {
    tokenize: Vec<TokenizeVector>,
    jaccard_similarity: Vec<JaccardVector>,
    generate_summary: Vec<GenerateSummaryVector>,
    compress_memory_slots_for_prompt: Vec<CompressSlotsVector>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenizeVector {
    input: String,
    tokens: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JaccardVector {
    a: String,
    b: String,
    similarity: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateSummaryVector {
    text: String,
    max_words: usize,
    summary: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompressSlotsVector {
    name: String,
    token_budget: usize,
    memories: Vec<RecordedMemorySlot>,
    slots: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordedMemorySlot {
    entry: RecordedMemoryEntry,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordedMemoryEntry {
    id: String,
    text: String,
    summary: String,
    category: String,
    memory_class: String,
}

fn load_js_vectors() -> JsVectorsFile {
    let bytes = std::fs::read(fixture_path("js-vectors.json")).expect("read js-vectors.json");
    serde_json::from_slice(&bytes).expect("parse js-vectors.json")
}

fn load_text_utils_vectors() -> TextUtilsFile {
    let bytes = std::fs::read(fixture_path("text-utils.json")).expect("read text-utils.json");
    serde_json::from_slice(&bytes).expect("parse text-utils.json")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

#[test]
fn js_whitespace_matches_node_for_every_recorded_code_point() {
    let vectors = load_js_vectors();
    assert!(!vectors.whitespace.is_empty());

    let mut saw_feff = false;
    let mut saw_nel = false;
    for entry in &vectors.whitespace {
        let ch = char::from_u32(entry.code_point).expect("valid scalar value");
        assert_eq!(
            is_js_whitespace(ch),
            entry.matches_js_whitespace,
            "whitespace mismatch for {} ({})",
            entry.hex,
            entry.code_point
        );
        if entry.code_point == 0xFEFF {
            assert!(entry.matches_js_whitespace, "U+FEFF must be JS whitespace");
            saw_feff = true;
        }
        if entry.code_point == 0x0085 {
            assert!(
                !entry.matches_js_whitespace,
                "U+0085 (NEL) must not be JS whitespace"
            );
            saw_nel = true;
        }
    }
    assert!(saw_feff && saw_nel);
}

#[test]
fn utf16_len_and_slice_match_node() {
    let vectors = load_js_vectors();
    for sample in &vectors.strings {
        assert_eq!(
            utf16_len(&sample.input),
            sample.utf16_len,
            "utf16_len mismatch on sample {}",
            sample.name
        );
        for slice in &sample.slices {
            let sliced = utf16_slice(&sample.input, 0, slice.end);
            assert_eq!(
                sliced.as_utf16_units(),
                slice.utf16_units.as_slice(),
                "utf16_slice units mismatch on sample {} (end={})",
                sample.name,
                slice.end
            );
            assert_eq!(
                sliced.to_json(),
                slice.json,
                "to_json mismatch on sample {} (end={})",
                sample.name,
                slice.end
            );
            assert_eq!(
                sliced.to_utf8_lossy(),
                slice.utf8_lossy,
                "to_utf8_lossy mismatch on sample {} (end={})",
                sample.name,
                slice.end
            );
            assert_eq!(
                sha256_hex(sliced.to_utf8_lossy().as_bytes()),
                slice.sha256_raw,
                "sha256Raw mismatch on sample {} (end={})",
                sample.name,
                slice.end
            );
            let json_material = format!(r#"["neo-stable-id-v1","statement",{}]"#, sliced.to_json());
            assert_eq!(
                sha256_hex(json_material.as_bytes()),
                slice.sha256_json_material,
                "sha256JsonMaterial mismatch on sample {} (end={})",
                sample.name,
                slice.end
            );
        }
    }
}

#[test]
fn a_cut_inside_a_surrogate_pair_serialises_as_the_json_escape_and_as_u_fffd_in_utf8() {
    // "Grüße 🚀" -> 'G'(1) 'r'(1) 'ü'(1) 'ß'(1) 'e'(1) ' '(1) '🚀'(2 UTF-16 units: 0xD83D, 0xDE80)
    let cut = utf16_slice("Grüße 🚀", 0, 7);
    assert_eq!(cut.utf16_len(), 7);
    assert_eq!(cut.as_utf16_units().last().copied(), Some(0xD83D));
    assert_eq!(cut.to_json(), r#""Grüße \ud83d""#);
    assert_eq!(cut.to_utf8_lossy(), "Grüße \u{FFFD}");

    // Also verify leading low surrogate when slicing the second half of a surrogate pair.
    let low_half = utf16_slice("🚀 Start", 1, 8);
    assert_eq!(low_half.as_utf16_units().first().copied(), Some(0xDE80));
    assert_eq!(low_half.to_json(), r#""\ude80 Start""#);
    assert_eq!(low_half.to_utf8_lossy(), "\u{FFFD} Start");
}

#[test]
fn the_tolerant_json_reader_keeps_a_lone_surrogate_escape_byte_identically() {
    let raw = std::fs::read_to_string(fixture_path("json-lines.jsonl"))
        .expect("read json-lines.jsonl")
        .replace("\r\n", "\n");
    let lines: Vec<&str> = raw.lines().filter(|l| !l.is_empty()).collect();
    assert!(!lines.is_empty());

    for (idx, line) in lines.iter().enumerate() {
        let value = parse_json(line).unwrap_or_else(|e| panic!("line {idx} parse failed: {e}"));
        let re_emitted = write_json(&value);
        assert_eq!(
            re_emitted, *line,
            "JSONL line {idx} was not re-emitted byte-identically"
        );
    }

    let single_str: JsString =
        parse_json_str(r#""Grüße \ud83d""#).expect("parse tolerant JSON string");
    assert_eq!(single_str.to_json(), r#""Grüße \ud83d""#);
    assert_eq!(single_str.to_utf8_lossy(), "Grüße \u{FFFD}");
}

#[test]
fn ascii_word_boundary_never_matches_before_a_leading_umlaut() {
    assert_eq!(ASCII_WORD_BOUNDARY, r"(?-u:\b)");
    assert_eq!(ASCII_DIGIT, "[0-9]");
    assert_eq!(ASCII_WORD_CHAR, "[A-Za-z0-9_]");

    let vectors = load_js_vectors();
    for case in &vectors.ascii_boundaries {
        let compiled_fancy = js_regex(&case.pattern, &case.flags)
            .unwrap_or_else(|e| panic!("failed to compile fancy {}: {e}", case.name));
        let compiled_standard = js_ascii_regex(&case.pattern, &case.flags)
            .unwrap_or_else(|e| panic!("failed to compile standard {}: {e}", case.name));
        for probe in &case.results {
            let actual_fancy = compiled_fancy
                .is_match(&probe.input)
                .unwrap_or_else(|e| panic!("match failed on {}: {e}", case.name));
            assert_eq!(
                actual_fancy, probe.matched,
                "ASCII boundary (fancy-regex) mismatch in {} for input {:?}",
                case.name, probe.input
            );
            assert_eq!(
                compiled_standard.is_match(&probe.input),
                probe.matched,
                "ASCII boundary (regex crate) mismatch in {} for input {:?}",
                case.name,
                probe.input
            );
        }
    }
}

#[test]
fn lookaround_patterns_compile_and_match_like_node() {
    let vectors = load_js_vectors();
    for case in &vectors.lookarounds {
        let compiled = js_regex(&case.pattern, &case.flags)
            .unwrap_or_else(|e| panic!("failed to compile lookaround {}: {e}", case.name));
        for probe in &case.results {
            let is_match = compiled
                .is_match(&probe.input)
                .unwrap_or_else(|e| panic!("is_match failed on {}: {e}", case.name));
            assert_eq!(
                is_match, probe.matched,
                "lookaround is_match mismatch in {} for {:?}",
                case.name, probe.input
            );
            let matches = compiled
                .find_all(&probe.input)
                .unwrap_or_else(|e| panic!("find_all failed on {}: {e}", case.name));
            assert_eq!(
                matches.len(),
                probe.matches.len(),
                "lookaround match count mismatch in {} for {:?}",
                case.name,
                probe.input
            );
            for (actual, expected) in matches.iter().zip(probe.matches.iter()) {
                assert_eq!(
                    actual.matched, expected.matched_text,
                    "lookaround text mismatch in {} for {:?}",
                    case.name, probe.input
                );
                assert_eq!(
                    actual.byte_start, expected.byte_start,
                    "lookaround byte_start mismatch in {} for {:?}",
                    case.name, probe.input
                );
            }
        }
    }
}

#[test]
fn normalization_matches_node_and_the_unicode_version_is_the_recorded_one() {
    let vectors = load_js_vectors();
    assert_eq!(
        icu_unicode_version(),
        vectors.runtime.unicode,
        "ICU4X Unicode version must match recorded Node process.versions.unicode"
    );

    for sample in &vectors.strings {
        assert_eq!(
            nfkd(&sample.input),
            sample.nfkd,
            "NFKD mismatch on sample {}",
            sample.name
        );
        assert_eq!(
            nfc(&sample.input),
            sample.nfc,
            "NFC mismatch on sample {}",
            sample.name
        );
        assert_eq!(
            nfkc(&sample.input),
            sample.nfkc,
            "NFKC mismatch on sample {}",
            sample.name
        );
    }
}

#[test]
fn locale_compare_matches_node_under_the_recorded_locale() {
    let vectors = load_js_vectors();
    let locale = &vectors.runtime.collator_locale;

    for site in &vectors.locale_compare {
        assert!(
            site.args.is_empty(),
            "unexpected localeCompare args at site {}: {:?}",
            site.site,
            site.args
        );
        for pair in &site.pairs {
            let expected = pair.sign.cmp(&0);
            let actual = locale_compare_with_locale(&pair.a, &pair.b, locale)
                .expect("valid recorded collator locale");
            assert_eq!(
                actual, expected,
                "locale_compare mismatch at {} for ({:?}, {:?})",
                site.site, pair.a, pair.b
            );
            assert_eq!(
                locale_compare(&pair.a, &pair.b),
                expected,
                "default locale_compare mismatch at {} for ({:?}, {:?})",
                site.site,
                pair.a,
                pair.b
            );
        }

        let mut sorted = site.keys.clone();
        sorted.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(
            sorted, site.sorted,
            "sorted key order mismatch at {}",
            site.site
        );
    }
}

#[test]
fn trim_and_lowercase_match_node() {
    let vectors = load_js_vectors();
    for sample in &vectors.strings {
        assert_eq!(
            js_trim(&sample.input),
            sample.trimmed,
            "js_trim mismatch on sample {}",
            sample.name
        );
        assert_eq!(
            js_to_lower_case(&sample.input),
            sample.lowered,
            "js_to_lower_case mismatch on sample {}",
            sample.name
        );
    }
}

#[test]
fn text_utils_tokenize_splits_umlaut_words_like_node() {
    let vectors = load_text_utils_vectors();
    for case in &vectors.tokenize {
        assert_eq!(
            tokenize(&case.input),
            case.tokens,
            "tokenize mismatch for input {:?}",
            case.input
        );
    }
}

#[test]
fn jaccard_generate_summary_and_compress_match_node() {
    let vectors = load_text_utils_vectors();

    for case in &vectors.jaccard_similarity {
        let actual = jaccard_similarity(&case.a, &case.b);
        assert!(
            (actual - case.similarity).abs() <= 1e-12,
            "jaccard_similarity mismatch for ({:?}, {:?}): actual={} expected={}",
            case.a,
            case.b,
            actual,
            case.similarity
        );
    }

    for case in &vectors.generate_summary {
        assert_eq!(
            generate_summary(&case.text, case.max_words),
            case.summary,
            "generate_summary mismatch for max_words={} text={:?}",
            case.max_words,
            case.text
        );
    }

    for case in &vectors.compress_memory_slots_for_prompt {
        let memories: Vec<PromptMemorySlot> = case
            .memories
            .iter()
            .map(|m| PromptMemorySlot {
                entry: PromptMemoryEntry {
                    id: m.entry.id.clone(),
                    text: m.entry.text.clone(),
                    summary: m.entry.summary.clone(),
                    category: m.entry.category.clone(),
                    memory_class: m.entry.memory_class.clone(),
                },
            })
            .collect();
        assert_eq!(
            compress_memory_slots_for_prompt(&memories, case.token_budget),
            case.slots,
            "compress_memory_slots_for_prompt mismatch on case {}",
            case.name
        );
    }
}
