//! The data of the prompt builder (`packages/core/src/prompt/types.ts`). Every type that TypeScript returns as an
//! object has a `to_j` here that lists its members in the order TypeScript creates them, so `JSON.stringify` of a
//! result is the same text on both sides (the vectors compare its digest).
use super::join::Block;
use super::model_table::{CacheRoute, Mechanism};
use crate::approvals::js_json::J;
use serde_json::Value;

/// ADR-010 §1, in the only order the zones are ever rendered. `Volatile` rides after the last breakpoint and is never
/// cached.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ZoneName {
    /// Zone 1: the tool definitions.
    Tools,
    /// Zone 2: the system parts.
    System,
    /// Zone 3: the frozen memory snapshot.
    Memory,
    /// Zone 4: the conversation, append-only.
    Conversation,
    /// The volatile tail.
    Volatile,
}

/// All five zones in render order.
pub const ZONES: [ZoneName; 5] = [
    ZoneName::Tools,
    ZoneName::System,
    ZoneName::Memory,
    ZoneName::Conversation,
    ZoneName::Volatile,
];
/// The three cached zones.
pub const STABLE_ZONES: [ZoneName; 3] = [ZoneName::Tools, ZoneName::System, ZoneName::Memory];

impl ZoneName {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            ZoneName::Tools => "tools",
            ZoneName::System => "system",
            ZoneName::Memory => "memory",
            ZoneName::Conversation => "conversation",
            ZoneName::Volatile => "volatile",
        }
    }
}

/// Who speaks a conversation entry. The role is part of the trust boundary: tool output and recall are user-side
/// content, a tool call is the assistant's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// The user side.
    User,
    /// The assistant.
    Assistant,
}

impl Role {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
}

/// The kind of a conversation entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemKind {
    /// Plain text (the default).
    Text,
    /// A tool call of the assistant.
    ToolUse,
    /// A tool's output.
    ToolResult,
    /// A folded recall (L7).
    Context,
}

impl ItemKind {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            ItemKind::Text => "text",
            ItemKind::ToolUse => "tool_use",
            ItemKind::ToolResult => "tool_result",
            ItemKind::Context => "context",
        }
    }
}

/// One conversation entry. `tool_use` and `tool_result` carry the correlation `id`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationItem {
    /// Who speaks.
    pub role: Role,
    /// The kind; `None` is text.
    pub kind: Option<ItemKind>,
    /// The text.
    pub text: String,
    /// The correlation id.
    pub id: Option<String>,
}

/// The kind of a rendered segment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SegmentKind {
    /// One tool definition, as canonical JSON.
    ToolDef,
    /// One system part.
    System,
    /// The memory snapshot.
    Memory,
    /// A conversation entry of that kind.
    Item(ItemKind),
}

impl SegmentKind {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            SegmentKind::ToolDef => "tool_def",
            SegmentKind::System => "system",
            SegmentKind::Memory => "memory",
            SegmentKind::Item(kind) => kind.as_str(),
        }
    }
}

/// Provider-neutral output unit. `cache` marks a breakpoint: the prefix up to and including this segment is cacheable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Segment {
    /// The zone.
    pub zone: ZoneName,
    /// The kind.
    pub kind: SegmentKind,
    /// The role, for conversation and volatile segments.
    pub role: Option<Role>,
    /// The text, normalised.
    pub text: String,
    /// The correlation id.
    pub id: Option<String>,
    /// The TTL of the breakpoint that ends here.
    pub cache: Option<String>,
}

impl Segment {
    /// `{ zone, kind, role?, text, id?, cache? }`.
    pub fn to_j(&self) -> J {
        let mut j = J::obj([
            ("zone", J::s(self.zone.as_str())),
            ("kind", J::s(self.kind.as_str())),
        ]);
        if let Some(role) = self.role {
            j.set("role", J::s(role.as_str()));
        }
        j.set("text", J::s(&self.text));
        if let Some(id) = &self.id {
            j.set("id", J::s(id));
        }
        if let Some(ttl) = &self.cache {
            j.set("cache", J::obj([("ttl", J::s(ttl))]));
        }
        j
    }
}

