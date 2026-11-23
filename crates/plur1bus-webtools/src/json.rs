//! Pretty-print parsed JSON in its JavaScript property order.

use std::{
    collections::HashMap,
    fmt::{self, Write as _},
};

use serde::{de, Deserialize, Deserializer};

enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Self>),
    Object(Vec<(String, Self)>),
}

impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(Parse)
    }
}

struct Parse;

impl<'de> de::Visitor<'de> for Parse {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Value, E> {
        self.visit_f64(value as f64)
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Value, E> {
        self.visit_f64(value as f64)
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> {
        Ok(Value::Number(value))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Value, E> {
        self.visit_string(value.to_owned())
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Value, E> {
        Ok(Value::String(value))
    }

    fn visit_seq<A: de::SeqAccess<'de>>(self, mut input: A) -> Result<Value, A::Error> {
        let mut items = Vec::new();
        while let Some(value) = input.next_element()? {
            items.push(value);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A: de::MapAccess<'de>>(self, mut input: A) -> Result<Value, A::Error> {
        let mut lookup = HashMap::<String, usize>::new();
        let mut entries = Vec::<(String, Value)>::new();
        while let Some((key, value)) = input.next_entry::<String, Value>()? {
            if let Some(&index) = lookup.get(&key) {
                entries[index].1 = value;
            } else {
                lookup.insert(key.clone(), entries.len());
                entries.push((key, value));
            }
        }
        entries.sort_by_key(|(key, _)| {
            let array_index = key
                .parse::<u32>()
                .ok()
                .filter(|n| *n != u32::MAX && n.to_string() == *key);
            (array_index.is_none(), array_index)
        });
        Ok(Value::Object(entries))
    }
}

struct Output {
    text: String,
    units_left: usize,
}

impl fmt::Write for Output {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        let next = self
            .units_left
            .checked_sub(text.encode_utf16().count())
            .ok_or(fmt::Error)?;
        self.text.push_str(text);
        self.units_left = next;
        Ok(())
    }
}

fn indent(out: &mut Output, depth: usize) -> fmt::Result {
    write!(out, "\n{:width$}", "", width = depth * 2)
}

fn write(value: &Value, out: &mut Output, depth: usize) -> fmt::Result {
    match value {
        Value::Null => out.write_str("null"),
        Value::Bool(true) => out.write_str("true"),
        Value::Bool(false) => out.write_str("false"),
        Value::Number(value) => out.write_str(&plur1bus_canon::format_double(*value)),
        Value::String(value) => {
            out.write_str(&serde_json::to_string(value).map_err(|_| fmt::Error)?)
        }
        Value::Array(items) => {
            out.write_char('[')?;
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.write_char(',')?;
                }
                indent(out, depth + 1)?;
                write(item, out, depth + 1)?;
            }
            if !items.is_empty() {
                indent(out, depth)?;
            }
            out.write_char(']')
        }
        Value::Object(entries) => {
            out.write_char('{')?;
            for (index, (key, value)) in entries.iter().enumerate() {
                if index > 0 {
                    out.write_char(',')?;
                }
                indent(out, depth + 1)?;
                out.write_str(&serde_json::to_string(key).map_err(|_| fmt::Error)?)?;
                out.write_str(": ")?;
                write(value, out, depth + 1)?;
            }
            if !entries.is_empty() {
                indent(out, depth)?;
            }
            out.write_char('}')
        }
    }
}

pub(super) fn pretty(input: &str, limit: usize) -> Result<Option<String>, fmt::Error> {
    let Ok(value) = serde_json::from_str(input) else {
        return Ok(None);
    };
    let mut out = Output {
        text: String::with_capacity(input.len().min(limit)),
        units_left: limit,
    };
    write(&value, &mut out, 0)?;
    Ok(Some(out.text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pretty_print_charges_utf16_for_whitespace_and_unicode_before_appending() {
        let input = r#"{"books":[{"title":"🌱"},3]}"#;
        let expected = "{\n  \"books\": [\n    {\n      \"title\": \"🌱\"\n    },\n    3\n  ]\n}";
        let bound = expected.encode_utf16().count();
        assert_eq!(pretty(input, bound), Ok(Some(expected.to_owned())));
        assert!(pretty(input, bound - 1).is_err());
        assert!(pretty(input, input.encode_utf16().count()).is_err());
        assert_eq!(pretty("{", 0), Ok(None));
    }
}
