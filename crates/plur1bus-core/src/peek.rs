//! The tolerant peek (P4-10 security review M1/L3): the few members of a frame the front door routes on, read so that
//! every frame `JSON.parse` accepts is understood here too.
//!
//! serde_json refuses two things `JSON.stringify` emits and `JSON.parse` accepts: a lone surrogate escape (`"\ud83d"`, an
//! emoji cut by `slice`) and nesting deeper than 128. A relay that parsed every frame fully would therefore end a
//! client's connection over text the legacy core wrote, or route a request differently from how the legacy core reads
//! it. Instead the front door reads only the top-level members it needs ([`members`]): the rest of the frame is skipped
//! without decoding (serde's `IgnoredAny`, which serde_json skips iteratively and without validating escapes), object
//! keys are decoded without validating escapes either, and the members come back as their raw JSON text. The frame
//! itself goes on as it was written; only frames the front door must change are parsed further ([`value_lossy`]: lone
//! surrogates become U+FFFD there, which is what a JavaScript string compare would never match anyway).
use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, Visitor};
use serde_json::value::RawValue;
use serde_json::Value;
use std::fmt;

/// The raw JSON text of the top-level members `keys` of the object `text` (the last one where a key repeats, as
/// `JSON.parse` keeps it), or `None` when `text` is not exactly one JSON object.
pub fn members<'a, const N: usize>(
    text: &'a str,
    keys: [&str; N],
) -> Option<[Option<&'a RawValue>; N]> {
    let mut de = serde_json::Deserializer::from_str(text);
    let found = Members { keys }.deserialize(&mut de).ok()?;
    de.end().ok()?;
    Some(found)
}

/// The raw member `key` of the raw object `object` (the last one where it repeats); `None` when it is absent or `object`
/// is no object.
pub fn member<'a>(object: &'a RawValue, key: &str) -> Option<&'a RawValue> {
    members(object.get(), [key]).and_then(|[value]| value)
}

struct Members<'k, const N: usize> {
    keys: [&'k str; N],
}

