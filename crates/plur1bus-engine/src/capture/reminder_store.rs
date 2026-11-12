//! Host-authorized reminder capture. Dispatch and acknowledgement belong to their later stages.
use super::pipeline::{CapturePostStore, ReminderEffect};
use super::{
    output_unicode::external,
    reminders::{self, ReminderPlan},
    row_defaults,
    wal::kernel_lock,
};
use crate::{
    context::RequestContext,
    contract::{
        AgentContext, Cancel, EmbedKind, EngineError, HostServices, MemoryRow, Principal,
        StoreError,
    },
    embedding::{batch::validate_vectors, EmbeddingProvider},
    store::{directory::TrustedDirectory, StorePool},
    text::js::JsString,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// A skipped extraction or a durable existing/new reminder.
pub enum ReminderCapture {
    /// Deterministic extraction gate declined the item.
    Skipped(&'static str),
    /// The existing or committed row and whether this call created it.
    Stored {
        /// The authenticated existing or durably committed reminder.
        row: Box<MemoryRow>,
        /// False when this key already had an active reminder.
        created: bool,
    },
}
/// Original selected message and authority for a recoverable reminder effect.
#[derive(Clone, Copy)]
pub struct ReminderInput<'a> {
    /// Selected source text before chunk expansion.
    pub text: &'a JsString,
    /// Original message role.
    pub role: &'a str,
    /// Effective auto-extraction gate.
    pub enabled: bool,
    /// Original caller, revalidated on replay.
    pub principal: &'a Principal,
    /// Original agent execution context.
    pub agent: &'a AgentContext,
}
struct Replay<'a> {
    position: usize,
    journal: &'a mut dyn CapturePostStore,
}

