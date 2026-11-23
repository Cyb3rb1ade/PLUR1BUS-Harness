//! Consent-bound promotion of a private direct conversation to a project board.
use super::gate::{open_store, write};
use super::surface::member_principal;
use crate::approvals::js_json::J;
use crate::budget::{Clock, IdSource};
use crate::collab::service::CollabService;
use crate::collab::{CollabError, CollabErrorCode as C};
use crate::identity::principals::derive_user_principal;
use crate::js::{js_trim, utf16_len};
use crate::rbac::audit::{AuditEvent, AuditSink};
use crate::rbac::authorize::authorize;
use crate::rbac::types::{AuthorizeContext, Principal, PrincipalKind, Resource};
use crate::sessions::store::SessionStore;
use crate::sessions::{MessageRecord, MessageRole, SessionError, SessionKind};
use plur1bus_store::rusqlite::{params, Connection, OptionalExtension};
use plur1bus_store::Store;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::Path;

type R<T> = Result<T, CollabError>;

/// Metadata required before reading chat content.
pub struct ChatIdentity {
    /// Owner derived from the authenticated person.
    pub owner: String,
    /// Agent bound to the source.
    pub agent: String,
    /// Only direct chats can be promoted.
    pub kind: SessionKind,
}

/// Active messages and rewinds, both relevant to preview freshness.
pub struct ChatContent {
    /// Tail of the conversation through the active-path view.
    pub messages: Vec<MessageRecord>,
    /// Rewind revisions, including undo history.
    pub rewinds: Value,
}

/// Resolves the caller's session runtime, including in-memory chats.
pub trait PromotionSource {
    /// Reads only metadata.
    fn identity(&self, id: &str) -> R<Option<ChatIdentity>>;
    /// Reads active content after authorization.
    fn content(&self, id: &str) -> R<ChatContent>;
}

/// Destination choice.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    /// Always create a card in an existing project.
    Card,
    /// Link to a known project, optionally adding notes.
    Project,
    /// Create a project with the explicitly chosen name.
    NewProject,
}

/// Destination selected explicitly by the person.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// Destination choice.
    pub kind: TargetKind,
    /// Existing project identifier.
    pub project_id: Option<String>,
    /// New project name.
    pub name: Option<String>,
    /// Optional card title.
    pub title: Option<String>,
    /// Optional destination column.
    pub column_id: Option<String>,
}

/// Content proposed for copying.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectionKind {
    /// No content.
    None,
    /// Explicit text entered by the person.
    Summary,
    /// Specific messages.
    Selected,
    /// Active conversation, bounded and without system instructions.
    Transcript,
}

/// Explicit content selection and its arguments.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    /// Copy mode.
    pub kind: SelectionKind,
    /// User-authored summary, if selected.
    pub summary: Option<String>,
    /// Individual visible ids, if selected.
    pub message_ids: Option<Vec<String>>,
}

/// Preview before any project write.
#[derive(Clone)]
pub struct Preview {
    /// Short-lived opaque handle for this choice.
    pub id: String,
    /// Exactly what would be published.
    pub content: String,
    /// Destination snapshot.
    pub target: Target,
    /// Content mode.
    pub selection: SelectionKind,
    /// First instant when a commit must refuse.
    pub expires_at: i64,
}

/// Project and optional card published by the trusted destination.
pub struct Published {
    /// Created or selected project.
    pub project_id: String,
    /// Created card, if any.
    pub card_id: Option<String>,
}

/// Consented write, with an idempotency key. Only the selected content, never the source id or title, is passed.
pub struct PublishInput<'a> {
    /// Stable key governing retries.
    pub key: &'a str,
    /// Authenticated person.
    pub actor: &'a Principal,
    /// Destination validated against live project membership.
    pub target: &'a Target,
    /// Selected text.
    pub content: &'a str,
    /// Whether a card is requested.
    pub create_card: bool,
}

