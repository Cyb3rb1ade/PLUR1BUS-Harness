//! The ACP (Agent Client Protocol, schema v1, ADR-008) agent side over a line-framed stream (port of
//! `packages/core/src/acp/server.ts`). It implements `initialize`, `session/new`, `session/prompt`, `session/cancel` and sends
//! `session/update`; everything else is a JSON-RPC error.
//!
//! Hygiene (ADR-008 stdout rule): the output carries JSON-RPC lines and nothing else. The log sink gets event names and small
//! counts only: never prompt text, model output, tool arguments, error text from a provider or any credential.
//!
//! The server is driven by an [`InputPort`] and writes to a [`Write`]; it owns no thread and no timer. A deadline (the
//! permission timeout) fires when the driver wakes it, so a real adapter wakes it at least at [`AcpServer::next_deadline`].
//!
//! Fail closed: a request other than `initialize` before the handshake is refused; a reply that is not the answer to an
//! agent-issued permission id confers nothing; a malformed answer to a permission request is a cancel.
use super::backend::{
    AcpBackend, AcpTurnUpdate, BackendError, PermFuture, PermHandler, PromptArgs, TurnState,
};
use super::exec::{yield_now, Exec, Signal};
use super::framing::{encode_line, LineItem, LineReader, MAX_LINE_BYTES};
use super::json::{parse, V};
use super::permissions::{AcpPermissions, DEFAULT_PERMISSION_TIMEOUT_MS};
use super::text::{acp_text, mode_state, AcpFailureReason, AcpLanguage, AcpMode};
use crate::budget::{Clock, IdSource};
use crate::js::{js_trim, utf16, utf16_len};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::rc::Rc;

/// The ACP schema version this server speaks (ADR-008; v2 alpha excluded).
pub const ACP_PROTOCOL_VERSION: u64 = 1;
/// `session.submit`'s text limit (rpc.schema.json): a longer prompt is refused here instead of by the core.
pub const MAX_PROMPT_CHARS: usize = 200_000;
const MAX_RAW_FILE_INPUT_BYTES: usize = 128 * 1024;

const ERR_PARSE: i64 = -32700;
const ERR_INVALID_REQUEST: i64 = -32600;
const ERR_METHOD_NOT_FOUND: i64 = -32601;
const ERR_INVALID_PARAMS: i64 = -32602;
const ERR_INTERNAL: i64 = -32603;
const ERR_BUSY: i64 = -32000;

/// A value of a log field (`string | number | boolean`).
#[derive(Clone, Debug, PartialEq)]
pub enum LogVal {
    /// A string.
    S(String),
    /// A number.
    N(f64),
    /// A boolean.
    B(bool),
}

/// The log sink: an event name and small fields.
pub type LogFn = dyn Fn(&str, &[(&str, LogVal)]);

/// What happens on the input side.
#[derive(Debug, PartialEq, Eq)]
pub enum InputEvent {
    /// Bytes arrived.
    Data(Vec<u8>),
    /// Something outside the input happened (time passed, a gate opened): run what can run.
    Wake,
    /// The stream reported an error (it stays open).
    Error,
    /// The input ended.
    End,
    /// The input was destroyed without an end.
    Close,
    /// Nobody reads the output any more.
    OutputClosed,
}

/// Where the server's input comes from. `next` blocks until something happens.
pub trait InputPort {
    /// The next event.
    fn next(&mut self) -> InputEvent;
}

/// What a server needs.
pub struct AcpServerOptions<B: AcpBackend + 'static> {
    /// The backend.
    pub backend: Rc<B>,
    /// The input.
    pub input: Box<dyn InputPort>,
    /// The output (JSON-RPC lines only).
    pub output: Box<dyn Write>,
    /// The log sink.
    pub log: Option<Rc<LogFn>>,
    /// `agentInfo` (name, title, version).
    pub agent_info: Option<(String, String, String)>,
    /// The line bound (default 1 MiB).
    pub max_line_bytes: Option<usize>,
    /// The language of the texts.
    pub language: AcpLanguage,
    /// The clock behind the permission timeout.
    pub clock: Rc<dyn Clock>,
    /// Where permission request ids come from.
    pub ids: Rc<dyn IdSource>,
    /// The permission timeout (default five minutes).
    pub permission_timeout_ms: Option<i64>,
    /// The executor the backend's detached work shares.
    pub exec: Rc<Exec>,
}

