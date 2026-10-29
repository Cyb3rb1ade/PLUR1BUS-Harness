//! Typed, lossless shapes of the pinned Node JSONL records.
//!
//! Known fields are optional typed views of the Node record, including its real nested shapes.
//! Missing or differently shaped fields are retained in the original tolerant object instead
//! of rejecting historical data. Only an explicit typed edit changes that original field;
//! untouched ordering, unknown fields, number lexemes and lone surrogates round-trip exactly.

use crate::contract::StoreError;
use crate::text::js::JsString;
use crate::text::json::{parse_json, TolerantJsonValue};

use super::state_file::JsonRecord;

/// A JSON number retaining its original lexical representation, without narrowing Node numbers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LedgerNumber(String);

impl LedgerNumber {
    /// Parse one JSON number, retaining exponents, insignificant zeroes and negative zero.
    pub fn new(lexeme: &str) -> Result<Self, StoreError> {
        match parse_json(lexeme).map_err(|_| StoreError::InvalidInput)? {
            TolerantJsonValue::Number(number) => Ok(Self(number)),
            _ => Err(StoreError::InvalidInput),
        }
    }
    /// The original JSON number token.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
    /// A finite floating-point view, when representable.
    #[must_use]
    pub fn as_f64(&self) -> Option<f64> {
        self.0.parse::<f64>().ok().filter(|value| value.is_finite())
    }
    /// An exact signed-integer token, without a floating-point conversion.
    #[must_use]
    pub fn as_i64(&self) -> Option<i64> {
        self.0.parse().ok()
    }
    /// An exact unsigned-integer token, without a floating-point conversion.
    #[must_use]
    pub fn as_u64(&self) -> Option<u64> {
        self.0.parse().ok()
    }
}

impl From<i64> for LedgerNumber {
    fn from(value: i64) -> Self {
        Self(value.to_string())
    }
}
impl From<u64> for LedgerNumber {
    fn from(value: u64) -> Self {
        Self(value.to_string())
    }
}

/// Node audit writers use both ISO text timestamps and numeric epoch milliseconds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TimestampValue {
    /// An unchanged Node string timestamp, without imposing date validation at persistence time.
    Text(JsString),
    /// A numeric Node timestamp, retaining the exact number token.
    Number(LedgerNumber),
}

trait KnownField: Sized {
    fn decode(value: &TolerantJsonValue) -> Option<Self>;
    fn encode(&self) -> TolerantJsonValue;
    fn as_string(&self) -> Option<&JsString> {
        None
    }
}
impl KnownField for JsString {
    fn decode(value: &TolerantJsonValue) -> Option<Self> {
        if let TolerantJsonValue::String(value) = value {
            Some(value.clone())
        } else {
            None
        }
    }
    fn encode(&self) -> TolerantJsonValue {
        TolerantJsonValue::String(self.clone())
    }
    fn as_string(&self) -> Option<&JsString> {
        Some(self)
    }
}
impl KnownField for LedgerNumber {
    fn decode(value: &TolerantJsonValue) -> Option<Self> {
        if let TolerantJsonValue::Number(value) = value {
            Some(Self(value.clone()))
        } else {
            None
        }
    }
    fn encode(&self) -> TolerantJsonValue {
        TolerantJsonValue::Number(self.0.clone())
    }
}
impl KnownField for bool {
    fn decode(value: &TolerantJsonValue) -> Option<Self> {
        if let TolerantJsonValue::Bool(value) = value {
            Some(*value)
        } else {
            None
        }
    }
    fn encode(&self) -> TolerantJsonValue {
        TolerantJsonValue::Bool(*self)
    }
}
impl<T: KnownField> KnownField for Vec<T> {
    fn decode(value: &TolerantJsonValue) -> Option<Self> {
        if let TolerantJsonValue::Array(values) = value {
            values.iter().map(T::decode).collect()
        } else {
            None
        }
    }
    fn encode(&self) -> TolerantJsonValue {
        TolerantJsonValue::Array(self.iter().map(T::encode).collect())
    }
}
impl<T: KnownField> KnownField for Option<T> {
    fn decode(value: &TolerantJsonValue) -> Option<Self> {
        if matches!(value, TolerantJsonValue::Null) {
            Some(None)
        } else {
            T::decode(value).map(Some)
        }
    }
    fn encode(&self) -> TolerantJsonValue {
        self.as_ref().map_or(TolerantJsonValue::Null, T::encode)
    }
    fn as_string(&self) -> Option<&JsString> {
        self.as_ref().and_then(T::as_string)
    }
}
impl KnownField for TimestampValue {
    fn decode(value: &TolerantJsonValue) -> Option<Self> {
        match value {
            TolerantJsonValue::String(value) => Some(Self::Text(value.clone())),
            TolerantJsonValue::Number(value) => Some(Self::Number(LedgerNumber(value.clone()))),
            _ => None,
        }
    }
    fn encode(&self) -> TolerantJsonValue {
        match self {
            Self::Text(value) => value.encode(),
            Self::Number(value) => value.encode(),
        }
    }
    fn as_string(&self) -> Option<&JsString> {
        if let Self::Text(value) = self {
            Some(value)
        } else {
            None
        }
    }
}

