//! One bounded System One transport (`packages/core/src/decision/system-one.ts`): no SDK, no retries, no discovery, no
//! logging of a raw response, no model installation. `jev` is the cloud endpoint, `kev` a literal loopback endpoint.
//!
//! HTTP, the secret store and the call budget are ports here (R-K-14: the core has no HTTP client of its own; the flip
//! wires the guarded egress client, the secret store and the budget service). What this module owns is everything
//! around the call, in this order: availability from the live configuration; the privacy rule for the cloud endpoint
//! (checked before the budget is reserved and again after the secret was leased, because the configuration is live);
//! the request body and its byte cap; the budget reservation before anything is sent and its settlement or release
//! afterwards; a short-lived lease of the credential, revoked whatever happens; and a closed check of the answer,
//! where any member that is not expected makes the whole answer invalid. The credential never reaches an error.
use super::client::unit;
use super::types::{
    BackendError, Cancel, Clock, DecisionBackend, DecisionConfig, DecisionContext, DecisionRequest,
    Failure, Primitive,
};
use crate::approvals::js_json::J;
use crate::config::policy::local_only_for;
use crate::js::utf16_len;
use serde_json::Value;
use std::sync::Arc;
use zeroize::Zeroizing;

const BYTE_CAP: usize = 65_536;
/// A finite conservative reservation; never a request for generated prose.
const MAX_OUTPUT: f64 = 65_536.0;
const JEV_URL: &str = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL: &str = "jev-1.13.0";

/// Which System One endpoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// The cloud endpoint.
    Jev,
    /// The local endpoint.
    Kev,
}

impl Kind {
    /// The TypeScript spelling, also the provider name in the budget.
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Jev => "jev",
            Kind::Kev => "kev",
        }
    }
}

/// What the call budget is asked before a call (`checkBeforeCall`).
#[derive(Clone, Debug, PartialEq)]
pub struct BudgetCall {
    /// The principal.
    pub principal: String,
    /// The agent.
    pub agent: String,
    /// The project, `decision` when the turn has none.
    pub project: String,
    /// The model.
    pub model: String,
    /// `jev` or `kev`.
    pub provider: &'static str,
    /// Request bytes plus 1024.
    pub estimated_input_tokens: f64,
    /// The output reservation.
    pub max_output_tokens: f64,
    /// The session.
    pub session: Option<String>,
    /// The turn.
    pub turn: Option<String>,
}

/// A port (the budget or the secret store) failed. Why is the port's own matter; a decision only needs to know.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PortFailed;

/// The call budget, as far as a decision needs it.
pub trait Budget: Send + Sync {
    /// Reserves; `None` is a refusal.
    fn check_before_call(&self, call: &BudgetCall) -> Option<String>;
    /// Settles a reservation after a request was sent, with the reported usage or the estimate.
    fn settle(
        &self,
        reservation: &str,
        input_tokens: f64,
        output_tokens: f64,
    ) -> Result<(), PortFailed>;
    /// Releases a reservation nothing was sent for.
    fn release_unused(&self, reservation: &str) -> Result<(), PortFailed>;
}

/// A leased credential as the store hands it out.
pub struct LeasedSecret {
    /// The purpose the lease was issued for.
    pub purpose: String,
    /// The profile it was issued to.
    pub profile_id: String,
    /// The value.
    pub value: Zeroizing<String>,
}

/// The secret store, as far as a decision needs it. The principal is always the core.
pub trait Secrets: Send + Sync {
    /// Leases `name` for `ttl_ms`; returns the lease id.
    fn lease(
        &self,
        name: &str,
        purpose: &str,
        profile_id: &str,
        ttl_ms: f64,
    ) -> Result<String, PortFailed>;
    /// Reads a lease.
    fn read_lease(&self, lease_id: &str) -> Result<LeasedSecret, PortFailed>;
    /// Revokes a lease.
    fn revoke_lease(&self, lease_id: &str) -> Result<(), PortFailed>;
}

/// The one request of this transport. It has no `Debug`: it holds the credential.
pub struct HttpCall {
    /// The URL.
    pub url: String,
    /// The body, at most [`BYTE_CAP`] bytes.
    pub body: String,
    /// `Bearer <credential>` for the cloud endpoint.
    pub authorization: Option<Zeroizing<String>>,
    /// The time limit in milliseconds, the rest of the decision's deadline.
    pub timeout_ms: f64,
}

