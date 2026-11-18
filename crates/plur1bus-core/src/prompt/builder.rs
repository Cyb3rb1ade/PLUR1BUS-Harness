//! The four-zone prompt builder (ADR-010 §1; `packages/core/src/prompt/builder.ts`): provider-neutral segments with
//! cache-breakpoint markers, zone and prefix hashes, and the prediction whether the prefix is still warm.
//!
//! The builder does no I/O. The only thing it reads besides its input is the request clock, a port. Its state is the
//! per-(agent, model) prefix registry (R5), the last render per session, and the model each session used last; all of
//! it is written at the end of a render that succeeded, so a refused input leaves no trace.
//!
//! What reaches a prompt is a boundary. Tool definitions are rendered as canonical JSON, never as text a caller
//! formatted; the role of a conversation entry is checked against its kind, so tool output or recall text cannot be
//! rendered as the assistant's own speech; the memory snapshot and the recall blocks are clipped at the same UTF-16
//! unit as in TypeScript and every clip is an event. Errors and events carry names and lengths, never prompt text.
use super::canonical::{canonical_json, normalize_text, sha256_hex, CanonicalError};
use super::join::{join_blocks, Block, DeferralKind};
use super::model_table::{lookup_cache_profile, normalize_model_id, CacheProfile, Mechanism};
use super::types::{
    Breakpoint, BreakpointKind, CacheHint, CacheInfo, CacheReason, ConversationItem, Delivery,
    InvalidationReason, ItemKind, PrefixStatus, PromptEvent, RenderInput, RenderedPrompt, Role,
    Segment, SegmentKind, VolatileInput, ZoneMetadata, ZoneName, DEFAULT_MEMORY_CAP_CHARS,
    DEFAULT_VOLATILE_CAP_CHARS, STABLE_ZONES, ZONES,
};
use crate::js::slice::{is_high_surrogate, trim_end_units};
use crate::js::utf16_len;
use crate::provider_auth::ports::Clock;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};

/// ADR-010 R1: the second trailing breakpoint sits this many positions behind the last one, inside Anthropic's
/// 20-position lookback. RULING: 15, the low end of the ADR's range, so it keeps hitting for a full turn of growth.
const INTERIOR_BACK: u64 = 15;

/// Why a render, an append or a recall was refused. The texts are TypeScript's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PromptError {
    /// A cap is NaN or below zero (it would make every length comparison false and silently lift the budget).
    Cap(&'static str),
    /// `tool_use` or `tool_result` without an id.
    NeedsId(ItemKind),
    /// A `tool_use` that does not have the assistant role.
    ToolUseRole,
    /// A `tool_result` or `context` that does not have the user role.
    UserRole(ItemKind),
    /// Tool-result delivery of a recall without the id of the tool call.
    VolatileNeedsId,
    /// Two tools have the same name after normalisation.
    DuplicateTool(String),
    /// A tool definition is not an object with a string `name`.
    ToolName,
    /// A tool definition has no canonical form.
    Canonical(CanonicalError),
    /// The request clock is not a finite number.
    Clock,
    /// A configured cache TTL is not finite and nonnegative.
    CacheTtl,
}

impl fmt::Display for PromptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PromptError::Cap(what) => write!(
                f,
                "{what} must be a nonnegative number (Infinity for uncapped)"
            ),
            PromptError::NeedsId(kind) => write!(f, "conversation {} needs an id", kind.as_str()),
            PromptError::ToolUseRole => {
                f.write_str("conversation tool_use must have the assistant role")
            }
            PromptError::UserRole(kind) => {
                write!(f, "conversation {} must have the user role", kind.as_str())
            }
            PromptError::VolatileNeedsId => {
                f.write_str("volatile tool_result delivery needs toolUseId")
            }
            PromptError::DuplicateTool(name) => write!(f, "duplicate tool name: {name}"),
            PromptError::ToolName => f.write_str("a tool definition needs a string name"),
            PromptError::Canonical(e) => e.fmt(f),
            PromptError::Clock => f.write_str("prompt clock must be finite"),
            PromptError::CacheTtl => {
                f.write_str("cache TTL must be finite and nonnegative or null")
            }
        }
    }
}

impl std::error::Error for PromptError {}

impl From<CanonicalError> for PromptError {
    fn from(e: CanonicalError) -> Self {
        PromptError::Canonical(e)
    }
}

