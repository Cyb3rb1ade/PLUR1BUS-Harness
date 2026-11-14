use crate::error::RpcError;
use crate::transport::{connect as transport_connect, Stream};
use crate::types::{
    CoreAuthResult, EngineAuthResult, ErrorCode, ModuleAuthResult, SupervisorAuthResult,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, TryLockError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// The server a client talks to; it picks the handshake method (ruling S2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Endpoint {
    /// The core: `core.auth`.
    #[default]
    Core,
    /// The supervisor: `supervisor.auth`.
    Supervisor,
    /// A module process: `module.auth` (B9). Its address and run files are per module
    /// (`Layout::endpoints` in the CLI crate), so this variant carries no name.
    Module,
    /// The memory engine process: `engine.auth`.
    Engine,
}
impl Endpoint {
    /// The first call on a connection to this endpoint.
    pub fn auth_method(self) -> &'static str {
        match self {
            Endpoint::Core => "core.auth",
            Endpoint::Supervisor => "supervisor.auth",
            Endpoint::Module => "module.auth",
            Endpoint::Engine => "engine.auth",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ConnectOptions {
    /// Bounds the socket connect and the whole handshake.
    pub connect_timeout: Duration,
    /// Whole-call deadline after the handshake, including writes and skipped notifications.
    pub call_timeout: Duration,
    /// Which server `address` belongs to (default: the core).
    pub endpoint: Endpoint,
    /// The pid the caller expects to serve `address` (the one in `run/core.pid` or `run/supervisor.pid`). On Windows,
    /// where any account can create a pipe of a free name, a pipe whose `GetNamedPipeServerProcessId` differs is
    /// refused before the token is sent (`E_UNAUTHORIZED`, reason `pipe-server-mismatch`, ruling S11). `None` skips
    /// the check. On unix the equivalent is [`crate::trust`]: the socket's directory and file are checked before the
    /// connect, and the kernel's peer uid after it.
    pub expected_server_pid: Option<u32>,
}
impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_millis(300),
            call_timeout: Duration::from_secs(30),
            endpoint: Endpoint::Core,
            expected_server_pid: None,
        }
    }
}

// Keep optional streaming state off the legacy client's stack footprint; its frames and byte budget share a lifetime.
struct NotificationBuffer {
    frames: VecDeque<Vec<u8>>,
    bytes: usize,
}

/// Blocking, strictly request→response: one stream behind a BufReader is enough because the CLI never has two calls in flight.
/// Writes go through `reader.get_mut()`, the one real stream.
///
/// **Poisoning:** after a blocking call's read timeout, an I/O error, an over-long line or the core closing the connection, the stream may be
/// positioned mid-line (or hold a late answer to the abandoned call). The client then marks itself poisoned and every later
/// [`Client::call`] returns `RpcError::Unavailable { reason: "poisoned" }` without touching the stream; reconnect to continue.
/// A `Call` error, a `Protocol` error on a complete line, or a skipped notification leave the client usable.
pub struct Client {
    reader: BufReader<Box<dyn Stream>>,
    line_buffer: Vec<u8>,
    notifications: Option<Box<NotificationBuffer>>,
    pending_call: Option<(u64, String)>,
    next_id: u64,
    hello: Value,
    endpoint: Endpoint,
    poisoned: bool,
    call_timeout: Duration,
}

/// Maximum bytes in one NDJSON line, newline not counted (same cap as packages/module-api/src/framing.ts).
pub const MAX_LINE: usize = 4 * 1024 * 1024;
const MAX_NOTIFICATION_BYTES: usize = 2 * MAX_LINE;
const MAX_NOTIFICATIONS: usize = 256;

impl Client {
    /// Connects with token auth; engine connections also identify as `harness-core`.
    pub fn connect(address: &str, token: &str, opts: ConnectOptions) -> Result<Client, RpcError> {
        Self::connect_with_auth(address, default_auth_params(token, opts.endpoint), opts)
    }

    /// Connects with the endpoint's complete authentication params, including an engine client id or delegation.
    /// Address and kernel peer checks run before any of these params are sent, just as in [`Client::connect`].
    pub fn connect_with_auth(
        address: &str,
        params: Value,
        mut opts: ConnectOptions,
    ) -> Result<Client, RpcError> {
        let start = Instant::now();
        // Audit M2: a unix socket must sit in a real `run/` directory of ours (not a symlink, no group/other write) and
        // belong to us, or nothing is connected and no token is sent.
        crate::trust::verify_address(address)?;
        let remaining = call_remaining(start, opts.connect_timeout).map_err(handshake_error)?;
        let stream = transport_connect(address, remaining)?;
        opts.connect_timeout =
            call_remaining(start, opts.connect_timeout).map_err(handshake_error)?;
        Self::handshake_with_auth(stream, params, opts)
    }