/// End offset and hash of a zone or of a prefix. `byte_offset` is exclusive, in the concatenated UTF-8 segment texts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZoneMetadata {
    /// The zone.
    pub zone: ZoneName,
    /// Exclusive end offset in bytes.
    pub byte_offset: usize,
    /// chars / 4, rounded up (local for a zone, cumulative for a breakpoint).
    pub token_estimate: u64,
    /// The zone hash, or the hash of the prefix text for a breakpoint.
    pub hash: String,
}

impl ZoneMetadata {
    /// `{ zone, byteOffset, tokenEstimate, hash }`.
    pub fn to_j(&self) -> J {
        J::obj([
            ("zone", J::s(self.zone.as_str())),
            ("byteOffset", J::Num(self.byte_offset as f64)),
            ("tokenEstimate", J::Num(self.token_estimate as f64)),
            ("hash", J::s(&self.hash)),
        ])
    }
}

/// Why a breakpoint sits where it sits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BreakpointKind {
    /// The end of a stable zone.
    Zone,
    /// The last conversation segment.
    Trailing,
    /// Fifteen positions behind the trailing one (ADR-010 R1).
    Interior,
}

impl BreakpointKind {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            BreakpointKind::Zone => "zone",
            BreakpointKind::Trailing => "trailing",
            BreakpointKind::Interior => "interior",
        }
    }
}

/// One cache breakpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Breakpoint {
    /// Offset, estimate and hash of the whole prefix through this breakpoint.
    pub metadata: ZoneMetadata,
    /// Index into the rendered segments.
    pub segment: usize,
    /// The TTL tier.
    pub ttl: String,
    /// Why it is here.
    pub kind: BreakpointKind,
}

impl Breakpoint {
    /// `{ zone, byteOffset, tokenEstimate, hash, segment, ttl, kind }`.
    pub fn to_j(&self) -> J {
        let mut j = self.metadata.to_j();
        j.set("segment", J::Num(self.segment as f64));
        j.set("ttl", J::s(&self.ttl));
        j.set("kind", J::s(self.kind.as_str()));
        j
    }
}

/// How a recall is delivered (ADR-010 §1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// As the result of the tool call that asked for it.
    ToolResult,
    /// As a trailing user-context block.
    Context,
}

/// The volatile tail of one request.
#[derive(Clone, Debug, PartialEq)]
pub struct VolatileInput {
    /// The engine's recall blocks, in engine order.
    pub blocks: Vec<Block>,
    /// The host's cap in code units; `f64::INFINITY` for an uncapped join; `None` is the default cap.
    pub cap_chars: Option<f64>,
    /// How it is delivered; `None` is context.
    pub delivery: Option<Delivery>,
    /// Required for tool-result delivery.
    pub tool_use_id: Option<String>,
}

/// The default cap of the memory zone, the engine's inject budget.
pub const DEFAULT_MEMORY_CAP_CHARS: f64 = 17_000.0;
/// The default cap of the volatile tail.
pub const DEFAULT_VOLATILE_CAP_CHARS: f64 = 17_000.0;

/// What a cache hint of the model profile asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CacheHint {
    /// The default placement.
    Auto,
    /// No breakpoint, so no cache write is paid for.
    None,
    /// As `Auto` here.
    Prefer,
}

