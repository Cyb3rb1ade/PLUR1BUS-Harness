//! Fallback, retries and per-provider/model health for a blocking streaming adapter. The caller
//! owns the selected profile, budget state, clock, randomness and all protocol ports.

use crate::{Adapter, ErrorKind, Json, Ports, ProviderError};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

pub trait StreamAdapter {
    fn stream(&self, request: &Json, emit: &mut dyn FnMut(Value)) -> Result<(), ProviderError>;
}

pub struct BoundAdapter<'a> {
    pub adapter: &'a Adapter,
    pub ports: &'a dyn Ports,
}

impl StreamAdapter for BoundAdapter<'_> {
    fn stream(&self, request: &Json, emit: &mut dyn FnMut(Value)) -> Result<(), ProviderError> {
        self.adapter.stream(request, self.ports, emit)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Target<'a> {
    pub provider: &'a str,
    pub model: &'a str,
}

pub struct Candidate<'a> {
    pub target: Target<'a>,
    pub adapter: &'a dyn StreamAdapter,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    Closed,
    Open,
    HalfOpen,
}

#[derive(Clone, Copy, Debug)]
pub struct Policy {
    pub failure_threshold: u32,
    pub open_ms: u64,
    pub max_retries: u32,
    pub base_ms: u64,
    pub max_ms: u64,
    pub max_retry_after_ms: u64,
    pub max_attempts: u32,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            failure_threshold: 3,
            open_ms: 30_000,
            max_retries: 2,
            base_ms: 250,
            max_ms: 8_000,
            max_retry_after_ms: 15_000,
            max_attempts: 6,
        }
    }
}

pub trait AttemptBudget {
    fn settle(self: Box<Self>, usage: Option<&Value>);
}

pub trait Runtime {
    fn now_ms(&self) -> u64;
    fn sleep_ms(&self, delay: u64) -> Result<(), ProviderError>;
    fn random(&self) -> f64;
    fn cancelled(&self) -> bool {
        false
    }

    fn authorize(
        &self,
        _profile: &str,
        _target: Target<'_>,
        _attempt: u32,
        _request: &Json,
    ) -> Result<Option<Box<dyn AttemptBudget + '_>>, String> {
        Ok(None)
    }

    fn event(&self, _event: Value) {}
}

#[derive(Debug)]
pub enum RouteError {
    Provider(ProviderError),
    NoCandidate,
    BudgetDenied(String),
    AttemptsExhausted(u32),
    UnknownProfile,
    UnsupportedStrategy(String),
}

impl From<ProviderError> for RouteError {
    fn from(error: ProviderError) -> Self {
        Self::Provider(error)
    }
}

pub struct Profile<'a> {
    pub name: &'a str,
    pub candidates: &'a [Candidate<'a>],
    pub defaults: &'a Json,
    pub unsupported: Option<&'a str>,
}

struct Breaker {
    state: Health,
    consecutive: u32,
    opened_ms: u64,
    probing: bool,
    generation: u64,
}

impl Default for Breaker {
    fn default() -> Self {
        Self {
            state: Health::Closed,
            consecutive: 0,
            opened_ms: 0,
            probing: false,
            generation: 0,
        }
    }
}

impl Breaker {
    fn change(&mut self, next: Health) -> Option<(Health, Health)> {
        if self.state == next {
            return None;
        }
        let previous = self.state;
        self.state = next;
        self.generation = self.generation.wrapping_add(1);
        Some((previous, next))
    }

    fn tick(&mut self, now: u64, open_ms: u64) -> Option<(Health, Health)> {
        if self.state == Health::Open && now.saturating_sub(self.opened_ms) >= open_ms {
            self.change(Health::HalfOpen)
        } else {
            None
        }
    }
}

pub struct Router {
    policy: Policy,
    breakers: Mutex<HashMap<(String, String), Breaker>>,
}