    /// Authenticates on a stream that is already connected ([`crate::transport::connect`]): the handshake of
    /// [`Client::connect`]. Lets a caller read the stream's [`Stream::peer_pid`] first and then talk to exactly that
    /// server.
    pub fn handshake(
        stream: Box<dyn Stream>,
        token: &str,
        opts: ConnectOptions,
    ) -> Result<Client, RpcError> {
        Self::handshake_with_auth(stream, default_auth_params(token, opts.endpoint), opts)
    }

    /// Authenticates an already-connected stream with complete params after verifying the kernel peer identity.
    pub fn handshake_with_auth(
        stream: Box<dyn Stream>,
        params: Value,
        opts: ConnectOptions,
    ) -> Result<Client, RpcError> {
        let start = Instant::now();
        let mut client = Client {
            reader: BufReader::new(stream),
            line_buffer: Vec::new(),
            notifications: None,
            pending_call: None,
            next_id: 1,
            hello: Value::Null,
            endpoint: opts.endpoint,
            poisoned: false,
            call_timeout: opts.connect_timeout,
        };
        if cfg!(windows) {
            check_server_pid(opts.expected_server_pid, client.peer_pid())?;
        }
        // Audit M2: the kernel names the uid that listens; another user's server gets no token.
        #[cfg(unix)]
        {
            // SAFETY: geteuid has no preconditions and cannot fail.
            let euid = unsafe { libc::geteuid() };
            crate::trust::check_peer_uid(client.reader.get_ref().peer_uid(), euid)?;
        }
        let method = opts.endpoint.auth_method();
        // The handshake runs under the connect timeout: a server that owns the socket but never answers must fail fast.
        client.call_timeout =
            call_remaining(start, opts.connect_timeout).map_err(handshake_error)?;
        let raw = client.call(method, params).map_err(handshake_error)?;
        // Check the major before parsing the rest: a MAJOR-2 hello may have a shape this client cannot read.
        let rpc = raw["rpc"]
            .as_str()
            .ok_or_else(|| RpcError::Protocol(format!("{method} result: missing rpc")))?;
        let major: Option<u64> = rpc.split('.').next().and_then(|s| s.parse().ok());
        if major != Some(crate::SUPPORTED_RPC_MAJOR) {
            return Err(RpcError::Version {
                server: rpc.to_string(),
            });
        }
        // The shape is checked against the generated (open) result type, but the raw value is what the client keeps:
        // unknown keys from a newer 1.x server survive for callers that print or forward the hello (R13).
        let shape = match opts.endpoint {
            Endpoint::Core => serde_json::from_value::<CoreAuthResult>(raw.clone()).map(drop),
            Endpoint::Supervisor => {
                serde_json::from_value::<SupervisorAuthResult>(raw.clone()).map(drop)
            }
            Endpoint::Module => serde_json::from_value::<ModuleAuthResult>(raw.clone()).map(drop),
            Endpoint::Engine => serde_json::from_value::<EngineAuthResult>(raw.clone()).map(drop),
        };
        shape.map_err(|e| RpcError::Protocol(format!("{method} result: {e}")))?;
        call_remaining(start, opts.connect_timeout).map_err(handshake_error)?;
        client
            .reader
            .get_ref()
            .set_read_timeout(Some(opts.call_timeout))?;
        client.hello = raw;
        client.call_timeout = opts.call_timeout;
        Ok(client)
    }

    /// The handshake result exactly as the server sent it (`core.auth`, `supervisor.auth`, `module.auth` or `engine.auth`).
    pub fn hello(&self) -> &Value {
        &self.hello
    }

    /// The pid the OS names as the server of this connection (see [`Stream::peer_pid`]).
    pub fn peer_pid(&self) -> Option<u32> {
        self.reader.get_ref().peer_pid()
    }

    /// The server this client is connected to.
    pub fn endpoint(&self) -> Endpoint {
        self.endpoint
    }

    /// True when the hello has no `capabilities` (an older server answers for itself), else whether
    /// `capabilities.methods` names `method`.
    pub fn supports(&self, method: &str) -> bool {
        match self.hello.get("capabilities") {
            None | Some(Value::Null) => true,
            Some(capabilities) => capabilities["methods"].get(method).is_some(),
        }
    }

