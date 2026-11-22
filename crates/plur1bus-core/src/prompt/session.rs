//! A prompt session (L7, ADR-010 §1; `packages/core/src/prompt/session.ts`): the memory snapshot is fixed for the
//! session and replaced only by an explicit refresh; a recall never touches it. A recall rides the volatile tail of
//! its own request, then folds into the conversation at the point it arrived, so the cached prefix only grows.
use super::builder::{check_conversation_item, join_recall, Emit, PromptBuilder, PromptError};
use super::join::Block;
use super::types::{
    ConversationItem, Delivery, ItemKind, PromptEvent, RenderInput, RenderedPrompt, Role,
    VolatileInput,
};
use serde_json::Value;
use std::sync::Arc;

/// What a session is opened with. Tools, system parts and the snapshot are owned by the session from here on, so
/// nothing a caller does later can move the prefix mid-session.
pub struct PromptSessionOptions {
    /// The builder (shared with the composition).
    pub builder: Arc<PromptBuilder>,
    /// The agent.
    pub agent_id: String,
    /// The model.
    pub model: String,
    /// A host-provided session identity for sticky routing and TTL isolation.
    pub session_id: Option<String>,
    /// The tool definitions.
    pub tools: Vec<Value>,
    /// The system parts.
    pub system: Vec<String>,
    /// The frozen memory snapshot, as of session start.
    pub memory_snapshot: String,
    /// Stable-zone breakpoint TTL.
    pub cache_ttl: Option<String>,
    /// The cap of the memory zone.
    pub memory_cap: Option<f64>,
    /// Receives the clip events of a recall as it arrives (render-time events come back on the rendered prompt).
    pub emit: Option<Emit>,
}

struct Folded {
    /// Number of conversation items before the recall: it sits right after item `anchor - 1`.
    anchor: usize,
    item: ConversationItem,
}

/// One prompt session.
pub struct PromptSession {
    o: PromptSessionOptions,
    refreshed: bool,
    items: Vec<ConversationItem>,
    recalls: Vec<Folded>,
}

impl PromptSession {
    /// `createPromptSession(options)`.
    pub fn new(options: PromptSessionOptions) -> Self {
        Self {
            o: options,
            refreshed: false,
            items: Vec::new(),
            recalls: Vec::new(),
        }
    }

    /// The agent.
    pub fn agent_id(&self) -> &str {
        &self.o.agent_id
    }

    /// The current model.
    pub fn model(&self) -> &str {
        &self.o.model
    }

    /// The current snapshot.
    pub fn memory_snapshot(&self) -> &str {
        &self.o.memory_snapshot
    }

    /// Appends one conversation entry; a refused shape is not stored, so one bad item cannot break every later render.
    pub fn append(&mut self, item: ConversationItem) -> Result<(), PromptError> {
        check_conversation_item(&item)?;
        self.items.push(item);
        Ok(())
    }

    /// Explicitly pays the snapshot invalidation cost; there is no automatic refresh by timer or recall.
    pub fn refresh_memory_snapshot(&mut self, snapshot: &str) {
        if snapshot != self.o.memory_snapshot {
            self.o.memory_snapshot = snapshot.to_owned();
            self.refreshed = true;
        }
    }

    /// The host performs any confirmation before calling; the next render reports the cost of the model change.
    pub fn set_model(&mut self, model: &str) {
        self.o.model = model.to_owned();
    }

    /// Takes a recall result. Returns its clip events (also handed to `emit`). RULING: the latest recall wins at an
    /// anchor.
    pub fn recall(
        &mut self,
        blocks: &[Block],
        cap_chars: Option<f64>,
        delivery: Option<Delivery>,
        tool_use_id: Option<&str>,
    ) -> Result<Vec<PromptEvent>, PromptError> {
        let mut events = Vec::new();
        let volatile = VolatileInput {
            blocks: blocks.to_vec(),
            cap_chars,
            delivery,
            tool_use_id: tool_use_id.filter(|id| !id.is_empty()).map(str::to_owned),
        };
        let emit = self.o.emit.as_ref();
        let joined = join_recall(&self.o.agent_id, &self.o.model, &volatile, &mut |e| {
            if let Some(emit) = emit {
                emit(&e);
            }
            events.push(e);
        })?;
        let anchor = self.items.len();
        if let Some(at) = self.recalls.iter().position(|r| r.anchor == anchor) {
            self.recalls.remove(at);
        }
        if !joined.text.is_empty() {
            let tool_result = joined.delivery == Delivery::ToolResult;
            self.recalls.push(Folded {
                anchor,
                item: ConversationItem {
                    role: Role::User,
                    kind: Some(if tool_result {
                        ItemKind::ToolResult
                    } else {
                        ItemKind::Context
                    }),
                    text: joined.text,
                    id: if tool_result {
                        joined.tool_use_id
                    } else {
                        None
                    },
                },
            });
        }
        Ok(events)
    }

    /// Recalls are interleaved at their anchors; the one anchored at the end is the live tail and is rendered as
    /// volatile instead.
    fn conversation(&self) -> Vec<ConversationItem> {
        let mut out = Vec::with_capacity(self.items.len() + self.recalls.len());
        for (i, item) in self.items.iter().enumerate() {
            out.extend(
                self.recalls
                    .iter()
                    .filter(|r| r.anchor == i)
                    .map(|r| r.item.clone()),
            );
            out.push(item.clone());
        }
        out
    }

    /// Renders the session's prompt.
    pub fn render(&mut self) -> Result<RenderedPrompt, PromptError> {
        let live = self.recalls.iter().find(|r| r.anchor == self.items.len());
        let input = RenderInput {
            agent_id: self.o.agent_id.clone(),
            model: self.o.model.clone(),
            route: None,
            session_id: self.o.session_id.clone(),
            memory_refresh: self.refreshed,
            tools: self.o.tools.clone(),
            system: self.o.system.clone(),
            memory: self.o.memory_snapshot.clone(),
            conversation: self.conversation(),
            volatile: live.map(|r| VolatileInput {
                blocks: vec![Block {
                    name: "recall".to_owned(),
                    text: r.item.text.clone(),
                    droppable: false,
                }],
                cap_chars: Some(f64::INFINITY),
                delivery: Some(if r.item.kind == Some(ItemKind::ToolResult) {
                    Delivery::ToolResult
                } else {
                    Delivery::Context
                }),
                tool_use_id: r.item.id.clone(),
            }),
            cache_ttl: self.o.cache_ttl.clone().filter(|ttl| !ttl.is_empty()),
            cache_hint: None,
            memory_cap: self.o.memory_cap,
        };
        let result = self.o.builder.render(&input)?;
        self.refreshed = false;
        Ok(result)
    }
}
