//! Node's exact result-cache address and its versioned native extension.
use std::fmt::Write;

use sha2::{Digest, Sha256};

use crate::{
    store::sqlite::LlmResultKey,
    text::{js::JsString, json::TolerantJsonValue as Json},
};

/// Inputs that can change the result of one cacheable provider call.
pub struct Request<'a> {
    /// The original authorized cache scope.
    pub scope_id: &'a str,
    /// The operation's stable purpose name.
    pub purpose: &'a str,
    /// Resolved endpoint before request dispatch.
    pub endpoint: &'a str,
    /// Resolved credential. Only its digest participates in the key.
    pub credential: Option<&'a str>,
    /// Resolved model id.
    pub model: &'a str,
    /// Full request message array, including exact UTF-16 cuts.
    pub messages: &'a Json,
    /// Output budget.
    pub max_tokens: u32,
    /// Requested temperature. An omitted field hashes as JavaScript undefined.
    pub temperature: Option<f64>,
    /// Whether the result must be JSON.
    pub json_mode: bool,
    /// Whether the request disables model reasoning.
    pub disable_thinking: bool,
    /// Effective request headers.
    pub headers: &'a Json,
}

fn sha(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn quote(text: &str) -> String {
    JsString::from(text).to_json()
}

fn string(text: &str) -> String {
    format!("string:{}", quote(text))
}

fn number(value: f64) -> String {
    if value == 0.0 && value.is_sign_negative() {
        return "number:-0".to_owned();
    }
    format!("number:{}", ryu_js::Buffer::new().format(value))
}

fn stable(value: &Json) -> String {
    match value {
        Json::Null => "null".to_owned(),
        Json::Bool(value) => format!("boolean:{value}"),
        Json::String(value) => format!("string:{}", value.to_json()),
        Json::Number(value) => number(value.parse().unwrap_or(f64::NAN)),
        Json::Array(values) => format!(
            "array:[{}]",
            values.iter().map(stable).collect::<Vec<_>>().join(",")
        ),
        Json::Object(fields) => {
            let mut fields: Vec<_> = fields.iter().collect();
            fields.sort_by(|a, b| a.0.as_utf16_units().cmp(b.0.as_utf16_units()));
            let fields = fields
                .into_iter()
                .map(|(key, value)| format!("{}:{}", key.to_json(), stable(value)))
                .collect::<Vec<_>>()
                .join(",");
            format!("object:{{{fields}}}")
        }
    }
}

impl Request<'_> {
    /// Exact key for the pinned Node SQLite cache, preserving existing row addresses.
    #[must_use]
    pub fn node_key(&self) -> LlmResultKey {
        let fields = [
            ("cacheVersion", string("llm-result-cache-v1")),
            (
                "credentialHash",
                string(&sha(&self
                    .credential
                    .map_or_else(|| "null".to_owned(), string))),
            ),
            (
                "disableThinking",
                format!("boolean:{}", self.disable_thinking),
            ),
            ("endpoint", string(self.endpoint)),
            ("headersHash", string(&sha(&stable(self.headers)))),
            ("jsonMode", format!("boolean:{}", self.json_mode)),
            ("maxTokens", number(f64::from(self.max_tokens))),
            ("messages", stable(self.messages)),
            ("model", string(self.model)),
            ("purpose", string(self.purpose)),
            ("scopeId", string(self.scope_id)),
            (
                "temperature",
                self.temperature
                    .map_or_else(|| "undefined".to_owned(), number),
            ),
        ];
        let mut material = String::from("object:{");
        for (index, (name, value)) in fields.iter().enumerate() {
            if index != 0 {
                material.push(',');
            }
            let _ = write!(material, "{}:{value}", quote(name));
        }
        material.push('}');
        LlmResultKey {
            key_hash: sha(&material),
            purpose: self.purpose.to_owned(),
            model: self.model.to_owned(),
        }
    }

    /// Native versioned key. A changed template version can never reuse an older
    /// decision even when the two versions happen to render identical messages.
    #[must_use]
    pub fn versioned_key(&self, template_version: u32) -> LlmResultKey {
        let mut key = self.node_key();
        key.key_hash = sha(&format!("job-template:{template_version}:{}", key.key_hash));
        key
    }
}