    /// Whether an earlier failure left the stream unusable (see the type docs).
    pub fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    /// Retain notifications, including ones preceding a subscription reply. The default client keeps skipping them.
    /// A backlog over 256 frames or 8 MiB fails the connection; callers can replay durable events after reconnecting.
    pub fn enable_notifications(&mut self) {
        self.notifications.get_or_insert_with(|| {
            Box::new(NotificationBuffer {
                frames: VecDeque::new(),
                bytes: 0,
            })
        });
    }

    /// Drain an already buffered notification without reading. This also works while a polled call is in flight.
    pub fn take_notification(&mut self) -> Result<Option<Value>, RpcError> {
        if self.poisoned {
            return Err(RpcError::Unavailable {
                reason: "poisoned".into(),
                detail: "reconnect the event connection".into(),
            });
        }
        let queue = self
            .notifications
            .as_mut()
            .ok_or_else(|| RpcError::Protocol("enable notifications before reading them".into()))?;
        if let Some(bytes) = queue.frames.pop_front() {
            queue.bytes -= bytes.len();
            return notification(&bytes).map(Some);
        }
        Ok(None)
    }

    /// Read the event connection without sending a request. `None` is an idle read deadline, including a partial frame.
    /// Partial bytes stay buffered; EOF and over-long frames poison the connection just as they do for calls.
    pub fn next_notification(&mut self) -> Result<Option<Value>, RpcError> {
        if self.pending_call.is_some() {
            return Err(RpcError::Protocol(
                "poll the pending call and drain buffered notifications".into(),
            ));
        }
        if let Some(value) = self.take_notification()? {
            return Ok(Some(value));
        }
        let start = Instant::now();
        loop {
            match self.read_line(start) {
                Ok(Line::Data(bytes)) if bytes.is_empty() => continue,
                Ok(Line::Data(bytes)) => return notification(&bytes).map(Some),
                Ok(Line::TooLong) => {
                    self.poisoned = true;
                    return Err(RpcError::Protocol("line too long".into()));
                }
                Ok(Line::Closed) => {
                    self.poisoned = true;
                    return Err(RpcError::Unavailable {
                        reason: "closed".into(),
                        detail: "event connection closed".into(),
                    });
                }
                Err(RpcError::Unavailable { reason, .. }) if reason == "call-timeout" => {
                    return Ok(None)
                }
                Err(error) => {
                    self.poisoned |= poisons(&error);
                    return Err(error);
                }
            }
        }
    }

