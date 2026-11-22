//! ACP v1 client permission requests are scoped, bounded and fail closed on cancellation or malformed replies (port of
//! `packages/core/src/acp/permissions.ts`).
//!
//! Agent-to-client requests have their own ids; only the matching client's structured result can resolve them. Every path that
//! is not a well-formed selection of an offered option ends as `cancelled`, which the Core reads as a refusal.
use super::exec::{oneshot, Receiver, Sender, Signal};
use super::framing::MAX_LINE_BYTES;
use super::json::V;
use crate::budget::{Clock, IdSource};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

/// How long a human may take (TypeScript: `DEFAULT_PERMISSION_TIMEOUT_MS`).
pub const DEFAULT_PERMISSION_TIMEOUT_MS: i64 = 5 * 60_000;
/// How many choices are kept while the editor decides.
pub const MAX_PENDING_PERMISSIONS: usize = 64;
const MAX_PERMISSION_OPTIONS: usize = 8;
const KINDS: [&str; 4] = ["allow_once", "allow_always", "reject_once", "reject_always"];

/// One choice offered to the editor.
#[derive(Clone, Debug, PartialEq)]
pub struct AcpPermissionOption {
    /// Its id (the answer names it).
    pub option_id: String,
    /// What the editor shows (absent: the member is left out, as an `undefined` would be).
    pub name: Option<String>,
    /// One of `allow_once`, `allow_always`, `reject_once`, `reject_always`.
    pub kind: String,
}

/// A question for the editor.
#[derive(Clone, Debug, PartialEq)]
pub struct AcpPermissionAsk {
    /// The tool call being asked about (an object).
    pub tool_call: V,
    /// The offered options.
    pub options: Vec<AcpPermissionOption>,
}

/// The editor's answer, or its absence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AcpPermissionOutcome {
    /// Nothing was selected (cancel, abort, timeout, close, a malformed or foreign answer).
    Cancelled,
    /// An offered option was selected.
    Selected(String),
}

struct Pending {
    session_id: String,
    options: HashSet<String>,
    tx: Sender<AcpPermissionOutcome>,
    deadline: i64,
    listener: Option<(Signal, u64)>,
}

/// The agent's open permission requests.
pub struct AcpPermissions {
    send: Box<dyn Fn(&V) -> bool>,
    timeout_ms: i64,
    clock: Rc<dyn Clock>,
    ids: Rc<dyn IdSource>,
    pending: RefCell<HashMap<String, Pending>>,
    order: RefCell<Vec<String>>,
    closed: Cell<bool>,
}

fn cancelled_now() -> Receiver<AcpPermissionOutcome> {
    let (tx, rx) = oneshot();
    tx.send(AcpPermissionOutcome::Cancelled);
    rx
}

impl AcpPermissions {
    /// `send` writes one message to the editor and says whether it could (a closed output cancels the request).
    pub fn new(
        send: impl Fn(&V) -> bool + 'static,
        clock: Rc<dyn Clock>,
        ids: Rc<dyn IdSource>,
        timeout_ms: i64,
    ) -> Rc<AcpPermissions> {
        Rc::new(AcpPermissions {
            send: Box::new(send),
            timeout_ms,
            clock,
            ids,
            pending: RefCell::new(HashMap::new()),
            order: RefCell::new(Vec::new()),
            closed: Cell::new(false),
        })
    }

