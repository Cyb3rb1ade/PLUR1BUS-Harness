//! The port between the ACP server and a harness (port of `packages/core/src/acp/backend.ts`): the server speaks ACP and knows
//! nothing of sessions; a backend turns "create a session / run a prompt / cancel it" into `session.*` calls
//! ([`CoreSessionBackend`]). The turn itself runs in the Core, behind [`RpcCaller`]; this package runs no turn.
use super::core_permissions::{AcpApprovalRelay, RelayError, RelayOptions};
use super::exec::{yield_now, Exec, Signal};
use super::file_changes::{AcpFileChanges, AcpFileContent};
use super::json::V;
use super::jsops::{js_string, nullish, strict_ne, truthy};
use super::permissions::{AcpPermissionAsk, AcpPermissionOutcome};
use super::text::{acp_text, AcpFailureReason, AcpLanguage, AcpMode};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

/// What a turn reports while it runs. Text is the model's output; tool events are relayed, never executed here.
#[derive(Clone, Debug, PartialEq)]
pub enum AcpTurnUpdate {
    /// Model output.
    Text(String),
    /// A fixed notice of the harness.
    Notice {
        /// Why (`approval-refused` or `profile-changed`).
        reason: &'static str,
        /// The text.
        text: String,
    },
    /// A tool call.
    ToolCall {
        /// The call id.
        id: String,
        /// The tool.
        name: String,
        /// Its arguments (absent: `undefined`).
        args: Option<V>,
    },
    /// A tool result.
    ToolResult {
        /// The call id.
        id: String,
        /// The output text.
        output: String,
        /// What the editor should show instead of the plain output.
        content: Option<Vec<AcpFileContent>>,
    },
}

/// How a turn ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnState {
    /// It finished.
    Completed,
    /// It failed.
    Failed,
    /// It was cancelled.
    Cancelled,
}

/// The outcome of a turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcpTurnOutcome {
    /// The state.
    pub state: TurnState,
    /// Never sent to the client or logged (a provider's error text may carry anything).
    pub error: Option<String>,
}

/// What a backend can do beyond the basics.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Features {
    /// Session modes.
    pub modes: bool,
    /// Steering a running turn.
    pub steer: bool,
    /// Queueing a follow-up.
    pub follow_up: bool,
}

/// Why a backend call failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BackendError {
    /// A known refusal with a static explanation.
    Failure(AcpFailureReason),
    /// Anything else; the class name is logged, the message never leaves.
    Other(Option<String>),
    /// A failed call to the Core.
    Rpc(RpcError),
}

impl From<RelayError> for BackendError {
    fn from(e: RelayError) -> BackendError {
        BackendError::Other(e.0)
    }
}

impl From<RpcError> for BackendError {
    fn from(e: RpcError) -> BackendError {
        BackendError::Rpc(e)
    }
}

/// A failed `call`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RpcError {
    /// The `error` member of a rejection object (`E_APPROVAL_REQUIRED`, ...).
    pub code: Option<String>,
    /// The class name when the rejection was an `Error`.
    pub name: Option<String>,
}

/// The Core's RPC surface as the ACP side uses it.
#[allow(async_fn_in_trait)]
pub trait RpcCaller {
    /// Whether the Core's handshake listed this method.
    fn has_method(&self, method: &str) -> bool;
    /// One call.
    async fn call(&self, method: &str, params: V) -> Result<V, RpcError>;
}

/// What the relay asks the editor with: the question and the signal that withdraws it.
pub type PermFuture = Pin<Box<dyn Future<Output = AcpPermissionOutcome>>>;
/// The editor's permission handler, as the server gives it to a turn.
pub type PermHandler = dyn Fn(AcpPermissionAsk, Option<Signal>) -> PermFuture;

/// One prompt.
#[derive(Clone, Debug)]
pub struct PromptArgs {
    /// The session.
    pub session_id: String,
    /// The prompt text.
    pub text: String,
}

