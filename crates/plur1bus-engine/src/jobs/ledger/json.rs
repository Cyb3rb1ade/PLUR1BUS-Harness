//! JSON.parse plus JSON.stringify object/number semantics for Node's opaque ledger objects.
use crate::text::{js::JsString, json::TolerantJsonValue as Json};
pub(super) fn node_value(value: Json) -> Json {
    match value {
        Json::Number(text) => match text.parse::<f64>() {
            Ok(value) if value.is_finite() => {
                Json::Number(ryu_js::Buffer::new().format(value).to_owned())
            }
            _ => Json::Null,
        },
        Json::Array(values) => Json::Array(values.into_iter().map(node_value).collect()),
        Json::Object(values) => {
            let mut fields = Vec::new();
            for (name, value) in values {
                super::set(&mut fields, name, node_value(value));
            }
            fields.sort_by_key(|(name, _)| index(name).map_or((1, 0), |i| (0, i)));
            Json::Object(fields)
        }
        other => other,
    }
}
fn index(name: &JsString) -> Option<u32> {
    let text = name.to_utf8_lossy();
    let number = text.parse::<u32>().ok().filter(|n| *n != u32::MAX)?;
    (number.to_string() == text).then_some(number)
}
