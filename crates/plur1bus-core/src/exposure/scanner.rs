//! `memory-sensitivity/{types,scanner}.ts`: the sensitivity categories, the five classifiers and `computeContentHash`.
//!
//! The classifiers are written by hand, one matcher per JavaScript pattern, over UTF-16 code units (the unit a JavaScript
//! regular expression without the `u` flag works on, so a lone surrogate and a surrogate pair behave as they do there). No
//! regular-expression crate. What the patterns need of JavaScript is in [`crate::js`]: ASCII-only `\b`, the `\s` class and
//! the `i` flag's `Canonicalize`. The keyword tables are the alternations of the patterns written out (`(?:is|e)`, `?` and
//! `[_-]` expanded, `\s*` written as a space); `fixtures/parity/exposure/keywords.json` carries the expansion computed from
//! the TypeScript pattern source and a test compares the tables to it.
use crate::js::{
    eq_ignore_case, is_boundary, is_space_unit, is_word_unit, sort_default, trim_units, utf16,
};
use plur1bus_log_schema::redact::{RedactError, RedactOptions, Redactor};
use sha2::{Digest, Sha256};

/// `SENSITIVITY_CATEGORIES`.
pub const SENSITIVITY_CATEGORIES: [&str; 5] =
    ["health", "financial", "credential", "identity", "personal"];

/// `SENSITIVITY_SOURCES`.
pub const SENSITIVITY_SOURCES: [&str; 3] = ["rule", "manual", "model"];

/// `isSensitivityCategory`.
pub fn is_sensitivity_category(cat: &str) -> bool {
    SENSITIVITY_CATEGORIES.contains(&cat)
}

/// `MemorySensitivityRecord`.
#[derive(Clone, Debug, PartialEq)]
pub struct MemorySensitivityRecord {
    /// `cardId`
    pub card_id: String,
    /// `contentHash`
    pub content_hash: String,
    /// `categories`
    pub categories: Vec<String>,
    /// `source`: one of [`SENSITIVITY_SOURCES`].
    pub source: String,
    /// `updatedAt`
    pub updated_at: f64,
}