    fn queue_notification(&mut self, bytes: Vec<u8>) -> Result<(), RpcError> {
        let Some(queue) = self.notifications.as_mut() else {
            return Ok(());
        };
        notification(&bytes)?;
        if queue.frames.len() >= MAX_NOTIFICATIONS
            || queue.bytes + bytes.len() > MAX_NOTIFICATION_BYTES
        {
            self.poisoned = true; // The outstanding response remains unread; never reuse that stream position.
            return Err(RpcError::Protocol(
                "notification backlog exceeded; reconnect and replay".into(),
            ));
        }
        queue.bytes += bytes.len();
        queue.frames.push_back(bytes);
        Ok(())
    }

    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        let start = Instant::now();
        self.start_call(method, params)?;
        match self.poll_call_at(start)? {
            Some(value) => Ok(value),
            None => {
                self.poisoned = true; // A blocking call abandons its pending reply at the first idle deadline.
                self.pending_call = None;
                Err(RpcError::Unavailable {
                    reason: "call-timeout".into(),
                    detail: format!("{method} timed out"),
                })
            }
        }
    }

    /// Start exactly one request. `poll_call` can then yield at read deadlines so input and events remain responsive.
    pub fn start_call(&mut self, method: &str, params: Value) -> Result<(), RpcError> {
        if self.poisoned {
            return Err(RpcError::Unavailable {
                reason: "poisoned".into(),
                detail: "an earlier call left the connection mid-line; reconnect".into(),
            });
        }
        if self.pending_call.is_some() {
            return Err(RpcError::Protocol(
                "a call is already in flight on this connection".into(),
            ));
        }
        let start = Instant::now();
        let id = self.next_id;
        self.next_id += 1;
        // `Value`'s Display is infallible (a `Value` always serialises).
        let line = format!(
            "{}\n",
            json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
        );
        let written: Result<(), RpcError> = (|| {
            let w = self.reader.get_mut();
            let mut bytes = line.as_bytes();
            while !bytes.is_empty() {
                let remaining = call_remaining(start, self.call_timeout)?;
                match w.set_write_timeout(Some(remaining)) {
                    Ok(()) => {}
                    // Custom streams predate optional write deadlines; preserve their behavior.
                    Err(error) if error.kind() == std::io::ErrorKind::Unsupported => {}
                    Err(error) => return Err(error.into()),
                }
                match w.write(bytes) {
                    Ok(0) => {
                        return Err(background_unavailable("io", "RPC write made no progress"))
                    }
                    Ok(written) => bytes = &bytes[written..],
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(error) => return Err(error.into()),
                }
            }
            call_remaining(start, self.call_timeout)?;
            w.flush()?;
            Ok(())
        })();
        if let Err(error) = written {
            self.poisoned = true;
            return Err(error);
        }
        self.pending_call = Some((id, method.into()));
        Ok(())
    }

    /// `None` preserves the pending request and partial frame at an idle deadline; terminal results end the request.
    pub fn poll_call(&mut self) -> Result<Option<Value>, RpcError> {
        self.poll_call_at(Instant::now())
    }

    fn poll_call_at(&mut self, start: Instant) -> Result<Option<Value>, RpcError> {
        if self.poisoned {
            return Err(RpcError::Unavailable {
                reason: "poisoned".into(),
                detail: "reconnect the call connection".into(),
            });
        }
        let (id, method) = self
            .pending_call
            .clone()
            .ok_or_else(|| RpcError::Protocol("no call is in flight".into()))?;
        let result = self.poll_response(id, &method, start);
        if !matches!(&result, Ok(None)) {
            self.pending_call = None;
        }
        if let Err(error) = &result {
            self.poisoned |= poisons(error);
        }
        result
    }

    fn poll_response(
        &mut self,
        id: u64,
        method: &str,
        start: Instant,
    ) -> Result<Option<Value>, RpcError> {
        loop {
            let line = match self.read_line(start) {
                Err(RpcError::Unavailable { reason, .. }) if reason == "call-timeout" => {
                    return Ok(None)
                }
                result => result?,
            };
            let buf = match line {
                Line::Closed => {
                    return Err(RpcError::Unavailable {
                        reason: "closed".into(),
                        detail: "connection closed by core".into(),
                    })
                }
                Line::TooLong => {
                    self.poisoned = true; // the rest of the over-long line is still in the stream
                    return Err(RpcError::Protocol("line too long".into()));
                }
                Line::Data(b) => b,
            };
            if let Some(value) = self.response_line(buf, id, method)? {
                return Ok(Some(value));
            }
        }
    }

    fn response_line(
        &mut self,
        buf: Vec<u8>,
        id: u64,
        method: &str,
    ) -> Result<Option<Value>, RpcError> {
        if buf.is_empty() {
            return Ok(None);
        }
        let msg: Value =
            serde_json::from_slice(&buf).map_err(|error| RpcError::Protocol(error.to_string()))?;
        let Some(msg_id) = msg.get("id") else {
            self.queue_notification(buf)?;
            return Ok(None);
        };
        // id:null belongs to the single outstanding call (parse/length errors from the server).
        if *msg_id != json!(id) && !msg_id.is_null() {
            return Ok(None);
        }
        if let Some(error) = msg.get("error") {
            return Err(call_error(error));
        }
        if msg_id.is_null() {
            return Err(RpcError::Protocol(
                "response with id null and no error".into(),
            ));
        }
        msg.get("result").cloned().map(Some).ok_or_else(|| {
            RpcError::Protocol(format!("{method}: response has neither result nor error"))
        })
    }

    /// Reads one line with at most `MAX_LINE + 1` bytes buffered, so an endless line cannot exhaust memory.
    fn read_line(&mut self, start: Instant) -> Result<Line, RpcError> {
        loop {
            let remaining = call_remaining(start, self.call_timeout)?;
            self.reader.get_ref().set_read_timeout(Some(remaining))?;
            let available = match self.reader.fill_buf() {
                Ok(available) => available,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            };
            if available.is_empty() {
                return Ok(Line::Closed);
            }
            let limit = available.len().min(MAX_LINE + 1 - self.line_buffer.len());
            let length = available[..limit]
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(limit, |index| index + 1);
            self.line_buffer.extend_from_slice(&available[..length]);
            self.reader.consume(length);
            if self.line_buffer.last() == Some(&b'\n') {
                let mut buf = std::mem::take(&mut self.line_buffer);
                buf.pop();
                return Ok(Line::Data(buf));
            }
            if self.line_buffer.len() > MAX_LINE {
                return Ok(Line::TooLong);
            }
        }
    }

    pub fn call_typed<P: Serialize, R: DeserializeOwned>(
        &mut self,
        method: &str,
        params: &P,
    ) -> Result<R, RpcError> {
        let v = self.call(
            method,
            serde_json::to_value(params).map_err(|e| RpcError::Protocol(e.to_string()))?,
        )?;
        serde_json::from_value(v).map_err(|e| RpcError::Protocol(format!("{method} result: {e}")))
    }
}

