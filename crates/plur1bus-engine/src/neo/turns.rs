//! Actual C4 captured-turn shape and replay IDs. Pure construction does not grant write authority.
use super::{merged_order::field, turn_rules};
use crate::{
    capture::{dynamics::json_number, emotion_legacy, epistemic, tier1::Tier1Classifier},
    contract::{EngineError, StoreError},
    text::{
        js::{is_js_whitespace, js_trim, JsString},
        json::{write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};
/// Number of normalized UTF-16 units used in Node's replay identity.
pub const STATEMENT_UNITS: usize = 4000;
const STABLE_HASH_HEX_DIGITS: usize = 20;
/// Roles accepted by visible-conversation capture.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Role {
    /// Human conversation input.
    User,
    /// Assistant reply, claim or plan.
    Assistant,
    /// Host-proven tool output; provenance selection belongs to the adapter.
    Tool,
}
impl Role {
    /// Normalize the two historical tool-role spellings and surrounding JS whitespace.
    pub fn parse(value: &str) -> Option<Self> {
        match js_trim(value) {
            "user" => Some(Self::User),
            "assistant" => Some(Self::Assistant),
            "tool" | "toolResult" | "tool_result" => Some(Self::Tool),
            _ => None,
        }
    }
    /// Exact stored C4 role.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }
}
/// Explicit source facts for the normal captured-turn constructor. No UUID/time is invented.
pub struct TurnInput<'a> {
    /// Stable ID already chosen from authenticated conversation identity.
    pub id: &'a JsString,
    /// Host-selected workspace storage key.
    pub workspace_key: &'a JsString,
    /// Actual capturing agent ID.
    pub agent_id: &'a JsString,
    /// Current run/session label; not used by stable_turn_id.
    pub session_id: &'a JsString,
    /// Display ordering, separate from stable identity.
    pub turn_index: f64,
    /// Normalized source role.
    pub role: Role,
    /// Visible source text, with original UTF-16 units intact.
    pub content: &'a JsString,
    /// Selected visibility spelling; C4 fallback applies in this pure projection only.
    pub scope: &'a JsString,
    /// Actual tool invocation references; never inferred from content text.
    pub source_tool_call_ids: &'a [JsString],
    /// Actual preceding assistant turn references.
    pub replies_to_turn_ids: &'a [JsString],
    /// Explicit creation timestamp; empty input is refused.
    pub created_at: &'a JsString,
}
/// Reuses the native deterministic lexicon. No provider, previous-owner state or model is loaded.
pub struct TurnBuilder {
    lexicon: Tier1Classifier,
}
impl TurnBuilder {
    /// Load the pinned immutable vocabulary once for this builder.
    pub fn new() -> Result<Self, EngineError> {
        Ok(Self {
            lexicon: Tier1Classifier::new(&Json::Null)?,
        })
    }
    /// Construct the captured-turn defaults exactly. A separate writer must authorize/stamp
    /// the actual principal and narrow scope before persisting this otherwise ownerless projection.
    pub fn build(&self, input: &TurnInput<'_>) -> Result<Json, EngineError> {
        if input.id.is_empty() || input.created_at.is_empty() {
            return Err(StoreError::InvalidInput.into());
        }
        let content = trim(input.content);
        let (category, origin) = turn_rules::classify(&content, input.role)?;
        // The lexical projection persists no score timestamp; zero is a deterministic internal
        // calculation input, not the event's source time (which is always explicitly provided).
        let emotion = emotion_legacy::infer_sync(&self.lexicon, &content, 0)?;
        let role = input.role.as_str();
        let scope = scope(input.scope, input.role);
        let workspace = or_default(input.workspace_key);
        let agent = or_default(input.agent_id);
        let trust = match input.role {
            Role::User => "user_asserted",
            Role::Assistant => "assistant_asserted",
            Role::Tool => "tool_observed",
        };
        let origin = object(vec![
            ("kind", text(origin)),
            ("role", text(role)),
            (
                "sourceTurnIds",
                Json::Array(vec![Json::String(input.id.clone())]),
            ),
            ("sourceMemoryIds", empty()),
            (
                "sourceToolCallIds",
                Json::Array(
                    input
                        .source_tool_call_ids
                        .iter()
                        .filter(|id| !id.is_empty())
                        .cloned()
                        .map(Json::String)
                        .collect(),
                ),
            ),
            ("capturedBy", text("agent_end_capture")),
            ("trustLevel", text(trust)),
            ("confidence", json_number(0.75)),
            ("scope", text(scope)),
            ("workspaceKey", Json::String(workspace.clone())),
            ("agentId", Json::String(agent.clone())),
            ("sessionId", Json::String(input.session_id.clone())),
        ]);
        let visibility = object(vec![
            ("scope", text(scope)),
            ("recallable", Json::Bool(true)),
            ("promptInjectable", Json::Bool(false)),
            ("dreamEligible", Json::Bool(input.role != Role::Assistant)),
        ]);
        let attribution = object(vec![
            (
                "repliesToTurnIds",
                Json::Array(
                    input
                        .replies_to_turn_ids
                        .iter()
                        .cloned()
                        .map(Json::String)
                        .collect(),
                ),
            ),
            ("usedMemoryIds", empty()),
            ("usedBehaviorCardIds", empty()),
            ("usedDreamIds", empty()),
            ("usedToolIds", empty()),
        ]);
        let quality = object(vec![
            ("confidence", json_number(0.75)),
            ("userConfirmed", Json::Bool(false)),
            ("contradicted", Json::Bool(false)),
            ("stale", Json::Bool(false)),
            ("promoted", Json::Bool(false)),
            ("demoted", Json::Bool(false)),
            ("pruned", Json::Bool(false)),
            (
                "promptInjectionSuspected",
                Json::Bool(epistemic::looks_like_prompt_injection(&content)?),
            ),
        ]);
        Ok(object(vec![
            ("id", Json::String(input.id.clone())),
            ("workspaceKey", Json::String(workspace)),
            ("agentId", Json::String(agent)),
            ("sessionId", Json::String(input.session_id.clone())),
            (
                "turnIndex",
                json_number(if input.turn_index.is_finite() {
                    input.turn_index
                } else {
                    0.
                }),
            ),
            ("role", text(role)),
            ("content", Json::String(content)),
            ("categories", Json::Array(vec![text(category)])),
            ("origin", origin),
            ("visibility", visibility),
            ("attribution", attribution),
            ("quality", quality),
            (
                "emotionalValence",
                text(&emotion_legacy::serialize(&emotion)),
            ),
            (
                "emotionalIntensity",
                field(&emotion, "emotionalIntensity")
                    .cloned()
                    .ok_or(StoreError::Corrupt)?,
            ),
            (
                "emotionalDominant",
                field(&emotion, "emotionalDominant")
                    .cloned()
                    .ok_or(StoreError::Corrupt)?,
            ),
            ("createdAt", Json::String(input.created_at.clone())),
        ]))
    }
}
fn scope(value: &JsString, role: Role) -> &'static str {
    match value.to_utf8_lossy().as_str() {
        "agent_private" | "agent-private" => "agent_private",
        "workspace_shared" | "workspace" => "workspace_shared",
        "global_user" | "user" => "global_user",
        _ => {
            if role == Role::Assistant {
                "agent_private"
            } else {
                "workspace_shared"
            }
        }
    }
}
fn whitespace(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_whitespace)
}
fn trim(value: &JsString) -> JsString {
    let units = value.as_utf16_units();
    let start = units
        .iter()
        .position(|u| !whitespace(*u))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|u| !whitespace(*u))
        .map_or(start, |i| i + 1);
    JsString::from_utf16_units(units[start..end].to_vec())
}
/// JS whitespace collapse, trim and 4,000-unit slice, preserving any split surrogate at the hash boundary.
pub fn normalize_statement(value: &JsString) -> JsString {
    let mut units = Vec::new();
    let mut pending_space = false;
    for unit in value.as_utf16_units() {
        if whitespace(*unit) {
            pending_space = !units.is_empty();
        } else {
            if pending_space {
                units.push(u16::from(b' '));
            }
            pending_space = false;
            units.push(*unit);
        }
    }
    units.truncate(STATEMENT_UNITS);
    JsString::from_utf16_units(units)
}
/// Hash the exact Node array with normalized content and duplicate ordinal. Current run name,
/// display index and timestamp are intentionally absent; workspace, agent and stable session remain.
pub fn stable_turn_id(
    workspace: &JsString,
    agent: &JsString,
    session: &JsString,
    role: Role,
    content: &JsString,
    tool_ids: &[JsString],
    ordinal: u32,
) -> JsString {
    let value = Json::Array(vec![
        text("neo-stable-id-v1"),
        text("turn"),
        Json::String(or_default(workspace)),
        Json::String(or_default(agent)),
        Json::String(session.clone()),
        text(role.as_str()),
        Json::String(normalize_statement(content)),
        Json::Array(tool_ids.iter().cloned().map(Json::String).collect()),
        Json::Number(ordinal.to_string()),
    ]);
    let hash = format!("{:x}", Sha256::digest(write_json(&value).as_bytes()));
    JsString::from(format!("turn_{}", &hash[..STABLE_HASH_HEX_DIGITS]).as_str())
}
fn or_default(v: &JsString) -> JsString {
    if v.is_empty() {
        JsString::from("default")
    } else {
        v.clone()
    }
}
fn object(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(
        fields
            .into_iter()
            .map(|(k, v)| (JsString::from(k), v))
            .collect(),
    )
}
fn text(v: &str) -> Json {
    Json::String(JsString::from(v))
}
fn empty() -> Json {
    Json::Array(vec![])
}