/// The input of one render. Nothing in it is read from a file, a clock or the environment.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderInput {
    /// The agent.
    pub agent_id: String,
    /// The model id as given.
    pub model: String,
    /// Where the request goes; first-party when absent.
    pub route: Option<CacheRoute>,
    /// Host session identity, kept out of all prompt bytes; `None` is the default session of the agent.
    pub session_id: Option<String>,
    /// Set by a session for the one render after an explicit snapshot refresh.
    pub memory_refresh: bool,
    /// The tool definitions: JSON objects with a string `name`.
    pub tools: Vec<Value>,
    /// System parts in order. Never time-varying.
    pub system: Vec<String>,
    /// The frozen memory snapshot.
    pub memory: String,
    /// The conversation.
    pub conversation: Vec<ConversationItem>,
    /// The volatile tail.
    pub volatile: Option<VolatileInput>,
    /// Stable-zone breakpoint TTL; `None` is `5m`.
    pub cache_ttl: Option<String>,
    /// The model profile's cache hint.
    pub cache_hint: Option<CacheHint>,
    /// The cap of the memory zone in code units; `None` is the default.
    pub memory_cap: Option<f64>,
}

/// Why a prefix was invalidated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvalidationReason {
    /// A stable zone changed.
    PrefixChanged,
    /// An explicit snapshot refresh.
    MemoryRefresh,
    /// The session moved to another model.
    ModelChanged,
}

impl InvalidationReason {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            InvalidationReason::PrefixChanged => "prefix-changed",
            InvalidationReason::MemoryRefresh => "memory-refresh",
            InvalidationReason::ModelChanged => "model-changed",
        }
    }
}

/// Typed events (engine-spec L3: nothing is clipped, dropped or left uncached silently). They carry lengths and names,
/// never prompt text.
#[derive(Clone, Debug, PartialEq)]
pub enum PromptEvent {
    /// The memory snapshot was clipped to its cap.
    ZoneClipped {
        /// The agent.
        agent_id: String,
        /// The model.
        model: String,
        /// Length before.
        from: usize,
        /// Length after.
        to: usize,
        /// The cap.
        cap: f64,
    },
    /// A recall block was clipped or dropped.
    Block {
        /// The agent.
        agent_id: String,
        /// The model.
        model: String,
        /// Whether it was dropped (else clipped).
        dropped: bool,
        /// The block's name.
        block: String,
        /// Length before.
        from: usize,
        /// Length after.
        to: usize,
        /// The reason.
        reason: String,
    },
    /// The stable prefix is below the model's cache floor.
    BelowMinimum {
        /// The agent.
        agent_id: String,
        /// The model.
        model: String,
        /// The estimate of the stable prefix.
        tokens_estimate: u64,
        /// The model's floor.
        min_tokens: u64,
    },
    /// The table does not know the model on this route.
    UnknownModel {
        /// The agent.
        agent_id: String,
        /// The model.
        model: String,
    },
    /// The transcript is longer than the provider's lookback and no slot was free for an interior breakpoint.
    LookbackRisk {
        /// The agent.
        agent_id: String,
        /// The model.
        model: String,
        /// Positions in the conversation.
        positions: u64,
        /// The provider's lookback.
        lookback: u64,
    },
    /// The cached prefix of this (agent, model) or session is no longer valid.
    PrefixInvalidated {
        /// The agent.
        agent_id: String,
        /// The model.
        model: String,
        /// The first stable zone that changed.
        from: Option<ZoneName>,
        /// The model the session used before.
        previous_model: Option<String>,
        /// Why.
        reason: InvalidationReason,
    },
}

