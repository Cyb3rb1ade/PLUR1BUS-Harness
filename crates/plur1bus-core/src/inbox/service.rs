//! `createInboxService` (`inbox/service.ts`): the port producers write to and the person-facing operations. Every producer call
//! is best effort: an inbox failure is logged and never reaches the module that announced the event.
use super::{
    Ids, InboxCounts, InboxDraft, InboxError, InboxListQuery, InboxPage, InboxRef, InboxStore,
    Params, INBOX_KINDS,
};
use serde_json::{json, Value};

/// `InboxTarget`: one person, or everyone who is an owner or admin at the time of the call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InboxTarget {
    /// `{ userId }`.
    User(String),
    /// `{ audience: "admins" }`.
    Admins,
}

/// `SettleTarget`: a target, or everyone who has the entry (when the producer does not know whose it was).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SettleTarget {
    /// One person.
    User(String),
    /// The owners and admins.
    Admins,
    /// `{ audience: "all" }`.
    All,
}

/// `InboxNotice`: a draft for a target.
#[derive(Clone, Debug, PartialEq)]
pub struct InboxNotice {
    /// Who gets it.
    pub target: InboxTarget,
    /// One of the eight kinds.
    pub kind: String,
    /// `info`, `warning` or `critical`.
    pub severity: String,
    /// The i18n key.
    pub title_key: String,
    /// The placeholders.
    pub params: Option<Params>,
    /// Where it leads.
    pub reference: Option<InboxRef>,
    /// The dedupe key.
    pub dedupe_key: String,
}

/// What a source module is given: one call to publish, one to close the entry again. Both never fail.
pub trait InboxPort {
    /// `publish(n, options?)`: `cooldown_ms` is `options.cooldownMs`.
    fn publish(&mut self, n: &InboxNotice, cooldown_ms: Option<f64>);
    /// `settle(target, dedupeKey)`.
    fn settle(&mut self, target: &SettleTarget, dedupe_key: &str);
}

/// `InboxChange`: what a listener is told after a write committed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboxChange {
    /// The person.
    pub user_id: String,
    /// `created`, `read`, `dismissed` or `settled`.
    pub change: &'static str,
    /// The kinds touched.
    pub kinds: Vec<String>,
}

/// The change listener: an error is logged, never undoes the write.
pub type ChangeListener = Box<dyn FnMut(&InboxChange) -> Result<(), String>>;
/// The metric listener: one tick per created entry; an error is ignored.
pub type PublishedListener = Box<dyn FnMut(&str) -> Result<(), String>>;
/// The log sink (`message`, `fields`).
pub type LogSink = Box<dyn FnMut(&str, Value)>;

/// `InboxServiceOptions`.
pub struct InboxServiceOptions {
    /// The store.
    pub store: InboxStore,
    /// Owners and admins at the time of the call: the recipients of installation-wide kinds.
    pub admins: Box<dyn Fn() -> Vec<String>>,
    /// After the write committed. An error never undoes it.
    pub on_change: Option<ChangeListener>,
    /// One tick per created entry; the kind is the only label. An error is ignored.
    pub on_published: Option<PublishedListener>,
    /// The log sink (`message`, `fields`).
    pub log: Option<LogSink>,
}

/// The inbox service.
pub struct InboxService {
    o: InboxServiceOptions,
}

