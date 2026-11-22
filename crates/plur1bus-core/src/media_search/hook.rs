//! Bounded stored/uploaded media work with explicit host-driven completion.

use super::{
    caption::{Caption, Request, Source},
    index::{Encoded, Index, Outcome, State, Ticket},
    Caller, Error, Kind, Scope,
};
use serde::Serialize;
use std::collections::{BTreeMap, VecDeque};

/// Source storage event, used to choose trusted prompt evidence.
#[derive(Clone, Copy)]
pub enum Event {
    /// Generated or edited in the media store.
    Stored,
    /// Uploaded by the user.
    Uploaded,
}

/// Record metadata. The source itself stays in the authenticated media store.
pub struct Record {
    /// Stable media identifier.
    pub id: String,
    /// Media kind.
    pub kind: Kind,
    /// Recorded content type.
    pub mime: String,
    /// Optional generation or editing prompt.
    pub prompt: Option<String>,
    /// Optional uploaded user caption.
    pub user_caption: Option<String>,
}

/// Work receipt returned to the trusted scheduler.
pub struct Work {
    /// Queue-generated sequence in this scope.
    pub sequence: u64,
    /// Immutable request metadata.
    pub record: Record,
    /// Whether the index supports this modality.
    pub encode: bool,
}
impl Work {
    /// Prepare prompt or alt text and bind all file reads to the stored record.
    pub fn request(&self) -> Request<'_> {
        Request {
            kind: self.record.kind,
            mime: &self.record.mime,
            source: Source::Stored(&self.record.id),
            prompt: self.record.prompt.as_deref(),
            user_caption: self.record.user_caption.as_deref(),
        }
    }
}

/// Safe failure stage, shared with the TypeScript event.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    /// Caption preparation.
    Caption,
    /// Encoding or storing.
    Index,
    /// Forget operation.
    Remove,
}

/// Content-free telemetry slot.
pub trait Notices {
    /// Indexing failure with stable metadata only.
    fn failed(&self, scope: &Scope, id: &str, stage: Stage, reason: &'static str);
}

/// Output from one started work receipt.
pub struct Finished {
    /// Encoded vectors or a classified failure.
    pub encoding: Result<Encoded, Error>,
    /// Optional caption provenance or a caption failure.
    pub caption: Result<Option<Caption>, Error>,
}

/// Record-only queue guarded by live rights and committed through the reference index.
pub struct Hook {
    scope: Scope,
    owner: String,
    index: Index,
    queue: VecDeque<Record>,
    active: BTreeMap<u64, Active>,
    next: u64,
    concurrency: usize,
    timeout_ms: u64,
}
struct Active {
    ticket: Ticket,
    id: String,
    deadline: u64,
}
const MAX_CONCURRENCY: usize = 32;
const MAX_QUEUED: usize = 256;
const MAX_METADATA: usize = 64 * 1024;
const MAX_TIMEOUT: u64 = 15 * 60_000;
const ACTION: &str = "media.write";

impl Hook {
    /// Bind one durable-index scope, concurrency and timeout to a trusted owner.
    pub fn new(
        scope: Scope,
        owner: String,
        index: Index,
        concurrency: usize,
        timeout_ms: u64,
    ) -> Result<Self, Error> {
        if owner.is_empty()
            || scope.workspace.is_empty()
            || scope.agent_id.is_empty()
            || !(1..=MAX_CONCURRENCY).contains(&concurrency)
            || !(1..=MAX_TIMEOUT).contains(&timeout_ms)
        {
            return Err(Error::new("E_INVALID_PARAMS", "media-queue-options"));
        }
        Ok(Self {
            scope,
            owner,
            index,
            queue: VecDeque::new(),
            active: BTreeMap::new(),
            next: 0,
            concurrency,
            timeout_ms,
        })
    }

    /// Enqueue a stored or uploaded record.
    pub fn enqueue(
        &mut self,
        caller: &Caller<'_>,
        mut record: Record,
        event: Event,
        enabled: bool,
    ) -> Result<bool, Error> {
        self.check(caller)?;
        if !enabled {
            return Ok(false);
        }
        if record.id.is_empty()
            || record.id.len() > 100
            || !record
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || record.mime.is_empty()
            || record.mime.len() > 100
            || record.mime.chars().any(char::is_control)
            || [&record.user_caption, &record.prompt]
                .into_iter()
                .flatten()
                .any(|text| text.len() > MAX_METADATA)
        {
            return Err(Error::new("E_INVALID_PARAMS", "media-record"));
        }
        if self.queue.len() >= MAX_QUEUED {
            return Err(unavailable("media-queue-capacity"));
        }
        if self.queue.iter().any(|queued| queued.id == record.id)
            || self.active.values().any(|work| work.id == record.id)
        {
            return Err(unavailable("media-record-already-queued"));
        }
        if matches!(event, Event::Uploaded) {
            record.prompt = None;
        }
        self.queue.push_back(record);
        Ok(true)
    }

