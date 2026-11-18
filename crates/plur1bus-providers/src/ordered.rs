//! Preserve member order locally. Enabling serde_json's workspace-wide preserve_order feature
//! would also change the ordering of objects in binaries that do not use the provider library.

use indexmap::IndexMap;
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::fmt::{self, Write as _};
use std::ops::Index;

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(IndexMap<String, Json>),
}

impl Json {
    pub fn parse(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }

    pub fn object() -> Self {
        Self::Object(IndexMap::new())
    }

    pub fn get(&self, key: &str) -> Option<&Self> {
        self.as_object()?.get(key)
    }

    pub fn as_object(&self) -> Option<&IndexMap<String, Self>> {
        match self {
            Self::Object(fields) => Some(fields),
            _ => None,
        }
    }

    pub fn set(&mut self, key: impl Into<String>, value: impl Into<Self>) {
        if let Self::Object(fields) = self {
            fields.insert(key.into(), value.into());
        }
    }

    pub(crate) fn get_mut(&mut self, key: &str) -> Option<&mut Self> {
        match self {
            Self::Object(fields) => fields.get_mut(key),
            _ => None,
        }
    }

    pub(crate) fn array_mut(&mut self) -> Option<&mut Vec<Self>> {
        match self {
            Self::Array(values) => Some(values),
            _ => None,
        }
    }

    pub(crate) fn remove(&mut self, key: &str) {
        if let Self::Object(fields) = self {
            fields.shift_remove(key);
        }
    }

    pub fn string(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn number(&self) -> Option<f64> {
        match self {
            Self::Number(value) => Some(*value),
            _ => None,
        }
    }

    pub fn boolean(&self) -> Option<bool> {
        match self {
            Self::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub fn array(&self) -> Option<&[Self]> {
        match self {
            Self::Array(values) => Some(values),
            _ => None,
        }
    }

    pub fn items(&self) -> &[Self] {
        self.array().unwrap_or_default()
    }

    pub fn text(&self) -> &str {
        self.string().unwrap_or_default()
    }

    /// Encode an object as JSON.stringify does. Array-index keys come first, in ascending order.
    pub fn encode(&self) -> String {
        fn array_index(key: &str) -> Option<u32> {
            let index = key.parse::<u32>().ok()?;
            (index != u32::MAX && key == index.to_string()).then_some(index)
        }
        fn string(out: &mut String, value: &str) {
            // String serialization to a Vec cannot return an I/O error.
            if let Ok(escaped) = serde_json::to_string(value) {
                out.push_str(&escaped);
            }
        }
        fn write(out: &mut String, value: &Json) {
            match value {
                Json::Null => out.push_str("null"),
                Json::Bool(value) => {
                    let _ = write!(out, "{value}");
                }
                Json::Number(value) if value.is_finite() => {
                    out.push_str(&plur1bus_canon::format_double(*value))
                }
                Json::Number(_) => out.push_str("null"),
                Json::String(value) => string(out, value),
                Json::Array(values) => {
                    out.push('[');
                    for (index, value) in values.iter().enumerate() {
                        if index != 0 {
                            out.push(',');
                        }
                        write(out, value);
                    }
                    out.push(']');
                }
                Json::Object(fields) => {
                    let mut indices = Vec::new();
                    let mut members = Vec::new();
                    for pair in fields {
                        if let Some(index) = array_index(pair.0) {
                            indices.push((index, pair));
                        } else {
                            members.push(pair);
                        }
                    }
                    indices.sort_unstable_by_key(|(index, _)| *index);
                    out.push('{');
                    for (position, (key, value)) in indices
                        .into_iter()
                        .map(|(_, pair)| pair)
                        .chain(members)
                        .enumerate()
                    {
                        if position != 0 {
                            out.push(',');
                        }
                        string(out, key);
                        out.push(':');
                        write(out, value);
                    }
                    out.push('}');
                }
            }
        }
        let mut out = String::new();
        write(&mut out, self);
        out
    }
}

impl Index<&str> for Json {
    type Output = Self;

    fn index(&self, key: &str) -> &Self {
        self.get(key).unwrap_or(&Self::Null)
    }
}

impl From<&str> for Json {
    fn from(value: &str) -> Self {
        Self::String(value.into())
    }
}
impl From<String> for Json {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}
impl From<bool> for Json {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}
impl From<f64> for Json {
    fn from(value: f64) -> Self {
        Self::Number(value)
    }
}
impl From<Vec<Self>> for Json {
    fn from(value: Vec<Self>) -> Self {
        Self::Array(value)
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(source: D) -> Result<Self, D::Error> {
        struct Ordered;

        impl<'de> Visitor<'de> for Ordered {
            type Value = Json;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("JSON")
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_bool<E>(self, value: bool) -> Result<Json, E> {
                Ok(value.into())
            }
            fn visit_i64<E>(self, value: i64) -> Result<Json, E> {
                Ok((value as f64).into())
            }
            fn visit_u64<E>(self, value: u64) -> Result<Json, E> {
                Ok((value as f64).into())
            }
            fn visit_f64<E>(self, value: f64) -> Result<Json, E> {
                Ok(value.into())
            }
            fn visit_str<E>(self, value: &str) -> Result<Json, E> {
                Ok(value.into())
            }
            fn visit_string<E>(self, value: String) -> Result<Json, E> {
                Ok(value.into())
            }
            fn visit_seq<S: SeqAccess<'de>>(self, mut source: S) -> Result<Json, S::Error> {
                let mut values = Vec::new();
                while let Some(item) = source.next_element()? {
                    values.push(item);
                }
                Ok(values.into())
            }
            fn visit_map<M: MapAccess<'de>>(self, mut source: M) -> Result<Json, M::Error> {
                let mut fields = IndexMap::new();
                while let Some((key, item)) = source.next_entry()? {
                    fields.insert(key, item);
                }
                Ok(Json::Object(fields))
            }
        }
        source.deserialize_any(Ordered)
    }
}

macro_rules! obj {
    ($($key:literal : $value:expr),+ $(,)?) => {{
        let mut out = $crate::Json::object();
        $(out.set($key, $value);)+
        out
    }};
}

pub(crate) use obj;
