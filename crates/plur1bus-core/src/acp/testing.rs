//! Scripted doubles for the ACP tests and the replay of `fixtures/parity/acp/` (mode W over stdio, P4-71).
//!
//! A scenario is a script (what the backend or the Core answers) and a list of events (what reaches the server: bytes, a gate
//! that opens, time that passes, the end of the input). The runner drives a real [`AcpServer`] and records one transcript: every
//! frame written (`OUT`), every log line (`LOG`), every call on the backend or the Core (`BACKEND`, `RPC`) and a marker before
//! each event (`EVENT`). `scripts/parity/export-acp.ts` runs the same scenarios against the TypeScript server and records the
//! transcript it produced; the replay requires the same transcript, line by line.
use super::backend::*;
use super::exec::{notify, yield_now, Exec};
use super::json::{parse, V};
use super::permissions::{AcpPermissionAsk, AcpPermissionOption, AcpPermissionOutcome};
use super::server::*;
use super::text::{AcpFailureReason, AcpLanguage, AcpMode};
use crate::budget::{Clock, IdSource};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::rc::Rc;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

/// The shared record of a scenario.
pub type Transcript = Rc<RefCell<Vec<String>>>;

/// A clock the script moves.
#[derive(Default)]
pub struct TestClock(pub AtomicI64);

impl Clock for TestClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// Ids from a list, then `exhausted-N`.
pub struct ListIds {
    ids: Vec<String>,
    next: AtomicUsize,
}

impl ListIds {
    /// The given ids in order.
    pub fn new(ids: Vec<String>) -> ListIds {
        ListIds {
            ids,
            next: AtomicUsize::new(0),
        }
    }
}

impl IdSource for ListIds {
    fn next_id(&self) -> String {
        let i = self.next.fetch_add(1, Ordering::SeqCst);
        self.ids
            .get(i)
            .cloned()
            .unwrap_or_else(|| format!("exhausted-{i}"))
    }
}

/// Named gates a script opens from outside.
#[derive(Clone, Default)]
pub struct Gates(Rc<RefCell<HashSet<String>>>);

impl Gates {
    /// Opens a gate.
    pub fn release(&self, name: &str) {
        self.0.borrow_mut().insert(name.to_owned());
        notify();
    }

    /// Waits until a gate is open.
    pub async fn wait(&self, name: &str) {
        let me = self.clone();
        let name = name.to_owned();
        std::future::poll_fn(move |_| {
            if me.0.borrow().contains(&name) {
                std::task::Poll::Ready(())
            } else {
                std::task::Poll::Pending
            }
        })
        .await;
    }
}

/// One thing that reaches the server.
pub enum Ev {
    /// Bytes on the input.
    In(Vec<u8>),
    /// A gate opens.
    Release(String),
    /// The clock moves.
    Advance(i64),
    /// The input ends.
    End,
    /// The input is destroyed.
    Close,
    /// The input reports an error.
    Error,
    /// The output is closed.
    OutputClosed,
    /// The next write fails before the input reports a closed output.
    BreakWriter,
}

struct ScriptedInput {
    events: VecDeque<Ev>,
    i: usize,
    transcript: Transcript,
    gates: Gates,
    clock: Rc<TestClock>,
    out_fail: Rc<Cell<bool>>,
}

impl InputPort for ScriptedInput {
    fn next(&mut self) -> InputEvent {
        let Some(ev) = self.events.pop_front() else {
            return InputEvent::End;
        };
        self.transcript
            .borrow_mut()
            .push(format!("EVENT {}", self.i));
        self.i += 1;
        match ev {
            Ev::In(b) => InputEvent::Data(b),
            Ev::Release(g) => {
                self.gates.release(&g);
                InputEvent::Wake
            }
            Ev::Advance(ms) => {
                self.clock.0.fetch_add(ms, Ordering::SeqCst);
                InputEvent::Wake
            }
            Ev::End => InputEvent::End,
            Ev::Close => InputEvent::Close,
            Ev::Error => InputEvent::Error,
            Ev::OutputClosed => {
                self.out_fail.set(true);
                InputEvent::OutputClosed
            }
            Ev::BreakWriter => {
                self.out_fail.set(true);
                InputEvent::Wake
            }
        }
    }
}

struct OutWriter {
    buf: Vec<u8>,
    transcript: Transcript,
    fail: Rc<Cell<bool>>,
}

impl Write for OutWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if self.fail.get() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "closed",
            ));
        }
        self.buf.extend_from_slice(data);
        while let Some(p) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=p).collect();
            self.transcript.borrow_mut().push(format!(
                "OUT {}",
                String::from_utf8_lossy(&line[..line.len() - 1])
            ));
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// No pause between polls.
pub struct ImmediateSleeper;

