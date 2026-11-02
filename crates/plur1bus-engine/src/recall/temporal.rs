//! `temporal-parser.js` and the safe createdAt filter.
//!
//! JavaScript `\b` is an ASCII boundary. Patterns use `(?-u:\b)` so a Unicode letter
//! does not count as a word character. `parse_temporal` takes the clock the pinned
//! pipeline actually reads: `Date.now()`, not the pipeline's `now` argument.

use chrono::Datelike;
use regex::Regex;
use std::sync::OnceLock;

use super::lifecycle::epoch;
use crate::contract::MemoryRow;
use crate::text::js::js_to_lower_case;

const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;

/// A parsed time hint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Temporal {
    /// Inclusive createdAt window, in milliseconds.
    Range {
        /// Inclusive lower bound.
        from: i64,
        /// Inclusive upper bound.
        to: i64,
    },
    /// A second search must resolve this phrase before the window exists.
    Anchor {
        /// Text after "nach dem" / "after the".
        reference_query: String,
    },
}

/// Result of [`apply_temporal_filter_safe`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TemporalFilter {
    /// Rows that remain. When `dropped` is set this is the original list.
    pub kept: Vec<usize>,
    /// The window removed every row, so the caller keeps the unfiltered list.
    pub dropped: bool,
}

/// Parse `query` at `now_ms`. `None` means the pipeline does not filter on createdAt.
#[must_use]
pub fn parse_temporal(query: &str, now_ms: i64) -> Option<Temporal> {
    if query.is_empty() {
        return None;
    }
    let lower = strip_duration_phrases(&js_to_lower_case(query));
    if let Some(reference) = anchor_reference(query) {
        return Some(Temporal::Anchor {
            reference_query: reference,
        });
    }
    if has(&lower, r"(?-u:\b)(?:heute|today)(?-u:\b)") {
        let from = start_of_utc_day(now_ms);
        return Some(Temporal::Range { from, to: now_ms });
    }
    if has(&lower, r"(?-u:\b)(?:gestern|yesterday)(?-u:\b)") {
        let today = start_of_utc_day(now_ms);
        return Some(Temporal::Range {
            from: today - DAY_MS,
            to: today,
        });
    }
    if let Some(days) = capture_u32(
        &lower,
        r"(?-u:\b)vor\s+(\d+)\s+tagen(?-u:\b)|(?-u:\b)(\d+)\s+days?\s+ago(?-u:\b)",
    ) {
        if (1..10_000).contains(&days) {
            let from = start_of_utc_day(now_ms - i64::from(days) * DAY_MS);
            return Some(Temporal::Range {
                from,
                to: from + DAY_MS,
            });
        }
    }
    if let Some(hours) = capture_u32(
        &lower,
        r"(?-u:\b)vor\s+(\d+)\s+stunden(?-u:\b)|(?-u:\b)(\d+)\s+hours?\s+ago(?-u:\b)",
    ) {
        if (1..10_000).contains(&hours) {
            return Some(Temporal::Range {
                from: now_ms - i64::from(hours) * HOUR_MS,
                to: now_ms,
            });
        }
    }
    if has(&lower, r"(?-u:\b)(?:letzte\s+woche|last\s+week)(?-u:\b)") {
        return Some(Temporal::Range {
            from: now_ms - 7 * DAY_MS,
            to: now_ms,
        });
    }
    if has(&lower, r"(?-u:\b)(?:letzten?\s+monat|last\s+month)(?-u:\b)") {
        return Some(Temporal::Range {
            from: now_ms - 30 * DAY_MS,
            to: now_ms,
        });
    }
    if let Some(range) = month_year(&lower) {
        return Some(range);
    }
    if let Some(range) = month_only(&lower, now_ms) {
        return Some(range);
    }
    if let Some(range) = weekday(&lower, now_ms) {
        return Some(range);
    }
    if let Some(year) = first_year(&lower) {
        return Some(Temporal::Range {
            from: utc_month_start(year, 0),
            to: utc_month_start(year + 1, 0),
        });
    }
    None
}

