//! Authenticated NDJSON dispatch and lifecycle. Modules receive only an established Core context.
use crate::files;
use plur1bus_rpc::server_transport::{Accepted, Listener};
use plur1bus_rpc::types::{
    ErrorCode, ModuleAdoptParams, ModuleAuthParams, ModuleShutdownParams, ModuleStatusParams,
    ToolsHealthParams, ToolsHelloParams,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::cell::Cell;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CONNECTIONS: usize = 128;
const MAX_ACCEPT_ERRORS: u32 = 16;

#[derive(Default)]
struct AcceptErrors {
    total: u64,
    consecutive: u32,
}

impl AcceptErrors {
    fn failed(&mut self) -> io::Result<Duration> {
        self.total += 1;
        self.consecutive += 1;
        // Fixed fields only: raw OS errors and endpoint paths never become RPC output.
        let _ = writeln!(
            io::stderr().lock(),
            "tools accept failed: total={} consecutive={}",
            self.total,
            self.consecutive
        );
        if self.consecutive >= MAX_ACCEPT_ERRORS {
            return Err(io::Error::other("tools accept error limit reached"));
        }
        Ok(Duration::from_millis(
            (25_u64 << (self.consecutive - 1).min(4)).min(250),
        ))
    }
}

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
    ticket_key: Arc<Zeroizing<[u8; 32]>>,
    identity: CoreIdentity,
    generation: u64,
}

type CloseConnection = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone, PartialEq, Eq)]
struct CoreIdentity {
    pid: u32,
    instance: String,
}

#[derive(Default)]
struct CoreState {
    identity: Option<CoreIdentity>,
    ticket_key: Option<Arc<Zeroizing<[u8; 32]>>>,
    generation: u64,
    connections: BTreeMap<u64, CloseConnection>,
}

struct ConnectionState {
    core: Option<CoreContext>,
    control: bool,
    adoption: Option<u64>,
    peer_pid: Option<u32>,
    id: u64,
    closer: CloseConnection,
}

struct CoreConnectionCleanup<'a> {
    runtime: &'a Runtime,
    id: u64,
    closer: CloseConnection,
}

struct ConnectionCount(Arc<Runtime>);
impl Drop for ConnectionCount {
    fn drop(&mut self) {
        self.0.connections.fetch_sub(1, Ordering::SeqCst);
    }
}

thread_local! {
    static IN_MODULE_CALL: Cell<bool> = const { Cell::new(false) };
}

struct ModulePanicBoundary(bool);
impl ModulePanicBoundary {
    fn enter() -> Self {
        static HOOK: std::sync::Once = std::sync::Once::new();
        HOOK.call_once(|| {
            let previous = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                // catch_unwind alone still invokes the default hook, which could disclose module arguments.
                if !IN_MODULE_CALL.try_with(Cell::get).unwrap_or(false) {
                    previous(info);
                }
            }));
        });
        Self(IN_MODULE_CALL.with(|active| active.replace(true)))
    }
}
impl Drop for ModulePanicBoundary {
    fn drop(&mut self) {
        IN_MODULE_CALL.with(|active| active.set(self.0));
    }
}

