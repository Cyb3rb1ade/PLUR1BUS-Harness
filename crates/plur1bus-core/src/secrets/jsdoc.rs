//! A JSON document the way JavaScript holds it, for files the TypeScript core reads and writes too
//! (`state/secrets/store.json`, the keyring's index entry).
//!
//! The TypeScript backends parse a file, change a member and write `JSON.stringify` of the same object. Two things follow
//! that a `serde_json::Value` does not give: the members of an object keep their order (so the bytes of an unchanged part
//! stay the same), and a member this version does not know survives a rewrite. [`JsObject`] keeps the order JavaScript
//! gives own properties: integer-like keys first, ascending, then every other key in the order it was first set.
//!
//! Known limits (none can occur in a file either implementation wrote): a string with a lone surrogate escape and a number
//! outside f64 are parse errors here and values in JavaScript; a non-integer number is written the way `serde_json` writes
//! it, which is not always `Number.prototype.toString`.
use crate::js::{array_index, json_stringify};
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::fmt;

/// A JSON value with ordered objects.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    /// `null`
    Null,
    /// `true` or `false`
    Bool(bool),
    /// A number, kept as parsed.
    Number(serde_json::Number),
    /// A string.
    String(String),
    /// An array.
    Array(Vec<Json>),
    /// An object.
    Object(JsObject),
}

impl Json {
    /// The string, when the value is one (`typeof v === "string"`).
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(s) => Some(s),
            _ => None,
        }
    }

    /// The object, when the value is one and not an array (`v && typeof v === "object" && !Array.isArray(v)`).
    pub fn as_object(&self) -> Option<&JsObject> {
        match self {
            Json::Object(o) => Some(o),
            _ => None,
        }
    }

    /// The object, mutably.
    pub fn as_object_mut(&mut self) -> Option<&mut JsObject> {
        match self {
            Json::Object(o) => Some(o),
            _ => None,
        }
    }

    /// `JSON.parse(text)`.
    pub fn parse(text: &str) -> Result<Json, serde_json::Error> {
        serde_json::from_str(text)
    }

    /// `JSON.stringify(value)`: compact, members in their order.
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Number(n) => out.push_str(&n.to_string()),
            Json::String(s) => out.push_str(&json_stringify(s)),
            Json::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Json::Object(object) => {
                out.push('{');
                for (i, (key, value)) in object.members.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&json_stringify(key));
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }
}

impl From<&str> for Json {
    fn from(text: &str) -> Json {
        Json::String(text.to_string())
    }
}

impl From<String> for Json {
    fn from(text: String) -> Json {
        Json::String(text)
    }
}

/// An object whose members are in JavaScript's own-property order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct JsObject {
    members: Vec<(String, Json)>,
}

impl JsObject {
    /// An empty object.
    pub fn new() -> JsObject {
        JsObject::default()
    }

    /// `Object.hasOwn(o, key)`.
    pub fn has(&self, key: &str) -> bool {
        self.members.iter().any(|(k, _)| k == key)
    }

    /// `o[key]` of an own member.
    pub fn get(&self, key: &str) -> Option<&Json> {
        self.members.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// `o[key]` of an own member, mutably.
    pub fn get_mut(&mut self, key: &str) -> Option<&mut Json> {
        self.members
            .iter_mut()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }

    /// `o[key] = value`: a member that exists keeps its place; a new one goes where JavaScript puts it (an integer-like
    /// key among the integer-like ones, ascending; any other key at the end).
    pub fn set(&mut self, key: &str, value: Json) {
        if let Some(slot) = self.get_mut(key) {
            *slot = value;
            return;
        }
        let at = match array_index(key) {
            Some(index) => self
                .members
                .iter()
                .position(|(k, _)| array_index(k).is_none_or(|other| other > index))
                .unwrap_or(self.members.len()),
            None => self.members.len(),
        };
        self.members.insert(at, (key.to_string(), value));
    }

    /// `delete o[key]`; the value that was there.
    pub fn remove(&mut self, key: &str) -> Option<Json> {
        let at = self.members.iter().position(|(k, _)| k == key)?;
        Some(self.members.remove(at).1)
    }

    /// `Object.keys(o)`.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.members.iter().map(|(k, _)| k.as_str())
    }

    /// `Object.entries(o)`.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &Json)> {
        self.members.iter().map(|(k, v)| (k.as_str(), v))
    }

    /// `Object.keys(o).length`.
    pub fn len(&self) -> usize {
        self.members.len()
    }

    /// Whether the object has no member.
    pub fn is_empty(&self) -> bool {
        self.members.is_empty()
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Json, D::Error> {
        struct JsonVisitor;

        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = Json;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON value")
            }

            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }

            fn visit_bool<E>(self, v: bool) -> Result<Json, E> {
                Ok(Json::Bool(v))
            }

            fn visit_i64<E>(self, v: i64) -> Result<Json, E> {
                Ok(Json::Number(v.into()))
            }

            fn visit_u64<E>(self, v: u64) -> Result<Json, E> {
                Ok(Json::Number(v.into()))
            }

            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Json, E> {
                serde_json::Number::from_f64(v)
                    .map(Json::Number)
                    .ok_or_else(|| E::custom("a number JSON cannot hold"))
            }

            fn visit_str<E>(self, v: &str) -> Result<Json, E> {
                Ok(Json::String(v.to_string()))
            }

            fn visit_string<E>(self, v: String) -> Result<Json, E> {
                Ok(Json::String(v))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Json::Array(items))
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                // A repeated key keeps its first place and takes the last value, as `JSON.parse` does.
                let mut object = JsObject::new();
                while let Some((key, value)) = map.next_entry::<String, Json>()? {
                    object.set(&key, value);
                }
                Ok(Json::Object(object))
            }
        }

        deserializer.deserialize_any(JsonVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn members_keep_javascript_order_and_unknown_members_survive() {
        let text = r#"{"b":1,"10":{"x":[true,null,"s"]},"a":"é\"\n","2":2.5,"b":3}"#;
        let json = Json::parse(text).unwrap();
        // Integer-like keys first, ascending; then first-set order; the repeated "b" keeps its place with the last value.
        assert_eq!(
            json.stringify(),
            r#"{"2":2.5,"10":{"x":[true,null,"s"]},"b":3,"a":"é\"\n"}"#
        );
        let mut object = json.as_object().unwrap().clone();
        object.set("a", Json::from("z"));
        object.set("7", Json::Null);
        object.set("new", Json::Bool(false));
        object.remove("b");
        object.set("b", Json::from("again"));
        assert_eq!(
            Json::Object(object).stringify(),
            r#"{"2":2.5,"7":null,"10":{"x":[true,null,"s"]},"a":"z","new":false,"b":"again"}"#
        );
    }

    #[test]
    fn keys_that_only_look_like_integers_are_ordinary_keys() {
        let mut object = JsObject::new();
        for key in ["01", "-1", "4294967295", "1.0", "b", "4294967294", "0"] {
            object.set(key, Json::Null);
        }
        assert_eq!(
            object.keys().collect::<Vec<_>>(),
            ["0", "4294967294", "01", "-1", "4294967295", "1.0", "b"]
        );
        assert!(object.has("01") && !object.has("1"));
        assert_eq!(object.len(), 7);
    }
}