fn abort() -> ProviderError {
    ProviderError::new(ErrorKind::Aborted, "call aborted by the caller")
}

fn transient(error: &ProviderError) -> bool {
    matches!(
        error.kind,
        ErrorKind::RateLimit | ErrorKind::Overloaded | ErrorKind::Timeout | ErrorKind::Network
    )
}

impl Router {
    pub fn new(policy: Policy) -> Self {
        Self {
            policy,
            breakers: Mutex::new(HashMap::new()),
        }
    }

    fn health<T>(&self, target: Target<'_>, operation: impl FnOnce(&mut Breaker) -> T) -> T {
        let mut breakers = self
            .breakers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        operation(
            breakers
                .entry((target.provider.into(), target.model.into()))
                .or_default(),
        )
    }

    fn emit_health(runtime: &dyn Runtime, target: Target<'_>, change: Option<(Health, Health)>) {
        if let Some((from, to)) = change {
            runtime.event(json!({"type":"provider.breaker","target":target,"from":from,"to":to}));
        }
    }

    pub fn breaker_state(&self, target: Target<'_>, runtime: &dyn Runtime) -> Health {
        let now = runtime.now_ms();
        let (state, change) = self.health(target, |breaker| {
            let change = breaker.tick(now, self.policy.open_ms);
            (breaker.state, change)
        });
        Self::emit_health(runtime, target, change);
        state
    }

