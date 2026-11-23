//! Pretty-print parsed JSON in its JavaScript property order.

use std::{collections::HashMap, fmt};

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

fn indent(out: &mut String, depth: usize) {
    out.push('\n');
    out.extend(std::iter::repeat_n(' ', depth * 2));
}

fn write(value: &Value, out: &mut String, depth: usize) -> serde_json::Result<()> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(value) => out.push_str(&plur1bus_canon::format_double(*value)),
        Value::String(value) => out.push_str(&serde_json::to_string(value)?),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                indent(out, depth + 1);
                write(item, out, depth + 1)?;
            }
            if !items.is_empty() {
                indent(out, depth);
            }
            out.push(']');
        }
        Value::Object(entries) => {
            out.push('{');
            for (index, (key, value)) in entries.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                indent(out, depth + 1);
                out.push_str(&serde_json::to_string(key)?);
                out.push_str(": ");
                write(value, out, depth + 1)?;
            }
            if !entries.is_empty() {
                indent(out, depth);
            }
            out.push('}');
        }
    }
    Ok(())
}

pub(super) fn pretty(input: &str) -> Option<String> {
    let value = serde_json::from_str(input).ok()?;
    let mut out = String::with_capacity(input.len());
    write(&value, &mut out, 0).ok()?;
    Some(out)
}
