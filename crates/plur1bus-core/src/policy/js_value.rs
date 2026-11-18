//! JavaScript value semantics the evaluator depends on, over `serde_json::Value`. The TypeScript evaluator reads objects a
//! store or a caller handed it without trusting their shape, so a member can be absent (`undefined`), `null`, or of the
//! wrong type; the operators below answer the way `===`, `>` and `+` answer for those, so the Rust port takes the same
//! branch on a malformed record as the TypeScript one.
use serde_json::Value;

/// `a === b` for two members that may be absent: absent equals absent, `null` equals `null`, numbers compare as doubles
/// (so `NaN` equals nothing), and an object or array is never strictly equal to another one.
pub fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        _ => false,
    }
}

/// `StringToNumber`: JavaScript white space trimmed, empty is 0, decimal with an optional sign and exponent, `Infinity`,
/// and unsigned `0x`, `0o`, `0b` integers; anything else is `NaN`.
pub fn string_to_number(s: &str) -> f64 {
    let t = s.trim_matches(crate::js::is_js_space);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |n, c| {
                n * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
            });
        }
    }
    let unsigned = t.strip_prefix(['+', '-']).unwrap_or(t);
    if unsigned == "Infinity" {
        return if t.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    // Rust's float grammar also takes `inf`, `nan` and `infinity` in any case; JavaScript's does not.
    let decimal = unsigned
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'));
    if !decimal || !unsigned.bytes().any(|b| b.is_ascii_digit()) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `ToNumber` of a JSON value: an array goes through its string form (`[]` is 0, `[x]` is `ToNumber(String(x))`, more
/// than one element holds a comma and is `NaN`), an object is `NaN`, `null` is 0.
pub fn to_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => string_to_number(s),
        Value::Array(a) => match a.as_slice() {
            [] => 0.0,
            // `String(true)` is "true" (NaN); `String(null)` inside an array is "" (0); a number survives the round trip.
            [Value::Bool(_)] => f64::NAN,
            [one] => to_number(one),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

/// `x > y` where `x` is a member that may be absent and `y` a number: `undefined > y` is false.
pub fn greater_than(x: Option<&Value>, y: f64) -> bool {
    x.is_some_and(|v| to_number(v) > y)
}

/// `Math.min(a, b)`: `NaN` wins.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `String(n)` for the numbers a lifetime sum produces (`NaN`, the infinities, integers below 10^21, and other finite
/// values in Rust's shortest round-trip form, which matches JavaScript between 10^-6 and 10^21).
pub fn number_to_string(n: f64) -> String {
    if n.is_nan() {
        "NaN".to_owned()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity" } else { "-Infinity" }.to_owned()
    } else if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{n:.0}")
    } else {
        format!("{n}")
    }
}

/// `base + ms` with JavaScript's `+`, then read back as a number (the comparisons and `Math.min` that consume a lifetime
/// convert it): a string, array or object base concatenates, a number, boolean or `null` adds.
pub fn plus_then_number(base: &Value, ms: f64) -> f64 {
    match base {
        Value::Number(_) | Value::Bool(_) | Value::Null => to_number(base) + ms,
        Value::String(s) => string_to_number(&format!("{s}{}", number_to_string(ms))),
        Value::Array(a) => match a.as_slice() {
            [] => string_to_number(&number_to_string(ms)),
            [Value::Number(n)] => string_to_number(&format!(
                "{}{}",
                number_to_string(n.as_f64().unwrap_or(f64::NAN)),
                number_to_string(ms)
            )),
            [Value::String(s)] => string_to_number(&format!("{s}{}", number_to_string(ms))),
            [Value::Null] => string_to_number(&number_to_string(ms)),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}