fn notification(bytes: &[u8]) -> Result<Value, RpcError> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|error| RpcError::Protocol(error.to_string()))?;
    if value.get("id").is_some() || value["jsonrpc"] != "2.0" || !value["method"].is_string() {
        return Err(RpcError::Protocol(
            "expected a JSON-RPC notification".into(),
        ));
    }
    Ok(value)
}

/// Events from a persistent authenticated connection.
#[derive(Debug, Clone, PartialEq)]
pub enum ClientEvent {
    Notification { method: String, params: Value },
    Closed,
}

const READ_TICK: Duration = Duration::from_millis(50);
const CALL_TICK: Duration = Duration::from_millis(10);
const MAX_PENDING_CALLS: usize = 64;
type PendingResponse = mpsc::SyncSender<Result<Value, RpcError>>;

/// A single authenticated connection with continuous notification delivery and concurrent calls.
///
/// The callback runs on the reader thread: it must return promptly and must not make a blocking call on
/// this client. Cancellation or a call deadline closes the connection, so the server also sees EOF.
/// Drop aborts I/O and joins the reader, waiting at most 250 ms for a callback that does not return.
/// On Windows a single stalled pipe write fails after at most 50 ms, because reads and writes share
/// the existing overlapped I/O deadline; its unknown transferred-byte count requires closing the pipe.
pub struct BackgroundClient {
    hello: Value,
    shared: Arc<BackgroundShared>,
    writer: Mutex<Box<dyn Stream>>,
    next_id: AtomicU64,
    reader: Option<JoinHandle<()>>,
    reader_done: Mutex<mpsc::Receiver<()>>,
}

struct BackgroundShared {
    closed: AtomicBool,
    pending: Mutex<HashMap<u64, PendingResponse>>,
    interrupt: Mutex<Box<dyn Stream>>,
}

#[derive(Clone, Copy)]
enum BackgroundFailure {
    Closed,
    Io,
    LineTooLong,
    InvalidFrame,
}

impl BackgroundFailure {
    fn error(self) -> RpcError {
        match self {
            Self::Closed => background_unavailable("closed", "RPC connection closed"),
            Self::Io => background_unavailable("io", "RPC connection I/O failed"),
            Self::LineTooLong => RpcError::Protocol("line too long".into()),
            Self::InvalidFrame => RpcError::Protocol("invalid RPC response".into()),
        }
    }
}

fn background_unavailable(reason: &str, detail: &str) -> RpcError {
    RpcError::Unavailable {
        reason: reason.into(),
        detail: detail.into(),
    }
}

fn background_lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl BackgroundShared {
    fn finish(&self, failure: BackgroundFailure) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        // This handle never holds the writer lock, so shutdown can interrupt a blocked writer.
        let _ = background_lock(&self.interrupt).shutdown();
        for (_, sender) in background_lock(&self.pending).drain() {
            let _ = sender.try_send(Err(failure.error()));
        }
    }
}

// A caller unwinding or abandoning its response cannot consume a pending slot forever.
struct PendingCall<'a> {
    shared: &'a BackgroundShared,
    id: u64,
}
impl Drop for PendingCall<'_> {
    fn drop(&mut self) {
        background_lock(&self.shared.pending).remove(&self.id);
    }
}

