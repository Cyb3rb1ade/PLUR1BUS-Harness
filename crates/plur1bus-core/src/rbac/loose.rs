//! The JavaScript value model of the `_js` entry points, and the coercions JavaScript applies to such values.
//!
//! The TypeScript functions are typed, but a JSON-RPC handler or a JavaScript plugin can hand them anything. A Rust type
//! cannot say "a string, or an array whose first element happens to be the string", so the entry points that must give the
//! TypeScript answer for *every* input (`authorize_js`, `can_see_js`, `surface_trust_js`, ...) take a [`Js`]: the JSON value
//! plus the three things JSON has no literal for (`undefined`, `NaN`, the infinities, `-0`). A [`Js`] is decoded from a
//! `serde_json::Value` with the tags the parity fixtures use: `{"$num":"NaN"|"Infinity"|"-Infinity"|"-0"}` and
//! `{"$undefined":true}`. A member that is absent is `undefined` to every lookup, as in JavaScript.
use serde_json::{Map, Number, Value};

/// A JavaScript value as far as JSON and the fixture tags reach.
#[derive(Clone, Debug, PartialEq)]
pub enum Js {
    /// `undefined` (an absent member, or an explicit one).
    Undefined,
    /// `null`
    Null,
    /// A boolean.
    Bool(bool),
    /// A number (any `f64`, including `NaN`, infinities and `-0`).
    Num(f64),
    /// A string.
    Str(String),
    /// An array (never sparse).
    Arr(Vec<Js>),
    /// A plain object with own, enumerable members, in insertion order. `__proto__` is an ordinary own member.
    Obj(Vec<(String, Js)>),
}

/// `TypeError`: the TypeScript function throws on this input (a method call on `null`, `.some` on a non-array, ...).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Throw;

impl Throw {
    /// The `name` of the JavaScript error.
    pub const NAME: &'static str = "TypeError";
}

impl Js {
    /// Decodes a `serde_json::Value` (with the fixture tags).
    pub fn from_value(v: &Value) -> Js {
        match v {
            Value::Null => Js::Null,
            Value::Bool(b) => Js::Bool(*b),
            Value::Number(n) => Js::Num(n.as_f64().unwrap_or(f64::NAN)),
            Value::String(s) => Js::Str(s.clone()),
            Value::Array(a) => Js::Arr(a.iter().map(Js::from_value).collect()),
            Value::Object(m) => {
                if m.len() == 1 {
                    if let Some(Value::String(t)) = m.get("$num") {
                        return Js::Num(match t.as_str() {
                            "NaN" => f64::NAN,
                            "Infinity" => f64::INFINITY,
                            "-Infinity" => f64::NEG_INFINITY,
                            _ => -0.0,
                        });
                    }
                    if m.contains_key("$undefined") {
                        return Js::Undefined;
                    }
                }
                Js::Obj(
                    m.iter()
                        .map(|(k, v)| (k.clone(), Js::from_value(v)))
                        .collect(),
                )
            }
        }
    }