fn find_field<'a>(
    fields: &'a [(JsString, TolerantJsonValue)],
    name: &str,
) -> Option<&'a TolerantJsonValue> {
    let key = JsString::from(name);
    fields
        .iter()
        .rev()
        .find(|(field, _)| field == &key)
        .map(|(_, value)| value)
}
fn replace_field(
    fields: &mut Vec<(JsString, TolerantJsonValue)>,
    name: &str,
    value: TolerantJsonValue,
) {
    let key = JsString::from(name);
    if let Some((_, previous)) = fields.iter_mut().rev().find(|(field, _)| field == &key) {
        *previous = value;
    } else {
        fields.push((key, value));
    }
}
fn remove_field(fields: &mut Vec<(JsString, TolerantJsonValue)>, name: &str) {
    let key = JsString::from(name);
    fields.retain(|(field, _)| field != &key);
}

macro_rules! typed_record {
    ($name:ident,$description:literal,{$($field:ident : $kind:ty => $wire:literal),* $(,)?}) => {
        #[doc=$description]
        #[derive(Clone,Debug,PartialEq,Eq)]
        pub struct $name {
            $(#[doc=concat!("Typed Node `",$wire,"` field; absence or a different historical shape stays in the retained object.")]
              pub $field: Option<$kind>,)*
            retained: Vec<(JsString,TolerantJsonValue)>,
        }
        impl Default for $name { fn default()->Self { Self::from_fields(Vec::new()) } }
        impl $name {
            fn from_fields(original: Vec<(JsString,TolerantJsonValue)>)->Self {
                Self { $($field:find_field(&original,$wire).and_then(<$kind as KnownField>::decode),)* retained: original }
            }
            fn encoded_fields(&self)->Vec<(JsString,TolerantJsonValue)> {
                let mut fields=self.retained.clone();
                $(let previous=find_field(&self.retained,$wire).and_then(<$kind as KnownField>::decode);
                  if self.$field.as_ref()!=previous.as_ref() { match &self.$field {
                      Some(value)=>replace_field(&mut fields,$wire,value.encode()),
                      None=>remove_field(&mut fields,$wire),
                  } })*
                fields
            }
            /// A current complete snapshot, including unknown fields and typed edits, in original field order.
            #[must_use]
            pub fn fields(&self)->Vec<(JsString,TolerantJsonValue)> { self.encoded_fields() }
            /// Inspect the retained original representation, including a historically different known-field shape.
            /// Typed edits are emitted by `to_json`; use the named typed field for its current value.
            #[must_use]
            pub fn field(&self,name:&str)->Option<&TolerantJsonValue> { find_field(&self.retained,name) }
            /// Read a current string field without replacing lone UTF-16 surrogates.
            #[must_use]
            pub fn string(&self,name:&str)->Option<&JsString> {
                $(if name==$wire {
                    if let Some(value)=&self.$field { return value.as_string(); }
                    if find_field(&self.retained,$wire).and_then(<$kind as KnownField>::decode).is_some() { return None; }
                })*
                match self.field(name) { Some(TolerantJsonValue::String(value))=>Some(value),_=>None }
            }
            /// Assign one raw Node field, preserving field position and any pending typed edits.
            pub fn set_field(&mut self,name:&str,value:TolerantJsonValue) {
                let mut fields=self.encoded_fields();replace_field(&mut fields,name,value);*self=Self::from_fields(fields);
            }
        }
        impl KnownField for $name {
            fn decode(value:&TolerantJsonValue)->Option<Self> { if let TolerantJsonValue::Object(fields)=value { Some(Self::from_fields(fields.clone())) } else { None } }
            fn encode(&self)->TolerantJsonValue { TolerantJsonValue::Object(self.encoded_fields()) }
        }
        impl JsonRecord for $name {
            fn from_json(value:TolerantJsonValue)->Result<Self,StoreError> { if let TolerantJsonValue::Object(fields)=value { Ok(Self::from_fields(fields)) } else { Err(StoreError::Corrupt) } }
            fn to_json(&self)->Result<TolerantJsonValue,StoreError> { Ok(self.encode()) }
        }
    };
}

