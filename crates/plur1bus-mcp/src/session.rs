//! A scoped MCP client over a host-owned connection.
use std::{
    collections::{HashMap, HashSet},
    fmt,
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc as sync, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use rmcp::{
    model::{
        CallToolRequestParams, GetPromptRequestParams, Implementation, JsonObject,
        PaginatedRequestParams, ProtocolVersion, ReadResourceRequestParams, Tool,
    },
    service::{
        ClientInitializeError, ClientLifecycleMode, ClientServiceExt, Peer, RunningService,
        ServiceError,
    },
    transport::streamable_http_client::{
        StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
    },
    RoleClient,
};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{mpsc, watch},
};
use ureq::http::{HeaderName, HeaderValue};

pub use crate::session_ports::{ClientPorts, Feature};
use crate::{http, runtime, session_ports::Handler, session_schema::OutputSchema, stdio};

const MAX_PAGES: usize = 50;
const INBOX: usize = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Start,
    AuthRequired,
    Closed,
    Busy,
    Timeout,
    LegacyOnly,
    Protocol,
    Rejected(i32),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Start => f.write_str("MCP connection could not start"),
            Self::AuthRequired => f.write_str("MCP authorization is required"),
            Self::Closed => f.write_str("MCP connection is closed"),
            Self::Busy => f.write_str("MCP connection is busy"),
            Self::Timeout => f.write_str("MCP request deadline reached"),
            Self::LegacyOnly => f.write_str("MCP peer offers a legacy protocol"),
            Self::Protocol => f.write_str("MCP protocol response refused"),
            Self::Rejected(code) => write!(f, "MCP peer rejected the request ({code})"),
        }
    }
}
impl std::error::Error for Error {}

#[derive(Clone, Copy)]
pub enum Protocol {
    Modern,
    Legacy,
    Auto,
}

#[derive(Clone, Copy)]
pub struct Timing {
    pub connect: Duration,
    pub request: Duration,
    pub close: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(10),
            request: Duration::from_secs(30),
            close: Duration::from_secs(2),
        }
    }
}

pub struct HttpOptions {
    pub endpoint: String,
    pub admission: Arc<dyn http::Admission>,
    pub bearer: Option<String>,
    pub headers: HashMap<HeaderName, HeaderValue>,
    pub protocol: Protocol,
    pub timing: Timing,
}

pub type Reader = Box<dyn AsyncRead + Send + Unpin>;
pub type Writer = Box<dyn AsyncWrite + Send + Unpin>;

/// The host owns the process identity and process tree. Dropping this handle
/// must release the process, including launch failures or a dropped startup.
pub trait Process: Send {
    fn stop(&mut self, deadline: Instant) -> Result<(), Error>;
}

pub struct ChildPipes {
    pub reader: Reader,
    pub writer: Writer,
    pub process: Box<dyn Process>,
}

pub trait Launcher: Send + Sync {
    fn launch(&self, deadline: Instant) -> Result<ChildPipes, Error>;
}

pub enum Call {
    ListTools,
    CallTool { name: String, arguments: JsonObject },
    ListResources,
    ListResourceTemplates,
    ReadResource { uri: String },
    ListPrompts,
    GetPrompt { name: String, arguments: JsonObject },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub protocol_version: String,
    pub server: Option<Implementation>,
}

struct Invocation {
    call: Call,
    deadline: tokio::time::Instant,
    answer: sync::SyncSender<Result<Value, Error>>,
}

struct SessionInner {
    tx: mpsc::Sender<Invocation>,
    close: watch::Sender<bool>,
    done: Mutex<sync::Receiver<()>>,
    timing: Timing,
    info: Info,
    tools_generation: Arc<AtomicU64>,
}

#[derive(Clone)]
pub struct Session(Arc<SessionInner>);

impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session").finish_non_exhaustive()
    }
}

type Running = RunningService<RoleClient, Handler>;
type Connected = (Running, Option<Box<dyn Process>>);

impl Session {
    pub fn open_http(options: HttpOptions) -> Result<Self, Error> {
        Self::open_http_with_ports(options, None, None)
    }