/// The backend of an ACP server.
#[allow(async_fn_in_trait)]
pub trait AcpBackend {
    /// What it offers.
    fn features(&self) -> Features;
    /// Whether it has `setMode`.
    fn has_set_mode(&self) -> bool {
        true
    }
    /// Whether it has `deliver`.
    fn has_deliver(&self) -> bool {
        true
    }
    /// One ACP session = one harness session; the current Core uses `acp`, an older Core's plain-chat fallback uses `direct`.
    /// The mode is whatever the Core said (the server checks it against the closed ids).
    async fn create_session(&self, cwd: &str) -> Result<(String, Option<V>), BackendError>;
    /// Switch the tool profile; the answer says which mode is now in force (as the Core said it) and whether it changed.
    async fn set_mode(&self, session_id: &str, mode: AcpMode) -> Result<(V, bool), BackendError>;
    /// Steering or a queued follow-up. The answer is the result member of the reply (`None`: absent).
    async fn deliver(
        &self,
        session_id: &str,
        text: &str,
        steer: bool,
    ) -> Result<Option<V>, BackendError>;
    /// Runs one turn; `on_update` is called in order, before the returned future settles.
    async fn prompt(
        &self,
        a: PromptArgs,
        on_update: Rc<dyn Fn(AcpTurnUpdate)>,
        request_permission: Rc<PermHandler>,
    ) -> Result<AcpTurnOutcome, BackendError>;
    /// Stops the session's running turn (a no-op when none runs).
    async fn cancel(&self, session_id: &str) -> Result<(), BackendError>;
}

/// Who the Core sees (`CallerIdentity`).
#[derive(Clone, Debug)]
pub struct Caller {
    /// The channel (`cli`).
    pub channel: String,
    /// The account.
    pub account_id: String,
    /// The user.
    pub user_id: String,
}

impl Caller {
    fn value(&self) -> V {
        V::obj([
            ("channel", V::s(&self.channel)),
            ("accountId", V::s(&self.account_id)),
            ("userId", V::s(&self.user_id)),
        ])
    }
}

/// Waits between two `session.events` polls (a test passes an immediate one).
#[allow(async_fn_in_trait)]
pub trait Sleeper {
    /// Waits about `ms` milliseconds.
    async fn sleep(&self, ms: u64);
}

/// Options of [`CoreSessionBackend`].
pub struct CoreSessionBackendOptions<R: RpcCaller + 'static, S: Sleeper> {
    /// The Core.
    pub client: Rc<R>,
    /// Who asks.
    pub caller: Caller,
    /// The agent.
    pub agent_id: String,
    /// The poll pause.
    pub sleeper: S,
    /// The poll pause in milliseconds (default 40).
    pub poll_ms: Option<u64>,
    /// Startup profile; a requested coding profile refuses an older Core rather than pretending it was applied.
    pub initial_mode: Option<AcpMode>,
    /// The language of the notices.
    pub language: AcpLanguage,
    /// Where the detached permission choices run.
    pub exec: Rc<Exec>,
}

const MAX_SESSIONS: usize = 1024;

struct Inflight {
    cancel_requested: Cell<bool>,
    submitted: Cell<bool>,
}

/// What the Core said about the bound root, kept as it came (a missing or odd root only matters when a file result needs it).
struct Binding {
    root: Option<V>,
}

/// RULING (TypeScript): the turn is followed by polling `session.events` (the persisted, replayable stream), not by the opt-in
/// `session.event` notification: polling needs no subscription state, survives a reconnect and is the same path a reader that
/// missed events uses. The price is up to `poll_ms` of added latency per update burst.
pub struct CoreSessionBackend<R: RpcCaller + 'static, S: Sleeper> {
    features: Features,
    o: CoreSessionBackendOptions<R, S>,
    cursor: RefCell<HashMap<String, V>>,
    bindings: RefCell<HashMap<String, Binding>>,
    inflight: RefCell<HashMap<String, Rc<Inflight>>>,
    creating: Cell<usize>,
}