impl HttpCall {
    /// `POST`.
    pub const METHOD: &'static str = "POST";
    /// The content type of the body, and the accepted type of the answer.
    pub const CONTENT_TYPE: &'static str = "application/json";
    /// The user agent.
    pub const USER_AGENT: &'static str = "PLUR1BUS-decision";
    /// The cap on the request body and on the response body; no redirect is followed and no error body is read.
    pub const MAX_BYTES: usize = BYTE_CAP;
}

/// How the request failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpFault {
    /// The client's own time limit (`WebFailure` code `timeout`).
    Timeout,
    /// Anything else, a refusal by the egress gate included.
    Other,
}

/// The guarded HTTP client. It must apply the egress policy, refuse redirects, cap the response at
/// [`HttpCall::MAX_BYTES`] and accept only [`accepts_json`] content types.
pub trait Http: Send + Sync {
    /// Sends the request; returns the status and the body.
    fn request(&self, call: &HttpCall, cancel: &dyn Cancel) -> Result<(u16, Vec<u8>), HttpFault>;
}

/// `acceptType`: `/^application\/json(?:\s*;|$)/i` on the content type of the answer.
pub fn accepts_json(content_type: Option<&str>) -> bool {
    let text = content_type.unwrap_or("");
    let Some(head) = text.get(..16) else {
        return false;
    };
    if !head.eq_ignore_ascii_case("application/json") {
        return false;
    }
    let rest = text[16..].trim_start_matches(crate::js::is_js_space);
    text.len() == 16 || rest.starts_with(';')
}

/// `literalLoopback(raw, path)`: `http` or `https`, a literal `127.x.y.z` or `[::1]`, an optional port, and exactly
/// `path` (`/` or `/v1/systemone`); nothing else, and the URL parser must agree.
pub fn literal_loopback(raw: &str, path: &str) -> bool {
    let Some(rest) = raw
        .strip_prefix("https://")
        .or_else(|| raw.strip_prefix("http://"))
    else {
        return false;
    };
    let digits = |s: &str, max: usize| s.bytes().take_while(u8::is_ascii_digit).count().min(max);
    let after_host = if let Some(rest) = rest.strip_prefix("[::1]") {
        rest
    } else if let Some(mut rest) = rest.strip_prefix("127") {
        for _ in 0..3 {
            let Some(octet) = rest.strip_prefix('.') else {
                return false;
            };
            let n = digits(octet, 3);
            if n == 0 {
                return false;
            }
            rest = &octet[n..];
        }
        rest
    } else {
        return false;
    };
    let after_port = match after_host.strip_prefix(':') {
        Some(port) => {
            let n = digits(port, 5);
            if n == 0 {
                return false;
            }
            &port[n..]
        }
        None => after_host,
    };
    if !(after_port.is_empty() || after_port == "/v1/systemone") {
        return false;
    }
    url::Url::parse(raw).is_ok_and(|u| u.path() == path)
}

/// `/^[A-Za-z0-9._/@-]{1,128}$/`.
fn is_model_id(model: &str) -> bool {
    (1..=128).contains(&model.len())
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'@' | b'-'))
}

/// The ports of a System One backend.
pub struct SystemOneOptions {
    /// The live configuration.
    pub config: Arc<dyn DecisionConfig>,
    /// The guarded HTTP client.
    pub http: Arc<dyn Http>,
    /// The secret store.
    pub secrets: Arc<dyn Secrets>,
    /// The call budget; without one the backend is unavailable.
    pub budget: Option<Arc<dyn Budget>>,
    /// The monotonic clock.
    pub clock: Arc<dyn Clock>,
    /// Internal loopback test seam. Never read from configuration.
    pub test_origin: Option<String>,
    /// Native admission of the local endpoint, not a configuration flag. Absent means Kev is unavailable even when
    /// explicitly selected.
    pub kev_eligible: Option<Box<dyn Fn() -> bool + Send + Sync>>,
}

/// `createSystemOneBackend(kind, options)`.
pub struct SystemOneBackend {
    kind: Kind,
    o: SystemOneOptions,
}