typed_record!(OriginFields, "The real createOrigin shape, also used by candidate-index projections.", {
    kind: JsString => "kind",
    role: JsString => "role",
    source_turn_ids: Vec<JsString> => "sourceTurnIds",
    source_memory_ids: Vec<JsString> => "sourceMemoryIds",
    source_tool_call_ids: Vec<JsString> => "sourceToolCallIds",
    captured_by: JsString => "capturedBy",
    trust_level: JsString => "trustLevel",
    confidence: LedgerNumber => "confidence",
    scope: JsString => "scope",
    workspace_key: JsString => "workspaceKey",
    agent_id: JsString => "agentId",
    session_id: JsString => "sessionId",
    owner_id: JsString => "ownerId",
});

typed_record!(VisibilityFields, "Turn visibility and candidate-index visibility metadata.", {
    scope: JsString => "scope",
    recallable: bool => "recallable",
    prompt_injectable: bool => "promptInjectable",
    dream_eligible: bool => "dreamEligible",
});

typed_record!(AttributionFields, "The source and memory attribution arrays written by createTurnEvent.", {
    replies_to_turn_ids: Vec<JsString> => "repliesToTurnIds",
    used_memory_ids: Vec<JsString> => "usedMemoryIds",
    used_behavior_card_ids: Vec<JsString> => "usedBehaviorCardIds",
    used_dream_ids: Vec<JsString> => "usedDreamIds",
    used_tool_ids: Vec<JsString> => "usedToolIds",
});

typed_record!(QualityFields, "The quality object written by createTurnEvent.", {
    confidence: LedgerNumber => "confidence",
    user_confirmed: bool => "userConfirmed",
    contradicted: bool => "contradicted",
    stale: bool => "stale",
    promoted: bool => "promoted",
    demoted: bool => "demoted",
    pruned: bool => "pruned",
    prompt_injection_suspected: bool => "promptInjectionSuspected",
});

typed_record!(TurnJournalLine, "A real turn-journal record with content, origin, visibility, attribution and quality.", {
    id: JsString => "id",
    workspace_key: JsString => "workspaceKey",
    agent_id: JsString => "agentId",
    session_id: JsString => "sessionId",
    turn_index: LedgerNumber => "turnIndex",
    role: JsString => "role",
    content: JsString => "content",
    categories: Vec<JsString> => "categories",
    origin: OriginFields => "origin",
    visibility: VisibilityFields => "visibility",
    attribution: AttributionFields => "attribution",
    quality: QualityFields => "quality",
    emotional_valence: JsString => "emotionalValence",
    emotional_intensity: LedgerNumber => "emotionalIntensity",
    emotional_dominant: JsString => "emotionalDominant",
    created_at: JsString => "createdAt",
    embedding: Vec<LedgerNumber> => "embedding",
    embedding_dims: LedgerNumber => "embeddingDims",
    embedding_store: JsString => "embeddingStore",
    updated_at: JsString => "updatedAt",
});
impl TurnJournalLine {
    /// The existing Node file name, without its owner-specific directory.
    pub const FILE_NAME: &'static str = "turn-journal.jsonl";
}

typed_record!(MemoryCandidateLine, "A memoryCandidatesFromTurns record with the lossless normalizedStatement and optional assistant agentId.", {
    id: JsString => "id",
    workspace_key: JsString => "workspaceKey",
    agent_id: JsString => "agentId",
    statement: JsString => "statement",
    normalized_statement: JsString => "normalizedStatement",
    category: JsString => "category",
    origin: OriginFields => "origin",
    source_turn_ids: Vec<JsString> => "sourceTurnIds",
    status: JsString => "status",
    confidence: LedgerNumber => "confidence",
    salience: LedgerNumber => "salience",
    recency: LedgerNumber => "recency",
    embedding_status: JsString => "embeddingStatus",
    created_at: JsString => "createdAt",
    emotional_valence: JsString => "emotionalValence",
    emotional_intensity: LedgerNumber => "emotionalIntensity",
    emotional_dominant: JsString => "emotionalDominant",
    embedding: Vec<LedgerNumber> => "embedding",
    embedding_dims: LedgerNumber => "embeddingDims",
    embedding_store: JsString => "embeddingStore",
    updated_at: JsString => "updatedAt",
});
impl MemoryCandidateLine {
    /// The existing Node file name, without its owner-specific directory.
    pub const FILE_NAME: &'static str = "memory-candidates.jsonl";
}