/// Keep indexes whose `createdAt` lies inside a range. An anchor is not applied here.
///
/// An empty result restores every index and sets `dropped`, which emits no rejection.
#[must_use]
pub fn apply_temporal_filter_safe(rows: &[&MemoryRow], temporal: &Temporal) -> TemporalFilter {
    let Temporal::Range { from, to } = *temporal else {
        return TemporalFilter {
            kept: (0..rows.len()).collect(),
            dropped: false,
        };
    };
    if rows.is_empty() {
        return TemporalFilter {
            kept: Vec::new(),
            dropped: false,
        };
    }
    let kept = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| {
            let created = epoch(&row.created_at);
            created >= from && created <= to
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if kept.is_empty() {
        TemporalFilter {
            kept: (0..rows.len()).collect(),
            dropped: true,
        }
    } else {
        TemporalFilter {
            kept,
            dropped: false,
        }
    }
}

/// Forty-eight hours from a resolved anchor row. `createdAt == 0` does not resolve.
#[must_use]
pub fn range_from_anchor(created_at: i64) -> Option<Temporal> {
    if created_at == 0 {
        return None;
    }
    Some(Temporal::Range {
        from: created_at,
        to: created_at + 48 * HOUR_MS,
    })
}

fn strip_duration_phrases(text: &str) -> String {
    // JavaScript rejects the phrase when whitespace and one of the excluded tails follow it.
    // The `regex` crate has no lookahead, so the tail is checked on the matched span.
    let phrases = pattern(
        r"(?-u:\b)(?:bis\s+(?:heute|jetzt|dato)|until\s+(?:today|now)|up\s+to\s+(?:today|now)|so\s+far|to\s+date)(?-u:\b)",
    );
    let mut rewritten = String::new();
    let mut last = 0;
    for found in phrases.find_iter(text) {
        if duration_tail_excluded(&text[found.end()..]) {
            continue;
        }
        rewritten.push_str(&text[last..found.start()]);
        rewritten.push(' ');
        last = found.end();
    }
    rewritten.push_str(&text[last..]);
    rewritten
}

fn duration_tail_excluded(rest: &str) -> bool {
    let trimmed = rest.trim_start_matches(js_whitespace);
    if trimmed.len() == rest.len() {
        return false;
    }
    const WORDS: &[&str] = &[
        "nachmittag",
        "vormittag",
        "afternoon",
        "morning",
        "evening",
        "mittag",
        "morgen",
        "abend",
        "nacht",
        "night",
        "frueh",
        "früh",
        "noon",
    ];
    if WORDS.iter().any(|word| trimmed.starts_with(word)) {
        return true;
    }
    if has_ascii_word(trimmed, "um") || has_ascii_word(trimmed, "at") {
        return true;
    }
    trimmed
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_digit())
}

fn has_ascii_word(text: &str, word: &str) -> bool {
    let Some(rest) = text.strip_prefix(word) else {
        return false;
    };
    match rest.as_bytes().first() {
        None => true,
        Some(byte) => !byte.is_ascii_alphanumeric() && *byte != b'_',
    }
}

fn js_whitespace(character: char) -> bool {
    matches!(
        character,
        ' ' | '\t'
            | '\n'
            | '\r'
            | '\u{000c}'
            | '\u{000b}'
            | '\u{00a0}'
            | '\u{feff}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{2000}'..='\u{200a}'
    )
}

fn anchor_reference(query: &str) -> Option<String> {
    let found = pattern(r"(?i)nach\s+dem\s+(.+)$")
        .captures(query)
        .or_else(|| pattern(r"(?i)after\s+the\s+(.+)$").captures(query))?;
    let reference = found.get(1)?.as_str().trim();
    if reference.is_empty() {
        None
    } else {
        Some(reference.to_owned())
    }
}

fn month_year(lower: &str) -> Option<Temporal> {
    let found = pattern(r"(?-u:\b)im\s+([a-zäöüß]+)\s+(\d{4})(?-u:\b)")
        .captures(lower)
        .or_else(|| pattern(r"(?-u:\b)in\s+([a-z]+)\s+(\d{4})(?-u:\b)").captures(lower))?;
    let month = month_index(found.get(1)?.as_str())?;
    let year = found.get(2)?.as_str().parse::<i32>().ok()?;
    if !(1970..3000).contains(&year) {
        return None;
    }
    Some(Temporal::Range {
        from: utc_month_start(year, month),
        to: utc_month_start(year, month + 1),
    })
}

fn month_only(lower: &str, now_ms: i64) -> Option<Temporal> {
    let found = pattern(r"(?-u:\b)im\s+([a-zäöüß]+)(?-u:\b)")
        .captures(lower)
        .or_else(|| pattern(r"(?-u:\b)in\s+([a-z]+)(?-u:\b)").captures(lower))?;
    let month = month_index(found.get(1)?.as_str())?;
    let year = chrono::DateTime::from_timestamp_millis(now_ms)?.year();
    let end = utc_month_start(year, month + 1).min(now_ms);
    Some(Temporal::Range {
        from: utc_month_start(year, month),
        to: end,
    })
}