/// A cap is a count of code units; NaN or a negative number is refused, `+Infinity` is "uncapped".
fn check_cap(cap: f64, what: &'static str) -> Result<(), PromptError> {
    if cap.is_nan() || cap < 0.0 {
        return Err(PromptError::Cap(what));
    }
    Ok(())
}

/// Shape check for one conversation entry, shared by the builder and `PromptSession::append`. Returns the entry's kind.
pub fn check_conversation_item(item: &ConversationItem) -> Result<ItemKind, PromptError> {
    let kind = item.kind.unwrap_or(ItemKind::Text);
    let has_id = item.id.as_deref().is_some_and(|id| !id.is_empty());
    if matches!(kind, ItemKind::ToolUse | ItemKind::ToolResult) && !has_id {
        return Err(PromptError::NeedsId(kind));
    }
    if kind == ItemKind::ToolUse && item.role != Role::Assistant {
        return Err(PromptError::ToolUseRole);
    }
    if matches!(kind, ItemKind::ToolResult | ItemKind::Context) && item.role != Role::User {
        return Err(PromptError::UserRole(kind));
    }
    Ok(kind)
}

/// RULING: chars / 4 is a deliberately low token estimate (CJK is denser), so R2 warns early rather than late.
fn tokens(chars: usize) -> u64 {
    (chars as u64).div_ceil(4)
}

/// RULING: clip the frozen snapshot to `cap` code units on a line (record) boundary when that keeps at least half the
/// cap; else hard-cut, never inside a surrogate pair; then `trimEnd`. `cap` is below the length and may be fractional,
/// in which case every index is truncated the way `charCodeAt`, `lastIndexOf` and `slice` truncate theirs.
fn clip_snapshot(units: &[u16], cap: f64) -> &[u16] {
    if units.is_empty() {
        return units;
    }
    let hard = if cap <= 0.0 {
        0.0
    } else {
        // `text.charCodeAt(keep - 1)`: an index in (-1, 0) truncates to 0.
        let at = ((cap - 1.0).trunc().max(0.0) as usize).min(units.len() - 1);
        if is_high_surrogate(units[at]) {
            cap - 1.0
        } else {
            cap
        }
    };
    let hard_index = (hard.trunc().max(0.0) as usize).min(units.len());
    // `text.lastIndexOf("\n", hard)`: the search starts at `hard` itself.
    let newline = units[..=hard_index.min(units.len() - 1)]
        .iter()
        .rposition(|u| *u == 0x0a);
    let end = match newline {
        Some(nl) if nl as f64 >= cap / 2.0 => nl,
        _ => hard_index,
    };
    trim_end_units(&units[..end])
}

/// What a recall became: its joined text and how it is delivered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JoinedRecall {
    /// The joined text.
    pub text: String,
    /// How it is delivered.
    pub delivery: Delivery,
    /// The id of the tool call, when one was given.
    pub tool_use_id: Option<String>,
}

/// `joinRecall`: joins the engine's recall blocks under the host cap and reports every clip or drop as a typed event.
/// Shared by the builder (a one-shot volatile tail) and the session (a recall that later folds into the conversation).
pub fn join_recall(
    agent_id: &str,
    model: &str,
    v: &VolatileInput,
    push: &mut dyn FnMut(PromptEvent),
) -> Result<JoinedRecall, PromptError> {
    if let Some(cap) = v.cap_chars {
        check_cap(cap, "volatile capChars")?;
    }
    let blocks: Vec<Block> = v
        .blocks
        .iter()
        .map(|b| Block {
            name: b.name.clone(),
            text: normalize_text(&b.text),
            droppable: b.droppable,
        })
        .collect();
    let (text, deferrals) = join_blocks(&blocks, v.cap_chars.unwrap_or(DEFAULT_VOLATILE_CAP_CHARS));
    for d in deferrals {
        push(PromptEvent::Block {
            agent_id: agent_id.to_owned(),
            model: model.to_owned(),
            dropped: d.kind == DeferralKind::Dropped,
            block: d.block,
            from: d.from,
            to: d.to,
            reason: d.reason.to_owned(),
        });
    }
    let delivery = v.delivery.unwrap_or(Delivery::Context);
    let tool_use_id = v.tool_use_id.clone().filter(|id| !id.is_empty());
    if delivery == Delivery::ToolResult && tool_use_id.is_none() {
        return Err(PromptError::VolatileNeedsId);
    }
    Ok(JoinedRecall {
        text,
        delivery,
        tool_use_id,
    })
}

