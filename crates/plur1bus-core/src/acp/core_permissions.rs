//! D109 remains the decision maker: ACP translates offered choices and never creates or widens a grant itself (port of
//! `packages/core/src/acp/core-permissions.ts`).
//!
//! The relay is the only place where an editor's choice can reach the approval service, and it reaches it through the
//! [`RpcCaller`] port with `approval.list`, `approval.get`, `approval.decide` and `approval.cancel` (design D4 of K8): the
//! Core records, scopes and confirms at the operating-system level; this module has no way to write a grant, so a client that
//! lies about an option, answers twice or answers late changes nothing but its own request. The rule everywhere is: when in
//! doubt, cancel (the Core reads a cancel as a refusal).
use super::backend::{PermHandler, RpcCaller, RpcError};
use super::exec::{Exec, Signal};
use super::json::V;
use super::jsops::{is_str, js_string, math_max, nullish, strict_eq, strict_ne, truthy};
use super::permissions::{AcpPermissionAsk, AcpPermissionOption, AcpPermissionOutcome};
use super::text::{acp_text, AcpLanguage};
use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

const PAGE_SIZE: f64 = 100.0;
const MAX_APPROVALS_PER_TURN: usize = 1024;

/// A thrown error: the name of its class (`None` where JavaScript threw something that is no `Error`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayError(pub Option<String>);

impl RelayError {
    fn type_error() -> RelayError {
        RelayError(Some("TypeError".to_owned()))
    }
}

impl From<RpcError> for RelayError {
    fn from(e: RpcError) -> RelayError {
        RelayError(e.name)
    }
}

/// What a relay needs to know about its turn.
pub struct RelayOptions<R: RpcCaller + 'static> {
    /// The Core.
    pub client: Rc<R>,
    /// The agent whose approvals are relayed.
    pub agent_id: String,
    /// The session.
    pub session_id: String,
    /// The turn id the Core returned (compared with `===`, so it is whatever the Core said).
    pub turn_id: Option<V>,
    /// Asks the editor.
    pub request_permission: Rc<PermHandler>,
    /// Told when a choice was refused by the Core.
    pub refused: Rc<dyn Fn()>,
    /// The language of the texts.
    pub language: AcpLanguage,
    /// Where the detached choices run.
    pub exec: Rc<Exec>,
}

/// One turn's bounded UI relay. Core records, scopes and OS confirmation remain authoritative at every decision.
pub struct AcpApprovalRelay<R: RpcCaller + 'static> {
    o: RelayOptions<R>,
    seen: RefCell<HashSet<String>>,
    cycle: RefCell<HashSet<String>>,
    active: RefCell<Vec<(String, Signal, V)>>,
    cursor: RefCell<Option<V>>,
    closed: Cell<bool>,
}

fn key(v: Option<&V>) -> String {
    let tag = match v {
        None => 'u',
        Some(V::Null) => 'n',
        Some(V::Bool(_)) => 'b',
        Some(V::Num(_)) => 'd',
        Some(V::Str(_)) => 's',
        Some(_) => 'o',
    };
    format!("{tag}{}", js_string(v))
}

/// `value.key` where a `null` or missing `value` throws.
fn prop<'a>(value: Option<&'a V>, name: &str) -> Result<Option<&'a V>, RelayError> {
    match value {
        None | Some(V::Null) => Err(RelayError::type_error()),
        Some(v) => Ok(v.get(name)),
    }
}