    /// Ask only with issued ids and offered options; unavailable capacity, malformed input and abort all cancel.
    pub fn request(
        self: &Rc<Self>,
        session_id: &str,
        ask: &AcpPermissionAsk,
        signal: Option<&Signal>,
    ) -> Receiver<AcpPermissionOutcome> {
        if self.closed.get()
            || signal.is_some_and(Signal::aborted)
            || self.pending.borrow().len() >= MAX_PENDING_PERMISSIONS
        {
            return cancelled_now();
        }
        let options: HashSet<String> = ask.options.iter().map(|o| o.option_id.clone()).collect();
        if ask.options.is_empty()
            || ask.options.len() > MAX_PERMISSION_OPTIONS
            || options.len() != ask.options.len()
            || ask
                .options
                .iter()
                .any(|o| o.option_id.is_empty() || !KINDS.contains(&o.kind.as_str()))
        {
            return cancelled_now();
        }
        let id = format!("acp-permission-{}", self.ids.next_id());
        let message = V::obj([
            ("jsonrpc", V::s("2.0")),
            ("id", V::s(&id)),
            ("method", V::s("session/request_permission")),
            (
                "params",
                V::obj([
                    ("sessionId", V::s(session_id)),
                    ("toolCall", ask.tool_call.clone()),
                    (
                        "options",
                        V::Arr(
                            ask.options
                                .iter()
                                .map(|o| {
                                    let mut v = V::obj([("optionId", V::s(&o.option_id))]);
                                    if let Some(name) = &o.name {
                                        v.set("name", V::s(name));
                                    }
                                    v.set("kind", V::s(&o.kind));
                                    v
                                })
                                .collect(),
                        ),
                    ),
                ]),
            ),
        ]);
        // A permission is one ACP line too. Do not retain an oversized tool payload while waiting for a human.
        if message.stringify_bounded(MAX_LINE_BYTES).is_none() {
            return cancelled_now();
        }
        let (tx, rx) = oneshot();
        let listener = signal.map(|s| {
            let me = Rc::downgrade(self);
            let key = id.clone();
            (
                s.clone(),
                s.on_abort(move || {
                    if let Some(me) = me.upgrade() {
                        me.finish(&key, AcpPermissionOutcome::Cancelled);
                    }
                }),
            )
        });
        self.pending.borrow_mut().insert(
            id.clone(),
            Pending {
                session_id: session_id.to_owned(),
                options,
                tx,
                deadline: self.clock.now().saturating_add(self.timeout_ms),
                listener,
            },
        );
        self.order.borrow_mut().push(id.clone());
        if !(self.send)(&message) {
            self.finish(&id, AcpPermissionOutcome::Cancelled);
        }
        rx
    }

    fn finish(&self, id: &str, outcome: AcpPermissionOutcome) {
        let Some(p) = self.pending.borrow_mut().remove(id) else {
            return;
        };
        self.order.borrow_mut().retain(|k| k != id);
        if let Some((signal, listener)) = p.listener {
            signal.off(listener);
        }
        p.tx.send(outcome);
    }

    /// Consume one matching reply; unknown ids confer no authority and malformed matching replies cancel. Returns whether the
    /// message was the reply to an open request (a second reply, a late one and a foreign one are not).
    pub fn answer(&self, message: &V) -> bool {
        if !message.is_obj()
            || message.get("jsonrpc").and_then(V::as_str) != Some("2.0")
            || message.has("method")
        {
            return false;
        }
        let Some(id) = message.get("id").and_then(V::as_str) else {
            return false;
        };
        let options = match self.pending.borrow().get(id) {
            Some(p) => p.options.clone(),
            None => return false,
        };
        let result = if message.has("error") {
            None
        } else {
            message.get("result").filter(|r| r.is_obj())
        };
        let outcome = result.and_then(|r| r.get("outcome")).filter(|o| o.is_obj());
        let selected = outcome.and_then(|o| {
            if o.get("outcome").and_then(V::as_str) != Some("selected") {
                return None;
            }
            let option = o.get("optionId").and_then(V::as_str)?;
            options.contains(option).then(|| option.to_owned())
        });
        self.finish(
            id,
            selected.map_or(
                AcpPermissionOutcome::Cancelled,
                AcpPermissionOutcome::Selected,
            ),
        );
        true
    }

    /// Withdraw this session only; other editor tabs keep their pending choices.
    pub fn cancel_session(&self, session_id: &str) {
        let ids: Vec<String> = self
            .order
            .borrow()
            .iter()
            .filter(|k| {
                self.pending
                    .borrow()
                    .get(*k)
                    .is_some_and(|p| p.session_id == session_id)
            })
            .cloned()
            .collect();
        for id in ids {
            self.finish(&id, AcpPermissionOutcome::Cancelled);
        }
    }

    /// Settle all outstanding choices before the protocol transport closes.
    pub fn close(&self) {
        self.closed.set(true);
        let ids: Vec<String> = self.order.borrow().clone();
        for id in ids {
            self.finish(&id, AcpPermissionOutcome::Cancelled);
        }
    }

    /// When the earliest open request times out, on the clock of the server (`None`: nothing is open).
    pub fn next_deadline(&self) -> Option<i64> {
        self.pending.borrow().values().map(|p| p.deadline).min()
    }

    /// The timer of every open request: the ones whose time is up are cancelled (in the order they were asked).
    pub fn expire(&self) {
        let now = self.clock.now();
        let due: Vec<String> = self
            .order
            .borrow()
            .iter()
            .filter(|k| {
                self.pending
                    .borrow()
                    .get(*k)
                    .is_some_and(|p| p.deadline <= now)
            })
            .cloned()
            .collect();
        for id in due {
            self.finish(&id, AcpPermissionOutcome::Cancelled);
        }
    }

    /// Number of retained choices, bounded by [`MAX_PENDING_PERMISSIONS`].
    pub fn pending(&self) -> usize {
        self.pending.borrow().len()
    }
}