/// Collapses consecutive `tool_use` (and consecutive `tool_result`) segments into one position, as Anthropic's
/// lookback counts them.
fn positions_of(conversation: &[Segment]) -> Vec<u64> {
    let mut pos = 0;
    let mut previous: Option<SegmentKind> = None;
    conversation
        .iter()
        .map(|s| {
            let run = matches!(
                s.kind,
                SegmentKind::Item(ItemKind::ToolUse | ItemKind::ToolResult)
            ) && previous == Some(s.kind);
            if !run {
                pos += 1;
            }
            previous = Some(s.kind);
            pos
        })
        .collect()
}

/// A callback that receives each event as a render produces it.
pub type Emit = Box<dyn Fn(&PromptEvent) + Send + Sync>;

/// Options of a builder.
#[derive(Default)]
pub struct PromptBuilderOptions {
    /// Called once per event, in order (the same events are also on the result).
    pub emit: Option<Emit>,
    /// Overrides each provider class's expected TTL in milliseconds; `None` as a value means unknown or disabled.
    pub cache_ttl_ms: HashMap<String, Option<f64>>,
}

struct LastRender {
    at: f64,
    hash: String,
    ttl_ms: Option<f64>,
    eligible: bool,
}

#[derive(Default)]
struct State {
    known: HashMap<String, [String; 3]>,
    last_render: HashMap<String, LastRender>,
    active_models: HashMap<String, String>,
}

/// The prompt builder. One instance holds the prefix registry of a composition; `render` takes `&self`, so a session
/// and the turn loop can share it.
pub struct PromptBuilder {
    clock: Arc<dyn Clock>,
    emit: Option<Emit>,
    ttl_overrides: HashMap<String, Option<f64>>,
    state: Mutex<State>,
}

impl PromptBuilder {
    /// `createPromptBuilder(options)`. The clock is the request-time clock in milliseconds: generation time therefore
    /// consumes TTL.
    pub fn new(clock: Arc<dyn Clock>, options: PromptBuilderOptions) -> Result<Self, PromptError> {
        if options
            .cache_ttl_ms
            .values()
            .flatten()
            .any(|ttl| !ttl.is_finite() || *ttl < 0.0)
        {
            return Err(PromptError::CacheTtl);
        }
        Ok(Self {
            clock,
            emit: options.emit,
            ttl_overrides: options.cache_ttl_ms,
            state: Mutex::new(State::default()),
        })
    }