/// The settings of one endpoint that the backend reads.
#[derive(Clone, Debug, PartialEq)]
struct Settings {
    enabled: bool,
    model: Option<Value>,
    secret_ref: Option<Value>,
    endpoint: Option<Value>,
}

fn invalid<T>() -> Result<T, BackendError> {
    Err(BackendError::Reason(Failure::Invalid))
}

/// `closed(v, keys)`: an object whose members are all among `keys`.
fn closed<'a>(v: Option<&'a J>, keys: &[&str]) -> Result<&'a J, BackendError> {
    match v {
        Some(j @ J::Obj(_)) if j.members().iter().all(|(k, _)| keys.contains(k)) => Ok(j),
        _ => invalid(),
    }
}

/// `usage(raw)`: two nonnegative safe integers and nothing else, or nothing.
fn usage(raw: Option<&J>) -> Option<(f64, f64)> {
    let j = closed(raw, &["input_tokens", "output_tokens"]).ok()?;
    let count = |key: &str| {
        j.get(key).and_then(J::as_f64).filter(|n| {
            n.is_finite() && n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(n)
        })
    };
    let (input, output) = (count("input_tokens")?, count("output_tokens")?);
    (input + output <= 9_007_199_254_740_991.0).then_some((input, output))
}

/// `distribution(raw, keys, kind)`: exactly one unit number per key, summing to 1 within the endpoint's tolerance,
/// renormalised. Kev's documented four-decimal rounding can move a K-way sum by at most K * 0.00005.
fn distribution(raw: Option<&J>, keys: &[&str], kind: Kind) -> Result<Vec<f64>, BackendError> {
    let j = closed(raw, keys)?;
    if j.members().len() != keys.len() {
        return invalid();
    }
    let values: Vec<f64> = keys
        .iter()
        .map(|k| unit(j.get(k)))
        .collect::<Option<_>>()
        .ok_or(BackendError::Reason(Failure::Invalid))?;
    let sum = values.iter().fold(0.0, |s, v| s + v);
    let tolerance = if kind == Kind::Kev {
        keys.len() as f64 * 0.00005 + 1e-12
    } else {
        1e-6
    };
    if sum <= 0.0 || (sum - 1.0).abs() > tolerance {
        return invalid();
    }
    Ok(values.into_iter().map(|v| v / sum).collect())
}

