//! The decision client (`packages/core/src/decision/client.ts`): one service per composition. It validates an input,
//! picks the backends in order, enforces the privacy rules before any content leaves the client, holds every backend
//! to one deadline, normalises the answer and keeps bounded aggregates. Only those aggregates survive outside the
//! authorised turn store: an event carries ids, names and numbers, never the state, the question or an answer.
//!
//! Privacy is decided here and fails closed: a cloud backend needs the caller's explicit admission
//! (`cloud_eligible`), and where the content must stay local (`force_local`, or "local only" in the live
//! configuration, read again for every backend) a backend that is not local is never asked.
use super::types::{
    BackendError, BackendName, Clock, ConfidenceSource, DecisionBackend, DecisionConfig,
    DecisionContext, DecisionError, DecisionEvent, DecisionInput, DecisionRequest, DecisionResult,
    DecisionSuccess, DecisionValue, Failure, IdSource, Primitive, UseCase,
};
use crate::approvals::js_json::J;
use crate::config::policy::local_only_for;
use crate::js::utf16_len;
use crate::policy::js_value::to_number;
use crate::triage::{triage, Shape, TriageOptions};
use serde_json::Value;
use std::sync::{Arc, Mutex, PoisonError};

/// Most elapsed-time samples kept for the percentiles.
const SAMPLES: usize = 512;

/// `unit(v)`: a finite number in 0..=1.
pub(crate) fn unit(v: Option<&J>) -> Option<f64> {
    v.and_then(J::as_f64)
        .filter(|n| n.is_finite() && (0.0..=1.0).contains(n))
}

/// `text(v, max)` for a string: at most `max` UTF-16 code units.
fn text(v: &str, max: usize) -> bool {
    utf16_len(v) <= max
}

/// `distribution(values, length)`: `length` unit numbers that sum to 1 within 1e-6.
fn distribution(values: &[Option<f64>], length: usize) -> Option<Vec<f64>> {
    let numbers: Vec<f64> = values.iter().copied().collect::<Option<_>>()?;
    (numbers.len() == length && (numbers.iter().fold(0.0, |a, b| a + b) - 1.0).abs() <= 1e-6)
        .then_some(numbers)
}

/// A callback for the telemetry of the composition. What it does cannot change the decision.
pub type Emit = Box<dyn Fn(&DecisionContext, &DecisionEvent) + Send + Sync>;

/// What a client is made of.
pub struct DecisionOptions {
    /// The live configuration.
    pub config: Arc<dyn DecisionConfig>,
    /// The installed backends, in the order they were installed.
    pub backends: Vec<(BackendName, Arc<dyn DecisionBackend>)>,
    /// The telemetry callback.
    pub emit: Option<Emit>,
    /// The monotonic clock.
    pub clock: Arc<dyn Clock>,
    /// The source of request ids.
    pub ids: Arc<dyn IdSource>,
}

#[derive(Default)]
struct Metrics {
    requests: u64,
    failures: u64,
    samples: Vec<f64>,
    backends: Vec<(BackendName, u64, u64)>,
}

/// `DecisionClient`.
pub struct DecisionClient {
    o: DecisionOptions,
    metrics: Mutex<Metrics>,
}

/// The `decision` section of a configuration.
fn settings(config: &Value) -> &Value {
    config.get("decision").unwrap_or(&Value::Null)
}

/// `String(settings.backend ?? 'role')`. The configuration schema makes it one of the names; any other value selects
/// nothing and leaves the role backend.
fn selected(config: &Value) -> String {
    match settings(config).get("backend") {
        None | Some(Value::Null) => "role".to_owned(),
        Some(Value::String(name)) => name.clone(),
        Some(other) => other.to_string(),
    }
}

impl DecisionClient {
    /// A client over its ports.
    pub fn new(options: DecisionOptions) -> Self {
        Self {
            o: options,
            metrics: Mutex::default(),
        }
    }