impl<'de, const N: usize> DeserializeSeed<'de> for Members<'_, N> {
    type Value = [Option<&'de RawValue>; N];

    fn deserialize<D: de::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de, const N: usize> Visitor<'de> for Members<'_, N> {
    type Value = [Option<&'de RawValue>; N];

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut found = [None; N];
        while let Some(Key(key)) = map.next_key()? {
            match self
                .keys
                .iter()
                .position(|k| k.as_bytes() == key.as_slice())
            {
                Some(i) => found[i] = Some(map.next_value::<&RawValue>()?),
                None => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(found)
    }
}

/// An object key, decoded without validating its escapes (a lone surrogate is kept as its WTF-8 bytes).
struct Key(Vec<u8>);

impl<'de> de::Deserialize<'de> for Key {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_bytes(BytesVisitor).map(Key)
    }
}

struct BytesVisitor;

impl Visitor<'_> for BytesVisitor {
    type Value = Vec<u8>;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON string")
    }

    fn visit_bytes<E: de::Error>(self, v: &[u8]) -> Result<Vec<u8>, E> {
        Ok(v.to_vec())
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Vec<u8>, E> {
        Ok(v.as_bytes().to_vec())
    }
}

/// The string a raw JSON value holds, `None` when it is not a string. A lone surrogate becomes U+FFFD.
pub fn string_lossy(raw: &RawValue) -> Option<String> {
    let text = raw.get();
    if !text.starts_with('"') {
        return None;
    }
    serde_json::from_str::<String>(text)
        .ok()
        .or_else(|| serde_json::from_str(&without_lone_surrogates(text)).ok())
}

/// `text` parsed into a value, with every lone surrogate escape read as U+FFFD; `None` when it is no JSON for serde_json
/// even so (nesting deeper than 128).
pub fn value_lossy(text: &str) -> Option<Value> {
    serde_json::from_str(text)
        .ok()
        .or_else(|| serde_json::from_str(&without_lone_surrogates(text)).ok())
}

/// `text` with every lone surrogate escape inside a string replaced by `\ufffd` (a well-formed pair stays).
pub fn without_lone_surrogates(text: &str) -> String {
    let b = text.as_bytes();
    let hex4 = |at: usize| -> Option<u32> {
        let digits = b.get(at..at + 4)?;
        let s = std::str::from_utf8(digits).ok()?;
        u32::from_str_radix(s, 16).ok()
    };
    let is_high = |c: u32| (0xD800..0xDC00).contains(&c);
    let is_low = |c: u32| (0xDC00..0xE000).contains(&c);
    let mut out = Vec::with_capacity(b.len());
    let mut in_string = false;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'"' => {
                in_string = !in_string;
                out.push(b'"');
                i += 1;
            }
            b'\\' if in_string => {
                let unit = (b.get(i + 1) == Some(&b'u')).then(|| hex4(i + 2)).flatten();
                match unit {
                    Some(high) if is_high(high) => {
                        let low = (b.get(i + 6) == Some(&b'\\') && b.get(i + 7) == Some(&b'u'))
                            .then(|| hex4(i + 8))
                            .flatten();
                        if low.is_some_and(is_low) {
                            out.extend_from_slice(&b[i..i + 12]);
                            i += 12;
                        } else {
                            out.extend_from_slice(b"\\ufffd");
                            i += 6;
                        }
                    }
                    Some(low) if is_low(low) => {
                        out.extend_from_slice(b"\\ufffd");
                        i += 6;
                    }
                    _ => {
                        // Any other escape: copied as it is (a malformed one is refused by the parser anyway).
                        let end = (i + 2).min(b.len());
                        out.extend_from_slice(&b[i..end]);
                        i = end;
                    }
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Where the raw member `part` sits in `text` (it must be a slice of it, as [`members`] returns): `(start, end)`.
pub fn span(text: &str, part: &RawValue) -> Option<(usize, usize)> {
    let start = (part.get().as_ptr() as usize).checked_sub(text.as_ptr() as usize)?;
    let end = start.checked_add(part.get().len())?;
    (text.get(start..end) == Some(part.get())).then_some((start, end))
}

/// `text` with the raw member `part` replaced by `with` (raw JSON text), or `None` when `part` is not a slice of `text`.
pub fn splice(text: &str, part: &RawValue, with: &str) -> Option<Vec<u8>> {
    let (start, end) = span(text, part)?;
    let mut out = Vec::with_capacity(text.len() + with.len());
    out.extend_from_slice(&text.as_bytes()[..start]);
    out.extend_from_slice(with.as_bytes());
    out.extend_from_slice(&text.as_bytes()[end..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn deep(n: usize) -> String {
        format!("{}0{}", "[".repeat(n), "]".repeat(n))
    }

    #[test]
    fn the_routing_members_are_read_from_frames_serde_json_refuses() {
        let surrogate = r#"{"jsonrpc":"2.0","id":"a","method":"m","params":{"t":"cut \ud83d"}}"#;
        assert!(
            serde_json::from_str::<Value>(surrogate).is_err(),
            "the case at hand"
        );
        let [id, method, missing] = members(surrogate, ["id", "method", "api"]).unwrap();
        assert_eq!(
            (id.unwrap().get(), method.unwrap().get()),
            (r#""a""#, r#""m""#)
        );
        assert!(missing.is_none());
        let nested = format!(r#"{{"id":7,"result":{{"v":{}}},"method":"x"}}"#, deep(200));
        assert!(
            serde_json::from_str::<Value>(&nested).is_err(),
            "deeper than 128"
        );
        let [id, method] = members(&nested, ["id", "method"]).unwrap();
        assert_eq!((id.unwrap().get(), method.unwrap().get()), ("7", r#""x""#));
        let in_key = r#"{"\udc00":1,"id":2}"#;
        assert_eq!(
            members(in_key, ["id"]).unwrap()[0].unwrap().get(),
            "2",
            "a lone surrogate in a key"
        );
        let surrogate_id = r#"{"id":"x\ud800","method":"\u006d"}"#;
        let [id, method] = members(surrogate_id, ["id", "method"]).unwrap();
        assert_eq!(id.unwrap().get(), r#""x\ud800""#, "the id as written");
        assert_eq!(
            string_lossy(method.unwrap()).as_deref(),
            Some("m"),
            "escapes in a value are decoded"
        );
    }

    #[test]
    fn a_repeated_key_is_the_last_one_and_only_one_object_counts() {
        let [id] = members(r#"{"id":1,"id":2}"#, ["id"]).unwrap();
        assert_eq!(id.unwrap().get(), "2", "JSON.parse keeps the last");
        let [id] = members(r#"{"\u0069d":3}"#, ["id"]).unwrap();
        assert_eq!(id.unwrap().get(), "3", "an escaped key is the key");
        for not_one_object in [
            "[1]",
            "5",
            "\"s\"",
            "{\"id\":1} {}",
            "{\"id\":1",
            "{not json",
            "",
            "null",
        ] {
            assert!(
                members(not_one_object, ["id"]).is_none(),
                "{not_one_object:?}"
            );
        }
        assert_eq!(
            members(" {\"id\" : null } \n", ["id"]).unwrap()[0]
                .unwrap()
                .get(),
            "null"
        );
    }

    #[test]
    fn strings_and_values_are_read_with_lone_surrogates_as_replacement_characters() {
        let [s] = members(r#"{"s":"a\ud83db"}"#, ["s"]).unwrap();
        assert_eq!(string_lossy(s.unwrap()).unwrap(), "a\u{fffd}b");
        let [n] = members(r#"{"n":5}"#, ["n"]).unwrap();
        assert_eq!(string_lossy(n.unwrap()), None, "not a string");
        let [params] = members(
            r#"{"params":{"nonce":"a\udc00","deep":[[[1]]]}}"#,
            ["params"],
        )
        .unwrap();
        let nonce = member(params.unwrap(), "nonce").unwrap();
        assert_eq!(
            string_lossy(nonce).unwrap(),
            "a\u{fffd}",
            "a member of a member"
        );
        assert!(member(params.unwrap(), "absent").is_none());
        assert!(member(nonce, "x").is_none(), "a string has no members");
        assert_eq!(
            value_lossy(
                r#"{"a":"\ud83d\ude00","b":"\ud83d","c":"\ude00x","d":"\\ud800","e":"\"\ud800"}"#
            ),
            Some(json!({"a":"😀","b":"\u{fffd}","c":"\u{fffd}x","d":"\\ud800","e":"\"\u{fffd}"})),
            "a pair stays, lone halves are replaced, an escaped backslash is no escape"
        );
        assert_eq!(
            value_lossy(r#"{"k\ud800":1}"#),
            Some(json!({"k\u{fffd}":1}))
        );
        assert_eq!(value_lossy(&deep(200)), None, "nesting is not repaired");
        assert_eq!(value_lossy("{bad"), None);
    }

    #[test]
    fn a_member_is_spliced_in_place_and_the_rest_stays_as_written() {
        let text = r#"{"jsonrpc":"2.0", "id" : "c-1","method":"core.adopt","params":{"n":1.0,"_meta":{"x":"\ud800"}}}"#;
        let [id] = members(text, ["id"]).unwrap();
        let out = splice(text, id.unwrap(), r#""fd-ab-1""#).unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            r#"{"jsonrpc":"2.0", "id" : "fd-ab-1","method":"core.adopt","params":{"n":1.0,"_meta":{"x":"\ud800"}}}"#
        );
        let other: Box<RawValue> = serde_json::from_str(r#""c-1""#).unwrap();
        assert_eq!(
            span(text, &other),
            None,
            "a value from another text has no place in this one"
        );
    }
}