/// `computeContentHash` over code units: `sha256((text ?? "").trim() + "\n" + (summary ?? "").trim())` as UTF-8, hex. A lone
/// surrogate encodes as U+FFFD, as `createHash().update(s, "utf8")` does.
pub fn compute_content_hash_units(text: &[u16], summary: &[u16]) -> String {
    let mut norm: Vec<u16> = trim_units(text).to_vec();
    norm.push(0x0a);
    norm.extend_from_slice(trim_units(summary));
    let bytes = String::from_utf16_lossy(&norm).into_bytes();
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `computeContentHash(text, summary)`.
pub fn compute_content_hash(text: &str, summary: Option<&str>) -> String {
    compute_content_hash_units(&utf16(text), &utf16(summary.unwrap_or("")))
}

/// `HEALTH_RE`: `\b(?:diagnos(?:is|e)|prescript(?:ion|e)|rezept|medicat(?:ion|e)|medikament|illness|krankheit|disease|hospital|
/// krankenhaus|doctor|arzt|medical|gesundheit|befund|treatment|behandlung|symptom(?:e|s)?|therap(?:y|ie)|patient|blutdruck|
/// blood\s*pressure|diabetes|cancer|krebs|allerg(?:y|ie)|hypertension|asthma)\b` with the `i` flag. A space is `\s*`.
pub const HEALTH: &[&str] = &[
    "diagnosis",
    "diagnose",
    "prescription",
    "prescripte",
    "rezept",
    "medication",
    "medicate",
    "medikament",
    "illness",
    "krankheit",
    "disease",
    "hospital",
    "krankenhaus",
    "doctor",
    "arzt",
    "medical",
    "gesundheit",
    "befund",
    "treatment",
    "behandlung",
    "symptom",
    "symptome",
    "symptoms",
    "therapy",
    "therapie",
    "patient",
    "blutdruck",
    "blood pressure",
    "diabetes",
    "cancer",
    "krebs",
    "allergy",
    "allergie",
    "hypertension",
    "asthma",
];

/// `FINANCIAL_KEYWORDS_RE`: `\b(?:iban|bic|swift|bank\s*account|routing\s*number|kreditkarte|credit\s*card|debit\s*card|
/// bankverbindung|kontonummer|bankleitzahl|gehalt|salary|payroll|überweisung|wire\s*transfer)\b` with the `i` flag.
pub const FINANCIAL: &[&str] = &[
    "iban",
    "bic",
    "swift",
    "bank account",
    "routing number",
    "kreditkarte",
    "credit card",
    "debit card",
    "bankverbindung",
    "kontonummer",
    "bankleitzahl",
    "gehalt",
    "salary",
    "payroll",
    "überweisung",
    "wire transfer",
];

/// `IDENTITY_RE`: `\b(?:passport|reisepass|social\s*security|ssn|sozialversicherung|driver'?s\s*license|führerschein|
/// national\s*id|personalausweis|ausweisnummer|steuer[_-]?id|tax\s*id|steueridentifikationsnummer|birth\s*certificate|
/// geburtsurkunde)\b` with the `i` flag.
pub const IDENTITY: &[&str] = &[
    "passport",
    "reisepass",
    "social security",
    "ssn",
    "sozialversicherung",
    "driver's license",
    "drivers license",
    "führerschein",
    "national id",
    "personalausweis",
    "ausweisnummer",
    "steuer_id",
    "steuer-id",
    "steuerid",
    "tax id",
    "steueridentifikationsnummer",
    "birth certificate",
    "geburtsurkunde",
];

/// `PERSONAL_RE`: `\b(?:date\s*of\s*birth|geburtsdatum|home\s*address|wohnort|privatadresse|private\s*address|
/// personal\s*phone|handynummer|marital\s*status|familienstand|religion|confession)\b` with the `i` flag.
pub const PERSONAL: &[&str] = &[
    "date of birth",
    "geburtsdatum",
    "home address",
    "wohnort",
    "privatadresse",
    "private address",
    "personal phone",
    "handynummer",
    "marital status",
    "familienstand",
    "religion",
    "confession",
];

/// One keyword at `start`: each character matches under `/i` (a space is `\s*`, greedy; the next character of every keyword
/// is a letter or a symbol, never white space, so no backtracking into the run can help), then `\b` must hold at the end.
fn keyword_at(units: &[u16], start: usize, keyword: &[u16]) -> bool {
    let mut at = start;
    for &k in keyword {
        if k == 0x20 {
            while units.get(at).is_some_and(|u| is_space_unit(*u)) {
                at += 1;
            }
        } else if units.get(at).is_some_and(|u| eq_ignore_case(k, *u)) {
            at += 1;
        } else {
            return false;
        }
    }
    is_boundary(units, at)
}

/// `/\b(?:k1|k2|...)\b/i.test(text)` for keywords of [`HEALTH`]'s notation.
pub fn matches_keywords(units: &[u16], keywords: &[&str]) -> bool {
    let compiled: Vec<Vec<u16>> = keywords.iter().map(|k| utf16(k)).collect();
    (0..=units.len())
        .filter(|i| is_boundary(units, *i))
        .any(|i| compiled.iter().any(|k| keyword_at(units, i, k)))
}

fn digit(u: Option<&u16>) -> bool {
    u.is_some_and(|u| (0x30..=0x39).contains(u))
}

fn digits(units: &[u16], at: usize, n: usize) -> bool {
    (at..at + n).all(|i| digit(units.get(i)))
}

fn alnum(u: Option<&u16>) -> bool {
    u.is_some_and(|u| matches!(*u, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a))
}

fn letter(u: Option<&u16>) -> bool {
    u.is_some_and(|u| matches!(*u, 0x41..=0x5a | 0x61..=0x7a))
}

/// The source text of `IBAN_RE` (flags `i`), checked against the TypeScript by `fixtures/parity/exposure/keywords.json`.
pub const IBAN_PATTERN: &str = "[A-Z]{2}[0-9]{2}(?:[ ]?[0-9A-Z]{4}){2,7}(?:[ ]?[0-9A-Z]{1,4})?";

/// The source text of `CARD_RE` (no flags), checked against the TypeScript by `fixtures/parity/exposure/keywords.json`.
pub const CARD_PATTERN: &str = "(?:4[0-9]{3}(?:[ -]?[0-9]{4}){3}(?:[ -]?[0-9]{3})?|5[1-5][0-9]{2}(?:[ -]?[0-9]{4}){3}|2[2-7][0-9]{2}(?:[ -]?[0-9]{4}){3}|3[47][0-9]{2}[ -]?[0-9]{6}[ -]?[0-9]{5}|3[47][0-9]{13}|6(?:011|5[0-9]{2})(?:[ -]?[0-9]{4}){3}|(?:[0-9]{4}[ -]){3}[0-9]{4})";

/// `IBAN_RE` = `/[A-Z]{2}[0-9]{2}(?:[ ]?[0-9A-Z]{4}){2,7}(?:[ ]?[0-9A-Z]{1,4})?/i`. The optional tail and the repetitions beyond
/// two never decide whether a match exists; each group is deterministic (a space is not alphanumeric). Under `/i` the class
/// `[A-Z]` holds exactly the ASCII letters (vector `probes["[A-Z]"]`).
pub fn matches_iban(units: &[u16]) -> bool {
    (0..units.len()).any(|i| {
        if !(letter(units.get(i)) && letter(units.get(i + 1)) && digits(units, i + 2, 2)) {
            return false;
        }
        let mut at = i + 4;
        for _ in 0..2 {
            let q = if units.get(at) == Some(&0x20) {
                at + 1
            } else {
                at
            };
            if (q..q + 4).all(|j| alnum(units.get(j))) {
                at = q + 4;
            } else {
                return false;
            }
        }
        true
    })
}

fn sep(u: Option<&u16>) -> bool {
    matches!(u, Some(0x20 | 0x2d))
}

/// `(?:[ -]?[0-9]{4}){3}` at `at`: the end of the match.
fn three_groups(units: &[u16], mut at: usize) -> Option<usize> {
    for _ in 0..3 {
        let q = if sep(units.get(at)) { at + 1 } else { at };
        if !digits(units, q, 4) {
            return None;
        }
        at = q + 4;
    }
    Some(at)
}

fn card_at(units: &[u16], i: usize) -> bool {
    let u = |k: usize| units.get(i + k).copied();
    let in_range = |k: usize, lo: u8, hi: u8| {
        u(k).is_some_and(|c| (u16::from(lo)..=u16::from(hi)).contains(&c))
    };
    // 4[0-9]{3}(?:[ -]?[0-9]{4}){3}  (the trailing optional group never decides a match)
    if u(0) == Some(0x34) && digits(units, i + 1, 3) && three_groups(units, i + 4).is_some() {
        return true;
    }
    // 5[1-5][0-9]{2}(?:[ -]?[0-9]{4}){3}
    if u(0) == Some(0x35)
        && in_range(1, b'1', b'5')
        && digits(units, i + 2, 2)
        && three_groups(units, i + 4).is_some()
    {
        return true;
    }
    // 2[2-7][0-9]{2}(?:[ -]?[0-9]{4}){3}
    if u(0) == Some(0x32)
        && in_range(1, b'2', b'7')
        && digits(units, i + 2, 2)
        && three_groups(units, i + 4).is_some()
    {
        return true;
    }
    let amex = u(0) == Some(0x33) && (u(1) == Some(0x34) || u(1) == Some(0x37));
    // 3[47][0-9]{2}[ -]?[0-9]{6}[ -]?[0-9]{5}
    if amex && digits(units, i + 2, 2) {
        let p = i + 4;
        let q = if sep(units.get(p)) { p + 1 } else { p };
        if digits(units, q, 6) {
            let r = q + 6;
            let s = if sep(units.get(r)) { r + 1 } else { r };
            if digits(units, s, 5) {
                return true;
            }
        }
    }
    // 3[47][0-9]{13}
    if amex && digits(units, i + 2, 13) {
        return true;
    }
    // 6(?:011|5[0-9]{2})(?:[ -]?[0-9]{4}){3}
    if u(0) == Some(0x36) {
        let prefix = (u(1) == Some(0x30) && u(2) == Some(0x31) && u(3) == Some(0x31))
            || (u(1) == Some(0x35) && digits(units, i + 2, 2));
        if prefix && three_groups(units, i + 4).is_some() {
            return true;
        }
    }
    // (?:[0-9]{4}[ -]){3}[0-9]{4}
    let mut at = i;
    for _ in 0..3 {
        if !(digits(units, at, 4) && sep(units.get(at + 4))) {
            return false;
        }
        at += 5;
    }
    digits(units, at, 4)
}

/// `CARD_RE` (no flags): a card number of one of the seven shapes, anywhere in the text.
pub fn matches_card(units: &[u16]) -> bool {
    (0..units.len()).any(|i| card_at(units, i))
}

/// The class `[A-Za-z0-9_-]` (the `i` flag adds nothing for ASCII).
fn token_char(u: Option<&u16>) -> bool {
    u.is_some_and(|u| matches!(*u, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x5f | 0x2d))
}

fn has_prefix(units: &[u16], at: usize, prefix: &str) -> bool {
    prefix
        .encode_utf16()
        .enumerate()
        .all(|(k, p)| units.get(at + k).is_some_and(|u| eq_ignore_case(p, *u)))
}

/// `/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36,}|Bearer\s+\S+)\b/i.test(text)`.
///
/// Every alternative starts with a word character, so the leading `\b` holds when the previous unit is not a word unit. The
/// trailing `\b` is tried at every length the greedy run can backtrack to. `sk-` with an `ant-` or `proj-` prefix matches a
/// subset of what the plain run matches (those letters are in the class), so the optional prefix is not modelled. In the
/// `Bearer` branch `\s+` must take the whole white-space run (`\S` cannot start on white space).
pub fn matches_token(units: &[u16]) -> bool {
    (0..units.len()).any(|i| {
        if i > 0 && is_word_unit(units[i - 1]) {
            return false;
        }
        let ends_at_boundary = |from: usize, min: usize, accepts: &dyn Fn(Option<&u16>) -> bool| {
            let mut run = 0;
            while accepts(units.get(from + run)) {
                run += 1;
            }
            (min..=run).any(|k| is_boundary(units, from + k))
        };
        if has_prefix(units, i, "sk-") && ends_at_boundary(i + 3, 20, &token_char) {
            return true;
        }
        if has_prefix(units, i, "ghp_") && ends_at_boundary(i + 4, 36, &|u| alnum(u)) {
            return true;
        }
        if has_prefix(units, i, "bearer") {
            let mut p = i + 6;
            while units.get(p).is_some_and(|u| is_space_unit(*u)) {
                p += 1;
            }
            if p > i + 6 && ends_at_boundary(p, 1, &|u| u.is_some_and(|u| !is_space_unit(*u))) {
                return true;
            }
        }
        false
    })
}

/// `new SensitivityScanner()`: the five classifiers over one shared redactor (`createRedactor()` with its defaults).
pub struct SensitivityScanner {
    redactor: Redactor,
}

impl SensitivityScanner {
    /// Errors when the redaction data cannot be read.
    pub fn new() -> Result<SensitivityScanner, RedactError> {
        Ok(SensitivityScanner {
            redactor: Redactor::new(RedactOptions::default())?,
        })
    }

    /// The credential branch that goes through the redactor: the text, redacted, shows one of the four markers.
    pub fn credential_by_redactor(&self, combined: &[u16]) -> bool {
        let redacted = self.redactor.text_units(combined);
        redacted.contains("[REDACTED:key]")
            || redacted.contains("[REDACTED:pattern]")
            || redacted.contains("[REDACTED:secret]")
            || redacted.contains("<deny:")
    }

    /// `scan(text, summary)`: the categories whose classifier matches `text + "\n" + summary`, in `Array.prototype.sort` order.
    pub fn scan_units(&self, text: &[u16], summary: &[u16]) -> Vec<&'static str> {
        let mut combined = text.to_vec();
        combined.push(0x0a);
        combined.extend_from_slice(summary);
        let mut detected: Vec<&'static str> = Vec::new();
        if matches_keywords(&combined, HEALTH) {
            detected.push("health");
        }
        if matches_keywords(&combined, FINANCIAL)
            || matches_iban(&combined)
            || matches_card(&combined)
        {
            detected.push("financial");
        }
        if self.credential_by_redactor(&combined) || matches_token(&combined) {
            detected.push("credential");
        }
        if matches_keywords(&combined, IDENTITY) {
            detected.push("identity");
        }
        if matches_keywords(&combined, PERSONAL) {
            detected.push("personal");
        }
        let mut names: Vec<String> = detected.iter().map(|s| (*s).to_owned()).collect();
        sort_default(&mut names);
        names
            .iter()
            .filter_map(|n| detected.iter().copied().find(|d| d == n))
            .collect()
    }

    /// `scan(text, summary)` for well-formed strings.
    pub fn scan(&self, text: &str, summary: Option<&str>) -> Vec<&'static str> {
        self.scan_units(&utf16(text), &utf16(summary.unwrap_or("")))
    }
}