typed_record!(CandidateIndexLine, "The actual slim candidate-index projection; absent projected fields stay absent.", {
    id: JsString => "id",
    workspace_key: JsString => "workspaceKey",
    agent_id: JsString => "agentId",
    statement: JsString => "statement",
    category: JsString => "category",
    status: JsString => "status",
    stale: bool => "stale",
    hard_deleted: bool => "hardDeleted",
    confidence: LedgerNumber => "confidence",
    salience: LedgerNumber => "salience",
    recency: LedgerNumber => "recency",
    created_at: JsString => "createdAt",
    updated_at: JsString => "updatedAt",
    start_time: JsString => "startTime",
    epistemic_status: JsString => "epistemicStatus",
    visibility: VisibilityFields => "visibility",
    owner_id: JsString => "ownerId",
    owner_user_id: JsString => "ownerUserId",
    source_turn_ids: Vec<JsString> => "sourceTurnIds",
    embedding_dims: LedgerNumber => "embeddingDims",
    emotional_dominant: JsString => "emotionalDominant",
    origin: OriginFields => "origin",
});
impl CandidateIndexLine {
    /// The existing Node file name, without its owner-specific directory.
    pub const FILE_NAME: &'static str = "candidate-index.jsonl";
}

typed_record!(ReactionLedgerLine, "A reactionSignalsFromTurns record including its target ids, polarity and lossless evidence.", {
    id: JsString => "id",
    workspace_key: JsString => "workspaceKey",
    agent_id: JsString => "agentId",
    session_id: JsString => "sessionId",
    turn_id: JsString => "turnId",
    target_type: JsString => "targetType",
    target_ids: Vec<JsString> => "targetIds",
    polarity: LedgerNumber => "polarity",
    intensity: LedgerNumber => "intensity",
    confidence: LedgerNumber => "confidence",
    explicitness: JsString => "explicitness",
    evidence: JsString => "evidence",
    extracted_at: JsString => "extractedAt",
});
impl ReactionLedgerLine {
    /// The existing Node file name, without its owner-specific directory.
    pub const FILE_NAME: &'static str = "reaction-ledger.jsonl";
}

typed_record!(BehaviorCardLine, "A behaviorCardsFromReactions record with independently optional confirmation and contradiction timestamps.", {
    id: JsString => "id",
    workspace_key: JsString => "workspaceKey",
    agent_id: JsString => "agentId",
    category: JsString => "category",
    statement: JsString => "statement",
    status: JsString => "status",
    confidence: LedgerNumber => "confidence",
    salience: LedgerNumber => "salience",
    source_signals: Vec<JsString> => "sourceSignals",
    last_confirmed_at: JsString => "lastConfirmedAt",
    last_contradicted_at: JsString => "lastContradictedAt",
    embedding_status: JsString => "embeddingStatus",
    created_at: JsString => "createdAt",
    embedding: Vec<LedgerNumber> => "embedding",
    embedding_dims: LedgerNumber => "embeddingDims",
    embedding_store: JsString => "embeddingStore",
    updated_at: JsString => "updatedAt",
});
impl BehaviorCardLine {
    /// The existing Node file name, without its owner-specific directory.
    pub const FILE_NAME: &'static str = "behavior-cards.jsonl";
}

typed_record!(RetrievalLedgerLine, "A selected-retrieval record passed to appendRetrievalLedger.", {
    agent_id: JsString => "agentId",
    workspace_key: JsString => "workspaceKey",
    query: JsString => "query",
    results_count: LedgerNumber => "resultsCount",
    selected_ids: Vec<JsString> => "selectedIds",
});
impl RetrievalLedgerLine {
    /// The existing Node file name, without its owner-specific directory.
    pub const FILE_NAME: &'static str = "retrieval-ledger.jsonl";
}

