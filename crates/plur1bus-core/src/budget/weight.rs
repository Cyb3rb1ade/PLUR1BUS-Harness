//! `budget/cache-read-weight.ts` (RE-D29): the weight with which cache reads count against token limits, kept in the budget
//! store's `settings` table beside the time zone. A token limit counts `input - cacheRead x (1 - w) + output`. The weight is
//! applied when usage is summed and never written into the ledger, so a changed weight re-rates a whole period at once;
//! reservations stay the unweighted estimate. Weight 1, the default, counts every cache read in full.
use super::BudgetError;
use crate::metrics::registry::js_number_to_string;
use plur1bus_store::rusqlite::{params, Connection, OptionalExtension};

/// Full weight: a cache read counts like any other input token, as before RE-D29.
pub const DEFAULT_CACHE_READ_WEIGHT: f64 = 1.0;
/// A weight is kept and applied in millionths.
const MICROS: i64 = 1_000_000;
const SETTING: &str = "cache_read_weight";

/// SQL over one `usage_event` row: the cache reads the weight may take off. A row never takes off more than its own input,
/// even when a provider reports more cache reads than prompt tokens.
pub const CACHE_READS_SQL: &str = "MIN(cache_read_tokens, input_tokens)";

/// A weight as stored and applied: a number from 0 to 1, rounded to millionths; anything else is a range error.
pub fn validate_cache_read_weight(w: f64) -> Result<f64, BudgetError> {
    if !w.is_finite() || !(0.0..=1.0).contains(&w) {
        return Err(BudgetError::Range(
            "cache read weight must be a number from 0 to 1".into(),
        ));
    }
    // `Math.round(w * MICROS) || 0`: a result of negative zero is stored as 0.
    let micros = (w * MICROS as f64).round();
    Ok((if micros == 0.0 { 0.0 } else { micros }) / MICROS as f64)
}

/// A stored value is read only when `writeCacheReadWeight` could have written it: digits, optionally a decimal part.
fn is_plain_decimal(v: &str) -> bool {
    let (int, frac) = match v.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (v, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    digits(int) && frac.is_none_or(digits)
}

/// The stored weight. A missing or unparsable value (a store edited by hand) is full weight: every read counts.
pub fn stored_cache_read_weight(conn: &Connection) -> Result<f64, BudgetError> {
    let value: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?", [SETTING], |r| {
            r.get(0)
        })
        .optional()?;
    let w = value
        .filter(|v| is_plain_decimal(v))
        .and_then(|v| v.parse::<f64>().ok());
    match w {
        Some(w) if (0.0..=1.0).contains(&w) => validate_cache_read_weight(w),
        _ => Ok(DEFAULT_CACHE_READ_WEIGHT),
    }
}

/// Validates and stores a weight; returns it as it will be applied.
pub fn write_cache_read_weight(conn: &Connection, w: f64) -> Result<f64, BudgetError> {
    let v = validate_cache_read_weight(w)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![SETTING, js_number_to_string(v)],
    )?;
    Ok(v)
}

/// The tokens a token limit counts for summed usage: `input_output` (input plus output, input including cache reads and
/// writes) less the share `1 - w` of `cache_reads` (summed with [`CACHE_READS_SQL`]). The weighted share of the reads,
/// `cache_reads x w`, is rounded up to a whole token once per sum, in exact integer arithmetic, so a limit never counts less
/// than the rule; with `w = 1` the result is `input_output` itself.
pub fn counted_tokens(input_output: i64, cache_reads: i64, weight: f64) -> i64 {
    let micros = i128::from((weight * MICROS as f64).round() as i64);
    let kept = (i128::from(cache_reads) * micros + i128::from(MICROS - 1)) / i128::from(MICROS);
    // Exact in i128; the JavaScript result is a double, which holds the same value while the sums are safe integers.
    let out = i128::from(input_output) - i128::from(cache_reads) + kept;
    i64::try_from(out).unwrap_or(i64::MAX)
}
