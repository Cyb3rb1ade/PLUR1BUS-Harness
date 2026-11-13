//! Drain retained post-turn episode work under both the original caller and a live job grant.
use super::{
    lance_scope::LanceScope,
    llm::{host_model, CompleteFor},
    registry::{JobBody, JobContext, JobReport},
};
use crate::{
    capture::{
        emotion_pool::EmotionalPool,
        post_turn::{DrainOptions, PostTurnQueue},
        replay_guard::turn_key_of,
    },
    context::RequestContext,
    contract::{
        AgentId, Cancel, EngineError, HostError, JobName, JobOutcome, LlmParams, LlmPort,
        LlmResult, StoreError, TurnRecord,
    },
    neo::{episode_store::EpisodeStore, turn_batch::MessageMetadata},
    recall::knowledge::private_key,
    store::{directory::TrustedDirectory, kernel_lease},
    text::json::{parse_json, write_json},
};
use serde_json::{json, Value};
use sha2::Digest;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

const ROOT: &str = "_post-turn";

const MAX_ENTRY: usize = 512 * 1024;

pub(crate) struct PostTurnRefine {
    pub scope: Arc<LanceScope>,
    pub base: PathBuf,
    pub root: PathBuf,
    pub mood: Arc<EmotionalPool>,
    pub completion: Option<Arc<CompleteFor>>,
}

struct Narrator {
    completion: Arc<CompleteFor>,
    agent: AgentId,
    model: Option<String>,
}
impl LlmPort for Narrator {
    fn complete(&self, mut params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError> {
        if params.model.is_none() {
            params.model.clone_from(&self.model);
        }
        (self.completion)(&self.agent, &params, cancel)
    }
}

impl JobBody for PostTurnRefine {
    fn name(&self) -> JobName {
        JobName::PostTurnRefine
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let deadline = Instant::now() + Duration::from_secs(300);
        let budget = &cancel.limited_to(deadline);
        let authority = context.authority()?;
        let (principal, agent) = authority.caller();
        let _operation = self.scope.operations.enter(principal, agent)?;
        if let Some(skip) = self.scope.check(authority, budget)? {
            return Ok(skip);
        }
        let host = self.scope.operations.host_handle();
        let raw = serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?;
        let config = crate::config::effective_config(&raw).map_err(|_| StoreError::InvalidInput)?;
        if config["neo"]["enabled"] == false {
            return Ok(report(JobOutcome::Skipped, "neo_disabled"));
        }
        let request = authority.request();
        let binding = private_key(request).ok_or(StoreError::InvalidInput)?;
        let dir = match queue_directory(&self.base, &binding, false) {
            Ok(dir) => dir,
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => return Ok(JobReport::completed()),
            Err(error) => return Err(error.into()),
        };
        let lease = kernel_lease::acquire(&dir, "post-turn-enqueue", budget, &mut || {})?;
        let queue = PostTurnQueue::open(dir.path())?;
        let episodes = EpisodeStore::open(
            &self.root,
            host.clone(),
            self.scope.policy.clone(),
            self.mood.clone(),
        )?;
        let model = host_model(
            &config,
            &request.agent_id,
            "episode-extraction",
            &Value::Null,
        );
        let episodes = if let Some(completion) = &self.completion {
            episodes.with_narrative(Arc::new(Narrator {
                completion: completion.clone(),
                agent: request.agent_id.clone(),
                model,
            }))
        } else {
            episodes
        };
        let start = Instant::now();
        let drain = queue.drain(
            request.agent_id.as_str(),
            |entry| {
                budget.check()?;
                lease.check(&dir)?;
                if self.scope.check(authority, budget)?.is_some()
                    || serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)? != raw
                {
                    return Err(StoreError::Unavailable.into());
                }
                let entry: Value =
                    serde_json::from_str(&write_json(entry)).map_err(|_| StoreError::Corrupt)?;
                if entry["ownerBinding"] != binding {
                    return Err(StoreError::UntrustedPath.into());
                }
                let turn: TurnRecord = serde_json::from_value(entry["turn"].clone())
                    .map_err(|_| StoreError::Corrupt)?;
                let rebound = RequestContext::build(&turn.principal, &turn.agent, host.as_ref())?;
                if private_key(&rebound).as_deref() != Some(binding.as_str())
                    || rebound.background()
                    || rebound.origin_wire() != "user"
                    || turn.incognito
                    || turn.agent_id != request.agent_id
                    || turn_key_of(&turn)? != entry["captureKey"].as_str().unwrap_or_default()
                {
                    return Err(StoreError::UntrustedPath.into());
                }
                let metadata: Option<Vec<MessageMetadata>> =
                    serde_json::from_value(entry["messageMetadata"].clone())
                        .map_err(|_| StoreError::Corrupt)?;
                let _mutation = self.scope.operations.mutation()?;
                budget.check()?;
                if self.scope.check(authority, budget)?.is_some() {
                    return Err(StoreError::Unavailable.into());
                }
                if let Some(metadata) = metadata {
                    if !crate::neo::turn_batch::valid_metadata(&turn.messages, &metadata) {
                        return Err(StoreError::Corrupt.into());
                    }
                    episodes.process_host_messages(&turn, &rebound, &metadata, budget)?;
                } else {
                    episodes.process(&turn, &rebound, budget)?;
                }
                Ok(true)
            },
            DrainOptions::default(),
            || start.elapsed().as_millis().min(i64::MAX as u128) as i64,
        )?;
        for (key, count) in [
            ("processed", drain.processed),
            ("failed", drain.failed),
            ("dropped", drain.dropped),
            ("remaining", drain.remaining),
        ] {
            context.note_count(key, count)?;
        }
        if drain.locked == Some(true) {
            return Ok(report(JobOutcome::Skipped, "already-running"));
        }
        if drain.failed > 0 || drain.remaining > 0 {
            return Ok(report(JobOutcome::Incomplete, "post_turn_pending"));
        }
        Ok(JobReport::completed())
    }
}