    fn backend(&self, name: BackendName) -> Option<&Arc<dyn DecisionBackend>> {
        self.o
            .backends
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, b)| b)
    }

    /// `status()`: the selected backend, what is installed, and the bounded aggregates.
    pub fn status(&self) -> J {
        let m = self.metrics.lock().unwrap_or_else(PoisonError::into_inner);
        let mut sorted = m.samples.clone();
        sorted.sort_by(f64::total_cmp);
        let percentile = |p: f64| {
            if sorted.is_empty() {
                0.0
            } else {
                sorted[((sorted.len() as f64 * p).ceil() as usize)
                    .saturating_sub(1)
                    .min(sorted.len() - 1)]
            }
        };
        let mut backends = J::Obj(Vec::new());
        for (name, requests, failures) in &m.backends {
            backends.set(
                name.as_str(),
                J::obj([
                    ("requests", J::Num(*requests as f64)),
                    ("failures", J::Num(*failures as f64)),
                ]),
            );
        }
        J::obj([
            ("backend", J::Str(selected(&self.o.config.config()))),
            (
                "installed",
                J::Arr(
                    self.o
                        .backends
                        .iter()
                        .map(|(n, _)| J::s(n.as_str()))
                        .collect(),
                ),
            ),
            ("requests", J::Num(m.requests as f64)),
            ("failures", J::Num(m.failures as f64)),
            (
                "errorRate",
                J::Num(if m.requests > 0 {
                    m.failures as f64 / m.requests as f64
                } else {
                    0.0
                }),
            ),
            ("p50Ms", J::Num(percentile(0.5))),
            ("p95Ms", J::Num(percentile(0.95))),
            ("backends", backends),
        ])
    }

    /// The probability that a statement is true.
    pub fn noul(&self, input: &DecisionInput, context: &DecisionContext) -> DecisionResult {
        self.run(Primitive::Noul, input, context)
    }

    /// One of the supplied options.
    pub fn choice(&self, input: &DecisionInput, context: &DecisionContext) -> DecisionResult {
        self.run(Primitive::Choice, input, context)
    }

    /// A score over ordered levels.
    pub fn score(&self, input: &DecisionInput, context: &DecisionContext) -> DecisionResult {
        self.run(Primitive::Score, input, context)
    }

    /// D105 compatibility bridge, not a fourth portable primitive.
    pub fn triage(&self, message: &str, context: &DecisionContext) -> DecisionResult {
        let input = DecisionInput {
            use_case: UseCase::Triage,
            state: message.to_owned(),
            question: "Classify the message using plur1bus.triage/1.".to_owned(),
            features: None,
            options: None,
            levels: None,
        };
        self.run(Primitive::TriageCompat, &input, context)
    }

    fn metric(&self, name: BackendName, failed: bool) {
        let mut m = self.metrics.lock().unwrap_or_else(PoisonError::into_inner);
        let at = match m.backends.iter().position(|(n, _, _)| *n == name) {
            Some(at) => at,
            None => {
                m.backends.push((name, 0, 0));
                m.backends.len() - 1
            }
        };
        if failed {
            m.backends[at].2 += 1;
        } else {
            m.backends[at].1 += 1;
        }
    }

    fn finish(
        &self,
        primitive: Primitive,
        input: &DecisionInput,
        context: &DecisionContext,
        attempted: &[BackendName],
        result: DecisionResult,
    ) -> DecisionResult {
        let elapsed_ms = match &result {
            Ok(ok) => ok.elapsed_ms,
            Err(e) => e.elapsed_ms,
        };
        {
            let mut m = self.metrics.lock().unwrap_or_else(PoisonError::into_inner);
            m.requests += 1;
            if result.is_err() {
                m.failures += 1;
            }
            m.samples.push(elapsed_ms);
            if m.samples.len() > SAMPLES {
                m.samples.remove(0);
            }
        }
        if let Some(emit) = &self.o.emit {
            let event = match &result {
                Ok(ok) => DecisionEvent {
                    request_id: ok.request_id.clone(),
                    primitive,
                    use_case: input.use_case,
                    attempted: attempted.to_vec(),
                    elapsed_ms,
                    failure: None,
                    backend: Some(ok.backend),
                    model_revision: ok.model_revision.clone().filter(|r| !r.is_empty()),
                    confidence: Some(ok.confidence),
                    confidence_source: Some(ok.confidence_source),
                },
                Err(e) => DecisionEvent {
                    request_id: e.request_id.clone(),
                    primitive,
                    use_case: input.use_case,
                    attempted: attempted.to_vec(),
                    elapsed_ms,
                    failure: Some(e.reason),
                    backend: None,
                    model_revision: None,
                    confidence: None,
                    confidence_source: None,
                },
            };
            emit(context, &event);
        }
        result
    }

    fn run(
        &self,
        primitive: Primitive,
        input: &DecisionInput,
        context: &DecisionContext,
    ) -> DecisionResult {
        let started = self.o.clock.now();
        let request_id = self.o.ids.next_id();
        let mut attempted: Vec<BackendName> = Vec::new();
        let config = self.o.config.config();
        let section = settings(&config);
        let selected = selected(&config);
        let of_use_case = |table: &str, default: f64| {
            section
                .get(table)
                .and_then(|t| t.get(input.use_case.as_str()))
                .filter(|v| !v.is_null())
                .map_or(default, to_number)
        };
        let cap = of_use_case("budgets", input.use_case.budget_ms());
        let timeout = section
            .get("timeoutMs")
            .filter(|v| !v.is_null())
            .map_or(2000.0, to_number);
        // `Math.min`: NaN wins, so a timeout that is not a number makes the deadline NaN and the input invalid.
        let js_min = |a: f64, b: f64| {
            if a.is_nan() || b.is_nan() {
                f64::NAN
            } else {
                a.min(b)
            }
        };
        let deadline = js_min(
            context.deadline.unwrap_or(f64::INFINITY),
            started + js_min(timeout, cap),
        );
        let floor = of_use_case("confidence", input.use_case.floor());
        let fail = |reason: Failure, attempted: &[BackendName]| {
            let error = DecisionError {
                request_id: request_id.clone(),
                elapsed_ms: self.o.clock.now() - started,
                reason,
                attempted: attempted.to_vec(),
            };
            self.finish(primitive, input, context, attempted, Err(error))
        };
        if context.cancel.cancelled() {
            return fail(Failure::Cancelled, &attempted);
        }
        if !valid_input(primitive, input) || !deadline.is_finite() {
            return fail(Failure::Invalid, &attempted);
        }
        let order: Vec<BackendName> = if primitive == Primitive::TriageCompat {
            vec![BackendName::Role]
        } else if selected == "auto" {
            vec![
                BackendName::Jev,
                BackendName::Kev,
                BackendName::Laya,
                BackendName::Role,
            ]
        } else {
            // `[...new Set([selected, 'role'])]`; a name that is no backend has nothing installed under it.
            let mut order: Vec<BackendName> = BackendName::parse(&selected).into_iter().collect();
            if !order.contains(&BackendName::Role) {
                order.push(BackendName::Role);
            }
            order
        };
        let mut failure = Failure::Unavailable;
        for name in order {
            if context.cancel.cancelled() {
                return fail(Failure::Cancelled, &attempted);
            }
            if self.o.clock.now() >= deadline {
                return fail(Failure::Timeout, &attempted);
            }
            let Some(backend) = self.backend(name) else {
                continue;
            };
            let chosen = selected == name.as_str();
            if name == BackendName::Jev && !context.cloud_eligible {
                if chosen {
                    return fail(Failure::Privacy, &attempted);
                }
                failure = Failure::Privacy;
                continue;
            }
            if selected == "auto"
                && matches!(name, BackendName::Laya | BackendName::Kev)
                && !backend.has_eligible()
            {
                continue;
            }
            let local = match backend.has_eligible().then(|| backend.eligible(context)) {
                Some(Ok(false)) => continue,
                Some(Err(_)) => Err(BackendError::Other),
                Some(Ok(true)) | None => backend.local(context),
            };
            let Ok(local) = local else {
                failure = Failure::Unavailable;
                continue;
            };
            // Cloud content eligibility is a caller policy; raw tool output sets `force_local`. The configuration is
            // live, so it is read again here.
            let local_required = context.force_local
                || local_only_for(&self.o.config.config(), Some(&context.agent_id));
            let Some(local) = local else {
                continue;
            };
            if local_required && !local {
                if chosen {
                    return fail(Failure::Privacy, &attempted);
                }
                failure = Failure::Privacy;
                continue;
            }
            attempted.push(name);
            self.metric(name, false);
            let request = DecisionRequest {
                input: input.clone(),
                request_id: request_id.clone(),
                primitive,
                deadline,
                context: context.clone(),
            };
            let outcome = match backend.run(&request, context.cancel.as_ref()) {
                Ok(_) if context.cancel.cancelled() => Err(Failure::Cancelled),
                Ok(_) if self.o.clock.now() >= deadline => Err(Failure::Timeout),
                Ok(raw) => normalize(primitive, input, &raw).and_then(|(value, confidence)| {
                    // `confidence < floor` is false for a NaN, as in JavaScript.
                    if confidence < floor {
                        return Err(Failure::LowConfidence);
                    }
                    let model_revision = raw
                        .get("modelRevision")
                        .and_then(J::as_str)
                        .filter(|r| text(r, 256))
                        .map(str::to_owned);
                    Ok((value, confidence, model_revision))
                }),
                // TypeScript races the backend against the signal: a failure after the turn was cancelled is a
                // cancellation, whatever the backend says it was.
                Err(_) if context.cancel.cancelled() => Err(Failure::Cancelled),
                Err(BackendError::Reason(reason)) => Err(reason),
                Err(BackendError::Interrupted) => Err(Failure::Timeout),
                Err(BackendError::Other) => Err(Failure::Invalid),
            };
            match outcome {
                Ok((value, confidence, model_revision)) => {
                    let confidence_source = if primitive == Primitive::Noul {
                        ConfidenceSource::Derived
                    } else if name == BackendName::Role {
                        ConfidenceSource::Uncalibrated
                    } else {
                        ConfidenceSource::Backend
                    };
                    let success = DecisionSuccess {
                        request_id: request_id.clone(),
                        backend: name,
                        elapsed_ms: self.o.clock.now() - started,
                        model_revision,
                        value,
                        confidence,
                        confidence_source,
                    };
                    return self.finish(primitive, input, context, &attempted, Ok(success));
                }
                Err(reason) => {
                    self.metric(name, true);
                    failure = reason;
                    if matches!(
                        failure,
                        Failure::Privacy | Failure::Cancelled | Failure::Timeout
                    ) {
                        return fail(failure, &attempted);
                    }
                }
            }
        }
        fail(failure, &attempted)
    }
}