/// Project write boundary. Repeating a key must return the same destination after a successful apply.
pub trait PromotionPublisher {
    /// Publish the requested effect atomically and deduplicate by key.
    fn publish(&mut self, input: PublishInput<'_>) -> R<Published>;
}

/// Promotion dependencies shared by the preview, commit and links paths.
pub struct PromotionPorts<'a> {
    /// Private session read port.
    pub source: &'a dyn PromotionSource,
    /// Project lookup and membership.
    pub collab: &'a CollabService,
    /// Current epoch in milliseconds.
    pub clock: &'a dyn Clock,
    /// Opaque preview identifiers.
    pub ids: &'a dyn IdSource,
    /// Authorized write port for the destination board.
    pub publisher: &'a mut dyn PromotionPublisher,
    /// Metadata-only audit, before publication.
    pub audit: &'a mut dyn AuditSink,
}

/// Durable private link receipt.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    /// Destination project.
    pub project_id: String,
    /// Destination card, if created.
    pub card_id: Option<String>,
    /// Copy mode.
    pub selection: SelectionKind,
    /// Number of conversation messages actually copied.
    pub transferred_messages: usize,
}

const DDL: &str = "CREATE TABLE IF NOT EXISTS chat_promotions(id TEXT PRIMARY KEY, person TEXT NOT NULL, source_session TEXT NOT NULL, result TEXT NOT NULL);";
const PREVIEW_TTL: i64 = 600_000;
const MAX_PREVIEWS: usize = 256;
const MAX_MESSAGES: usize = 10_000;
const MAX_CONTENT: usize = 65_536;

struct RecordedPreview {
    plan: Preview,
    person: String,
    source: String,
    source_hash: String,
    transferred: usize,
}

/// Short-lived previews and durable chat-promotion receipts.
pub struct ChatPromotion {
    db: Store,
    previews: HashMap<String, RecordedPreview>,
}

fn invalid(message: &str) -> CollabError {
    CollabError::new(C::Invalid, message)
}

fn denied(message: &str) -> CollabError {
    CollabError::new(C::Unauthorized, message)
}

fn preview_missing() -> CollabError {
    CollabError::new(C::NotFound, "promotion preview not found")
}

fn unreadable(_: SessionError) -> CollabError {
    CollabError::new(C::Storage, "source conversation could not be read")
}

impl PromotionSource for SessionStore {
    fn identity(&self, id: &str) -> R<Option<ChatIdentity>> {
        Ok(self
            .get_session(id)
            .map_err(unreadable)?
            .map(|s| ChatIdentity {
                owner: s.owner,
                agent: s.agent_id,
                kind: s.kind,
            }))
    }

    fn content(&self, id: &str) -> R<ChatContent> {
        let messages = self.context_messages(id, None).map_err(unreadable)?;
        let rows = self.rewinds(id).map_err(unreadable)?;
        let rewinds = rows.into_iter().map(|r| json!({
            "id": r.id, "sessionId": r.session_id, "parentSeq": r.parent_seq, "hiddenFromSeq": r.hidden_from_seq,
            "hiddenToSeq": r.hidden_to_seq, "lessonMessageId": r.lesson_message_id, "hiddenDigest": r.hidden_digest,
            "trigger": r.trigger.as_str(), "actor": r.actor, "createdAt": r.created_at, "undoneAt": r.undone_at,
        })).collect();
        Ok(ChatContent {
            messages,
            rewinds: Value::Array(rewinds),
        })
    }
}

struct Source {
    messages: Vec<MessageRecord>,
    too_large: bool,
    hash: String,
}

