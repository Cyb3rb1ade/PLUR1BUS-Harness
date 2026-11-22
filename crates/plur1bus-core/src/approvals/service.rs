//! `approvals/service.ts` (D109 §5/§6, D4): the approval service, the dispatcher's approval port. A call whose decision is
//! `ask` is parked here: a request is stored (nonce, bound to action hash, principal, subject, session and task),
//! `approval.requested` goes out, and the call waits for a person's decision. The first valid answer wins. NOTHING is ever
//! approved automatically: a timeout, an abort, a headless run, a broken chain, a failing audit line or any other error ends
//! as "not approved".
//!
//! What a decision does: [`ApprovalService::decide`] checks the surface (`surfaceMayDecide`), records the decision in the
//! chain, creates the grant the person chose (a once grant bound to the action hash by default; a path or capability grant
//! for a wider scope, narrowed to the call's own targets) and writes the audit line, all in ONE transaction, so an
//! unrecordable decision does not exist. [`ApprovalService::begin`] is the execution start: it consumes the approval and its
//! once grant atomically; a replay is refused.
//!
//! The waiting itself is the host's: TypeScript returns a promise, this port takes the callback that receives the
//! [`Answer`] (the flip wraps it in a future). Time comes through [`Timers`]: the service asks for a foreground and an
//! expiry timer per request, and the host calls [`ApprovalService::fire`] when one is due; an abort signal is
//! [`ApprovalService::abort`]. The audit trail is passed to every call that writes ([`AuditPort`]), the events go to
//! [`ApprovalEvents`], and the argument canonicaliser, the redactor and the A2A trust display are ports
//! ([`ServicePorts`]).
use super::chain::VerifyResult;
use super::js_json::{num_value, J};
use super::store::{ApprovalRecord, Binding, DecideInput, Denial, RequestInput, Status};
use super::{ApprovalError, AuditPort, Clock};
use crate::grants::open::PermissionStores;
use crate::grants::store::{CreateGrantInput, GrantError, GrantErrorCode, GrantMatch, GrantStore};
use crate::logs::redact::TextRedactor;
use crate::policy::audit::hash_and_size;
use crate::policy::capabilities::{capability, GrantScope, Risk, RISKS};
use crate::policy::decide::{max_scope_for, surface_may_decide, Flags};
use plur1bus_store::rusqlite::{Connection, OptionalExtension};
use plur1bus_store::StoreError;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// `DEFAULT_FOREGROUND_WAIT_MS`: a foreground turn waits this long before the task parks.
pub const DEFAULT_FOREGROUND_WAIT_MS: i64 = 10 * 60_000;

/// The two timers a waiting request has.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TimerKind {
    /// The foreground wait: when it fires, the call is answered "parked" and the request stays open.
    Foreground,
    /// The request's end: when it fires, an undecided request is expired (= denied).
    Expiry,
}

/// `Timers`: the host schedules `fire(kind, id)` after `ms` and can clear it again.
pub trait Timers {
    /// Schedule.
    fn set(&self, kind: TimerKind, id: &str, ms: i64);
    /// Clear (nothing when it is not set).
    fn clear(&self, kind: TimerKind, id: &str);
}

/// `ApprovalEvents.emit(name, payload)`: `approval.requested` (with the nonce, for the surfaces that may decide; an RPC
/// mapper drops it), `approval.parked`, `approval.resolved`, `grant.changed`. A listener never breaks a decision.
pub trait ApprovalEvents {
    /// One event.
    fn emit(&self, name: &str, payload: &Value);
}

/// `recurring` of an ask: the user-chosen job name shown with a recurring task's request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recurring {
    /// The job.
    pub job_id: String,
    /// Its name (flattened and cut before it is shown).
    pub job_name: String,
}

/// `ApprovalAsk`: what the dispatcher hands the port for an `ask` decision.
#[derive(Clone, Debug)]
pub struct Ask {
    /// `decide()`'s `ApprovalRequest` (capability, effect, risk, reversible, flags, surfaces, grant options, taint, hash).
    pub request: Value,
    /// The call.
    pub call_id: String,
    /// The tool.
    pub tool: String,
    /// The raw arguments (only their canonical hash, size and redacted summary are kept).
    pub args: Value,
    /// The agent.
    pub agent_id: String,
    /// The person on whose behalf the call runs.
    pub principal: String,
    /// The session.
    pub session_id: Option<String>,
    /// Headless: nobody is asked and nothing parks.
    pub park: bool,
    /// The abort signal had already fired.
    pub aborted: bool,
    /// `subjectKind` (default `agent`).
    pub subject_kind: Option<String>,
    /// The turn (default: the call id).
    pub turn_id: Option<String>,
    /// The task.
    pub task_id: Option<String>,
    /// The project.
    pub project_id: Option<String>,
    /// The canonical targets (members that are not strings are dropped, as in TypeScript).
    pub targets: Option<Vec<Value>>,
    /// `read` or `write`.
    pub access: Option<String>,
    /// The model's own why (unverified; redacted before it is stored).
    pub reason: Option<String>,
    /// A diff the model supplied (unverified; redacted before it is stored).
    pub diff: Option<String>,
    /// From a recurring task.
    pub recurring: Option<Recurring>,
    /// `publicPeerTrust` (for the A2A trust display port).
    pub public_peer_trust: Option<Value>,
}

/// `ApprovalAnswer`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Answer {
    /// Only `true` when a person approved.
    pub approved: bool,
    /// The foreground wait ran out; the request is still open.
    pub parked: bool,
    /// The request.
    pub request_id: Option<String>,
    /// Why not (a sentence for the model; no secret).
    pub reason: Option<String>,
    /// The scope the person chose.
    pub scope: Option<GrantScope>,
    /// The grants the decision created.
    pub grant_ids: Vec<String>,
}

/// `ServiceDecideDenial`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceDenial {
    /// A store denial.
    Store(Denial),
    /// `scope-unavailable`.
    ScopeUnavailable,
}

impl ServiceDenial {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            ServiceDenial::Store(d) => d.as_str(),
            ServiceDenial::ScopeUnavailable => "scope-unavailable",
        }
    }
}

/// `ServiceDecideInput`.
#[derive(Clone, Debug, Default)]
pub struct ServiceDecide {
    /// The request.
    pub request_id: String,
    /// Its nonce (ignored by [`ApprovalService::decide_for_session`]).
    pub nonce: String,
    /// `true` approve, `false` deny.
    pub approve: bool,
    /// Who decides.
    pub person: String,
    /// On which surface (`SurfaceTrust`; anything above 3 is not a surface).
    pub surface: u8,
    /// `once` when `None`; ignored for a denial. Any string: an unknown one is refused.
    pub scope: Option<String>,
    /// "Allow for this task, including helpers" (D104).
    pub delegable: bool,
    /// `shell.exec` without a sandbox, knowingly accepted (Q17).
    pub acknowledged_unsandboxed: bool,
    /// `attested:<method>`; only [`ApprovalService::decide_for_session`] keeps it.
    pub attested_via: Option<String>,
}

