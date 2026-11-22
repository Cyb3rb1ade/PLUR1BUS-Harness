//! Claim, rights revalidation and execution of bounded dreaming work through ports.

use super::promotion::{self, Prepared};
use super::scheduler::{phase_defaults, plan, planned_jobs, sync_agents, Job, Settings};
use super::store::{DreamStore, ObservedCorpus};
use super::types::{Breaker, DreamRun, FinishRun, NewRun, Outcome, Phase, SchedulePatch, Trigger};
use crate::budget::{Clock, IdSource};
use crate::collab::{CollabError, CollabErrorCode as C};
use crate::logs::methods::AbortSignal;
use crate::rbac::audit::{AuditEvent, AuditSink};
use crate::rbac::authorize::authorize;
use crate::rbac::types::{AuthorizeContext, MemoryAgentScope, Principal, PrincipalKind, Resource};
use serde_json::json;

type R<T> = Result<T, CollabError>;

/// Outcome reported by the engine job port.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum JobOutcome {
    /// Job completed.
    Completed,
    /// The job could not apply its intended effect.
    Skipped,
    /// A job failure.
    Failed,
    /// Job reported an incomplete result.
    Incomplete,
    /// Job abandoned by its worker.
    Abandoned,
}

/// Observed result of a job. Native adapters supply redacted reason strings.
pub struct JobReceipt {
    /// Terminal job outcome.
    pub outcome: JobOutcome,
    /// Optional machine-readable job reason.
    pub reason: Option<String>,
    /// Input usage if measured.
    pub tokens_in: Option<i64>,
    /// Output usage if measured.
    pub tokens_out: Option<i64>,
    /// Whether a required diary write was observed.
    pub diary_written: Option<bool>,
}

/// Trusted identity and job catalog for the runner.
pub trait DreamJobs {
    /// Whether the agent is presently registered.
    fn active_agent(&self, agent: &str) -> bool;
    /// Resolve the current rights for the authenticated person.
    fn current_person(&self, user_id: &str) -> Option<Principal>;
    /// Current job list.
    fn available(&self) -> Vec<Job>;
    /// Whether a model job may use the current route.
    fn has_model_route(&self, agent: &str) -> bool;
    /// Run one admitted job with the trusted phase and due identity.
    fn execute(&mut self, job: &Job, context: &JobContext<'_>) -> R<JobReceipt>;
}

/// Effect context passed to the job port.
pub struct JobContext<'a> {
    /// Authorized agent name.
    pub agent: &'a str,
    /// Phase selected by admission.
    pub phase: Phase,
    /// Native due identity, when configured.
    pub due_id: Option<&'a str>,
    /// Shared caller cancellation.
    pub abort: &'a AbortSignal,
}

/// Operation certified by the calling scheduler or RPC dispatcher.
pub struct RunRequest<'a> {
    /// Live responsible person.
    pub who: &'a Principal,
    /// Agent to run.
    pub agent: &'a str,
    /// Phase to execute.
    pub phase: Phase,
    /// Source of the request.
    pub trigger: Trigger,
    /// The configured slot, for a scheduled request.
    pub scheduled_for: Option<i64>,
    /// Operation cancellation.
    pub abort: &'a AbortSignal,
}

/// The runtime inputs that cannot be fabricated by a model or terminal result.
pub struct Ports<'a> {
    /// Host clock.
    pub clock: &'a dyn Clock,
    /// Fresh run identifiers.
    pub ids: &'a dyn IdSource,
    /// Job list, liveness and execution port.
    pub jobs: &'a mut dyn DreamJobs,
    /// Audit sink for privileged work.
    pub audit: &'a mut dyn AuditSink,
    /// Defaults for newly encountered agents.
    pub settings: &'a Settings,
    /// Model-session cap per day across REM and deep runs.
    pub breaker_sessions: i64,
    /// Whether execution requires confirmation of a diary write.
    pub require_diary: bool,
    /// Whether the host understands opaque due identities.
    pub native_dues: bool,
    /// Agent-private shortlist and integration port.
    pub candidates: Option<&'a mut dyn promotion::CandidateSource>,
}

const DAY_MS: i64 = 86_400_000;
const SWEEP: &[Phase] = &[Phase::Rem, Phase::Deep];

fn authorized(person: &Principal, agent: &str, at: i64) -> bool {
    person.kind == Some(PrincipalKind::Person)
        && super::can_run_jobs(person, at)
        && authorize(
            Some(person),
            "agent.use",
            &Resource::Agent {
                agent_id: agent.to_owned(),
            },
            &AuthorizeContext {
                now: Some(at as f64),
            },
        )
        .is_allow()
}