    pub fn open_http_with_challenges(
        options: HttpOptions,
        observer: Option<Arc<dyn crate::auth::challenge::Observer>>,
    ) -> Result<Self, Error> {
        Self::open_http_with_ports(options, observer, None)
    }

    pub fn open_http_with_ports(
        options: HttpOptions,
        observer: Option<Arc<dyn crate::auth::challenge::Observer>>,
        ports: Option<Arc<dyn ClientPorts>>,
    ) -> Result<Self, Error> {
        let timing = options.timing;
        Self::spawn(timing, move |generation| async move {
            let backend =
                http::HttpClient::new(&options.endpoint, options.admission, timing.request)
                    .map_err(|_| Error::Start)?
                    .with_frame_limit(stdio::MAX_FRAME_BYTES)
                    .allow_legacy_probe(matches!(options.protocol, Protocol::Auto))
                    .passive();
            let backend = if let Some(observer) = observer {
                backend.with_challenges(observer)
            } else {
                backend
            };
            let mut config = StreamableHttpClientTransportConfig::with_uri(options.endpoint)
                .custom_headers(options.headers)
                .max_sse_event_size(stdio::MAX_FRAME_BYTES)
                .reinit_on_expired_session(false);
            config.auth_header = options.bearer;
            let transport = StreamableHttpClientTransport::with_client(backend, config);
            let handler = Handler::new(
                ports,
                timing.request,
                generation,
                !matches!(options.protocol, Protocol::Legacy),
            )?;
            let running = connect(transport, options.protocol, timing.connect, handler).await?;
            Ok((running, None))
        })
    }

    pub fn open_stdio(
        launcher: Arc<dyn Launcher>,
        protocol: Protocol,
        timing: Timing,
    ) -> Result<Self, Error> {
        Self::open_stdio_with_ports(launcher, protocol, timing, None)
    }

    pub fn open_stdio_with_ports(
        launcher: Arc<dyn Launcher>,
        protocol: Protocol,
        timing: Timing,
        ports: Option<Arc<dyn ClientPorts>>,
    ) -> Result<Self, Error> {
        Self::spawn(timing, move |generation| async move {
            let deadline = Instant::now() + timing.connect;
            let first = match protocol {
                Protocol::Auto => Protocol::Modern,
                other => other,
            };
            let modern_budget = if matches!(protocol, Protocol::Auto) {
                timing.connect.min(Duration::from_secs(1))
            } else {
                timing.connect
            };
            let handler = Handler::new(
                ports.clone(),
                timing.request,
                generation.clone(),
                !matches!(first, Protocol::Legacy),
            )?;
            match open_child(
                launcher.as_ref(),
                first,
                deadline,
                modern_budget,
                timing,
                handler,
            )
            .await
            {
                Err(Error::LegacyOnly | Error::Timeout) if matches!(protocol, Protocol::Auto) => {
                    open_child(
                        launcher.as_ref(),
                        Protocol::Legacy,
                        deadline,
                        deadline.saturating_duration_since(Instant::now()),
                        timing,
                        Handler::new(ports, timing.request, generation, false)?,
                    )
                    .await
                }
                result => result,
            }
        })
    }