    /// Renders one prompt. Pure apart from the prefix registry: the same input renders byte-identical segments.
    pub fn render(&self, input: &RenderInput) -> Result<RenderedPrompt, PromptError> {
        let agent_id = input.agent_id.as_str();
        let model = input.model.as_str();
        let at = self.clock.now();
        if !at.is_finite() {
            return Err(PromptError::Clock);
        }
        let mut events: Vec<PromptEvent> = Vec::new();
        let mut push = |e: PromptEvent| {
            if let Some(emit) = &self.emit {
                emit(&e);
            }
            events.push(e);
        };
        let profile: CacheProfile = lookup_cache_profile(model, input.route.as_ref());
        if !profile.known {
            push(PromptEvent::UnknownModel {
                agent_id: agent_id.to_owned(),
                model: model.to_owned(),
            });
        }

        // Zone 1: tools, one segment each, sorted by name so registration order never reaches the prefix. The order
        // and the duplicate check use the NFC name that canonical JSON renders, so NFC and NFD spellings cannot move
        // the prefix. Code-point order is the byte order of UTF-8.
        let mut named: Vec<(String, &Value)> = Vec::with_capacity(input.tools.len());
        for tool in &input.tools {
            let name = tool
                .get("name")
                .and_then(Value::as_str)
                .ok_or(PromptError::ToolName)?;
            named.push((normalize_text(name), tool));
        }
        named.sort_by(|a, b| a.0.cmp(&b.0));
        let mut tool_segs: Vec<Segment> = Vec::with_capacity(named.len());
        for (i, (name, tool)) in named.iter().enumerate() {
            if i > 0 && named[i - 1].0 == *name {
                return Err(PromptError::DuplicateTool(name.clone()));
            }
            tool_segs.push(Segment {
                zone: ZoneName::Tools,
                kind: SegmentKind::ToolDef,
                role: None,
                text: canonical_json(tool)?,
                id: None,
                cache: None,
            });
        }

        // Zone 2: system parts, in the caller's order (order is meaning here).
        let system_segs: Vec<Segment> = input
            .system
            .iter()
            .map(|part| normalize_text(part))
            .filter(|text| !text.is_empty())
            .map(|text| Segment {
                zone: ZoneName::System,
                kind: SegmentKind::System,
                role: None,
                text,
                id: None,
                cache: None,
            })
            .collect();

        // Zone 3: the frozen snapshot, capped (L3: a clip is an event).
        let mem_cap = input.memory_cap.unwrap_or(DEFAULT_MEMORY_CAP_CHARS);
        check_cap(mem_cap, "memory zone cap")?;
        let mut mem_text = normalize_text(&input.memory);
        let mem_units: Vec<u16> = mem_text.encode_utf16().collect();
        if mem_units.len() as f64 > mem_cap {
            let clipped = clip_snapshot(&mem_units, mem_cap);
            push(PromptEvent::ZoneClipped {
                agent_id: agent_id.to_owned(),
                model: model.to_owned(),
                from: mem_units.len(),
                to: clipped.len(),
                cap: mem_cap,
            });
            mem_text = String::from_utf16_lossy(clipped);
        }
        let mem_segs: Vec<Segment> = if mem_text.is_empty() {
            Vec::new()
        } else {
            vec![Segment {
                zone: ZoneName::Memory,
                kind: SegmentKind::Memory,
                role: None,
                text: mem_text,
                id: None,
                cache: None,
            }]
        };

        // Zone 4: the conversation, append-only.
        let mut conv_segs: Vec<Segment> = Vec::with_capacity(input.conversation.len());
        for item in &input.conversation {
            let kind = check_conversation_item(item)?;
            conv_segs.push(Segment {
                zone: ZoneName::Conversation,
                kind: SegmentKind::Item(kind),
                role: Some(item.role),
                text: normalize_text(&item.text),
                id: item.id.clone().filter(|id| !id.is_empty()),
                cache: None,
            });
        }

        // The volatile tail: engine blocks joined under the host cap, after the last breakpoint, never cached.
        let mut vol_segs: Vec<Segment> = Vec::new();
        if let Some(volatile) = &input.volatile {
            let joined = join_recall(agent_id, model, volatile, &mut push)?;
            if !joined.text.is_empty() {
                let tool_result = joined.delivery == Delivery::ToolResult;
                vol_segs.push(Segment {
                    zone: ZoneName::Volatile,
                    kind: SegmentKind::Item(if tool_result {
                        ItemKind::ToolResult
                    } else {
                        ItemKind::Context
                    }),
                    role: Some(Role::User),
                    text: joined.text,
                    id: if tool_result {
                        joined.tool_use_id
                    } else {
                        None
                    },
                    cache: None,
                });
            }
        }

        let (tool_count, system_count, mem_count, conv_count) = (
            tool_segs.len(),
            system_segs.len(),
            mem_segs.len(),
            conv_segs.len(),
        );
        let positions = positions_of(&conv_segs);
        let mut segments: Vec<Segment> = tool_segs;
        segments.extend(system_segs);
        segments.extend(mem_segs);
        segments.extend(conv_segs);
        segments.extend(vol_segs);
        let first_conversation = tool_count + system_count + mem_count;
        let index_of = |zone: ZoneName| segments.iter().rposition(|s| s.zone == zone);

        // R2: warn, never pad, when the stable prefix cannot clear the model's floor.
        let stable_chars: usize = segments[..first_conversation]
            .iter()
            .map(|s| utf16_len(&s.text))
            .sum();
        let stable_tokens_estimate = tokens(stable_chars);
        let eligible =
            profile.known && stable_chars > 0 && stable_tokens_estimate >= profile.min_tokens;
        if profile.known && stable_tokens_estimate < profile.min_tokens {
            push(PromptEvent::BelowMinimum {
                agent_id: agent_id.to_owned(),
                model: model.to_owned(),
                tokens_estimate: stable_tokens_estimate,
                min_tokens: profile.min_tokens,
            });
        }

        // R1: breakpoint placement from the model table.
        let mut breakpoints: Vec<Breakpoint> = Vec::new();
        let wanted = input.cache_ttl.as_deref().unwrap_or("5m");
        let stable_ttl: String = if profile.ttls.iter().any(|t| t == wanted) {
            wanted.to_owned()
        } else {
            profile
                .ttls
                .first()
                .cloned()
                .unwrap_or_else(|| "5m".to_owned())
        };
        let metadata_at = |segment: usize| -> ZoneMetadata {
            let text: String = segments[..=segment]
                .iter()
                .map(|s| s.text.as_str())
                .collect();
            ZoneMetadata {
                zone: segments[segment].zone,
                byte_offset: text.len(),
                token_estimate: tokens(utf16_len(&text)),
                hash: sha256_hex(&text),
            }
        };
        let add = |list: &mut Vec<Breakpoint>, segment: usize, ttl: &str, kind: BreakpointKind| {
            let metadata = metadata_at(segment);
            if metadata.token_estimate >= profile.min_tokens {
                list.push(Breakpoint {
                    metadata,
                    segment,
                    ttl: ttl.to_owned(),
                    kind,
                });
            }
        };
        let mut lookback_risk: Option<PromptEvent> = None;
        if eligible
            && profile.mechanism == Mechanism::Explicit
            && profile.max_breakpoints > 0
            && input.cache_hint != Some(CacheHint::None)
        {
            // RULING: the trailing breakpoint always takes the shortest TTL (its content changes every turn); 1h
            // entries therefore precede 5m ones.
            let trailing_ttl: String = if profile.ttls.iter().any(|t| t == "5m") {
                "5m".to_owned()
            } else {
                profile
                    .ttls
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "5m".to_owned())
            };
            let has_trailing = conv_count > 0;
            // RULING: if the model allows fewer breakpoints than wanted, drop tools first, then system, then memory;
            // the trailing one is kept before any zone.
            let mut zones: Vec<usize> = STABLE_ZONES
                .iter()
                .filter_map(|z| index_of(*z))
                .filter(|i| metadata_at(*i).token_estimate >= profile.min_tokens)
                .collect();
            let total = positions.last().copied().unwrap_or(0);
            let needs_interior =
                has_trailing && profile.lookback_positions > 0 && total > INTERIOR_BACK;
            let max = profile.max_breakpoints as i64;
            let room = max - i64::from(has_trailing) - i64::from(needs_interior);
            if zones.len() as i64 > room {
                let keep = room.max(0) as usize;
                zones = zones.split_off(zones.len() - keep);
            }
            for segment in &zones {
                add(
                    &mut breakpoints,
                    *segment,
                    &stable_ttl,
                    BreakpointKind::Zone,
                );
            }
            if has_trailing {
                let free = max - zones.len() as i64 - 1;
                if needs_interior && free > 0 {
                    let target = total - INTERIOR_BACK;
                    if let Some(at) = positions.iter().rposition(|p| *p == target) {
                        add(
                            &mut breakpoints,
                            first_conversation + at,
                            &trailing_ttl,
                            BreakpointKind::Interior,
                        );
                    }
                } else if profile.lookback_positions > 0 && total > profile.lookback_positions {
                    lookback_risk = Some(PromptEvent::LookbackRisk {
                        agent_id: agent_id.to_owned(),
                        model: model.to_owned(),
                        positions: total,
                        lookback: profile.lookback_positions,
                    });
                }
                add(
                    &mut breakpoints,
                    first_conversation + conv_count - 1,
                    &trailing_ttl,
                    BreakpointKind::Trailing,
                );
            }
        }
        if let Some(event) = lookback_risk {
            push(event);
        }
        for bp in &breakpoints {
            segments[bp.segment].cache = Some(bp.ttl.clone());
        }