enum Fail {
    Acp {
        code: i64,
        message: &'static str,
        data: Option<V>,
    },
    Failure(AcpFailureReason),
    Backend(BackendError),
}

impl From<BackendError> for Fail {
    fn from(e: BackendError) -> Fail {
        match e {
            BackendError::Failure(r) => Fail::Failure(r),
            other => Fail::Backend(other),
        }
    }
}

fn acp(code: i64, message: &'static str) -> Fail {
    Fail::Acp {
        code,
        message,
        data: None,
    }
}

fn acp_data(code: i64, message: &'static str, data: V) -> Fail {
    Fail::Acp {
        code,
        message,
        data: Some(data),
    }
}

fn unknown_session() -> Fail {
    acp_data(
        ERR_INVALID_PARAMS,
        "unknown session",
        V::obj([("reason", V::s("unknown-session"))]),
    )
}

struct Running {
    cancel_requested: Cell<bool>,
    permission_abort: Signal,
}

struct Inner<B: AcpBackend + 'static> {
    backend: Rc<B>,
    log: Option<Rc<LogFn>>,
    agent_info: Option<(String, String, String)>,
    language: AcpLanguage,
    exec: Rc<Exec>,
    sessions: RefCell<HashSet<String>>,
    running: RefCell<HashMap<String, Rc<Running>>>,
    pending: Cell<usize>,
    perms: Rc<AcpPermissions>,
    initialized: Cell<bool>,
    closed: Cell<bool>,
    out_gone: Cell<bool>,
    out: RefCell<Box<dyn Write>>,
}

/// The server.
pub struct AcpServer<B: AcpBackend + 'static> {
    inner: Rc<Inner<B>>,
    input: RefCell<Box<dyn InputPort>>,
    reader: RefCell<LineReader>,
    timeout_ms: i64,
}