/// `#validInput`: bounds on everything a backend will see.
fn valid_input(primitive: Primitive, input: &DecisionInput) -> bool {
    let state_cap = if primitive == Primitive::TriageCompat {
        200_000
    } else {
        16_384
    };
    if !text(&input.state, state_cap) || !text(&input.question, 2048) {
        return false;
    }
    if let Some(features) = input.features_j() {
        let members = features.members();
        if members.len() > 32 {
            return false;
        }
        // An object holds the last value written under a name; only those are checked, as in TypeScript.
        let ok = members.iter().all(|(_, value)| match value {
            J::Num(n) => n.is_finite(),
            J::Str(s) => text(s, 1024),
            _ => true,
        });
        if !ok {
            return false;
        }
    }
    match primitive {
        Primitive::Choice => input.options.as_ref().is_some_and(|options| {
            let distinct = options
                .iter()
                .enumerate()
                .all(|(i, o)| options[..i].iter().all(|earlier| earlier.id != o.id));
            (2..=255).contains(&options.len())
                && distinct
                && options
                    .iter()
                    .all(|o| text(&o.id, 128) && !o.id.is_empty() && text(&o.description, 1024))
        }),
        Primitive::Score => input.levels.as_ref().is_some_and(|levels| {
            (2..=10).contains(&levels.len())
                && levels.iter().all(|l| text(l, 1024) && !l.is_empty())
        }),
        Primitive::Noul | Primitive::TriageCompat => true,
    }
}