impl BackgroundClient {
    pub fn connect_with_auth(
        address: &str,
        params: Value,
        opts: ConnectOptions,
        on_event: Arc<dyn Fn(ClientEvent) + Send + Sync>,
    ) -> Result<Self, RpcError> {
        // Promote the authenticated reader itself: a hello and notification may share a buffered read.
        // Client retains all address/UID/pipe-PID verification before credentials are written.
        let client = Client::connect_with_auth(address, params, opts)?;
        client.reader.get_ref().set_read_timeout(Some(READ_TICK))?;
        let writer = client.reader.get_ref().try_clone_stream()?;
        writer.set_write_timeout(Some(READ_TICK))?;
        let interrupt = client.reader.get_ref().try_clone_stream()?;
        let shared = Arc::new(BackgroundShared {
            closed: AtomicBool::new(false),
            pending: Mutex::new(HashMap::new()),
            interrupt: Mutex::new(interrupt),
        });
        let state = shared.clone();
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        let reader = thread::Builder::new()
            .name("rpc-reader".into())
            .spawn(move || {
                let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    background_read_loop(client.reader, &state, &on_event)
                }))
                .unwrap_or(BackgroundFailure::Io);
                state.finish(failure);
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    on_event(ClientEvent::Closed);
                }));
                let _ = done_tx.send(());
            })
            .map_err(|_| {
                shared.finish(BackgroundFailure::Io);
                background_unavailable("io", "RPC reader could not start")
            })?;
        Ok(Self {
            hello: client.hello,
            shared,
            writer: Mutex::new(writer),
            next_id: AtomicU64::new(client.next_id),
            reader: Some(reader),
            reader_done: Mutex::new(done_rx),
        })
    }

    /// Explicit feature advertisement from the authenticated peer.
    pub fn advertises(&self, method: &str) -> bool {
        self.hello["capabilities"]["methods"].get(method).is_some()
    }

    pub fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::Acquire)
    }

    /// Signals closure and interrupts I/O without waiting for the reader or callback.
    pub fn close(&self) {
        self.shared.finish(BackgroundFailure::Closed);
    }

    pub fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Value, RpcError> {
        let start = Instant::now();
        self.check_call_budget(start, timeout, cancelled)?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut frame = json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params})
            .to_string()
            .into_bytes();
        if frame.len() > MAX_LINE {
            return Err(RpcError::Protocol("line too long".into()));
        }
        frame.push(b'\n');
        let (sender, receiver) = mpsc::sync_channel(1);
        {
            let mut pending = background_lock(&self.shared.pending);
            if self.is_closed() {
                return Err(BackgroundFailure::Closed.error());
            }
            if pending.len() >= MAX_PENDING_CALLS {
                return Err(background_unavailable("busy", "too many pending RPC calls"));
            }
            pending.insert(id, sender);
        }
        let _pending = PendingCall {
            shared: &self.shared,
            id,
        };
        self.write_frame(&frame, start, timeout, cancelled)?;
        loop {
            let remaining = self.check_call_budget(start, timeout, cancelled)?;
            match receiver.recv_timeout(remaining.min(CALL_TICK)) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(BackgroundFailure::Closed.error());
                }
            }
        }
    }

    fn check_call_budget(
        &self,
        start: Instant,
        timeout: Duration,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Duration, RpcError> {
        let reason = if cancelled() {
            Some(("cancelled", "RPC call cancelled"))
        } else if start.elapsed() >= timeout {
            Some(("call-timeout", "RPC call deadline exceeded"))
        } else {
            None
        };
        if let Some((reason, detail)) = reason {
            self.close();
            return Err(background_unavailable(reason, detail));
        }
        Ok(timeout
            .saturating_sub(start.elapsed())
            .max(Duration::from_micros(1)))
    }

    fn write_frame(
        &self,
        mut frame: &[u8],
        start: Instant,
        timeout: Duration,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(), RpcError> {
        let mut writer = loop {
            self.check_call_budget(start, timeout, cancelled)?;
            if self.is_closed() {
                return Err(BackgroundFailure::Closed.error());
            }
            match self.writer.try_lock() {
                Ok(writer) => break writer,
                Err(TryLockError::Poisoned(_)) => {
                    self.shared.finish(BackgroundFailure::Io);
                    return Err(BackgroundFailure::Io.error());
                }
                Err(TryLockError::WouldBlock) => thread::park_timeout(Duration::from_millis(1)),
            }
        };
        while !frame.is_empty() {
            let remaining = self.check_call_budget(start, timeout, cancelled)?;
            if self.is_closed() {
                return Err(BackgroundFailure::Closed.error());
            }
            if writer
                .set_write_timeout(Some(remaining.min(READ_TICK)))
                .is_err()
            {
                self.shared.finish(BackgroundFailure::Io);
                return Err(BackgroundFailure::Io.error());
            }
            match writer.write(&frame[..frame.len().min(16 * 1024)]) {
                Ok(0) => {
                    self.shared.finish(BackgroundFailure::Io);
                    return Err(BackgroundFailure::Io.error());
                }
                Ok(written) => frame = &frame[written..],
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                // Unix write errors report no transferred bytes, so a short timeout is a polling tick.
                #[cfg(unix)]
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) => {}
                Err(_) => {
                    self.shared.finish(BackgroundFailure::Io);
                    return Err(BackgroundFailure::Io.error());
                }
            }
        }
        // Windows shares its read/write timeout; a short call must not leave the idle reader
        // polling at a sub-millisecond deadline after its request has been sent.
        // A completed response followed by EOF may already have revoked the Windows pipe: retain
        // that queued response even if this best-effort timeout restoration can no longer apply.
        let _ = writer.set_write_timeout(Some(READ_TICK));
        Ok(())
    }
}

