//! Typed UTF-8 JSON without an intermediate inexact decimal-to-float conversion.
use super::{parse_json, TolerantJsonError, TolerantJsonErrorKind, TolerantJsonValue as Json};
use serde_json::{Number, Value};
fn invalid() -> TolerantJsonError {
    TolerantJsonError {
        kind: TolerantJsonErrorKind::Syntax,
        offset: 0,
        message: "invalid typed JSON value".into(),
    }
}
fn string(value: &crate::text::js::JsString) -> Result<String, TolerantJsonError> {
    String::from_utf16(value.as_utf16_units()).map_err(|_| invalid())
}
fn convert(value: Json) -> Result<Value, TolerantJsonError> {
    Ok(match value {
        Json::Null => Value::Null,
        Json::Bool(value) => Value::Bool(value),
        Json::String(value) => Value::String(string(&value)?),
        Json::Number(text) => {
            let number = if let Ok(value) = text.parse::<i64>() {
                Number::from(value)
            } else if let Ok(value) = text.parse::<u64>() {
                Number::from(value)
            } else {
                Number::from_f64(text.parse::<f64>().map_err(|_| invalid())?).ok_or_else(invalid)?
            };
            Value::Number(number)
        }
        Json::Array(values) => {
            Value::Array(values.into_iter().map(convert).collect::<Result<_, _>>()?)
        }
        Json::Object(fields) => {
            let mut object = serde_json::Map::new();
            for (key, value) in fields {
                if object.insert(string(&key)?, convert(value)?).is_some() {
                    return Err(invalid());
                }
            }
            Value::Object(object)
        }
    })
}
/// Parse typed UTF-8 JSON with correctly rounded finite numbers and bounded depth.
/// Duplicate fields and unpaired UTF-16 units are refused; use `parse_json` when
/// retaining Node's unpaired units is required. Original golden bytes remain unchanged.
pub fn parse_exact(input: &str) -> Result<Value, TolerantJsonError> {
    convert(parse_json(input)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[allow(clippy::unwrap_used, reason = "test assertions")]
    fn exact_floats_and_integer_boundaries_survive_typed_parse() {
        let text = r#"{"value":0.41733280085163044,"smallest":5e-324,"max":18446744073709551615,"min":-9223372036854775808}"#;
        let value = parse_exact(text).unwrap();
        assert_eq!(
            value["value"].as_f64().unwrap().to_bits(),
            0.417_332_800_851_630_44_f64.to_bits()
        );
        assert_eq!(value["smallest"].as_f64().unwrap().to_bits(), 1);
        assert_eq!(value["max"].as_u64(), Some(u64::MAX));
        assert_eq!(value["min"].as_i64(), Some(i64::MIN));
        for bad in [r#"{"x":1,"x":2}"#, r#""\ud800""#, "1e999"] {
            assert!(parse_exact(bad).is_err());
        }
        assert!(parse_exact(&format!("{}0{}", "[".repeat(129), "]".repeat(129))).is_err());
    }
}