impl Sleeper for ImmediateSleeper {
    async fn sleep(&self, _ms: u64) {
        yield_now().await;
    }
}

fn str_of<'a>(v: &'a V, k: &str) -> Option<&'a str> {
    v.get(k).and_then(V::as_str)
}

fn json_of(v: &V, k: &str) -> Option<V> {
    str_of(v, k).and_then(parse)
}

fn reason_of(name: &str) -> AcpFailureReason {
    match name {
        "root-not-granted" => AcpFailureReason::RootNotGranted,
        "coding-unavailable" => AcpFailureReason::CodingUnavailable,
        "unknown-session" => AcpFailureReason::UnknownSession,
        "delivery-unavailable" => AcpFailureReason::DeliveryUnavailable,
        "mode-unavailable" => AcpFailureReason::ModeUnavailable,
        _ => AcpFailureReason::SessionLimit,
    }
}

/// `{ fail }`, `{ error }` or `{ errorAnon }` of a script entry as the error it stands for.
fn scripted_error(v: &V) -> Option<BackendError> {
    if let Some(r) = str_of(v, "fail") {
        return Some(BackendError::Failure(reason_of(r)));
    }
    if let Some(n) = str_of(v, "error") {
        return Some(BackendError::Other(Some(n.to_owned())));
    }
    v.has("errorAnon").then_some(BackendError::Other(None))
}

fn exhausted() -> BackendError {
    BackendError::Other(Some("ScriptExhausted".to_owned()))
}

/// A backend that does what the script says.
pub struct ScriptedBackend {
    exec: Rc<Exec>,
    script: V,
    transcript: Transcript,
    gates: Gates,
    next: RefCell<HashMap<&'static str, usize>>,
}

impl ScriptedBackend {
    fn take(&self, list: &'static str) -> Option<&V> {
        let mut next = self.next.borrow_mut();
        let i = next.entry(list).or_insert(0);
        let item = self
            .script
            .get(list)
            .and_then(V::as_arr)
            .and_then(|a| a.get(*i));
        *i += 1;
        item
    }
}

impl AcpBackend for ScriptedBackend {
    fn features(&self) -> Features {
        let f = self.script.get("features");
        let flag = |k: &str| {
            f.and_then(|f| f.get(k))
                .is_some_and(|v| matches!(v, V::Bool(true)))
        };
        Features {
            modes: flag("modes"),
            steer: flag("steer"),
            follow_up: flag("followUp"),
        }
    }

    fn has_set_mode(&self) -> bool {
        !matches!(self.script.get("hasSetMode"), Some(V::Bool(false)))
    }

    fn has_deliver(&self) -> bool {
        !matches!(self.script.get("hasDeliver"), Some(V::Bool(false)))
    }

    async fn create_session(&self, cwd: &str) -> Result<(String, Option<V>), BackendError> {
        self.transcript
            .borrow_mut()
            .push(format!("BACKEND createSession {cwd}"));
        let item = self.take("create").ok_or_else(exhausted)?;
        if let Some(e) = scripted_error(item) {
            return Err(e);
        }
        Ok((
            str_of(item, "sessionId").unwrap_or("").to_owned(),
            json_of(item, "modeJson"),
        ))
    }

    async fn set_mode(&self, session_id: &str, mode: AcpMode) -> Result<(V, bool), BackendError> {
        self.transcript
            .borrow_mut()
            .push(format!("BACKEND setMode {session_id} {}", mode.id()));
        let item = self.take("mode").ok_or_else(exhausted)?;
        if let Some(e) = scripted_error(item) {
            return Err(e);
        }
        Ok((
            json_of(item, "modeJson").unwrap_or(V::Null),
            matches!(item.get("changed"), Some(V::Bool(true))),
        ))
    }

    async fn deliver(
        &self,
        session_id: &str,
        text: &str,
        steer: bool,
    ) -> Result<Option<V>, BackendError> {
        self.transcript.borrow_mut().push(format!(
            "BACKEND deliver {session_id} {} {text}",
            if steer { "steer" } else { "queue" }
        ));
        let item = self.take("deliver").ok_or_else(exhausted)?;
        if let Some(e) = scripted_error(item) {
            return Err(e);
        }
        Ok(json_of(item, "resultJson"))
    }

