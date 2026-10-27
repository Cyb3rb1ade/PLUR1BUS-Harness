//! ECMAScript / Node 24.21 string, whitespace, regex, Unicode normalization, and collation
//! primitives (`RE-04/T0`).

use std::cmp::Ordering;
use std::fmt::{self, Write as _};
use std::sync::OnceLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{CollatorBorrowed, CollatorPreferences};
use icu_locale_core::{locale, Locale};
use icu_normalizer::{ComposingNormalizerBorrowed, DecomposingNormalizerBorrowed};

/// The Unicode version of the baked ICU4X 2.3.x tables and the pinned Node 24.21 runtime.
pub const RECORDED_UNICODE_VERSION: &str = "17.0";

/// The default `Intl.Collator` locale recorded under the pinned Node 24.21 runtime.
pub const RECORDED_COLLATOR_LOCALE: &str = "en-US";

/// ASCII-only word boundary assertion matching ECMAScript `\b` in non-Unicode and standard modes.
pub const ASCII_WORD_BOUNDARY: &str = r"(?-u:\b)";

/// ASCII-only non-word boundary assertion matching ECMAScript `\B`.
pub const ASCII_NON_WORD_BOUNDARY: &str = r"(?-u:\B)";

/// ASCII-only digit class matching ECMAScript `\d`.
pub const ASCII_DIGIT: &str = "[0-9]";

/// ASCII-only non-digit class matching ECMAScript `\D`.
pub const ASCII_NON_DIGIT: &str = "[^0-9]";

/// ASCII-only word character class matching ECMAScript `\w`.
pub const ASCII_WORD_CHAR: &str = "[A-Za-z0-9_]";

/// ASCII-only non-word character class matching ECMAScript `\W`.
pub const ASCII_NON_WORD_CHAR: &str = "[^A-Za-z0-9_]";

/// ASCII-only word boundary assertion for `fancy-regex` lookaround patterns.
const FANCY_ASCII_WORD_BOUNDARY: &str =
    "(?:(?<=(?-i:[A-Za-z0-9_]))(?!(?-i:[A-Za-z0-9_]))|(?<!(?-i:[A-Za-z0-9_]))(?=(?-i:[A-Za-z0-9_])))";

/// ASCII-only non-word boundary assertion for `fancy-regex` lookaround patterns.
const FANCY_ASCII_NON_WORD_BOUNDARY: &str =
    "(?:(?<=(?-i:[A-Za-z0-9_]))(?=(?-i:[A-Za-z0-9_]))|(?<!(?-i:[A-Za-z0-9_]))(?!(?-i:[A-Za-z0-9_])))";

/// Character-class body for the 25 ECMAScript `WhiteSpace` and `LineTerminator` code points.
const JS_WHITESPACE_RANGES: &str =
    "\\t\\n\\x0B\\x0C\\r \\u{00A0}\\u{1680}\\u{2000}-\\u{200A}\\u{2028}\\u{2029}\\u{202F}\\u{205F}\\u{3000}\\u{FEFF}";

/// Character class matching ECMAScript `\s` (includes `U+FEFF`, excludes `U+0085`).
pub const JS_WHITESPACE_CLASS: &str =
    "[\t\n\u{000B}\u{000C}\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

/// Negated character class matching ECMAScript `\S`.
pub const JS_NON_WHITESPACE_CLASS: &str =
    "[^\t\n\u{000B}\u{000C}\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

/// Returns the Unicode version of the ICU4X normalizer and collator data tables.
#[must_use]
pub const fn icu_unicode_version() -> &'static str {
    RECORDED_UNICODE_VERSION
}

/// Returns `true` if `ch` is one of the 25 ECMAScript `WhiteSpace` or `LineTerminator` code
/// points matched by JavaScript `\s` and `String.prototype.trim()`.
///
/// Notably, `U+FEFF` (BOM) is `true` and `U+0085` (NEL) is `false`.
#[must_use]
pub const fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// Trims leading and trailing ECMAScript whitespace code points, matching `String.prototype.trim`.
#[must_use]
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// Trims leading ECMAScript whitespace code points, matching `String.prototype.trimStart`.
#[must_use]
pub fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_whitespace)
}