/// `#normalize`: the backend's raw answer as a value and a confidence, or `invalid`. An answer is never trusted: its
/// shape, its ids and its numbers are checked against the input.
fn normalize(
    primitive: Primitive,
    input: &DecisionInput,
    raw: &J,
) -> Result<(DecisionValue, f64), Failure> {
    if !matches!(raw, J::Obj(_)) || utf16_len(&raw.stringify()) > 65_536 {
        return Err(Failure::Invalid);
    }
    if primitive == Primitive::TriageCompat {
        let payload = match raw {
            J::Obj(members) => J::Obj(
                members
                    .iter()
                    .filter(|(k, _)| k != "modelRevision")
                    .cloned()
                    .collect(),
            ),
            other => other.clone(),
        };
        let decision = triage(
            &input.state,
            &TriageOptions {
                classified: Some(&payload),
                cost: None,
                active_task: None,
            },
        )
        .map_err(|_| Failure::Invalid)?;
        let count = decision.task_count();
        let consistent = count <= 32
            && match decision.shape() {
                Shape::Chat | Shape::Followup => count == 0,
                Shape::Single => count == 1,
                Shape::Multi => count >= 2,
            };
        if !consistent {
            return Err(Failure::Invalid);
        }
        // `Math.min(1, ...confidences)`: a task without a confidence makes it NaN.
        let confidence = decision.tasks().iter().fold(1.0, |least: f64, t| {
            if least.is_nan() || t.confidence.is_nan() {
                f64::NAN
            } else {
                least.min(t.confidence)
            }
        });
        return Ok((DecisionValue::Triage(decision), confidence));
    }
    if primitive == Primitive::Noul {
        let probability = unit(raw.get("probability")).ok_or(Failure::Invalid)?;
        return Ok((
            DecisionValue::Noul { probability },
            probability.max(1.0 - probability),
        ));
    }
    let confidence = unit(raw.get("confidence")).ok_or(Failure::Invalid)?;
    if primitive == Primitive::Choice {
        let ids: Vec<&str> = input
            .options
            .iter()
            .flatten()
            .map(|o| o.id.as_str())
            .collect();
        let id = raw
            .get("id")
            .and_then(J::as_str)
            .filter(|id| ids.contains(id))
            .ok_or(Failure::Invalid)?;
        let given = raw
            .get("probabilities")
            .filter(|p| matches!(p, J::Obj(_)))
            .ok_or(Failure::Invalid)?;
        if given.members().iter().any(|(k, _)| !ids.contains(k)) {
            return Err(Failure::Invalid);
        }
        let values: Vec<Option<f64>> = ids.iter().map(|option| unit(given.get(option))).collect();
        let probabilities = distribution(&values, ids.len()).ok_or(Failure::Invalid)?;
        let highest = probabilities
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        if given.get(id).and_then(J::as_f64) != Some(highest) {
            return Err(Failure::Invalid);
        }
        let value = DecisionValue::Choice {
            id: id.to_owned(),
            probabilities: ids
                .iter()
                .map(|option| (*option).to_owned())
                .zip(probabilities)
                .collect(),
        };
        return Ok((value, confidence));
    }
    let count = input.levels.as_ref().map_or(0, Vec::len);
    let Some(J::Arr(given)) = raw.get("probabilities") else {
        return Err(Failure::Invalid);
    };
    let values: Vec<Option<f64>> = given.iter().map(|p| unit(Some(p))).collect();
    let probabilities = distribution(&values, count).ok_or(Failure::Invalid)?;
    let score = probabilities
        .iter()
        .enumerate()
        .fold(0.0, |sum, (i, p)| sum + p * i as f64);
    Ok((
        DecisionValue::Score {
            score,
            probabilities,
        },
        confidence,
    ))
}