    async fn prompt(
        &self,
        a: PromptArgs,
        on_update: Rc<dyn Fn(AcpTurnUpdate)>,
        request_permission: Rc<PermHandler>,
    ) -> Result<AcpTurnOutcome, BackendError> {
        self.transcript
            .borrow_mut()
            .push(format!("BACKEND prompt {} {}", a.session_id, a.text));
        let ops = self
            .take("prompts")
            .and_then(V::as_arr)
            .ok_or_else(exhausted)?;
        for op in ops {
            if let Some(t) = str_of(op, "text") {
                on_update(AcpTurnUpdate::Text(t.to_owned()));
            } else if let Some(c) = op.get("toolCall") {
                on_update(AcpTurnUpdate::ToolCall {
                    id: str_of(c, "id").unwrap_or("").to_owned(),
                    name: str_of(c, "name").unwrap_or("").to_owned(),
                    args: json_of(c, "argsJson"),
                });
            } else if let Some(r) = op.get("toolResult") {
                on_update(AcpTurnUpdate::ToolResult {
                    id: str_of(r, "id").unwrap_or("").to_owned(),
                    output: str_of(r, "output").unwrap_or("").to_owned(),
                    content: None,
                });
            } else if let Some(n) = op.get("notice") {
                on_update(AcpTurnUpdate::Notice {
                    reason: if str_of(n, "reason") == Some("approval-refused") {
                        "approval-refused"
                    } else {
                        "profile-changed"
                    },
                    text: str_of(n, "text").unwrap_or("").to_owned(),
                });
            } else if let Some(p) = op.get("permission") {
                let tag = str_of(p, "tag").unwrap_or("").to_owned();
                let ask = ask_of(&json_of(p, "askJson").unwrap_or(V::Null));
                let outcome = request_permission(ask, None).await;
                let shown = match outcome {
                    AcpPermissionOutcome::Cancelled => "cancelled".to_owned(),
                    AcpPermissionOutcome::Selected(o) => format!("selected:{o}"),
                };
                self.transcript
                    .borrow_mut()
                    .push(format!("BACKEND permission {tag} {shown}"));
            } else if let Some(p) = op.get("spawnPermission") {
                let tag = str_of(p, "tag").unwrap_or("").to_owned();
                let ask = ask_of(&json_of(p, "askJson").unwrap_or(V::Null));
                let (handler, transcript) = (request_permission.clone(), self.transcript.clone());
                self.exec.spawn(async move {
                    let outcome = handler(ask, None).await;
                    let shown = match outcome {
                        AcpPermissionOutcome::Cancelled => "cancelled".to_owned(),
                        AcpPermissionOutcome::Selected(o) => format!("selected:{o}"),
                    };
                    transcript
                        .borrow_mut()
                        .push(format!("BACKEND permission {tag} {shown}"));
                });
            } else if let Some(g) = str_of(op, "gate") {
                self.gates.wait(g).await;
            } else if op.has("awaitCancel") {
                self.gates.wait(&format!("cancel:{}", a.session_id)).await;
            } else if let Some(V::Num(n)) = op.get("yield") {
                for _ in 0..(*n as usize) {
                    yield_now().await;
                }
            } else if let Some(state) = str_of(op, "return") {
                let state = match state {
                    "failed" => TurnState::Failed,
                    "cancelled" => TurnState::Cancelled,
                    _ => TurnState::Completed,
                };
                return Ok(AcpTurnOutcome {
                    state,
                    error: str_of(op, "error").map(str::to_owned),
                });
            } else if let Some(n) = str_of(op, "throw") {
                return Err(BackendError::Other(Some(n.to_owned())));
            } else if op.has("throwAnon") {
                return Err(BackendError::Other(None));
            }
        }
        Ok(AcpTurnOutcome {
            state: TurnState::Completed,
            error: None,
        })
    }

    async fn cancel(&self, session_id: &str) -> Result<(), BackendError> {
        self.transcript
            .borrow_mut()
            .push(format!("BACKEND cancel {session_id}"));
        self.gates.release(&format!("cancel:{session_id}"));
        if matches!(self.script.get("cancelError"), Some(V::Bool(true))) {
            return Err(BackendError::Other(Some("Error".to_owned())));
        }
        Ok(())
    }
}

fn ask_of(v: &V) -> AcpPermissionAsk {
    let options = v
        .get("options")
        .and_then(V::as_arr)
        .unwrap_or(&[])
        .iter()
        .map(|o| AcpPermissionOption {
            option_id: str_of(o, "optionId").unwrap_or("").to_owned(),
            name: str_of(o, "name").map(str::to_owned),
            kind: str_of(o, "kind").unwrap_or("").to_owned(),
        })
        .collect();
    AcpPermissionAsk {
        tool_call: v.get("toolCall").cloned().unwrap_or(V::Null),
        options,
    }
}