fn unique(v: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for x in v {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

impl InboxService {
    /// `createInboxService(options)`.
    pub fn new(o: InboxServiceOptions) -> Self {
        Self { o }
    }

    fn log(&mut self, message: &str, fields: Value) {
        if let Some(l) = &mut self.o.log {
            l(message, fields);
        }
    }

    fn emit(&mut self, c: &InboxChange) {
        let failed = match &mut self.o.on_change {
            Some(f) => f(c).err(),
            None => None,
        };
        if let Some(error) = failed {
            self.log("inbox change listener failed", json!({ "error": error }));
        }
    }

    fn admins(&self) -> Vec<String> {
        unique((self.o.admins)())
    }

    fn users(&self, t: &InboxTarget) -> Vec<String> {
        match t {
            InboxTarget::User(u) => vec![u.clone()],
            InboxTarget::Admins => self.admins(),
        }
    }

    fn publish_all(&mut self, n: &InboxNotice, cooldown: Option<f64>) -> Result<(), InboxError> {
        for user_id in self.users(&n.target) {
            let draft = InboxDraft {
                user_id: user_id.clone(),
                kind: n.kind.clone(),
                severity: n.severity.clone(),
                title_key: n.title_key.clone(),
                params: n.params.clone(),
                reference: n.reference.clone(),
                dedupe_key: n.dedupe_key.clone(),
            };
            let r = match cooldown {
                Some(c) => self.o.store.publish_rate_limited(&draft, c)?,
                None => self.o.store.publish(&draft)?,
            };
            if !r.created {
                continue;
            }
            if let Some(f) = &mut self.o.on_published {
                let _ = f(&n.kind);
            }
            self.emit(&InboxChange {
                user_id,
                change: "created",
                kinds: vec![n.kind.clone()],
            });
        }
        Ok(())
    }

    fn settle_all(&mut self, target: &SettleTarget, key: &str) -> Result<(), InboxError> {
        let kind = key.split(':').next().unwrap_or_default();
        let kinds: Vec<String> = if INBOX_KINDS.contains(&kind) {
            vec![kind.to_owned()]
        } else {
            Vec::new()
        };
        let closed = match target {
            SettleTarget::All => self.o.store.settle_everywhere(key)?,
            other => {
                let users = match other {
                    SettleTarget::User(u) => vec![u.clone()],
                    _ => self.admins(),
                };
                let mut closed = Vec::new();
                for u in users {
                    if self.o.store.settle(&u, key)? {
                        closed.push(u);
                    }
                }
                closed
            }
        };
        for user_id in unique(closed) {
            self.emit(&InboxChange {
                user_id,
                change: "settled",
                kinds: kinds.clone(),
            });
        }
        Ok(())
    }

    /// `list`.
    pub fn list(&self, user_id: &str, q: &InboxListQuery) -> Result<InboxPage, InboxError> {
        self.o.store.list(user_id, q)
    }

    /// `count`.
    pub fn count(&self, user_id: &str) -> Result<InboxCounts, InboxError> {
        self.o.store.count(user_id)
    }

    /// `markRead`: how many changed; listeners hear of the kinds that were unread.
    pub fn mark_read(&mut self, user_id: &str, ids: Ids<'_>) -> Result<i64, InboxError> {
        let kinds = self.o.store.kinds_of(user_id, ids, true)?;
        let changed = self.o.store.mark_read(user_id, ids)?;
        if changed > 0 {
            self.emit(&InboxChange {
                user_id: user_id.to_owned(),
                change: "read",
                kinds,
            });
        }
        Ok(changed)
    }

    /// `dismiss`: how many changed; listeners hear of the kinds that were open.
    pub fn dismiss(&mut self, user_id: &str, ids: Ids<'_>) -> Result<i64, InboxError> {
        let kinds = self.o.store.kinds_of(user_id, ids, false)?;
        let changed = self.o.store.dismiss(user_id, ids)?;
        if changed > 0 {
            self.emit(&InboxChange {
                user_id: user_id.to_owned(),
                change: "dismissed",
                kinds,
            });
        }
        Ok(changed)
    }
}

impl InboxPort for InboxService {
    fn publish(&mut self, n: &InboxNotice, cooldown_ms: Option<f64>) {
        if let Err(e) = self.publish_all(n, cooldown_ms) {
            self.log(
                "inbox publish failed",
                json!({ "kind": n.kind, "error": e.to_string() }),
            );
        }
    }

    fn settle(&mut self, target: &SettleTarget, dedupe_key: &str) {
        if let Err(e) = self.settle_all(target, dedupe_key) {
            self.log("inbox settle failed", json!({ "error": e.to_string() }));
        }
    }
}
