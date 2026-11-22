//! Model-free knowledge job planning and scoped dispatch.

use crate::rbac::{
    authorize::authorize,
    types::{AuthorizeContext, Principal, Resource},
};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Interval between sweeps in milliseconds.
pub const INTERVAL: u64 = 900_000;
/// Lower bound on scheduling a retry after a registry fault.
pub const RETRY_BACKOFF: u64 = 30_000;

/// Trigger metadata carried into the dispatch port.
#[derive(Clone, Copy)]
pub enum Trigger {
    /// User explicitly initiated the job.
    Manual,
    /// System scheduler initiated the job.
    Cron,
    /// Harness initiated the job.
    Harness,
}
impl Trigger {
    /// Existing wire name.
    pub fn name(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Cron => "cron",
            Self::Harness => "harness",
        }
    }
}

/// Current scheduler authority and dispatch port supplied by the host.
pub trait Host {
    /// Current epoch milliseconds.
    fn now(&self) -> u64;
    /// Whether this scoped cancellation is active.
    fn cancelled(&self) -> bool;
    /// Registered agent identifiers in sweep order.
    fn agents(&self) -> Vec<String>;
    /// Resolve the principal's current authority.
    fn principal(&self, user: &str) -> Option<Principal>;
    /// Exact knowledge promotion capability and advertised job availability.
    fn knowledge_promotion(&self) -> bool;
    /// Registered engine job names.
    fn jobs(&self) -> Vec<String>;
    /// Request one authorized per-agent promotion.
    fn dispatch(&self, job: &str, agent: &str, trigger: Trigger) -> Option<Receipt>;
}

/// Per-agent receipt returned by the dispatch port.
pub struct Receipt {
    /// Outcome name from the job contract.
    pub outcome: String,
    /// Stable identifier if the job ran.
    pub run_id: Option<String>,
    /// Optional diagnostic code.
    pub reason: Option<String>,
}

/// Reusable singleton interval state. The caller owns timers and the durable registry.
pub struct Schedule {
    next: AtomicU64,
    running: AtomicBool,
}

struct Active<'a>(&'a AtomicBool);
impl Drop for Active<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl Schedule {
    /// Restore the schedule relative to the latest recorded start.
    pub fn new(now: u64, last_started: Option<u64>) -> Self {
        Self {
            next: AtomicU64::new(
                now.max(last_started.map_or(now, |last| last.saturating_add(INTERVAL))),
            ),
            running: AtomicBool::new(false),
        }
    }

    /// Current due time retained by the schedule.
    pub fn next_at(&self) -> u64 {
        self.next.load(Ordering::Acquire)
    }

    /// Milliseconds until the next attempt.
    pub fn wake_delay(next: u64, now: u64, registry_fault: bool) -> u64 {
        next.saturating_sub(now)
            .max(if registry_fault { RETRY_BACKOFF } else { 0 })
    }

    /// Validate exact arguments and dispatch a sweep.
    pub fn run(
        &self,
        host: &dyn Host,
        who: &Principal,
        args: &Value,
        trigger: Trigger,
    ) -> Result<Value, &'static str> {
        let target = target_agent(host, args)?;
        if host.cancelled() {
            return Ok(json!({"outcome":"abandoned","reason":"aborted","detail":null}));
        }
        if self
            .running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(json!({"outcome":"skipped","reason":"already-running","detail":null}));
        }
        let _active = Active(&self.running);
        current(host, who).ok_or("knowledge-rights-changed")?;
        self.next
            .store(host.now().saturating_add(INTERVAL), Ordering::Release);
        if !host.knowledge_promotion() || !host.jobs().iter().any(|name| name == "knowledge-update")
        {
            return Ok(
                json!({"outcome":"skipped","reason":"engine-contract-unavailable","detail":{
                    "requiredContract":"1.18.0","requiredCapability":"knowledgePromotion"
                }}),
            );
        }
        let ids = target.map_or_else(|| host.agents(), |id| vec![id.to_owned()]);
        Ok(sweep(host, who, trigger, ids))
    }
}

fn target_agent<'a>(host: &dyn Host, raw: &'a Value) -> Result<Option<&'a str>, &'static str> {
    if raw.is_null() {
        return Ok(None);
    }
    let args = raw.as_object().ok_or("args must be an object")?;
    if args.keys().any(|key| key != "agentId") {
        return Err("unknown knowledge.update argument");
    }
    args.get("agentId")
        .map(|id| {
            id.as_str()
                .filter(|id| host.agents().iter().any(|candidate| candidate == id))
                .ok_or("unknown agent")
        })
        .transpose()
}

fn current(host: &dyn Host, who: &Principal) -> Option<Principal> {
    let live = host.principal(&who.user_id)?;
    let auth = AuthorizeContext {
        now: Some(host.now() as f64),
    };
    (live.user_id == who.user_id
        && [who, &live]
            .into_iter()
            .all(|p| authorize(Some(p), "jobs.run", &Resource::System, &auth).is_allow()))
    .then_some(live)
}

fn sweep(host: &dyn Host, who: &Principal, trigger: Trigger, ids: Vec<String>) -> Value {
    let mut results = Vec::new();
    let mut failed = false;
    for id in ids {
        if host.cancelled() {
            return json!({"outcome":"abandoned","reason":"aborted","detail":results});
        }
        if !host.agents().contains(&id) {
            continue;
        }
        let Some(live) = current(host, who) else {
            return json!({"outcome":"abandoned","reason":"knowledge-rights-changed","detail":results});
        };
        let scope = Resource::Agent {
            agent_id: id.clone(),
        };
        let auth = AuthorizeContext {
            now: Some(host.now() as f64),
        };
        if [who, &live]
            .into_iter()
            .any(|p| !authorize(Some(p), "agent.use", &scope, &auth).is_allow())
        {
            continue;
        }
        let Some(receipt) = host.dispatch("knowledge-update", &id, trigger) else {
            if host.cancelled() {
                return json!({"outcome":"abandoned","reason":"aborted","detail":results});
            }
            failed = true;
            results.push(json!({"agentId":id,"outcome":"failed","reason":"engine-job-threw"}));
            continue;
        };
        match receipt.outcome.as_str() {
            "completed" | "skipped" => {}
            "failed" | "incomplete" | "abandoned" => failed = true,
            _ => {
                return json!({"outcome":"failed","reason":"engine-job-invalid-result","detail":results})
            }
        }
        let mut result = json!({"agentId":id,"outcome":receipt.outcome});
        if let Some(run_id) = receipt.run_id.filter(|field| !field.is_empty()) {
            result["runId"] = json!(run_id);
        }
        if let Some(reason) = receipt.reason.filter(|field| !field.is_empty()) {
            result["reason"] = json!(reason);
        }
        results.push(result);
    }
    if host.cancelled() {
        return json!({"outcome":"abandoned","reason":"aborted","detail":results});
    }
    if failed {
        return json!({"outcome":"failed","reason":"engine-job-failed","detail":results});
    }
    json!({"outcome":"completed","detail":results})
}

#[cfg(test)]
#[path = "job_vectors.rs"]
mod vectors;