impl<R: RpcCaller + 'static> AcpApprovalRelay<R> {
    /// A relay for one turn.
    pub fn new(o: RelayOptions<R>) -> Rc<AcpApprovalRelay<R>> {
        Rc::new(AcpApprovalRelay {
            o,
            seen: RefCell::new(HashSet::new()),
            cycle: RefCell::new(HashSet::new()),
            active: RefCell::new(Vec::new()),
            cursor: RefCell::new(None),
            closed: Cell::new(false),
        })
    }

    /// One bounded page per event poll; completing a scan also withdraws editor choices already resolved elsewhere.
    pub async fn poll(self: &Rc<Self>) -> Result<(), RelayError> {
        if self.closed.get() {
            return Ok(());
        }
        let mut params = V::obj([
            ("status", V::s("pending")),
            ("agent", V::s(&self.o.agent_id)),
            ("limit", V::n(PAGE_SIZE)),
        ]);
        let cursor = self.cursor.borrow().clone();
        if let Some(c) = cursor.as_ref().filter(|c| truthy(Some(c))) {
            params.set("cursor", c.clone());
        }
        let page = self.o.client.call("approval.list", params).await?;
        if self.closed.get() {
            return Ok(());
        }
        let approvals = prop(Some(&page), "approvals")?
            .and_then(V::as_arr)
            .ok_or_else(RelayError::type_error)?;
        for record in approvals {
            if !self.belongs(record)? || strict_ne(record.get("status"), Some(&V::s("pending"))) {
                continue;
            }
            let id = key(record.get("id"));
            self.cycle.borrow_mut().insert(id.clone());
            if self.seen.borrow().contains(&id) {
                continue;
            }
            if self.seen.borrow().len() >= MAX_APPROVALS_PER_TURN {
                return Err(RelayError(Some("Error".to_owned())));
            }
            self.seen.borrow_mut().insert(id.clone());
            let abort = Signal::new();
            self.active.borrow_mut().push((
                id.clone(),
                abort.clone(),
                record.get("id").cloned().unwrap_or(V::Null),
            ));
            let (me, record) = (self.clone(), record.clone());
            self.o.exec.spawn(async move {
                if me.choose(&record, &abort).await.is_err() && !me.closed.get() && !abort.aborted()
                {
                    me.cancel(record.get("id")).await;
                    (me.o.refused)();
                }
                me.active.borrow_mut().retain(|(k, _, _)| *k != id);
            });
        }
        let next = prop(Some(&page), "nextCursor")?.cloned();
        let more = truthy(next.as_ref());
        *self.cursor.borrow_mut() = next;
        if !more {
            let snapshot: Vec<(String, Signal, V)> = self.active.borrow().clone();
            for (id, active, raw) in snapshot {
                if self.cycle.borrow().contains(&id) {
                    continue;
                }
                // A changing paginated list is not proof of withdrawal. Check the individual record before clearing its UI.
                let current = self
                    .o
                    .client
                    .call("approval.get", V::obj([("id", raw)]))
                    .await?;
                if strict_ne(prop(Some(&current), "status")?, Some(&V::s("pending")))
                    || !self.belongs(&current)?
                {
                    active.abort();
                }
            }
            self.cycle.borrow_mut().clear();
        }
        Ok(())
    }

    /// Withdraw every outstanding editor choice; a late reply can no longer reach `approval.decide`.
    pub fn close(&self) {
        self.closed.set(true);
        let all: Vec<(String, Signal, V)> = std::mem::take(&mut *self.active.borrow_mut());
        for (_, s, _) in all {
            s.abort();
        }
        self.seen.borrow_mut().clear();
        self.cycle.borrow_mut().clear();
        *self.cursor.borrow_mut() = None;
    }

    fn belongs(&self, record: &V) -> Result<bool, RelayError> {
        let sid = V::s(&self.o.session_id);
        if strict_ne(prop(Some(record), "sessionId")?, Some(&sid))
            || strict_ne(record.get("turnId"), self.o.turn_id.as_ref())
        {
            return Ok(false);
        }
        let subject = prop(Some(record), "subject")?;
        Ok(is_str(prop(subject, "kind")?, "agent")
            && strict_eq(prop(subject, "id")?, Some(&V::s(&self.o.agent_id))))
    }

    async fn choose(self: &Rc<Self>, record: &V, signal: &Signal) -> Result<(), RelayError> {
        let choices = offered(record)?;
        let ask = question(record, &choices, self.o.language)?;
        let outcome = (self.o.request_permission)(ask, Some(signal.clone())).await;
        if self.closed.get() || signal.aborted() {
            return Ok(());
        }
        let AcpPermissionOutcome::Selected(option_id) = outcome else {
            self.cancel(record.get("id")).await;
            return Ok(());
        };
        let fresh = self
            .o
            .client
            .call("approval.get", V::obj([("id", id_param(record))]))
            .await?;
        if self.closed.get()
            || signal.aborted()
            || strict_ne(prop(Some(&fresh), "status")?, Some(&V::s("pending")))
        {
            return Ok(());
        }
        if !self.belongs(&fresh)?
            || strict_ne(fresh.get("id"), record.get("id"))
            || strict_ne(fresh.get("actionHash"), record.get("actionHash"))
            || strict_ne(fresh.get("capability"), record.get("capability"))
        {
            self.cancel(record.get("id")).await;
            return Ok(());
        }
        if option_id == "deny" {
            self.o
                .client
                .call(
                    "approval.decide",
                    V::obj([("id", id_param(record)), ("decision", V::s("deny"))]),
                )
                .await?;
            return Ok(());
        }
        let selected = choices
            .iter()
            .find(|(k, _)| *k == option_id)
            .map(|(_, o)| o);
        let fresh_choices = offered(&fresh)?;
        let current = fresh_choices
            .iter()
            .find(|(k, _)| *k == option_id)
            .map(|(_, o)| o);
        let (Some(selected), Some(current)) = (selected, current) else {
            self.cancel(record.get("id")).await;
            return Ok(());
        };
        if strict_ne(current.get("scope"), selected.get("scope")) {
            self.cancel(record.get("id")).await;
            return Ok(());
        }
        let mut params = V::obj([("id", id_param(record)), ("decision", V::s("approve"))]);
        if let Some(scope) = current.get("scope") {
            params.set("scope", scope.clone());
        }
        let need = math_max(
            nullish(fresh.get("requiredSurface"), Some(&V::Num(0.0))),
            current.get("requiredSurface"),
        );
        if need > 1.0 {
            params.set("attest", V::Bool(true));
        }
        if self.o.client.call("approval.decide", params).await.is_err() {
            // A missing helper, failed OS confirmation or a changed policy is a refusal; never fall back to grant.create.
            self.cancel(record.get("id")).await;
            if !self.closed.get() && !signal.aborted() {
                (self.o.refused)();
            }
        }
        Ok(())
    }

    async fn cancel(&self, id: Option<&V>) {
        let params = match id {
            Some(v) => V::obj([("id", v.clone())]),
            None => V::obj([]),
        };
        let _ = self.o.client.call("approval.cancel", params).await;
    }
}

