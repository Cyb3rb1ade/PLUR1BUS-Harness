//! Preserve the provider request field order from the TypeScript writer.

use serde::{ser::SerializeMap, Serialize, Serializer};
use serde_json::{json, Value};

#[derive(Default)]
pub(crate) struct Object(Vec<(String, Field)>);

impl Object {
    pub(crate) fn put(&mut self, key: impl Into<String>, value: impl Into<Field>) {
        self.0.push((key.into(), value.into()));
    }

    pub(crate) fn copy(&mut self, key: &'static str, source: &Value, field: &str) {
        if let Some(value) = source.get(field) {
            self.put(key, value.clone());
        }
    }
}

impl Serialize for Object {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

pub(crate) enum Field {
    Scalar(Value),
    Object(Object),
    List(Vec<Self>),
}

impl Serialize for Field {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Scalar(value) => value.serialize(serializer),
            Self::Object(value) => value.serialize(serializer),
            Self::List(value) => value.serialize(serializer),
        }
    }
}

impl From<Value> for Field {
    fn from(value: Value) -> Self {
        // JavaScript serializes an exactly representable whole number without ".0".
        let value = value
            .as_number()
            .filter(|number| number.is_f64())
            .and_then(|number| number.as_f64())
            .filter(|number| number.fract() == 0.0 && number.abs() <= (1i64 << 53) as f64)
            .map_or(value, |number| json!(number as i64));
        Self::Scalar(value)
    }
}

impl From<&str> for Field {
    fn from(value: &str) -> Self {
        Self::Scalar(json!(value))
    }
}

impl From<String> for Field {
    fn from(value: String) -> Self {
        Self::Scalar(json!(value))
    }
}

impl From<u32> for Field {
    fn from(value: u32) -> Self {
        Self::Scalar(json!(value))
    }
}

impl From<bool> for Field {
    fn from(value: bool) -> Self {
        Self::Scalar(json!(value))
    }
}

impl From<Object> for Field {
    fn from(value: Object) -> Self {
        Self::Object(value)
    }
}

pub(super) fn object<const N: usize>(fields: [(&'static str, Field); N]) -> Object {
    Object(
        fields
            .into_iter()
            .map(|(key, field)| (key.to_owned(), field))
            .collect(),
    )
}