        // R3/R8: per-zone hashes and cumulative prefix hashes.
        let zone_hash = |zone: ZoneName| -> String {
            let projected: Vec<Value> = segments
                .iter()
                .filter(|s| s.zone == zone)
                .map(|s| {
                    let mut o = serde_json::Map::new();
                    o.insert("kind".to_owned(), json!(s.kind.as_str()));
                    if let Some(role) = s.role {
                        o.insert("role".to_owned(), json!(role.as_str()));
                    }
                    if let Some(id) = &s.id {
                        o.insert("id".to_owned(), json!(id));
                    }
                    o.insert("text".to_owned(), json!(s.text));
                    Value::Object(o)
                })
                .collect();
            hash_of(
                &json!({ "v": "plur1bus.prompt.zone/1", "zone": zone.as_str(), "segments": projected }),
            )
        };
        let zone_hashes: [String; 5] = ZONES.map(zone_hash);
        let prefix_hashes: [String; 3] = [0, 1, 2].map(|i: usize| {
            hash_of(&json!({ "v": "plur1bus.prompt.prefix/1", "zones": zone_hashes[..=i] }))
        });

        // R5: one prefix per (agent, model); a change is reported so the host can warn before it costs a full re-read.
        let prefix_key =
            hash_of(&json!({ "agentId": agent_id, "model": normalize_model_id(model) }));
        let session_id = sticky_session_id(agent_id, input.session_id.as_deref());
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let mut prefix = PrefixStatus::Cold;
        if let Some(before) = state.known.get(&prefix_key) {
            prefix = match (0..3).find(|i| before[*i] != prefix_hashes[*i]) {
                Some(i) => PrefixStatus::Invalidated(STABLE_ZONES[i]),
                None => PrefixStatus::Warm,
            };
            if let PrefixStatus::Invalidated(zone) = prefix {
                push(PromptEvent::PrefixInvalidated {
                    agent_id: agent_id.to_owned(),
                    model: model.to_owned(),
                    from: Some(zone),
                    previous_model: None,
                    reason: if input.memory_refresh {
                        InvalidationReason::MemoryRefresh
                    } else {
                        InvalidationReason::PrefixChanged
                    },
                });
            }
        }
        state
            .known
            .insert(prefix_key.clone(), prefix_hashes.clone());

