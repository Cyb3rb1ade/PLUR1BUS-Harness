//! JavaScript value semantics the evaluator depends on, over `serde_json::Value`. The TypeScript evaluator reads objects a
//! store or a caller handed it without trusting their shape, so a member can be absent (`undefined`), `null`, or of the
//! wrong type; the operators below answer the way `===`, `>`, `+`, `Number`, `String` and `Boolean` answer for those, so
//! the Rust port takes the same branch on a malformed record as the TypeScript one.
//!
//! A conversion can throw in JavaScript: an object with an own `toString` member has no primitive form, because a member of a
//! JSON object is never a function. Those conversions return [`TypeError`], and each caller says what it does with it.
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

/// The `TypeError` of `OrdinaryToPrimitive`: the value has no primitive form.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TypeError;

/// `Boolean(v)` for a member that may be absent: `undefined`, `null`, `false`, `0` and the empty string are false,
/// everything else is true (an empty array and an empty object too).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `String(v)` of a JSON value. An array is `join(",")` of its elements, where `null` is empty and every other element is
/// its own string form, to any depth (`[[5]]` is `"5"`, `[[]]` is empty, `[1, 2]` is `"1,2"`). An object is
/// `"[object Object]"`, unless it has an own `toString` member: that member hides `Object.prototype.toString` and is no
/// function, `valueOf` hands the object back (or is hidden the same way), and the conversion throws.
pub fn to_js_string(v: &Value) -> Result<String, TypeError> {
    Ok(match v {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => {
            let mut parts = Vec::with_capacity(a.len());
            for element in a {
                parts.push(match element {
                    Value::Null => String::new(),
                    other => to_js_string(other)?,
                });
            }
            parts.join(",")
        }
        Value::Object(o) if o.contains_key("toString") => return Err(TypeError),
        Value::Object(_) => "[object Object]".to_owned(),
    })
}

/// `Number(v)` for a member that may be absent: `undefined` is `NaN`, `null` is 0, and an array or object is the number
/// its string form reads as (`[[5]]` is 5, `[]` is 0, `[1, 2]` and `{}` are `NaN`).
pub fn to_number(v: Option<&Value>) -> Result<f64, TypeError> {
    Ok(match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        Some(structured) => string_to_number(&to_js_string(structured)?),
    })
}

/// `x > y` where `x` is a member that may be absent and `y` a number: both sides are read as numbers, and `NaN` is greater
/// than nothing.
pub fn greater_than(x: Option<&Value>, y: f64) -> Result<bool, TypeError> {
    Ok(to_number(x)? > y)
}

/// `Math.min(a, b)`: `NaN` wins.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `String(n)`.
pub fn number_to_string(n: f64) -> String {
    crate::metrics::registry::js_number_to_string(n)
}

/// `base + ms` with JavaScript's `+`, then read back as a number (the comparisons and `Math.min` that consume a lifetime
/// convert it): `undefined`, a number, a boolean or `null` adds; a string, an array or an object concatenates its string
/// form with `String(ms)`.
pub fn plus_then_number(base: Option<&Value>, ms: f64) -> Result<f64, TypeError> {
    Ok(match base {
        None | Some(Value::Number(_) | Value::Bool(_) | Value::Null) => to_number(base)? + ms,
        Some(text) => string_to_number(&format!("{}{}", to_js_string(text)?, number_to_string(ms))),
    })
}