impl PromptEvent {
    /// The event as the TypeScript object.
    pub fn to_j(&self) -> J {
        let head = |kind: &str, agent_id: &str, model: &str| {
            J::obj([
                ("type", J::s(kind)),
                ("agentId", J::s(agent_id)),
                ("model", J::s(model)),
            ])
        };
        match self {
            PromptEvent::ZoneClipped {
                agent_id,
                model,
                from,
                to,
                cap,
            } => {
                let mut j = head("prompt.zone-clipped", agent_id, model);
                j.set("zone", J::s("memory"));
                j.set("from", J::Num(*from as f64));
                j.set("to", J::Num(*to as f64));
                j.set("cap", J::Num(*cap));
                j.set("reason", J::s("zone-cap"));
                j
            }
            PromptEvent::Block {
                agent_id,
                model,
                dropped,
                block,
                from,
                to,
                reason,
            } => {
                let kind = if *dropped {
                    "prompt.block-dropped"
                } else {
                    "prompt.block-clipped"
                };
                let mut j = head(kind, agent_id, model);
                j.set("block", J::s(block));
                j.set("from", J::Num(*from as f64));
                j.set("to", J::Num(*to as f64));
                j.set("reason", J::s(reason));
                j
            }
            PromptEvent::BelowMinimum {
                agent_id,
                model,
                tokens_estimate,
                min_tokens,
            } => {
                let mut j = head("prompt.below-minimum", agent_id, model);
                j.set("tokensEstimate", J::Num(*tokens_estimate as f64));
                j.set("minTokens", J::Num(*min_tokens as f64));
                j
            }
            PromptEvent::UnknownModel { agent_id, model } => {
                head("prompt.unknown-model", agent_id, model)
            }
            PromptEvent::LookbackRisk {
                agent_id,
                model,
                positions,
                lookback,
            } => {
                let mut j = head("prompt.lookback-risk", agent_id, model);
                j.set("positions", J::Num(*positions as f64));
                j.set("lookback", J::Num(*lookback as f64));
                j
            }
            PromptEvent::PrefixInvalidated {
                agent_id,
                model,
                from,
                previous_model,
                reason,
            } => {
                let mut j = head("prompt.prefix-invalidated", agent_id, model);
                if let Some(zone) = from {
                    j.set("from", J::s(zone.as_str()));
                }
                if let Some(previous) = previous_model {
                    j.set("previousModel", J::s(previous));
                }
                j.set("reason", J::s(reason.as_str()));
                j
            }
        }
    }
}

/// Whether the stable prefix was seen before.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrefixStatus {
    /// First render of this (agent, model).
    Cold,
    /// Stable zones unchanged since its last render.
    Warm,
    /// A stable zone changed, from this one on.
    Invalidated(ZoneName),
}

/// Why a prompt is or is not cacheable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CacheReason {
    /// Markers are placed.
    Eligible,
    /// The stable prefix is below the model's floor.
    BelowMinimum,
    /// There is no stable prefix.
    EmptyPrefix,
    /// The provider caches on its own.
    ImplicitProvider,
    /// The table does not know the model.
    UnknownModel,
}

impl CacheReason {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            CacheReason::Eligible => "eligible",
            CacheReason::BelowMinimum => "below-minimum",
            CacheReason::EmptyPrefix => "empty-prefix",
            CacheReason::ImplicitProvider => "implicit-provider",
            CacheReason::UnknownModel => "unknown-model",
        }
    }
}

/// The cache view of one render.
#[derive(Clone, Debug, PartialEq)]
pub struct CacheInfo {
    /// The provider class.
    pub provider: String,
    /// The mechanism.
    pub mechanism: Mechanism,
    /// The model's floor.
    pub minimum_tokens: u64,
    /// Whether the stable prefix clears the floor of a known model.
    pub eligible: bool,
    /// Why.
    pub reason: CacheReason,
    /// Prediction only; provider usage is the source of measured cache hits.
    pub expected_warm: bool,
    /// The TTL tier chosen for the stable zones, or `None` when the model offers no tier.
    pub ttl: Option<String>,
    /// Time since the last render of this prefix in this session.
    pub age_ms: Option<f64>,
    /// The window in which the prefix is predicted warm.
    pub ttl_ms: Option<f64>,
}