        // Session identity is metadata only; model switches do not erase other models' entries.
        if let Some(previous) = state.active_models.get(&session_id) {
            if normalize_model_id(previous) != normalize_model_id(model) {
                push(PromptEvent::PrefixInvalidated {
                    agent_id: agent_id.to_owned(),
                    model: model.to_owned(),
                    from: None,
                    previous_model: Some(previous.clone()),
                    reason: InvalidationReason::ModelChanged,
                });
            }
        }
        state
            .active_models
            .insert(session_id.clone(), model.to_owned());

        let ttl_ms: Option<f64> = match self.ttl_overrides.get(&profile.provider) {
            Some(configured) => *configured,
            None if profile.provider == "anthropic" && stable_ttl == "1h" => Some(3_600_000.0),
            None => profile.warm_ms.map(|ms| ms as f64),
        };
        let render_key =
            canonical_json(&json!({ "prefixKey": prefix_key, "session_id": session_id }))
                .unwrap_or_default();
        let last = state.last_render.get(&render_key);
        let age_ms = last.map(|l| at - l.at);
        let warm = eligible
            && last.is_some_and(|l| {
                l.eligible
                    && l.hash == prefix_hashes[2]
                    && l.ttl_ms
                        .is_some_and(|ttl| at - l.at >= 0.0 && at - l.at < ttl)
            });
        state.last_render.insert(
            render_key,
            LastRender {
                at,
                hash: prefix_hashes[2].clone(),
                ttl_ms,
                eligible,
            },
        );
        drop(state);

        let mut byte_offset = 0;
        let zones: Vec<ZoneMetadata> = ZONES
            .iter()
            .zip(&zone_hashes)
            .map(|(zone, hash)| {
                let parts = segments.iter().filter(|s| s.zone == *zone);
                byte_offset += parts.clone().map(|s| s.text.len()).sum::<usize>();
                ZoneMetadata {
                    zone: *zone,
                    byte_offset,
                    token_estimate: tokens(parts.map(|s| utf16_len(&s.text)).sum()),
                    hash: hash.clone(),
                }
            })
            .collect();
        let reason = if !profile.known {
            CacheReason::UnknownModel
        } else if stable_chars == 0 {
            CacheReason::EmptyPrefix
        } else if !eligible {
            CacheReason::BelowMinimum
        } else if profile.mechanism == Mechanism::Implicit {
            CacheReason::ImplicitProvider
        } else {
            CacheReason::Eligible
        };
        let cache = CacheInfo {
            provider: profile.provider.clone(),
            mechanism: profile.mechanism,
            minimum_tokens: profile.min_tokens,
            eligible,
            reason,
            expected_warm: warm,
            ttl: (!profile.ttls.is_empty()).then_some(stable_ttl),
            age_ms,
            ttl_ms,
        };
        Ok(RenderedPrompt {
            agent_id: agent_id.to_owned(),
            model: model.to_owned(),
            prefix_key,
            segments,
            breakpoints,
            zone_hashes,
            prefix_hashes,
            prefix,
            stable_tokens_estimate,
            zones,
            session_id,
            cache,
            events,
        })
    }
}

/// sha256 of the canonical JSON of a value the builder made itself (string members only, so it always has a form).
fn hash_of(value: &Value) -> String {
    sha256_hex(&canonical_json(value).unwrap_or_default())
}

/// `stickySessionId`: a stable routing identity, kept separate from rendered prefix content. `None` is the session
/// called `default`.
pub fn sticky_session_id(agent_id: &str, session_id: Option<&str>) -> String {
    hash_of(&json!({ "agentId": agent_id, "sessionId": session_id.unwrap_or("default") }))
}