/// Trims trailing ECMAScript whitespace code points, matching `String.prototype.trimEnd`.
#[must_use]
pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_whitespace)
}

/// Converts `s` to lowercase using Unicode default case conversion (`SpecialCasing.txt`),
/// matching `String.prototype.toLowerCase()`.
#[must_use]
pub fn js_to_lower_case(s: &str) -> String {
    s.to_lowercase()
}

/// Returns the length of `s` in UTF-16 code units, matching JavaScript `s.length`.
#[must_use]
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// A JavaScript string represented as a sequence of 16-bit UTF-16 code units (`Vec<u16>`),
/// capable of holding unpaired high or low surrogates produced by `String.prototype.slice`
/// or tolerant JSON parsing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct JsString {
    units: Vec<u16>,
}

impl JsString {
    /// Creates a `JsString` from raw UTF-16 code units, preserving any unpaired surrogates.
    #[must_use]
    pub const fn from_utf16_units(units: Vec<u16>) -> Self {
        Self { units }
    }

    /// Encodes a well-formed UTF-8 string slice into a `JsString`.
    #[must_use]
    pub fn from_utf8_str(s: &str) -> Self {
        Self {
            units: s.encode_utf16().collect(),
        }
    }

    /// Returns the underlying UTF-16 code units.
    #[must_use]
    pub fn as_utf16_units(&self) -> &[u16] {
        &self.units
    }

    /// Consumes the `JsString` and returns its underlying UTF-16 code units.
    #[must_use]
    pub fn into_utf16_units(self) -> Vec<u16> {
        self.units
    }

    /// Returns the number of UTF-16 code units in this string (`s.length` in JS).
    #[must_use]
    pub fn utf16_len(&self) -> usize {
        self.units.len()
    }

    /// Returns `true` if this string contains zero UTF-16 code units.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.units.is_empty()
    }

    /// Slices this `JsString` by UTF-16 code unit indices `[start..end]`, clamping to
    /// `0..=self.utf16_len()` like `String.prototype.slice(start, end)` for non-negative bounds.
    #[must_use]
    pub fn utf16_slice(&self, start: usize, end: usize) -> Self {
        let len = self.units.len();
        let clamped_start = start.min(len);
        let clamped_end = end.min(len).max(clamped_start);
        Self {
            units: self.units[clamped_start..clamped_end].to_vec(),
        }
    }

    /// Converts this `JsString` to a UTF-8 `String`, replacing any unpaired surrogate code unit
    /// with `U+FFFD` (`REPLACEMENT CHARACTER`), matching `Buffer.from(s, "utf8")`.
    #[must_use]
    pub fn to_utf8_lossy(&self) -> String {
        String::from_utf16_lossy(&self.units)
    }

    /// Serializes this `JsString` as a JSON string literal (including surrounding quotes),
    /// matching ECMAScript `JSON.stringify` (`QuoteJSONString`): paired surrogates are emitted
    /// as their supplementary UTF-8 character, while lone surrogates are emitted as lowercase
    /// `\ud800`..`\udfff` escapes.
    #[must_use]
    pub fn to_json(&self) -> String {
        let mut out = String::with_capacity(self.units.len() + 2);
        out.push('"');
        let mut i = 0;
        while i < self.units.len() {
            let u = self.units[i];
            match u {
                0x0008 => out.push_str("\\b"),
                0x0009 => out.push_str("\\t"),
                0x000A => out.push_str("\\n"),
                0x000C => out.push_str("\\f"),
                0x000D => out.push_str("\\r"),
                0x0022 => out.push_str("\\\""),
                0x005C => out.push_str("\\\\"),
                0x0000..=0x001F => {
                    let _ = write!(&mut out, "\\u{u:04x}");
                }
                0xD800..=0xDBFF => {
                    if let Some(&lo) = self.units.get(i + 1) {
                        if (0xDC00..=0xDFFF).contains(&lo) {
                            let cp = 0x10000
                                + (((u32::from(u) - 0xD800) << 10) | (u32::from(lo) - 0xDC00));
                            if let Some(ch) = char::from_u32(cp) {
                                out.push(ch);
                                i += 2;
                                continue;
                            }
                        }
                    }
                    let _ = write!(&mut out, "\\u{u:04x}");
                }
                0xDC00..=0xDFFF => {
                    let _ = write!(&mut out, "\\u{u:04x}");
                }
                _ => {
                    if let Some(ch) = char::from_u32(u32::from(u)) {
                        out.push(ch);
                    }
                }
            }
            i += 1;
        }
        out.push('"');
        out
    }
}