typed_record!(ReconsolidationEventLine, "A safe-update event, including the optional epistemic-collapse audit fields.", {
    id: JsString => "id",
    idempotency_key: JsString => "idempotencyKey",
    old_memory_id: JsString => "oldMemoryId",
    new_memory_id: JsString => "newMemoryId",
    action: JsString => "action",
    update_source: JsString => "updateSource",
    update_evidence: JsString => "updateEvidence",
    confidence: LedgerNumber => "confidence",
    semantic_drift: LedgerNumber => "semanticDrift",
    created_at: LedgerNumber => "createdAt",
    previous_epistemic_status: JsString => "previousEpistemicStatus",
    new_epistemic_status: JsString => "newEpistemicStatus",
});
impl ReconsolidationEventLine {
    /// The existing Node file name, without its owner-specific directory.
    pub const FILE_NAME: &'static str = "reconsolidation-events.jsonl";
}

typed_record!(ConflictLogLine, "A conflict log record retaining nullable newMemoryId and optional caller evidence.", {
    timestamp: JsString => "timestamp",
    topic: JsString => "topic",
    new_memory_id: Option<JsString> => "newMemoryId",
    existing_memory_id: JsString => "existingMemoryId",
    new_text: JsString => "newText",
    existing_text: JsString => "existingText",
    pending: bool => "pending",
    schema_version: LedgerNumber => "schemaVersion",
    new_agent_id: JsString => "newAgentId",
    existing_agent_id: JsString => "existingAgentId",
    score: LedgerNumber => "score",
    category: JsString => "category",
    merge_decision: JsString => "mergeDecision",
});
impl ConflictLogLine {
    /// The existing Node file name, without its owner-specific directory.
    pub const FILE_NAME: &'static str = "conflict-log.jsonl";
}

typed_record!(ConflictResolvedLine, "A conflict-resolver decision carrying its typed original conflict.", {
    original: ConflictLogLine => "original",
    resolution: JsString => "resolution",
    confidence: LedgerNumber => "confidence",
    reason: JsString => "reason",
    recommendation: JsString => "recommendation",
    resolved_at: JsString => "resolvedAt",
    dry_run: bool => "dryRun",
});
impl ConflictResolvedLine {
    /// The existing Node file name, without its owner-specific directory.
    pub const FILE_NAME: &'static str = "conflict-resolved.jsonl";
}

typed_record!(DestructiveOpLine, "A destructive-operation audit entry; the writers legitimately use text or numeric timestamps.", {
    operation: JsString => "operation",
    agent_id: Option<JsString> => "agentId",
    id: JsString => "id",
    timestamp: TimestampValue => "timestamp",
    memory_id: JsString => "memoryId",
    previous_epistemic_status: JsString => "previousEpistemicStatus",
    new_epistemic_status: JsString => "newEpistemicStatus",
    previous_valid_until: LedgerNumber => "previousValidUntil",
    new_valid_until: LedgerNumber => "newValidUntil",
    actor: JsString => "actor",
    reason: JsString => "reason",
    evidence: JsString => "evidence",
    user_principal: Option<JsString> => "userPrincipal",
    event: JsString => "event",
    source: JsString => "source",
    via: JsString => "via",
    archive_path: JsString => "archivePath",
    tombstone_id: JsString => "tombstoneId",
    canonical_origin_id: JsString => "canonicalOriginId",
    result: JsString => "result",
    error_class: JsString => "errorClass",
});
impl DestructiveOpLine {
    /// The existing Node file name, without its owner-specific directory.
    pub const FILE_NAME: &'static str = "destructive-ops.jsonl";
}

typed_record!(ReplyOutcomeLine, "A completePendingReplyOutcomes result, including nullable workspaceKey and its classification.", {
    id: JsString => "id",
    schema: LedgerNumber => "schema",
    timestamp: LedgerNumber => "timestamp",
    agent_id: JsString => "agentId",
    session_key: JsString => "sessionKey",
    workspace_key: Option<JsString> => "workspaceKey",
    source: JsString => "source",
    user_prompt: JsString => "userPrompt",
    reply_text: JsString => "replyText",
    assistant_text: JsString => "assistantText",
    memory_ids: Vec<JsString> => "memoryIds",
    outcome: JsString => "outcome",
    feedback: JsString => "feedback",
    confidence: LedgerNumber => "confidence",
    reasons: Vec<JsString> => "reasons",
});
impl ReplyOutcomeLine {
    /// The existing Node file name, without its owner-specific directory.
    pub const FILE_NAME: &'static str = "reply-outcomes.jsonl";
}
