//! Caller-bound speaker proposals. Pending names never become confirmed mappings implicitly.
use super::{
    emotion_json::{array, get},
    speaker::{self, SpeakerProposal},
};
use crate::{
    contract::{AgentContext, Cancel, EngineError, Principal, StoreError},
    ops::context::OperationContext,
    store::sqlite::{SpeakerMapping, SpeakerMappings},
    text::{js::JsString, json::TolerantJsonValue as Json},
};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

/// Node-shaped result of inserting newly proposed labels.
#[derive(Debug, serde::Serialize)]
pub struct ProposalCounts {
    /// Newly inserted pending proposals.
    pub stored: usize,
    /// Existing pending/confirmed labels retained without modification.
    pub skipped: usize,
}
/// Proposed names and the outcome of the atomic insert-if-absent operations.
pub struct ProposalResult {
    /// Contextual suggestions, including those suppressed by an existing pending mapping.
    pub proposals: Vec<SpeakerProposal>,
    /// Durable insert counts; not a claim that proposals are confirmed.
    pub counts: ProposalCounts,
}
/// Host-owned facade over the existing Node-compatible SQLite schema.
pub struct CallerSpeakers {
    context: Arc<OperationContext>,
    mappings: Arc<SpeakerMappings>,
}
impl CallerSpeakers {
    /// The runtime supplies its authenticated operation context and prepared private SQLite store.
    pub fn new(context: Arc<OperationContext>, mappings: Arc<SpeakerMappings>) -> Self {
        Self { context, mappings }
    }
    /// Normalize and apply only the current agent's confirmed mappings.
    pub fn mapped_segments(
        &self,
        input: &Json,
        p: &Principal,
        a: &AgentContext,
        cancel: &Cancel,
    ) -> Result<Json, EngineError> {
        cancel.check()?;
        let op = self.context.enter(p, a)?;
        let normalized = validate(input)?;
        let rows = self.mappings.list(op.context.agent_id.as_str())?;
        let map = rows
            .into_iter()
            .filter(|m| m.confirmed == 1)
            .map(|m| {
                (
                    JsString::from(m.speaker_label.as_str()),
                    JsString::from(m.speaker_display_name.as_str()),
                )
            })
            .collect::<HashMap<_, _>>();
        cancel.check()?;
        Ok(speaker::apply_mappings(&normalized, &map))
    }
    /// Generate contextual proposals and insert only absent labels. Repeats retain pending/manual rows.
    /// A cancellation after an insertion does not undo that already durable row.
    pub fn propose_and_store(
        &self,
        input: &Json,
        p: &Principal,
        a: &AgentContext,
        cancel: &Cancel,
    ) -> Result<ProposalResult, EngineError> {
        cancel.check()?;
        let op = self.context.enter(p, a)?;
        let normalized = validate(input)?;
        let rows = self.mappings.list(op.context.agent_id.as_str())?;
        let confirmed = rows
            .into_iter()
            .filter(|m| m.confirmed == 1)
            .map(|m| JsString::from(m.speaker_label.as_str()))
            .collect::<HashSet<_>>();
        let proposals = speaker::propose(&normalized, &confirmed)?;
        let mut counts = ProposalCounts {
            stored: 0,
            skipped: 0,
        };
        for proposal in &proposals {
            cancel.check()?;
            self.context.assert_open()?;
            let mapping = SpeakerMapping {
                agent_id: op.context.agent_id.to_string(),
                speaker_label: strict(&proposal.speaker_label)?,
                speaker_display_name: strict(&proposal.display_name)?,
                attribution_source: "contextual_proposal".into(),
                confidence: Some(proposal.confidence),
                confirmed: 0,
                proposed_at: self.context.host().now_ms(),
                confirmed_at: None,
                context_hint: Some(strict(&proposal.context_hint)?),
            };
            if self.mappings.insert_proposal(&mapping)? {
                counts.stored += 1;
            } else {
                counts.skipped += 1;
            }
        }
        Ok(ProposalResult { proposals, counts })
    }
}
fn strict(value: &JsString) -> Result<String, EngineError> {
    String::from_utf16(value.as_utf16_units()).map_err(|_| StoreError::InvalidInput.into())
}
fn validate(input: &Json) -> Result<Json, EngineError> {
    let normalized = speaker::normalize_segments(input);
    for segment in array(&normalized) {
        // An opaque label cannot be repaired with replacement characters: that could alias another identity.
        if let Json::String(label) = get(segment, "speakerLabel") {
            strict(label)?;
        }
    }
    Ok(normalized)
}
