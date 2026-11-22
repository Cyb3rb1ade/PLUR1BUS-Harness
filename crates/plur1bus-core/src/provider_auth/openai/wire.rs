//! `openai-auth/wire.ts`: the closed wire guard of the plan route. An unknown field is refused rather than silently weakening
//! what the caller asked for; only function tools, no system role, only text, image and refusal content parts. The request
//! goes out with `store: false` and `stream: true`.
//!
//! The answer is a `serde_json` object, whose members are in key order where TypeScript keeps the caller's order (a known
//! difference of the JSON body's member order, nothing a server reads).
use super::ports::{fail, OpenAIError};
use serde_json::Value;

const ALLOWED: [&str; 12] = [
    "model",
    "input",
    "instructions",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning",
    "text",
    "store",
    "stream",
    "include",
    "service_tier",
];
const CONTENT: [&str; 4] = ["input_text", "output_text", "input_image", "refusal"];

fn truthy(v: Option<&Value>) -> bool {
    v.is_some_and(super::super::record::truthy)
}

/// `guardSiwc(request)`.
pub fn guard_siwc(request: &Value) -> Result<Value, OpenAIError> {
    let Value::Object(r) = request else {
        return fail("siwc-unsupported");
    };
    if r.keys().any(|k| !ALLOWED.contains(&k.as_str())) {
        return fail("siwc-unsupported");
    }
    if let Some(tools) = r.get("tools") {
        let ok = tools.as_array().is_some_and(|a| {
            a.iter()
                .all(|t| t.is_object() && t.get("type").and_then(Value::as_str) == Some("function"))
        });
        if !ok {
            return fail("siwc-unsupported");
        }
    }
    if let Some(input) = r.get("input").filter(|i| !i.is_string()) {
        let Some(items) = input.as_array() else {
            return fail("siwc-unsupported");
        };
        for item in items {
            // `typeof item === "object"` holds for an array too; it has no role, type or content.
            if !(item.is_object() || item.is_array())
                || item.get("role").and_then(Value::as_str) == Some("system")
            {
                return fail("siwc-unsupported");
            }
            // `item.type && !['message', ...].includes(item.type)`: a truthy type must be one of the three.
            if truthy(item.get("type"))
                && !matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("message" | "function_call" | "function_call_output")
                )
            {
                return fail("siwc-unsupported");
            }
            if let Some(content) = item.get("content").filter(|c| !c.is_string()) {
                let ok = content.as_array().is_some_and(|parts| {
                    parts.iter().all(|p| {
                        p.is_object()
                            && CONTENT
                                .contains(&p.get("type").and_then(Value::as_str).unwrap_or(""))
                    })
                });
                if !ok {
                    return fail("siwc-unsupported");
                }
            }
        }
    }
    let mut out = r.clone();
    out.insert("store".into(), Value::Bool(false));
    out.insert("stream".into(), Value::Bool(true));
    Ok(Value::Object(out))
}
