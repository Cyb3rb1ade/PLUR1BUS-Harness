//! The JavaScript operators the TypeScript code applies to values it did not make, where Rust's own comparisons would answer
//! differently (a lesson of the earlier reviews of this package): `===` between two arrays or two objects is never true (serde
//! and `PartialEq` compare structurally), `undefined === undefined` is true, a string becomes a number by `StringToNumber`
//! (a leading `+` is allowed, an empty string is 0), and a value is "falsy" by its own list.
//!
//! A value that may be missing is an `Option<&V>` where `None` is `undefined`.
use super::json::V;
use crate::js::js_trim;
use crate::metrics::registry::js_number_to_string;

/// `a === b`.
pub fn strict_eq(a: Option<&V>, b: Option<&V>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(V::Null), Some(V::Null)) => true,
        (Some(V::Bool(x)), Some(V::Bool(y))) => x == y,
        (Some(V::Num(x)), Some(V::Num(y))) => x == y,
        (Some(V::Str(x)), Some(V::Str(y))) => x == y,
        // Two distinct objects or arrays are never identical, and nothing here shares a reference.
        _ => false,
    }
}

/// `a !== b`.
pub fn strict_ne(a: Option<&V>, b: Option<&V>) -> bool {
    !strict_eq(a, b)
}

/// `a === "literal"` for a string literal.
pub fn is_str(a: Option<&V>, lit: &str) -> bool {
    a.and_then(V::as_str) == Some(lit)
}

/// `Boolean(v)`: `undefined`, `null`, `false`, `0`, `NaN` and `""` are falsy; everything else (an empty array included) is
/// truthy.
pub fn truthy(v: Option<&V>) -> bool {
    match v {
        None | Some(V::Null) => false,
        Some(V::Bool(b)) => *b,
        Some(V::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(V::Str(s)) => !s.is_empty(),
        Some(V::Arr(_) | V::Obj(_)) => true,
    }
}

/// `String(v)` (and the template literal `${v}`).
pub fn js_string(v: Option<&V>) -> String {
    match v {
        None => "undefined".to_owned(),
        Some(V::Null) => "null".to_owned(),
        Some(V::Bool(b)) => b.to_string(),
        Some(V::Num(n)) => js_number_to_string(*n),
        Some(V::Str(s)) => s.clone(),
        Some(V::Arr(a)) => a
            .iter()
            .map(|x| match x {
                V::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(V::Obj(_)) => "[object Object]".to_owned(),
    }
}

/// `Number(string)`: white space is trimmed, the empty string is 0, `0x`, `0o` and `0b` forms read, `Infinity` reads with a
/// sign, a decimal literal may start with `+` or `-`; anything else is `NaN`.
pub fn string_to_number(s: &str) -> f64 {
    let t = js_trim(s);
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
        if let Some(rest) = t.strip_prefix(prefix) {
            return if rest.is_empty() || !rest.chars().all(|c| c.is_digit(radix)) {
                f64::NAN
            } else {
                rest.chars().fold(0.0, |acc, c| {
                    acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
                })
            };
        }
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    let digits = body
        .bytes()
        .all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-'));
    let starts_ok = body
        .bytes()
        .next()
        .is_some_and(|c| c.is_ascii_digit() || c == b'.');
    if !digits || !starts_ok || body == "." {
        return f64::NAN;
    }
    body.parse::<f64>().map_or(f64::NAN, |n| sign * n)
}

/// `Number(v)` / the coercion of `Math.max`.
pub fn to_number(v: Option<&V>) -> f64 {
    match v {
        None => f64::NAN,
        Some(V::Null) => 0.0,
        Some(V::Bool(b)) => f64::from(u8::from(*b)),
        Some(V::Num(n)) => *n,
        Some(V::Str(s)) => string_to_number(s),
        Some(a @ V::Arr(_)) => string_to_number(&js_string(Some(a))),
        Some(V::Obj(_)) => f64::NAN,
    }
}

/// `Math.max(a, b)`.
pub fn math_max(a: Option<&V>, b: Option<&V>) -> f64 {
    let (x, y) = (to_number(a), to_number(b));
    if x.is_nan() || y.is_nan() {
        f64::NAN
    } else {
        x.max(y)
    }
}

/// `a ?? b` for a value that may be missing: `undefined` and `null` fall through.
pub fn nullish<'a>(a: Option<&'a V>, b: Option<&'a V>) -> Option<&'a V> {
    match a {
        None | Some(V::Null) => b,
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::json::parse;

    #[test]
    fn strict_equality_is_never_structural() {
        let a = parse("[1]").unwrap();
        let b = parse("[1]").unwrap();
        assert!(!strict_eq(Some(&a), Some(&b)));
        assert!(strict_eq(None, None));
        assert!(!strict_eq(None, Some(&V::Null)));
        assert!(!strict_eq(Some(&V::Num(f64::NAN)), Some(&V::Num(f64::NAN))));
        assert!(strict_eq(Some(&V::Num(0.0)), Some(&V::Num(-0.0))));
        assert!(!strict_eq(Some(&V::s("1")), Some(&V::Num(1.0))));
    }

    #[test]
    fn numbers_from_text_follow_string_to_number() {
        for (s, n) in [
            ("", 0.0),
            ("  7 ", 7.0),
            ("+3", 3.0),
            ("-2", -2.0),
            ("0x10", 16.0),
            ("1e2", 100.0),
            (".5", 0.5),
            ("5.", 5.0),
        ] {
            assert_eq!(string_to_number(s), n, "{s:?}");
        }
        for s in [
            "abc", "1 2", "--1", "+-1", "0x", "1_0", "e5", ".", "+", "Infinit",
        ] {
            assert!(string_to_number(s).is_nan(), "{s:?}");
        }
        assert_eq!(string_to_number("-Infinity"), f64::NEG_INFINITY);
        assert!(math_max(None, Some(&V::Num(1.0))).is_nan());
        assert_eq!(math_max(Some(&V::s("+2")), Some(&V::Num(1.0))), 2.0);
        assert!(
            !truthy(Some(&V::Num(f64::NAN)))
                && truthy(Some(&V::Arr(vec![])))
                && !truthy(Some(&V::s("")))
        );
    }
}