fn source(who: &Principal, id: &str, port: &dyn PromotionSource) -> R<Source> {
    if who.kind != Some(PrincipalKind::Person) {
        return Err(denied("a person is required"));
    }
    let owner = derive_user_principal(&who.user_id).map_err(|_| denied("a person is required"))?;
    let session = port
        .identity(id)?
        .filter(|identity| identity.owner == owner)
        .ok_or_else(|| CollabError::new(C::NotFound, format!("session {id} not found")))?;
    if session.kind != SessionKind::Direct {
        return Err(CollabError::new(C::NotFound, "direct chat not found"));
    }
    let resource = Resource::Agent {
        agent_id: session.agent.clone(),
    };
    if !authorize(
        Some(who),
        "agent.use",
        &resource,
        &AuthorizeContext::default(),
    )
    .is_allow()
    {
        return Err(denied("agent right required"));
    }
    let ChatContent {
        mut messages,
        rewinds,
    } = port.content(id)?;
    let too_large = messages.len() > MAX_MESSAGES;
    let discarded = messages.len().saturating_sub(MAX_MESSAGES + 1);
    messages.drain(..discarded);
    messages.retain(|m| m.role != MessageRole::System);
    let projected: Vec<_> = messages
        .iter()
        .map(|m| {
            json!([
                m.id,
                m.session_id,
                m.turn_id,
                m.seq,
                m.role.as_str(),
                m.text,
                m.tokens,
                m.created_at
            ])
        })
        .collect();
    let bytes = json!([id, owner, session.agent, projected, rewinds]).to_string();
    let hash = format!("{:x}", Sha256::digest(bytes.as_bytes()));
    Ok(Source {
        messages,
        too_large,
        hash,
    })
}

fn validate_target(who: &Principal, target: &Target, collab: &CollabService) -> R<()> {
    if target.kind == TargetKind::NewProject {
        let name_ok = target
            .name
            .as_deref()
            .is_some_and(|name| !js_trim(name).is_empty() && utf16_len(name) <= 160);
        if !name_ok || target.project_id.is_some() || target.column_id.is_some() {
            return Err(invalid("new project needs a name"));
        }
        let allowed = authorize(
            Some(who),
            "project.create",
            &Resource::System,
            &AuthorizeContext::default(),
        )
        .is_allow();
        if !allowed {
            return Err(denied("project creation not permitted"));
        }
    } else {
        let id = target
            .project_id
            .as_deref()
            .filter(|id| !id.is_empty() && target.name.is_none())
            .ok_or_else(|| invalid("existing project required"))?;
        let p = collab.get_project(who, id)?;
        let actor = member_principal(who, &p);
        if p.archived_at.is_some()
            || !authorize(
                Some(&actor),
                "project.write",
                &Resource::Project {
                    project_id: p.id.clone(),
                },
                &AuthorizeContext::default(),
            )
            .is_allow()
        {
            return Err(denied("project write required"));
        }
        if let Some(column_id) = &target.column_id {
            if !collab
                .store()
                .board_columns(id)?
                .iter()
                .any(|c| c.get("id").and_then(J::as_str) == Some(column_id.as_str()))
            {
                return Err(CollabError::new(C::NotFound, "column not found"));
            }
        }
    }
    if target
        .title
        .as_deref()
        .is_some_and(|title| js_trim(title).is_empty() || utf16_len(title) > 256)
    {
        return Err(invalid("invalid destination title"));
    }
    Ok(())
}

fn message_text<'a>(messages: impl Iterator<Item = &'a MessageRecord>) -> R<(String, usize)> {
    let mut text = String::new();
    let mut count = 0;
    for message in messages {
        if count > 0 {
            text.push_str("\n\n");
        }
        text.push_str(message.role.as_str());
        text.push_str(": ");
        if text.len().saturating_add(message.text.len()) > MAX_CONTENT {
            return Err(invalid(
                "selection is too large; choose a summary or fewer messages",
            ));
        }
        text.push_str(&message.text);
        count += 1;
    }
    Ok((text, count))
}