/// Real host, private agent store and embedding route; no fallback fixture metadata.
pub struct ReminderStore {
    host: Arc<dyn HostServices>,
    stores: Arc<StorePool>,
    embedder: Arc<dyn EmbeddingProvider>,
}
impl ReminderStore {
    /// Compose against the same active store/embedding identity as the capture pipeline.
    pub fn new(
        host: Arc<dyn HostServices>,
        stores: Arc<StorePool>,
        embedder: Arc<dyn EmbeddingProvider>,
    ) -> Self {
        Self {
            host,
            stores,
            embedder,
        }
    }
    /// Parse one actual capture item and store only a user reminder with a usable time/topic.
    pub fn capture(
        &self,
        input: &JsString,
        role: &str,
        enabled: bool,
        p: &Principal,
        a: &AgentContext,
        cancel: &Cancel,
    ) -> Result<ReminderCapture, EngineError> {
        self.capture_inner(
            ReminderInput {
                text: input,
                role,
                enabled,
                principal: p,
                agent: a,
            },
            None,
            cancel,
        )
    }
    /// Preserve the first planned target and time through outer capture recovery.
    pub fn capture_recoverable(
        &self,
        input: ReminderInput<'_>,
        position: usize,
        journal: &mut dyn CapturePostStore,
        cancel: &Cancel,
    ) -> Result<ReminderCapture, EngineError> {
        self.capture_inner(input, Some(Replay { position, journal }), cancel)
    }
    fn capture_inner(
        &self,
        input: ReminderInput<'_>,
        mut replay: Option<Replay<'_>>,
        cancel: &Cancel,
    ) -> Result<ReminderCapture, EngineError> {
        let ReminderInput {
            text: input,
            role,
            enabled,
            principal: p,
            agent: a,
        } = input;
        cancel.check()?;
        if let Some(replay) = &replay {
            replay.journal.check(cancel)?;
        }
        let first = self.host.workspace_dir(&p.agent_id)?;
        let context = RequestContext::build(p, a, self.host.as_ref())?;
        if first != self.host.workspace_dir(&p.agent_id)? {
            return Err(StoreError::InvalidInput.into());
        }
        let now = replay
            .as_ref()
            .map_or_else(|| self.host.now_ms(), |r| r.journal.reference_time());
        let plan = reminders::plan(input, role, enabled, now)?;
        let (intent, text) = match plan {
            ReminderPlan::Candidate { intent, text } => (intent, text),
            ReminderPlan::Skip(reason) => return Ok(ReminderCapture::Skipped(reason)),
        };
        let timestamp = intent
            .remind_at
            .filter(|v| v.is_finite() && *v >= 0. && *v <= 1e15)
            .ok_or(StoreError::InvalidInput)?
            .floor() as i64;
        let workspace = if let Some(path) = first {
            TrustedDirectory::open(&path)?
                .path()
                .to_str()
                .ok_or(StoreError::InvalidInput)?
                .to_owned()
        } else {
            "default".into()
        };
        let key = reminder_key(context.agent_id.as_str(), &workspace, &text, timestamp);
        let text = external(&text);
        if crate::text::js::js_trim(&text).is_empty() {
            return Err(StoreError::InvalidInput.into());
        }
        cancel.check()?;
        let store = self
            .stores
            .get_with_expected(context.agent_id.as_str(), Some(self.embedder.identity()))?;
        let directory =
            TrustedDirectory::open(&self.stores.agent_path(context.agent_id.as_str())?)?;
        let locks = directory.create_child(".reminder-leases")?;
        let lease = kernel_lock::acquire(&locks, &key, cancel, &mut || {})?;
        if let Some(receipt) = replay.as_ref().and_then(|r| r.journal.reminder(r.position)) {
            validate_receipt(&receipt.row, &context, &workspace, &key, &text, timestamp)?;
            replay
                .as_ref()
                .ok_or(StoreError::Corrupt)?
                .journal
                .check(cancel)?;
            crate::store::tombstone::assert_card_write_allowed(
                directory.path().parent().ok_or(StoreError::InvalidInput)?,
                &receipt.row,
            )?;
            if let Some(current) = store.get(&receipt.row.id)? {
                validate_replay_row(&receipt.row, &current)?;
                return Ok(ReminderCapture::Stored {
                    row: Box::new(current),
                    created: false,
                });
            }
            if !receipt.create {
                return Err(StoreError::Corrupt.into());
            }
            lease.check(&locks)?;
            directory.assert_unchanged()?;
            cancel.check()?;
            store.upsert(std::slice::from_ref(&receipt.row))?;
            return Ok(ReminderCapture::Stored {
                row: Box::new(receipt.row),
                created: true,
            });
        }
        let existing = store.capture_reminders(context.agent_id.as_str(), &workspace, &key)?;
        let mut active = existing
            .into_iter()
            .filter(|row| {
                !matches!(row.status.as_str(), "archived" | "deleted" | "superseded")
                    && !matches!(row.reminder_status.as_str(), "acknowledged" | "cancelled")
            })
            .collect::<Vec<_>>();
        active.sort_by(|a, b| {
            a.created_at
                .as_f64()
                .unwrap_or(0.)
                .total_cmp(&b.created_at.as_f64().unwrap_or(0.))
        });
        if let Some(row) = active.into_iter().next() {
            // A key match never grants access to a shared/foreign ownership tuple.
            if row.scope != "agent-private"
                || !row.owner_user_id.is_empty()
                || !row.workspace_id.is_empty()
                || (!row.agent_id.is_empty() && row.agent_id != context.agent_id.as_str())
                || row.epistemic_status == "invalidated"
            {
                return Err(StoreError::Corrupt.into());
            }
            crate::store::tombstone::assert_card_write_allowed(
                directory.path().parent().ok_or(StoreError::InvalidInput)?,
                &row,
            )?;
            cancel.check()?;
            if let Some(replay) = &mut replay {
                replay.journal.plan_reminder(
                    replay.position,
                    ReminderEffect {
                        row: row.clone(),
                        create: false,
                    },
                    cancel,
                )?;
            }
            return Ok(ReminderCapture::Stored {
                row: Box::new(row),
                created: false,
            });
        }
        let mut vectors =
            self.embedder
                .embed(std::slice::from_ref(&text), EmbedKind::Query, cancel)?;
        let dimension = self
            .embedder
            .identity()
            .dimension
            .as_u64()
            .ok_or(StoreError::InvalidInput)? as usize;
        validate_vectors(&vectors, 1, dimension)?;
        let vector = vectors.pop().ok_or(StoreError::Corrupt)?;
        let mut row = row_defaults::schema_defaults(vector);
        row.id = uuid::Uuid::new_v4().to_string();
        row.text = text;
        row.category = "reminder".into();
        row.memory_kind = "reminder".into();
        row.reminder_status = "scheduled".into();
        row.remind_at = timestamp.into();
        row.reminder_key = key;
        row.created_at = now.into();
        row.source_timestamp = now.into();
        row.stored_by = context.agent_id.to_string();
        row.workspace_key = workspace;
        row.importance = serde_json::Number::from_f64(0.9).ok_or(StoreError::InvalidInput)?;
        row.memory_class = "working".into();
        row.confirmed = true;
        row.half_life_days = 30.into();
        // This writer omits an explicit capture trust decision in Node; the last-line store default is untrusted.
        row.epistemic_status = "untrusted".into();
        if let Some(replay) = &mut replay {
            replay.journal.plan_reminder(
                replay.position,
                ReminderEffect {
                    row: row.clone(),
                    create: true,
                },
                cancel,
            )?;
            replay.journal.check(cancel)?;
        }
        lease.check(&locks)?;
        directory.assert_unchanged()?;
        cancel.check()?;
        store.upsert(std::slice::from_ref(&row))?;
        Ok(ReminderCapture::Stored {
            row: Box::new(row),
            created: true,
        })
    }
}
/// Node hashes its original UTF-16 text through UTF-8 replacement; F3 visible cuts do not alter the key oracle.
#[must_use]
pub fn reminder_key(agent: &str, workspace: &str, text: &JsString, timestamp: i64) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            format!("{workspace}:{agent}:{}:{timestamp}", text.to_utf8_lossy()).as_bytes()
        )
    )[..32]
        .to_owned()
}

