//! JSON the way `JSON.parse` and `JSON.stringify` see it, for the bytes the approval chain keys its MACs over.
//!
//! The chain stores `JSON.stringify(payload)` and later compares strings it rebuilds from parsed payloads (a grant's chained
//! definition, the binding a decision copies from its request). `serde_json::Value` sorts object members (the crate is built
//! without `preserve_order`), so it cannot rebuild those strings. [`J`] keeps members in the order they were written and
//! prints them in the order a JavaScript object enumerates them: array-index keys first, ascending, then the others in
//! insertion order. Numbers are doubles and print as `String(number)` does; strings are escaped as `JSON.stringify` escapes
//! them ([`crate::js::json_stringify`]).
use crate::js::{array_index, json_stringify};
use crate::metrics::registry::js_number_to_string;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use std::fmt;

/// A parsed JSON value with its member order.
#[derive(Clone, Debug, PartialEq)]
pub enum J {
    /// `null`.
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// A number (a double, as in JavaScript).
    Num(f64),
    /// A string.
    Str(String),
    /// An array.
    Arr(Vec<J>),
    /// An object, members in insertion order (a repeated key keeps its first position and its last value, as `JSON.parse`).
    Obj(Vec<(String, J)>),
}

impl J {
    /// `JSON.parse(text)`; `None` where it throws or where serde_json cannot hold the text (a lone surrogate escape, a number
    /// out of the double range): such a payload is unreadable here, which the callers treat as malformed (fail closed).
    pub fn parse(text: &str) -> Option<J> {
        serde_json::from_str(text).ok()
    }

    /// An object from members in the given order.
    pub fn obj<const N: usize>(members: [(&str, J); N]) -> J {
        let mut out = J::Obj(Vec::with_capacity(N));
        for (k, v) in members {
            out.set(k, v);
        }
        out
    }

    /// A string value.
    pub fn s(v: &str) -> J {
        J::Str(v.to_owned())
    }

    /// `null` for `None`, else the string.
    pub fn opt_s(v: Option<&str>) -> J {
        v.map_or(J::Null, J::s)
    }

    /// `null` for `None`, else the number.
    pub fn opt_n(v: Option<i64>) -> J {
        v.map_or(J::Null, |n| J::Num(n as f64))
    }

    /// `o[key] = value` on an object (no effect on anything else).
    pub fn set(&mut self, key: &str, value: J) {
        if let J::Obj(m) = self {
            match m.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = value,
                None => m.push((key.to_owned(), value)),
            }
        }
    }

    /// `o[key]` of an object; `None` for a missing member or a value that is not an object.
    pub fn get(&self, key: &str) -> Option<&J> {
        match self {
            J::Obj(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// The string, when this is one.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            J::Str(s) => Some(s),
            _ => None,
        }
    }

    /// The number, when this is one.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            J::Num(n) => Some(*n),
            _ => None,
        }
    }

    /// `typeof v === "object" && v !== null` (arrays included).
    pub fn is_object_like(&self) -> bool {
        matches!(self, J::Obj(_) | J::Arr(_))
    }

    /// `JSON.stringify(v)`.
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            J::Null => out.push_str("null"),
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Num(n) if n.is_finite() => out.push_str(&js_number_to_string(*n)),
            J::Num(_) => out.push_str("null"),
            J::Str(s) => out.push_str(&json_stringify(s)),
            J::Arr(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write(out);
                }
                out.push(']');
            }
            J::Obj(_) => {
                out.push('{');
                for (i, (k, v)) in self.members().into_iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&json_stringify(k));
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }

    /// The members in JavaScript's enumeration order: array indices ascending, then the rest as inserted.
    pub fn members(&self) -> Vec<(&str, &J)> {
        let J::Obj(m) = self else {
            return Vec::new();
        };
        let mut indexed: Vec<(usize, &str, &J)> = m
            .iter()
            .filter_map(|(k, v)| array_index(k).map(|i| (i, k.as_str(), v)))
            .collect();
        indexed.sort_by_key(|(i, _, _)| *i);
        indexed
            .into_iter()
            .map(|(_, k, v)| (k, v))
            .chain(
                m.iter()
                    .filter(|(k, _)| array_index(k).is_none())
                    .map(|(k, v)| (k.as_str(), v)),
            )
            .collect()
    }

    /// A `serde_json::Value` with the same content (member order is lost: for reading, never for bytes).
    pub fn to_value(&self) -> Value {
        match self {
            J::Null => Value::Null,
            J::Bool(b) => Value::Bool(*b),
            J::Num(n) => num_value(*n),
            J::Str(s) => Value::String(s.clone()),
            J::Arr(a) => Value::Array(a.iter().map(J::to_value).collect()),
            J::Obj(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), v.to_value())).collect()),
        }
    }

    /// From a `serde_json::Value` (members in the order the value holds them, which is sorted for an object).
    pub fn from_value(v: &Value) -> J {
        match v {
            Value::Null => J::Null,
            Value::Bool(b) => J::Bool(*b),
            Value::Number(n) => J::Num(n.as_f64().unwrap_or(f64::NAN)),
            Value::String(s) => J::Str(s.clone()),
            Value::Array(a) => J::Arr(a.iter().map(J::from_value).collect()),
            Value::Object(m) => J::Obj(
                m.iter()
                    .map(|(k, v)| (k.clone(), J::from_value(v)))
                    .collect(),
            ),
        }
    }
}

/// A number as a `serde_json::Value`: an integer where the double is one (so `12` reads back as `12`, not `12.0`).
pub fn num_value(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

struct JVisitor;

impl<'de> Visitor<'de> for JVisitor {
    type Value = J;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JSON")
    }
    fn visit_unit<E>(self) -> Result<J, E> {
        Ok(J::Null)
    }
    fn visit_bool<E>(self, v: bool) -> Result<J, E> {
        Ok(J::Bool(v))
    }
    fn visit_i64<E>(self, v: i64) -> Result<J, E> {
        Ok(J::Num(v as f64))
    }
    fn visit_u64<E>(self, v: u64) -> Result<J, E> {
        Ok(J::Num(v as f64))
    }
    fn visit_f64<E>(self, v: f64) -> Result<J, E> {
        Ok(J::Num(v))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<J, E> {
        Ok(J::Str(v.to_owned()))
    }
    fn visit_string<E>(self, v: String) -> Result<J, E> {
        Ok(J::Str(v))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<J, A::Error> {
        let mut out = Vec::new();
        while let Some(v) = seq.next_element::<J>()? {
            out.push(v);
        }
        Ok(J::Arr(out))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<J, A::Error> {
        let mut out = J::Obj(Vec::new());
        while let Some((k, v)) = map.next_entry::<String, J>()? {
            out.set(&k, v);
        }
        Ok(out)
    }
}

impl<'de> Deserialize<'de> for J {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<J, D::Error> {
        d.deserialize_any(JVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stringify_follows_javascript_member_order_and_escapes() {
        let j = J::parse(r#"{"b":1,"2":true,"a":[null,"x\u0001"],"1":-0.5,"01":2e21}"#).unwrap();
        assert_eq!(
            j.stringify(),
            r#"{"1":-0.5,"2":true,"b":1,"a":[null,"x\u0001"],"01":2e+21}"#
        );
        let dup = J::parse(r#"{"a":1,"b":2,"a":3}"#).unwrap();
        assert_eq!(dup.stringify(), r#"{"a":3,"b":2}"#);
        assert_eq!(J::parse("1e400"), None, "out of range: unreadable here");
        assert_eq!(J::Num(f64::NAN).stringify(), "null");
    }
}
