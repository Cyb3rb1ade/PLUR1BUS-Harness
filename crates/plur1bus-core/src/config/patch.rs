//! `flattenPatch` and `FILE_POLL_MS` of `config-source.ts`: the pure part of the configuration source. A patch under a
//! prefix becomes the `config.set` changes of its leaves; arrays and non-objects are leaves.
use serde_json::{Map, Value};

/// The interval of the stat check that backs the directory watcher: a change to config.json reaches the listeners within
/// this interval at the latest, whatever the OS reports.
pub const FILE_POLL_MS: u64 = 1000;

/// A refused patch: a key that would address another path, or nesting beyond 32 levels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchError(pub String);

impl std::fmt::Display for PatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PatchError {}

const MAX_DEPTH: usize = 32;

/// `JSON.stringify` of UTF-16 code units: a lone surrogate is written as the escape `\udXXX`.
fn stringify_units(units: &[u16]) -> String {
    let mut out = String::from("\"");
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(c) if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            Ok(c) => out.push(c),
            Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
        }
    }
    out.push('"');
    out
}

fn segment(key: &str) -> Result<&str, PatchError> {
    if key.is_empty() || key.contains('.') || key == "__proto__" {
        let units: Vec<u16> = key.encode_utf16().take(40).collect();
        return Err(PatchError(format!(
            "configuration patch key {} is not a valid key",
            stringify_units(&units)
        )));
    }
    Ok(key)
}

/// The leaves of `patch` as `config.set` changes under `prefix`, `(key, value)` in key order (`serde_json` sorts the
/// members; TypeScript keeps insertion order). A key with a dot would address a different path than the one written, an
/// empty key addresses nothing and `__proto__` is never a configuration key; nesting beyond 32 levels is refused.
pub fn flatten_patch(
    prefix: &str,
    patch: &Map<String, Value>,
) -> Result<Vec<(String, Value)>, PatchError> {
    fn walk(
        prefix: &str,
        path: String,
        value: &Value,
        depth: usize,
        out: &mut Vec<(String, Value)>,
    ) -> Result<(), PatchError> {
        if depth > MAX_DEPTH {
            return Err(PatchError(format!(
                "configuration patch under {prefix} is nested too deeply (or cyclic)"
            )));
        }
        if let Value::Object(map) = value {
            for (k, x) in map {
                walk(prefix, format!("{path}.{}", segment(k)?), x, depth + 1, out)?;
            }
            return Ok(());
        }
        out.push((path, value.clone()));
        Ok(())
    }
    let mut out = Vec::new();
    for (k, v) in patch {
        walk(prefix, format!("{prefix}.{}", segment(k)?), v, 0, &mut out)?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[allow(clippy::needless_pass_by_value)] // json! literals are passed by value at every call site
    fn map(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn yields_leaf_keys() {
        assert_eq!(
            flatten_patch("engine", &map(json!({"recall": {"x": 1}, "tags": ["a"]}))).unwrap(),
            vec![
                ("engine.recall.x".to_owned(), json!(1)),
                ("engine.tags".to_owned(), json!(["a"]))
            ]
        );
        assert!(flatten_patch("engine", &Map::new()).unwrap().is_empty());
        assert_eq!(
            flatten_patch("engine", &map(json!({"a": null, "b": {"c": {"d": false}}}))).unwrap(),
            vec![
                ("engine.a".to_owned(), Value::Null),
                ("engine.b.c.d".to_owned(), json!(false))
            ]
        );
    }

    #[test]
    fn refuses_keys_that_would_address_a_different_path() {
        for patch in [
            json!({"a.b": 1}),
            json!({"": 1}),
            serde_json::from_str(r#"{"a":{"__proto__":{"x":1}}}"#).unwrap(),
        ] {
            let e = flatten_patch("engine", &map(patch)).unwrap_err();
            assert!(e.0.contains("key"), "{e}");
        }
        assert_eq!(
            flatten_patch("engine", &map(json!({"a": {"b": 1}, "c": [1]}))).unwrap(),
            vec![
                ("engine.a.b".to_owned(), json!(1)),
                ("engine.c".to_owned(), json!([1]))
            ]
        );
    }

    #[test]
    fn refuses_nesting_beyond_32_levels_instead_of_overflowing() {
        let nest = |levels: usize| {
            let mut v = json!(1);
            for _ in 0..levels {
                v = json!({ "a": v });
            }
            map(v)
        };
        // The value under the first key sits at depth 0; a leaf at depth 32 is the deepest one allowed.
        assert_eq!(flatten_patch("engine", &nest(33)).unwrap().len(), 1);
        let e = flatten_patch("engine", &nest(34)).unwrap_err();
        assert!(e.0.contains("nested too deeply"));
        assert!(flatten_patch("engine", &nest(500)).is_err());
    }

    #[test]
    fn a_cut_key_is_shown_as_json_with_a_lone_surrogate_escaped() {
        let long = format!("{}.", "k".repeat(60));
        let e = flatten_patch("p", &map(json!({ long: 1 }))).unwrap_err();
        assert_eq!(
            e.0,
            format!(
                "configuration patch key \"{}\" is not a valid key",
                "k".repeat(40)
            )
        );
        // 39 units, then a pair: the cut keeps the high surrogate only.
        let key = format!("{}\u{1F600}.", "k".repeat(39));
        let e = flatten_patch("p", &map(json!({ key: 1 }))).unwrap_err();
        assert!(e.0.contains(&format!("{}\\ud83d\"", "k".repeat(39))), "{e}");
    }
}