impl<B: AcpBackend + 'static> AcpServer<B> {
    /// A server over the given streams.
    pub fn new(o: AcpServerOptions<B>) -> AcpServer<B> {
        let timeout_ms = o
            .permission_timeout_ms
            .unwrap_or(DEFAULT_PERMISSION_TIMEOUT_MS);
        let inner = Rc::new_cyclic(|weak: &std::rc::Weak<Inner<B>>| {
            let weak = weak.clone();
            Inner {
                backend: o.backend,
                log: o.log,
                agent_info: o.agent_info,
                language: o.language,
                exec: o.exec,
                sessions: RefCell::new(HashSet::new()),
                running: RefCell::new(HashMap::new()),
                pending: Cell::new(0),
                perms: AcpPermissions::new(
                    move |message| weak.upgrade().is_some_and(|i| i.send(message)),
                    o.clock,
                    o.ids,
                    timeout_ms,
                ),
                initialized: Cell::new(false),
                closed: Cell::new(false),
                out_gone: Cell::new(false),
                out: RefCell::new(o.output),
            }
        });
        AcpServer {
            inner,
            input: RefCell::new(o.input),
            reader: RefCell::new(LineReader::new(o.max_line_bytes.unwrap_or(MAX_LINE_BYTES))),
            timeout_ms,
        }
    }

    /// The permission timeout in force.
    pub fn permission_timeout_ms(&self) -> i64 {
        self.timeout_ms
    }

    /// Serves until the input ends, then cancels what is still running and lets it settle. Returns how many messages are still
    /// being handled (more than 0: something never settled, e.g. a backend that ignores its cancel).
    pub fn run(&self) -> usize {
        let inner = &self.inner;
        let mut finished = false;
        loop {
            let event = self.input.borrow_mut().next();
            let mut end = false;
            match event {
                InputEvent::Data(chunk) => {
                    // TS keeps its input listeners after a finish caused by a lost reader, so input still gets handled.
                    let items = self.reader.borrow_mut().push(&chunk);
                    self.handle(items);
                }
                InputEvent::Wake => {}
                InputEvent::Error => inner.log("input-error", &[]),
                InputEvent::End => {
                    self.finish(true, &mut finished);
                    end = true;
                }
                InputEvent::Close => {
                    self.finish(false, &mut finished);
                    end = true;
                }
                InputEvent::OutputClosed => {
                    // A reader that went away (EPIPE, closed pipe): stop writing, stop the work nobody can receive.
                    if !inner.out_gone.replace(true) {
                        inner.log("output-error", &[]);
                        self.finish(false, &mut finished);
                    }
                }
            }
            inner.perms().expire();
            inner.exec.run_until_stalled();
            if end {
                break;
            }
        }
        // The input is gone: wait for what is running, as far as it can settle without more input (a gate opened from
        // outside, a cancelled turn).
        while inner.pending.get() > 0 {
            match self.input.borrow_mut().next() {
                InputEvent::Wake | InputEvent::Error => {
                    inner.perms().expire();
                    inner.exec.run_until_stalled();
                }
                InputEvent::Data(_) => {}
                InputEvent::End | InputEvent::Close | InputEvent::OutputClosed => break,
            }
        }
        inner.pending.get()
    }

    /// When the earliest open permission request times out (milliseconds on the server's clock); `None` when none is open.
    pub fn next_deadline(&self) -> Option<i64> {
        self.inner.perms().next_deadline()
    }

    fn handle(&self, items: Vec<LineItem>) {
        let inner = &self.inner;
        for item in items {
            match item {
                LineItem::Overflow => {
                    inner.log("line-too-long", &[]);
                    inner.send(&error_message(
                        V::Null,
                        ERR_INVALID_REQUEST,
                        "line too long",
                        Some(V::obj([("reason", V::s("line-too-long"))])),
                    ));
                }
                LineItem::Line(line) => {
                    inner.pending.set(inner.pending.get() + 1);
                    let me = inner.clone();
                    inner.exec.spawn(async move {
                        me.message(&line).await;
                        me.pending.set(me.pending.get() - 1);
                    });
                }
            }
        }
    }

    fn finish(&self, flush: bool, finished: &mut bool) {
        if *finished {
            return;
        }
        *finished = true;
        if flush {
            let items = self.reader.borrow_mut().end();
            self.handle(items);
        }
        let inner = &self.inner;
        inner.closed.set(true);
        inner.perms().close();
        let running: Vec<(String, Rc<Running>)> = inner
            .running
            .borrow()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (sid, st) in running {
            st.cancel_requested.set(true);
            st.permission_abort.abort();
            let backend = inner.backend.clone();
            inner.exec.spawn(async move {
                let _ = backend.cancel(&sid).await;
            });
        }
    }
}

fn error_message(id: V, code: i64, message: &str, data: Option<V>) -> V {
    let mut error = V::obj([("code", V::Num(code as f64)), ("message", V::s(message))]);
    if let Some(d) = data {
        error.set("data", d);
    }
    V::obj([("jsonrpc", V::s("2.0")), ("id", id), ("error", error)])
}

/// `String.prototype.slice(0, 64)` plus `…` and the printable-ASCII filter, over UTF-16 code units.
fn short(s: &str) -> String {
    let units = utf16(s);
    let cut = units.len() > 64;
    let mut out: String = units
        .iter()
        .take(64)
        .map(|u| {
            if (0x20..=0x7e).contains(u) {
                char::from(*u as u8)
            } else {
                '?'
            }
        })
        .collect();
    if cut {
        out.push('?');
    }
    out
}

/// Client-chosen strings are never logged, a method name included (it can carry anything): only the methods this server
/// knows, else "other".
fn log_name(m: &str) -> &str {
    match m {
        "initialize"
        | "session/new"
        | "session/prompt"
        | "session/cancel"
        | "session/set_mode"
        | "_app.plur1bus/steer"
        | "_app.plur1bus/follow_up" => m,
        _ => "other",
    }
}

/// `path.posix.isAbsolute(s) || path.win32.isAbsolute(s)`.
fn is_absolute(s: &str) -> bool {
    let b = s.as_bytes();
    match b.first() {
        Some(b'/' | b'\\') => true,
        Some(c) if c.is_ascii_alphabetic() => {
            b.len() > 2 && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\')
        }
        _ => false,
    }
}

