//! Concrete host LLM and guarded Jev routes used by the capture worker.
//!
//! Prompt bytes follow Node. Frozen LlmParams cannot carry Node's `purpose` or signal:
//! the purpose is the fixed adapter stage, while the signal is the existing Cancel argument.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::context::RequestContext;
use crate::contract::{
    Cancel, Decision, EgressGate, EngineError, HostError, HostServices, LlmParams, Message,
    MessageRole, SecretValue, Target,
};
use crate::text::js::{js_trim, JsString};
use crate::transport::{GuardedClient, HttpRequest, SystemResolver};

use super::super::chunk_decider::{request_json, storage_for_answer, Storage};
use super::{CaptureChunkDecider, CaptureSummary, StorageDecision};

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

struct HostGate(Arc<dyn HostServices>);
impl EgressGate for HostGate {
    fn decide(&self, target: &Target) -> Decision {
        self.0.egress().decide(target)
    }
}

/// An authenticated Jev route; its secret is deliberately neither Debug nor serializable.
pub struct JevChunkDecider {
    client: Arc<GuardedClient<'static>>,
    credential: SecretValue,
    model: String,
    minimum: f64,
    timeout: Duration,
    endpoint: String,
}

impl JevChunkDecider {
    /// Resolve only a named SecretPort value. Missing credentials mean Node's no-decider fallback.
    /// No ambient environment value or config-held secret is read or retained in diagnostics.
    pub fn from_host(
        host: Arc<dyn HostServices>,
        config: &Value,
    ) -> Result<Option<Self>, EngineError> {
        let name = config["apiKeyEnv"]
            .as_str()
            .map(js_trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("TYPESAFE_API_KEY");
        let Some(port) = host.secrets() else {
            return Ok(None);
        };
        let Some(credential) = port.get(name)? else {
            return Ok(None);
        };
        if js_trim(credential.expose()).is_empty() {
            return Ok(None);
        }
        let model = config["model"]
            .as_str()
            .map(js_trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("jev-latest")
            .to_string();
        let minimum = config["minConfidence"]
            .as_f64()
            .filter(|value| value.is_finite())
            .unwrap_or(0.85);
        let milliseconds = config["timeoutMs"]
            .as_f64()
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(5000.0);
        let timeout = Duration::try_from_secs_f64(milliseconds / 1000.0)
            .map_err(|_| HostError::InvalidResponse)?;
        let client = Arc::new(GuardedClient::new_owned(
            Arc::new(HostGate(host)),
            Box::new(SystemResolver),
        ));
        Ok(Some(Self {
            client,
            credential,
            model,
            minimum,
            timeout,
            endpoint: "https://api.typesafe.ai/v1/systemone".into(),
        }))
    }
}

fn confidence(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(value) => Some(f64::from(u8::from(*value))),
        Value::Number(value) => value.as_f64(),
        Value::String(value) => {
            let value = js_trim(value);
            if value.is_empty() {
                Some(0.0)
            } else {
                value.parse().ok()
            }
        }
        _ => None,
    }
}

impl CaptureChunkDecider for JevChunkDecider {
    fn decide(
        &self,
        text: &JsString,
        _context: &RequestContext,
        cancel: &Cancel,
    ) -> Result<StorageDecision, EngineError> {
        cancel.check()?;
        if js_trim(&text.to_utf8_lossy()).is_empty() {
            return Ok(StorageDecision::Both);
        }
        let remaining = cancel
            .remaining()
            .map_or(self.timeout, |remaining| remaining.min(self.timeout));
        let deadline = Instant::now()
            .checked_add(remaining)
            .ok_or(HostError::InvalidResponse)?;
        let request = HttpRequest {
            method: "POST".into(),
            url: self.endpoint.clone(),
            headers: vec![
                (
                    "Authorization".into(),
                    format!("Bearer {}", js_trim(self.credential.expose())),
                ),
                ("Content-Type".into(), "application/json".into()),
            ],
            body: request_json(
                &self.model,
                &JsString::from(super::super::output_unicode::external(
                    &text.utf16_slice(0, 60_000),
                )),
            )
            .into_bytes(),
            max_response_bytes: 1024 * 1024,
            max_error_response_bytes: 64 * 1024,
            auth_rejection_counter: None,
        };
        let response = self
            .client
            .request_cancelled(request, deadline, cancel)
            .map_err(|error| match error {
                crate::transport::TransportError::Cancelled(reason) => {
                    EngineError::Cancelled(reason)
                }
                crate::transport::TransportError::Denied
                | crate::transport::TransportError::AddressDenied => HostError::Denied.into(),
                _ => HostError::Failed.into(),
            })?;
        if !(200..300).contains(&response.status) {
            return Err(HostError::Failed.into());
        }
        let body: Value =
            serde_json::from_slice(&response.body).map_err(|_| HostError::InvalidResponse)?;
        let answer = &body["answers"]["structure"];
        Ok(
            match storage_for_answer(
                answer["choice"].as_str(),
                confidence(&answer["confidence"]),
                self.minimum,
            ) {
                Storage::Whole => StorageDecision::Whole,
                Storage::Parts => StorageDecision::Parts,
                Storage::Both => StorageDecision::Both,
            },
        )
    }
}