    fn spawn<F, Fut>(timing: Timing, start: F) -> Result<Self, Error>
    where
        F: FnOnce(Arc<AtomicU64>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Connected, Error>>,
    {
        for duration in [timing.connect, timing.request, timing.close] {
            if duration.is_zero() || duration > Duration::from_secs(600) {
                return Err(Error::Timeout);
            }
        }
        let (tx, rx) = mpsc::channel(INBOX);
        let (close, closing) = watch::channel(false);
        let (ready_tx, ready_rx) = sync::sync_channel(1);
        let on_runtime_failure = ready_tx.clone();
        let (done_tx, done_rx) = sync::sync_channel(1);
        let tools_generation = Arc::new(AtomicU64::new(0));
        let worker_generation = tools_generation.clone();
        thread::Builder::new()
            .name("plur1bus-mcp".into())
            .spawn(move || {
                let ran = runtime::quiet(
                    || {
                        serve(
                            || start(worker_generation.clone()),
                            rx,
                            closing,
                            ready_tx,
                            timing,
                            worker_generation.clone(),
                        )
                    },
                    timing.close,
                );
                if ran.is_err() {
                    let _ = on_runtime_failure.send(Err(Error::Start));
                }
                let _ = done_tx.send(());
            })
            .map_err(|_| Error::Start)?;
        let info = ready_rx
            .recv_timeout(timing.connect)
            .map_err(|error| match error {
                sync::RecvTimeoutError::Timeout => Error::Timeout,
                sync::RecvTimeoutError::Disconnected => Error::Start,
            })??;
        Ok(Self(Arc::new(SessionInner {
            tx,
            close,
            done: Mutex::new(done_rx),
            timing,
            info,
            tools_generation,
        })))
    }

    pub fn info(&self) -> &Info {
        &self.0.info
    }

    pub fn tools_generation(&self) -> u64 {
        self.0.tools_generation.load(Ordering::Acquire)
    }

    pub fn is_closed(&self) -> bool {
        *self.0.close.borrow() || self.0.tx.is_closed()
    }

    pub fn invoke(&self, call: Call, deadline: Instant) -> Result<Value, Error> {
        if self.is_closed() {
            return Err(Error::Closed);
        }
        let deadline = deadline.min(Instant::now() + self.0.timing.request);
        if deadline <= Instant::now() {
            return Err(Error::Timeout);
        }
        let (send, recv) = sync::sync_channel(1);
        self.0
            .tx
            .try_send(Invocation {
                call,
                deadline: deadline.into(),
                answer: send,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => Error::Busy,
                mpsc::error::TrySendError::Closed(_) => Error::Closed,
            })?;
        recv.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|error| match error {
                sync::RecvTimeoutError::Timeout => Error::Timeout,
                sync::RecvTimeoutError::Disconnected => Error::Closed,
            })?
    }

    pub fn close(&self) -> Result<(), Error> {
        let _ = self.0.close.send(true);
        let done = self.0.done.lock().map_err(|_| Error::Closed)?;
        match done.recv_timeout(self.0.timing.close) {
            Ok(()) | Err(sync::RecvTimeoutError::Disconnected) => Ok(()),
            Err(sync::RecvTimeoutError::Timeout) => Err(Error::Timeout),
        }
    }
}

impl Drop for SessionInner {
    fn drop(&mut self) {
        let _ = self.close.send(true);
    }
}