impl Drop for BackgroundClient {
    fn drop(&mut self) {
        self.close();
        if let Some(reader) = self.reader.take() {
            let start = Instant::now();
            if reader.thread().id() == thread::current().id() {
                return;
            }
            let _ = background_lock(&self.reader_done).recv_timeout(Duration::from_millis(250));
            // The callback's captured values are dropped after the completion signal too. Only join
            // a fully finished thread, so even a user-defined destructor cannot make Drop unbounded.
            while !reader.is_finished() && start.elapsed() < Duration::from_millis(250) {
                thread::park_timeout(Duration::from_millis(1));
            }
            if reader.is_finished() {
                let _ = reader.join();
            }
            // A user callback can block indefinitely; I/O is already aborted and Drop remains bounded.
        }
    }
}

fn background_read_loop(
    mut reader: BufReader<Box<dyn Stream>>,
    shared: &BackgroundShared,
    on_event: &Arc<dyn Fn(ClientEvent) + Send + Sync>,
) -> BackgroundFailure {
    let mut partial = Vec::new();
    while !shared.closed.load(Ordering::Acquire) {
        // read_until appends bytes even on a timeout; keep them for the next read tick.
        let limit = MAX_LINE + 1 - partial.len();
        let read = (&mut reader)
            .take(limit as u64)
            .read_until(b'\n', &mut partial);
        if partial.last() == Some(&b'\n') {
            partial.pop();
            if !partial.is_empty() && background_dispatch(&partial, shared, on_event).is_err() {
                return BackgroundFailure::InvalidFrame;
            }
            partial.clear();
        } else if partial.len() > MAX_LINE {
            return BackgroundFailure::LineTooLong;
        }
        match read {
            Ok(0) => return BackgroundFailure::Closed,
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) => {}
            Err(_) => return BackgroundFailure::Io,
        }
    }
    BackgroundFailure::Closed
}

fn background_dispatch(
    frame: &[u8],
    shared: &BackgroundShared,
    on_event: &Arc<dyn Fn(ClientEvent) + Send + Sync>,
) -> Result<(), ()> {
    let message: Value = serde_json::from_slice(frame).map_err(|_| ())?;
    let Some(id) = message.get("id") else {
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            on_event(ClientEvent::Notification {
                method: method.into(),
                params: message.get("params").cloned().unwrap_or(Value::Null),
            });
        }
        return Ok(());
    };
    let sender = {
        let mut pending = background_lock(&shared.pending);
        if id.is_null() {
            // A null-id error is only attributable when exactly one call is pending.
            if pending.len() != 1 || message.get("error").is_none() {
                return Err(());
            }
            pending.drain().next().map(|(_, sender)| sender)
        } else {
            pending.remove(&id.as_u64().ok_or(())?)
        }
    };
    if let Some(sender) = sender {
        let response = if let Some(error) = message.get("error") {
            Err(call_error(error))
        } else {
            message
                .get("result")
                .cloned()
                .ok_or_else(|| RpcError::Protocol("response has neither result nor error".into()))
        };
        let _ = sender.try_send(response);
    }
    Ok(())
}

fn call_remaining(start: Instant, timeout: Duration) -> Result<Duration, RpcError> {
    let remaining = timeout.saturating_sub(start.elapsed());
    if remaining.is_zero() {
        Err(background_unavailable(
            "call-timeout",
            "RPC call deadline exceeded",
        ))
    } else {
        Ok(remaining)
    }
}

fn handshake_error(error: RpcError) -> RpcError {
    match error {
        RpcError::Unavailable { reason, detail } if reason == "call-timeout" => {
            RpcError::Unavailable {
                reason: "handshake-timeout".into(),
                detail,
            }
        }
        other => other,
    }
}

fn default_auth_params(token: &str, endpoint: Endpoint) -> Value {
    if endpoint == Endpoint::Engine {
        json!({ "token": token, "clientId": "harness-core" })
    } else {
        json!({ "token": token })
    }
}

enum Line {
    Data(Vec<u8>),
    TooLong,
    Closed,
}

/// Ruling S11: with an expectation, the OS must name exactly that pid as the server, or the token stays unsent.
fn check_server_pid(expected: Option<u32>, actual: Option<u32>) -> Result<(), RpcError> {
    let Some(expected) = expected else {
        return Ok(());
    };
    if actual == Some(expected) {
        return Ok(());
    }
    Err(RpcError::Call {
        error: ErrorCode::EUnauthorized,
        jsonrpc: -32000,
        message: "the pipe is not served by the expected process".into(),
        reason: Some("pipe-server-mismatch".into()),
        detail: Some(match actual {
            Some(pid) => format!("served by pid {pid}, expected pid {expected}"),
            None => format!("the OS does not name the server, expected pid {expected}"),
        }),
        ids: None,
        ext: None,
    })
}

