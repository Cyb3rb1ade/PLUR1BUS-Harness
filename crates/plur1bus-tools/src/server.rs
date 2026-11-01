//! Authenticated NDJSON dispatch and lifecycle. Modules receive only an established Core context.
use crate::files;
use plur1bus_rpc::listener::{Accepted, Listener};
use plur1bus_rpc::types::{
    ErrorCode, ModuleAdoptParams, ModuleAuthParams, ModuleShutdownParams, ModuleStatusParams,
    ToolsHealthParams, ToolsHelloParams,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CONNECTIONS: usize = 128;

/// An RPC refusal with the existing harness error vocabulary; never carries caller payloads.
#[derive(Debug, Clone)]
pub struct ToolError {
    /// Existing harness error code.
    pub code: ErrorCode,
    /// Stable refusal reason; no credentials or tool arguments.
    pub reason: &'static str,
}

impl ToolError {
    fn denied() -> Self {
        Self {
            code: ErrorCode::EDenied,
            reason: "tools-core-only",
        }
    }
    fn invalid() -> Self {
        Self {
            code: ErrorCode::EInvalidParams,
            reason: "tools-params",
        }
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.reason)
    }
}
impl std::error::Error for ToolError {}

/// The authenticated Core's per-start key (D120 §11.2); not constructible from RPC principal fields.
pub struct CoreContext {
    ticket_key: Zeroizing<[u8; 32]>,
}
impl CoreContext {
    /// Borrow the handshake key for the dispatcher-ticket verifier; never log or persist it.
    pub fn ticket_key(&self) -> &[u8; 32] {
        &self.ticket_key
    }
}

/// Extension point for D123/D124 and later ACI modules. The server enforces the Core guard first.
pub trait ToolsModule: Send + Sync {
    /// Return `None` for another module's method; validate all closed method params before any effects.
    fn call(
        &self,
        method: &str,
        params: &Value,
        core: &CoreContext,
    ) -> Option<Result<Value, ToolError>>;
}

#[derive(Default)]
struct Lifecycle {
    generation: u64,
    orphaned: Option<Instant>,
}