impl CacheInfo {
    /// `{ provider, mechanism, minimumTokens, eligible, reason, expected, ageMs, ttlMs, ttl }`.
    pub fn to_j(&self) -> J {
        let num = |n: Option<f64>| n.map_or(J::Null, J::Num);
        J::obj([
            ("provider", J::s(&self.provider)),
            ("mechanism", J::s(self.mechanism.as_str())),
            ("minimumTokens", J::Num(self.minimum_tokens as f64)),
            ("eligible", J::Bool(self.eligible)),
            ("reason", J::s(self.reason.as_str())),
            (
                "expected",
                J::s(if self.expected_warm { "warm" } else { "cold" }),
            ),
            ("ageMs", num(self.age_ms)),
            ("ttlMs", num(self.ttl_ms)),
            ("ttl", J::opt_s(self.ttl.as_deref())),
        ])
    }
}

/// One rendered prompt.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderedPrompt {
    /// The agent.
    pub agent_id: String,
    /// The model id as given.
    pub model: String,
    /// sha256 of `{agentId, normalised model}`: the identity of this (agent, model) prefix (R5).
    pub prefix_key: String,
    /// The segments, in zone order.
    pub segments: Vec<Segment>,
    /// The breakpoints.
    pub breakpoints: Vec<Breakpoint>,
    /// Per-zone content hashes (R3/R8), in zone order.
    pub zone_hashes: [String; 5],
    /// Cumulative: `tools`, `tools+system`, `tools+system+memory`. This is what a provider's cache keys on.
    pub prefix_hashes: [String; 3],
    /// Whether the stable prefix was seen before.
    pub prefix: PrefixStatus,
    /// Rough token estimate of zones 1 to 3 (chars / 4, deliberately low), used for R2 only.
    pub stable_tokens_estimate: u64,
    /// All five zones, including empty ones, in render order.
    pub zones: Vec<ZoneMetadata>,
    /// Sticky routing hint, never rendered into a zone.
    pub session_id: String,
    /// The cache view.
    pub cache: CacheInfo,
    /// The events of this render, in order.
    pub events: Vec<PromptEvent>,
}

impl RenderedPrompt {
    /// The hash of one zone.
    pub fn zone_hash(&self, zone: ZoneName) -> &str {
        &self.zone_hashes[zone as usize]
    }

    /// The result as the TypeScript object, members in TypeScript's order.
    pub fn to_j(&self) -> J {
        let zone_hashes =
            ZONES
                .iter()
                .zip(&self.zone_hashes)
                .fold(J::Obj(Vec::new()), |mut j, (zone, hash)| {
                    j.set(zone.as_str(), J::s(hash));
                    j
                });
        let prefix_hashes = STABLE_ZONES.iter().zip(&self.prefix_hashes).fold(
            J::Obj(Vec::new()),
            |mut j, (zone, hash)| {
                j.set(zone.as_str(), J::s(hash));
                j
            },
        );
        let prefix = match self.prefix {
            PrefixStatus::Cold => J::obj([("status", J::s("cold"))]),
            PrefixStatus::Warm => J::obj([("status", J::s("warm"))]),
            PrefixStatus::Invalidated(zone) => J::obj([
                ("status", J::s("invalidated")),
                ("changedFrom", J::s(zone.as_str())),
            ]),
        };
        J::obj([
            ("agentId", J::s(&self.agent_id)),
            ("model", J::s(&self.model)),
            ("prefixKey", J::s(&self.prefix_key)),
            (
                "segments",
                J::Arr(self.segments.iter().map(Segment::to_j).collect()),
            ),
            (
                "breakpoints",
                J::Arr(self.breakpoints.iter().map(Breakpoint::to_j).collect()),
            ),
            ("zoneHashes", zone_hashes),
            ("prefixHashes", prefix_hashes),
            ("prefix", prefix),
            (
                "stableTokensEstimate",
                J::Num(self.stable_tokens_estimate as f64),
            ),
            (
                "zones",
                J::Arr(self.zones.iter().map(ZoneMetadata::to_j).collect()),
            ),
            ("session_id", J::s(&self.session_id)),
            ("cache", self.cache.to_j()),
            (
                "events",
                J::Arr(self.events.iter().map(PromptEvent::to_j).collect()),
            ),
        ])
    }
}