/// Errors after which the stream position is unknown (timeouts, I/O errors, close). The over-long line case poisons
/// itself in `call_inner`, since a `Protocol` error on a complete line leaves the stream at a clean boundary.
fn poisons(e: &RpcError) -> bool {
    matches!(e, RpcError::Unavailable { .. })
}

fn call_error(err: &Value) -> RpcError {
    let error: ErrorCode =
        serde_json::from_value(err["data"]["error"].clone()).unwrap_or(ErrorCode::EInternal);
    RpcError::Call {
        error,
        jsonrpc: err["code"].as_i64().unwrap_or(-32000),
        message: err["message"].as_str().unwrap_or("").to_string(),
        reason: err["data"]["reason"].as_str().map(String::from),
        detail: err["data"]["detail"].as_str().map(String::from),
        ids: err["data"]["ids"].as_object().and_then(|m| {
            let ids: std::collections::BTreeMap<String, String> = m
                .iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect();
            (!ids.is_empty()).then(|| Box::new(ids))
        }),
        ext: err["data"]
            .get("ext")
            .filter(|v| v.is_object())
            .map(|v| Box::new(v.clone())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A hostile endpoint must never observe any byte of a delegated credential.
    #[test]
    fn explicit_auth_params_are_not_written_before_kernel_peer_verification() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        struct Untrusted(Arc<AtomicUsize>);
        impl Read for Untrusted {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Ok(0)
            }
        }
        impl Write for Untrusted {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.fetch_add(bytes.len(), Ordering::SeqCst);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl Stream for Untrusted {
            fn set_read_timeout(&self, _: Option<Duration>) -> std::io::Result<()> {
                Ok(())
            }
            fn peer_pid(&self) -> Option<u32> {
                Some(42)
            }
            #[cfg(unix)]
            fn peer_uid(&self) -> Option<u32> {
                // SAFETY: geteuid has no preconditions and cannot fail.
                Some(unsafe { libc::geteuid() }.wrapping_add(1))
            }
        }
        let writes = Arc::new(AtomicUsize::new(0));
        let result = Client::handshake_with_auth(
            Box::new(Untrusted(writes.clone())),
            json!({"token": "core-secret", "engine": {"token": "engine-secret", "clientId": "memory-engine"}}),
            ConnectOptions {
                expected_server_pid: Some(1),
                ..Default::default()
            },
        );
        assert!(matches!(
            result,
            Err(RpcError::Call {
                error: ErrorCode::EUnauthorized,
                ..
            })
        ));
        assert_eq!(writes.load(Ordering::SeqCst), 0);
    }

    fn reason(r: Result<(), RpcError>) -> Option<String> {
        match r {
            Err(RpcError::Call {
                error: ErrorCode::EUnauthorized,
                reason,
                ..
            }) => reason,
            other => panic!("expected E_UNAUTHORIZED, got {other:?}"),
        }
    }

    /// X1-C19: `error.data.ext` reaches the caller as `RpcError::ext()`; an error without one (or with a non-object)
    /// has none.
    #[test]
    fn error_data_ext_survives_on_a_call_error() {
        let e = call_error(&json!({
            "code": -32000, "message": "needs an acknowledgment",
            "data": { "error": "E_APPROVAL_REQUIRED", "reason": "acknowledge-capabilities",
                      "ext": { "capabilities": { "network": { "mode": "none" } }, "authority": "full" } }
        }));
        assert_eq!(e.code_name(), "E_APPROVAL_REQUIRED");
        let ext = e.ext().expect("ext survives");
        assert_eq!(ext["authority"], "full");
        assert_eq!(ext["capabilities"]["network"]["mode"], "none");
        for data in [json!({ "error": "E_INTERNAL" }), json!({ "ext": "x" })] {
            let e = call_error(&json!({ "code": -32000, "message": "m", "data": data }));
            assert!(e.ext().is_none(), "{e:?}");
        }
    }

    #[test]
    fn a_server_pid_check_passes_on_a_match_or_without_an_expectation() {
        assert!(check_server_pid(Some(42), Some(42)).is_ok());
        assert!(check_server_pid(None, Some(42)).is_ok());
        assert!(check_server_pid(None, None).is_ok());
    }

    #[test]
    fn a_mismatched_or_unnamed_server_is_refused_as_pipe_server_mismatch() {
        assert_eq!(
            reason(check_server_pid(Some(1), Some(42))).as_deref(),
            Some("pipe-server-mismatch")
        );
        assert_eq!(
            reason(check_server_pid(Some(1), None)).as_deref(),
            Some("pipe-server-mismatch")
        );
    }
}