pub(crate) fn enqueue(
    base: &Path,
    turn: &TurnRecord,
    request: &RequestContext,
    metadata: Option<&[MessageMetadata]>,
    now: i64,
    cancel: &Cancel,
) -> Result<bool, EngineError> {
    if turn.incognito || request.background() || request.origin_wire() != "user" {
        return Ok(false);
    }
    let Some(binding) = private_key(request) else {
        return Ok(false);
    };
    let key = turn_key_of(turn)?;
    let now = metadata
        .and_then(|items| items.iter().rev().find_map(|item| item.timestamp_ms))
        .filter(|time| *time >= 0 && *time <= now)
        .unwrap_or(now);
    let payload = serde_json::to_string(&json!({
        "ownerBinding":binding,"captureKey":key,"turn":turn,"messageMetadata":metadata,
    }))
    .map_err(|_| StoreError::InvalidInput)?;
    if payload.len() > MAX_ENTRY {
        return Ok(false);
    }
    let directory = queue_directory(base, &binding, true)?;
    let lease = kernel_lease::acquire(&directory, "post-turn-enqueue", cancel, &mut || {})?;
    let queue = PostTurnQueue::open(directory.path())?;
    let hash = sha2::Sha256::digest(key.as_bytes());
    let mut id = [0u8; 16];
    id.copy_from_slice(&hash[..16]);
    lease.check(&directory)?;
    queue.enqueue_with_id(
        request.agent_id.as_str(),
        parse_json(&payload).map_err(|_| StoreError::InvalidInput)?,
        now,
        uuid::Uuid::from_bytes(id),
    )?;
    Ok(true)
}

fn queue_directory(base: &Path, key: &str, create: bool) -> Result<TrustedDirectory, StoreError> {
    let base = TrustedDirectory::open(base)?;
    if create {
        base.create_child(ROOT)?.create_child(key)
    } else {
        base.open_child(ROOT)?.open_child(key)
    }
}

fn report(outcome: JobOutcome, reason: &str) -> JobReport {
    JobReport {
        outcome,
        reason: Some(reason.into()),
    }
}