/// A Core that answers from the script, call by call per method.
pub struct ScriptedRpc {
    script: V,
    transcript: Transcript,
    gates: Gates,
    next: RefCell<HashMap<String, usize>>,
}

impl RpcCaller for ScriptedRpc {
    fn has_method(&self, method: &str) -> bool {
        self.script
            .get("methods")
            .and_then(V::as_arr)
            .is_some_and(|m| m.iter().any(|x| x.as_str() == Some(method)))
    }

    async fn call(&self, method: &str, params: V) -> Result<V, RpcError> {
        self.transcript.borrow_mut().push(format!(
            "RPC {method} {}",
            params.stringify().unwrap_or_default()
        ));
        let list = self
            .script
            .get("calls")
            .and_then(|c| c.get(method))
            .and_then(V::as_arr);
        let i = {
            let mut next = self.next.borrow_mut();
            let slot = next.entry(method.to_owned()).or_insert(0);
            let i = *slot;
            *slot += 1;
            i
        };
        let item = list.and_then(|l| l.get(i).or_else(|| l.last().filter(|x| x.has("repeat"))));
        let Some(item) = item else {
            return Err(RpcError {
                code: None,
                name: Some("ScriptExhausted".to_owned()),
            });
        };
        if let Some(g) = str_of(item, "gate") {
            self.gates.wait(g).await;
        }
        if let Some(e) = item.get("err") {
            return Err(RpcError {
                code: str_of(e, "code").map(str::to_owned),
                name: str_of(e, "name").map(str::to_owned),
            });
        }
        Ok(json_of(item, "okJson").unwrap_or(V::Null))
    }
}

fn from_serde(v: &serde_json::Value) -> V {
    match v {
        serde_json::Value::Null => V::Null,
        serde_json::Value::Bool(b) => V::Bool(*b),
        serde_json::Value::Number(n) => V::Num(n.as_f64().unwrap_or(f64::NAN)),
        serde_json::Value::String(s) => V::Str(s.clone()),
        serde_json::Value::Array(a) => V::Arr(a.iter().map(from_serde).collect()),
        serde_json::Value::Object(m) => {
            V::Obj(m.iter().map(|(k, v)| (k.clone(), from_serde(v))).collect())
        }
    }
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap_or(0))
        .collect()
}

fn events_of(script: &V) -> VecDeque<Ev> {
    script
        .get("events")
        .and_then(V::as_arr)
        .unwrap_or(&[])
        .iter()
        .map(|e| {
            if let Some(t) = str_of(e, "in") {
                Ev::In(t.as_bytes().to_vec())
            } else if let Some(h) = str_of(e, "hex") {
                Ev::In(hex(h))
            } else if let Some(r) = e.get("repeat") {
                let n = r.get("count").and_then(V::as_f64).unwrap_or(0.0) as usize;
                let s = format!(
                    "{}{}{}",
                    str_of(r, "prefix").unwrap_or(""),
                    str_of(r, "unit").unwrap_or("").repeat(n),
                    str_of(r, "suffix").unwrap_or("")
                );
                Ev::In(s.into_bytes())
            } else if let Some(r) = e.get("nest") {
                let n = r.get("depth").and_then(V::as_f64).unwrap_or(0.0) as usize;
                let s = format!(
                    "{}{}{}{}",
                    str_of(r, "prefix").unwrap_or(""),
                    "[".repeat(n),
                    "]".repeat(n),
                    str_of(r, "suffix").unwrap_or("")
                );
                Ev::In(s.into_bytes())
            } else if let Some(g) = str_of(e, "release") {
                Ev::Release(g.to_owned())
            } else if let Some(V::Num(ms)) = e.get("advance") {
                Ev::Advance(*ms as i64)
            } else if e.has("close") {
                Ev::Close
            } else if e.has("error") {
                Ev::Error
            } else if e.has("outputClosed") {
                Ev::OutputClosed
            } else if e.has("breakWriter") {
                Ev::BreakWriter
            } else {
                Ev::End
            }
        })
        .collect()
}