fn current(request: &RunRequest<'_>, ports: &Ports<'_>, at: i64) -> bool {
    ports.jobs.active_agent(request.agent)
        && ports
            .jobs
            .current_person(&request.who.user_id)
            .is_some_and(|person| {
                person.user_id == request.who.user_id && authorized(&person, request.agent, at)
            })
}

fn memory_access(
    request: &RunRequest<'_>,
    jobs: &dyn DreamJobs,
    now: i64,
    scope: MemoryAgentScope,
    action: &str,
) -> bool {
    let resource = Resource::MemoryAgent {
        scope,
        agent_id: request.agent.into(),
    };
    let context = AuthorizeContext {
        now: Some(now as f64),
    };
    let allows = |person: &Principal| {
        person.user_id == request.who.user_id
            && authorized(person, request.agent, now)
            && authorize(Some(person), action, &resource, &context).is_allow()
    };
    jobs.active_agent(request.agent)
        && allows(request.who)
        && jobs
            .current_person(&request.who.user_id)
            .is_some_and(|person| allows(&person))
}

fn valid_agent_id(agent: &str) -> bool {
    let bytes = agent.as_bytes();
    let head = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    bytes.len() <= 64
        && bytes.first().is_some_and(|&b| head(b))
        && bytes.iter().all(|&b| head(b) || matches!(b, b'_' | b'-'))
}

fn disposition(mut result: FinishRun, outcome: Outcome, reason: Option<String>) -> FinishRun {
    result.outcome = Some(outcome);
    result.reason = reason;
    result
}

fn refusal(outcome: Outcome, reason: &str) -> FinishRun {
    disposition(FinishRun::default(), outcome, Some(reason.to_owned()))
}

fn track_usage(result: &mut FinishRun, receipt: &JobReceipt) {
    if receipt.tokens_in.is_some() || receipt.tokens_out.is_some() {
        result.tokens_in = Some(
            result
                .tokens_in
                .unwrap_or(0)
                .saturating_add(receipt.tokens_in.unwrap_or(0).max(0)),
        );
        result.tokens_out = Some(
            result
                .tokens_out
                .unwrap_or(0)
                .saturating_add(receipt.tokens_out.unwrap_or(0).max(0)),
        );
    }
}

fn trip_breaker(store: &DreamStore, agent: &str, day: i64) -> R<()> {
    for &phase in SWEEP {
        store.update_schedule(
            agent,
            phase,
            SchedulePatch {
                breaker_state: Some(Breaker::Open),
                breaker_until: Some(Some(day.saturating_add(DAY_MS))),
                breaker_reason: Some(Some("breaker_sessions".to_owned())),
                ..SchedulePatch::default()
            },
        )?;
    }
    Ok(())
}

