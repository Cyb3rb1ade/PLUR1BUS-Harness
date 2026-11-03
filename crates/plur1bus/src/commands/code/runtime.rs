//! Frontend-independent session loop. Calls, stream events and human input meet here; neither renderer owns RPC.
mod actions;
mod events;
use super::{
    approve, binding,
    commands::{self, Command},
    input::{self, AcceptKey, Delivery, Frontend, Interrupt, Interrupts},
    lang::Language,
    pump::{Bus, Event},
    render,
    signals::Signals,
    stream::{Reader, SessionStream},
    CodeArgs, CodeError,
};
use crate::{identity::CallerIdentity, output::Out, paths::Layout};
use plur1bus_rpc::Client;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    io::IsTerminal,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::Receiver,
        Arc,
    },
    time::{Duration, Instant},
};

#[derive(Clone)]
enum Kind {
    Status(&'static str),
    Submit,
    Transcript,
    Check,
    Diff,
    Done,
    ModelGet(Option<Value>),
    ModelPreview {
        params: Value,
        base_revision: Option<Value>,
    },
    ModelApply,
    QueueList(Option<usize>),
    QueueRemove,
}
struct Operation {
    kind: Kind,
    method: &'static str,
    params: Value,
    started: Instant,
}
struct Runtime {
    client: Option<Client>,
    reader: Reader,
    frontend: Frontend,
    receiver: Receiver<super::pump::Envelope>,
    stop: Arc<AtomicBool>,
    signals: Signals,
    home: std::path::PathBuf,
    caller: CallerIdentity,
    session: String,
    agent: String,
    opened: Value,
    open_params: Value,
    lang: Language,
    interactive: bool,
    color: bool,
    auto_model: bool,
    running: Option<String>,
    operation: Option<Operation>,
    deferred: VecDeque<Operation>,
    completed: VecDeque<String>,
    failed: bool,
    denied: bool,
    eof: bool,
    input_pending: bool,
    pending_line: Option<(String, AcceptKey)>,
    model_question: Option<Value>,
    approvals: BTreeMap<String, Value>,
    deciding: BTreeSet<String>,
    approval_order: VecDeque<String>,
    approval_answers: BTreeMap<String, Value>,
    tools: BTreeMap<String, Value>,
    queue_items: Vec<Value>,
    initial_seq: u64,
    initial_turn: Option<String>,
    partial: String,
    interrupts: Interrupts,
    began: Instant,
}

pub(super) fn run(out: &Out, layout: &Layout, args: CodeArgs) -> Result<(), CodeError> {
    let interactive = args.message.is_none()
        && !out.json
        && std::io::stdin().is_terminal()
        && std::io::stdout().is_terminal();
    let color = interactive
        && std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty())
        && crate::output::color_decision(
            crate::output::color_from_args(std::env::args_os().skip(1)),
            None,
            true,
        );
    let lang = Language::environment();
    let fullscreen =
        input::fullscreen_enabled(args.tui, interactive, std::env::var("TERM").ok().as_deref());
    if args.tui && !fullscreen {
        eprintln!(
            "{}",
            lang.text(
                "Fullscreen display unavailable here; using line mode.",
                "Vollbildanzeige hier nicht verfügbar; verwende den Zeilenmodus."
            )
        );
    }
    let bound = binding::open(out, layout, &args, interactive, lang)?;
    let initial_seq = bound.opened["lastEventSeq"].as_u64().unwrap_or(0);
    let running = bound.opened["runningTurnId"].as_str().map(str::to_string);
    let stop = Arc::new(AtomicBool::new(false));
    let (bus, receiver) = Bus::channel(stop.clone());
    let signals = Signals::install()?;
    let frontend = Frontend::start(
        interactive,
        args.message.is_none(),
        color,
        bus.clone(),
        stop.clone(),
        fullscreen,
        lang,
    )?;
    frontend.update(|state| {
        state.header = format!(
            "{} · {} · {}",
            render::safe(&bound.agent, false),
            render::safe(bound.opened["branch"].as_str().unwrap_or("HEAD"), false),
            render::safe(bound.opened["root"].as_str().unwrap_or("?"), false)
        );
        state.status = lang.text("idle", "bereit").into();
    });
    // An active turn is replayed from its beginning; completed history is suppressed by the initial high-water mark.
    let reader = Reader::spawn(
        layout,
        super::connect(layout)?,
        SessionStream::new(
            &bound.session,
            &bound.agent,
            &bound.caller,
            if running.is_some() { 0 } else { initial_seq },
        ),
        bus,
        stop.clone(),
    )?;
    let mut runtime = Runtime {
        client: Some(bound.client),
        reader,
        frontend,
        receiver,
        stop,
        signals,
        home: layout.home.clone(),
        caller: bound.caller,
        session: bound.session,
        agent: bound.agent,
        opened: bound.opened,
        open_params: bound.params,
        lang,
        interactive,
        color: color && !fullscreen,
        auto_model: args.yes,
        initial_turn: running.clone(),
        running,
        initial_seq,
        operation: None,
        deferred: VecDeque::new(),
        completed: VecDeque::new(),
        failed: false,
        denied: false,
        eof: args.message.is_some(),
        input_pending: false,
        pending_line: args.message.map(|s| (s, AcceptKey::Enter)),
        model_question: None,
        approvals: BTreeMap::new(),
        deciding: BTreeSet::new(),
        approval_order: VecDeque::new(),
        approval_answers: BTreeMap::new(),
        tools: BTreeMap::new(),
        queue_items: vec![],
        partial: String::new(),
        interrupts: Interrupts::default(),
        began: Instant::now(),
    };
    runtime.emit("code.session.open", runtime.opened.clone())?;
    runtime.refresh_status();
    let outcome = runtime.run_loop();
    // Stop native input before a final cancel/reconnect; every path (including unwind) retains the restoration guards.
    runtime.stop.store(true, Ordering::Release);
    outcome
}