fn selection_text(selection: &Selection, source: &Source) -> R<(String, usize)> {
    match selection.kind {
        SelectionKind::None if selection.summary.is_none() && selection.message_ids.is_none() => {
            Ok((String::new(), 0))
        }
        SelectionKind::Summary if selection.message_ids.is_none() => {
            let summary = selection
                .summary
                .as_deref()
                .filter(|s| !js_trim(s).is_empty())
                .ok_or_else(|| invalid("explicit summary required"))?;
            if summary.len() > MAX_CONTENT {
                return Err(invalid(
                    "selection is too large; choose a summary or fewer messages",
                ));
            }
            Ok((summary.to_owned(), 0))
        }
        SelectionKind::Selected => {
            let invalid_ids = || invalid("select existing messages from this chat");
            let ids = selection
                .message_ids
                .as_ref()
                .filter(|ids| !ids.is_empty() && selection.summary.is_none())
                .ok_or_else(invalid_ids)?;
            let requested: HashSet<_> = ids.iter().map(String::as_str).collect();
            if requested.len() != ids.len()
                || !requested
                    .iter()
                    .all(|id| source.messages.iter().any(|m| m.id == *id))
            {
                return Err(invalid_ids());
            }
            message_text(
                source
                    .messages
                    .iter()
                    .filter(|message| requested.contains(message.id.as_str())),
            )
        }
        SelectionKind::Transcript => {
            if source.too_large {
                return Err(invalid(
                    "transcript is too large; choose a summary or selected messages",
                ));
            }
            if selection.summary.is_some() || selection.message_ids.is_some() {
                return Err(invalid("transcript has no extra selection"));
            }
            message_text(source.messages.iter())
        }
        SelectionKind::Summary => Err(invalid("explicit summary required")),
        SelectionKind::None => Err(invalid("invalid content selection")),
    }
}

fn decode_receipt(text: &str) -> R<Receipt> {
    serde_json::from_str(text)
        .map_err(|_| CollabError::new(C::Storage, "promotion receipt is unreadable"))
}

