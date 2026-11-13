//! Native job completion requirements and per-call feature credentials.
//!
//! The host owns provider selection and policy. A job supplies the limits for the
//! selected prompt. A configured secret reference is authoritative for direct routes.
use crate::{
    contract::{
        AgentId, Cancel, HostError, LlmParams, LlmPort, LlmResult, Message, MessageRole,
        SecretPort, SecretValue,
    },
    text::js::JsString,
};
use serde_json::Value;

/// Native composition callback. The host retains its authentication and provider policy.
pub type CompleteFor =
    dyn Fn(&AgentId, &LlmParams, &Cancel) -> Result<LlmResult, HostError> + Send + Sync;

/// A completion scoped to the owner-bound agent of a single admitted job.
pub(crate) struct JobCompletion<'a> {
    pub(crate) authority: &'a super::authority::JobAuthority,
    pub(crate) complete: &'a CompleteFor,
    pub(crate) model: Option<String>,
}

impl LlmPort for JobCompletion<'_> {
    fn complete(&self, mut params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError> {
        cancel.check()?;
        if params.model.is_none() {
            params.model.clone_from(&self.model);
        }
        (self.complete)(&self.authority.request().agent_id, &params, cancel)
    }
}

/// A feature-owned endpoint or credential must never fall back to the host profile.
pub(crate) fn has_direct_transport(settings: &Value) -> bool {
    ["baseUrl", "apiKey", "apiKeyRef", "headers"]
        .iter()
        .any(|key| match &settings[*key] {
            Value::Null | Value::Bool(false) => false,
            Value::String(value) => !value.is_empty(),
            _ => true,
        })
}

/// The model selection for a feature which uses only the host's routed transport.
pub(crate) fn host_model(
    config: &Value,
    agent: &AgentId,
    feature: &str,
    configured: &Value,
) -> Option<String> {
    let router = &config["llmRouter"];
    let choices = &router["agentModels"][agent.as_str()];
    [
        &choices[feature],
        &choices["*"],
        configured,
        &router["defaultModel"],
    ]
    .into_iter()
    .filter_map(Value::as_str)
    .map(str::trim)
    .find(|value| !value.is_empty())
    .map(str::to_owned)
}

/// Fixed job request purposes with CP-1 ceilings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    /// Classify a conflict between two cards.
    ConflictResolution,
    /// Decide whether two cards can be compacted.
    MergeDecision,
    /// Refine a card's importance, intent and emotion.
    EmotionRefine,
    /// Classify the encoding decision.
    Encoding,
    /// Extract insights from recent conversation turns.
    ConversationInsights,
    /// Summarize the pattern of a REM cluster.
    RemPatternAnalysis,
    /// Write a short light-dream narrative.
    LightNarrative,
    /// Write a REM narrative.
    RemNarrative,
    /// Enrich an existing episode.
    EpisodeAnalysis,
    /// Extract a repeatable skill from evidence.
    SkillExtraction,
    /// Describe the benefit of a skill proposal.
    SkillBenefit,
}

impl Purpose {
    /// CP-1 output ceiling for the purpose (release 7.18.23).
    #[must_use]
    pub const fn max_tokens(self) -> u32 {
        match self {
            Self::MergeDecision | Self::EmotionRefine => 450,
            Self::Encoding => 24,
            Self::ConversationInsights | Self::ConflictResolution | Self::LightNarrative => 600,
            Self::RemPatternAnalysis => 900,
            Self::RemNarrative | Self::SkillExtraction => 1200,
            Self::EpisodeAnalysis => 750,
            Self::SkillBenefit => 300,
        }
    }

    /// The pinned default sampling temperature for a purpose.
    #[must_use]
    pub const fn temperature(self) -> f64 {
        match self {
            Self::LightNarrative | Self::RemNarrative => 0.9,
            _ => 0.0,
        }
    }

    /// Project a one-message prompt onto the existing host contract.
    /// A split surrogate is removed at the F3 wire boundary. The internal prompt remains exact.
    #[must_use]
    pub fn params(self, prompt: &JsString, model: Option<String>) -> LlmParams {
        let content = char::decode_utf16(prompt.as_utf16_units().iter().copied())
            .filter_map(Result::ok)
            .collect();
        LlmParams {
            messages: vec![Message {
                role: MessageRole::User,
                content,
            }],
            max_tokens: Some(self.max_tokens().into()),
            temperature: serde_json::Number::from_f64(self.temperature()),
            model,
        }
    }
}