impl<R: RpcCaller + 'static, S: Sleeper> CoreSessionBackend<R, S> {
    /// A backend over a connected Core; what the Core's handshake lists decides the features.
    pub fn new(o: CoreSessionBackendOptions<R, S>) -> CoreSessionBackend<R, S> {
        let supports = |m: &str| o.client.has_method(m);
        let modes = supports("code.session.open") && supports("code.session.mode");
        // Native CLI uses this same queue contract signal. Do not advertise delivery on the older submit-only surface.
        let delivery = supports("session.submit") && supports("session.queue.list");
        let features = Features {
            modes,
            steer: delivery,
            follow_up: delivery,
        };
        CoreSessionBackend {
            features,
            o,
            cursor: RefCell::new(HashMap::new()),
            bindings: RefCell::new(HashMap::new()),
            inflight: RefCell::new(HashMap::new()),
            creating: Cell::new(0),
        }
    }

    async fn cancel_call(&self, session_id: &str) -> Result<(), RpcError> {
        self.o
            .client
            .call(
                "session.cancel",
                V::obj([
                    ("caller", self.o.caller.value()),
                    ("sessionId", V::s(session_id)),
                ]),
            )
            .await
            .map(|_| ())
    }

    async fn open_binding(
        &self,
        session_id: &str,
        cwd: &str,
        mode: AcpMode,
    ) -> Result<(String, Option<V>), BackendError> {
        let bound = self
            .o
            .client
            .call(
                "code.session.open",
                V::obj([
                    ("caller", self.o.caller.value()),
                    ("agentId", V::s(&self.o.agent_id)),
                    ("sessionId", V::s(session_id)),
                    ("root", V::s(cwd)),
                    ("interactive", V::Bool(false)),
                ]),
            )
            .await?;
        if bound.get("state").and_then(V::as_str) != Some("open") {
            return Err(BackendError::Failure(AcpFailureReason::RootNotGranted));
        }
        let root = bound.get("root").cloned();
        self.bindings
            .borrow_mut()
            .insert(session_id.to_owned(), Binding { root });
        let (selected, _) = self.set_mode(session_id, mode).await?;
        Ok((session_id.to_owned(), Some(selected)))
    }
}