/// A successful decision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decided {
    /// Approved or denied.
    pub approved: bool,
    /// The scope of an approval.
    pub scope: Option<GrantScope>,
    /// The grants it created.
    pub grant_ids: Vec<String>,
}

/// `peerTrustDisplay`: the A2A trust coordinates shown instead of the arguments; `Err` when an ask carries a trust display
/// that does not check out (the request then fails, not approved).
pub type PeerTrust = Box<dyn Fn(&Ask) -> Result<Option<String>, ()>>;

/// `canonicalJson(args)`; `None` where the arguments cannot be serialised.
pub type Canonical = Box<dyn Fn(&Value) -> Option<String>>;

/// The service's ports beyond clock, timers and events.
pub struct ServicePorts {
    /// `canonicalJson(args)` (the dispatcher's canonicaliser, `plur1bus_canon::canonical_json` at the flip).
    pub canonical: Canonical,
    /// The redactor (`createRedactor({ secrets })`).
    pub redactor: Box<dyn TextRedactor>,
    /// `peerTrustDisplay`.
    pub peer_trust: PeerTrust,
}

/// What `policyContext` needs of the dispatch context.
#[derive(Clone, Debug, Default)]
pub struct DispatchContext {
    /// The principal.
    pub principal: String,
    /// The agent.
    pub agent_id: String,
    /// The task.
    pub task_id: Option<String>,
    /// The session.
    pub session_id: Option<String>,
}

type Waiter = Box<dyn FnOnce(Answer)>;

/// `createApprovalService`.
pub struct ApprovalService {
    stores: PermissionStores,
    clock: Arc<dyn Clock>,
    timers: Box<dyn Timers>,
    events: Option<Box<dyn ApprovalEvents>>,
    foreground_ms: i64,
    ports: ServicePorts,
    /// The waiting calls, each with the number of its arrival.
    waiters: HashMap<String, (u64, Waiter)>,
    waiter_seq: u64,
    expiry: HashSet<String>,
    code_root_sessions: HashMap<String, Box<dyn Fn() -> bool>>,
}

const HOUR_MS: f64 = 60.0 * 60_000.0;
const MAX_SUMMARY: usize = 2048;
const MAX_REASON: usize = 2048;
const MAX_DIFF: usize = 8192;
const MAX_TARGETS: usize = 50;
const MAX_JOB_NAME: usize = 80;

/// Why a decision transaction did not commit.
enum Inner {
    Approval(ApprovalError),
    Grant(GrantError),
}

impl From<StoreError> for Inner {
    fn from(e: StoreError) -> Self {
        Inner::Approval(e.into())
    }
}

impl From<ApprovalError> for Inner {
    fn from(e: ApprovalError) -> Self {
        Inner::Approval(e)
    }
}

impl From<GrantError> for Inner {
    fn from(e: GrantError) -> Self {
        Inner::Grant(e)
    }
}