impl From<&str> for JsString {
    fn from(value: &str) -> Self {
        Self::from_utf8_str(value)
    }
}

impl From<String> for JsString {
    fn from(value: String) -> Self {
        Self::from_utf8_str(&value)
    }
}

/// Slices a UTF-8 string `s` by UTF-16 code unit indices `[start..end]`, returning a [`JsString`]
/// that preserves lone surrogates if the cut lands inside a surrogate pair.
#[must_use]
pub fn utf16_slice(s: &str, start: usize, end: usize) -> JsString {
    JsString::from_utf8_str(s).utf16_slice(start, end)
}

/// Error returned when compiling or executing a JavaScript regular expression via [`js_regex`].
#[derive(Debug)]
pub enum JsRegexError {
    /// An unsupported or duplicate flag was passed to [`js_regex`] or [`js_ascii_regex`].
    InvalidFlag(char),
    /// The underlying `fancy-regex` compilation or execution failed.
    Fancy(fancy_regex::Error),
    /// The underlying `regex` crate compilation failed.
    Standard(regex::Error),
}

impl fmt::Display for JsRegexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFlag(flag) => write!(f, "unsupported JS regex flag: {flag:?}"),
            Self::Fancy(err) => write!(f, "{err}"),
            Self::Standard(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for JsRegexError {}

/// A single match produced by [`JsRegex::find_all`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsRegexMatch {
    /// The matched substring.
    pub matched: String,
    /// Start byte offset in the UTF-8 input.
    pub byte_start: usize,
    /// End byte offset in the UTF-8 input.
    pub byte_end: usize,
}

/// A compiled JavaScript-compatible regular expression backed by `fancy_regex`.
#[derive(Debug)]
pub struct JsRegex {
    inner: fancy_regex::Regex,
}

impl JsRegex {
    /// Returns `true` if the pattern matches anywhere in `text` (matching `RegExp.prototype.test`
    /// without sticky state).
    ///
    /// # Errors
    ///
    /// Returns [`JsRegexError::Fancy`] if backtracking exceeds runtime limits.
    pub fn is_match(&self, text: &str) -> Result<bool, JsRegexError> {
        self.inner.is_match(text).map_err(JsRegexError::Fancy)
    }

    /// Finds all non-overlapping matches of the pattern in `text`.
    ///
    /// # Errors
    ///
    /// Returns [`JsRegexError::Fancy`] if backtracking exceeds runtime limits.
    pub fn find_all(&self, text: &str) -> Result<Vec<JsRegexMatch>, JsRegexError> {
        let mut out = Vec::new();
        for res in self.inner.find_iter(text) {
            let m = res.map_err(JsRegexError::Fancy)?;
            out.push(JsRegexMatch {
                matched: m.as_str().to_owned(),
                byte_start: m.start(),
                byte_end: m.end(),
            });
        }
        Ok(out)
    }
}