fn execute_jobs(
    store: &DreamStore,
    request: &RunRequest<'_>,
    ports: &mut Ports<'_>,
    jobs: &[Job],
    due_id: Option<&str>,
    run_id: &str,
) -> R<FinishRun> {
    let mut result = FinishRun::default();
    let at = ports.clock.now();
    let private = |jobs: &dyn DreamJobs, at| {
        memory_access(
            request,
            jobs,
            at,
            MemoryAgentScope::AgentPrivate,
            "memory.agent-private.read",
        )
    };
    let observed_candidates =
        if request.phase != Phase::Rem && !request.abort.is_aborted() && private(ports.jobs, at) {
            match ports.candidates.as_deref_mut() {
                Some(port) => port.pull(request.agent, request.abort).and_then(|batch| {
                    let now = ports.clock.now();
                    if request.abort.is_aborted() || !private(ports.jobs, now) {
                        return Err(CollabError::new(
                            C::Unauthorized,
                            "dreaming shortlist authority changed",
                        ));
                    }
                    let workspace = memory_access(
                        request,
                        ports.jobs,
                        now,
                        MemoryAgentScope::Workspace,
                        "memory.workspace.read",
                    );
                    promotion::observe(
                        store,
                        request.agent,
                        run_id,
                        at,
                        ports.ids,
                        &batch,
                        workspace,
                    )
                }),
                None => Ok(Prepared::default()),
            }
        } else {
            Ok(Prepared::default())
        };
    if let Ok(stats) = &observed_candidates {
        result.counts.extend(stats.counts.clone());
    }
    let mut observed = Vec::new();
    let mut sessions = 0_i64;
    result
        .counts
        .extend([("jobs".to_owned(), 0.0), ("llmSessions".to_owned(), 0.0)]);
    let context = JobContext {
        agent: request.agent,
        phase: request.phase,
        due_id,
        abort: request.abort,
    };
    for job in jobs {
        let now = ports.clock.now();
        if request.abort.is_aborted() {
            return Ok(disposition(
                result,
                Outcome::Aborted,
                Some("cancelled".to_owned()),
            ));
        }
        if !current(request, ports, now) {
            return Ok(disposition(
                result,
                Outcome::Aborted,
                Some("rights-changed".to_owned()),
            ));
        }
        let consumes_session = job.needs_llm && request.phase != Phase::Light;
        if job.needs_llm && !ports.jobs.has_model_route(request.agent) {
            return Ok(disposition(
                result,
                Outcome::Skipped,
                Some("no_llm_route".to_owned()),
            ));
        }
        if consumes_session {
            let day = now.div_euclid(DAY_MS) * DAY_MS;
            if !store.reserve_model_session(run_id, request.agent, day, ports.breaker_sessions)? {
                trip_breaker(store, request.agent, day)?;
                return Ok(disposition(
                    result,
                    Outcome::Aborted,
                    Some("breaker_sessions".into()),
                ));
            }
            sessions += 1;
            result.counts.insert("llmSessions".into(), sessions as f64);
        }
        let receipt = match ports.jobs.execute(job, &context) {
            Ok(receipt) => receipt,
            Err(_) => {
                return Ok(disposition(
                    result,
                    Outcome::Failed,
                    Some("engine_error".to_owned()),
                ))
            }
        };
        if consumes_session && receipt.outcome == JobOutcome::Skipped {
            store.release_skipped_session(run_id)?;
            sessions -= 1;
            result.counts.insert("llmSessions".into(), sessions as f64);
        }
        track_usage(&mut result, &receipt);
        result
            .counts
            .insert("jobs".to_owned(), (observed.len() + 1) as f64);
        if request.abort.is_aborted() {
            return Ok(disposition(
                result,
                Outcome::Aborted,
                Some("cancelled".to_owned()),
            ));
        }
        match receipt.outcome {
            JobOutcome::Failed => {
                let reason = receipt.reason.unwrap_or_else(|| "engine_error".to_owned());
                return Ok(disposition(result, Outcome::Failed, Some(reason)));
            }
            outcome @ (JobOutcome::Incomplete | JobOutcome::Abandoned) => {
                let fallback = if outcome == JobOutcome::Incomplete {
                    "incomplete"
                } else {
                    "abandoned"
                };
                let reason = receipt.reason.as_deref().unwrap_or(fallback);
                return Ok(disposition(
                    result,
                    Outcome::Failed,
                    Some(format!("incomplete:{reason}")),
                ));
            }
            _ => observed.push((job.name.as_str(), receipt)),
        }
    }

    if !current(request, ports, ports.clock.now()) {
        return Ok(disposition(
            result,
            Outcome::Aborted,
            Some("rights-changed".to_owned()),
        ));
    }
    let candidates = match observed_candidates {
        Ok(candidates) => candidates,
        Err(error) => {
            return Ok(disposition(
                result,
                if error.code == C::Unauthorized {
                    Outcome::Aborted
                } else {
                    Outcome::Failed
                },
                Some(
                    if error.code == C::Unauthorized {
                        "rights-changed"
                    } else {
                        "engine_error"
                    }
                    .into(),
                ),
            ))
        }
    };
    let primary = phase_defaults(request.phase).primary;
    let main = observed
        .iter()
        .find(|(name, _)| *name == primary)
        .or_else(|| observed.first());
    if let Some((_, receipt)) = main.filter(|(_, run)| run.outcome == JobOutcome::Skipped) {
        let reason = receipt.reason.as_deref().unwrap_or("skipped");
        let reason = if reason.starts_with("no_llm") {
            "no_llm_route"
        } else {
            reason
        };
        return Ok(disposition(
            result,
            Outcome::Skipped,
            Some(reason.to_owned()),
        ));
    }

    if observed
        .iter()
        .any(|(_, run)| run.diary_written == Some(false))
        || (ports.require_diary
            && !observed
                .iter()
                .any(|(_, run)| run.diary_written == Some(true)))
    {
        return Ok(disposition(
            result,
            Outcome::Failed,
            Some("diary_not_written".to_owned()),
        ));
    }
    if request.phase == Phase::Deep {
        result.counts.insert("promoted".to_owned(), 0.0);
        if let Some(port) = ports.candidates.as_deref_mut() {
            let jobs = &*ports.jobs;
            let clock = ports.clock;
            let check = || {
                if request.abort.is_aborted() {
                    return Err(CollabError::with_reason(
                        C::Aborted,
                        "dreaming cancelled",
                        "cancelled",
                    ));
                }
                let at = clock.now();
                if !private(jobs, at)
                    || !memory_access(
                        request,
                        jobs,
                        at,
                        MemoryAgentScope::AgentPrivate,
                        "memory.agent-private.write",
                    )
                {
                    return Err(CollabError::with_reason(
                        C::Unauthorized,
                        "dreaming promotion authority changed",
                        "rights-changed",
                    ));
                }
                Ok(())
            };
            match promotion::integrate(
                store,
                request.agent,
                candidates,
                port,
                request.abort,
                clock,
                check,
            ) {
                Ok(counts) => result.counts.extend(counts),
                Err(error) if matches!(error.code, C::Unauthorized | C::Aborted) => {
                    let reason = if error.code == C::Aborted {
                        "cancelled"
                    } else {
                        "rights-changed"
                    };
                    return Ok(disposition(result, Outcome::Aborted, Some(reason.into())));
                }
                Err(_) => {
                    return Ok(disposition(
                        result,
                        Outcome::Failed,
                        Some("engine_error".into()),
                    ))
                }
            }
        }
    }
    Ok(disposition(result, Outcome::Completed, None))
}