async fn serve<F, Fut>(
    start: F,
    mut rx: mpsc::Receiver<Invocation>,
    mut closing: watch::Receiver<bool>,
    ready: sync::SyncSender<Result<Info, Error>>,
    timing: Timing,
    tools_generation: Arc<AtomicU64>,
) where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Connected, Error>>,
{
    let (mut running, mut process) = match start().await {
        Ok(result) => result,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let info = running
        .peer_info()
        .map(|peer| Info {
            protocol_version: peer.protocol_version.as_str().to_owned(),
            server: peer.server_info.clone(),
        })
        .ok_or(Error::Protocol);
    let ready_ok = info.is_ok();
    if ready.send(info).is_ok() && ready_ok {
        let mut tools = HashMap::new();
        let mut observed = tools_generation.load(Ordering::Acquire);
        loop {
            let invocation = tokio::select! {
                _ = closing.changed() => break,
                message = rx.recv() => match message {
                    Some(message) => message,
                    None => break,
                },
            };
            if running.is_closed() || running.is_transport_closed() {
                let _ = invocation.answer.send(Err(Error::Closed));
                break;
            }
            let latest = tools_generation.load(Ordering::Acquire);
            if latest != observed {
                tools.clear();
                observed = latest;
            }
            let result = tokio::select! {
                _ = closing.changed() => {
                    let _ = invocation.answer.send(Err(Error::Closed));
                    break;
                }
                result = tokio::time::timeout_at(invocation.deadline, execute(running.peer(), &mut tools, invocation.call)) => {
                    result.unwrap_or(Err(Error::Timeout))
                }
            };
            let transport_closed = result == Err(Error::Closed);
            let _ = invocation.answer.send(result);
            if transport_closed {
                break;
            }
        }
    }
    rx.close();
    let _ = running.close_with_timeout(timing.close).await;
    if let Some(ref mut process) = process {
        let _ = process.stop(Instant::now() + timing.close);
    }
}

async fn open_child(
    launcher: &dyn Launcher,
    protocol: Protocol,
    deadline: Instant,
    connect_limit: Duration,
    timing: Timing,
    handler: Handler,
) -> Result<Connected, Error> {
    if deadline <= Instant::now() {
        return Err(Error::Timeout);
    }
    let ChildPipes {
        reader,
        writer,
        mut process,
    } = launcher.launch(deadline)?;
    let result = match stdio::Framed::new(reader, writer, stdio::MAX_FRAME_BYTES, timing.request) {
        Ok(transport) => {
            let transport = if matches!(protocol, Protocol::Legacy) {
                transport.with_legacy_envelope()
            } else {
                transport
            };
            connect(
                transport.passive(),
                protocol,
                connect_limit.min(deadline.saturating_duration_since(Instant::now())),
                handler,
            )
            .await
        }
        Err(_) => Err(Error::Start),
    };
    match result {
        Ok(session) => Ok((session, Some(process))),
        Err(error) => {
            process.stop(Instant::now() + timing.close)?;
            Err(error)
        }
    }
}

async fn connect<T, E, A>(
    transport: T,
    protocol: Protocol,
    timeout: Duration,
    handler: Handler,
) -> Result<Running, Error>
where
    T: rmcp::transport::IntoTransport<RoleClient, E, A>,
    E: std::error::Error + Send + Sync + 'static,
{
    let lifecycle = match protocol {
        Protocol::Modern => ClientLifecycleMode::Discover {
            preferred_versions: vec![ProtocolVersion::V_2026_07_28],
        },
        Protocol::Legacy => ClientLifecycleMode::Initialize,
        Protocol::Auto => ClientLifecycleMode::Auto {
            preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            legacy_version: Some(ProtocolVersion::V_2025_11_25),
        },
    };
    tokio::time::timeout(timeout, handler.serve_with_lifecycle(transport, lifecycle))
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|error| initialize_error(&error))
}

fn initialize_error(error: &ClientInitializeError) -> Error {
    if error.auth_challenge().is_some() {
        return Error::AuthRequired;
    }
    match error {
        ClientInitializeError::JsonRpcError(reply)
            if matches!(reply.code.0, -32600 | -32601 | -32602 | -32000) =>
        {
            Error::LegacyOnly
        }
        ClientInitializeError::NoCompatibleProtocolVersion {
            server_supported, ..
        } if server_supported.iter().any(|version| {
            matches!(version.as_str(), "2025-11-25" | "2025-06-18" | "2025-03-26")
        }) =>
        {
            Error::LegacyOnly
        }
        ClientInitializeError::JsonRpcError(_)
        | ClientInitializeError::NoCompatibleProtocolVersion { .. } => Error::Protocol,
        ClientInitializeError::Cancelled => Error::Closed,
        _ => Error::Start,
    }
}

fn rpc_error(error: ServiceError) -> Error {
    match error {
        ServiceError::TransportSend(_) | ServiceError::TransportClosed => Error::Closed,
        ServiceError::Cancelled { .. } | ServiceError::Timeout { .. } => Error::Timeout,
        ServiceError::McpError(error) => Error::Rejected(error.code.0),
        _ => Error::Protocol,
    }
}