/// `normalize(raw, request, kind, model)`: the endpoint's answer as the client's raw answer, or invalid.
fn normalize(
    raw: &J,
    request: &DecisionRequest,
    kind: Kind,
    model: &str,
) -> Result<J, BackendError> {
    let top: &[&str] = if kind == Kind::Kev {
        &["model", "answers", "usage", "latency_ms"]
    } else {
        &["model", "answers", "usage"]
    };
    let raw = closed(Some(raw), top)?;
    if raw.get("model").and_then(J::as_str) != Some(model) || usage(raw.get("usage")).is_none() {
        return invalid();
    }
    if let Some(latency) = raw.get("latency_ms") {
        if !latency
            .as_f64()
            .is_some_and(|ms| ms.is_finite() && ms >= 0.0)
        {
            return invalid();
        }
    }
    let answer = closed(raw.get("answers"), &["decision"])?.get("decision");
    let kind_is = |j: &J, name: &str| j.get("type").and_then(J::as_str) == Some(name);
    match request.primitive {
        Primitive::Noul => {
            let answer = closed(answer, &["type", "noul"])?;
            let (true, Some(probability)) = (kind_is(answer, "noul"), unit(answer.get("noul")))
            else {
                return invalid();
            };
            Ok(J::obj([
                ("probability", J::Num(probability)),
                ("modelRevision", J::s(model)),
            ]))
        }
        Primitive::Choice => {
            let answer = closed(answer, &["type", "choice", "confidence", "probabilities"])?;
            let keys: Vec<&str> = request
                .input
                .options
                .iter()
                .flatten()
                .map(|o| o.id.as_str())
                .collect();
            let values = distribution(answer.get("probabilities"), &keys, kind)?;
            let choice = answer.get("choice").and_then(J::as_str);
            let at = choice.and_then(|c| keys.iter().position(|k| *k == c));
            let highest = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let (true, Some(choice), Some(confidence), Some(at)) = (
                kind_is(answer, "choice"),
                choice,
                unit(answer.get("confidence")),
                at,
            ) else {
                return invalid();
            };
            if values[at] != highest {
                return invalid();
            }
            let mut probabilities = J::Obj(Vec::new());
            for (key, value) in keys.iter().zip(&values) {
                probabilities.set(key, J::Num(*value));
            }
            Ok(J::obj([
                ("id", J::s(choice)),
                ("probabilities", probabilities),
                ("confidence", J::Num(confidence)),
                ("modelRevision", J::s(model)),
            ]))
        }
        Primitive::Score => {
            let answer = closed(
                answer,
                &["type", "score", "legend", "confidence", "probabilities"],
            )?;
            let levels: &[String] = request.input.levels.as_deref().unwrap_or(&[]);
            let names: Vec<String> = (0..levels.len()).map(|i| i.to_string()).collect();
            let keys: Vec<&str> = names.iter().map(String::as_str).collect();
            let values = distribution(answer.get("probabilities"), &keys, kind)?;
            let legend = closed(answer.get("legend"), &keys)?;
            let legend_ok = legend.members().len() == keys.len()
                && keys
                    .iter()
                    .zip(levels)
                    .all(|(k, level)| legend.get(k).and_then(J::as_str) == Some(level));
            let expected = values
                .iter()
                .enumerate()
                .fold(0.0, |s, (i, p)| s + p * i as f64);
            let n = keys.len() as f64;
            let tolerance = if kind == Kind::Kev {
                0.00005 * n * n + 1e-12
            } else {
                1e-6
            };
            let score = answer.get("score").and_then(J::as_f64).filter(|s| {
                s.is_finite() && *s >= 0.0 && *s <= n - 1.0 && (s - expected).abs() <= tolerance
            });
            let (true, true, Some(confidence), Some(_)) = (
                legend_ok,
                kind_is(answer, "score"),
                unit(answer.get("confidence")),
                score,
            ) else {
                return invalid();
            };
            Ok(J::obj([
                (
                    "probabilities",
                    J::Arr(values.into_iter().map(J::Num).collect()),
                ),
                ("confidence", J::Num(confidence)),
                ("modelRevision", J::s(model)),
            ]))
        }
        Primitive::TriageCompat => invalid(),
    }
}

/// The request body: `{ model, state, questions: { decision } }`, the state with its features when there are any.
fn body_of(request: &DecisionRequest, model: &str) -> String {
    let input = &request.input;
    let mut question = J::obj([
        ("type", J::s(request.primitive.as_str())),
        ("instructions", J::s(&input.question)),
    ]);
    match request.primitive {
        Primitive::Choice => {
            let mut criteria = J::Obj(Vec::new());
            for option in input.options.iter().flatten() {
                criteria.set(&option.id, J::s(&option.description));
            }
            question.set("criteria", criteria);
        }
        Primitive::Score => question.set(
            "criteria",
            J::Arr(input.levels.iter().flatten().map(|l| J::s(l)).collect()),
        ),
        Primitive::Noul | Primitive::TriageCompat => {}
    }
    let state = match input.features_j() {
        Some(features) => J::obj([("text", J::s(&input.state)), ("features", features)]),
        None => J::s(&input.state),
    };
    J::obj([
        ("model", J::s(model)),
        ("state", state),
        ("questions", J::obj([("decision", question)])),
    ])
    .stringify()
}

impl SystemOneBackend {
    /// A backend for one endpoint. A test origin that is not a literal loopback origin is refused.
    pub fn new(kind: Kind, options: SystemOneOptions) -> Result<Self, BackendError> {
        if options
            .test_origin
            .as_deref()
            .is_some_and(|origin| !literal_loopback(origin, "/"))
        {
            return Err(BackendError::Reason(Failure::Unavailable));
        }
        Ok(Self { kind, o: options })
    }

    fn settings(&self) -> Settings {
        let config = self.o.config.config();
        let section = config
            .get("decision")
            .and_then(|d| d.get("systemOne"))
            .and_then(|s| s.get(self.kind.as_str()));
        let member = |key: &str| {
            section
                .filter(|s| s.is_object())
                .and_then(|s| s.get(key))
                .cloned()
        };
        Settings {
            enabled: member("enabled") == Some(Value::Bool(true)),
            model: member("model"),
            secret_ref: member("secretRef"),
            endpoint: member("endpoint"),
        }
    }