/// `text.slice(0, n)` over UTF-16 units; a cut through a surrogate pair keeps neither half (a Rust string cannot hold a
/// lone surrogate, which JavaScript would keep).
fn slice_units(text: &str, n: usize) -> String {
    let mut units = 0;
    for (i, c) in text.char_indices() {
        units += c.len_utf16();
        if units > n {
            return text[..i].to_owned();
        }
    }
    text.to_owned()
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The job name flattened: runs of control, zero-width, line-separator and bidi characters become one space; trimmed.
fn flatten_job_name(name: &str) -> String {
    let hidden = |c: char| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2066}'..='\u{2069}');
    let mut out = String::with_capacity(name.len());
    let mut in_run = false;
    for c in name.chars() {
        if hidden(c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    slice_units(out.trim_matches(crate::js::is_js_space), MAX_JOB_NAME)
}

/// `taskKeyOf(taskId, sessionId)`.
fn task_key(task: Option<&str>, session: Option<&str>) -> String {
    task.or(session).unwrap_or("-").to_owned()
}

/// `bindingOf(ask)`.
pub fn binding_of(ask: &Ask) -> Binding {
    Binding {
        action_hash: ask.request["actionHash"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        principal: ask.principal.clone(),
        subject_kind: ask
            .subject_kind
            .clone()
            .unwrap_or_else(|| "agent".to_owned()),
        subject_id: ask.agent_id.clone(),
        turn_id: ask.turn_id.clone().unwrap_or_else(|| ask.call_id.clone()),
        task_id: task_key(ask.task_id.as_deref(), ask.session_id.as_deref()),
        session_id: ask.session_id.clone().unwrap_or_else(|| "-".to_owned()),
    }
}

/// `String(v)` of a JSON value: arrays join their members with commas (`null` as nothing), objects are
/// `[object Object]`.
fn js_string(v: &J) -> String {
    match v {
        J::Null => "null".to_owned(),
        J::Bool(b) => b.to_string(),
        J::Num(n) => crate::metrics::registry::js_number_to_string(*n),
        J::Str(s) => s.clone(),
        J::Arr(a) => a
            .iter()
            .map(|x| {
                if *x == J::Null {
                    String::new()
                } else {
                    js_string(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        J::Obj(_) => "[object Object]".to_owned(),
    }
}

/// `parentOf(p)`: the directory of a canonical path; a path grant is narrowed to the direct children of the target's
/// directory, never wider. `None` for a root-level target, a drive root or a path that ends in a separator.
///
/// TypeScript reads it with `/^(.*)[\\/][^\\/]+$/`: the greedy `(.*)` ends at the last separator, `[^\\/]+$` takes the rest
/// (line terminators included), and `.` without the `s` flag matches no line terminator (`\n`, `\r`, U+2028, U+2029). A
/// directory part holding one of them is no match, so no directory and no path grant (review B, RB-2).
pub fn parent_of(p: &str) -> Option<&str> {
    let k = p.rfind(['/', '\\'])?;
    if k + 1 >= p.len() {
        return None;
    }
    let dir = &p[..k];
    if dir.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    let b = dir.as_bytes();
    let drive = b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
    (!dir.is_empty() && !drive).then_some(dir)
}

fn risk_of(s: Option<&str>) -> Risk {
    // Only "low" matters to `surfaceMayDecide` (the T1 rule); an unknown spelling is treated as not low.
    RISKS
        .into_iter()
        .find(|r| Some(r.as_str()) == s)
        .unwrap_or(Risk::Medium)
}

fn obj(members: Vec<(&str, Value)>) -> Value {
    let mut m = Map::new();
    for (k, v) in members {
        m.insert(k.to_owned(), v);
    }
    Value::Object(m)
}

impl ApprovalService {
    /// `createApprovalService(o)`.
    pub fn new(
        stores: PermissionStores,
        clock: Arc<dyn Clock>,
        timers: Box<dyn Timers>,
        events: Option<Box<dyn ApprovalEvents>>,
        foreground_ms: Option<i64>,
        ports: ServicePorts,
    ) -> Self {
        ApprovalService {
            stores,
            clock,
            timers,
            events,
            foreground_ms: foreground_ms.unwrap_or(DEFAULT_FOREGROUND_WAIT_MS),
            ports,
            waiters: HashMap::new(),
            waiter_seq: 0,
            expiry: HashSet::new(),
            code_root_sessions: HashMap::new(),
        }
    }

    /// The stores (the RPC grant handlers share them).
    pub fn stores(&mut self) -> &mut PermissionStores {
        &mut self.stores
    }

    /// An audit line the caller must not act without.
    fn rec(audit: &mut dyn AuditPort, action: &str, f: &Value) -> Result<(), ApprovalError> {
        audit.record(action, f).map_err(ApprovalError::Audit)
    }

    /// An audit line about something already refused: never turns a refusal into a failure.
    fn rec_soft(audit: &mut dyn AuditPort, action: &str, f: &Value) {
        let _ = audit.record(action, f);
    }

    fn emit(&self, name: &str, payload: &Value) {
        if let Some(e) = &self.events {
            e.emit(name, payload);
        }
    }

    fn integrity_failure(audit: &mut dyn AuditPort, e: &ApprovalError) {
        if let ApprovalError::Integrity { broken_at, reason } = e {
            Self::rec_soft(
                audit,
                "approvals.integrity-failure",
                &obj(vec![
                    ("brokenAt", num_value(*broken_at)),
                    ("failure", json!(reason.as_str())),
                ]),
            );
        }
    }

    fn finish(&mut self, id: &str, answer: Answer) {
        if let Some(w) = self.waiters.remove(id) {
            self.timers.clear(TimerKind::Foreground, id);
            (w.1)(answer);
        }
    }

    fn not_approved(id: &str, reason: &str) -> Answer {
        Answer {
            request_id: Some(id.to_owned()),
            reason: Some(reason.to_owned()),
            ..Answer::default()
        }
    }

    fn fail_all(&mut self, reason: &str) {
        // In the order the requests came, as TypeScript's `Map` iterates (review B, H-1).
        let mut ids: Vec<(u64, String)> = self
            .waiters
            .iter()
            .map(|(id, w)| (w.0, id.clone()))
            .collect();
        ids.sort_unstable();
        let ids = ids.into_iter().map(|(_, id)| id);
        for id in ids {
            self.finish(&id, Self::not_approved(&id, reason));
        }
    }

    fn clear_expiry(&mut self, id: &str) {
        if self.expiry.remove(id) {
            self.timers.clear(TimerKind::Expiry, id);
        }
    }

    /// `viewOf(r)`: what a surface is shown; never the nonce or the raw arguments.
    pub fn view_of(r: &ApprovalRecord) -> Value {
        let d = r.detail.as_ref();
        let dv = |k: &str| d.and_then(|d| d.get(k)).map(J::to_value);
        let mut m = Map::new();
        let mut put = |k: &str, v: Option<Value>| {
            if let Some(v) = v {
                m.insert(k.to_owned(), v);
            }
        };
        let b = &r.bound;
        put("id", Some(json!(r.id)));
        put("status", Some(json!(r.status.as_str())));
        put("capability", Some(json!(r.capability)));
        for k in ["tool", "effect", "risk", "reversible"] {
            put(k, dv(k));
        }
        put("principal", Some(json!(b.principal)));
        put(
            "subject",
            Some(json!({ "kind": b.subject_kind, "id": b.subject_id })),
        );
        put("actionHash", Some(json!(b.action_hash)));
        put("turnId", Some(json!(b.turn_id)));
        put("taskId", Some(json!(b.task_id)));
        put("sessionId", Some(json!(b.session_id)));
        for k in [
            "requiredSurface",
            "originSurface",
            "grantOptions",
            "tainted",
            "taintSuspended",
            "flags",
            "targets",
            "summary",
            "agentReason",
            "diff",
        ] {
            put(k, dv(k));
        }
        put("createdAt", Some(num_value(r.created_at)));
        put("expiresAt", Some(num_value(r.expires_at)));
        put("delegable", Some(json!(r.delegable)));
        put("decidedAt", r.decided_at.map(num_value));
        put("decidedBy", r.decided_by.clone().map(Value::String));
        put(
            "decisionSurface",
            r.decision_surface.as_ref().map(J::to_value),
        );
        put("usedAt", r.used_at.map(num_value));
        put("cancelledAt", r.cancelled_at.map(num_value));
        Value::Object(m)
    }

    fn safe_view(&self, id: &str) -> Option<Value> {
        self.stores
            .approval(id)
            .ok()
            .flatten()
            .map(|r| Self::view_of(&r))
    }

    /// `detailOf(ask)`: what the harness computed about the request, chained with it so a decision after a restart can be
    /// checked without memory. `Err` when the A2A trust display does not check out.
    fn detail_of(&self, ask: &Ask) -> Result<(J, Vec<String>, bool), ()> {
        let req = &ask.request;
        let redact = |t: &str| self.ports.redactor.text(t);
        let mut summary = "(arguments could not be shown)".to_owned();
        let (mut hash, mut bytes) = (String::new(), 0usize);
        if let Some(text) = (self.ports.canonical)(&ask.args) {
            let (h, b) = hash_and_size(&text);
            (hash, bytes) = (h, b);
            let head = if units(&text) > 8192 {
                slice_units(&text, 8192)
            } else {
                text
            };
            summary = slice_units(&redact(&head), MAX_SUMMARY);
        }
        if let Some(r) = &ask.recurring {
            let name = flatten_job_name(&r.job_name);
            summary = slice_units(
                &format!(
                    "{}: {summary}",
                    redact(&format!("aus wiederkehrender Aufgabe {name}"))
                ),
                MAX_SUMMARY,
            );
        }
        let all: Vec<&str> = ask
            .targets
            .iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let shown: Vec<&str> = all.iter().take(MAX_TARGETS).copied().collect();
        let masked: Vec<String> = shown.iter().map(|t| redact(t)).collect();
        let targets_masked =
            masked.iter().zip(&shown).any(|(m, s)| m != s) || all.len() > shown.len();
        let mut flags = J::Obj(Vec::new());
        if let Some(f) = req["flags"].as_object() {
            for (k, v) in f {
                if let Some(b) = v.as_bool() {
                    flags.set(k, J::Bool(b));
                }
            }
        }
        let public_trust = (self.ports.peer_trust)(ask)?;
        let options: Vec<J> = req["grantOptions"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|g| {
                J::obj([
                    ("scope", J::from_value(&g["scope"])),
                    ("requiredSurface", J::from_value(&g["requiredSurface"])),
                ])
            })
            .collect();
        let v = |k: &str| J::from_value(&req[k]);
        let mut d = J::obj([
            ("tool", J::s(&ask.tool)),
            ("effect", v("effect")),
            ("risk", v("risk")),
            ("reversible", v("reversible")),
            ("flags", flags),
            ("requiredSurface", v("requiredSurface")),
            ("originSurface", v("originSurface")),
            ("grantOptions", J::Arr(options)),
            ("tainted", v("tainted")),
            ("taintSuspended", v("taintSuspended")),
            ("agentId", J::s(&ask.agent_id)),
            ("callId", J::s(&ask.call_id)),
            ("targets", J::Arr(masked.iter().map(|t| J::s(t)).collect())),
            ("targetsMasked", J::Bool(targets_masked)),
            ("targetsTotal", J::Num(all.len() as f64)),
        ]);
        if let Some(a) = &ask.access {
            d.set("access", J::s(a));
        }
        d.set("summary", J::s(public_trust.as_deref().unwrap_or(&summary)));
        d.set("argsBytes", J::Num(bytes as f64));
        d.set("payloadHash", J::s(&hash));
        if let Some(r) = ask.reason.as_deref().filter(|r| !r.is_empty()) {
            d.set("agentReason", J::s(&slice_units(&redact(r), MAX_REASON)));
        }
        match (&public_trust, ask.diff.as_deref().filter(|x| !x.is_empty())) {
            (Some(t), _) => d.set("diff", J::s(t)),
            (None, Some(diff)) => d.set("diff", J::s(&slice_units(&redact(diff), MAX_DIFF))),
            (None, None) => {}
        }
        for (k, val) in [
            ("taskId", &ask.task_id),
            ("sessionId", &ask.session_id),
            ("projectId", &ask.project_id),
        ] {
            if let Some(val) = val {
                d.set(k, J::s(val));
            }
        }
        Ok((d, masked, false))
    }

    /// `auditFieldsOf(ask, extra)`.
    fn audit_fields(ask: &Ask, extra: Vec<(&str, Value)>) -> Value {
        let req = &ask.request;
        let mut f = vec![
            ("person", json!(ask.principal)),
            ("agentId", json!(ask.agent_id)),
            (
                "subjectKind",
                json!(ask.subject_kind.as_deref().unwrap_or("agent")),
            ),
        ];
        if let Some(s) = ask.session_id.as_deref().filter(|s| !s.is_empty()) {
            f.push(("sessionId", json!(s)));
        }
        if let Some(t) = ask.task_id.as_deref().filter(|t| !t.is_empty()) {
            f.push(("taskId", json!(t)));
        }
        f.extend([
            ("tool", json!(ask.tool)),
            ("capability", req["capability"].clone()),
            ("effect", req["effect"].clone()),
            ("risk", req["risk"].clone()),
            ("actionHash", req["actionHash"].clone()),
            ("surface", req["originSurface"].clone()),
        ]);
        let mut v = obj(f);
        if let Some(m) = v.as_object_mut() {
            for (k, x) in extra {
                m.insert(k.to_owned(), x);
            }
        }
        v
    }

    // ---- request / park ----

    /// `request(ask)`: parks the call; `on_answer` receives the one answer (at once for a refusal, later for a decision).
    pub fn request(
        &mut self,
        audit: &mut dyn AuditPort,
        ask: &Ask,
        on_answer: Box<dyn FnOnce(Answer)>,
    ) {
        if ask.park {
            Self::rec_soft(
                audit,
                "approval.refused",
                &Self::audit_fields(ask, vec![("reason", json!("headless"))]),
            );
            on_answer(Answer {
                reason: Some("headless run without a job-bound standing grant: nothing is asked and nothing parks".to_owned()),
                ..Answer::default()
            });
            return;
        }
        if ask.aborted {
            on_answer(Answer {
                reason: Some("aborted".to_owned()),
                ..Answer::default()
            });
            return;
        }
        let bound = binding_of(ask);
        let made = match self.detail_of(ask) {
            Err(()) => Err(ApprovalError::Invalid(
                "invalid public trust display".to_owned(),
            )),
            Ok((detail, targets, _)) => {
                let input = RequestInput {
                    bound: bound.clone(),
                    capability: ask.request["capability"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    detail: Some(detail.clone()),
                };
                self.stores.write(|tx, a, _| {
                    let r = a.request(tx, &input)?;
                    let mut extra = vec![
                        ("requestId", json!(r.id)),
                        ("targets", json!(targets)),
                        (
                            "flags",
                            detail.get("flags").map_or(Value::Null, J::to_value),
                        ),
                        ("expiresAt", json!(r.expires_at)),
                        (
                            "argsBytes",
                            detail.get("argsBytes").map_or(Value::Null, J::to_value),
                        ),
                        (
                            "payloadHash",
                            detail.get("payloadHash").map_or(Value::Null, J::to_value),
                        ),
                        (
                            "payloadBytes",
                            detail.get("argsBytes").map_or(Value::Null, J::to_value),
                        ),
                    ];
                    if ask.task_id.is_none() {
                        extra.push(("taskId", json!(bound.task_id)));
                    }
                    Self::rec(audit, "approval.requested", &Self::audit_fields(ask, extra))?;
                    Ok::<_, ApprovalError>(r)
                })
            }
        };
        let made = match made {
            Ok(m) => m,
            Err(e) => {
                Self::integrity_failure(audit, &e);
                let reason = if matches!(e, ApprovalError::Integrity { .. }) {
                    "the approval store failed its integrity check: nothing was approved"
                } else {
                    "the approval service is unavailable: nothing was approved"
                };
                on_answer(Answer {
                    reason: Some(reason.to_owned()),
                    ..Answer::default()
                });
                return;
            }
        };
        let id = made.id.clone();
        self.waiter_seq += 1;
        self.waiters
            .insert(id.clone(), (self.waiter_seq, on_answer));
        self.timers
            .set(TimerKind::Foreground, &id, self.foreground_ms);
        self.timers.set(
            TimerKind::Expiry,
            &id,
            (made.expires_at - self.clock.now()).max(0),
        );
        self.expiry.insert(id.clone());
        if let Some(view) = self.safe_view(&id) {
            let until = self.clock.now() + self.foreground_ms;
            self.emit(
                "approval.requested",
                &json!({ "approval": view, "nonce": made.nonce, "foregroundUntil": until }),
            );
        }
    }

    /// A timer the host scheduled is due.
    pub fn fire(&mut self, audit: &mut dyn AuditPort, kind: TimerKind, id: &str) {
        match kind {
            TimerKind::Foreground => self.park(audit, id),
            TimerKind::Expiry => self.on_expiry(audit, id),
        }
    }

    fn park(&mut self, audit: &mut dyn AuditPort, id: &str) {
        if !self.waiters.contains_key(id) {
            return;
        }
        self.finish(
            id,
            Answer {
                parked: true,
                request_id: Some(id.to_owned()),
                reason: Some(format!("parked: waiting for the person to approve request {id}; continue with work that does not need it")),
                ..Answer::default()
            },
        );
        let view = self.safe_view(id);
        let mut f = vec![("requestId", json!(id))];
        if let Some(v) = &view {
            f.extend([
                ("person", v["principal"].clone()),
                ("tool", v.get("tool").cloned().unwrap_or(json!(""))),
                ("capability", v["capability"].clone()),
                ("actionHash", v["actionHash"].clone()),
            ]);
        }
        Self::rec_soft(audit, "approval.parked", &obj(f));
        if let Some(v) = view {
            self.emit("approval.parked", &json!({ "approval": v }));
        }
    }

    fn on_expiry(&mut self, audit: &mut dyn AuditPort, id: &str) {
        self.expiry.remove(id);
        let r = match self.stores.approval(id) {
            Ok(r) => r,
            Err(e) => {
                Self::integrity_failure(audit, &e);
                self.finish(
                    id,
                    Self::not_approved(id, "the approval store failed its integrity check"),
                );
                return;
            }
        };
        let Some(r) = r else { return };
        let now = self.clock.now() as f64;
        if r.status == Status::Pending && now < r.expires_at {
            self.timers
                .set(TimerKind::Expiry, id, (r.expires_at - now) as i64);
            self.expiry.insert(id.to_owned());
            return;
        }
        if r.status != Status::Expired {
            return;
        }
        self.code_root_sessions.remove(id);
        self.finish(
            id,
            Self::not_approved(
                id,
                "the approval request expired; nothing is ever approved automatically",
            ),
        );
        let b = &r.bound;
        Self::rec_soft(
            audit,
            "approval.expired",
            &json!({ "requestId": id, "person": b.principal, "capability": r.capability, "actionHash": b.action_hash }),
        );
        self.emit(
            "approval.resolved",
            &json!({ "approval": Self::view_of(&r), "outcome": "expired" }),
        );
    }

    /// The call's abort signal fired: not approved, and the request is cancelled.
    pub fn abort(&mut self, audit: &mut dyn AuditPort, id: &str) {
        if !self.waiters.contains_key(id) {
            return;
        }
        self.finish(id, Self::not_approved(id, "aborted"));
        self.close_aborted(audit, id);
    }

    fn close_aborted(&mut self, audit: &mut dyn AuditPort, id: &str) {
        let r = self.stores.write(|tx, a, _| {
            let c = a.cancel(tx, id, "abort")?;
            if c.is_ok() {
                Self::rec(
                    audit,
                    "approval.cancelled",
                    &json!({ "requestId": id, "by": "abort" }),
                )?;
            }
            Ok::<_, ApprovalError>(c)
        });
        match r {
            Ok(c) => {
                self.clear_expiry(id);
                self.code_root_sessions.remove(id);
                if c.is_ok() {
                    if let Some(v) = self.safe_view(id) {
                        self.emit(
                            "approval.resolved",
                            &json!({ "approval": v, "outcome": "cancelled" }),
                        );
                    }
                }
            }
            Err(e) => Self::integrity_failure(audit, &e),
        }
    }

    // ---- decide ----

    #[allow(clippy::too_many_arguments)]
    fn create_grants(
        tx: &Connection,
        chain: &crate::approvals::chain::ApprovalChain,
        grants: &GrantStore,
        audit: &mut dyn AuditPort,
        r: &ApprovalRecord,
        d: &J,
        input: &ServiceDecide,
        scope: GrantScope,
    ) -> Result<Vec<String>, GrantError> {
        let invalid = |m: &str| GrantError::Refused {
            code: GrantErrorCode::InvalidGrant,
            message: m.to_owned(),
        };
        let b = &r.bound;
        let ds = |k: &str| d.get(k).and_then(J::as_str).map(str::to_owned);
        // An id of the detail as TypeScript hands it to the store: a string as it is; a number fails the store's check
        // for the scope that needs that id, and is otherwise written as SQLite writes a REAL into a text column ("7.0").
        let id_of = |k: &str, needed_by: &str| match d.get(k) {
            Some(J::Str(v)) => Some(v.clone()),
            Some(J::Num(n)) if scope.as_str() != needed_by => tx
                .query_row("SELECT CAST(?1 AS TEXT)", [*n], |r| r.get::<_, String>(0))
                .ok(),
            _ => None,
        };
        let base = |cap: &str, scope: &str, m: GrantMatch| {
            let mut i = CreateGrantInput::new(
                cap,
                &b.principal,
                &b.subject_id,
                scope,
                m,
                &input.person,
                input.surface,
            );
            i.effect = ds("effect");
            i.delegable = input.delegable;
            i.project_id = id_of("projectId", "");
            i.task_id = id_of("taskId", "task");
            i.session_id = id_of("sessionId", "session");
            i.acknowledged_unsandboxed = input.acknowledged_unsandboxed;
            i.attested_via = input.attested_via.clone();
            i
        };
        // `d.targets` as TypeScript uses it (review B, RB-5): an array's members go through `String()` into the expression
        // of `parentOf`; a value whose `length` is 0 (an empty string, `{ length: 0 }`) asks for a capability grant; no value
        // at all throws at `.length`, any other value at `.map`. A stored detail is written by `detailOf` alone today, always
        // with an array of strings; this reads one of another shape the way TypeScript does instead of widening it.
        let type_error = |m: &str| GrantError::Storage(format!("TypeError: {m}"));
        let raw_targets = d.get("targets");
        let targets: Vec<String> = match raw_targets {
            Some(J::Arr(a)) => a.iter().map(js_string).collect(),
            _ => Vec::new(),
        };
        let length_zero = match raw_targets {
            Some(J::Arr(a)) => a.is_empty(),
            Some(J::Str(s)) => s.is_empty(),
            Some(o @ J::Obj(_)) => o.get("length") == Some(&J::Num(0.0)),
            _ => false,
        };
        let no_targets = matches!(raw_targets, None | Some(J::Null));
        let masked = d.get("targetsMasked") == Some(&J::Bool(true));
        if ds("origin").as_deref() == Some("code-session-root") {
            let target = targets.first().cloned().unwrap_or_default();
            if scope != GrantScope::Session
                || input.delegable
                || masked
                || targets.len() != 1
                || ds("access").as_deref() != Some("write")
                || grants.reaches_system_tree(&target, true)
            {
                return Err(invalid(
                    "code folder grants are exact, non-delegable and session-only",
                ));
            }
            let mut out = Vec::new();
            for cap in ["fs.write", "fs.read"] {
                let access = if cap == "fs.write" { "write" } else { "read" };
                let mut i = base(
                    cap,
                    "session",
                    GrantMatch::Path {
                        path: target.clone(),
                        access: access.into(),
                        recursive: true,
                    },
                );
                i.effect = Some(
                    if cap == "fs.write" {
                        "local-write"
                    } else {
                        "read"
                    }
                    .to_owned(),
                );
                i.delegable = false;
                let g = grants.create(tx, chain, audit, &i)?;
                out.push(g["id"].as_str().unwrap_or_default().to_owned());
            }
            return Ok(out);
        }
        if scope == GrantScope::Once {
            let mut i = base(&r.capability, "once", GrantMatch::Action);
            i.action_hash = Some(b.action_hash.clone());
            return match grants.create(tx, chain, audit, &i) {
                Ok(g) => Ok(vec![g["id"].as_str().unwrap_or_default().to_owned()]),
                // A capability that takes no standing grant is still approvable for this one call: the request itself is
                // the single-use record.
                Err(GrantError::Refused {
                    code: GrantErrorCode::CeilingExceeded,
                    ..
                }) => Ok(Vec::new()),
                Err(e) => Err(e),
            };
        }
        if scope == GrantScope::Task && d.get("taskId").is_none() {
            return Err(invalid("a task grant needs a task id"));
        }
        if scope == GrantScope::Session && d.get("sessionId").is_none() {
            return Err(invalid("a session grant needs a session id"));
        }
        if no_targets {
            return Err(type_error(
                "Cannot read properties of undefined (reading 'length')",
            ));
        }
        if length_zero {
            let g = grants.create(
                tx,
                chain,
                audit,
                &base(&r.capability, scope.as_str(), GrantMatch::Capability),
            )?;
            return Ok(vec![g["id"].as_str().unwrap_or_default().to_owned()]);
        }
        // §8: narrowed to the call's own targets. Never from a masked or truncated list: that is not what the person was shown.
        if masked {
            return Err(invalid(
                "the targets were masked or truncated; only a once grant is possible",
            ));
        }
        if !matches!(raw_targets, Some(J::Arr(_))) {
            return Err(type_error("d.targets.map is not a function"));
        }
        // `d.access ?? (...)`: a value of another type is handed on, and the store refuses it.
        let access = d
            .get("access")
            .filter(|a| **a != J::Null)
            .map(js_string)
            .unwrap_or_else(|| {
                if ds("effect").as_deref() == Some("read") {
                    "read"
                } else {
                    "write"
                }
                .to_owned()
            });
        let mut dirs: Vec<Option<&str>> = Vec::new();
        for t in &targets {
            let p = parent_of(t);
            if !dirs.contains(&p) {
                dirs.push(p);
            }
        }
        if dirs.iter().any(Option::is_none) {
            return Err(invalid("a target has no directory to grant"));
        }
        let mut out = Vec::new();
        for dir in dirs.into_iter().flatten() {
            let m = GrantMatch::Path {
                path: dir.to_owned(),
                access: access.clone(),
                recursive: false,
            };
            let g = grants.create(tx, chain, audit, &base(&r.capability, scope.as_str(), m))?;
            out.push(g["id"].as_str().unwrap_or_default().to_owned());
        }
        Ok(out)
    }

    fn decide_core(
        &mut self,
        audit: &mut dyn AuditPort,
        input: &ServiceDecide,
    ) -> Result<Result<Decided, ServiceDenial>, ApprovalError> {
        let refuse = |audit: &mut dyn AuditPort, reason: ServiceDenial| {
            let mut f = vec![
                ("person", json!(input.person)),
                ("requestId", json!(input.request_id)),
                (
                    "decision",
                    json!(if input.approve { "approve" } else { "deny" }),
                ),
            ];
            if let Some(s) = &input.scope {
                f.push(("scope", json!(s)));
            }
            f.extend([
                ("decisionSurface", json!(input.surface)),
                ("reason", json!(reason.as_str())),
            ]);
            Self::rec_soft(audit, "approval.refused", &obj(f));
            Ok(Err(reason))
        };
        if input.surface > 3 {
            return refuse(audit, ServiceDenial::Store(Denial::SurfaceUntrusted));
        }
        let r = match self.stores.approval(&input.request_id) {
            Ok(r) => r,
            Err(e) => {
                Self::integrity_failure(audit, &e);
                self.fail_all("the approval store failed its integrity check");
                return Err(e);
            }
        };
        let Some(r) = r.filter(|r| r.bound.principal == input.person) else {
            return refuse(audit, ServiceDenial::Store(Denial::Mismatch));
        };
        let scope_text = input.scope.clone().unwrap_or_else(|| "once".to_owned());
        let d = r.detail.clone();
        let dget = |k: &str| d.as_ref().and_then(|d| d.get(k));
        if input.approve {
            if dget("origin").and_then(J::as_str) == Some("code-session-root") {
                if scope_text != "session" || input.delegable {
                    return refuse(audit, ServiceDenial::ScopeUnavailable);
                }
                if !self
                    .code_root_sessions
                    .get(&r.id)
                    .is_some_and(|active| active())
                {
                    return refuse(audit, ServiceDenial::Store(Denial::Mismatch));
                }
            }
            let def = capability(&r.capability);
            let Some(scope) = GrantScope::parse(&scope_text) else {
                return refuse(audit, ServiceDenial::ScopeUnavailable);
            };
            let (Some(def), Some(risk), Some(flags)) =
                (def, dget("risk").and_then(J::as_str), dget("flags"))
            else {
                return refuse(audit, ServiceDenial::Store(Denial::SurfaceUntrusted));
                // fail closed: no detail, no approval
            };
            let offered = matches!(dget("grantOptions"), Some(J::Arr(o)) if o.iter().any(|o| o.get("scope").and_then(J::as_str) == Some(scope_text.as_str())));
            if !offered {
                return refuse(audit, ServiceDenial::ScopeUnavailable);
            }
            if !matches!(input.surface, 1..=3) {
                return refuse(audit, ServiceDenial::Store(Denial::SurfaceUntrusted));
            }
            let flags = Flags::of(&flags.to_value());
            if scope > max_scope_for(def, flags) {
                return refuse(audit, ServiceDenial::ScopeUnavailable);
            }
            if !surface_may_decide(
                &r.capability,
                risk_of(Some(risk)),
                flags,
                input.surface,
                scope,
            ) {
                return refuse(audit, ServiceDenial::Store(Denial::SurfaceUntrusted));
            }
        }
        let scope = GrantScope::parse(&scope_text).unwrap_or(GrantScope::Once);
        let detail = d.clone().unwrap_or(J::Null);
        let out = self.stores.write(|tx, a, g| {
            let store_input = DecideInput {
                request_id: input.request_id.clone(),
                nonce: input.nonce.clone(),
                approve: input.approve,
                person: input.person.clone(),
                surface: input.surface,
                delegable: input.delegable,
            };
            let res = a.decide(tx, &store_input)?;
            if res.is_err() {
                return Ok::<_, Inner>((res, Vec::new()));
            }
            let grant_ids = if input.approve {
                Self::create_grants(tx, &a.chain, g, audit, &r, &detail, input, scope)?
            } else {
                Vec::new()
            };
            let b = &r.bound;
            let mut f = vec![
                ("person", json!(input.person)),
                ("requestId", json!(input.request_id)),
                (
                    "decision",
                    json!(if input.approve { "approve" } else { "deny" }),
                ),
            ];
            if input.approve {
                f.push(("scope", json!(scope.as_str())));
            }
            f.extend([
                ("decisionSurface", json!(input.surface)),
                ("capability", json!(r.capability)),
                ("actionHash", json!(b.action_hash)),
                ("agentId", json!(b.subject_id)),
                ("subjectKind", json!(b.subject_kind)),
                ("taskId", json!(b.task_id)),
                ("sessionId", json!(b.session_id)),
            ]);
            for k in ["tool", "risk"] {
                if let Some(v) = detail.get(k).and_then(J::as_str).filter(|v| !v.is_empty()) {
                    f.push((k, json!(v)));
                }
            }
            if let Some(gid) = grant_ids.first() {
                f.push(("grantId", json!(gid)));
            }
            if let Some(a) = &input.attested_via {
                f.push(("attestedVia", json!(a)));
            }
            Self::rec(audit, "approval.decided", &obj(f))?;
            Ok((res, grant_ids))
        });
        let (res, grant_ids) = match out {
            Ok(x) => x,
            // The store is the last line: a path grant that reaches a home or system tree answers surface-too-low below
            // T3, ceiling-exceeded above `task`.
            Err(Inner::Grant(GrantError::Refused { code, .. })) => {
                let why = if code == GrantErrorCode::SurfaceTooLow {
                    ServiceDenial::Store(Denial::SurfaceUntrusted)
                } else {
                    ServiceDenial::ScopeUnavailable
                };
                return refuse(audit, why);
            }
            Err(Inner::Grant(GrantError::Integrity { broken_at, reason }))
            | Err(Inner::Approval(ApprovalError::Integrity { broken_at, reason })) => {
                let e = ApprovalError::Integrity { broken_at, reason };
                Self::integrity_failure(audit, &e);
                self.fail_all("the approval store failed its integrity check");
                return Err(e);
            }
            Err(Inner::Grant(e)) => return Err(ApprovalError::Storage(e.to_string())),
            Err(Inner::Approval(e)) => return Err(e),
        };
        let approved = match res {
            Ok(approved) => approved,
            Err(d) => return refuse(audit, ServiceDenial::Store(d)),
        };
        let id = input.request_id.as_str();
        self.clear_expiry(id);
        self.code_root_sessions.remove(id);
        let answer = if approved {
            Answer {
                approved: true,
                request_id: Some(id.to_owned()),
                scope: Some(scope),
                grant_ids: grant_ids.clone(),
                ..Answer::default()
            }
        } else {
            Self::not_approved(id, "denied by the person")
        };
        self.finish(id, answer);
        if let Some(view) = self.safe_view(id) {
            let mut p = json!({ "approval": view, "outcome": if approved { "approved" } else { "denied" } });
            if approved {
                p["scope"] = json!(scope.as_str());
                p["grantIds"] = json!(grant_ids);
            }
            self.emit("approval.resolved", &p);
        }
        for gid in &grant_ids {
            if let Ok(Some(g)) = self.stores.grant(gid) {
                self.emit(
                    "grant.changed",
                    &json!({ "change": "created", "grantId": g["id"], "person": g["person"], "agent": g["agent"], "capability": g["capability"], "scope": g["scope"] }),
                );
            }
        }
        Ok(Ok(Decided {
            approved,
            scope: approved.then_some(scope),
            grant_ids,
        }))
    }

    /// `decide(input)`: for a surface that holds the nonce (a channel relay). A relayed decision can never carry an
    /// attestation: that field is dropped here.
    pub fn decide(
        &mut self,
        audit: &mut dyn AuditPort,
        input: &ServiceDecide,
    ) -> Result<Result<Decided, ServiceDenial>, ApprovalError> {
        let input = ServiceDecide {
            attested_via: None,
            ..input.clone()
        };
        self.decide_core(audit, &input)
    }

    /// `decideForSession(input)`: for an authenticated surface (RPC session, CLI on a TTY); the nonce stays inside the core
    /// and is read from the projection (the store compares it with the chained one). The caller vouches for person and
    /// surface.
    pub fn decide_for_session(
        &mut self,
        audit: &mut dyn AuditPort,
        input: &ServiceDecide,
    ) -> Result<Result<Decided, ServiceDenial>, ApprovalError> {
        // A blob in the projection's `nonce` is a `Uint8Array` in TypeScript, which the store refuses as no string: a value
        // that matches no nonce stands for it here (review B, RB-3).
        let nonce: Option<String> = self
            .stores
            .conn()
            .query_row(
                "SELECT nonce FROM approvals WHERE id = ?",
                [&input.request_id],
                |r| {
                    Ok(match r.get_ref(0)? {
                        plur1bus_store::rusqlite::types::ValueRef::Text(t) => {
                            String::from_utf8_lossy(t).into_owned()
                        }
                        _ => crate::approvals::chain::BLOB_TEXT.to_owned(),
                    })
                },
            )
            .optional()
            .map_err(ApprovalError::from)?;
        let input = ServiceDecide {
            nonce: nonce.unwrap_or_default(),
            ..input.clone()
        };
        self.decide_core(audit, &input)
    }

    // ---- execution start ----

    /// `begin(answer, ask)`: consumes the approval and its once grants atomically; a replay, another binding or a grant of
    /// someone else is refused (audited), never an error.
    pub fn begin(&mut self, audit: &mut dyn AuditPort, answer: &Answer, ask: &Ask) -> bool {
        let Some(request_id) = answer.request_id.as_deref().filter(|_| answer.approved) else {
            return false;
        };
        let bound = binding_of(ask);
        let action_hash = bound.action_hash.clone();
        let mut used_views = Vec::new();
        let r = self.stores.write(|tx, a, g| {
            let refused = |code: &str| Inner::Approval(ApprovalError::Invalid(code.to_owned()));
            if let Err(d) = a.consume(tx, request_id, &bound)? {
                return Err(refused(d.as_str()));
            }
            for gid in &answer.grant_ids {
                let grant = g.get(tx, &a.chain, gid)?;
                let Some(grant) = grant.filter(|x| {
                    x["person"] == ask.principal.as_str() && x["agent"] == ask.agent_id.as_str()
                }) else {
                    return Err(refused("grant-mismatch"));
                };
                if grant["scope"] == "once" {
                    let ok = match g.consume_once(
                        tx,
                        &a.chain,
                        audit,
                        gid,
                        &ask.principal,
                        &ask.agent_id,
                        &action_hash,
                    ) {
                        Ok(ok) => ok,
                        Err(GrantError::Integrity { .. }) => false,
                        Err(e) => return Err(e.into()),
                    };
                    if !ok {
                        return Err(refused("grant-used"));
                    }
                } else if let Some(v) = g.mark_used(tx, &a.chain, audit, gid)? {
                    used_views.push(v);
                }
            }
            let mut extra = vec![("requestId", json!(request_id))];
            if let Some(gid) = answer.grant_ids.first() {
                extra.push(("grantId", json!(gid)));
            }
            if let Some(s) = answer.scope {
                extra.push(("scope", json!(s.as_str())));
            }
            Self::rec(audit, "approval.consumed", &Self::audit_fields(ask, extra))?;
            Ok::<_, Inner>(())
        });
        match r {
            Ok(()) => {
                for v in &used_views {
                    self.stores.grants.announce_used(v);
                }
                true
            }
            Err(e) => {
                let reason = match &e {
                    Inner::Approval(ApprovalError::Invalid(code)) => code.clone(),
                    Inner::Approval(x) => {
                        Self::integrity_failure(audit, x);
                        "error".to_owned()
                    }
                    Inner::Grant(_) => "error".to_owned(),
                };
                Self::rec_soft(
                    audit,
                    "approval.refused",
                    &Self::audit_fields(
                        ask,
                        vec![("requestId", json!(request_id)), ("reason", json!(reason))],
                    ),
                );
                false
            }
        }
    }

    // ---- reads / cancel / verify ----

    /// `list(filter)`: the views, oldest first.
    pub fn list(
        &self,
        status: Option<Status>,
        principal: Option<&str>,
        task: Option<&str>,
        session: Option<&str>,
    ) -> Result<Vec<Value>, ApprovalError> {
        Ok(self
            .stores
            .approvals(status, principal)?
            .iter()
            .filter(|r| {
                task.is_none_or(|t| r.bound.task_id == t)
                    && session.is_none_or(|s| r.bound.session_id == s)
            })
            .map(Self::view_of)
            .collect())
    }

    /// `get(id, principal)`: with `principal`, a request of another person is `None`, exactly like an unknown id.
    pub fn get(&self, id: &str, principal: Option<&str>) -> Result<Option<Value>, ApprovalError> {
        Ok(self
            .stores
            .approval(id)?
            .filter(|r| principal.is_none_or(|p| r.bound.principal == p))
            .map(|r| Self::view_of(&r)))
    }

    /// `cancel({ requestId, person, by })`: by the request's own person only.
    pub fn cancel(
        &mut self,
        audit: &mut dyn AuditPort,
        id: &str,
        person: &str,
        by: Option<&str>,
    ) -> Result<Result<(), Denial>, ApprovalError> {
        let Some(r) = self
            .stores
            .approval(id)?
            .filter(|r| r.bound.principal == person)
        else {
            return Ok(Err(Denial::Mismatch));
        };
        let by = by.unwrap_or(person);
        let res = self.stores.write(|tx, a, _| {
            let c = a.cancel(tx, id, by)?;
            if c.is_ok() {
                Self::rec(
                    audit,
                    "approval.cancelled",
                    &json!({ "person": person, "requestId": id, "by": by, "capability": r.capability, "actionHash": r.bound.action_hash }),
                )?;
            }
            Ok::<_, ApprovalError>(c)
        })?;
        if res.is_err() {
            return Ok(res);
        }
        self.clear_expiry(id);
        self.code_root_sessions.remove(id);
        self.finish(id, Self::not_approved(id, "cancelled"));
        if let Some(v) = self.safe_view(id) {
            self.emit(
                "approval.resolved",
                &json!({ "approval": v, "outcome": "cancelled" }),
            );
        }
        Ok(Ok(()))
    }

    /// `verify()`: the store's chain check; a failure is audited.
    pub fn verify(&mut self, audit: &mut dyn AuditPort) -> Result<VerifyResult, ApprovalError> {
        let v = self.stores.verify()?;
        if let VerifyResult::Broken {
            broken_at, reason, ..
        } = &v
        {
            Self::rec_soft(
                audit,
                "approvals.integrity-failure",
                &obj(vec![
                    ("brokenAt", num_value(*broken_at)),
                    ("failure", json!(reason.as_str())),
                ]),
            );
        }
        Ok(v)
    }

    // ---- dispatcher context ----

    /// `policyContext(inner)(ctx)`: `base` is what the inner hook returned (an object). Adds `deniedActionHashes` and
    /// `promptsThisHour` from this task's requests, and keeps only the verified `handoff.approvalsHeld` (D104). `Err`
    /// when the store cannot be read or a rejection cannot be audited (the dispatcher then refuses).
    pub fn policy_context(
        &self,
        audit: &mut dyn AuditPort,
        ctx: &DispatchContext,
        base: Value,
    ) -> Result<Value, String> {
        let mut out = match base {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        let pick = |k: &str| out.get(k).and_then(Value::as_str).map(str::to_owned);
        let key = task_key(
            pick("taskId").or_else(|| ctx.task_id.clone()).as_deref(),
            pick("sessionId")
                .or_else(|| ctx.session_id.clone())
                .as_deref(),
        );
        let now = self.clock.now() as f64;
        let records = self
            .stores
            .approvals(None, Some(&ctx.principal))
            .map_err(|e| {
                Self::integrity_failure(audit, &e);
                e.to_string()
            })?;
        let mut denied: Vec<Value> = out
            .get("deniedActionHashes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut prompts = 0.0;
        for r in records.iter().filter(|r| r.bound.task_id == key) {
            if r.status == Status::Denied && !denied.contains(&json!(r.bound.action_hash)) {
                denied.push(json!(r.bound.action_hash));
            }
            if r.created_at > now - HOUR_MS {
                prompts += 1.0;
            }
        }
        let mut seen = Vec::new();
        denied.retain(|d| {
            if seen.contains(d) {
                false
            } else {
                seen.push(d.clone());
                true
            }
        });
        let inner = out
            .get("promptsThisHour")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        out.insert("deniedActionHashes".to_owned(), Value::Array(denied));
        out.insert("promptsThisHour".to_owned(), num_value(inner.max(prompts)));
        if let Some(Value::Object(handoff)) = out.get("handoff").cloned() {
            // `g.taskId !== handoff.taskId`: an absent id (`undefined`) is not `null` (review B, H-4).
            let task = handoff.get("taskId").cloned();
            let mut valid = Vec::new();
            let mut rejected = Vec::new();
            for id in handoff
                .get("approvalsHeld")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let g = id
                    .as_str()
                    .and_then(|i| self.stores.grant(i).ok().flatten());
                let reason = match &g {
                    None => Some("unknown"),
                    Some(g)
                        if g.get("revoked") == Some(&json!(true))
                            || g.get("consumedAt").is_some() =>
                    {
                        Some("revoked")
                    }
                    Some(g) if g["person"] != ctx.principal.as_str() => Some("foreign-person"),
                    Some(g) if g.get("delegable") != Some(&json!(true)) => Some("not-delegable"),
                    Some(g) if g.get("taskId") != task.as_ref() => Some("task-mismatch"),
                    Some(_) => None,
                };
                match reason {
                    Some(why) => rejected.push(json!({ "id": crate::approvals::js_string(Some(&J::from_value(id))), "reason": why })),
                    None => valid.push(id.clone()),
                }
            }
            if !rejected.is_empty() {
                let mut f = vec![
                    ("person", json!(ctx.principal)),
                    ("agentId", json!(ctx.agent_id)),
                ];
                if let Some(t) = &task {
                    f.push(("taskId", t.clone()));
                }
                if let Some(s) = ctx.session_id.as_deref().filter(|s| !s.is_empty()) {
                    f.push(("sessionId", json!(s)));
                }
                f.push(("rejected", Value::Array(rejected)));
                audit.record("approvals.held-rejected", &obj(f))?;
            }
            let mut h = handoff;
            h.insert("approvalsHeld".to_owned(), Value::Array(valid));
            out.insert("handoff".to_owned(), Value::Object(h));
        }
        Ok(Value::Object(out))
    }

    /// `dispose()`: every waiting call ends as not approved; timers are cleared.
    pub fn dispose(&mut self, audit: &mut dyn AuditPort) {
        let roots: Vec<String> = self.code_root_sessions.keys().cloned().collect();
        for id in roots {
            self.close_aborted(audit, &id);
        }
        self.code_root_sessions.clear();
        self.fail_all("the approval service is shutting down");
        let ids: Vec<String> = self.expiry.drain().collect();
        for id in ids {
            self.timers.clear(TimerKind::Expiry, &id);
        }
    }
}