async fn execute(
    peer: &Peer<RoleClient>,
    tools: &mut HashMap<String, Option<OutputSchema>>,
    call: Call,
) -> Result<Value, Error> {
    match call {
        Call::ListTools => Ok(json!({ "tools": refresh_tools(peer, tools).await? })),
        Call::CallTool { name, arguments } => {
            if !tools.contains_key(&name) {
                refresh_tools(peer, tools).await?;
            }
            let output = tools.get(&name).ok_or(Error::Rejected(-32601))?;
            let result = peer
                .call_tool(CallToolRequestParams::new(name).with_arguments(arguments))
                .await
                .map_err(rpc_error)?;
            if result.is_error != Some(true) {
                if let Some(output) = output {
                    output.validate(result.structured_content.as_ref())?;
                }
            }
            serde_json::to_value(result).map_err(|_| Error::Protocol)
        }
        Call::ListResources => {
            pages(
                |cursor| async move {
                    let result = peer.list_resources(page(cursor)).await.map_err(rpc_error)?;
                    Ok((result.resources, result.next_cursor))
                },
                "resources",
            )
            .await
        }
        Call::ListResourceTemplates => {
            pages(
                |cursor| async move {
                    let result = peer
                        .list_resource_templates(page(cursor))
                        .await
                        .map_err(rpc_error)?;
                    Ok((result.resource_templates, result.next_cursor))
                },
                "resourceTemplates",
            )
            .await
        }
        Call::ReadResource { uri } => as_json(
            peer.read_resource(ReadResourceRequestParams::new(uri))
                .await,
        ),
        Call::ListPrompts => {
            pages(
                |cursor| async move {
                    let result = peer.list_prompts(page(cursor)).await.map_err(rpc_error)?;
                    Ok((result.prompts, result.next_cursor))
                },
                "prompts",
            )
            .await
        }
        Call::GetPrompt { name, arguments } => as_json(
            peer.get_prompt(GetPromptRequestParams::new(name).with_arguments(arguments))
                .await,
        ),
    }
}

async fn refresh_tools(
    peer: &Peer<RoleClient>,
    tools: &mut HashMap<String, Option<OutputSchema>>,
) -> Result<Vec<Tool>, Error> {
    let values = collect_pages(|cursor| async move {
        let result = peer.list_tools(page(cursor)).await.map_err(rpc_error)?;
        Ok((result.tools, result.next_cursor))
    })
    .await?;
    let mut validated = HashMap::new();
    for tool in &values {
        let name = tool.name.as_ref();
        if name.is_empty()
            || name.encode_utf16().count() > 128
            || name.chars().any(char::is_control)
            || tool.input_schema.get("type") != Some(&Value::String("object".into()))
            || validated.contains_key(name)
        {
            return Err(Error::Protocol);
        }
        let output = tool
            .output_schema
            .as_deref()
            .map(OutputSchema::compile)
            .transpose()?;
        validated.insert(name.to_owned(), output);
    }
    *tools = validated;
    Ok(values)
}

fn page(cursor: Option<String>) -> Option<PaginatedRequestParams> {
    cursor.map(|cursor| PaginatedRequestParams::default().with_cursor(Some(cursor)))
}

async fn pages<T: Serialize, F: Future<Output = Result<(Vec<T>, Option<String>), Error>>>(
    next: impl Fn(Option<String>) -> F,
    name: &str,
) -> Result<Value, Error> {
    let items = serde_json::to_value(collect_pages(next).await?).map_err(|_| Error::Protocol)?;
    Ok(Value::Object(
        [(name.to_owned(), items)].into_iter().collect(),
    ))
}

async fn collect_pages<T, F: Future<Output = Result<(Vec<T>, Option<String>), Error>>>(
    next: impl Fn(Option<String>) -> F,
) -> Result<Vec<T>, Error> {
    let mut cursor = None;
    let mut seen = HashSet::new();
    let mut all = Vec::new();
    for _ in 0..MAX_PAGES {
        let (mut items, next_cursor) = next(cursor).await?;
        all.append(&mut items);
        let Some(value) = next_cursor else {
            return Ok(all);
        };
        if value.is_empty() || !seen.insert(value.clone()) {
            return Err(Error::Protocol);
        }
        cursor = Some(value);
    }
    Ok(all)
}

fn as_json<T: Serialize>(result: Result<T, ServiceError>) -> Result<Value, Error> {
    serde_json::to_value(result.map_err(rpc_error)?).map_err(|_| Error::Protocol)
}