impl Drop for CoreConnectionCleanup<'_> {
    fn drop(&mut self) {
        lock(&self.runtime.core).connections.remove(&self.id);
        (self.closer)();
    }
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
    next_connection: AtomicU64,
    core: Mutex<CoreState>,
    stdin_closed: AtomicBool,
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
    fn core_identity(&self) -> Result<CoreIdentity, ToolError> {
        let refused = || ToolError {
            code: ErrorCode::EDenied,
            reason: "tools-core-identity",
        };
        let recorded =
            files::read_private(&self.home.join("run/core.pid")).map_err(|_| refused())?;
        let mut fields = recorded.split_whitespace();
        let pid = fields
            .next()
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|pid| *pid > 0)
            .ok_or_else(refused)?;
        let instance = fields.next().ok_or_else(refused)?.to_owned();
        if fields.next().is_some() {
            return Err(refused());
        }
        Ok(CoreIdentity { pid, instance })
    }

    fn authorize_core(
        &self,
        state: &ConnectionState,
        ticket_key: Zeroizing<[u8; 32]>,
    ) -> Result<CoreContext, ToolError> {
        if self.stopping.load(Ordering::SeqCst) {
            return Err(ToolError::denied());
        }
        let identity = self.core_identity()?;
        if state.peer_pid.is_some_and(|pid| pid != identity.pid) {
            return Err(ToolError {
                code: ErrorCode::EDenied,
                reason: "tools-core-identity",
            });
        }
        let mut core = lock(&self.core);
        if self.stopping.load(Ordering::SeqCst) || self.core_identity()? != identity {
            return Err(ToolError::denied());
        }
        let retired = if core.identity.as_ref() != Some(&identity) {
            let retired = std::mem::take(&mut core.connections);
            core.generation = core.generation.saturating_add(1);
            core.identity = Some(identity.clone());
            core.ticket_key = Some(Arc::new(ticket_key));
            retired
        } else {
            let same = core.ticket_key.as_ref().is_some_and(|expected| {
                expected
                    .iter()
                    .zip(ticket_key.iter())
                    .fold(0u8, |different, (left, right)| different | (left ^ right))
                    == 0
            });
            if !same {
                return Err(ToolError {
                    code: ErrorCode::EDenied,
                    reason: "tools-ticket-key",
                });
            }
            BTreeMap::new()
        };
        let context = CoreContext {
            ticket_key: core
                .ticket_key
                .as_ref()
                .cloned()
                .ok_or_else(ToolError::denied)?,
            identity,
            generation: core.generation,
        };
        core.connections.insert(state.id, state.closer.clone());
        drop(core);
        // Do not call another connection's close while holding the registry lock used by its Drop guard.
        for close in retired.into_values() {
            close();
        }
        Ok(context)
    }

    fn current_core(&self, context: &CoreContext) -> bool {
        if self.core_identity().ok().as_ref() != Some(&context.identity) {
            return false;
        }
        let state = lock(&self.core);
        state.generation == context.generation && state.identity.as_ref() == Some(&context.identity)
    }

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
            "detail":{"adopted":lock(&self.lifecycle).generation > 0,"stdinClosed":self.stdin_closed.load(Ordering::Acquire)}})
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
        if !self.current_core(core) {
            return Err(ToolError::denied());
        }
        if method == "tools.health" {
            let _: ToolsHealthParams = params(value)?;
            return Ok(
                json!({"process":self.process(),"rpc":plur1bus_rpc::RPC_VERSION,
                "instanceId":self.instance,"pid":std::process::id(),"uptimeMs":self.started.elapsed().as_millis() as u64}),
            );
        }
        for module in &self.modules {
            let result = {
                let _boundary = ModulePanicBoundary::enter();
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    module.call(method, &value, core)
                }))
            }
            .map_err(|_| ToolError {
                code: ErrorCode::EInternal,
                reason: "module-panic",
            })?;
            if let Some(result) = result {
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
        files::shared_dir(home)?;
        files::shared_dir(&home.join("state"))?;
        files::run_dir(&home.join("run"))?;
        files::private_dir(&home.join("state/tools"))?;
        let single = files::private_file(&home.join("state/tools/instance.lock"))?;
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
            next_connection: AtomicU64::new(1),
            core: Mutex::new(CoreState::default()),
            stdin_closed: AtomicBool::new(false),
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
        self.serve_accept(stdin_lifeline, orphan_grace, move |timeout| {
            listener.accept_timeout(timeout)
        })
    }

    fn serve_accept(
        self,
        stdin_lifeline: bool,
        orphan_grace: Duration,
        mut accept: impl FnMut(Duration) -> io::Result<Option<Accepted>> + Send + 'static,
    ) -> io::Result<()> {
        let runtime = self.runtime.clone();
        let acceptor = std::thread::Builder::new()
            .name("tools-accept".into())
            .spawn(move || {
                let mut errors = AcceptErrors::default();
                while !runtime.stopping.load(Ordering::SeqCst) {
                    let connection = match accept(Duration::from_millis(25)) {
                        Ok(Some(connection)) => {
                            errors.consecutive = 0;
                            connection
                        }
                        Ok(None) => continue,
                        Err(_) => {
                            let delay = match errors.failed() {
                                Ok(delay) => delay,
                                Err(error) => {
                                    runtime.stopping.store(true, Ordering::SeqCst);
                                    return Err(error);
                                }
                            };
                            std::thread::sleep(delay);
                            continue;
                        }
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
                            let _count = ConnectionCount(state.clone());
                            handle(&state, connection);
                        })
                        .is_err()
                    {
                        runtime.connections.fetch_sub(1, Ordering::SeqCst);
                    }
                }
                Ok(())
            })?;
        if stdin_lifeline {
            let state = self.runtime.clone();
            std::thread::Builder::new()
                .name("tools-lifeline".into())
                .spawn(move || {
                    let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
                    state.orphan(0);
                    state.stdin_closed.store(true, Ordering::Release);
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
        acceptor
            .join()
            .map_err(|_| io::Error::other("tools acceptor failed"))?
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        // The instance lock remains held while these files are removed.
        self.runtime.stopping.store(true, Ordering::SeqCst);
        let mut core = lock(&self.runtime.core);
        let connections = std::mem::take(&mut core.connections);
        core.ticket_key = None;
        core.identity = None;
        drop(core);
        for close in connections.into_values() {
            close();
        }
        for name in ["tools-core.token", "tools.token", "tools.pid", "tools.sock"] {
            let _ = fs::remove_file(self.runtime.home.join("run").join(name));
        }
    }
}

fn handle(runtime: &Runtime, mut connection: Accepted) {
    let id = runtime.next_connection.fetch_add(1, Ordering::Relaxed);
    let _cleanup = CoreConnectionCleanup {
        runtime,
        id,
        closer: connection.closer.clone(),
    };
    let mut state = ConnectionState {
        core: None,
        control: false,
        adoption: None,
        peer_pid: connection.peer_pid,
        id,
        closer: connection.closer.clone(),
    };
    let (authenticated, deadline) = mpsc::channel();
    let close = connection.closer.clone();
    let watchdog = std::thread::spawn(move || {
        if deadline.recv_timeout(AUTH_TIMEOUT) != Ok(true) {
            close();
        }
    });
    let mut reader = BufReader::new(connection.reader);
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
        let result = route(runtime, method, value, &mut state);
        if state.core.is_some() || state.control {
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
    if let Some(generation) = state.adoption {
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
    state: &mut ConnectionState,
) -> Result<Value, ToolError> {
    if method == "tools.hello" || method == "module.auth" {
        if state.core.is_some() || state.control {
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
            state.core = Some(runtime.authorize_core(state, ticket_key)?);
            return Ok(runtime.hello(true));
        }
        let input: ModuleAuthParams = params(value)?;
        if !files::same(&input.token, &runtime.control_token) {
            return Err(ToolError {
                code: ErrorCode::EUnauthorized,
                reason: "tools-credential",
            });
        }
        state.control = true;
        return Ok(runtime.hello(false));
    }
    if method.starts_with("tools.") {
        return runtime.dispatch(method, value, state.core.as_ref());
    }
    if !state.control {
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
            let expected = Zeroizing::new(
                files::read_private(&runtime.home.join("run/supervisor.token")).unwrap_or_default(),
            );
            if expected.len() != 64 || !files::same(&input.nonce, &expected) {
                return Err(ToolError {
                    code: ErrorCode::EUnauthorized,
                    reason: "adopt-nonce",
                });
            }
            let mut lifecycle = lock(&runtime.lifecycle);
            lifecycle.generation = lifecycle.generation.saturating_add(1);
            state.adoption = Some(lifecycle.generation);
            lifecycle.orphaned = None;
            drop(lifecycle);
            Ok(json!({"status":runtime.status()}))
        }
        _ => Err(ToolError {
            code: ErrorCode::ENotAvailable,
            reason: "method-not-found",
        }),
    }
}

#[cfg(all(test, unix))]
#[allow(clippy::unwrap_used)]
mod home_permissions_tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn home() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join("state")).unwrap();
        fs::create_dir(home.path().join("run")).unwrap();
        fs::set_permissions(home.path().join("run"), fs::Permissions::from_mode(0o700)).unwrap();
        home
    }

    #[test]
    fn binding_preserves_user_managed_home_and_shared_state_permissions() {
        let home = home();
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o751)).unwrap();
        fs::set_permissions(home.path().join("state"), fs::Permissions::from_mode(0o750)).unwrap();
        fs::write(home.path().join("state/user-data"), "unchanged").unwrap();
        let service = Service::bind(home.path(), "permissions", vec![]).unwrap();
        assert_eq!(
            fs::metadata(home.path()).unwrap().permissions().mode() & 0o777,
            0o751
        );
        assert_eq!(
            fs::metadata(home.path().join("state"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o750
        );
        assert_eq!(
            fs::read_to_string(home.path().join("state/user-data")).unwrap(),
            "unchanged"
        );
        drop(service);
    }

    #[test]
    fn binding_accepts_a_symlinked_home_like_the_core() {
        let home = home();
        let parent = tempfile::tempdir().unwrap();
        let alias = parent.path().join("home");
        symlink(home.path(), &alias).unwrap();
        let service = Service::bind(&alias, "symlink-home", vec![]).unwrap();
        assert!(alias.join("run/tools-core.token").is_file());
        drop(service);
    }

    #[test]
    fn an_untrusted_run_directory_is_refused_without_repairing_it() {
        let home = home();
        let run = home.path().join("run");
        fs::set_permissions(&run, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(Service::bind(home.path(), "unsafe-run", vec![]).is_err());
        assert_eq!(
            fs::metadata(&run).unwrap().permissions().mode() & 0o777,
            0o777
        );
        assert!(!run.join("tools-core.token").exists());
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod panic_boundary_tests {
    use super::*;
    use std::thread::JoinHandle;

    struct PanickingModule;
    impl ToolsModule for PanickingModule {
        #[allow(clippy::panic)] // Inject a real unwind to verify the production RPC panic boundary.
        fn call(
            &self,
            method: &str,
            _: &Value,
            _: &CoreContext,
        ) -> Option<Result<Value, ToolError>> {
            if method == "tools.fixture.panic" {
                panic!("fixture module panic");
            }
            None
        }
    }

    struct Running {
        home: tempfile::TempDir,
        runtime: Arc<Runtime>,
        thread: Option<JoinHandle<io::Result<()>>>,
    }

    impl Running {
        fn start() -> Self {
            let home = tempfile::tempdir().unwrap();
            fs::create_dir(home.path().join("state")).unwrap();
            files::run_dir(&home.path().join("run")).unwrap();
            files::write_private(
                &home.path().join("run/core.pid"),
                &format!("{} {}\n", std::process::id(), uuid::Uuid::new_v4()),
            )
            .unwrap();
            let service = Service::bind(
                home.path(),
                "panic-fixture",
                vec![Arc::new(PanickingModule), Arc::new(crate::team::TeamModule)],
            )
            .unwrap();
            let runtime = service.runtime.clone();
            let thread = std::thread::spawn(move || service.serve(false, Duration::from_secs(1)));
            Self {
                home,
                runtime,
                thread: Some(thread),
            }
        }
    }

    impl Drop for Running {
        fn drop(&mut self) {
            self.runtime.stopping.store(true, Ordering::SeqCst);
            for close in std::mem::take(&mut lock(&self.runtime.core).connections).into_values() {
                close();
            }
            let _ = plur1bus_rpc::transport::connect(
                &crate::address(self.home.path()),
                Duration::from_millis(100),
            );
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn rpc(
        stream: &mut BufReader<Box<dyn plur1bus_rpc::transport::Stream>>,
        method: &str,
        params: &Value,
    ) -> Value {
        writeln!(
            stream.get_mut(),
            "{}",
            json!({"jsonrpc":"2.0","id":1,"method":method,"params":params})
        )
        .unwrap();
        stream.get_mut().flush().unwrap();
        let mut line = String::new();
        assert!(
            stream.read_line(&mut line).unwrap() > 0,
            "RPC connection closed instead of reporting the module failure"
        );
        serde_json::from_str(&line).unwrap()
    }

    #[test]
    fn module_panics_are_refusals_and_more_than_the_connection_limit_can_recover() {
        let service = Running::start();
        let ticket_key = files::fresh_token().unwrap();
        for _ in 0..MAX_CONNECTIONS + 1 {
            let stream = plur1bus_rpc::transport::connect(
                &crate::address(service.home.path()),
                Duration::from_secs(2),
            )
            .unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut stream = BufReader::new(stream);
            assert!(rpc(&mut stream, "tools.hello", &json!({
                "token":files::read_private(&service.home.path().join("run/tools-core.token")).unwrap(),
                "ticketKey":ticket_key,
            }))["result"].is_object());
            let refused = rpc(&mut stream, "tools.fixture.panic", &json!({}));
            assert_eq!(refused["error"]["data"]["error"], "E_INTERNAL");
            assert_eq!(refused["error"]["data"]["reason"], "module-panic");
            assert_eq!(
                rpc(&mut stream, "tools.health", &json!({}))["result"]["process"]["state"],
                "ready"
            );
            drop(stream);
            let deadline = Instant::now() + Duration::from_secs(2);
            while service.runtime.connections.load(Ordering::SeqCst) != 0 {
                assert!(Instant::now() < deadline, "connection count leaked");
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
    #[test]
    fn team_methods_require_core_authentication_before_dispatch() {
        let service = Running::start();
        let ticket_key = files::fresh_token().unwrap();
        for (method, fixture) in [
            (
                "tools.team.check",
                include_str!("../../../packages/rpc-schema/fixtures/methods/tools.team.check.json"),
            ),
            (
                "tools.team.diffcheck",
                include_str!(
                    "../../../packages/rpc-schema/fixtures/methods/tools.team.diffcheck.json"
                ),
            ),
            (
                "tools.team.impact",
                include_str!(
                    "../../../packages/rpc-schema/fixtures/methods/tools.team.impact.json"
                ),
            ),
        ] {
            let stream = plur1bus_rpc::transport::connect(
                &crate::address(service.home.path()),
                Duration::from_secs(2),
            )
            .unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut stream = BufReader::new(stream);
            let fixture: Value = serde_json::from_str(fixture).unwrap();
            assert_eq!(
                rpc(&mut stream, method, &fixture["params"])["error"]["data"]["error"],
                "E_DENIED"
            );
            assert!(rpc(&mut stream, "tools.hello", &json!({
                "token":files::read_private(&service.home.path().join("run/tools-core.token")).unwrap(),
                "ticketKey":ticket_key,
            }))["result"].is_object());
            assert_eq!(
                rpc(&mut stream, method, &fixture["params"])["result"],
                fixture["result"]
            );
        }
    }
    #[test]
    fn accept_errors_back_off_count_and_reset_only_after_a_connection() {
        let mut errors = AcceptErrors::default();
        assert_eq!(errors.failed().unwrap(), Duration::from_millis(25));
        assert_eq!(errors.failed().unwrap(), Duration::from_millis(50));
        errors.consecutive = 0;
        assert_eq!(errors.failed().unwrap(), Duration::from_millis(25));
        assert_eq!(errors.total, 3);
        for _ in 1..MAX_ACCEPT_ERRORS - 1 {
            let wait = errors.failed().unwrap();
            assert!((Duration::from_millis(25)..=Duration::from_millis(250)).contains(&wait));
        }
        assert!(errors.failed().is_err());
        assert_eq!(errors.consecutive, MAX_ACCEPT_ERRORS);
    }

    #[test]
    fn persistent_accept_failure_stops_the_service_and_removes_its_run_files() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join("state")).unwrap();
        let service =
            Service::bind(home.path(), &uuid::Uuid::new_v4().to_string(), Vec::new()).unwrap();
        let runtime = service.runtime.clone();
        let attempts = Arc::new(AtomicUsize::new(0));
        let seen = attempts.clone();
        let started = Instant::now();
        let result = service.serve_accept(false, Duration::from_secs(60), move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
            Err(io::Error::other("synthetic accept resource exhaustion"))
        });
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("accept error limit"));
        assert_eq!(attempts.load(Ordering::SeqCst), MAX_ACCEPT_ERRORS as usize);
        assert!(started.elapsed() >= Duration::from_millis(25));
        assert!(runtime.stopping.load(Ordering::SeqCst));
        for name in ["tools.pid", "tools.token", "tools-core.token", "tools.sock"] {
            assert!(!home.path().join("run").join(name).exists());
        }
        let replacement =
            Service::bind(home.path(), &uuid::Uuid::new_v4().to_string(), Vec::new()).unwrap();
        drop(replacement);
    }

    #[test]
    fn one_successful_accept_resets_the_fatal_error_budget_but_an_idle_timeout_does_not() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join("state")).unwrap();
        let service =
            Service::bind(home.path(), &uuid::Uuid::new_v4().to_string(), Vec::new()).unwrap();
        let attempts = Arc::new(AtomicUsize::new(0));
        let seen = attempts.clone();
        let result = service.serve_accept(false, Duration::from_secs(60), move |_| {
            let attempt = seen.fetch_add(1, Ordering::SeqCst) + 1;
            if attempt == MAX_ACCEPT_ERRORS as usize {
                return Ok(Some(Accepted {
                    peer_pid: None,
                    reader: Box::new(io::empty()),
                    writer: Box::new(io::sink()),
                    closer: Arc::new(|| {}),
                    drain: Box::new(|| {}),
                    read_timeout: Box::new(|_| Ok(())),
                }));
            }
            if attempt == MAX_ACCEPT_ERRORS as usize + 2 {
                return Ok(None);
            }
            Err(io::Error::other("synthetic transient accept failure"))
        });
        assert!(result.is_err());
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            2 * MAX_ACCEPT_ERRORS as usize + 1
        );
    }
}