/// Text and resource links are handled; every other block type is refused by name (never dropped silently, ADR-008).
fn prompt_text(blocks: &[V]) -> Result<String, Fail> {
    let mut parts: Vec<String> = Vec::new();
    for b in blocks {
        let Some(kind) = b.get("type").and_then(V::as_str).filter(|_| b.is_obj()) else {
            return Err(acp(ERR_INVALID_PARAMS, "invalid content block"));
        };
        if let (true, Some(text)) = (kind == "text", b.get("text").and_then(V::as_str)) {
            parts.push(text.to_owned());
        } else if let (true, Some(uri)) =
            (kind == "resource_link", b.get("uri").and_then(V::as_str))
        {
            let name = b.get("name").and_then(V::as_str).unwrap_or("");
            parts.push(strip_space_before_bracket(&format!(
                "[resource: {name} {uri}]"
            )));
        } else {
            return Err(acp_data(
                ERR_INVALID_PARAMS,
                "unsupported content block",
                V::obj([
                    ("reason", V::s("unsupported-content-block")),
                    ("type", V::Str(short(kind))),
                ]),
            ));
        }
    }
    let text = parts.join("\n");
    if js_trim(&text).is_empty() {
        return Err(acp_data(
            ERR_INVALID_PARAMS,
            "prompt is empty",
            V::obj([("reason", V::s("prompt-empty"))]),
        ));
    }
    if utf16_len(&text) > MAX_PROMPT_CHARS {
        return Err(acp_data(
            ERR_INVALID_PARAMS,
            "prompt too long",
            V::obj([
                ("reason", V::s("prompt-too-long")),
                ("max", V::n(MAX_PROMPT_CHARS as f64)),
            ]),
        ));
    }
    Ok(text)
}

/// `s.replace(/\s+\]/, "]")`: the first run of white space that is followed by a `]` loses its white space.
fn strip_space_before_bracket(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if crate::js::is_js_space(chars[i]) {
            let mut j = i;
            while j < chars.len() && crate::js::is_js_space(chars[j]) {
                j += 1;
            }
            if chars.get(j) == Some(&']') {
                let mut out: String = chars[..i].iter().collect();
                out.extend(chars[j..].iter());
                return out;
            }
            i = j;
        } else {
            i += 1;
        }
    }
    s.to_owned()
}

fn tool_input(name: &str, args: Option<&V>) -> Vec<(&'static str, V)> {
    let Some(args) = args else { return Vec::new() };
    if name != "file.write" && name != "file.edit" {
        return vec![("rawInput", args.clone())];
    }
    match args.stringify() {
        Some(text) if text.len() <= MAX_RAW_FILE_INPUT_BYTES => vec![("rawInput", args.clone())],
        Some(text) => vec![(
            "_meta",
            V::obj([(
                "app.plur1bus/raw_input",
                V::obj([
                    ("omitted", V::Bool(true)),
                    ("reason", V::s("size-limit")),
                    ("bytes", V::n(text.len() as f64)),
                ]),
            )]),
        )],
        None => vec![(
            "_meta",
            V::obj([(
                "app.plur1bus/raw_input",
                V::obj([
                    ("omitted", V::Bool(true)),
                    ("reason", V::s("unserializable-input")),
                ]),
            )]),
        )],
    }
}