fn validate_receipt(
    row: &MemoryRow,
    ctx: &RequestContext,
    workspace: &str,
    key: &str,
    text: &str,
    timestamp: i64,
) -> Result<(), StoreError> {
    if row.id.len() != 36
        || uuid::Uuid::parse_str(&row.id).is_err()
        || row.stored_by != ctx.agent_id.as_str()
        || row.scope != "agent-private"
        || !row.owner_user_id.is_empty()
        || !row.workspace_id.is_empty()
        || (!row.agent_id.is_empty() && row.agent_id != ctx.agent_id.as_str())
        || row.workspace_key != workspace
        || row.reminder_key != key
        || row.text != text
        || row.remind_at.as_f64() != Some(timestamp as f64)
        || row.memory_kind != "reminder"
        || row.epistemic_status == "invalidated"
    {
        return Err(StoreError::Corrupt);
    }
    Ok(())
}
fn validate_replay_row(expected: &MemoryRow, current: &MemoryRow) -> Result<(), StoreError> {
    let mut stable = current.clone();
    // Only actual reminder lifecycle fields may evolve after the prepared effect.
    // Body, vector, authority, provenance and scheduled time remain exact.
    if matches!(
        current.reminder_status.as_str(),
        "scheduled" | "dispatched" | "acknowledged" | "cancelled"
    ) {
        stable.reminder_status = expected.reminder_status.clone();
        stable.reminded_at = expected.reminded_at.clone();
        stable.dispatched_at = expected.dispatched_at.clone();
        stable.acknowledged_at = expected.acknowledged_at.clone();
        stable.cancelled_at = expected.cancelled_at.clone();
        stable.dispatch_count = expected.dispatch_count.clone();
        stable.last_dispatch_attempt_at = expected.last_dispatch_attempt_at.clone();
        stable.next_dispatch_attempt_at = expected.next_dispatch_attempt_at.clone();
    }
    if matches!(
        current.status.as_str(),
        "archived" | "deleted" | "superseded"
    ) {
        stable.status = expected.status.clone();
    }
    if super::admission::row_digest(&stable)? != super::admission::row_digest(expected)? {
        return Err(StoreError::Corrupt);
    }
    Ok(())
}