    fn available(&self) -> bool {
        let s = self.settings();
        if !s.enabled || self.o.budget.is_none() {
            return false;
        }
        let text = |v: &Option<Value>| v.as_ref().and_then(Value::as_str).map(str::to_owned);
        match self.kind {
            Kind::Jev => {
                text(&s.model).as_deref() == Some(JEV_MODEL)
                    && text(&s.secret_ref).is_some_and(|r| !r.is_empty())
            }
            Kind::Kev => {
                self.o
                    .kev_eligible
                    .as_ref()
                    .is_some_and(|eligible| eligible())
                    && text(&s.model).is_some_and(|m| is_model_id(&m))
                    && text(&s.endpoint).is_some_and(|e| literal_loopback(&e, "/v1/systemone"))
            }
        }
    }

    /// The cloud endpoint may not see content that has to stay local, and only with the caller's admission.
    fn cloud_refused(&self, context: &DecisionContext) -> bool {
        self.kind == Kind::Jev
            && (!context.cloud_eligible
                || context.force_local
                || local_only_for(&self.o.config.config(), Some(&context.agent_id)))
    }

    fn interrupted(
        &self,
        request: &DecisionRequest,
        cancel: &dyn Cancel,
    ) -> Result<(), BackendError> {
        if cancel.cancelled() || request.context.cancel.cancelled() {
            return Err(BackendError::Reason(Failure::Cancelled));
        }
        if self.o.clock.now() >= request.deadline {
            return Err(BackendError::Reason(Failure::Timeout));
        }
        Ok(())
    }

    /// Everything between the reservation and its settlement. `lease` and `sent` tell the caller what to clean up.
    #[allow(clippy::too_many_arguments)]
    fn exchange(
        &self,
        request: &DecisionRequest,
        cancel: &dyn Cancel,
        s: &Settings,
        model: &str,
        body: String,
        lease: &mut Option<String>,
        sent: &mut bool,
        actual: &mut Option<(f64, f64)>,
    ) -> Result<J, Result<BackendError, HttpFault>> {
        let unavailable = || Ok(BackendError::Reason(Failure::Unavailable));
        let mut authorization = None;
        if self.kind == Kind::Jev {
            let name = s
                .secret_ref
                .as_ref()
                .and_then(Value::as_str)
                .unwrap_or_default();
            let ttl = (request.deadline - self.o.clock.now())
                .ceil()
                .clamp(1.0, 60_000.0);
            let id = self
                .o
                .secrets
                .lease(name, "decision", "decision-service", ttl)
                .map_err(|PortFailed| Ok(BackendError::Other))?;
            *lease = Some(id.clone());
            self.interrupted(request, cancel).map_err(Ok)?;
            let fresh = self
                .o
                .secrets
                .read_lease(&id)
                .map_err(|PortFailed| Ok(BackendError::Other))?;
            let value = &fresh.value;
            if fresh.purpose != "decision"
                || fresh.profile_id != "decision-service"
                || value.is_empty()
                || utf16_len(value) > 4096
                || value.contains(['\r', '\n', '\0'])
            {
                return Err(unavailable());
            }
            authorization = Some(Zeroizing::new(format!("Bearer {}", value.as_str())));
        }
        self.interrupted(request, cancel).map_err(Ok)?;
        // The configuration is live: nothing is sent if admission was withdrawn while the lease was issued.
        if !self.available() || self.settings() != *s {
            return Err(unavailable());
        }
        if self.cloud_refused(&request.context) {
            return Err(Ok(BackendError::Reason(Failure::Privacy)));
        }
        let remaining = (request.deadline - self.o.clock.now()).ceil().max(1.0);
        let url = match (self.kind, &self.o.test_origin) {
            (Kind::Jev, Some(origin)) => format!("{origin}/v1/systemone"),
            (Kind::Jev, None) => JEV_URL.to_owned(),
            (Kind::Kev, _) => s
                .endpoint
                .as_ref()
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        };
        *sent = true;
        let (status, bytes) = self
            .o
            .http
            .request(
                &HttpCall {
                    url,
                    body,
                    authorization,
                    timeout_ms: remaining,
                },
                cancel,
            )
            .map_err(Err)?;
        if status != 200 || bytes.len() > BYTE_CAP {
            return Err(unavailable());
        }
        // `body.toString('utf8')` never fails; bytes that are not UTF-8 become U+FFFD.
        let raw = J::parse(&String::from_utf8_lossy(&bytes))
            .ok_or(Ok(BackendError::Reason(Failure::Invalid)))?;
        *actual = usage(raw.get("usage"));
        self.interrupted(request, cancel).map_err(Ok)?;
        normalize(&raw, request, self.kind, model).map_err(Ok)
    }
}