/// CP-1 host reasoning override. `None` leaves the provider's default in effect.
#[must_use]
pub fn disable_reasoning(model: &str, route: Option<bool>, call: Option<bool>) -> bool {
    call.or(route).unwrap_or_else(|| {
        const HAIKU: &str = "anthropic/claude-haiku-";
        model
            .get(..HAIKU.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(HAIKU))
    })
}

/// CP-1 summary output ceiling. The wording and input cut still use RE-D24's pinned rules.
#[must_use]
pub const fn summary_max_tokens(max_chars: usize) -> usize {
    max_chars.div_ceil(2)
}

/// Resolve a configured credential for one direct call. A present reference that cannot
/// be resolved aborts the call. A literal is eligible only when there is no reference.
pub fn feature_credential(
    secrets: Option<&dyn SecretPort>,
    reference: Option<&str>,
    literal: Option<&str>,
) -> Result<Option<SecretValue>, HostError> {
    if let Some(name) = reference.map(str::trim).filter(|name| !name.is_empty()) {
        let value = secrets.ok_or(HostError::Unavailable)?.get(name)?;
        return value
            .filter(|value| !value.expose().trim().is_empty())
            .map(Some)
            .ok_or(HostError::Unavailable);
    }
    Ok(literal
        .filter(|key| !key.trim().is_empty())
        .map(SecretValue::new))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "literal model selection fixtures")]
mod tests {
    use super::*;

    struct Secrets;
    impl SecretPort for Secrets {
        fn get(&self, name: &str) -> Result<Option<SecretValue>, HostError> {
            Ok((name == "feature/key").then(|| SecretValue::new("from store")))
        }
    }

    #[test]
    fn a_set_reference_precedes_a_literal_and_never_falls_back() {
        let store: &dyn SecretPort = &Secrets;
        let resolved = feature_credential(Some(store), Some("feature/key"), Some("literal"));
        assert!(matches!(resolved, Ok(Some(value)) if value.expose() == "from store"));
        assert!(feature_credential(Some(store), Some("missing"), Some("literal")).is_err());
        assert!(feature_credential(None, Some("feature/key"), Some("literal")).is_err());
        let resolved = feature_credential(Some(store), Some(""), Some("literal"));
        assert!(matches!(resolved, Ok(Some(value)) if value.expose() == "literal"));
    }

    #[test]
    fn the_host_model_uses_feature_then_agent_then_router_defaults() {
        let config = serde_json::json!({
            "llmRouter":{
                "defaultModel":"provider/default",
                "agentModels":{
                    "alpha":{"*":"provider/alpha","episode-extraction":"provider/episode"},
                    "beta":{"episode-extraction":" "}
                }
            }
        });
        let alpha: AgentId = serde_json::from_value(serde_json::json!("alpha")).unwrap();
        let beta: AgentId = serde_json::from_value(serde_json::json!("beta")).unwrap();
        assert_eq!(
            host_model(&config, &alpha, "episode-extraction", &Value::Null).as_deref(),
            Some("provider/episode")
        );
        assert_eq!(
            host_model(&config, &alpha, "conversation-insights", &Value::Null).as_deref(),
            Some("provider/alpha")
        );
        assert_eq!(
            host_model(&config, &beta, "episode-extraction", &Value::Null).as_deref(),
            Some("provider/default")
        );
    }

    #[test]
    fn the_cp1_reasoning_default_is_route_specific_and_explicit_overrides_win() {
        let haiku = "Anthropic/Claude-Haiku-5.5";
        assert!(disable_reasoning(haiku, None, None));
        assert!(!disable_reasoning(haiku, Some(false), None));
        assert!(disable_reasoning(haiku, Some(false), Some(true)));
        assert!(!disable_reasoning("anthropic/claude-sonnet-4", None, None));
    }

    #[test]
    fn the_cp1_ceilings_match_the_job_call_sites() {
        use Purpose::*;
        for (purpose, limit) in [
            (ConflictResolution, 600),
            (MergeDecision, 450),
            (EmotionRefine, 450),
            (Encoding, 24),
            (ConversationInsights, 600),
            (RemPatternAnalysis, 900),
            (LightNarrative, 600),
            (RemNarrative, 1200),
            (EpisodeAnalysis, 750),
            (SkillExtraction, 1200),
            (SkillBenefit, 300),
        ] {
            assert_eq!(purpose.max_tokens(), limit);
        }
        assert_eq!(summary_max_tokens(500), 250);
        assert_eq!(summary_max_tokens(501), 251);
    }
}
