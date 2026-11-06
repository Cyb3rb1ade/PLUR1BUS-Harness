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
        opened: bound.opened,
        open_params: bound.params,
        lang,
        interactive,
        color,
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
                if let Some(operation) = self.deferred.pop_front() {
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
                        self.command_error(error)?;
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
                    Event::Interrupt => {
                        if self.interrupt()? {
                            self.cancel_for_exit();
                            break;
                        }
                    }
                    Event::Eof => {
                        if !self.interactive {
                            self.eof = true;
                        } else if self.running.is_none() && self.operation.is_none() {
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
            op.method
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
        self.frontend.update(|state| state.status = status.into());
    }
    fn interrupt(&mut self) -> Result<bool, CodeError> {
        let busy = self.running.is_some() || self.operation.is_some();
        match self.interrupts.press(self.began.elapsed(), busy) {
            Interrupt::Exit => return Ok(true),
            Interrupt::Clear => {
                self.model_question = None;
                self.frontend.update(|state| state.question.clear());
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
        let model_busy = self.running.is_some()
            || self
                .operation
                .as_ref()
                .is_some_and(|op| matches!(op.kind, Kind::Submit | Kind::Transcript));
        if !model_busy && self.operation.is_none() {
            return;
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