impl<R: RpcCaller + 'static, S: Sleeper> AcpBackend for CoreSessionBackend<R, S> {
    fn features(&self) -> Features {
        self.features
    }

    async fn create_session(&self, cwd: &str) -> Result<(String, Option<V>), BackendError> {
        let mode = self.o.initial_mode.unwrap_or(AcpMode::Chat);
        if mode == AcpMode::Coding && !self.features.modes {
            return Err(BackendError::Failure(AcpFailureReason::CodingUnavailable));
        }
        if self.cursor.borrow().len() + self.creating.get() >= MAX_SESSIONS {
            return Err(BackendError::Failure(AcpFailureReason::SessionLimit));
        }
        if self.features.modes && cwd.is_empty() {
            return Err(BackendError::Failure(AcpFailureReason::RootNotGranted));
        }
        self.creating.set(self.creating.get() + 1);
        let created = self
            .o
            .client
            .call(
                "session.create",
                V::obj([
                    ("caller", self.o.caller.value()),
                    ("agentId", V::s(&self.o.agent_id)),
                    (
                        "kind",
                        V::s(if self.features.modes { "acp" } else { "direct" }),
                    ),
                    ("title", V::s("ACP")),
                ]),
            )
            .await;
        self.creating.set(self.creating.get() - 1);
        let created = created?;
        let sid = match created.get("session").and_then(|s| s.get("id")) {
            Some(V::Str(s)) => s.clone(),
            _ => return Err(BackendError::Other(Some("TypeError".to_owned()))),
        };
        self.cursor.borrow_mut().insert(sid.clone(), V::Num(0.0));
        if !self.features.modes {
            return Ok((sid, None));
        }
        match self.open_binding(&sid, cwd, mode).await {
            Ok(done) => Ok(done),
            Err(error) => {
                self.cursor.borrow_mut().remove(&sid);
                self.bindings.borrow_mut().remove(&sid);
                // This newly-created empty session belongs to this failed operation, never an existing editor transcript.
                let _ = self
                    .o
                    .client
                    .call(
                        "session.archive",
                        V::obj([("caller", self.o.caller.value()), ("sessionId", V::s(&sid))]),
                    )
                    .await;
                Err(match error {
                    BackendError::Rpc(RpcError {
                        code: Some(code), ..
                    }) if code == "E_APPROVAL_REQUIRED" => {
                        BackendError::Failure(AcpFailureReason::RootNotGranted)
                    }
                    other => other,
                })
            }
        }
    }

    /// Core validates the person, bound root and audit writer; the editor cannot add a grant through this path.
    async fn set_mode(&self, session_id: &str, mode: AcpMode) -> Result<(V, bool), BackendError> {
        if !self.features.modes {
            return Err(BackendError::Failure(AcpFailureReason::ModeUnavailable));
        }
        if !self.bindings.borrow().contains_key(session_id) {
            return Err(BackendError::Failure(AcpFailureReason::UnknownSession));
        }
        let result = self
            .o
            .client
            .call(
                "code.session.mode",
                V::obj([
                    ("caller", self.o.caller.value()),
                    ("sessionId", V::s(session_id)),
                    ("mode", V::s(mode.id())),
                ]),
            )
            .await?;
        Ok((
            result.get("mode").cloned().unwrap_or(V::Null),
            truthy(result.get("changed")),
        ))
    }

    /// Only the Core's advertised steering/queue contract enables these optional ACP extensions.
    async fn deliver(
        &self,
        session_id: &str,
        text: &str,
        steer: bool,
    ) -> Result<Option<V>, BackendError> {
        if !self.features.steer || !self.features.follow_up {
            return Err(BackendError::Failure(AcpFailureReason::DeliveryUnavailable));
        }
        if !self.cursor.borrow().contains_key(session_id) {
            return Err(BackendError::Failure(AcpFailureReason::UnknownSession));
        }
        let r = self
            .o
            .client
            .call(
                "session.submit",
                V::obj([
                    ("caller", self.o.caller.value()),
                    ("sessionId", V::s(session_id)),
                    ("text", V::s(text)),
                    ("delivery", V::s(if steer { "steer" } else { "queue" })),
                    ("wait", V::Bool(false)),
                ]),
            )
            .await?;
        Ok(Some(r))
    }

    async fn prompt(
        &self,
        a: PromptArgs,
        on_update: Rc<dyn Fn(AcpTurnUpdate)>,
        request_permission: Rc<PermHandler>,
    ) -> Result<AcpTurnOutcome, BackendError> {
        let flight = Rc::new(Inflight {
            cancel_requested: Cell::new(false),
            submitted: Cell::new(false),
        });
        let root = self
            .bindings
            .borrow()
            .get(&a.session_id)
            .and_then(|b| b.root.clone());
        let mut changes = AcpFileChanges::new(root, self.o.language);
        self.inflight
            .borrow_mut()
            .insert(a.session_id.clone(), flight.clone());
        let mut approvals: Option<Rc<AcpApprovalRelay<R>>> = None;
        let result = self
            .run_turn(
                &a,
                &flight,
                &mut changes,
                &on_update,
                &request_permission,
                &mut approvals,
            )
            .await;
        if result.is_err() {
            if flight.submitted.get() {
                let _ = self.cancel_call(&a.session_id).await;
            }
        }
        if let Some(rel) = &approvals {
            rel.close();
        }
        self.inflight.borrow_mut().remove(&a.session_id);
        result
    }

    async fn cancel(&self, session_id: &str) -> Result<(), BackendError> {
        let f = self.inflight.borrow().get(session_id).cloned();
        let Some(f) = f else { return Ok(()) };
        f.cancel_requested.set(true);
        if f.submitted.get() {
            self.cancel_call(session_id).await?;
        }
        Ok(())
    }
}