impl Runtime {
    fn run_loop(&mut self) -> Result<(), CodeError> {
        loop {
            if self.signals.terminated() {
                self.cancel_for_exit();
                return Err(CodeError::new(
                    "E_CANCELLED",
                    self.lang
                        .text("coding frontend terminated", "Coding-CLI beendet"),
                ));
            }
            if self.signals.take_interrupt() && self.interrupt()? {
                self.cancel_for_exit();
                break;
            }
            if self.operation.is_none() {
                let status_waits = self
                    .deferred
                    .front()
                    .is_some_and(|op| matches!(op.kind, Kind::Status(_)))
                    && (self.pending_line.is_some()
                        || self.model_question.is_some()
                        || !self.approval_order.is_empty());
                if let Some(operation) = if status_waits {
                    None
                } else {
                    self.deferred.pop_front()
                } {
                    self.begin(operation)?;
                }
            }
            if self.running.is_none() && self.operation.is_none() {
                if let Some((line, key)) = self.pending_line.take() {
                    self.handle_input(line, key)?;
                }
            }
            if self.operation.is_some() {
                let polled = self.client()?.poll_call();
                match polled {
                    Ok(Some(result)) => {
                        if let Some(operation) = self.operation.take() {
                            self.result(operation, result)?;
                        }
                    }
                    Ok(None) => {
                        if self.operation.as_ref().is_some_and(|op| {
                            op.started.elapsed()
                                > if matches!(op.kind, Kind::Check | Kind::Done) {
                                    Duration::from_secs(45 * 60)
                                } else {
                                    Duration::from_secs(30)
                                }
                        }) {
                            return Err(CodeError::new(
                                "E_TIMEOUT",
                                "coding command deadline exceeded",
                            ));
                        }
                    }
                    Err(error) => {
                        let broken = self.client.as_ref().is_none_or(Client::is_poisoned);
                        let operation = self.operation.take();
                        let error = CodeError::from(error);
                        if broken {
                            return Err(error);
                        }
                        if let Some(method) = operation.as_ref().and_then(|op| {
                            if let Kind::Status(method) = op.kind {
                                Some(method)
                            } else {
                                None
                            }
                        }) {
                            self.frontend.metadata(
                                method,
                                &Value::Null,
                                &self.session,
                                &self.agent,
                            );
                        } else {
                            self.command_error(error)?;
                        }
                        if operation
                            .is_some_and(|op| matches!(op.kind, Kind::Submit | Kind::Transcript))
                            && self.running.is_none()
                        {
                            self.input_pending = false;
                            self.frontend.next_line();
                        }
                    }
                }
            }
            match self.receiver.recv_timeout(Duration::from_millis(20)) {
                Ok(envelope) => match envelope.into_event() {
                    Event::Input(line, key) => {
                        if !self.interactive && (self.running.is_some() || self.operation.is_some())
                        {
                            self.pending_line = Some((line, key));
                        } else if let Err(error) = self.handle_input(line.clone(), key) {
                            self.command_error(error)?;
                            self.frontend.restore(&line)?;
                            if !self.interactive {
                                self.frontend.next_line();
                            }
                        }
                    }
                    #[cfg(feature = "tui")]
                    Event::FrontendInput {
                        line,
                        key,
                        question,
                    } => self.frontend_input(line, key, question)?,
                    Event::Interrupt => {
                        if self.interrupt()? {
                            self.cancel_for_exit();
                            break;
                        }
                    }
                    Event::Eof => {
                        if !self.interactive {
                            self.eof = true;
                        } else if self.running.is_none()
                            && self
                                .operation
                                .as_ref()
                                .is_none_or(|op| matches!(op.kind, Kind::Status(_)))
                        {
                            break;
                        } else {
                            self.note(self.lang.text(
                                "Cancel with Ctrl+C; Ctrl+D exits when idle.",
                                "Ctrl+C bricht ab; Ctrl+D beendet die CLI im Leerlauf.",
                            ))?;
                        }
                    }
                    Event::Frame(frame) => self.frame(frame)?,
                    Event::Reply { operation, result } => self.reader_reply(&operation, result)?,
                    Event::Notice(message) => self.note(match message.as_str() {
                        "event-reconnect" => self.lang.text(
                            "Event connection interrupted; reconnecting and replaying.",
                            "Event-Verbindung unterbrochen; verbinde neu und hole Events nach.",
                        ),
                        "input-too-long" => self.lang.text(
                            "Input exceeds 200000 characters.",
                            "Eingabe überschreitet 200000 Zeichen.",
                        ),
                        _ => &message,
                    })?,
                    Event::Failed(error) => return Err(error),
                },
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(CodeError::new("E_IO", "coding event bus closed"))
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
            if self.running.is_none()
                && self.operation.is_none()
                && self.deferred.is_empty()
                && self.pending_line.is_none()
            {
                if self.input_pending {
                    self.input_pending = false;
                    self.frontend.next_line();
                }
                if self.eof {
                    break;
                }
            }
            self.status();
        }
        self.flush_partial()?;
        if self.failed {
            Err(CodeError::new(
                if self.denied {
                    "E_APPROVAL_REQUIRED"
                } else {
                    "E_TURN_FAILED"
                },
                self.lang.text(
                    "one or more coding turns or checks failed",
                    "Mindestens ein Coding-Turn oder Check ist fehlgeschlagen",
                ),
            ))
        } else {
            Ok(())
        }
    }
    #[cfg(feature = "tui")]
    fn frontend_input(
        &mut self,
        line: String,
        key: AcceptKey,
        question: Option<String>,
    ) -> Result<(), CodeError> {
        let current = self.frontend.question_id();
        match input::classify_input(question.as_deref(), current.as_deref()) {
            input::InputDisposition::Deliver => {
                let status_pending = self
                    .operation
                    .as_ref()
                    .is_some_and(|op| matches!(op.kind, Kind::Status(_)));
                if question.is_none()
                    && self.running.is_none()
                    && status_pending
                    && self.pending_line.is_none()
                {
                    self.pending_line = Some((line, key));
                } else if let Err(error) = self.handle_input(line.clone(), key) {
                    self.command_error(error)?;
                    if question.is_none() {
                        self.frontend.restore(&line)?;
                    }
                }
            }
            input::InputDisposition::RestoreDraft => {
                self.frontend.restore(&line)?;
                self.note(self.lang.text(
                    "A question arrived; your draft is preserved.",
                    "Eine Frage ist eingetroffen; der Entwurf bleibt erhalten.",
                ))?;
            }
            input::InputDisposition::DiscardAnswer => self.note(self.lang.text(
                "The displayed question changed; review the current request.",
                "Die angezeigte Frage hat sich geändert; prüfe die aktuelle Anfrage.",
            ))?,
        }
        Ok(())
    }
    fn client(&mut self) -> Result<&mut Client, CodeError> {
        self.client
            .as_mut()
            .ok_or_else(|| CodeError::new("E_CORE_UNAVAILABLE", "call connection closed"))
    }
    fn supports(&self, method: &str) -> bool {
        self.client
            .as_ref()
            .is_some_and(|client| client.supports(method))
    }
    fn feature(&self, method: &str) -> bool {
        self.client.as_ref().is_some_and(|client| {
            client.hello()["capabilities"].is_object() && client.supports(method)
        })
    }
    fn params(&self) -> Value {
        json!({"caller":self.caller,"sessionId":self.session})
    }
    fn start(&mut self, kind: Kind, method: &'static str, params: Value) -> Result<(), CodeError> {
        let operation = Operation {
            kind,
            method,
            params,
            started: Instant::now(),
        };
        if self.operation.is_some() {
            if matches!(operation.kind, Kind::Submit) && self.deferred.len() < 20 {
                self.deferred.push_back(operation);
                return Ok(());
            }
            return Err(CodeError::new(
                "E_BUSY",
                self.lang.text(
                    "a command is still running; input retained",
                    "Ein Befehl läuft noch; Eingabe bleibt erhalten",
                ),
            ));
        }
        self.begin(operation)
    }
    fn begin(&mut self, mut operation: Operation) -> Result<(), CodeError> {
        if !self.supports(operation.method) {
            return Err(CodeError::new(
                "E_NOT_AVAILABLE",
                format!("core does not provide {}", operation.method),
            ));
        }
        self.client()?
            .start_call(operation.method, operation.params.clone())?;
        operation.started = Instant::now();
        self.operation = Some(operation);
        Ok(())
    }
    fn emit(&self, method: &str, result: Value) -> Result<(), CodeError> {
        if !self.interactive {
            self.frontend.print(&render::json_event(
                &json!({"method":method,"result":result}),
            )?)?;
        }
        Ok(())
    }
    fn note(&self, text: &str) -> Result<(), CodeError> {
        if self.interactive {
            self.frontend.print(&render::safe(text, true))
        } else {
            self.emit("code.notice", json!({"message":text}))
        }
    }
    fn command_error(&mut self, error: CodeError) -> Result<(), CodeError> {
        if self.interactive {
            self.note(&format!("{}: {}", error.code, error.message))
        } else {
            self.failed = true;
            self.emit(
                "code.error",
                json!({"error":error.code,"message":error.message,"reason":error.reason}),
            )
        }
    }
    fn status(&self) {
        let status = if let Some(op) = &self.operation {
            if self.frontend.is_tui() {
                match op.kind {
                    Kind::Status(_) => self.lang.text("loading status", "Status wird geladen"),
                    Kind::Check => self.lang.text("checking", "prüfe"),
                    Kind::Diff => self.lang.text("reading diff", "lese Diff"),
                    Kind::Submit | Kind::Transcript => self.lang.text("sending", "sende"),
                    _ => self.lang.text("working", "arbeite"),
                }
            } else {
                op.method
            }
        } else if self.running.is_some() {
            if self.feature("session.queue.list") {
                self.lang.text(
                    "running · Enter steers · Alt+Enter queues",
                    "läuft · Enter steuert · Alt+Enter reiht ein",
                )
            } else {
                self.lang
                    .text("running · Ctrl+C cancels", "läuft · Ctrl+C bricht ab")
            }
        } else {
            self.lang.text("idle", "bereit")
        };
        self.frontend.update(|state| {
            state.status = status.into();
            state.busy = self.running.is_some()
                || self
                    .operation
                    .as_ref()
                    .is_some_and(|op| !matches!(op.kind, Kind::Status(_)));
        });
    }

    fn refresh_status(&mut self) {
        if !self.frontend.is_tui() {
            return;
        }
        for method in [
            "session.model.get",
            "telemetry.cache.summary",
            "budget.status",
        ] {
            if !self.feature(method)
                || self
                    .operation
                    .as_ref()
                    .is_some_and(|op| matches!(op.kind,Kind::Status(m) if m==method))
                || self
                    .deferred
                    .iter()
                    .any(|op| matches!(op.kind,Kind::Status(m) if m==method))
            {
                continue;
            }
            let params = match method {
                "session.model.get" => self.params(),
                "telemetry.cache.summary" => {
                    json!({"window":"24h","agentId":self.agent,"sessionId":self.session})
                }
                _ => json!({"agentId":self.agent}),
            };
            self.deferred.push_back(Operation {
                kind: Kind::Status(method),
                method,
                params,
                started: Instant::now(),
            });
        }
    }
    fn interrupt(&mut self) -> Result<bool, CodeError> {
        let busy = self.running.is_some()
            || self
                .operation
                .as_ref()
                .is_some_and(|op| !matches!(op.kind, Kind::Status(_)));
        match self.interrupts.press(self.began.elapsed(), busy) {
            Interrupt::Exit => return Ok(true),
            Interrupt::Clear => {
                self.model_question = None;
                self.frontend.question(None, String::new(), String::new());
            }
            Interrupt::Cancel => {
                self.model_question = None;
                if self.running.is_some()
                    || self
                        .operation
                        .as_ref()
                        .is_some_and(|op| matches!(op.kind, Kind::Submit | Kind::Transcript))
                {
                    self.reader
                        .command("cancel", "session.cancel", self.params())?;
                } else if self.operation.is_some() {
                    // Dropping this connection aborts a human check's existing RPC signal and verifier process group.
                    drop(self.client.take());
                    self.operation = None;
                    self.client = Some(super::connect(&Layout::new(self.home.clone()))?);
                    let params = self.open_params.clone();
                    let opened = binding::call(self.client()?, "code.session.open", params)?;
                    if opened["state"] != "open" {
                        return Err(CodeError::new(
                            "E_APPROVAL_REQUIRED",
                            "native task ended; reopen the folder to request a new task grant",
                        ));
                    }
                    self.note(self.lang.text("Command cancelled.", "Befehl abgebrochen."))?;
                }
            }
        }
        Ok(false)
    }
    fn cancel_for_exit(&mut self) {
        self.frontend.leave_tui();
        let model_busy = self.running.is_some()
            || self
                .operation
                .as_ref()
                .is_some_and(|op| matches!(op.kind, Kind::Submit | Kind::Transcript));
        if !model_busy && self.operation.is_none() {
            return;
        }
        if model_busy
            && self
                .reader
                .command("exit-cancel", "session.cancel", self.params())
                .is_ok()
        {
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                match self
                    .receiver
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                {
                    Ok(envelope) => {
                        if matches!(envelope.into_event(),Event::Reply{operation,..} if operation=="exit-cancel")
                        {
                            drop(self.client.take());
                            self.operation = None;
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
        }
        // Drop before reconnecting: the frontend never holds more than its two RPC connections.
        drop(self.client.take());
        self.operation = None;
        if model_busy {
            if let Ok(mut client) = super::connect(&Layout::new(self.home.clone())) {
                let _ = super::pump::request(
                    &mut client,
                    "session.cancel",
                    self.params(),
                    &AtomicBool::new(false),
                    Duration::from_secs(2),
                );
            }
        }
    }
}