    /// Hand the next bounded work record to the caller.
    pub fn next(
        &mut self,
        caller: &Caller<'_>,
        enabled: bool,
        notice: &dyn Notices,
    ) -> Result<Option<Work>, Error> {
        self.check(caller)?;
        let now = caller.authority.now();
        self.expire(now, notice);
        if !enabled || self.active.len() >= self.concurrency {
            return Ok(None);
        }
        let Some(record) = self.queue.pop_front() else {
            return Ok(None);
        };
        self.next = self
            .next
            .checked_add(1)
            .ok_or_else(|| unavailable("media-queue-revision"))?;
        let ticket = match self.index.begin(caller, &record.id, record.kind) {
            Ok(ticket) => ticket,
            Err(error) => {
                notice.failed(&self.scope, &record.id, Stage::Index, "work-refused");
                return Err(error);
            }
        };
        let active = Active {
            ticket,
            id: record.id.clone(),
            deadline: now.saturating_add(self.timeout_ms),
        };
        self.active.insert(self.next, active);
        Ok(Some(Work {
            sequence: self.next,
            encode: self.index.supports(record.kind),
            record,
        }))
    }

    /// Publish one completion if the receipt is still current.
    pub fn finish(
        &mut self,
        caller: &Caller<'_>,
        sequence: u64,
        enabled: bool,
        result: Finished,
        notice: &dyn Notices,
    ) -> Result<Option<Outcome>, Error> {
        self.bound(caller)?;
        self.expire(caller.authority.now(), notice);
        let checked = caller.authorize(ACTION);
        let Some(work) = self.active.remove(&sequence) else {
            checked?;
            return Ok(None);
        };
        if checked.is_err() || !enabled {
            self.index.cancel(&work.ticket);
            checked?;
            return Ok(None);
        }
        let caption = match result.caption {
            Ok(caption) => caption.map(|c| c.text),
            Err(_) => {
                notice.failed(&self.scope, &work.id, Stage::Caption, "caption-failed");
                None
            }
        };
        match self
            .index
            .finish(caller, work.ticket, result.encoding, caption)
        {
            Ok(outcome) => {
                if outcome.state == State::Failed {
                    notice.failed(&self.scope, &work.id, Stage::Index, "encoding-failed");
                }
                Ok(Some(outcome))
            }
            Err(error) => {
                notice.failed(&self.scope, &work.id, Stage::Index, "index-save-failed");
                Err(error)
            }
        }
    }

    /// Forget live and queued work for the scoped stored record.
    pub fn delete(
        &mut self,
        caller: &Caller<'_>,
        id: &str,
        notice: &dyn Notices,
    ) -> Result<(), Error> {
        self.check(caller)?;
        if let Err(error) = self.index.remove(caller, id) {
            notice.failed(&self.scope, id, Stage::Remove, "remove-refused");
            return Err(error);
        }
        self.queue.retain(|record| record.id != id);
        self.active.retain(|_, work| work.id != id);
        Ok(())
    }

    /// Scoped index for ordinary reads.
    pub fn index(&self) -> &Index {
        &self.index
    }

    fn bound(&self, caller: &Caller<'_>) -> Result<(), Error> {
        if self.scope != *caller.scope || self.owner != caller.who.user_id {
            return Err(Error::new("E_DENIED", "media-queue-scope"));
        }
        Ok(())
    }
    fn check(&self, caller: &Caller<'_>) -> Result<(), Error> {
        self.bound(caller)?;
        caller.authorize(ACTION)
    }
    fn expire(&mut self, now: u64, notice: &dyn Notices) {
        for (_, work) in self.active.extract_if(.., |_, work| work.deadline <= now) {
            self.index.cancel(&work.ticket);
            notice.failed(&self.scope, &work.id, Stage::Index, "index-timeout");
        }
    }
}
fn unavailable(reason: &'static str) -> Error {
    Error::new("E_MEDIA_UNAVAILABLE", reason)
}

#[cfg(test)]
#[path = "hook_vectors.rs"]
mod vectors;