impl DecisionBackend for SystemOneBackend {
    fn local(&self, _context: &DecisionContext) -> Result<Option<bool>, BackendError> {
        Ok(self.available().then_some(self.kind == Kind::Kev))
    }

    fn has_eligible(&self) -> bool {
        true
    }

    fn eligible(&self, _context: &DecisionContext) -> Result<bool, BackendError> {
        Ok(self.available())
    }

    fn run(&self, request: &DecisionRequest, cancel: &dyn Cancel) -> Result<J, BackendError> {
        let unavailable = BackendError::Reason(Failure::Unavailable);
        self.interrupted(request, cancel)?;
        if request.primitive == Primitive::TriageCompat || !self.available() {
            return Err(unavailable);
        }
        if self.cloud_refused(&request.context) {
            return Err(BackendError::Reason(Failure::Privacy));
        }
        let context = &request.context;
        let principal = context
            .principal
            .as_deref()
            .or(context.chat.as_ref().and_then(|c| c.principal.as_deref()))
            .filter(|p| !p.is_empty());
        let (Some(principal), false) = (principal, context.agent_id.is_empty()) else {
            return Err(unavailable);
        };
        let s = self.settings();
        let model = s
            .model
            .as_ref()
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let body = body_of(request, &model);
        let bytes = body.len();
        if bytes > BYTE_CAP {
            return invalid();
        }
        let estimate = (bytes as f64 + 1024.0, MAX_OUTPUT);
        let Some(budget) = &self.o.budget else {
            return Err(unavailable);
        };
        let call = BudgetCall {
            principal: principal.to_owned(),
            agent: context.agent_id.clone(),
            project: context
                .chat
                .as_ref()
                .and_then(|c| c.project_id.clone())
                .unwrap_or_else(|| "decision".to_owned()),
            model: model.clone(),
            provider: self.kind.as_str(),
            estimated_input_tokens: estimate.0,
            max_output_tokens: estimate.1,
            session: context.session_id.clone().filter(|v| !v.is_empty()),
            turn: context.turn_id.clone().filter(|v| !v.is_empty()),
        };
        let Some(reservation) = budget.check_before_call(&call) else {
            return Err(unavailable);
        };
        let (mut lease, mut sent, mut actual) = (None, false, None);
        let outcome = self
            .exchange(
                request,
                cancel,
                &s,
                &model,
                body,
                &mut lease,
                &mut sent,
                &mut actual,
            )
            .map_err(|error| {
                if context.cancel.cancelled() || cancel.cancelled() {
                    return BackendError::Reason(Failure::Cancelled);
                }
                // The client reports both of its limits as a timeout; so does a deadline that has passed by now.
                if error == Err(HttpFault::Timeout) || self.o.clock.now() >= request.deadline {
                    return BackendError::Reason(Failure::Timeout);
                }
                match error {
                    Ok(reason @ BackendError::Reason(_)) => reason,
                    _ => unavailable,
                }
            });
        // `finally`: the reservation is settled or released, then the lease is revoked; a failure of either replaces
        // the outcome, the lease's last.
        let settled = if sent {
            let (input, output) = actual.unwrap_or(estimate);
            budget.settle(&reservation, input, output)
        } else {
            budget.release_unused(&reservation)
        };
        let revoked = lease
            .as_deref()
            .map_or(Ok(()), |id| self.o.secrets.revoke_lease(id));
        if revoked.is_err() {
            return Err(unavailable);
        }
        if settled.is_err() {
            return Err(BackendError::Other);
        }
        outcome
    }
}