    /// Encodes with the same tags (finite integers stay integers, so two encodings compare equal as `Value`s).
    pub fn to_value(&self) -> Value {
        match self {
            Js::Undefined => tag("$undefined", Value::Bool(true)),
            Js::Null => Value::Null,
            Js::Bool(b) => Value::Bool(*b),
            Js::Num(n) => num_value(*n),
            Js::Str(s) => Value::String(s.clone()),
            Js::Arr(a) => Value::Array(a.iter().map(Js::to_value).collect()),
            Js::Obj(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), v.to_value())).collect()),
        }
    }

    /// An own member of an object (`Object.hasOwn(o, k) ? o[k] : undefined`); `None` for a non-object or an absent member.
    pub fn own(&self, key: &str) -> Option<&Js> {
        match self {
            Js::Obj(o) => o.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// The member as JavaScript reads it: `undefined` for everything absent.
    pub fn get(&self, key: &str) -> &Js {
        self.own(key).unwrap_or(&Js::Undefined)
    }

    /// `v === undefined`.
    pub fn is_undefined(&self) -> bool {
        matches!(self, Js::Undefined)
    }

    /// `typeof v === "object" && v !== null && !Array.isArray(v)`.
    pub fn is_plain_object(&self) -> bool {
        matches!(self, Js::Obj(_))
    }

    /// `v === true`.
    pub fn is_true(&self) -> bool {
        matches!(self, Js::Bool(true))
    }

    /// The string if it is one.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Js::Str(s) => Some(s),
            _ => None,
        }
    }

    /// `typeof v === "number" && Number.isFinite(v)`.
    pub fn as_finite(&self) -> Option<f64> {
        match self {
            Js::Num(n) if n.is_finite() => Some(*n),
            _ => None,
        }
    }

    /// `ToNumber(ToPrimitive(v))`, the operand conversion of `a >= v` / `a < v` when `a` is a number.
    pub fn to_number(&self) -> f64 {
        match self {
            Js::Undefined => f64::NAN,
            Js::Null => 0.0,
            Js::Bool(b) => f64::from(u8::from(*b)),
            Js::Num(n) => *n,
            Js::Str(s) => string_to_number(s),
            // An array's primitive is its `join(",")`: empty is "" (0), one element is that element's string, more contain a
            // comma, which no numeric string does.
            Js::Arr(a) => match a.as_slice() {
                [] => 0.0,
                [one] => match one {
                    Js::Undefined | Js::Null => 0.0,
                    Js::Num(n) => *n,
                    other => string_to_number(&other.to_js_string()),
                },
                _ => f64::NAN,
            },
            // "[object Object]"
            Js::Obj(_) => f64::NAN,
        }
    }

    /// `String(v)` (a template literal's conversion), exact for strings, arrays, `null`, `undefined`, booleans and objects.
    /// Numbers use Rust's formatting, which differs from JavaScript's only in text no comparison here can depend on.
    pub fn to_js_string(&self) -> String {
        match self {
            Js::Undefined => "undefined".to_owned(),
            Js::Null => "null".to_owned(),
            Js::Bool(b) => b.to_string(),
            Js::Num(n) => format!("{n}"),
            Js::Str(s) => s.clone(),
            Js::Arr(a) => a
                .iter()
                .map(|e| match e {
                    Js::Undefined | Js::Null => String::new(),
                    other => other.to_js_string(),
                })
                .collect::<Vec<_>>()
                .join(","),
            Js::Obj(_) => "[object Object]".to_owned(),
        }
    }
}

fn tag(key: &str, v: Value) -> Value {
    let mut m = Map::new();
    m.insert(key.to_owned(), v);
    Value::Object(m)
}

fn num_value(n: f64) -> Value {
    if n.is_nan() {
        return tag("$num", Value::String("NaN".into()));
    }
    if n == f64::INFINITY {
        return tag("$num", Value::String("Infinity".into()));
    }
    if n == f64::NEG_INFINITY {
        return tag("$num", Value::String("-Infinity".into()));
    }
    if n == 0.0 && n.is_sign_negative() {
        return tag("$num", Value::String("-0".into()));
    }
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        return Value::from(n as i64);
    }
    Number::from_f64(n).map_or(Value::Null, Value::Number)
}

/// JavaScript whitespace and line terminators (`String.prototype.trim`, ES2024 WhiteSpace + LineTerminator).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'
            | '\u{a}'
            | '\u{b}'
            | '\u{c}'
            | '\u{d}'
            | '\u{20}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `Number(s)` for a string: the StringNumericLiteral grammar (trimmed; empty is 0; `Infinity`; `0x`, `0o`, `0b` without a
/// sign; a signed decimal with optional fraction and exponent); anything else is `NaN`. Hex, octal and binary literals above
/// 2^128 lose the exactness JavaScript has (never a case a grant can depend on).
pub fn string_to_number(s: &str) -> f64 {
    let t = s.trim_matches(is_js_space);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let radix = |digits: &str, base: u32| -> f64 {
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(base)) {
            return f64::NAN;
        }
        digits.chars().fold(0.0_f64, |acc, c| {
            acc * f64::from(base) + f64::from(c.to_digit(base).unwrap_or(0))
        })
    };
    if let Some(rest) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return radix(rest, 16);
    }
    if let Some(rest) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
        return radix(rest, 8);
    }
    if let Some(rest) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
        return radix(rest, 2);
    }
    // StrDecimalLiteral: [+-]? ( digits [. digits?]? | . digits ) ( [eE] [+-]? digits )?
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let f = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - f;
    }
    if int_digits == 0 && frac_digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let e = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == e {
            return f64::NAN;
        }
    }
    if i != b.len() {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}