/// Runs one scenario of `fixtures/parity/acp/` and returns its transcript.
pub fn run_scenario(scenario: &serde_json::Value) -> Vec<String> {
    let sc = from_serde(scenario);
    let transcript: Transcript = Rc::new(RefCell::new(Vec::new()));
    let gates = Gates::default();
    let clock = Rc::new(TestClock::default());
    let out_fail = Rc::new(Cell::new(false));
    let exec = Exec::new();
    let ids = Rc::new(ListIds::new(
        sc.get("ids")
            .and_then(V::as_arr)
            .unwrap_or(&[])
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect(),
    ));
    let input = ScriptedInput {
        events: events_of(&sc),
        i: 0,
        transcript: transcript.clone(),
        gates: gates.clone(),
        clock: clock.clone(),
        out_fail: out_fail.clone(),
    };
    let output = OutWriter {
        buf: Vec::new(),
        transcript: transcript.clone(),
        fail: out_fail,
    };
    let log_tx = transcript.clone();
    let log: Rc<LogFn> = Rc::new(move |event: &str, fields: &[(&str, LogVal)]| {
        let mut v = V::obj([("e", V::s(event))]);
        for (k, val) in fields {
            v.set(
                k,
                match val {
                    LogVal::S(s) => V::Str(s.clone()),
                    LogVal::N(n) => V::Num(*n),
                    LogVal::B(b) => V::Bool(*b),
                },
            );
        }
        log_tx
            .borrow_mut()
            .push(format!("LOG {}", v.stringify().unwrap_or_default()));
    });
    let server_opts = sc.get("server");
    let language = if server_opts.and_then(|s| str_of(s, "language")) == Some("de") {
        AcpLanguage::De
    } else {
        AcpLanguage::En
    };
    let max_line = server_opts
        .and_then(|s| s.get("maxLineBytes"))
        .and_then(V::as_f64)
        .map(|n| n as usize);
    let max_pending = server_opts
        .and_then(|s| s.get("maxPending"))
        .and_then(V::as_f64)
        .map(|n| n as usize);
    let timeout = server_opts
        .and_then(|s| s.get("permissionTimeoutMs"))
        .and_then(V::as_f64)
        .map(|n| n as i64);
    let agent_info = server_opts
        .and_then(|s| s.get("agentInfo"))
        .and_then(V::as_arr)
        .map(|a| {
            let g = |i: usize| a.get(i).and_then(V::as_str).unwrap_or("").to_owned();
            (g(0), g(1), g(2))
        });
    let hung;
    if let Some(rpc) = sc.get("rpc") {
        let core = sc.get("core");
        let client = Rc::new(ScriptedRpc {
            script: rpc.clone(),
            transcript: transcript.clone(),
            gates: gates.clone(),
            next: RefCell::new(HashMap::new()),
        });
        let initial = core
            .and_then(|c| str_of(c, "initialMode"))
            .and_then(|m| AcpMode::from_value(Some(&V::s(m))));
        let backend = Rc::new(CoreSessionBackend::new(CoreSessionBackendOptions {
            client,
            caller: Caller {
                channel: "cli".into(),
                account_id: "acc".into(),
                user_id: "u".into(),
            },
            agent_id: core
                .and_then(|c| str_of(c, "agentId"))
                .unwrap_or("bernd")
                .to_owned(),
            sleeper: ImmediateSleeper,
            poll_ms: None,
            initial_mode: initial,
            language,
            exec: exec.clone(),
        }));
        hung = serve(
            backend,
            input,
            output,
            log,
            agent_info,
            max_line,
            max_pending,
            language,
            clock,
            ids,
            timeout,
            exec.clone(),
        );
    } else {
        let backend = Rc::new(ScriptedBackend {
            exec: exec.clone(),
            script: sc.get("backend").cloned().unwrap_or(V::Null),
            transcript: transcript.clone(),
            gates: gates.clone(),
            next: RefCell::new(HashMap::new()),
        });
        hung = serve(
            backend,
            input,
            output,
            log,
            agent_info,
            max_line,
            max_pending,
            language,
            clock,
            ids,
            timeout,
            exec.clone(),
        );
    }
    if hung > 0 {
        transcript.borrow_mut().push("HUNG".to_owned());
    }
    let out = transcript.borrow().clone();
    out
}

#[allow(clippy::too_many_arguments)]
fn serve<B: AcpBackend + 'static>(
    backend: Rc<B>,
    input: ScriptedInput,
    output: OutWriter,
    log: Rc<LogFn>,
    agent_info: Option<(String, String, String)>,
    max_line_bytes: Option<usize>,
    max_pending: Option<usize>,
    language: AcpLanguage,
    clock: Rc<TestClock>,
    ids: Rc<ListIds>,
    permission_timeout_ms: Option<i64>,
    exec: Rc<Exec>,
) -> usize {
    let server = AcpServer::new(AcpServerOptions {
        backend,
        input: Box::new(input),
        output: Box::new(output),
        log: Some(log),
        agent_info,
        max_line_bytes,
        max_pending,
        language,
        clock,
        ids,
        permission_timeout_ms,
        exec,
    });
    server.run()
}