/// Translates a JavaScript regex pattern and flags (`g`, `i`, `m`, `s`, `u`) into a pattern for
/// either `fancy-regex` (`use_fancy_boundaries = true`) or the `regex` crate
/// (`use_fancy_boundaries = false`), where `\b`, `\B`, `\d`, `\D`, `\w`, `\W`, `\s`, and `\S`
/// preserve ECMAScript semantics.
fn translate_js_pattern(
    pattern: &str,
    flags: &str,
    use_fancy_boundaries: bool,
) -> Result<String, JsRegexError> {
    let mut case_insensitive = false;
    let mut multi_line = false;
    let mut dot_all = false;

    for ch in flags.chars() {
        match ch {
            'g' | 'u' => {}
            'i' => case_insensitive = true,
            'm' => multi_line = true,
            's' => dot_all = true,
            other => return Err(JsRegexError::InvalidFlag(other)),
        }
    }

    let mut out = String::with_capacity(pattern.len() + 32);
    if case_insensitive || multi_line || dot_all {
        out.push_str("(?");
        if case_insensitive {
            out.push('i');
        }
        if multi_line {
            out.push('m');
        }
        if dot_all {
            out.push('s');
        }
        out.push(')');
    }

    let word_boundary = if use_fancy_boundaries {
        FANCY_ASCII_WORD_BOUNDARY
    } else {
        ASCII_WORD_BOUNDARY
    };
    let non_word_boundary = if use_fancy_boundaries {
        FANCY_ASCII_NON_WORD_BOUNDARY
    } else {
        ASCII_NON_WORD_BOUNDARY
    };

    let mut chars = pattern.chars().peekable();
    let mut class_depth: usize = 0;

    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(escaped) = chars.next() {
                let in_class = class_depth > 0;
                match (escaped, in_class) {
                    ('b', false) => out.push_str(word_boundary),
                    ('B', false) => out.push_str(non_word_boundary),
                    ('b', true) => out.push_str("\\x08"),
                    ('d', false) => out.push_str(ASCII_DIGIT),
                    ('d', true) => out.push_str("0-9"),
                    ('D', false) => out.push_str(ASCII_NON_DIGIT),
                    ('w', false) => out.push_str("(?-i:[A-Za-z0-9_])"),
                    ('w', true) => out.push_str("A-Za-z0-9_"),
                    ('W', false) => out.push_str("(?-i:[^A-Za-z0-9_])"),
                    ('s', false) => {
                        out.push('[');
                        out.push_str(JS_WHITESPACE_RANGES);
                        out.push(']');
                    }
                    ('s', true) => out.push_str(JS_WHITESPACE_RANGES),
                    ('S', false) => {
                        out.push_str("[^");
                        out.push_str(JS_WHITESPACE_RANGES);
                        out.push(']');
                    }
                    _ => {
                        out.push('\\');
                        out.push(escaped);
                    }
                }
            } else {
                out.push('\\');
            }
            continue;
        }

        if ch == '[' && class_depth == 0 {
            class_depth = 1;
            out.push('[');
            if chars.peek() == Some(&'^') {
                if let Some(caret) = chars.next() {
                    out.push(caret);
                }
            }
            if chars.peek() == Some(&']') {
                if let Some(closing) = chars.next() {
                    out.push(closing);
                }
            }
            continue;
        }

        if ch == ']' && class_depth > 0 {
            class_depth = 0;
            out.push(']');
            continue;
        }

        out.push(ch);
    }

    Ok(out)
}

/// Compiles a non-lookaround JavaScript regular expression (`pattern`, `flags`) into a
/// [`regex::Regex`] using [`ASCII_WORD_BOUNDARY`] (`(?-u:\b)`), [`ASCII_DIGIT`] (`[0-9]`),
/// [`ASCII_WORD_CHAR`] (`[A-Za-z0-9_]`), and ECMAScript `\s` whitespace.
///
/// # Errors
///
/// Returns [`JsRegexError`] if `flags` contains an unsupported flag or the pattern fails to
/// compile in the `regex` crate.
pub fn js_ascii_regex(pattern: &str, flags: &str) -> Result<regex::Regex, JsRegexError> {
    let translated = translate_js_pattern(pattern, flags, false)?;
    regex::Regex::new(&translated).map_err(JsRegexError::Standard)
}