/// Run one phase through the current trusted ports.
pub fn run_phase(
    store: &DreamStore,
    request: &RunRequest<'_>,
    ports: &mut Ports<'_>,
) -> R<DreamRun> {
    let at = ports.clock.now();
    if at < 0
        || !valid_agent_id(request.agent)
        || !authorized(request.who, request.agent, at)
        || !current(request, ports, at)
    {
        return Err(CollabError::new(
            C::Unauthorized,
            "dreaming agent authority is unavailable",
        ));
    }
    sync_agents(store, &[request.agent], ports.settings, at)?;
    let schedule = store
        .schedule(request.agent, request.phase)?
        .ok_or_else(|| CollabError::new(C::NotFound, "dreaming schedule is missing"))?;
    let jobs = ports.jobs.available();
    let plan = plan(store, request.agent, request.phase, at, &jobs)?;
    let jobs = planned_jobs(request.phase, &jobs);
    let id = ports.ids.next_id();
    let key = plan.idempotency_key;
    let busy = store.begin_phase(&NewRun {
        run_id: id.clone(),
        agent_id: request.agent.to_owned(),
        phase: request.phase,
        job_id: phase_defaults(request.phase).primary.to_owned(),
        partition: Some("agent-private".to_owned()),
        idempotency_key: key.clone(),
        trigger: request.trigger,
        scheduled_for: request.scheduled_for,
        started_at: at,
        log_path: None,
    })?;
    let outcome = if busy && plan.reason != Some("idempotent") {
        refusal(Outcome::Skipped, "already_running")
    } else if let Some(reason) = plan.reason {
        disposition(
            FinishRun {
                counts: plan.counts,
                ..FinishRun::default()
            },
            Outcome::Skipped,
            Some(reason.to_owned()),
        )
    } else if jobs.iter().any(|job| job.needs_llm) && !ports.jobs.has_model_route(request.agent) {
        refusal(Outcome::Skipped, "no_llm_route")
    } else if !store.claim_key(&id, &key)? {
        refusal(Outcome::Skipped, "idempotent")
    } else {
        let event = AuditEvent {
            at,
            user: request.who.user_id.clone(),
            host: String::new(),
            action: "dreams.run".to_owned(),
            target: request.agent.to_owned(),
            detail: vec![
                ("phase".to_owned(), json!(request.phase)),
                ("runId".to_owned(), json!(id)),
            ],
        };
        if ports.audit.append(&event).is_err() {
            refusal(Outcome::Failed, "audit_unavailable")
        } else {
            let due = (ports.native_dues && request.trigger != Trigger::Manual).then(|| {
                request
                    .scheduled_for
                    .map_or_else(|| key.clone(), |when| format!("due:{when}"))
            });
            match execute_jobs(store, request, ports, &jobs, due.as_deref(), &id) {
                Ok(result) => result,
                Err(_) => refusal(Outcome::Failed, "engine_error"),
            }
        }
    };
    let result = FinishRun {
        finished_at: Some(ports.clock.now()),
        ..outcome
    };
    store.finish_phase(
        &id,
        &result,
        ObservedCorpus {
            captures: schedule.captures_acc,
            importance: schedule.importance_acc,
        },
    )?;
    store
        .run(&id)?
        .ok_or_else(|| CollabError::new(C::Storage, "closed dreaming run could not be read"))
}

#[cfg(test)]
#[path = "runner_vectors.rs"]
mod vectors;