impl<R: RpcCaller + 'static, S: Sleeper> CoreSessionBackend<R, S> {
    async fn run_turn(
        &self,
        a: &PromptArgs,
        flight: &Rc<Inflight>,
        changes: &mut AcpFileChanges,
        on_update: &Rc<dyn Fn(AcpTurnUpdate)>,
        request_permission: &Rc<PermHandler>,
        approvals: &mut Option<Rc<AcpApprovalRelay<R>>>,
    ) -> Result<AcpTurnOutcome, BackendError> {
        let caller = self.o.caller.value();
        let sub = self
            .o
            .client
            .call(
                "session.submit",
                V::obj([
                    ("caller", caller.clone()),
                    ("sessionId", V::s(&a.session_id)),
                    ("text", V::s(&a.text)),
                ]),
            )
            .await?;
        // `sub.turnId` may be anything the Core said; events are matched with `===`.
        let turn_id: Option<V> = sub.get("turnId").cloned();
        flight.submitted.set(true);
        if [
            "approval.list",
            "approval.get",
            "approval.decide",
            "approval.cancel",
        ]
        .iter()
        .all(|m| self.o.client.has_method(m))
        {
            let on_refused = on_update.clone();
            let language = self.o.language;
            *approvals = Some(AcpApprovalRelay::new(RelayOptions {
                client: self.o.client.clone(),
                agent_id: self.o.agent_id.clone(),
                session_id: a.session_id.clone(),
                turn_id: turn_id.clone(),
                request_permission: request_permission.clone(),
                refused: Rc::new(move || {
                    on_refused(AcpTurnUpdate::Notice {
                        reason: "approval-refused",
                        text: acp_text(language).approval_refused.to_owned(),
                    });
                }),
                language,
                exec: self.o.exec.clone(),
            }));
        }
        // A cancel that arrived before the turn existed is applied now.
        // A failing cancel must not abandon a turn that is running: it is still followed to its end.
        if flight.cancel_requested.get() {
            let _ = self.cancel_call(&a.session_id).await;
        }
        loop {
            let after = match self.cursor.borrow().get(&a.session_id) {
                None | Some(V::Null) => V::Num(0.0),
                Some(v) => v.clone(),
            };
            let page = self
                .o
                .client
                .call(
                    "session.events",
                    V::obj([
                        ("caller", caller.clone()),
                        ("sessionId", V::s(&a.session_id)),
                        ("afterSeq", after),
                        ("limit", V::n(500.0)),
                    ]),
                )
                .await?;
            let events = page
                .get("events")
                .and_then(V::as_arr)
                .ok_or_else(|| BackendError::Other(Some("TypeError".to_owned())))?;
            for e in events {
                if let Some(seq) = e.get("seq") {
                    self.cursor
                        .borrow_mut()
                        .insert(a.session_id.clone(), seq.clone());
                } else {
                    self.cursor
                        .borrow_mut()
                        .insert(a.session_id.clone(), V::Null);
                }
                if strict_ne(e.get("turnId"), turn_id.as_ref()) {
                    continue;
                }
                let kind = e.get("type").and_then(V::as_str);
                let data = e.get("data");
                let field = |name: &str| -> Result<Option<&V>, BackendError> {
                    match data {
                        None | Some(V::Null) => {
                            Err(BackendError::Other(Some("TypeError".to_owned())))
                        }
                        Some(d) => Ok(d.get(name)),
                    }
                };
                match kind {
                    Some("delta") => {
                        if let Some(V::Str(t)) = field("text")? {
                            on_update(AcpTurnUpdate::Text(t.clone()));
                        }
                    }
                    Some("tool.call") => {
                        let id = js_string(field("id")?);
                        let name = js_string(field("name")?);
                        let args = field("args")?;
                        changes.call(&id, &name, args);
                        on_update(AcpTurnUpdate::ToolCall {
                            id,
                            name,
                            args: args.cloned(),
                        });
                    }
                    Some("tool.result") => {
                        let id = js_string(field("id")?);
                        let output = js_string(nullish(field("output")?, Some(&V::s(""))));
                        let content = changes
                            .result(&id, &output)
                            .map_err(|()| BackendError::Other(Some("TypeError".to_owned())))?;
                        on_update(AcpTurnUpdate::ToolResult {
                            id,
                            output,
                            content,
                        });
                    }
                    Some("turn.completed") => {
                        return Ok(AcpTurnOutcome {
                            state: TurnState::Completed,
                            error: None,
                        });
                    }
                    Some("turn.failed") => {
                        let error = match field("error")? {
                            Some(V::Str(s)) => s.clone(),
                            _ => "unknown".to_owned(),
                        };
                        return Ok(if error == "cancelled" {
                            AcpTurnOutcome {
                                state: TurnState::Cancelled,
                                error: None,
                            }
                        } else {
                            AcpTurnOutcome {
                                state: TurnState::Failed,
                                error: Some(error),
                            }
                        });
                    }
                    _ => {}
                }
            }
            if events.is_empty() && !truthy(page.get("running")) {
                return Ok(AcpTurnOutcome {
                    state: TurnState::Failed,
                    error: Some("turn-ended-without-event".to_owned()),
                });
            }
            if let Some(rel) = approvals.as_ref() {
                rel.poll().await?;
            }
            // TypeScript awaits the (possibly absent) poll: one tick either way, which orders this loop against the relay's
            // own tasks (a refused choice cancels and tells the editor on later ticks).
            yield_now().await;
            if events.len() < 500 {
                self.o.sleeper.sleep(self.o.poll_ms.unwrap_or(40)).await;
            }
        }
    }
}