impl<B: AcpBackend + 'static> Inner<B> {
    fn perms(&self) -> Rc<AcpPermissions> {
        self.perms.clone()
    }

    fn log(&self, event: &str, fields: &[(&str, LogVal)]) {
        if let Some(f) = &self.log {
            f(event, fields);
        }
    }

    fn send(&self, m: &V) -> bool {
        if self.out_gone.get() {
            return false;
        }
        let Some(line) = encode_line(m) else {
            self.log("output-error", &[]);
            return false;
        };
        let wrote = {
            let mut out = self.out.borrow_mut();
            out.write_all(line.as_bytes()).and_then(|()| out.flush())
        };
        if wrote.is_err() {
            // A reader that went away: stop writing, stop the work nobody can receive.
            self.log("output-error", &[]);
            self.out_gone.set(true);
            return false;
        }
        true
    }

    fn reply(&self, id: V, result: Option<V>) {
        let mut m = V::obj([("jsonrpc", V::s("2.0")), ("id", id)]);
        if let Some(r) = result {
            m.set("result", r);
        }
        self.send(&m);
    }

    fn fail(&self, id: V, e: Fail) {
        match e {
            Fail::Failure(reason) => self.send(&error_message(
                id,
                ERR_BUSY,
                acp_text(self.language).failure(reason),
                Some(V::obj([("reason", V::s(reason.key()))])),
            )),
            Fail::Acp {
                code,
                message,
                data,
            } => self.send(&error_message(id, code, message, data)),
            Fail::Backend(err) => {
                // An unexpected failure: the cause is logged by class only, the client gets a fixed message.
                let name = match err {
                    BackendError::Other(n) => n,
                    BackendError::Rpc(r) => r.name,
                    BackendError::Failure(_) => None,
                };
                self.log(
                    "internal-error",
                    &[(
                        "name",
                        LogVal::S(name.unwrap_or_else(|| "unknown".to_owned())),
                    )],
                );
                self.send(&error_message(id, ERR_INTERNAL, "internal error", None))
            }
        };
    }

    async fn message(self: &Rc<Self>, line: &str) {
        let Some(msg) = parse(line) else {
            self.log("parse-error", &[]);
            self.send(&error_message(V::Null, ERR_PARSE, "parse error", None));
            return;
        };
        if !msg.is_obj() || msg.get("jsonrpc").and_then(V::as_str) != Some("2.0") {
            self.fail(V::Null, acp(ERR_INVALID_REQUEST, "invalid request"));
            return;
        }
        let has_id = msg.has("id");
        let id = msg.get("id");
        if has_id && !matches!(id, Some(V::Str(_) | V::Num(_) | V::Null)) {
            self.fail(V::Null, acp(ERR_INVALID_REQUEST, "invalid request id"));
            return;
        }
        let Some(method) = msg.get("method").and_then(V::as_str) else {
            // Client responses resolve only an agent-issued permission id. Unsolicited responses confer no authority.
            if self.perms().answer(&msg) {
                return;
            }
            if !(msg.has("result") || msg.has("error")) {
                self.fail(
                    if has_id {
                        id.cloned().unwrap_or(V::Null)
                    } else {
                        V::Null
                    },
                    acp(ERR_INVALID_REQUEST, "invalid request"),
                );
            }
            return;
        };
        let params = msg.get("params");
        if !has_id {
            self.notification(method, params);
            return;
        }
        let id = id.cloned().unwrap_or(V::Null);
        self.log(
            "request",
            &[("method", LogVal::S(log_name(method).to_owned()))],
        );
        let outcome = self.request(method, params).await;
        // One tick between the settled result and the reply, as `await` costs.
        yield_now().await;
        match outcome {
            Ok(result) => self.reply(id, result),
            Err(e) => self.fail(id, e),
        }
    }

    fn notification(self: &Rc<Self>, method: &str, params: Option<&V>) {
        if method == "session/cancel" {
            let sid = params
                .filter(|p| p.is_obj())
                .and_then(|p| p.get("sessionId"))
                .and_then(V::as_str)
                .filter(|s| !s.is_empty());
            let st = sid.and_then(|s| self.running.borrow().get(s).cloned());
            self.log("cancel", &[("running", LogVal::B(st.is_some()))]);
            if let (Some(sid), Some(st)) = (sid, st) {
                st.cancel_requested.set(true);
                st.permission_abort.abort();
                let (me, sid) = (self.clone(), sid.to_owned());
                self.exec.spawn(async move {
                    if me.backend.cancel(&sid).await.is_err() {
                        me.log("cancel-failed", &[]);
                    }
                });
            }
            return;
        }
        // `$/cancel_request` and any other notification: ignored by JSON-RPC rules (no reply possible).
        self.log(
            "notification-ignored",
            &[("method", LogVal::S(log_name(method).to_owned()))],
        );
    }

    async fn request(self: &Rc<Self>, method: &str, params: Option<&V>) -> Result<Option<V>, Fail> {
        match method {
            "initialize" => self.initialize(params).map(Some),
            "session/new" => {
                self.need_init()?;
                self.new_session(params).await.map(Some)
            }
            "session/prompt" => {
                self.need_init()?;
                self.prompt(params).await.map(Some)
            }
            "session/set_mode" => {
                self.need_init()?;
                self.set_mode(params).await.map(Some)
            }
            "_app.plur1bus/steer" => {
                self.need_init()?;
                self.deliver(params, true).await
            }
            "_app.plur1bus/follow_up" => {
                self.need_init()?;
                self.deliver(params, false).await
            }
            _ => Err(acp(ERR_METHOD_NOT_FOUND, "method not found")),
        }
    }

    fn need_init(&self) -> Result<(), Fail> {
        // RULING (TypeScript): a request other than `initialize` before the handshake is refused (fail closed); the spec does
        // not say.
        if self.initialized.get() {
            Ok(())
        } else {
            Err(acp_data(
                ERR_INVALID_REQUEST,
                "initialize first",
                V::obj([("reason", V::s("not-initialized"))]),
            ))
        }
    }

    fn initialize(&self, params: Option<&V>) -> Result<V, Fail> {
        let version = params
            .filter(|p| p.is_obj())
            .and_then(|p| p.get("protocolVersion"))
            .and_then(V::as_f64);
        let Some(version) = version.filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= 1.0)
        else {
            return Err(acp(
                ERR_INVALID_PARAMS,
                "protocolVersion must be a positive integer",
            ));
        };
        self.initialized.set(true);
        let (name, title, ver) = self.agent_info.clone().unwrap_or((
            "plur1bus".into(),
            "PLUR1BUS".into(),
            "0.0.0".into(),
        ));
        let f = self.backend.features();
        let mut caps = V::obj([
            ("loadSession", V::Bool(false)),
            (
                "promptCapabilities",
                V::obj([
                    ("image", V::Bool(false)),
                    ("audio", V::Bool(false)),
                    ("embeddedContext", V::Bool(false)),
                ]),
            ),
            (
                "mcpCapabilities",
                V::obj([("http", V::Bool(false)), ("sse", V::Bool(false))]),
            ),
        ]);
        if self.backend.has_deliver() && (f.steer || f.follow_up) {
            let mut meta = V::obj([]);
            if f.steer {
                meta.set("app.plur1bus/steer", V::Bool(true));
            }
            if f.follow_up {
                meta.set("app.plur1bus/follow_up", V::Bool(true));
            }
            caps.set("_meta", meta);
        }
        Ok(V::obj([
            // The latest version we support that is not above the client's: schema v1 only.
            (
                "protocolVersion",
                V::n(version.min(ACP_PROTOCOL_VERSION as f64)),
            ),
            ("agentCapabilities", caps),
            (
                "agentInfo",
                V::obj([
                    ("name", V::Str(name)),
                    ("title", V::Str(title)),
                    ("version", V::Str(ver)),
                ]),
            ),
            ("authMethods", V::Arr(Vec::new())),
        ]))
    }

    async fn new_session(self: &Rc<Self>, params: Option<&V>) -> Result<V, Fail> {
        let cwd = params
            .filter(|p| p.is_obj())
            .and_then(|p| p.get("cwd"))
            .and_then(V::as_str)
            .filter(|c| is_absolute(c));
        let (Some(params), Some(cwd)) = (params, cwd) else {
            return Err(acp(ERR_INVALID_PARAMS, "cwd must be an absolute path"));
        };
        let servers = params.get("mcpServers");
        if servers.is_some_and(|s| s.as_arr().is_none()) {
            return Err(acp(ERR_INVALID_PARAMS, "mcpServers must be an array"));
        }
        // The backend binds cwd through the Core's coding contract when available; this adapter never edits editor files.
        // Client-supplied MCP servers are not started (ADR-014); only their number is logged.
        let n = servers.and_then(V::as_arr).map_or(0, <[V]>::len);
        self.log("session-new", &[("mcpServers", LogVal::N(n as f64))]);
        let (session_id, mode) = self.backend.create_session(cwd).await?;
        let modes = self.backend.features().modes && self.backend.has_set_mode();
        let mode = AcpMode::from_value(mode.as_ref());
        if modes && mode.is_none() {
            return Err(acp(ERR_INTERNAL, "backend did not provide a session mode"));
        }
        self.sessions.borrow_mut().insert(session_id.clone());
        let mut out = V::obj([("sessionId", V::Str(session_id))]);
        if let (true, Some(m)) = (modes, mode) {
            out.set("modes", mode_state(m, self.language));
        }
        Ok(out)
    }

    async fn set_mode(self: &Rc<Self>, params: Option<&V>) -> Result<V, Fail> {
        if !self.backend.features().modes || !self.backend.has_set_mode() {
            return Err(acp(ERR_METHOD_NOT_FOUND, "method not found"));
        }
        let sid = params
            .filter(|p| p.is_obj())
            .and_then(|p| p.get("sessionId"))
            .and_then(V::as_str);
        let mode = AcpMode::from_value(params.and_then(|p| p.get("modeId")));
        let (Some(sid), Some(mode)) = (sid, mode) else {
            return Err(acp(
                ERR_INVALID_PARAMS,
                "sessionId and a supported modeId are required",
            ));
        };
        if !self.sessions.borrow().contains(sid) {
            return Err(unknown_session());
        }
        let (current, changed) = self.backend.set_mode(sid, mode).await?;
        if changed {
            self.send(&V::obj([
                ("jsonrpc", V::s("2.0")),
                ("method", V::s("session/update")),
                (
                    "params",
                    V::obj([
                        ("sessionId", V::s(sid)),
                        (
                            "update",
                            V::obj([
                                ("sessionUpdate", V::s("current_mode_update")),
                                ("currentModeId", current),
                            ]),
                        ),
                    ]),
                ),
            ]));
            self.update(
                sid,
                AcpTurnUpdate::Notice {
                    reason: "profile-changed",
                    text: acp_text(self.language).profile_changed.to_owned(),
                },
            );
        }
        Ok(V::obj([]))
    }

    async fn deliver(self: &Rc<Self>, params: Option<&V>, steer: bool) -> Result<Option<V>, Fail> {
        let f = self.backend.features();
        let supported = if steer { f.steer } else { f.follow_up };
        if !supported || !self.backend.has_deliver() {
            return Err(acp(ERR_METHOD_NOT_FOUND, "method not found"));
        }
        let sid = params
            .filter(|p| p.is_obj())
            .and_then(|p| p.get("sessionId"))
            .and_then(V::as_str);
        let prompt = params.and_then(|p| p.get("prompt")).and_then(V::as_arr);
        let (Some(sid), Some(prompt)) = (sid, prompt) else {
            return Err(acp(ERR_INVALID_PARAMS, "sessionId and prompt are required"));
        };
        if !self.sessions.borrow().contains(sid) {
            return Err(unknown_session());
        }
        if self.closed.get() {
            return Err(acp(ERR_INTERNAL, "connection closing"));
        }
        let text = prompt_text(prompt)?;
        Ok(self.backend.deliver(sid, &text, steer).await?)
    }

    async fn prompt(self: &Rc<Self>, params: Option<&V>) -> Result<V, Fail> {
        let sid = params
            .filter(|p| p.is_obj())
            .and_then(|p| p.get("sessionId"))
            .and_then(V::as_str);
        let prompt = params.and_then(|p| p.get("prompt")).and_then(V::as_arr);
        let (Some(sid), Some(prompt)) = (sid, prompt) else {
            return Err(acp(ERR_INVALID_PARAMS, "sessionId and prompt are required"));
        };
        if !self.sessions.borrow().contains(sid) {
            return Err(unknown_session());
        }
        let text = prompt_text(prompt)?;
        if self.closed.get() {
            return Err(acp(ERR_INTERNAL, "connection closing"));
        }
        if self.running.borrow().contains_key(sid) {
            return Err(acp_data(
                ERR_BUSY,
                "a prompt is already running for this session",
                V::obj([("reason", V::s("turn-in-progress"))]),
            ));
        }
        let st = Rc::new(Running {
            cancel_requested: Cell::new(false),
            permission_abort: Signal::new(),
        });
        self.running.borrow_mut().insert(sid.to_owned(), st.clone());
        let session_id = sid.to_owned();
        let me = self.clone();
        let on_update: Rc<dyn Fn(AcpTurnUpdate)> = {
            let (me, sid) = (self.clone(), session_id.clone());
            Rc::new(move |u| me.update(&sid, u))
        };
        let handler: Rc<PermHandler> = {
            let (st, sid, perms) = (st.clone(), session_id.clone(), self.perms());
            Rc::new(move |ask, signal| -> PermFuture {
                let combined = match &signal {
                    Some(s) => Signal::any(&st.permission_abort, s),
                    None => st.permission_abort.clone(),
                };
                let rx = perms.request(&sid, &ask, Some(&combined));
                Box::pin(rx)
            })
        };
        let out = self
            .backend
            .prompt(
                PromptArgs {
                    session_id: session_id.clone(),
                    text,
                },
                on_update,
                handler,
            )
            .await;
        let result = match out {
            Ok(out) => {
                let state = match out.state {
                    TurnState::Completed => "completed",
                    TurnState::Failed => "failed",
                    TurnState::Cancelled => "cancelled",
                };
                me.log("prompt-done", &[("state", LogVal::S(state.to_owned()))]);
                if out.state == TurnState::Completed && !st.cancel_requested.get() {
                    Ok(V::obj([("stopReason", V::s("end_turn"))]))
                } else if out.state == TurnState::Cancelled || st.cancel_requested.get() {
                    Ok(V::obj([("stopReason", V::s("cancelled"))]))
                } else {
                    Err(acp_data(
                        ERR_INTERNAL,
                        "turn failed",
                        V::obj([("reason", V::s("turn-failed"))]),
                    ))
                }
            }
            Err(e) => Err(e.into()),
        };
        st.permission_abort.abort();
        self.running.borrow_mut().remove(&session_id);
        result
    }

    fn update(&self, session_id: &str, u: AcpTurnUpdate) {
        let update = match u {
            AcpTurnUpdate::Text(text) => V::obj([
                ("sessionUpdate", V::s("agent_message_chunk")),
                (
                    "content",
                    V::obj([("type", V::s("text")), ("text", V::Str(text))]),
                ),
            ]),
            AcpTurnUpdate::Notice { reason, text } => V::obj([
                ("sessionUpdate", V::s("agent_message_chunk")),
                (
                    "content",
                    V::obj([("type", V::s("text")), ("text", V::Str(text))]),
                ),
                ("_meta", V::obj([("app.plur1bus/notice", V::s(reason))])),
            ]),
            AcpTurnUpdate::ToolCall { id, name, args } => {
                let kind = if name == "file.write" || name == "file.edit" {
                    "edit"
                } else {
                    "other"
                };
                let mut update = V::obj([
                    ("sessionUpdate", V::s("tool_call")),
                    ("toolCallId", V::Str(id)),
                    ("title", V::Str(name.clone())),
                    ("kind", V::s(kind)),
                    ("status", V::s("in_progress")),
                ]);
                for (k, v) in tool_input(&name, args.as_ref()) {
                    update.set(k, v);
                }
                update
            }
            AcpTurnUpdate::ToolResult {
                id,
                output,
                content,
            } => {
                let content = match content {
                    Some(c) => V::Arr(c.iter().map(|x| x.to_value()).collect()),
                    None => V::Arr(vec![V::obj([
                        ("type", V::s("content")),
                        (
                            "content",
                            V::obj([("type", V::s("text")), ("text", V::Str(output))]),
                        ),
                    ])]),
                };
                V::obj([
                    ("sessionUpdate", V::s("tool_call_update")),
                    ("toolCallId", V::Str(id)),
                    ("status", V::s("completed")),
                    ("content", content),
                ])
            }
        };
        self.send(&V::obj([
            ("jsonrpc", V::s("2.0")),
            ("method", V::s("session/update")),
            (
                "params",
                V::obj([("sessionId", V::s(session_id)), ("update", update)]),
            ),
        ]));
    }
}