struct Runtime {
    home: PathBuf,
    instance: String,
    control_token: Zeroizing<String>,
    core_token: Zeroizing<String>,
    started: Instant,
    since: u64,
    lifecycle: Mutex<Lifecycle>,
    stopping: AtomicBool,
    connections: AtomicUsize,
    modules: Vec<Arc<dyn ToolsModule>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn params<T: DeserializeOwned>(value: Value) -> Result<T, ToolError> {
    serde_json::from_value(value).map_err(|_| ToolError::invalid())
}

impl Runtime {
    fn process(&self) -> Value {
        let state = if self.stopping.load(Ordering::SeqCst) {
            "stopping"
        } else if lock(&self.lifecycle).orphaned.is_some() {
            "orphaned"
        } else {
            "ready"
        };
        json!({"state":state,"since":self.since})
    }
    fn status(&self) -> Value {
        json!({"process":self.process(),"name":"tools","version":env!("CARGO_PKG_VERSION"),
            "apiVersion":"1","instanceId":self.instance,"pid":std::process::id(),
            "uptimeMs":self.started.elapsed().as_millis() as u64,"core":"not-needed",
            "detail":{"adopted":lock(&self.lifecycle).generation > 0}})
    }
    fn hello(&self, core: bool) -> Value {
        let mut result = json!({"rpc":plur1bus_rpc::RPC_VERSION,"instanceId":self.instance,
            "pid":std::process::id(),"capabilities":plur1bus_rpc::capabilities(if core {"tools"} else {"module"}, &[])});
        if !core {
            result["module"] =
                json!({"name":"tools","version":env!("CARGO_PKG_VERSION"),"apiVersion":"1"});
        }
        result
    }
    fn orphan(&self, generation: u64) {
        let mut state = lock(&self.lifecycle);
        if state.generation == generation {
            state.orphaned = Some(Instant::now());
        }
    }
    fn dispatch(
        &self,
        method: &str,
        value: Value,
        core: Option<&CoreContext>,
    ) -> Result<Value, ToolError> {
        let core = core.ok_or_else(ToolError::denied)?;
        if method == "tools.health" {
            let _: ToolsHealthParams = params(value)?;
            return Ok(
                json!({"process":self.process(),"rpc":plur1bus_rpc::RPC_VERSION,
                "instanceId":self.instance,"pid":std::process::id(),"uptimeMs":self.started.elapsed().as_millis() as u64}),
            );
        }
        for module in &self.modules {
            if let Some(result) = module.call(method, &value, core) {
                return result;
            }
        }
        Err(ToolError {
            code: ErrorCode::ENotAvailable,
            reason: "method-not-found",
        })
    }
}

/// Owns the native listener, instance lock and private run files until shutdown.
pub struct Service {
    runtime: Arc<Runtime>,
    listener: Option<Listener>,
    _lock: File,
}

impl Service {
    /// Bind one tools instance. A held lock, unsafe run file or occupied endpoint is an error.
    pub fn bind(
        home: &Path,
        instance: &str,
        modules: Vec<Arc<dyn ToolsModule>>,
    ) -> io::Result<Self> {
        if !home.is_absolute() {
            return Err(io::Error::other("tools home must be absolute"));
        }
        files::private_dir(home)?;
        files::private_dir(&home.join("state"))?;
        files::private_dir(&home.join("run"))?;
        let single = files::private_file(&home.join("state/tools.lock"))?;
        single.try_lock().map_err(|error| match error {
            fs::TryLockError::WouldBlock => {
                io::Error::new(io::ErrorKind::WouldBlock, "tools instance already running")
            }
            fs::TryLockError::Error(error) => error,
        })?;
        let endpoint = crate::address(home);
        #[cfg(unix)]
        if Path::new(&endpoint).exists() {
            if std::os::unix::net::UnixStream::connect(&endpoint).is_ok() {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "tools endpoint is live",
                ));
            }
            fs::remove_file(&endpoint)?;
        }
        let listener = Listener::bind(&endpoint)?;
        let runtime = Arc::new(Runtime {
            home: home.to_path_buf(),
            instance: instance.into(),
            control_token: Zeroizing::new(files::fresh_token()?),
            core_token: Zeroizing::new(files::fresh_token()?),
            started: Instant::now(),
            since: now(),
            lifecycle: Mutex::new(Lifecycle::default()),
            stopping: AtomicBool::new(false),
            connections: AtomicUsize::new(0),
            modules,
        });
        let service = Self {
            runtime,
            listener: Some(listener),
            _lock: single,
        };
        files::write_private(
            &home.join("run/tools.pid"),
            &format!("{} {instance}\n", std::process::id()),
        )?;
        files::write_private(
            &home.join("run/tools.token"),
            &service.runtime.control_token,
        )?;
        // Published last: Core treats this credential as readiness of all run files.
        files::write_private(
            &home.join("run/tools-core.token"),
            &service.runtime.core_token,
        )?;
        Ok(service)
    }

    /// Listen until lifecycle shutdown or an unadopted stdin lifeline expires. No secret-store values are read.
    pub fn serve(mut self, stdin_lifeline: bool, orphan_grace: Duration) -> io::Result<()> {
        let listener = self
            .listener
            .take()
            .ok_or_else(|| io::Error::other("tools listener missing"))?;
        let runtime = self.runtime.clone();
        std::thread::Builder::new()
            .name("tools-accept".into())
            .spawn(move || {
                while !runtime.stopping.load(Ordering::SeqCst) {
                    let Ok(connection) = listener.accept() else {
                        std::thread::sleep(Duration::from_millis(25));
                        continue;
                    };
                    if runtime.connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                        runtime.connections.fetch_sub(1, Ordering::SeqCst);
                        (connection.closer)();
                        continue;
                    }
                    let state = runtime.clone();
                    if std::thread::Builder::new()
                        .name("tools-rpc".into())
                        .spawn(move || {
                            handle(&state, connection);
                            state.connections.fetch_sub(1, Ordering::SeqCst);
                        })
                        .is_err()
                    {
                        runtime.connections.fetch_sub(1, Ordering::SeqCst);
                    }
                }
            })?;
        if stdin_lifeline {
            let state = self.runtime.clone();
            std::thread::Builder::new()
                .name("tools-lifeline".into())
                .spawn(move || {
                    let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
                    state.orphan(0);
                })?;
        }
        while !self.runtime.stopping.load(Ordering::SeqCst) {
            if lock(&self.runtime.lifecycle)
                .orphaned
                .is_some_and(|at| at.elapsed() >= orphan_grace)
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        self.runtime.stopping.store(true, Ordering::SeqCst);
        Ok(())
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        // The instance lock remains held while these files are removed.
        self.runtime.stopping.store(true, Ordering::SeqCst);
        for name in ["tools-core.token", "tools.token", "tools.pid", "tools.sock"] {
            let _ = fs::remove_file(self.runtime.home.join("run").join(name));
        }
    }
}

