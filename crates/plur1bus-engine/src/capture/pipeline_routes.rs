//! Concrete host LLM summary route; no built-in external capture decision transport.
//!
//! Prompt bytes follow Node. Frozen LlmParams cannot carry Node's `purpose` or signal:
//! the purpose is the fixed adapter stage, while the signal is the existing Cancel argument.

use std::sync::Arc;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::context::RequestContext;
use crate::contract::{
    Cancel, EngineError, HostError, HostServices, LlmParams, Message, MessageRole,
};
use crate::text::js::JsString;

use super::CaptureSummary;

/// The concrete capture-summary route over the existing host LLM port.
pub struct HostCaptureSummary {
    host: Arc<dyn HostServices>,
    model: Option<String>,
}

impl HostCaptureSummary {
    /// Configure the same optional `llmRouter.defaultModel` override as the Node feature route.
    #[must_use]
    pub fn new(host: Arc<dyn HostServices>, model: Option<String>) -> Self {
        Self { host, model }
    }

    /// Build the exact Node summary prompt, including its 60,000-unit UTF-16 input cut.
    #[must_use]
    pub fn prompt(text: &JsString, max_chars: usize) -> JsString {
        let target = (max_chars as f64 / 4.0).round();
        let prefix = format!("Summarize this text into the most important facts, decisions, preferences, and actionable information. Keep all specific names, numbers, URLs, dates, technical details, and configuration values. Output ONLY the summary, no preamble. Target length: {target} characters.\n\n");
        let mut units = JsString::from(prefix).into_utf16_units();
        units.extend_from_slice(text.utf16_slice(0, 60_000).as_utf16_units());
        JsString::from_utf16_units(units)
    }

    /// Node `JSON.stringify(messages)` bytes used to address recorded prompt fixtures.
    #[must_use]
    pub fn messages_json(text: &JsString, max_chars: usize) -> String {
        format!(
            "[{{\"role\":\"user\",\"content\":{}}}]",
            Self::prompt(text, max_chars).to_json()
        )
    }

    /// SHA-256 of the exact Node message JSON, excluding runtime-only signal objects.
    #[must_use]
    pub fn prompt_hash(text: &JsString, max_chars: usize) -> String {
        format!(
            "{:x}",
            Sha256::digest(Self::messages_json(text, max_chars).as_bytes())
        )
    }

    /// Build every summary parameter expressible by the frozen host contract.
    pub fn params(&self, text: &JsString, max_chars: usize) -> Result<LlmParams, EngineError> {
        // F3: keep Node's prompt/hash projection, but send only complete code points.
        let content = super::super::output_unicode::external(&Self::prompt(text, max_chars));
        Ok(LlmParams {
            messages: vec![Message {
                role: MessageRole::User,
                content,
            }],
            max_tokens: Some(((max_chars as f64 / 3.0).round() as u64).into()),
            temperature: Some(0.into()),
            model: self.model.clone(),
        })
    }

    /// Serialize contract-expressible parameters in Node request order for boundary goldens.
    pub fn contract_params_json(params: &LlmParams) -> Result<String, EngineError> {
        #[derive(Serialize)]
        struct NodeMessage<'a> {
            role: &'a MessageRole,
            content: &'a str,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Params<'a> {
            messages: Vec<NodeMessage<'a>>,
            #[serde(skip_serializing_if = "Option::is_none")]
            max_tokens: Option<&'a serde_json::Number>,
            #[serde(skip_serializing_if = "Option::is_none")]
            temperature: Option<&'a serde_json::Number>,
            #[serde(skip_serializing_if = "Option::is_none")]
            model: Option<&'a str>,
        }
        serde_json::to_string(&Params {
            messages: params
                .messages
                .iter()
                .map(|message| NodeMessage {
                    role: &message.role,
                    content: &message.content,
                })
                .collect(),
            max_tokens: params.max_tokens.as_ref(),
            temperature: params.temperature.as_ref(),
            model: params.model.as_deref(),
        })
        .map_err(|_| HostError::InvalidResponse.into())
    }
}

impl CaptureSummary for HostCaptureSummary {
    fn summarize(
        &self,
        text: &JsString,
        max_chars: usize,
        _context: &RequestContext,
        cancel: &Cancel,
    ) -> Result<JsString, EngineError> {
        cancel.check()?;
        let llm = self.host.llm().ok_or(HostError::Unavailable)?;
        let result = llm.complete(self.params(text, max_chars)?, cancel)?;
        cancel.check()?;
        let summary = JsString::from(result.text);
        Ok(if summary.utf16_len() > 20 {
            summary
        } else {
            text.utf16_slice(0, max_chars)
        })
    }
}