    pub fn stream(
        &self,
        profile: &Profile<'_>,
        request: &Json,
        runtime: &dyn Runtime,
        emit: &mut dyn FnMut(Value),
    ) -> Result<(), RouteError> {
        if let Some(reason) = profile.unsupported {
            return Err(RouteError::UnsupportedStrategy(reason.into()));
        }
        if profile.candidates.is_empty() {
            return Err(RouteError::UnknownProfile);
        }
        let mut effective = request.clone();
        for field in ["temperature", "topP", "maxTokens"] {
            if let Some(value) = profile
                .defaults
                .get(field)
                .filter(|_| effective.get(field).is_none())
            {
                effective.set(field, value.clone());
            }
        }
        let name = profile.name;
        let mut attempts = 0;
        let mut last_error = None;
        let mut budget_denied = None;
        let mut left = None;
        for candidate in profile.candidates {
            let target = candidate.target;
            let mut retries = 0;
            loop {
                if runtime.cancelled() {
                    return Err(abort().into());
                }
                let now = runtime.now_ms();
                let (admission, change) = self.health(target, |breaker| {
                    let change = breaker.tick(now, self.policy.open_ms);
                    let allowed = match breaker.state {
                        Health::Open => Err("breaker_open"),
                        Health::HalfOpen if breaker.probing => Err("half_open_busy"),
                        Health::HalfOpen => {
                            breaker.probing = true;
                            Ok(breaker.generation)
                        }
                        Health::Closed => Ok(breaker.generation),
                    };
                    (allowed, change)
                });
                Self::emit_health(runtime, target, change);
                let generation = match admission {
                    Ok(generation) => generation,
                    Err(reason) => {
                        runtime.event(json!({"type":"provider.skipped","profile":name,"target":target,"reason":reason}));
                        left = Some((target, json!(reason)));
                        break;
                    }
                };
                if attempts >= self.policy.max_attempts {
                    self.release(target, generation);
                    return Err(RouteError::AttemptsExhausted(attempts));
                }
                let ticket = match runtime.authorize(name, target, attempts + 1, &effective) {
                    Ok(ticket) => ticket,
                    Err(reason) => {
                        self.release(target, generation);
                        if runtime.cancelled() {
                            return Err(abort().into());
                        }
                        runtime.event(json!({"type":"provider.skipped","profile":name,"target":target,"reason":"budget_denied","detail":reason}));
                        budget_denied = Some(reason);
                        left = Some((target, json!("budget_denied")));
                        break;
                    }
                };
                attempts += 1;
                if let Some((from, reason)) = left.take() {
                    runtime.event(json!({"type":"provider.fallback","profile":name,"from":from,"to":target,"reason":reason}));
                }
                let mut attempted = effective.clone();
                attempted.set("model", target.model);
                let mut committed = false;
                let mut terminal = None;
                let mut usage = None;
                let outcome = candidate.adapter.stream(&attempted, &mut |event| {
                    if !committed {
                        committed = true;
                        emit(json!({"type":"served","provider":target.provider,"model":target.model}));
                    }
                    if let Some(reported) = event.get("usage").or_else(|| event["result"].get("usage")) { usage = Some(reported.clone()); }
                    if event["type"] == "done" { terminal = Some(event); } else { emit(event); }
                });
                match outcome {
                    Ok(()) => {
                        let change = self.health(target, |breaker| {
                            if breaker.generation != generation {
                                return None;
                            }
                            breaker.consecutive = 0;
                            breaker.probing = false;
                            breaker.change(Health::Closed)
                        });
                        Self::emit_health(runtime, target, change);
                        if let Some(ticket) = ticket {
                            ticket.settle(usage.as_ref());
                        }
                        if let Some(done) = terminal {
                            emit(done);
                        }
                        return Ok(());
                    }
                    Err(error) => {
                        let error = if runtime.cancelled() { abort() } else { error };
                        let busy = error.kind == ErrorKind::Network
                            && error.code.as_deref() == Some("busy");
                        let subscription = error.code.as_deref()
                            == Some("subscription_sharing_usage_limit_exceeded");
                        let counts = transient(&error) && !busy && !subscription;
                        if counts {
                            let now = runtime.now_ms();
                            let change = self.health(target, |breaker| {
                                if breaker.generation != generation {
                                    return None;
                                }
                                breaker.probing = false;
                                breaker.consecutive = breaker.consecutive.saturating_add(1);
                                if breaker.state == Health::HalfOpen
                                    || breaker.consecutive >= self.policy.failure_threshold
                                {
                                    breaker.opened_ms = now;
                                    breaker.change(Health::Open)
                                } else {
                                    None
                                }
                            });
                            Self::emit_health(runtime, target, change);
                        } else {
                            self.release(target, generation);
                        }
                        if let Some(ticket) = ticket {
                            ticket.settle(
                                error
                                    .partial
                                    .as_deref()
                                    .and_then(|p| p.get("usage"))
                                    .or(usage.as_ref()),
                            );
                        }
                        if committed || !(counts || busy) {
                            return Err(error.into());
                        }
                        let wait = error.retry_after_ms.unwrap_or(0);
                        if counts
                            && error.retryable
                            && retries < self.policy.max_retries
                            && wait <= self.policy.max_retry_after_ms
                        {
                            let ceiling = self
                                .policy
                                .base_ms
                                .saturating_mul(2u64.saturating_pow(retries))
                                .min(self.policy.max_ms);
                            let delay =
                                ((runtime.random().clamp(0.0, 1.0) * ceiling as f64).floor()
                                    as u64)
                                    .max(wait);
                            retries += 1;
                            runtime.event(json!({"type":"provider.retry","profile":name,"target":target,"attempt":retries,"delayMs":delay,"reason":error.kind}));
                            last_error = Some(error);
                            runtime.sleep_ms(delay)?;
                            continue;
                        }
                        left = Some((target, json!(error.kind)));
                        last_error = Some(error);
                        break;
                    }
                }
            }
        }
        if let Some(reason) = budget_denied {
            return Err(RouteError::BudgetDenied(reason));
        }
        Err(last_error.map_or(RouteError::NoCandidate, RouteError::Provider))
    }

    fn release(&self, target: Target<'_>, generation: u64) {
        self.health(target, |breaker| {
            if breaker.generation == generation {
                breaker.probing = false;
            }
        });
    }
}