fn weekday(lower: &str, now_ms: i64) -> Option<Temporal> {
    let found = pattern(r"(?-u:\b)am\s+([a-z]+)(?-u:\b)")
        .captures(lower)
        .or_else(|| pattern(r"(?-u:\b)on\s+([a-z]+)(?-u:\b)").captures(lower))?;
    let day = weekday_index(found.get(1)?.as_str())?;
    let from = previous_weekday_utc(now_ms, day);
    Some(Temporal::Range {
        from,
        to: from + DAY_MS,
    })
}

fn first_year(lower: &str) -> Option<i32> {
    let found = pattern(r"(?-u:\b)(\d{4})(?-u:\b)").captures(lower)?;
    let year = found.get(1)?.as_str().parse::<i32>().ok()?;
    (1970..3000).contains(&year).then_some(year)
}

fn month_index(name: &str) -> Option<i32> {
    Some(match name {
        "januar" | "january" => 0,
        "februar" | "february" => 1,
        "märz" | "maerz" | "march" => 2,
        "april" => 3,
        "mai" | "may" => 4,
        "juni" | "june" => 5,
        "juli" | "july" => 6,
        "august" => 7,
        "september" => 8,
        "oktober" | "october" => 9,
        "november" => 10,
        "dezember" | "december" => 11,
        _ => return None,
    })
}

fn weekday_index(name: &str) -> Option<u32> {
    Some(match name {
        "sunday" | "sonntag" => 0,
        "monday" | "montag" => 1,
        "tuesday" | "dienstag" => 2,
        "wednesday" | "mittwoch" => 3,
        "thursday" | "donnerstag" => 4,
        "friday" | "freitag" => 5,
        "saturday" | "samstag" => 6,
        _ => return None,
    })
}

fn capture_u32(text: &str, source: &'static str) -> Option<u32> {
    let found = pattern(source).captures(text)?;
    found
        .iter()
        .skip(1)
        .flatten()
        .find_map(|group| group.as_str().parse().ok())
}

fn has(text: &str, source: &'static str) -> bool {
    pattern(source).is_match(text)
}

fn pattern(source: &'static str) -> Regex {
    static PATTERNS: OnceLock<std::sync::Mutex<std::collections::HashMap<&'static str, Regex>>> =
        OnceLock::new();
    let cache = PATTERNS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut guard = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(found) = guard.get(source) {
        return found.clone();
    }
    let compiled = compile_pattern(source);
    guard.insert(source, compiled.clone());
    compiled
}

#[allow(
    clippy::expect_used,
    reason = "temporal patterns are fixed literals; a bad pattern is a porting bug"
)]
fn compile_pattern(source: &str) -> Regex {
    Regex::new(source).expect("temporal pattern")
}

fn start_of_utc_day(timestamp: i64) -> i64 {
    let Some(date) = chrono::DateTime::from_timestamp_millis(timestamp) else {
        return timestamp;
    };
    date.date_naive()
        .and_hms_opt(0, 0, 0)
        .map(|naive| naive.and_utc().timestamp_millis())
        .unwrap_or(timestamp)
}

fn previous_weekday_utc(timestamp: i64, target_day: u32) -> i64 {
    let Some(date) = chrono::DateTime::from_timestamp_millis(timestamp) else {
        return timestamp;
    };
    let current = date.weekday().num_days_from_sunday();
    let mut diff = i64::from(current) - i64::from(target_day);
    if diff <= 0 {
        diff += 7;
    }
    start_of_utc_day((date - chrono::Duration::days(diff)).timestamp_millis())
}

fn utc_month_start(year: i32, month_index: i32) -> i64 {
    let (year, month) = civil_month(year, month_index);
    chrono::NaiveDate::from_ymd_opt(year, month, 1)
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|naive| naive.and_utc().timestamp_millis())
        .unwrap_or(0)
}

fn civil_month(mut year: i32, mut month_index: i32) -> (i32, u32) {
    while month_index > 11 {
        month_index -= 12;
        year += 1;
    }
    while month_index < 0 {
        month_index += 12;
        year -= 1;
    }
    (year, u32::try_from(month_index + 1).unwrap_or(1))
}