fn handle(runtime: &Runtime, mut connection: Accepted) {
    let (authenticated, deadline) = mpsc::channel();
    let close = connection.closer.clone();
    let watchdog = std::thread::spawn(move || {
        if deadline.recv_timeout(AUTH_TIMEOUT) != Ok(true) {
            close();
        }
    });
    let mut reader = BufReader::new(connection.reader);
    let mut core = None;
    let mut control = false;
    let mut adoption = None;
    loop {
        let mut bytes = Vec::new();
        let read = reader
            .by_ref()
            .take(plur1bus_rpc::client::MAX_LINE as u64 + 1)
            .read_until(b'\n', &mut bytes);
        if read.is_err() || bytes.is_empty() || bytes.last() != Some(&b'\n') {
            break;
        }
        let request = match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) => v,
            Err(_) => break,
        };
        let id = &request["id"];
        if request["jsonrpc"] != "2.0" || (!id.is_string() && !id.is_i64() && !id.is_u64()) {
            break;
        }
        let Some(method) = request["method"].as_str() else {
            break;
        };
        let value = request.get("params").cloned().unwrap_or_else(|| json!({}));
        let result = route(
            runtime,
            method,
            value,
            &mut core,
            &mut control,
            &mut adoption,
        );
        if core.is_some() || control {
            let _ = authenticated.send(true);
        }
        let reply = match result {
            Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
            Err(error) => json!({"jsonrpc":"2.0","id":id,"error":{
                "code":if error.reason == "method-not-found" {-32601} else if error.code == ErrorCode::EInvalidParams {-32602} else {-32000},
                "message":error.to_string(),"data":{"error":error.code,"reason":error.reason}}}),
        };
        if writeln!(connection.writer, "{reply}")
            .and_then(|_| connection.writer.flush())
            .is_err()
        {
            break;
        }
        if runtime.stopping.load(Ordering::SeqCst) {
            break;
        }
    }
    if let Some(generation) = adoption {
        runtime.orphan(generation);
    }
    drop(authenticated);
    (connection.drain)();
    (connection.closer)();
    let _ = watchdog.join();
}

fn route(
    runtime: &Runtime,
    method: &str,
    value: Value,
    core: &mut Option<CoreContext>,
    control: &mut bool,
    adoption: &mut Option<u64>,
) -> Result<Value, ToolError> {
    if method == "tools.hello" || method == "module.auth" {
        if core.is_some() || *control {
            return Err(ToolError {
                code: ErrorCode::EDenied,
                reason: "tools-identity-change",
            });
        }
        if method == "tools.hello" {
            let input: ToolsHelloParams = params(value)?;
            let token = Zeroizing::new(String::from(input.token));
            let key = Zeroizing::new(String::from(input.ticket_key));
            if !files::same(&token, &runtime.core_token) {
                return Err(ToolError {
                    code: ErrorCode::EUnauthorized,
                    reason: "tools-credential",
                });
            }
            let ticket_key = files::ticket_key(&key).ok_or_else(ToolError::invalid)?;
            *core = Some(CoreContext { ticket_key });
            return Ok(runtime.hello(true));
        }
        let input: ModuleAuthParams = params(value)?;
        if !files::same(&input.token, &runtime.control_token) {
            return Err(ToolError {
                code: ErrorCode::EUnauthorized,
                reason: "tools-credential",
            });
        }
        *control = true;
        return Ok(runtime.hello(false));
    }
    if method.starts_with("tools.") {
        return runtime.dispatch(method, value, core.as_ref());
    }
    if !*control {
        return Err(ToolError::denied());
    }
    match method {
        "module.status" => {
            let _: ModuleStatusParams = params(value)?;
            Ok(runtime.status())
        }
        "module.shutdown" => {
            let input: ModuleShutdownParams = params(value)?;
            if input
                .budget_ms
                .is_some_and(|ms| !(0..=120_000).contains(&ms))
            {
                return Err(ToolError::invalid());
            }
            runtime.stopping.store(true, Ordering::SeqCst);
            Ok(json!({"accepted":true}))
        }
        "module.adopt" => {
            let input: ModuleAdoptParams = params(value)?;
            let expected =
                files::read_private(&runtime.home.join("run/supervisor.token")).unwrap_or_default();
            if expected.len() != 64 || !files::same(&input.nonce, &expected) {
                return Err(ToolError {
                    code: ErrorCode::EUnauthorized,
                    reason: "adopt-nonce",
                });
            }
            let mut state = lock(&runtime.lifecycle);
            state.generation = state.generation.saturating_add(1);
            *adoption = Some(state.generation);
            state.orphaned = None;
            drop(state);
            Ok(json!({"status":runtime.status()}))
        }
        _ => Err(ToolError {
            code: ErrorCode::ENotAvailable,
            reason: "method-not-found",
        }),
    }
}