fn id_param(record: &V) -> V {
    record.get("id").cloned().unwrap_or(V::Null)
}

/// The choices a record offers, by option id, in the order the Core listed them (a repeated id keeps its first place).
fn offered(record: &V) -> Result<Vec<(String, V)>, RelayError> {
    let mut choices: Vec<(String, V)> = Vec::new();
    let options = match prop(Some(record), "grantOptions")? {
        None | Some(V::Null) => &[][..],
        Some(V::Arr(a)) => a,
        Some(_) => return Err(RelayError::type_error()),
    };
    for option in options {
        let surface = prop(Some(option), "requiredSurface")?;
        if math_max(
            nullish(record.get("requiredSurface"), Some(&V::Num(0.0))),
            surface,
        ) > 2.0
            || is_str(option.get("scope"), "always")
        {
            continue;
        }
        if is_str(option.get("scope"), "task") && !truthy(record.get("taskId")) {
            continue;
        }
        if is_str(option.get("scope"), "session") && !truthy(record.get("sessionId")) {
            continue;
        }
        let id = format!("allow-{}", js_string(option.get("scope")));
        match choices.iter_mut().find(|(k, _)| *k == id) {
            Some(slot) => slot.1 = option.clone(),
            None => choices.push((id, option.clone())),
        }
    }
    Ok(choices)
}