fn committed(db: &Connection, who: &Principal, id: &str) -> R<Option<(String, Receipt)>> {
    let row = db
        .query_row(
            "SELECT person,source_session,result FROM chat_promotions WHERE id=?",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    match row {
        None => Ok(None),
        Some((person, source, receipt)) if person == who.user_id => {
            Ok(Some((source, decode_receipt(&receipt)?)))
        }
        Some(_) => Err(preview_missing()),
    }
}

fn existing_target(project_id: String) -> Target {
    Target {
        kind: TargetKind::Project,
        project_id: Some(project_id),
        name: None,
        title: None,
        column_id: None,
    }
}

impl ChatPromotion {
    /// Open the compatible unversioned receipt store.
    pub fn open(path: &Path) -> R<Self> {
        Self::open_with_permissions(path, None)
    }

    /// Open with the host's owner-only attestation for disk-backed stores.
    pub fn open_with_permissions(path: &Path, secure: Option<&dyn Fn(&Path) -> bool>) -> R<Self> {
        Ok(Self {
            db: open_store(path, "chat-promotions", DDL, secure)?,
            previews: HashMap::new(),
        })
    }

    /// Capture a consent preview using the current source and destination.
    pub fn preview(
        &mut self,
        who: &Principal,
        session_id: &str,
        target: Target,
        selection: &Selection,
        ports: &PromotionPorts<'_>,
    ) -> R<Preview> {
        let source = source(who, session_id, ports.source)?;
        validate_target(who, &target, ports.collab)?;
        let (content, transferred) = selection_text(selection, &source)?;
        let now = ports.clock.now();
        self.previews.retain(|_, p| p.plan.expires_at > now);
        if self.previews.len() >= MAX_PREVIEWS {
            return Err(CollabError::new(
                C::Conflict,
                "promotion preview capacity reached",
            ));
        }
        let id = ports.ids.next_id();
        if id.is_empty()
            || self.previews.contains_key(&id)
            || committed(self.db.conn(), who, &id)?.is_some()
        {
            return Err(CollabError::new(
                C::Conflict,
                "promotion preview identifier is unavailable",
            ));
        }
        let plan = Preview {
            id: id.clone(),
            content,
            target,
            selection: selection.kind,
            expires_at: now.saturating_add(PREVIEW_TTL),
        };
        self.previews.insert(
            id,
            RecordedPreview {
                plan: plan.clone(),
                person: who.user_id.clone(),
                source: session_id.to_owned(),
                source_hash: source.hash,
                transferred,
            },
        );
        Ok(plan)
    }

    /// Publish an explicit preview and keep a private receipt. The write port deduplicates by the preview key.
    pub fn commit(
        &mut self,
        who: &Principal,
        id: &str,
        ports: &mut PromotionPorts<'_>,
    ) -> R<Receipt> {
        let result = write(self.db.conn(), |db| {
            if let Some((session, receipt)) = committed(db, who, id)? {
                source(who, &session, ports.source)?;
                validate_target(
                    who,
                    &existing_target(receipt.project_id.clone()),
                    ports.collab,
                )?;
                return Ok(receipt);
            }
            let preview = self
                .previews
                .get(id)
                .filter(|p| p.person == who.user_id)
                .ok_or_else(preview_missing)?;
            let plan = &preview.plan;
            if plan.expires_at <= ports.clock.now() {
                return Err(CollabError::with_reason(
                    C::Conflict,
                    "promotion preview expired",
                    "expired",
                ));
            }
            let current = source(who, &preview.source, ports.source)?;
            validate_target(who, &plan.target, ports.collab)?;
            if current.hash != preview.source_hash {
                return Err(CollabError::new(
                    C::Conflict,
                    "chat changed; preview the selection again",
                ));
            }
            ports
                .audit
                .append(&AuditEvent {
                    at: ports.clock.now(),
                    user: who.user_id.clone(),
                    host: String::new(),
                    action: "chat.promoted".to_owned(),
                    target: "project".to_owned(),
                    detail: vec![
                        ("bytes".to_owned(), json!(plan.content.len())),
                        ("selection".to_owned(), json!(plan.selection)),
                    ],
                })
                .map_err(|_| CollabError::new(C::Storage, "chat promotion audit failed"))?;
            let mut target = plan.target.clone();
            target.name = target.name.map(|name| js_trim(&name).to_owned());
            target.title = target.title.map(|title| js_trim(&title).to_owned());
            let create_card = plan.target.kind == TargetKind::Card || !plan.content.is_empty();
            // The destination never receives the source id, title, or content outside the explicit selection.
            let published = ports.publisher.publish(PublishInput {
                key: id,
                actor: who,
                target: &target,
                content: &plan.content,
                create_card,
            })?;
            if published.project_id.is_empty()
                || (create_card != published.card_id.is_some())
                || target
                    .project_id
                    .as_deref()
                    .is_some_and(|p| p != published.project_id)
            {
                return Err(CollabError::new(
                    C::Storage,
                    "promotion destination returned an invalid receipt",
                ));
            }
            let receipt = Receipt {
                project_id: published.project_id,
                card_id: published.card_id,
                selection: plan.selection,
                transferred_messages: preview.transferred,
            };
            let serialized = serde_json::to_string(&receipt)
                .map_err(|_| CollabError::new(C::Storage, "cannot encode promotion receipt"))?;
            db.execute(
                "INSERT INTO chat_promotions VALUES (?,?,?,?)",
                params![id, who.user_id, preview.source, serialized],
            )?;
            Ok(receipt)
        });
        if result.is_ok()
            || result
                .as_ref()
                .is_err_and(|e| e.reason.as_deref() == Some("expired"))
        {
            self.previews.remove(id);
        }
        result
    }

    /// Links whose private source and project are both still visible to the caller.
    pub fn links(
        &self,
        who: &Principal,
        session: &str,
        ports: &PromotionPorts<'_>,
    ) -> R<Vec<Value>> {
        source(who, session, ports.source)?;
        let mut sql = self.db.conn().prepare(
            "SELECT result FROM chat_promotions WHERE person=? AND source_session=? ORDER BY rowid",
        )?;
        let rows = sql.query_map([who.user_id.as_str(), session], |r| r.get::<_, String>(0))?;
        let mut links = Vec::new();
        for row in rows {
            let receipt = decode_receipt(&row?)?;
            if let Ok(p) = ports.collab.get_project(who, &receipt.project_id) {
                let mut link = json!(receipt);
                link["projectName"] = json!(p.name);
                links.push(link);
            }
        }
        Ok(links)
    }
}

#[cfg(test)]
#[path = "promotion_vectors.rs"]
mod vectors;
