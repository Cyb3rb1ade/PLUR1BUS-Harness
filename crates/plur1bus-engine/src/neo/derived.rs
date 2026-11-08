//! Actual C4 candidate/reaction/behavior projections from captured turns.
//!
//! This pure stage neither writes nor grants visibility. The writer must validate actual sources
//! under its lease, bind the principal and narrow derived scope before storing any projection.
use super::{
    derived_fields::*,
    reactions, turn_rules,
    turns::{normalize_statement, stable_id, Role},
};
use crate::{
    capture::{dynamics::json_number, epistemic::is_injected_context},
    contract::{Cancel, EngineError, StoreError},
    text::{js::JsString, json::TolerantJsonValue as Json},
};

/// Ordered projections; these ownerless values are not permission to persist records.
#[derive(Clone, Debug)]
pub struct Derived {
    /// Memory candidates from recallable, noninjected source turns.
    pub candidates: Vec<Json>,
    /// User reaction evidence, including ambiguous reactions.
    pub reactions: Vec<Json>,
    /// Behavior proposals from nonambiguous explicit reactions.
    pub behavior: Vec<Json>,
}
/// Derive from normal captured-turn shapes, preserving source order and exact opaque identities.
/// Extraction time is explicit. Malformed or duplicate fields fail the entire pure batch.
pub fn from_turns(
    turns: &[Json],
    extracted_at: &JsString,
    cancel: &Cancel,
) -> Result<Derived, EngineError> {
    cancel.check()?;
    if extracted_at.is_empty() {
        return Err(StoreError::InvalidInput.into());
    }
    let mut out = Derived {
        candidates: vec![],
        reactions: vec![],
        behavior: vec![],
    };
    for input in turns {
        cancel.check()?;
        let turn = Turn::parse(input)?;
        if let Some(candidate) = candidate(&turn)? {
            out.candidates.push(candidate);
        }
        if let Some((signal, behavior)) = reactions::derive(&turn, extracted_at)? {
            out.reactions.push(signal);
            out.behavior.extend(behavior);
        }
    }
    cancel.check()?;
    Ok(out)
}
pub(super) struct Turn<'a> {
    pub raw: &'a Json,
    pub id: &'a JsString,
    pub workspace: &'a JsString,
    pub agent: &'a JsString,
    pub session: &'a JsString,
    pub content: &'a JsString,
    pub created_at: &'a JsString,
    pub role: Role,
    pub origin: &'a Json,
    pub quality: &'a Json,
    pub visibility: &'a Json,
    pub replies: &'a Json,
    pub category: JsString,
}
impl<'a> Turn<'a> {
    fn parse(raw: &'a Json) -> Result<Self, EngineError> {
        validate_object(raw)?;
        let role_text = str_field(raw, "role")?;
        let role = [Role::User, Role::Assistant, Role::Tool]
            .into_iter()
            .find(|r| role_text == &JsString::from(r.as_str()))
            .ok_or(StoreError::InvalidInput)?;
        let id = str_field(raw, "id")?;
        let workspace = str_field(raw, "workspaceKey")?;
        let agent = str_field(raw, "agentId")?;
        let created_at = str_field(raw, "createdAt")?;
        if [id, workspace, agent, created_at]
            .iter()
            .any(|s| s.is_empty())
        {
            return Err(StoreError::InvalidInput.into());
        }
        let content = str_field(raw, "content")?;
        let origin = field(raw, "origin")?;
        let quality = field(raw, "quality")?;
        let visibility = field(raw, "visibility")?;
        let attribution = field(raw, "attribution")?;
        for item in [origin, quality, visibility, attribution] {
            validate_object(item)?;
        }
        let replies = field(attribution, "repliesToTurnIds")?;
        let Json::Array(ids) = replies else {
            return Err(StoreError::InvalidInput.into());
        };
        if ids.iter().any(|v| !matches!(v, Json::String(_))) {
            return Err(StoreError::InvalidInput.into());
        }
        let Json::Array(categories) = field(raw, "categories")? else {
            return Err(StoreError::InvalidInput.into());
        };
        if categories.iter().any(|v| !matches!(v, Json::String(_))) {
            return Err(StoreError::InvalidInput.into());
        }
        let category = match categories.first() {
            Some(Json::String(v)) if !v.is_empty() => v.clone(),
            _ => JsString::from(turn_rules::classify(content, role)?.0),
        };
        Ok(Self {
            raw,
            id,
            workspace,
            agent,
            session: str_field(raw, "sessionId")?,
            content,
            created_at,
            role,
            origin,
            quality,
            visibility,
            replies,
            category,
        })
    }
}
fn candidate(turn: &Turn<'_>) -> Result<Option<Json>, EngineError> {
    if !bool_field(turn.visibility, "recallable")?
        || turn.content.is_empty()
        || bool_field(turn.quality, "promptInjectionSuspected")?
        || is_injected_context(turn.content)?
    {
        return Ok(None);
    }
    let assistant = turn.role == Role::Assistant;
    let normalized = normalize_statement(turn.content);
    let id = stable_id(
        "mem",
        vec![string(turn.id), string(&turn.category), string(&normalized)],
    );
    let sources = Json::Array(vec![string(turn.id)]);
    let mut origin = turn.origin.clone();
    set(&mut origin, "sourceTurnIds", sources.clone())?;
    if assistant {
        set(&mut origin, "trustLevel", text("assistant_asserted"))?;
    } else {
        str_field(&origin, "trustLevel")?;
    }
    let confidence = if assistant {
        json_number(0.45)
    } else {
        let value = field(turn.quality, "confidence")?;
        match value {
            Json::Number(n) if n.parse::<f64>().is_ok_and(f64::is_finite) => value.clone(),
            Json::Null => json_number(0.75),
            _ => return Err(StoreError::InvalidInput.into()),
        }
    };
    let mut fields = vec![
        ("id", string(&id)),
        ("workspaceKey", string(turn.workspace)),
    ];
    if assistant {
        fields.push(("agentId", string(turn.agent)));
    }
    fields.extend(vec![
        ("statement", string(turn.content)),
        ("normalizedStatement", string(&normalized)),
        ("category", string(&turn.category)),
        ("origin", origin),
        ("sourceTurnIds", sources),
        (
            "status",
            text(if assistant { "candidate" } else { "active" }),
        ),
        ("confidence", confidence),
        (
            "salience",
            json_number(initial_salience(&turn.category, assistant)),
        ),
        ("recency", json_number(1.)),
        ("embeddingStatus", text("pending")),
        ("createdAt", string(turn.created_at)),
        (
            "emotionalValence",
            field(turn.raw, "emotionalValence")?.clone(),
        ),
        (
            "emotionalIntensity",
            field(turn.raw, "emotionalIntensity")?.clone(),
        ),
        (
            "emotionalDominant",
            field(turn.raw, "emotionalDominant")?.clone(),
        ),
    ]);
    Ok(Some(object(fields)))
}
fn initial_salience(category: &JsString, assistant: bool) -> f64 {
    if assistant {
        return 0.35;
    }
    match category.to_utf8_lossy().as_str() {
        "architecture_decision" | "technical_constraint" | "workspace_rule" | "user_preference" => {
            0.8
        }
        "bug" | "failure" | "test_result" => 0.7,
        _ => 0.55,
    }
}