/// What `kinds[capability]` answers in JavaScript, where `kinds` is a plain object literal: the two names, `undefined` for
/// anything else, and an inherited member for a name of `Object.prototype` (a function is dropped by `JSON.stringify`, so such
/// a `kind` is absent from the message; `__proto__` is that prototype object, which prints as `{}`).
fn kind_of(capability: Option<&V>) -> Option<V> {
    match capability.and_then(V::as_str) {
        Some("fs.read") => Some(V::s("read")),
        Some("fs.write") => Some(V::s("edit")),
        Some(
            "constructor"
            | "hasOwnProperty"
            | "isPrototypeOf"
            | "propertyIsEnumerable"
            | "toLocaleString"
            | "toString"
            | "valueOf"
            | "__defineGetter__"
            | "__defineSetter__"
            | "__lookupGetter__"
            | "__lookupSetter__",
        ) => None,
        Some("__proto__") => Some(V::Obj(Vec::new())),
        _ => Some(V::s("other")),
    }
}

fn question(
    record: &V,
    choices: &[(String, V)],
    language: AcpLanguage,
) -> Result<AcpPermissionAsk, RelayError> {
    let text = acp_text(language);
    let mut details: Vec<String> = Vec::new();
    let mut add = |v: Option<&V>| {
        if truthy(v) {
            details.push(js_string(v));
        }
    };
    add(record.get("summary"));
    match record.get("targets") {
        None | Some(V::Null) => {}
        Some(V::Arr(a)) => a.iter().for_each(|t| add(Some(t))),
        Some(V::Str(s)) => s.chars().for_each(|c| add(Some(&V::Str(c.to_string())))),
        Some(_) => return Err(RelayError::type_error()),
    }
    for (label, field) in [(text.risk, "risk"), (text.agent_reason, "agentReason")] {
        if truthy(record.get(field)) {
            add(Some(&V::Str(format!(
                "{label}: {}",
                js_string(record.get(field))
            ))));
        }
    }
    if truthy(record.get("diff")) {
        add(Some(&V::Str(format!(
            "{}:\n{}",
            text.patch_preview,
            js_string(record.get("diff"))
        ))));
    }
    let details = details.join("\n");
    let capability = record.get("capability");
    let mut tool_call = V::obj([(
        "toolCallId",
        V::Str(format!("approval:{}", js_string(record.get("id")))),
    )]);
    if let Some(title) = nullish(record.get("tool"), capability) {
        tool_call.set("title", title.clone());
    }
    tool_call.set("status", V::s("pending"));
    if let Some(kind) = kind_of(capability) {
        tool_call.set("kind", kind);
    }
    if !details.is_empty() {
        tool_call.set(
            "content",
            V::Arr(vec![V::obj([
                ("type", V::s("content")),
                (
                    "content",
                    V::obj([("type", V::s("text")), ("text", V::Str(details))]),
                ),
            ])]),
        );
    }
    let mut options: Vec<AcpPermissionOption> = choices
        .iter()
        .map(|(option_id, option)| {
            let scope = option.get("scope").and_then(V::as_str);
            AcpPermissionOption {
                option_id: option_id.clone(),
                name: match scope {
                    Some("once") => Some(text.allow_once.to_owned()),
                    Some("task") => Some(text.allow_task.to_owned()),
                    Some("session") => Some(text.allow_session.to_owned()),
                    Some("always") => Some(text.always.to_owned()),
                    _ => None,
                },
                kind: if scope == Some("once") {
                    "allow_once"
                } else {
                    "allow_always"
                }
                .to_owned(),
            }
        })
        .collect();
    options.push(AcpPermissionOption {
        option_id: "deny".to_owned(),
        name: Some(text.deny.to_owned()),
        kind: "reject_once".to_owned(),
    });
    Ok(AcpPermissionAsk { tool_call, options })
}
