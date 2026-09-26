//! The supervisor's RPC endpoint: NDJSON JSON-RPC 2.0 on `run/supervisor.sock` (unix) or the per-home
//! `-supervisor` pipe (Windows). One accept loop, one thread per connection (S14). `supervisor.auth` must come first
//! (constant-time token compare); a connection that has not authenticated within [`AUTH_IDLE`] is closed. Params are
//! deserialised into the generated closed structs, so an unknown key is `E_INVALID_PARAMS`.
use super::{spawn_guarded, Shared, StopSource, DEFAULT_STOP_BUDGET, SUPERVISOR_FEATURES};
use crate::paths::{supervisor_address, Layout};
use plur1bus_rpc::client::MAX_LINE;
use plur1bus_rpc::types::{
    DaemonStartParams, DaemonStatusParams, DaemonStopParams, SupervisorAuthParams,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A connection that has not sent a valid `supervisor.auth` by then is closed.
pub const AUTH_IDLE: Duration = Duration::from_secs(30);

/// At most one "accept failed" warning per this interval; the next one carries the suppressed count.
const ACCEPT_WARN_EVERY: Duration = Duration::from_secs(10);

/// `daemon.stop { budgetMs }` upper bound, as in the schema (typify does not check integer ranges).
const MAX_BUDGET_MS: i64 = 120_000;

/// One accepted connection, split so the connection thread can read and write while a watchdog closes it.
pub(crate) struct Accepted {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    /// Ends the connection from another thread; a blocked read then returns.
    pub closer: Box<dyn FnOnce() + Send>,
    /// Makes sure everything written reaches the peer before the connection is dropped.
    pub drain: Box<dyn FnMut() + Send>,
}

pub struct SupervisorServer {
    listener: imp::Listener,
    token: String,
    address: String,
}

impl SupervisorServer {
    /// Listens on the supervisor address. On unix `run/` must exist (the caller creates it `0700` and removes a
    /// dead socket first); the socket is made `0600`. A live socket at the address is an `AddrInUse` error.
    pub fn bind(layout: &Layout, token: &str) -> io::Result<Self> {
        let address = supervisor_address(
            &layout.home,
            if cfg!(windows) { "windows" } else { "posix" },
        );
        let listener = imp::Listener::bind(&address)?;
        Ok(Self {
            listener,
            token: token.to_string(),
            address,
        })
    }

    pub fn address(&self) -> &str {
        &self.address
    }

    /// Accepts connections until the process exits, each on its own guarded thread.
    pub fn serve(self, shared: Arc<Shared>) {
        let hello_base = {
            let st = shared.lock();
            json!({
                "rpc": plur1bus_rpc::RPC_VERSION,
                "instanceId": st.instance_id,
                "pid": st.pid,
                "capabilities": plur1bus_rpc::capabilities("supervisor", SUPERVISOR_FEATURES),
            })
        };
        let ctx = Arc::new(ConnCtx {
            token: self.token,
            hello: hello_base,
            shared: shared.clone(),
        });
        let mut next_id: u64 = 0;
        // Accept failures (e.g. EMFILE) can repeat every few ms; log at most one per ACCEPT_WARN_EVERY.
        let mut last_warn: Option<Instant> = None;
        let mut suppressed: u64 = 0;
        loop {
            match self.listener.accept() {
                Ok(conn) => {
                    next_id += 1;
                    let ctx = ctx.clone();
                    let id = next_id;
                    if let Err(e) =
                        spawn_guarded(&shared, &format!("conn-{id}"), move || ctx.handle(conn))
                    {
                        shared.log.error(
                            "cannot start a connection thread",
                            json!({ "err": e.to_string() }),
                        );
                    }
                }
                Err(e) => {
                    if last_warn.is_none_or(|t| t.elapsed() >= ACCEPT_WARN_EVERY) {
                        shared.log.warn(
                            "accept failed",
                            json!({ "err": e.to_string(), "suppressed": suppressed }),
                        );
                        last_warn = Some(Instant::now());
                        suppressed = 0;
                    } else {
                        suppressed += 1;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
}

struct ConnCtx {
    token: String,
    hello: Value,
    shared: Arc<Shared>,
}

enum Line {
    Data(Vec<u8>),
    TooLong,
    Closed,
}

fn read_line(r: &mut BufReader<Box<dyn Read + Send>>) -> Line {
    let mut buf = Vec::new();
    match r.take(MAX_LINE as u64 + 1).read_until(b'\n', &mut buf) {
        Ok(0) | Err(_) => Line::Closed,
        Ok(_) if buf.last() == Some(&b'\n') => {
            buf.pop();
            Line::Data(buf)
        }
        Ok(_) if buf.len() > MAX_LINE => Line::TooLong,
        Ok(_) => Line::Closed, // EOF in the middle of a line
    }
}

/// An error reply. `data.error` is the closed `ErrorCode`; the JSON-RPC code follows the core (`-32602` for invalid
/// params unless overridden, `-32000` otherwise).
fn error_reply(
    id: &Value,
    error: &str,
    message: &str,
    reason: Option<&str>,
    detail: Option<String>,
    code: Option<i64>,
) -> Value {
    let code = code.unwrap_or(if error == "E_INVALID_PARAMS" {
        -32602
    } else {
        -32000
    });
    let mut data = json!({ "error": error });
    if let Some(r) = reason {
        data["reason"] = json!(r);
    }
    if let Some(d) = detail {
        data["detail"] = json!(d);
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message, "data": data } })
}

fn result_reply(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn invalid_params(id: &Value, detail: String) -> Value {
    error_reply(
        id,
        "E_INVALID_PARAMS",
        "invalid params",
        None,
        Some(detail),
        None,
    )
}

fn parse<P: DeserializeOwned>(params: &Value) -> Result<P, String> {
    serde_json::from_value(params.clone()).map_err(|e| e.to_string())
}

/// Constant-time equality for equal-length inputs (the length itself is not secret: tokens are always 64 chars).
fn tokens_match(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .fold(0u8, |acc, (x, y)| std::hint::black_box(acc | (x ^ y)))
            == 0
}

/// What the connection loop does after a reply.
enum After {
    Continue,
    Close,
    Stop(Duration),
}

impl ConnCtx {
    /// `daemon.start`: reset the core's backoff and ask the main thread for an immediate spawn (a no-op while the
    /// core runs). Under `--no-core` there is never a child.
    fn daemon_start(&self, id: &Value) -> Value {
        let mut st = self.shared.lock();
        if st.no_core {
            return error_reply(
                id,
                "E_NOT_AVAILABLE",
                "this supervisor has no children to start",
                Some("no-children"),
                None,
                None,
            );
        }
        if st.stopping.is_some() {
            return error_reply(
                id,
                "E_NOT_AVAILABLE",
                "the supervisor is stopping",
                Some("stopping"),
                None,
                None,
            );
        }
        st.backoff.reset();
        st.start_requested = true;
        self.shared.wake.notify_all();
        drop(st);
        self.shared
            .log
            .info("daemon.start", json!({ "child": "core" }));
        result_reply(id, json!({ "accepted": true, "role": "core" }))
    }

    fn handle(&self, conn: Accepted) {
        let Accepted {
            reader,
            mut writer,
            closer,
            mut drain,
        } = conn;
        // Watchdog: closes the connection unless `authed_tx` is dropped (auth succeeded, or the connection ended)
        // within AUTH_IDLE.
        let (authed_tx, authed_rx) = mpsc::channel::<()>();
        let watchdog = spawn_guarded(&self.shared, "auth-idle", move || {
            if let Err(mpsc::RecvTimeoutError::Timeout) = authed_rx.recv_timeout(AUTH_IDLE) {
                closer();
            }
        });
        if let Err(e) = watchdog {
            // Without the watchdog nothing would close an idle unauthenticated connection: refuse it instead.
            self.shared.log.error(
                "cannot start the auth-idle watchdog, closing the connection",
                json!({ "err": e.to_string() }),
            );
            return;
        }
        let mut authed_tx = Some(authed_tx);
        let mut reader = BufReader::new(reader);
        loop {
            let (reply, after) = match read_line(&mut reader) {
                Line::Closed => break,
                Line::TooLong => (
                    error_reply(
                        &Value::Null,
                        "E_INVALID_PARAMS",
                        "line too long",
                        Some("line-too-long"),
                        None,
                        None,
                    ),
                    After::Close,
                ),
                Line::Data(buf) if buf.iter().all(u8::is_ascii_whitespace) => continue,
                Line::Data(buf) => match serde_json::from_slice::<Value>(&buf) {
                    Err(_) => (
                        error_reply(
                            &Value::Null,
                            "E_INVALID_PARAMS",
                            "parse error",
                            Some("parse-error"),
                            None,
                            Some(-32700),
                        ),
                        After::Continue,
                    ),
                    Ok(msg) => match self.dispatch(&msg, authed_tx.is_none()) {
                        None => continue, // a notification: no reply
                        Some((reply, after, authed)) => {
                            if authed {
                                authed_tx = None;
                            }
                            (reply, after)
                        }
                    },
                },
            };
            let mut line = reply.to_string();
            line.push('\n');
            if writer
                .write_all(line.as_bytes())
                .and_then(|_| writer.flush())
                .is_err()
            {
                break;
            }
            match after {
                After::Continue => {}
                After::Close => {
                    drain();
                    break;
                }
                After::Stop(budget) => {
                    // The reply is out before the stop starts.
                    drain();
                    self.shared.request_stop(budget, StopSource::Rpc);
                }
            }
        }
        drop(authed_tx);
    }

    /// Returns the reply, what to do next, and whether the connection is now authenticated; `None` for a message
    /// without an `id` (a notification), which gets no reply.
    fn dispatch(&self, msg: &Value, authed: bool) -> Option<(Value, After, bool)> {
        let id = msg.get("id").cloned();
        let valid = msg.is_object()
            && msg["jsonrpc"] == "2.0"
            && msg["method"].is_string()
            && matches!(id, None | Some(Value::String(_)) | Some(Value::Number(_)))
            && matches!(msg.get("params"), None | Some(Value::Object(_)));
        if !valid {
            let id = match id {
                Some(v @ (Value::String(_) | Value::Number(_))) => v,
                _ => Value::Null,
            };
            let reply = error_reply(
                &id,
                "E_INVALID_PARAMS",
                "invalid request",
                Some("invalid-request"),
                None,
                Some(-32600),
            );
            return Some((reply, After::Continue, false));
        }
        let id = id?;
        let method = msg["method"].as_str().unwrap_or_default();
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

        if method == "supervisor.auth" {
            let p: SupervisorAuthParams = match parse(&params) {
                Ok(p) => p,
                Err(d) => return Some((invalid_params(&id, d), After::Close, false)),
            };
            if !tokens_match(&p.token, &self.token) {
                self.shared
                    .log
                    .warn("supervisor.auth refused", json!({ "reason": "bad-token" }));
                let reply = error_reply(
                    &id,
                    "E_UNAUTHORIZED",
                    "bad token",
                    Some("bad-token"),
                    None,
                    None,
                );
                return Some((reply, After::Close, false));
            }
            return Some((result_reply(&id, self.hello.clone()), After::Continue, true));
        }
        if !authed {
            let reply = error_reply(
                &id,
                "E_UNAUTHORIZED",
                "authenticate first",
                Some("auth-required"),
                None,
                None,
            );
            return Some((reply, After::Continue, false));
        }
        let reply = match method {
            "daemon.status" => match parse::<DaemonStatusParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => (
                    result_reply(&id, self.shared.lock().status_json()),
                    After::Continue,
                ),
            },
            "daemon.start" => match parse::<DaemonStartParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => (self.daemon_start(&id), After::Continue),
            },
            "daemon.stop" => match parse::<DaemonStopParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(DaemonStopParams { budget_ms: Some(b) })
                    if !(0..=MAX_BUDGET_MS).contains(&b) =>
                {
                    (
                        invalid_params(
                            &id,
                            format!("budgetMs must be between 0 and {MAX_BUDGET_MS}"),
                        ),
                        After::Continue,
                    )
                }
                Ok(p) => {
                    let budget = p
                        .budget_ms
                        .map(|b| Duration::from_millis(b as u64))
                        .unwrap_or(DEFAULT_STOP_BUDGET);
                    (
                        result_reply(&id, json!({ "accepted": true })),
                        After::Stop(budget),
                    )
                }
            },
            other => (
                error_reply(
                    &id,
                    "E_INTERNAL",
                    &format!("method not found: {other}"),
                    Some("method-not-found"),
                    None,
                    Some(-32601),
                ),
                After::Continue,
            ),
        };
        Some((reply.0, reply.1, false))
    }
}

#[cfg(unix)]
mod imp {
    use super::Accepted;
    use std::io;
    use std::net::Shutdown;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    pub struct Listener(UnixListener);

    impl Listener {
        pub fn bind(address: &str) -> io::Result<Self> {
            let l = UnixListener::bind(address)?;
            std::fs::set_permissions(address, std::fs::Permissions::from_mode(0o600))?;
            Ok(Self(l))
        }

        pub fn accept(&self) -> io::Result<Accepted> {
            let (s, _) = self.0.accept()?;
            let reader = s.try_clone()?;
            let closer = s.try_clone()?;
            Ok(Accepted {
                reader: Box::new(reader),
                writer: Box::new(s),
                closer: Box::new(move || {
                    let _ = closer.shutdown(Shutdown::Both);
                }),
                // The kernel delivers what was written before the close.
                drain: Box::new(|| {}),
            })
        }
    }
}

#[cfg(windows)]
mod imp {
    //! A plain byte-mode named pipe; the explicit DACL and `FILE_FLAG_FIRST_PIPE_INSTANCE` come with Task 10.
    use super::Accepted;
    use std::fs::File;
    use std::io::{self, Read, Write};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::sync::{Arc, Mutex};
    use windows_sys::Win32::Foundation::{ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
        PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };
    use windows_sys::Win32::System::IO::CancelIoEx;

    pub struct Listener {
        name: Vec<u16>,
        /// The instance the next `accept` waits on.
        next: Mutex<Option<OwnedHandle>>,
    }

    fn create_instance(name: &[u16]) -> io::Result<OwnedHandle> {
        // SAFETY: `name` is NUL-terminated; a null security-attributes pointer means the default DACL.
        let h = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                64 * 1024,
                64 * 1024,
                0,
                std::ptr::null(),
            )
        };
        if h == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `h` is a valid handle we own.
        Ok(unsafe { OwnedHandle::from_raw_handle(h) })
    }

    struct Pipe(Arc<File>);
    impl Read for Pipe {
        fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
            (&*self.0).read(b)
        }
    }
    impl Write for Pipe {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            (&*self.0).write(b)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Listener {
        pub fn bind(address: &str) -> io::Result<Self> {
            let name: Vec<u16> = std::ffi::OsStr::new(address)
                .encode_wide()
                .chain(Some(0))
                .collect();
            let first = create_instance(&name)?;
            Ok(Self {
                name,
                next: Mutex::new(Some(first)),
            })
        }

        pub fn accept(&self) -> io::Result<Accepted> {
            let h = match self.next.lock().unwrap_or_else(|e| e.into_inner()).take() {
                Some(h) => h,
                None => create_instance(&self.name)?,
            };
            // SAFETY: `h` is a valid pipe instance; a null OVERLAPPED makes this a blocking wait for a client.
            let ok = unsafe { ConnectNamedPipe(h.as_raw_handle(), std::ptr::null_mut()) };
            if ok == 0 {
                let e = io::Error::last_os_error();
                if e.raw_os_error() != Some(ERROR_PIPE_CONNECTED as i32) {
                    return Err(e);
                }
            }
            // Keep an instance listening while this one is served (clients retry on ERROR_PIPE_BUSY meanwhile).
            if let Ok(n) = create_instance(&self.name) {
                *self.next.lock().unwrap_or_else(|e| e.into_inner()) = Some(n);
            }
            let file = Arc::new(File::from(h));
            let closer = file.clone();
            let drain = file.clone();
            Ok(Accepted {
                reader: Box::new(Pipe(file.clone())),
                writer: Box::new(Pipe(file)),
                closer: Box::new(move || {
                    let raw = closer.as_raw_handle();
                    // SAFETY: `closer` keeps the handle open for the duration of both calls.
                    unsafe {
                        DisconnectNamedPipe(raw);
                        CancelIoEx(raw, std::ptr::null());
                    }
                }),
                // FlushFileBuffers: wait until the client has read what was written, so closing does not drop it.
                drain: Box::new(move || {
                    let _ = drain.sync_all();
                }),
            })
        }
    }
}
