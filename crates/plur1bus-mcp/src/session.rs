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

use plur1bus_providers::display;
use rmcp::{
    model::{
        CallToolRequestParams, GetPromptRequestParams, Implementation, JsonObject,
        PaginatedRequestParams, ProtocolVersion, ReadResourceRequestParams, ServerRequest,
        ToolAnnotations,
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
use crate::{
    connection_fault::{Cause, Fault},
    http, replies, runtime,
    session_ports::Handler,
    session_schema::OutputSchema,
    stdio,
};

const MAX_PAGES: usize = 50;
const MAX_LIST_ITEMS: usize = 10_000;
const MAX_NAME_UNITS: usize = 128;
const MAX_DESCRIPTION_UNITS: usize = 8192;
const INBOX: usize = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Start,
    AuthRequired,
    Closed,
    Busy,
    Backpressure,
    ReconnectLimit,
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
            Self::Backpressure => f.write_str("MCP reply budget exhausted"),
            Self::ReconnectLimit => f.write_str("MCP event stream reconnect limit reached"),
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
    reply_fault: Fault,
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
        Self::spawn(timing, move |generation, reply_fault| async move {
            let backend =
                http::HttpClient::new(&options.endpoint, options.admission, timing.request)
                    .map_err(|_| Error::Start)?
                    .with_frame_limit(stdio::MAX_FRAME_BYTES)
                    .allow_legacy_probe(matches!(options.protocol, Protocol::Auto))
                    .passive()
                    .with_reply_write_timeout(timing.close, reply_fault.clone())
                    .with_reconnect_limit(reply_fault.clone());
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
            config.channel_buffer_capacity = 1;
            config.retry_config = Arc::new(http::BackendRetry);
            let transport = replies::Bounded::new(
                StreamableHttpClientTransport::with_client(backend, config),
                stdio::MAX_FRAME_BYTES,
                reply_fault.clone(),
                |request| matches!(request, ServerRequest::PingRequest(_)),
            )
            .detect_legacy_initialize();
            let handler = Handler::new(
                ports,
                timing.request,
                generation,
                !matches!(options.protocol, Protocol::Legacy),
            )?;
            let running = connect(
                transport,
                options.protocol,
                timing.connect,
                handler,
                &reply_fault,
            )
            .await?;
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
        Self::spawn(timing, move |generation, reply_fault| async move {
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
                &reply_fault,
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
                        &reply_fault,
                    )
                    .await
                }
                result => result,
            }
        })
    }

    fn spawn<F, Fut>(timing: Timing, start: F) -> Result<Self, Error>
    where
        F: FnOnce(Arc<AtomicU64>, Fault) -> Fut + Send + 'static,
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
        let reply_fault = Fault::new();
        let worker_fault = reply_fault.clone();
        thread::Builder::new()
            .name("plur1bus-mcp".into())
            .spawn(move || {
                let ran = runtime::quiet(
                    || {
                        serve(
                            || start(worker_generation.clone(), worker_fault.clone()),
                            rx,
                            closing,
                            ready_tx,
                            timing,
                            worker_generation.clone(),
                            worker_fault.clone(),
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
            reply_fault,
        })))
    }

    pub fn info(&self) -> &Info {
        &self.0.info
    }

    pub fn tools_generation(&self) -> u64 {
        self.0.tools_generation.load(Ordering::Acquire)
    }

    pub fn is_closed(&self) -> bool {
        *self.0.close.borrow() || self.0.tx.is_closed() || self.0.reply_fault.current().is_some()
    }

    pub fn invoke(&self, call: Call, deadline: Instant) -> Result<Value, Error> {
        if self.is_closed() {
            return Err(self.closed_error());
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
                mpsc::error::TrySendError::Closed(_) => self.closed_error(),
            })?;
        recv.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|error| match error {
                sync::RecvTimeoutError::Timeout => Error::Timeout,
                sync::RecvTimeoutError::Disconnected => self.closed_error(),
            })?
    }

    fn closed_error(&self) -> Error {
        self.0
            .reply_fault
            .current()
            .map_or(Error::Closed, connection_error)
    }

    pub fn close(&self) -> Result<(), Error> {
        let _ = self.0.close.send(true);
        let done = self.0.done.lock().map_err(|_| Error::Closed)?;
        let result = done.recv_timeout(self.0.timing.close);
        if let Some(cause) = self.0.reply_fault.current() {
            return Err(connection_error(cause));
        }
        match result {
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
    reply_fault: Fault,
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
                _ = reply_fault.wait() => break,
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
                biased;
                cause = reply_fault.wait() => {
                    let _ = invocation.answer.send(Err(connection_error(cause)));
                    break;
                }
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
    if reply_fault.current().is_some() {
        running.cancellation_token().cancel();
    } else {
        let _ = running.close_with_timeout(timing.close).await;
    }
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
    reply_fault: &Fault,
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
                replies::Bounded::new(
                    transport
                        .passive()
                        .with_write_fault(timing.close, reply_fault.clone()),
                    stdio::MAX_FRAME_BYTES,
                    reply_fault.clone(),
                    |request| matches!(request, ServerRequest::PingRequest(_)),
                )
                .with_request_cancellation(matches!(protocol, Protocol::Legacy)),
                protocol,
                connect_limit.min(deadline.saturating_duration_since(Instant::now())),
                handler,
                reply_fault,
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
    reply_fault: &Fault,
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
    tokio::select! {
        biased;
        cause = reply_fault.wait() => Err(connection_error(cause)),
        result = tokio::time::timeout(timeout, handler.serve_with_lifecycle(transport, lifecycle)) => {
            result.map_err(|_| Error::Timeout)?.map_err(|error| initialize_error(&error))
        }
    }
}

fn connection_error(cause: Cause) -> Error {
    match cause {
        Cause::Backpressure => Error::Backpressure,
        Cause::ReconnectLimit => Error::ReconnectLimit,
    }
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

struct ToolEntry {
    wire_name: String,
    output_schema: Option<OutputSchema>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Descriptor {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    input_schema: Arc<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_schema: Option<Arc<JsonObject>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    annotations: Option<ToolAnnotations>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ui_resource_uri: Option<String>,
}

async fn execute(
    peer: &Peer<RoleClient>,
    tools: &mut HashMap<String, ToolEntry>,
    call: Call,
) -> Result<Value, Error> {
    match call {
        Call::ListTools => Ok(json!({ "tools": refresh_tools(peer, tools).await? })),
        Call::CallTool { name, arguments } => {
            if !tools.contains_key(&name) {
                refresh_tools(peer, tools).await?;
            }
            let tool = tools.get(&name).ok_or(Error::Rejected(-32601))?;
            let result = peer
                .call_tool(
                    CallToolRequestParams::new(tool.wire_name.clone()).with_arguments(arguments),
                )
                .await
                .map_err(rpc_error)?;
            if result.is_error != Some(true) {
                if let Some(output) = &tool.output_schema {
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
    tools: &mut HashMap<String, ToolEntry>,
) -> Result<Vec<Descriptor>, Error> {
    let values = collect_pages(|cursor| async move {
        let result = peer.list_tools(page(cursor)).await.map_err(rpc_error)?;
        Ok((result.tools, result.next_cursor))
    })
    .await?;
    let mut validated = HashMap::new();
    let mut descriptors = Vec::with_capacity(values.len());
    for tool in values {
        let name = tool_name(&tool.name)?;
        if tool.input_schema.get("type").and_then(Value::as_str) != Some("object") {
            return Err(Error::Protocol);
        }
        if name.is_empty() || validated.contains_key(&name) {
            return Err(Error::Protocol);
        }
        let output_schema = tool
            .output_schema
            .as_deref()
            .map(OutputSchema::compile)
            .transpose()?;
        validated.insert(
            name.clone(),
            ToolEntry {
                wire_name: tool.name.into_owned(),
                output_schema,
            },
        );
        let ui_resource_uri = tool.meta.as_ref().and_then(|meta| {
            meta.0
                .get("ui")
                .and_then(|ui| ui.get("resourceUri"))
                .filter(|uri| !uri.is_null())
                .or_else(|| meta.0.get("ui/resourceUri"))
                .and_then(Value::as_str)
                .filter(|uri| uri.starts_with("ui://"))
                .map(ToOwned::to_owned)
        });
        let mut annotations = tool.annotations;
        if let Some(annotations) = &mut annotations {
            annotations.title = annotations
                .title
                .as_deref()
                .map(|text| display::sanitize(text, MAX_NAME_UNITS));
        }
        descriptors.push(Descriptor {
            name,
            title: tool
                .title
                .as_deref()
                .map(|text| display::sanitize(text, MAX_NAME_UNITS)),
            description: tool
                .description
                .as_deref()
                .map(|text| display::sanitize(text, MAX_DESCRIPTION_UNITS)),
            input_schema: tool.input_schema,
            output_schema: tool.output_schema,
            annotations,
            ui_resource_uri,
        });
    }
    *tools = validated;
    Ok(descriptors)
}

fn tool_name(name: &str) -> Result<String, Error> {
    if name.is_empty()
        || name.encode_utf16().count() > MAX_NAME_UNITS
        || name
            .chars()
            .any(|character| character.is_control() || matches!(character, '\u{2028}' | '\u{2029}'))
    {
        return Err(Error::Protocol);
    }
    Ok(display::sanitize(name, MAX_NAME_UNITS))
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
        if items.len() > MAX_LIST_ITEMS - all.len() {
            return Err(Error::Protocol);
        }
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

#[cfg(test)]
mod list_tests {
    use super::{collect_pages, tool_name, Error, MAX_LIST_ITEMS};
    use std::future::ready;

    #[test]
    fn tool_names_reject_control_characters_before_cleaning() {
        for separator in ['\t', '\u{85}', '\u{2028}', '\u{2029}'] {
            assert_eq!(
                tool_name(&format!("first{separator}second")),
                Err(Error::Protocol)
            );
        }
    }

    #[tokio::test]
    async fn paged_lists_stop_on_a_repeated_cursor() {
        let result = collect_pages(|_| ready(Ok((vec![1], Some("same".into()))))).await;
        assert_eq!(result, Err(Error::Protocol));
    }

    #[tokio::test]
    async fn paged_lists_enforce_the_combined_item_count() {
        for extra in [0, 1] {
            let result = collect_pages(|cursor| {
                ready(Ok(if cursor.is_none() {
                    (vec![(); MAX_LIST_ITEMS - 1], Some("more".into()))
                } else {
                    (vec![(); 1 + extra], None)
                }))
            })
            .await;
            assert_eq!(
                result.map(|items| items.len()),
                if extra == 0 {
                    Ok(MAX_LIST_ITEMS)
                } else {
                    Err(Error::Protocol)
                }
            );
        }
    }
}