/// Compiles a JavaScript regular expression (`pattern`, `flags`) over `fancy-regex`, preserving
/// ECMAScript ASCII `\b`/`\d`/`\w`, JS `\s` whitespace, Unicode property escapes `\p{...}`, and
/// lookaround assertions.
///
/// # Errors
///
/// Returns [`JsRegexError`] if `flags` contains an unsupported flag or the pattern fails to
/// compile.
pub fn js_regex(pattern: &str, flags: &str) -> Result<JsRegex, JsRegexError> {
    let translated = translate_js_pattern(pattern, flags, true)?;
    let inner = fancy_regex::Regex::new(&translated).map_err(JsRegexError::Fancy)?;
    Ok(JsRegex { inner })
}

/// Normalizes `s` to Unicode Normalization Form KD (NFKD) using ICU4X 2.3 data, matching
/// `s.normalize("NFKD")`.
#[must_use]
pub fn nfkd(s: &str) -> String {
    DecomposingNormalizerBorrowed::new_nfkd()
        .normalize(s)
        .into_owned()
}

/// Normalizes `s` to Unicode Normalization Form C (NFC) using ICU4X 2.3 data, matching
/// `s.normalize("NFC")`.
#[must_use]
pub fn nfc(s: &str) -> String {
    ComposingNormalizerBorrowed::new_nfc()
        .normalize(s)
        .into_owned()
}

/// Normalizes `s` to Unicode Normalization Form KC (NFKC) using ICU4X 2.3 data, matching
/// `s.normalize("NFKC")`.
#[must_use]
pub fn nfkc(s: &str) -> String {
    ComposingNormalizerBorrowed::new_nfkc()
        .normalize(s)
        .into_owned()
}

/// Error returned when constructing an ICU4X collator for an explicit locale string.
#[derive(Debug)]
pub enum JsCollationError {
    /// The locale string is not a valid BCP-47 locale identifier.
    InvalidLocale(String),
    /// ICU4X failed to load collation data for the requested preferences.
    DataError(String),
}

impl fmt::Display for JsCollationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLocale(loc) => write!(f, "invalid collation locale: {loc:?}"),
            Self::DataError(msg) => write!(f, "collation data error: {msg}"),
        }
    }
}

impl std::error::Error for JsCollationError {}

fn default_collator() -> Option<&'static CollatorBorrowed<'static>> {
    static COLLATOR: OnceLock<Option<CollatorBorrowed<'static>>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            let prefs: CollatorPreferences = locale!("en-US").into();
            CollatorBorrowed::try_new(prefs, CollatorOptions::default()).ok()
        })
        .as_ref()
}

/// Compares `a` and `b` using the pinned Node 24.21 default collator locale (`en-US`), matching
/// single-argument `a.localeCompare(b)` without reading the host operating system's locale.
#[must_use]
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    if let Some(collator) = default_collator() {
        collator.compare(a, b)
    } else {
        a.cmp(b)
    }
}

/// Compares `a` and `b` as potentially ill-formed UTF-16 unit slices using the pinned `en-US`
/// collator.
#[must_use]
pub fn locale_compare_utf16(a: &[u16], b: &[u16]) -> Ordering {
    if let Some(collator) = default_collator() {
        collator.compare_utf16(a, b)
    } else {
        a.cmp(b)
    }
}

/// Compares `a` and `b` under an explicit BCP-47 `locale_str` with default `Intl.Collator`
/// options.
///
/// # Errors
///
/// Returns [`JsCollationError`] if `locale_str` cannot be parsed or collation data is unavailable.
pub fn locale_compare_with_locale(
    a: &str,
    b: &str,
    locale_str: &str,
) -> Result<Ordering, JsCollationError> {
    let parsed = Locale::try_from_str(locale_str)
        .map_err(|_| JsCollationError::InvalidLocale(locale_str.to_owned()))?;
    let prefs: CollatorPreferences = parsed.into();
    let collator = CollatorBorrowed::try_new(prefs, CollatorOptions::default())
        .map_err(|e| JsCollationError::DataError(e.to_string()))?;
    Ok(collator.compare(a, b))
}
